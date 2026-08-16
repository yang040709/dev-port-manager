'use strict';

/**
 * server.js —— Dev Port Manager 后端
 *
 * 功能：
 *   GET    /api/ports       端口列表 + 实时占用检测
 *   POST   /api/ports       添加自定义端口（写入 ports.json）
 *   DELETE /api/ports/:port 删除端口
 *   POST   /api/kill/:port  终止占用该端口的进程
 *
 * 前端为纯静态页（React UMD + Babel standalone，无构建），由本服务直接托管。
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

const { scanPorts, killPort } = require('./lib/portscan');

const SERVER_PORT = Number(process.env.SERVER_PORT || 3081);
const DEFAULT_PORTS = [5173, 3000, 5174, 8080, 3001];
const PORTS_FILE = path.join(__dirname, 'ports.json');

/* ---------- 端口列表持久化（简单 JSON 文件） ---------- */

function savePorts(list) {
  fs.writeFileSync(PORTS_FILE, JSON.stringify({ ports: list }, null, 2) + '\n');
}

function loadPorts() {
  try {
    const raw = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
    if (Array.isArray(raw.ports) && raw.ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
      return [...new Set(raw.ports)].sort((a, b) => a - b);
    }
  } catch { /* 文件不存在或损坏 → 使用默认端口并重新生成 */ }
  const def = [...DEFAULT_PORTS].sort((a, b) => a - b);
  savePorts(def);
  return def;
}

/* ---------- HTTP 服务 ---------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// 端口列表 + 实时状态
app.get('/api/ports', async (req, res) => {
  try {
    const ports = loadPorts();
    const list = await scanPorts(ports);
    res.json({ ok: true, ports: list, server: { port: SERVER_PORT, pid: process.pid } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
  const list = loadPorts();
  if (list.includes(port)) {
    return res.status(409).json({ ok: false, error: `端口 ${port} 已在列表中` });
  }
  list.push(port);
  list.sort((a, b) => a - b);
  savePorts(list);
  res.status(201).json({ ok: true, port, ports: list });
});

// 删除端口（仅从列表移除，不影响进程）
app.delete('/api/ports/:port', (req, res) => {
  const port = Number(req.params.port);
  const list = loadPorts();
  const idx = list.indexOf(port);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: `端口 ${port} 不在列表中` });
  }
  list.splice(idx, 1);
  savePorts(list);
  res.json({ ok: true, port, ports: list });
});

// 停止占用端口的进程
app.post('/api/kill/:port', async (req, res) => {
  const port = Number(req.params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ ok: false, error: '无效的端口号' });
  }
  try {
    const result = await killPort(port, process.pid);
    if (result.ok) {
      res.json({ ok: true, message: result.message, killed: result.killed, forced: !!result.forced });
    } else {
      res.status(409).json({ ok: false, error: result.error, still: result.still, attempts: result.attempts });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: `终止进程时出错：${err.message}` });
  }
});

/* ---------- 静态资源 ---------- */

// 免构建前端运行时已固化在 public/vendor/（npm install 时由 scripts/vendor-assets.js 自动重建）
app.use(express.static(path.join(__dirname, 'public')));

// 兜底 404（须放在静态资源之后）
app.use((req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

/* ---------- 启动 ---------- */

const server = app.listen(SERVER_PORT, () => {
  console.log('');
  console.log('  🛠️  Dev Port Manager 已启动');
  console.log(`  访问地址 : http://localhost:${SERVER_PORT}`);
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