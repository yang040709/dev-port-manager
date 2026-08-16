'use strict';

/**
 * server.js —— Dev Port Manager 后端
 *
 * 安全：默认只监听 127.0.0.1（HOST 环境变量可改为 0.0.0.0 对外开放）
 *
 * API：
 *   GET    /api/ports              端口列表 + 实时占用检测 + 备注
 *   POST   /api/ports              添加自定义端口（写入 ports.json）
 *   DELETE /api/ports/:port        删除端口
 *   PUT    /api/ports/:port/note   保存/清除端口备注
 *   POST   /api/kill/:port         终止占用该端口的整棵进程树
 *   POST   /api/kill-all           批量终止（body: { ports: [...] }，缺省=全部占用中）
 *   GET    /api/ports/events       SSE 实时推送（?interval=秒，缺省 2）
 *
 * 前端为纯静态页（React UMD + Babel standalone，无构建），由本服务直接托管。
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const { scanPorts, killPort } = require('./lib/portscan');

const HOST = process.env.HOST || '127.0.0.1';
const SERVER_PORT = Number(process.env.SERVER_PORT || 3081);
// 常用开发端口（vite×3 / node×3 / angular / flask / django / 通用 http）
const DEFAULT_PORTS = [5173, 3000, 5174, 8080, 3001, 5175, 3002, 4200, 5000, 8000];
const PORT_LIST_VERSION = 2;
const PORTS_FILE = path.join(__dirname, 'ports.json');
const SSE_TICK_MIN = 1000;
const SSE_TICK_MAX = 30000;

/* ---------- 端口列表 + 备注持久化（简单 JSON 文件） ---------- */

function saveState(state) {
  fs.writeFileSync(PORTS_FILE, JSON.stringify({
    version: state.version || PORT_LIST_VERSION,
    ports: state.ports,
    notes: state.notes || {},
  }, null, 2) + '\n');
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
    if (Array.isArray(raw.ports) && raw.ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
      const notes = raw.notes && typeof raw.notes === 'object' ? raw.notes : {};
      const ports = [...new Set(raw.ports)].sort((a, b) => a - b);
      // 一次性迁移：默认端口扩充（如 v1.1 从 5 个扩到 10 个）时补入新默认端口，
      // 迁移后用户自行删除的默认端口不会再被加回
      let migrated = false;
      if (!raw.version || raw.version < PORT_LIST_VERSION) {
        for (const p of DEFAULT_PORTS) {
          if (!ports.includes(p)) { ports.push(p); migrated = true; }
        }
        if (migrated) ports.sort((a, b) => a - b);
      }
      const state = { version: PORT_LIST_VERSION, ports, notes };
      if (migrated) saveState(state);
      return state;
    }
  } catch { /* 文件不存在或损坏 → 使用默认端口并重新生成 */ }
  const state = { version: PORT_LIST_VERSION, ports: [...DEFAULT_PORTS].sort((a, b) => a - b), notes: {} };
  saveState(state);
  return state;
}

/* ---------- SSE：单例扫描定时器 + 多客户端广播 ---------- */

const sseClients = new Set();
let sseTimer = null;
let lastSnapshot = '';

async function pushSnapshot(force) {
  try {
    const { ports, notes } = loadState();
    const list = await scanPorts(ports);
    const payload = JSON.stringify({ ok: true, ports: list, notes, server: { port: SERVER_PORT, pid: process.pid } });
    if (!force && payload === lastSnapshot) return; // 无变化不推送
    lastSnapshot = payload;
    for (const res of sseClients) {
      try { res.write(`data: ${payload}\n\n`); } catch { /* 客户端已断开 */ }
    }
  } catch { /* 扫描失败跳过本次推送 */ }
}

function refSseTimer(intervalMs) {
  if (sseClients.size && !sseTimer) {
    sseTimer = setInterval(() => pushSnapshot(false), intervalMs);
  }
  if (!sseClients.size && sseTimer) {
    clearInterval(sseTimer);
    sseTimer = null;
    lastSnapshot = '';
  }
}

/* ---------- HTTP 服务 ---------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// 端口列表 + 实时状态 + 备注
app.get('/api/ports', async (req, res) => {
  try {
    const { ports, notes } = loadState();
    const list = await scanPorts(ports);
    res.json({ ok: true, ports: list, notes, server: { port: SERVER_PORT, pid: process.pid } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SSE 实时推送
app.get('/api/ports/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders && res.flushHeaders();
  res.write('retry: 3000\n\n');

  const secs = Math.max(1, Math.min(30, Number(req.query.interval) || 2));
  sseClients.add(res);
  refSseTimer(secs * 1000);
  pushSnapshot(true); // 连接即推一次快照

  req.on('close', () => {
    sseClients.delete(res);
    refSseTimer(secs * 1000);
  });
});

// 添加端口
app.post('/api/ports', (req, res) => {
  const port = Number(req.body && req.body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ ok: false, error: '端口号必须是 1–65535 的整数' });
  }
  if (port === SERVER_PORT) {
    return res.status(400).json({ ok: false, error: `端口 ${port} 是本工具自身端口，不能加入列表` });
  }
  const state = loadState();
  if (state.ports.includes(port)) {
    return res.status(409).json({ ok: false, error: `端口 ${port} 已在列表中` });
  }
  state.ports.push(port);
  state.ports.sort((a, b) => a - b);
  saveState(state);
  pushSnapshot(true);
  res.status(201).json({ ok: true, port, ports: state.ports });
});

// 删除端口（仅从列表移除，不影响进程）
app.delete('/api/ports/:port', (req, res) => {
  const port = Number(req.params.port);
  const state = loadState();
  const idx = state.ports.indexOf(port);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: `端口 ${port} 不在列表中` });
  }
  state.ports.splice(idx, 1);
  delete state.notes[String(port)];
  saveState(state);
  pushSnapshot(true);
  res.json({ ok: true, port, ports: state.ports });
});

// 保存/清除端口备注（空字符串 = 清除）
app.put('/api/ports/:port/note', (req, res) => {
  const port = Number(req.params.port);
  const state = loadState();
  if (!state.ports.includes(port)) {
    return res.status(404).json({ ok: false, error: `端口 ${port} 不在列表中` });
  }
  const note = String((req.body && req.body.note) || '').trim().slice(0, 50);
  if (note) state.notes[String(port)] = note;
  else delete state.notes[String(port)];
  saveState(state);
  pushSnapshot(true);
  res.json({ ok: true, port, note });
});

// 停止占用端口的整棵进程树
app.post('/api/kill/:port', async (req, res) => {
  const port = Number(req.params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ ok: false, error: '无效的端口号' });
  }
  try {
    const result = await killPort(port, process.pid);
    pushSnapshot(true);
    if (result.ok) {
      res.json({
        ok: true,
        message: result.message,
        killed: result.killed,
        killedCount: result.killedCount || 0,
        extraKilled: result.extraKilled || 0,
        forced: !!result.forced,
      });
    } else {
      res.status(409).json({ ok: false, error: result.error, still: result.still, attempts: result.attempts });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: `终止进程时出错：${err.message}` });
  }
});

// 批量终止（body: { ports: [...] }；缺省 = 停止全部占用中的被监控端口）
app.post('/api/kill-all', async (req, res) => {
  try {
    const state = loadState();
    const reqPorts = req.body && Array.isArray(req.body.ports) ? req.body.ports.map(Number) : [];
    const wanted = (reqPorts.length ? reqPorts : state.ports)
      .filter((p) => Number.isInteger(p) && state.ports.includes(p));
    if (!wanted.length) {
      return res.json({ ok: true, results: [], stopped: 0, failed: 0 });
    }
    const scan = await scanPorts(wanted);
    const targets = scan.filter((p) => p.occupied).map((p) => p.port);
    if (!targets.length) {
      return res.json({ ok: true, results: [], stopped: 0, failed: 0 });
    }
    const results = [];
    for (const port of targets) {
      try {
        const r = await killPort(port, process.pid);
        results.push({ port, ok: r.ok, message: r.message, error: r.error, killedCount: r.killedCount || 0, extraKilled: r.extraKilled || 0 });
      } catch (e) {
        results.push({ port, ok: false, error: e.message });
      }
    }
    pushSnapshot(true);
    const stopped = results.filter((r) => r.ok).length;
    const failed = results.length - stopped;
    res.json({ ok: failed === 0, results, stopped, failed });
  } catch (err) {
    res.status(500).json({ ok: false, error: `批量终止时出错：${err.message}` });
  }
});

/* ---------- 静态资源 ---------- */

// 免构建前端运行时已固化在 public/vendor/（npm install 时由 scripts/vendor-assets.js 自动重建）
app.use(express.static(path.join(__dirname, 'public')));

// 兜底 404（须放在静态资源之后）
app.use((req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

/* ---------- 启动 ---------- */

const server = app.listen(SERVER_PORT, HOST, () => {
  const display = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log('');
  console.log('  🛠️  Dev Port Manager 已启动');
  console.log(`  访问地址 : http://${display}:${SERVER_PORT}`);
  console.log(`  监听地址 : ${HOST}${HOST === '127.0.0.1' ? '（仅本机，安全）' : '（对外，请确认可信网络）'}`);
  console.log(`  进程 PID : ${process.pid}`);
  console.log(`  端口列表 : ${PORTS_FILE}`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n启动失败：端口 ${SERVER_PORT} 已被其他进程占用。\n可用环境变量更换工具自身端口，例如：SERVER_PORT=3082 node server.js\n`);
    process.exit(1);
  }
  throw err;
});