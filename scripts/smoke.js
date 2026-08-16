'use strict';

/**
 * smoke.js —— Dev Port Manager 全 API 回归测试（CI 与本地通用）
 *
 * 用法：node scripts/smoke.js   （可用 SERVER_PORT 指定测试服务端口，默认 33123）
 * 它会自行启动一个 server 实例，跑完所有用例后自动关闭。
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.SERVER_PORT || 33123);
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  PASS  ' + name); }
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: HOST, port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function getSSE(p, waitMs) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: HOST, port: PORT, path: p }, (res) => {
      let buf = '';
      const t = setTimeout(() => { r.destroy(); resolve(buf); }, waitMs);
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('data:')) { clearTimeout(t); r.destroy(); resolve(buf); }
      });
      res.on('error', reject);
    });
    r.on('error', reject);
  });
}

function spawnListener(port) {
  const code = `require('http').createServer((q,s)=>s.end('ok')).listen(${port})`;
  return spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
}

/** 等待子进程退出（最多 waitMs），返回最终 exitCode/killed */
async function waitExit(child, waitMs = 2000) {
  if (isDead(child)) return;
  await Promise.race([
    new Promise((resolve) => child.on('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, waitMs)),
  ]);
}

/** 进程已死（正常退出 / 信号杀死 / 主动终止） */
function isDead(child) {
  return child.exitCode !== null || child.signalCode !== null || child.killed === true;
}

async function awaitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await req('GET', '/');
      if (r.status === 200) return true;
    } catch (e) { /* 未就绪 */ }
    await sleep(300);
  }
  return false;
}

async function main() {
  // 端口占用探测：拒绝在残留实例上假跑
  const pre = await req('GET', '/').catch(() => null);
  if (pre && pre.status === 200) {
    console.error(`smoke: ${HOST}:${PORT} 已被占用（疑似残留的测试实例），请先清理后再运行`);
    process.exit(2);
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SERVER_PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const killChild = () => { try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } };
  process.on('exit', killChild);

  console.log(`smoke: 启动测试服务 http://${HOST}:${PORT}`);
  check('服务启动（GET / 返回 200）', await awaitReady());

  let r;
  r = await req('GET', '/api/ports');
  check('GET /api/ports ok', r.status === 200 && r.json.ok === true);
  const listedPorts = (r.json.ports || []).map((p) => p.port);
  const defaults = [5173, 3000, 5174, 8080, 3001];
  check('包含全部预置端口', defaults.every((p) => listedPorts.includes(p)), listedPorts.join(','));
  check('响应含 notes 字段', r.json && typeof r.json.notes === 'object');
  check('响应含 server 信息', r.json && r.json.server && r.json.server.port === PORT);

  r = await req('POST', '/api/ports', { port: 61234 });
  check('POST 添加端口 61234 → 201', r.status === 201 && r.json.ok === true);
  r = await req('POST', '/api/ports', { port: 61234 });
  check('重复添加 → 409', r.status === 409);
  r = await req('POST', '/api/ports', { port: 99999 });
  check('非法端口 99999 → 400', r.status === 400);

  r = await req('PUT', '/api/ports/3000/note', { note: 'frontend' });
  check('PUT 保存备注 → ok', r.status === 200 && r.json.ok === true && r.json.note === 'frontend');
  r = await req('GET', '/api/ports');
  check('GET 返回备注', r.json.notes && r.json.notes['3000'] === 'frontend');
  r = await req('PUT', '/api/ports/3000/note', { note: '' });
  check('PUT 空备注清除', r.status === 200 && r.json.note === '');

  r = await req('POST', '/api/kill/3000');
  check('对空闲端口 kill → ok（无需终止）', r.status === 200 && r.json.ok === true,
    r.json && r.json.message);

  // 占用 → 单杀（先加入监控列表，与真实使用一致）
  r = await req('POST', '/api/ports', { port: 61236 });
  check('监控列表添加 61236', r.status === 201);
  const dummy = spawnListener(61236);
  await sleep(800);
  r = await req('POST', '/api/kill/61236');
  check('单端口 kill 占用进程 → ok', r.status === 200 && r.json.ok === true,
    r.json && (r.json.message || r.json.error));
  check('kill 后端口空闲', (await req('GET', '/api/ports')).json.ports.find((p) => p.port === 61236).occupied === false);
  await waitExit(dummy);
  check('kill 进程已退出', isDead(dummy),
    `exit=${dummy.exitCode} signal=${dummy.signalCode}`);

  // 批量 kill-all
  await req('POST', '/api/ports', { port: 61236 });
  await req('POST', '/api/ports', { port: 61237 });
  const d1 = spawnListener(61236);
  const d2 = spawnListener(61237);
  await sleep(800);
  r = await req('POST', '/api/kill-all', { ports: [61236, 61237] });
  check('kill-all 批量 → stopped=2', r.status === 200 && r.json.stopped === 2,
    JSON.stringify(r.json));
  const afterAll = (await req('GET', '/api/ports')).json.ports;
  check('kill-all 后两个端口均空闲',
    !afterAll.find((p) => p.port === 61236).occupied && !afterAll.find((p) => p.port === 61237).occupied);
  await waitExit(d1); await waitExit(d2);
  check('批量进程已退出', isDead(d1) && isDead(d2),
    `d1=${d1.exitCode}/${d1.signalCode} d2=${d2.exitCode}/${d2.signalCode}`);

  // SSE
  const sse = await getSSE('/api/ports/events?interval=1', 5000);
  check('SSE 收到 data: 推送', sse.includes('data:'), sse.slice(0, 80).replace(/\n/g, ' '));

  // 删除
  r = await req('DELETE', '/api/ports/61234');
  check('DELETE 61234 → ok', r.status === 200 && r.json.ok === true);
  r = await req('DELETE', '/api/ports/61234');
  check('重复 DELETE → 404', r.status === 404);

  // 静态与兜底
  r = await req('GET', '/vendor/react/react.development.js');
  check('vendor 静态资源 200', r.status === 200 && r.text.length > 10000);
  r = await req('GET', '/api/nope');
  check('未知 API → 404', r.status === 404);

  // 清理测试端口
  await req('DELETE', '/api/ports/61236');
  await req('DELETE', '/api/ports/61237');

  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  await sleep(200);

  console.log(failures === 0 ? '\n  ✔ smoke 全部通过' : `\n  ✘ smoke 共 ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke 异常：', e); process.exit(1); });