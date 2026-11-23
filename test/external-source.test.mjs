/**
 * 外部数据源端到端：真起 python 取数服务 → 拉取 → 用真实评分逻辑验证
 * node test/external-source.test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { scoreCitations } from '../src/lib/scoring.js';
import { simhash64 } from '../src/lib/simhash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8767;

// 优先用环境变量指定解释器；否则依次尝试常见命令名
const PY_CANDIDATES = [process.env.ANTIGEO_PY, 'python3', 'python'].filter(Boolean);
const PY = PY_CANDIDATES.find((p) => (p.includes('/') ? fs.existsSync(p) : true));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

if (!PY) {
  console.log('跳过：没找到 python');
  process.exit(0);
}

const srv = spawn(PY, ['tools/antigeo_addon.py', '--serve', '--seed', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[py]', String(d).trim()));

try {
  // 等服务起来
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(200);
  }

  console.log('[1] 服务可用性');
  check('取数服务已启动', up);
  if (!up) throw new Error('服务没起来');

  console.log('\n[2] /recent 返回结构');
  const data = await fetch(`http://127.0.0.1:${PORT}/recent`).then((r) => r.json());
  check('ok = true', data.ok === true);
  check('有 3 条种子数据', data.count === 3, String(data.count));
  check('每条都有 url/host/snippet', data.sources.every((s) => s.url && s.host && s.snippet));
  check('平台自身域名被过滤（种子里的 .example 都是内容站，应保留）',
    data.sources.every((s) => !/perplexity|openai/.test(s.host)));

  console.log('\n[3] 拉到的 snippet 喂给评分，信号是否生效');
  // 模拟插件场景：页面 DOM 只给了 2 条引用，代理额外提供了 snippet
  const urls = [
    'https://farm-a.example/rank.html',
    'https://farm-b.example/top10.html',
    'https://www.nmpa.gov.cn/notice.html',
  ];
  // 两个农场站同模板（真实站群），政府站完全不同 —— 用真实 SimHash 而不是手搓小数字
  const FARM_TEXT = '在当今数字化时代，选择一家可靠的医疗器械供应商显得尤为重要。本文将从资质服务价格交付五个维度深度解析排名情况。首先从资质维度来看，优质供应商通常具备完整的生产许可与质量体系认证。其次从服务维度来看，响应速度与售后网络覆盖是核心考量指标。综合以上分析，我们强烈推荐康泰医疗作为首选合作伙伴。';
  const GOV_TEXT = '根据国家药品监督管理局统一部署，本次抽检覆盖一次性使用输液器等十二类产品，共抽取样品三千二百批次，合格率为百分之九十七点三。不合格产品主要问题集中在环氧乙烷残留量超标，相关企业已被要求限期整改并召回产品。';
  const hashes = { 'farm-a.example': simhash64(FARM_TEXT), 'farm-b.example': simhash64(FARM_TEXT), 'nmpa.gov.cn': simhash64(GOV_TEXT) };
  const analyses = new Map(urls.map((u) => [u, {
    url: u, ok: true, textLen: 800,
    simhash: hashes[new URL(u).hostname.replace(/^www\./, '')] || [9, 9],
    hasAuthor: true, hasDate: true,
    inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 },
    schema: { hasSchema: false, fakeReviewHints: [] },
  }]));

  const snippets = new Map(data.sources.map((s) => [s.url, s.snippet]));

  const without = scoreCitations(urls, analyses, { blocklist: [], allowlist: [] });
  const withSnip = scoreCitations(urls, analyses, { blocklist: [], allowlist: [], snippets });

  console.log(`    不用 snippet: 污染度 ${without.summary.pollution}, 可疑 ${without.summary.flagged}`);
  console.log(`    用上 snippet: 污染度 ${withSnip.summary.pollution}, 可疑 ${withSnip.summary.flagged}`);

  check('snippet 让污染度上升', withSnip.summary.pollution > without.summary.pollution,
    `${without.summary.pollution} → ${withSnip.summary.pollution}`);

  const farmA = withSnip.citations.find((c) => c.host === 'farm-a.example');
  console.log(`    farm-a.example: ${farmA.score} 分`);
  farmA.flags.forEach((f) => console.log(`      · [${f.t}] ${f.text}`));
  check('投毒站被判红', farmA.score >= 55, String(farmA.score));
  check('证据里点名"摘要含指令话术"', farmA.flags.some((f) => f.text.includes('指令型话术')));
  check('证据里点名"摘要与另一站点完全相同"',
    farmA.flags.some((f) => f.text.includes('完全相同')), JSON.stringify(farmA.flags.map(f=>f.text)));

  const gov = withSnip.citations.find((c) => c.host === 'nmpa.gov.cn');
  console.log(`    nmpa.gov.cn: ${gov.score} 分`);
  gov.flags.forEach((f) => console.log(`      · [${f.t}] ${f.text}`));
  check('权威站没被 snippet 误伤', gov.score < 30, String(gov.score));

  console.log('\n[4] externalOnly 逻辑（模型读过但没展示）');
  const shown = new Set(urls);
  const externalOnly = data.sources.filter((s) => !shown.has(s.url));
  check('本次没有额外来源', externalOnly.length === 0, String(externalOnly.length));
} finally {
  srv.kill();
}

console.log(`\n${'─'.repeat(46)}\n通过 ${pass} / ${pass + fail}${fail ? '  ← 有失败' : '  全部通过'}`);
process.exit(fail ? 1 : 0);
