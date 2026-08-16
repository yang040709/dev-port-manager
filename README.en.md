# Dev Port Manager 🛠️

> 🌐 English | [简体中文](README.md)

A local development server port manager: watch port usage in real time from a web UI, resolve the process name & PID behind each occupied port, and stop processes with one click.

- Backend: Node.js + Express (port detection & PID lookup via `lsof` / `ss` / `netstat`)
- Frontend: React 18 (UMD, **no build step** — runtime assets are vendored into `public/vendor/` and rebuilt automatically on `npm install`)
- Storage: `ports.json` (persists custom ports; auto-created on first run; listed in `.gitignore`)

> License: [MIT](./LICENSE)

![Screenshot](screenshot.png)

*Screenshot: live port status, occupied processes & PIDs, stop process, add port and auto-refresh; language toggle in the top-right corner.*

## Quick Start

Prerequisite: **Node.js ≥ 16** (React 18 UMD builds are pinned in dependencies — no bundler or build tooling required).

```bash
cd dev-port-manager
npm install
npm start
```

Open **http://localhost:3081** in your browser.

> To change the tool's own port: `SERVER_PORT=3082 npm start`
>
> ⚠️ By default the server binds **loopback only (`127.0.0.1`)** so other machines on the LAN cannot reach the kill APIs. To share on a trusted network: `HOST=0.0.0.0 npm start`.

## Tests

```bash
npm test   # full API regression: boots a temporary instance, cleans up afterwards (same as CI)
```

## Features

| Feature | Description |
| --- | --- |
| Pre-configured ports | `5173, 3000, 5174, 8080, 3001` — written to `ports.json` on first run |
| Add / remove ports | Type a port in the top bar to add it; the "Delete" button on each row removes it from monitoring (running processes are never touched) |
| Status detection | Live detection on every refresh: Free (green) / Occupied (red); when occupied, shows the process name + PID + command line |
| Stop process | Kills the **whole process tree** (Unix SIGTERM → SIGKILL; Windows `taskkill /T`) |
| Batch stop | Select multiple rows → "Stop selected (n)", or one-click "Stop all", with per-port success/failure summary |
| Port notes | Click the note cell to edit inline (≤50 chars), persisted in `ports.json` |
| Tool detection | Auto-tags processes: vite / webpack / next / node / npm / python / java / docker / nginx / system services |
| Live push | With auto-refresh on, updates stream over SSE (server pushes at the chosen interval; auto fallback to polling on disconnect) |
| Auto refresh | Toolbar option: off / every 3 s / 5 s / 10 s |
| Error reporting | Clear, actionable errors instead of silent failure when a process cannot be killed (system service, insufficient permissions) |

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/ports` | Port list + live occupancy status + notes |
| POST | `/api/ports` | Add a port, body `{ "port": 6001 }` |
| DELETE | `/api/ports/:port` | Remove a port from the list |
| PUT | `/api/ports/:port/note` | Save/clear the note, body `{ "note": "frontend" }` (empty = clear) |
| POST | `/api/kill/:port` | Terminate the process tree holding the port |
| POST | `/api/kill-all` | Batch terminate, body `{ "ports": [...] }` (omitted = all occupied monitored ports) |
| GET | `/api/ports/events` | SSE live push, `?interval=seconds` (default 2, range 1–30) |

## Detection mechanism (cross-platform)

| Platform | Port → PID | Process name / tool tag | Terminate |
| --- | --- | --- | --- |
| macOS / Linux | `lsof -nP -iTCP -sTCP:LISTEN` (falls back to `ss -ltnp`; on Linux without either, reads `/proc/net/tcp` + inode mapping) | `ps -o pid=,comm=,args=`, auto-classified by command line (vite/webpack/node/…) | `process.kill` whole tree: SIGTERM → SIGKILL |
| Windows | `netstat -ano -p tcp` | `tasklist /FO CSV /NH`, auto-classified by image name | `taskkill /PID <pid> /T` (recursive), `/F` fallback |

## FAQ

- **Security (since v1.1)**: binds `127.0.0.1` only by default, so other LAN devices cannot reach the API. To share on a trusted network, start with `HOST=0.0.0.0`.
- **Blank page / `ReactDOM is not defined` / 404 on assets**: hard-refresh with `Ctrl+F5` (`Cmd+Shift+R` on macOS) and open `http://localhost:3081` directly in the browser — not through a proxy or preview pane. If this is a manually copied copy, re-run `npm install` (rebuilds the front-end runtime under `public/vendor/`) and restart. The page ships with a self-diagnostic overlay that tells you exactly which asset failed to load.
- **Stop fails**: "insufficient permissions" → re-run the tool as admin/root; "still occupied" → the process ignores termination signals (e.g. a system service) and needs manual handling.
- **The tool's own port is taken**: startup reports `EADDRINUSE` — set `SERVER_PORT=xxxx` to use another port.
- **Removed a port by accident**: edit `ports.json` to add it back, or delete the file and restart (default ports are recreated when the file is missing or corrupt). Removing a port from monitoring never kills its process.
- **Self-protection**: even if the tool's own port is added to the list, the backend refuses to terminate it and explains why.