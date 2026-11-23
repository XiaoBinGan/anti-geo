#!/usr/bin/env node
/**
 * blocklist-server.mjs — 本地名单服务（用来端到端验证订阅链路）
 *
 * 跑法：
 *   node scripts/blocklist-server.mjs
 *   node scripts/blocklist-server.mjs --file ./my-list.json --port 8788
 *
 * 然后到扩展设置页填：http://127.0.0.1:8788/blocklist.json
 *
 * 这个脚本只做三件事：读 JSON、校验、带 CORS 返回。
 * 真要上线就把同样的 JSON 扔到任意静态托管（GitHub Pages / Gist / 对象存储）。
 *
 * 加 --watch 会在文件变化时自动重载，方便边改边测。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── 参数 ── */
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const FILE = path.resolve(getArg('--file', path.join(__dirname, '..', 'assets', 'blocklist.example.json')));
const PORT = parseInt(getArg('--port', '8788'), 10);
const WATCH = argv.includes('--watch');

/* ── 校验：只放行结构正确的内容，避免把脏数据喂给扩展 ── */
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63}(?<!-))+$/i;

function loadAndValidate() {
  const raw = fs.readFileSync(FILE, 'utf8');
  const data = JSON.parse(raw);

  const list = Array.isArray(data) ? data : data.domains;
  if (!Array.isArray(list)) throw new Error('缺少 domains 数组');

  const clean = [];
  const seen = new Set();
  let dropped = 0;
  for (const item of list) {
    const d = typeof item === 'string' ? item : item?.d ?? item?.domain;
    if (typeof d !== 'string') { dropped++; continue; }
    const norm = d.trim().toLowerCase().replace(/^www\./, '');
    if (!DOMAIN_RE.test(norm)) { dropped++; continue; }
    if (seen.has(norm)) continue; // 去重
    seen.add(norm);

    // 输出只保留约定字段，别把源文件的其它键带出去
    const entry = { d: norm };
    if (item && typeof item === 'object') {
      if (typeof item.reason === 'string' && item.reason.trim()) entry.reason = item.reason.trim().slice(0, 40);
      if (Number.isFinite(item.score)) entry.score = Math.max(0, Math.min(100, item.score));
    }
    if (entry.score === undefined) entry.score = 45;
    clean.push(entry);
  }

  return {
    body: JSON.stringify({
      version: data.version ?? 1,
      updated: data.updated ?? new Date().toISOString().slice(0, 10),
      name: data.name ?? '本地名单',
      domains: clean,
    }),
    count: clean.length,
    dropped,
  };
}

/* ── 服务 ── */
let cache = null;
let cacheMtime = 0;

function serve() {
  const st = fs.statSync(FILE);
  if (!cache || st.mtimeMs !== cacheMtime) {
    cache = loadAndValidate();
    cacheMtime = st.mtimeMs;
  }
  return cache;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, file: FILE }));
  }

  if (url.pathname === '/blocklist.json') {
    try {
      const out = serve();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(out.body);
      console.log(`[${new Date().toLocaleTimeString()}] 200 blocklist.json  ${out.count} 条` +
        (out.dropped ? `（丢弃非法项 ${out.dropped}）` : ''));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: String(e.message) }));
      console.error('名单读取失败:', e.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end('404。可用路径：/blocklist.json、/health');
});

server.listen(PORT, '127.0.0.1', () => {
  const st = serve();
  console.log(`名单服务已启动  http://127.0.0.1:${PORT}/blocklist.json`);
  console.log(`数据文件        ${FILE}`);
  console.log(`有效域名        ${st.count} 条${st.dropped ? `（另有 ${st.dropped} 条非法已丢弃）` : ''}`);
  console.log(`\n把这个地址填到扩展 → 设置 → 订阅名单：`);
  console.log(`  http://127.0.0.1:${PORT}/blocklist.json\n`);
});

if (WATCH) {
  fs.watch(FILE, { persistent: false }, () => {
    try {
      cacheMtime = 0;
      const st = serve();
      console.log(`[reload] ${st.count} 条`);
    } catch (e) {
      console.error('[reload] 失败:', e.message);
    }
  });
}
