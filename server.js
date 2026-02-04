const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const GT_DIR = process.env.GT_DIR || path.join(process.env.HOME, 'gt');
const EVENTS_FILE = path.join(GT_DIR, '.events.jsonl');

// Activity detection patterns for Claude Code output
// These indicate ONGOING activity (tool running, thinking, etc.)
const ACTIVE_PATTERNS = [
  /⎿\s+Running…/,        // Tool is actively running
  /Warping/i,            // Warping animation
  /Wandering/i,          // Wandering animation (thinking)
  /thinking/i,           // Thinking indicator
  /thought for \d+/,     // Recently finished thinking
  /\[█+\s*\]/,           // Progress bar spinner
  /Searching\.\.\./i,
  /Loading\.\.\./i,
  /Processing\.\.\./i,
];

// Idle patterns - check that prompt is at end with only UI chrome after
const IDLE_PATTERNS = [
  /❯\s*\n+[-─━]+\n\s*⏵/,  // Prompt followed by separator and status bar (typical idle)
  /Waiting for input/i,
];

// Cache for pane content to detect changes
const paneContentCache = new Map();

// Detect activity from tmux pane content
function detectActivityFromPane(paneContent, sessionName) {
  if (!paneContent || paneContent.trim() === '') {
    return 'idle';
  }

  // Get the last few lines to check current state (not historical)
  const lines = paneContent.split('\n');
  const lastLines = lines.slice(-20).join('\n');

  // Check for active patterns FIRST - if actively doing something, it's working
  // These patterns indicate ongoing activity
  for (const pattern of ACTIVE_PATTERNS) {
    if (pattern.test(lastLines)) {
      return 'working';
    }
  }

  // If no active patterns, check for idle state
  for (const pattern of IDLE_PATTERNS) {
    if (pattern.test(lastLines)) {
      return 'idle';
    }
  }

  // Check if content changed recently (indicates activity)
  const cachedContent = paneContentCache.get(sessionName);
  const contentChanged = cachedContent !== paneContent;
  paneContentCache.set(sessionName, paneContent);

  // If content changed recently, likely still processing
  if (contentChanged) {
    return 'working';
  }

  // Default to idle if no active patterns and content stable
  return 'idle';
}

// Capture tmux pane content for a polecat session
function captureTmuxPane(sessionName) {
  return new Promise((resolve) => {
    // Sanitize session name
    if (!/^[a-zA-Z0-9_\-:@/]+$/.test(sessionName)) {
      resolve(null);
      return;
    }
    exec(`tmux capture-pane -t "${sessionName}" -p -S -50`, {
      timeout: 5000,
      maxBuffer: 1024 * 64
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

// Get activity status for all polecats
async function getPolecatActivityStatus(polecats) {
  if (!polecats || !Array.isArray(polecats)) {
    return polecats;
  }

  const enrichedPolecats = await Promise.all(polecats.map(async (p) => {
    // Check both 'running' and 'session_running' fields
    const isRunning = p.running || p.session_running;
    if (!isRunning) {
      return { ...p, activity_status: 'offline' };
    }

    // Try to capture tmux pane for this polecat
    // Session name format is: gt-{rig}-{name}
    const sessionNames = [
      `gt-${p.rig}-${p.name}`,
      `${p.rig}-${p.name}`,
      `gt-${p.name}`,
      p.name
    ];

    let paneContent = null;
    let usedSession = null;
    for (const sessionName of sessionNames) {
      paneContent = await captureTmuxPane(sessionName);
      if (paneContent !== null) {
        usedSession = sessionName;
        break;
      }
    }

    if (paneContent !== null) {
      const activity = detectActivityFromPane(paneContent, usedSession);
      return { ...p, activity_status: activity };
    }

    // Fallback to has_work flag if tmux capture fails
    return { ...p, activity_status: p.has_work ? 'working' : 'idle' };
  }));

  return enrichedPolecats;
}

// Get activity status for agents (mayor, deacon, etc.)
async function getAgentActivityStatus(agents) {
  if (!agents || !Array.isArray(agents)) {
    return agents;
  }

  const enrichedAgents = await Promise.all(agents.map(async (a) => {
    if (!a.running) {
      return { ...a, activity_status: 'offline' };
    }

    // Try to capture tmux pane for this agent
    // Use the session field if available, otherwise try hq-{name}
    const sessionNames = a.session ? [a.session] : [
      `hq-${a.name}`,
      a.name
    ];

    let paneContent = null;
    let usedSession = null;
    for (const sessionName of sessionNames) {
      paneContent = await captureTmuxPane(sessionName);
      if (paneContent !== null) {
        usedSession = sessionName;
        break;
      }
    }

    if (paneContent !== null) {
      const activity = detectActivityFromPane(paneContent, usedSession);
      return { ...a, activity_status: activity };
    }

    // Fallback to has_work flag if tmux capture fails
    return { ...a, activity_status: a.has_work ? 'working' : 'idle' };
  }));

  return enrichedAgents;
}

// Ensure PATH includes go binaries
process.env.PATH = `${process.env.HOME}/go/bin:${process.env.PATH}`;

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for live events
const wss = new WebSocketServer({ server, path: '/ws' });

// CORS middleware for cross-origin requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Parse JSON body
app.use(express.json());

// Serve static files
app.use(express.static(__dirname));

// Helper to run gt commands
function runGtCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const cmd = `gt ${args}`;
    exec(cmd, {
      cwd: GT_DIR,
      env: { ...process.env, PATH: `${process.env.HOME}/go/bin:${process.env.PATH}` },
      maxBuffer: 1024 * 1024 * 10
    }, (error, stdout, stderr) => {
      if (error && !options.allowError) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

// Parse JSON output from gt command
async function getGtJson(args) {
  try {
    const output = await runGtCommand(args);
    return JSON.parse(output);
  } catch (e) {
    console.error(`Error running gt ${args}:`, e.message);
    return null;
  }
}

// API Routes

// Get overall status
app.get('/api/status', async (req, res) => {
  try {
    const status = await getGtJson('status --json');
    if (status && status.agents) {
      status.agents = await getAgentActivityStatus(status.agents);
    }
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get ready work
app.get('/api/ready', async (req, res) => {
  try {
    const ready = await getGtJson('ready --json');
    res.json(ready);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get polecat list with activity detection
app.get('/api/polecats', async (req, res) => {
  try {
    const polecats = await getGtJson('polecat list --all --json');
    const enrichedPolecats = await getPolecatActivityStatus(polecats || []);
    res.json(enrichedPolecats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sanitize identifiers (allow alphanumeric, dash, underscore, colon, @)
function sanitizeId(str) {
  if (!str || !/^[a-zA-Z0-9_\-:@]+$/.test(str)) {
    throw new Error('Invalid identifier');
  }
  return str;
}

// Get bead details
app.get('/api/bead/:id', async (req, res) => {
  try {
    const beadId = sanitizeId(req.params.id);
    const output = await runGtCommand(`bead show ${beadId}`);
    res.json({ id: beadId, content: output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get mail inbox
app.get('/api/mail', async (req, res) => {
  try {
    const mail = await getGtJson('mail inbox --json');
    res.json(mail || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Close a bead
app.post('/api/bead/:id/close', async (req, res) => {
  try {
    const beadId = sanitizeId(req.params.id);
    await runGtCommand(`bead close ${beadId}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Kill a polecat
app.post('/api/polecat/:rig/:name/kill', async (req, res) => {
  try {
    const rig = sanitizeId(req.params.rig);
    const name = sanitizeId(req.params.name);
    await runGtCommand(`polecat kill ${rig}/${name}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send mail to mayor
app.post('/api/mail/mayor', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Message required' });
      return;
    }
    // Limit message length
    if (message.length > 2000) {
      res.status(400).json({ error: 'Message too long (max 2000 chars)' });
      return;
    }
    // Escape the message for shell (single quote escaping)
    const escapedMessage = message.replace(/'/g, "'\\''");
    await runGtCommand(`mail send mayor/ -s "WebUI Message" -m '${escapedMessage}'`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get recent events from .events.jsonl
app.get('/api/events', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    if (!fs.existsSync(EVENTS_FILE)) {
      res.json([]);
      return;
    }

    const content = fs.readFileSync(EVENTS_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l);
    const events = lines
      .slice(-limit)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(e => e)
      .reverse();

    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get log entries
app.get('/api/log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const output = await runGtCommand(`log -n ${limit}`, { allowError: true });
    const lines = output.trim().split('\n').filter(l => l);
    const entries = lines.map(line => {
      // Parse: "2026-02-03 21:17:30 [nudge] deacon nudged"
      const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (.+)$/);
      if (match) {
        return {
          timestamp: match[1],
          type: match[2],
          message: match[3]
        };
      }
      return { message: line };
    });
    res.json(entries);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper to run shell commands (for tmux)
function runShellCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      env: process.env,
      maxBuffer: 1024 * 1024 * 10
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

// Get available tmux sessions for spy view
app.get('/api/sessions', async (req, res) => {
  try {
    const output = await runShellCommand('tmux list-sessions -F "#{session_name}"');
    const sessions = output.trim().split('\n').filter(s => s);
    res.json(sessions);
  } catch (e) {
    // No sessions or tmux not running
    res.json([]);
  }
});

// Get tmux pane capture for a session
app.get('/api/spy/:session', async (req, res) => {
  try {
    const session = req.params.session;
    // Validate session name (alphanumeric, dash, underscore)
    if (!/^[a-zA-Z0-9_\-]+$/.test(session)) {
      res.status(400).json({ error: 'Invalid session name' });
      return;
    }
    // Capture the pane output (last 200 lines)
    const output = await runShellCommand(`tmux capture-pane -t "${session}:0" -p -S -200`);
    res.json({ session, output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// WebSocket: Stream live events
function setupEventWatcher() {
  if (!fs.existsSync(EVENTS_FILE)) {
    console.log('Events file not found, will retry...');
    setTimeout(setupEventWatcher, 5000);
    return;
  }

  let lastSize = fs.statSync(EVENTS_FILE).size;

  const watcher = fs.watch(EVENTS_FILE, (eventType) => {
    if (eventType === 'change') {
      try {
        const stat = fs.statSync(EVENTS_FILE);
        if (stat.size > lastSize) {
          // Read new content
          const fd = fs.openSync(EVENTS_FILE, 'r');
          const buffer = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buffer, 0, buffer.length, lastSize);
          fs.closeSync(fd);

          const newContent = buffer.toString('utf-8');
          const lines = newContent.trim().split('\n').filter(l => l);

          lines.forEach(line => {
            try {
              const event = JSON.parse(line);
              // Broadcast to all connected clients
              wss.clients.forEach(client => {
                if (client.readyState === 1) { // WebSocket.OPEN
                  client.send(JSON.stringify({ type: 'event', data: event }));
                }
              });
            } catch {
              // Skip invalid JSON
            }
          });

          lastSize = stat.size;
        } else if (stat.size < lastSize) {
          // File was truncated, reset
          lastSize = stat.size;
        }
      } catch (e) {
        console.error('Error reading events:', e.message);
      }
    }
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    watcher.close();
    process.exit();
  });
}

// Track spy subscriptions per client
const spySubscriptions = new Map();

// Spy streaming interval (captures pane every 500ms for subscribed clients)
setInterval(async () => {
  for (const [ws, session] of spySubscriptions.entries()) {
    if (ws.readyState !== 1) {
      spySubscriptions.delete(ws);
      continue;
    }
    try {
      const output = await runShellCommand(`tmux capture-pane -t "${session}:0" -p -S -200`);
      ws.send(JSON.stringify({ type: 'spy', session, output }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'spy_error', session, error: e.message }));
    }
  }
}, 500);

// WebSocket connection handling
wss.on('connection', async (ws) => {
  console.log('Client connected');

  // Send initial status with polecats and agents (including activity detection)
  try {
    const [status, polecats] = await Promise.all([
      getGtJson('status --json'),
      getGtJson('polecat list --all --json')
    ]);
    if (status) {
      status.polecats = await getPolecatActivityStatus(polecats || []);
      status.agents = await getAgentActivityStatus(status.agents || []);
      ws.send(JSON.stringify({ type: 'status', data: status }));
    }
  } catch (e) {
    console.error('Error sending initial status:', e.message);
  }

  // Send available sessions for spy view
  try {
    const sessionsOutput = await runShellCommand('tmux list-sessions -F "#{session_name}"');
    const sessions = sessionsOutput.trim().split('\n').filter(s => s);
    ws.send(JSON.stringify({ type: 'sessions', sessions }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'sessions', sessions: [] }));
  }

  // Handle incoming messages for spy subscriptions
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'spy_subscribe' && msg.session) {
        // Validate session name
        if (/^[a-zA-Z0-9_\-]+$/.test(msg.session)) {
          spySubscriptions.set(ws, msg.session);
          console.log(`Client subscribed to spy: ${msg.session}`);
        }
      } else if (msg.type === 'spy_unsubscribe') {
        spySubscriptions.delete(ws);
        console.log('Client unsubscribed from spy');
      }
    } catch (e) {
      // Ignore invalid messages
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    spySubscriptions.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    spySubscriptions.delete(ws);
  });
});

// Periodic status broadcast with activity detection
setInterval(async () => {
  if (wss.clients.size > 0) {
    try {
      const [status, polecats] = await Promise.all([
        getGtJson('status --json'),
        getGtJson('polecat list --all --json')
      ]);
      if (status) {
        // Include polecats and agents with activity detection in status update
        status.polecats = await getPolecatActivityStatus(polecats || []);
        status.agents = await getAgentActivityStatus(status.agents || []);
        wss.clients.forEach(client => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'status', data: status }));
          }
        });
      }
    } catch (e) {
      console.error('Error fetching status:', e.message);
    }
  }
}, 5000);

// Start server
server.listen(PORT, () => {
  console.log(`GT WebUI server running at http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`GT directory: ${GT_DIR}`);
  setupEventWatcher();
});
