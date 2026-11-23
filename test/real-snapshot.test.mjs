/**
 * 真实快照回归：用 2026-11 从 chatglm.cn 实抓的 DOM 数据验证判定逻辑
 * node test/real-snapshot.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCitations } from '../src/lib/scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/real-zhipu.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('[1] 真实快照的基本事实');
console.log(`    host=${snap.host} 外链=${snap.extAnchors} 候选=${snap.candidates.length}`);
check('抓到 40 条引用', snap.extAnchors === 40, String(snap.extAnchors));
check('找到答案容器', snap.candidates.length > 0);

const pick = snap.candidates.find(c => c.pluginsPick);
console.log(`    插件选中: ${pick?.className} (ext=${pick?.ext} 文本=${pick?.textLen} 段落=${pick?.paragraphs})`);
check('选中 message-content-wrapper', pick?.className === 'message-content-wrapper', pick?.className);
check('容器方案覆盖全部引用（ext = 40）', pick?.ext === 40, String(pick?.ext));

console.log('\n[2] 同域多页是常态，不能判成占位');
const byHost = {};
for (const a of snap.anchorShapes) {
  const h = new URL(a.href).hostname;
  byHost[h] = (byHost[h] || 0) + a.occurrences;
}
console.log('    按域名的出现次数:', JSON.stringify(byHost));
const topHost = Object.entries(byHost).sort((a, b) => b[1] - a[1])[0];
check('确实存在同域多次出现（真实场景）', topHost[1] >= 3, JSON.stringify(topHost));

console.log('\n[3] 用真实引用跑评分，不该大面积误报');
const urls = snap.anchorShapes.map(a => a.href);
const analyses = new Map();
urls.forEach((u, i) => {
  // 这些是行业媒体/榜单站，正文正常
  analyses.set(u, {
    url: u, ok: true, textLen: 1800 + i * 50,
    simhash: [1000 + i * 7919, 2000 + i * 104729], // 各不相同
    hasAuthor: true, hasDate: true,
    inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 },
    schema: { hasSchema: false, fakeReviewHints: [] },
  });
});

const r = scoreCitations(urls, analyses, { blocklist: [], allowlist: [] });
console.log(`    污染度 ${r.summary.pollution} / ${r.summary.level.key} / 可疑 ${r.summary.flagged}/${r.summary.total}`);
r.summary.conclusions.forEach(c => console.log(`    · ${c}`));
r.citations
  .filter(c => c.score > 0)
  .slice(0, 5)
  .forEach(c => {
    console.log(`    ${c.host}: ${c.score} 分`);
    c.flags.forEach(f => console.log(`       [${f.t}] ${f.text}`));
  });

check('正常行业站不因同域多次被判黄', r.summary.flagged === 0, `flagged=${r.summary.flagged}`);
check('整体判绿', r.summary.level.key === 'green', `${r.summary.pollution}/${r.summary.level.key}`);

console.log('\n[4] 同域聚集即使极端也不该判红');
const many = ['https://same-site.com/a', 'https://same-site.com/b', 'https://same-site.com/c',
              'https://same-site.com/d', 'https://same-site.com/e', 'https://same-site.com/f'];
const a6 = new Map(many.map((u, i) => [u, {
  url: u, ok: true, textLen: 2000, simhash: [i * 100000 + 7, i * 99991 + 3],
  hasAuthor: true, hasDate: true,
  inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 },
  schema: { hasSchema: false, fakeReviewHints: [] },
}]));
const r6 = scoreCitations(many, a6, { blocklist: [], allowlist: [] });
console.log(`    6 页同站 → 污染度 ${r6.summary.pollution} / ${r6.summary.level.key}`);
check('同站 6 页不判红', r6.summary.level.key !== 'red', `${r6.summary.pollution}`);

console.log(`\n${'─'.repeat(46)}\n通过 ${pass} / ${pass + fail}${fail ? '  ← 有失败' : '  全部通过'}`);
process.exit(fail ? 1 : 0);
