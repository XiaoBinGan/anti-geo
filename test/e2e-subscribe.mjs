/**
 * 端到端：导出名单 → 本地服务托管 → 客户端拉取 → 解析 → 参与评分
 * 证明"共享名单"整条链路是通的。node test/e2e-subscribe.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExport, normalizeList } from '../src/lib/community.js';
import { scoreCitations } from '../src/lib/scoring.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PORT = 8811;
const tmp = path.join(os.tmpdir(), `ag-e2e-${Date.now()}.json`);

// ① A 用户本地标记了几个站，导出成社区格式
const exported = buildExport({
  blocklist: ['astroturf-clinic.top', 'paid-ranking.xyz'],
  allowlist: ['nmpa.gov.cn'],
});
fs.writeFileSync(tmp, JSON.stringify(exported, null, 2));
console.log(`[1] 导出 ${exported.domains.length} 条 → ${tmp}`);

// ② 用本地服务托管
const srv = spawn(process.execPath, ['scripts/blocklist-server.mjs', '--file', tmp, '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[server]', String(d).trim()));
await sleep(1200);

try {
  // ③ B 用户订阅并拉取
  const resp = await fetch(`http://127.0.0.1:${PORT}/blocklist.json`);
  check(`订阅源可访问 (HTTP ${resp.status})`, resp.ok);
  const raw = await resp.json();
  const list = normalizeList(raw);
  console.log(`[2] 拉到 ${list.length} 条：${list.map(x => x.d).join(', ')}`);
  check('拉到的条数与导出一致', list.length === exported.domains.length, `${list.length} vs ${exported.domains.length}`);

  // ④ 拿 B 用户的 AI 答案去评分，引用里正好有被标记的站
  const urls = [
    'https://www.astroturf-clinic.top/best-2026.html',
    'https://paid-ranking.xyz/top10.html',
    'https://www.nmpa.gov.cn/notice.html',
  ];
  const analyses = new Map([
    [urls[0], { url: urls[0], ok: true, textLen: 1200, simhash: [11, 22], hasAuthor: false, hasDate: false,
      inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 }, schema: { hasSchema: false, fakeReviewHints: [] } }],
    [urls[1], { url: urls[1], ok: true, textLen: 900, simhash: [33, 44], hasAuthor: false, hasDate: false,
      inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 }, schema: { hasSchema: false, fakeReviewHints: [] } }],
    [urls[2], { url: urls[2], ok: true, textLen: 2400, simhash: [55, 66], hasAuthor: true, hasDate: true,
      inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 }, schema: { hasSchema: false, fakeReviewHints: [] } }],
  ]);

  const scored = scoreCitations(urls, analyses, { blocklist: [], allowlist: ['nmpa.gov.cn'], subscription: list });
  const hitA = scored.citations.find(c => c.host === 'astroturf-clinic.top');
  const hitB = scored.citations.find(c => c.host === 'paid-ranking.xyz');
  const good = scored.citations.find(c => c.host === 'nmpa.gov.cn');

  console.log(`[3] 评分：污染度 ${scored.summary.pollution} / ${scored.summary.level.key}`);
  scored.citations.forEach(c => console.log(`    ${c.host}: ${c.score} 分 [${c.blockSource || '-'}]`));

  check('A 站被订阅名单命中并判红', hitA.score >= 55, `${hitA.score}`);
  check('B 站被订阅名单命中并判红', hitB.score >= 55, `${hitB.score}`);
  check('政府站未误伤', good.score < 25, `${good.score}`);
  check('整体判红', scored.summary.level.key === 'red');
} finally {
  srv.kill();
  fs.rmSync(tmp, { force: true });
}

console.log(`\n${'─'.repeat(46)}\n通过 ${pass} / ${pass + fail}${fail ? '  ← 有失败' : '  全部通过'}`);
process.exit(fail ? 1 : 0);
