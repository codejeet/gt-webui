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

// Get polecat list
app.get('/api/polecats', async (req, res) => {
  try {
    const polecats = await getGtJson('polecat list --all --json');
    res.json(polecats || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get bead details
app.get('/api/bead/:id', async (req, res) => {
  try {
    const output = await runGtCommand(`bead show ${req.params.id}`);
    res.json({ id: req.params.id, content: output });
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

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send initial status
  getGtJson('status --json').then(status => {
    if (status) {
      ws.send(JSON.stringify({ type: 'status', data: status }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// Periodic status broadcast
setInterval(async () => {
  if (wss.clients.size > 0) {
    try {
      const status = await getGtJson('status --json');
      if (status) {
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
