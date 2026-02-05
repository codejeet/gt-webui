# Gas Town WebUI

Monitoring dashboard for active Gas Town instances.

## Features

- Real-time status of rigs, polecats, and agents
- Live event feed via WebSocket
- Bead queue and convoy tracking
- Responsive design

## Running Locally

### Prerequisites

- Node.js 18+
- Gas Town (`gt`) CLI in PATH

### Start the server
to install through git
```bash
cd ~/gt/gt-webui
npm install
npm start
```
or

npm install -g gt-webui

Or use the start script:

```bash
bash ~/gt/gt-webui/start.sh
```

Open http://localhost:3000 in your browser.

### Environment Variables

- `PORT` - Server port (default: 3000)
- `GT_DIR` - Gas Town directory (default: ~/gt)

## API Endpoints

- `GET /api/status` - Overall town status (rigs, agents, polecats)
- `GET /api/ready` - Ready work items
- `GET /api/polecats` - All polecats
- `GET /api/events?limit=N` - Recent events
- `GET /api/bead/:id` - Bead details
- `GET /api/mail` - Mail inbox
- `GET /api/log` - Agent lifecycle log

## WebSocket

Connect to `ws://localhost:3000/ws` for live updates.

Messages:
- `{type: "status", data: {...}}` - Status updates (every 5s)
- `{type: "event", data: {...}}` - New events

## Configuration

If running the frontend from a different origin (e.g., Vercel), configure the backend URL in browser console:

```js
gtConfig.setApiBase('http://localhost:3000')
gtConfig.setWsHost('localhost:3000')
gtConfig.reset() // Reset to defaults
```

## Deployment

The backend requires access to the `gt` CLI and must run locally or on a VPS where Gas Town is installed.

For static-only deployment (no live data), deploy to Vercel:

```bash
vercel deploy
```
