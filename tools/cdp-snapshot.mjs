#!/usr/bin/env node
/**
 * cdp-snapshot.mjs — 直接连你的 Chrome 读 DOM 结构（全自动，无需复制粘贴）
 *
 * 前提：Chrome 以调试端口启动。两种做法：
 *
 *   ① 用你现有的登录态（会重启 Chrome，标签页可能丢，先收藏好）：
 *      pkill -x "Google Chrome"; sleep 2
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
 *
 *   ② 新开一个干净实例（不动你现有窗口，但要重新登录）：
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *        --remote-debugging-port=9222 --user-data-dir=/tmp/ag-profile
 *
 * 然后打开 ChatGPT / 豆包 / Kimi，各问一个带引用的问题，再跑：
 *   node tools/cdp-snapshot.mjs
 *
 * 输出：tools/snapshots/<域名>.json，每个文件就是那个页面的容器结构。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PORT = parseInt(getArg('--port', '9222'), 10);
const OUT = path.resolve(ROOT, getArg('--out', 'tools/snapshots'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpList() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res) => {
            const i = ++id;
            pending.set(i, res);
            ws.send(JSON.stringify({ id: i, method, params }));
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      })
    );
    ws.addEventListener('error', reject);
  });
}

async function main() {
  let targets;
  try {
    targets = await cdpList();
  } catch (e) {
    console.error(`连不上 127.0.0.1:${PORT} —— ${e.message}`);
    console.error('\n先按文件顶部的说明，用 --remote-debugging-port 启动 Chrome。');
    process.exit(1);
  }

  const pages = targets.filter(
    (t) => t.type === 'page' && /^https?:/.test(t.url || '') && !t.url.startsWith('chrome')
  );

  if (!pages.length) {
    console.error('没找到可读的网页标签。请先在 Chrome 里打开目标 AI 页面。');
    process.exit(1);
  }

  const probe = fs.readFileSync(path.join(__dirname, 'dom-probe.js'), 'utf8')
    .replace(/^\/\*\*[\s\S]*?\*\/\s*/, '');

  fs.mkdirSync(OUT, { recursive: true });
  console.log(`找到 ${pages.length} 个页面，开始读取…\n`);

  const summary = [];
  const usedNames = new Map(); // 同域名多个标签时避免互相覆盖

  for (const t of pages) {
    const host = (() => {
      try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
    })();

    let cdp;
    try {
      cdp = await connect(t.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      const r = await cdp.send('Runtime.evaluate', {
        expression: probe,
        returnByValue: true,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      });

      const v = r.result?.result?.value;
      if (!v) {
        console.log(`✗ ${host}  注入失败（可能是受限页面）`);
        continue;
      }

      let name = host;
      if (usedNames.has(host)) {
        const n = usedNames.get(host) + 1;
        usedNames.set(host, n);
        name = `${host}-${n}`;
      } else {
        usedNames.set(host, 1);
      }
      const file = path.join(OUT, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(v, null, 2), 'utf8');

      const pick = v.candidates?.find((c) => c.pluginsPick) || v.candidates?.[0];
      console.log(`✓ ${host}`);
      console.log(`   引用链接 ${v.extAnchors} 条 · 候选容器 ${v.candidates?.length || 0} 个` +
        (v.hasShadow ? ' · 有 Shadow DOM' : ''));
      if (pick) {
        console.log(`   插件会选: ${pick.selector}`);
        console.log(`   ext=${pick.ext} 文本=${pick.textLen} 字`);
      } else {
        console.log(`   ⚠ 没找到含外部引用的容器 —— 是不是还没生成带引用的回答？`);
      }
      console.log(`   已存 ${path.relative(ROOT, file)}\n`);

      summary.push({ host, file, ext: v.extAnchors, cands: v.candidates?.length || 0, pick: pick?.selector || null });
    } catch (e) {
      console.log(`✗ ${host}  ${e.message}`);
    } finally {
      cdp?.close();
    }
  }

  if (summary.length) {
    console.log('═'.repeat(56));
    console.log(`共 ${summary.length} 个页面，文件在 ${path.relative(ROOT, OUT)}/`);
    console.log('把这一整个目录发我，我按真实结构改 ADAPTERS。');
  }

  await sleep(100);
  process.exit(0);
}

main().catch((e) => {
  console.error('异常:', e);
  process.exit(1);
});
