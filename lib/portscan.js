'use strict';

/**
 * portscan.js —— 端口占用检测与进程终止
 *
 * 检测策略（按平台自动选择）：
 *   macOS / Linux : lsof -nP -iTCP -sTCP:LISTEN   （缺失时降级 ss -ltnp）
 *                   Linux 且无 lsof/ss 时降级 /proc/net/tcp + inode→pid 映射
 *   Windows       : netstat -ano -p tcp + tasklist
 *
 * 终止策略（killPort，进程树感知）：
 *   Unix    : SIGTERM 整棵进程树（子进程优先）→ 仍占用则 SIGKILL 整树兜底
 *   Windows : taskkill /PID <pid> /T（带 /F 强杀）递归终止进程树
 *   失败时返回明确错误信息（权限不足 / 系统服务 / 进程已退出等）
 */

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);
const CMD_TIMEOUT = 4000;
const MAX_BUFFER = 8 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return execFileP(cmd, args, { timeout: CMD_TIMEOUT, windowsHide: true, maxBuffer: MAX_BUFFER })
    .then(({ stdout }) => stdout);
}

/** 从 "0.0.0.0:5173" / "[::]:8080" / "*:3000" 等令牌中解析端口号 */
function parsePortNumber(token) {
  const m = /:(\d+)\s*$/.exec(String(token || ''));
  return m ? Number(m[1]) : null;
}

/* ---------------- Unix 检测源 ---------------- */

/** lsof：全量列出 TCP LISTEN 端口 */
async function lsofRows() {
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  const rows = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('COMMAND')) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 3) continue;
    const name = parts[0];
    const pid = Number(parts[1]);
    let port = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parsePortNumber(parts[i]);
      if (p) { port = p; break; }
    }
    if (Number.isInteger(pid) && pid > 0 && port) rows.push({ port, pid, name });
  }
  return rows;
}

/** ss：Linux iproute2 备用源 */
async function ssRows() {
  const out = await run('ss', ['-ltnp']);
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*LISTEN\b.*?\s([^:]+|\[[^\]]*\]):(\d+)\s.*?users:\s*\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (!m) continue;
    const pid = Number(m[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ port: Number(m[2]), pid, name: m[3] });
  }
  return rows;
}

/** Linux /proc 兜底：/proc/net/tcp(+tcp6) 的 LISTEN 行 → inode → fd 目录映射出 PID */
async function linuxProcRows() {
  const map = new Map(); // port -> [{ inode }]
  const tcpFiles = ['/proc/net/tcp', '/proc/net/tcp6'];
  for (const file of tcpFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      if (parts[3] !== '0A') continue; // 0A = LISTEN
      const local = parts[1];
      const idx = local.lastIndexOf(':');
      const port = parseInt(local.slice(idx + 1), 16);
      const inode = parts[9];
      if (port > 0 && inode && inode !== '0') {
        if (!map.has(port)) map.set(port, []);
        map.get(port).push({ inode, port });
      }
    }
  }
  if (!map.size) return [];
  const inodePid = new Map();
  let procs;
  try { procs = fs.readdirSync('/proc'); } catch { return []; }
  for (const name of procs) {
    if (!/^\d+$/.test(name)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${name}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${name}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m) inodePid.set(m[1], Number(name));
    }
  }
  const rows = [];
  for (const [port, list] of map) {
    for (const r of list) {
      const pid = inodePid.get(r.inode);
      if (pid) rows.push({ port, pid, name: 'unknown' });
    }
  }
  return rows;
}

/* ---------------- Windows 检测源 ---------------- */

async function winRows() {
  const out = await run('netstat', ['-ano', '-p', 'tcp']);
  const rows = [];
  const seen = new Set();
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== 'TCP') continue;
    const port = parsePortNumber(f[1]);
    const pid = Number(f[4]);
    if (!port || !Number.isInteger(pid) || pid <= 0) continue;
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ port, pid, name: 'TCP 监听' });
  }
  const pidSet = [...new Set(rows.map((r) => r.pid))];
  if (pidSet.length) {
    try {
      const tOut = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const names = new Map();
      for (const line of tOut.split('\n')) {
        const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
        if (m) names.set(Number(m[2]), m[1]);
      }
      for (const r of rows) if (names.has(r.pid)) r.name = names.get(r.pid);
    } catch { /* 名称拿不到时保留占位名 */ }
  }
  return rows;
}

/* ---------------- 汇总 ---------------- */

/** Unix：依次尝试 lsof → ss → /proc（仅 Linux）；退出码 1 视为“无监听” */
async function unixRows() {
  const sources = [
    { name: 'lsof', fn: lsofRows },
    { name: 'ss', fn: ssRows },
    ...(process.platform === 'linux' ? [{ name: '/proc', fn: linuxProcRows }] : []),
  ];
  let lastErr = null;
  for (const { name, fn } of sources) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.killed) throw new Error(`端口检测超时（${name}）`);
      if (err && err.code === 1) return [];
      if (err && err.code === 'ENOENT') { lastErr = err; continue; }
      lastErr = err;
    }
  }
  throw new Error(
    `端口检测失败：系统缺少可用的检测命令（尝试过 ${sources.map((s) => s.name).join('、')}）` +
    (lastErr ? `。最后错误：${lastErr.message}` : '')
  );
}

/* ---------------- 开发工具识别 ---------------- */

const SYSTEM_NAMES = new Set([
  'sshd', 'systemd', 'svchost', 'svchost.exe', 'wininit', 'wininit.exe',
  'lsass', 'lsass.exe', 'services', 'services.exe', 'launchd', 'sysmon', 'csrss', 'smss',
]);

function classify(name, cmdline) {
  const n = (name || '').toLowerCase();
  const c = (cmdline || '').toLowerCase();
  const has = (re) => re.test(c);
  if (has(/vite/)) return 'vite';
  if (has(/webpack/)) return 'webpack';
  if (has(/(^|\s|\/)next(-dev)?(\s|$)/)) return 'next';
  if (has(/nuxt/)) return 'nuxt';
  if (has(/(^|\s|\/)(npm|pnpm|yarn|bun)(\s|$)/) || /^(npm|pnpm|yarn|bun)(\.exe)?$/.test(n)) return 'npm';
  if (n === 'node' || n === 'node.exe') return 'node';
  if (has(/python/) || /^python/.test(n)) return 'python';
  if (has(/java/) || /^java/.test(n)) return 'java';
  if (has(/docker/) || n === 'docker' || n === 'dockerd') return 'docker';
  if (has(/nginx/) || n === 'nginx') return 'nginx';
  if (SYSTEM_NAMES.has(n) || /^\/(usr\/)?sbin\//.test(cmdline || '')) return 'system';
  return 'unknown';
}

/* ---------------- 扫描 ---------------- */

/**
 * 扫描一批端口，返回 [{ port, occupied, pids:[{pid,name,cmdline,kind}], checkedAt }]
 */
async function scanPorts(portList) {
  const ports = [...new Set(portList.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535))]
    .sort((a, b) => a - b);

  const rows = process.platform === 'win32' ? await winRows() : await unixRows();

  const byPort = new Map();
  const pids = new Set();
  for (const r of rows) {
    if (!byPort.has(r.port)) byPort.set(r.port, []);
    byPort.get(r.port).push({ pid: r.pid, name: r.name });
    pids.add(r.pid);
  }

  // Unix 下用 ps 补全进程名与命令行，并做工具分类
  if (process.platform !== 'win32' && pids.size) {
    try {
      const out = await run('ps', ['-p', [...pids].join(','), '-o', 'pid=,comm=,args=']);
      const attr = new Map();
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (m) attr.set(Number(m[1]), { name: m[2], cmdline: (m[3] || '').trim().slice(0, 240) });
      }
      for (const list of byPort.values()) {
        for (const p of list) {
          const a = attr.get(p.pid);
          if (a) { p.name = a.name; p.cmdline = a.cmdline; }
        }
      }
    } catch { /* 可选信息，忽略 */ }
  }

  for (const list of byPort.values()) {
    for (const p of list) p.kind = classify(p.name, p.cmdline);
  }

  const checkedAt = Date.now();
  return ports.map((port) => ({
    port,
    occupied: byPort.has(port) && byPort.get(port).length > 0,
    pids: byPort.get(port) || [],
    checkedAt,
  }));
}

/** 单独检测一个端口（kill 后复查用） */
async function checkPort(port) {
  const [r] = await scanPorts([port]);
  return r;
}

/* ---------------- 进程树与终止 ---------------- */

function killErrMessage(e) {
  if (!e) return '未知错误';
  if (e.code === 'ESRCH') return '进程不存在（可能已自行退出）';
  if (e.code === 'EPERM') return '权限不足：该进程归属其他用户或系统，请以管理员/root 身份运行本工具';
  return e.message || String(e);
}

const describe = (pids) => pids.map((p) => `${p.name}(PID ${p.pid})`).join('、');

/**
 * Unix：构建 pid→ppid 映射，返回 rootPids 的全部后代（不含 root 自身）。
 * 顺序：BFS 序（父先于子），调用方反向后即为“子先于父”。
 */
async function collectProcessTree(rootPids) {
  const rootSet = new Set(rootPids);
  let ppidMap = new Map();
  try {
    const out = await run('ps', ['-eo', 'pid=,ppid=,comm=']);
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      if (m) ppidMap.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
    }
  } catch { return []; } // 拿不到进程树时退化为只杀监听进程

  const tree = [];
  const seen = new Set(rootSet);
  const queue = [];
  for (const [pid, info] of ppidMap) {
    if (rootSet.has(info.ppid) && !rootSet.has(pid)) queue.push(pid);
  }
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = ppidMap.get(pid);
    tree.push({ pid, name: info ? info.comm : 'child' });
    for (const [cpid, cinfo] of ppidMap) {
      if (cinfo.ppid === pid && !seen.has(cpid)) queue.push(cpid);
    }
  }
  return tree;
}

/** Windows：taskkill /T 递归终止整棵进程树 */
async function taskkillTree(p, force) {
  const args = ['/PID', String(p.pid), '/T'];
  if (force) args.push('/F');
  try {
    await run('taskkill', args);
    return true;
  } catch { return false; }
}

/**
 * 终止占用端口的整棵进程树。
 * - 端口空闲 → { ok:true }
 * - SIGTERM（Windows 为 taskkill /T）后端口释放 → { ok:true, extraKilled }
 * - 仍占用 → SIGKILL / taskkill /T /F 兜底
 * - 全部失败 → { ok:false, error: 明确原因, still, attempts }
 */
async function killPort(port, selfPid) {
  const before = await checkPort(port);
  if (!before.occupied) {
    return { ok: true, message: `端口 ${port} 当前空闲，无需终止进程` };
  }
  if (before.pids.some((p) => p.pid === selfPid)) {
    return {
      ok: false,
      error: `端口 ${port} 正被本工具自身占用（PID ${selfPid}），已自动跳过终止`,
    };
  }

  const listeners = before.pids;
  const isWin = process.platform === 'win32';
  const attempts = [];

  async function sendSignal(p, sig) {
    try {
      process.kill(p.pid, sig);
      attempts.push({ pid: p.pid, name: p.name, signal: sig, status: 'ok' });
      return true;
    } catch (e) {
      attempts.push({ pid: p.pid, name: p.name, signal: sig, status: 'failed', error: killErrMessage(e) });
      return false;
    }
  }

  // 1) 优雅终止整棵树（子进程优先）
  let tree = [];
  let killOrder = listeners.map((p) => ({ ...p }));
  if (isWin) {
    for (const p of listeners) await taskkillTree(p, false);
  } else {
    tree = await collectProcessTree(listeners.map((p) => p.pid));
    killOrder = [...tree, ...listeners];
    for (const p of killOrder) await sendSignal(p, 'SIGTERM');
  }
  await sleep(900);

  let after = await checkPort(port);
  if (!after.occupied) {
    const extra = isWin ? [] : tree;
    const msg = `已终止 ${describe(listeners)}${extra.length ? ` 及其 ${extra.length} 个子进程` : ''}，端口 ${port} 已释放`;
    return { ok: true, killed: [...listeners, ...extra], extraKilled: extra.length, killedCount: listeners.length + extra.length, message: msg, attempts };
  }

  // 2) 强制终止兜底
  if (isWin) {
    for (const p of after.pids) await taskkillTree(p, true);
  } else {
    for (const p of [...tree, ...after.pids]) await sendSignal(p, 'SIGKILL');
  }
  await sleep(700);

  const after2 = await checkPort(port);
  if (!after2.occupied) {
    const extra = isWin ? [] : tree;
    const msg = `已强制终止 ${describe(after.pids)}${extra.length ? ` 及其 ${extra.length} 个子进程` : ''}，端口 ${port} 已释放`;
    return { ok: true, forced: true, killed: [...after.pids, ...extra], extraKilled: extra.length, killedCount: after.pids.length + extra.length, message: msg, attempts };
  }
  after = after2;

  return {
    ok: false,
    error: `端口 ${port} 仍被进程占用：${describe(after.pids)}。该进程可能是系统服务或无权限终止（如 root 启动的进程），请以管理员/root 身份运行本工具后重试，或手动处理。`,
    still: after.pids,
    attempts,
  };
}

module.exports = { scanPorts, checkPort, killPort, parsePortNumber, classify };