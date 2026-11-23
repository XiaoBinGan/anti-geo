/** 社区名单：格式校验、脏数据拦截、导出格式。node test/community.test.mjs */
import { normalizeList, isSafeDomain, buildExport, SUBSCRIPTION_WEIGHT } from '../src/lib/community.js';
import { scoreCitations } from '../src/lib/scoring.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\n[1] 域名校验');
check('正常域名通过', isSafeDomain('example-farm.com'));
check('拒绝协议前缀', !isSafeDomain('https://evil.com'));
check('拒绝空格', !isSafeDomain('a b.com'));
check('拒绝纯标识符', !isSafeDomain('localhost'));
check('拒绝 JavaScript 伪协议', !isSafeDomain('javascript:alert(1)'));
check('拒绝引号注入', !isSafeDomain('a.com"><script>'));
check('拒绝超长', !isSafeDomain('a'.repeat(300) + '.com'));
check('拒绝路径', !isSafeDomain('a.com/x'));
check('拒绝前导连字符', !isSafeDomain('-bad.com'));

console.log('\n[2] 名单格式归一化');
const a = normalizeList(['A.com', 'www.b.com', 'a.com', 'https://c.com']);
check('字符串数组去重 + 去 www + 小写', JSON.stringify(a.map(x => x.d)) === JSON.stringify(['a.com', 'b.com']), JSON.stringify(a));
check('非法项被丢弃（https://c.com）', !a.some(x => x.d.includes('/')));

const b = normalizeList({ domains: [{ d: 'x.top', reason: 'contentfarm', score: 55 }, 'y.xyz', { nope: 1 }] });
check('对象数组解析', b.length === 2, JSON.stringify(b));
check('score 透传', b[0].score === 55);
check('默认 score = 45', b[1].score === SUBSCRIPTION_WEIGHT);
check('reason 透传', b[0].reason === 'contentfarm');

check('空输入返回空数组', normalizeList(null).length === 0);
check('无 domains 字段返回空', normalizeList({ foo: 1 }).length === 0);

console.log('\n[3] 订阅名单参与评分');
const urls = ['https://bad-farm.top/a', 'https://good.gov.cn/b'];
const analyses = new Map(urls.map(u => [u, {
  url: u, ok: true, textLen: 800, simhash: [1, 2], hasAuthor: true, hasDate: true,
  inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 },
  schema: { hasSchema: false, fakeReviewHints: [] },
}]));
const scored = scoreCitations(urls, analyses, {
  blocklist: [],
  allowlist: [],
  subscription: [{ d: 'bad-farm.top', reason: 'contentfarm', score: 55 }],
});
const hit = scored.citations.find(c => c.host === 'bad-farm.top');
console.log(`    ${hit.host} = ${hit.score}分, blockSource=${hit.blockSource}`);
hit.flags.forEach(f => console.log(`    · [${f.t}] ${f.text}`));
check('订阅命中被判为可疑', hit.score >= 55, `实际 ${hit.score}`);
check('blockSource = subscription', hit.blockSource === 'subscription');

console.log('\n[4] 自建名单权重高于订阅');
const both = scoreCitations(urls, analyses, {
  blocklist: ['bad-farm.top'],
  allowlist: [],
  subscription: [{ d: 'bad-farm.top', score: 45 }],
});
const bhit = both.citations.find(c => c.host === 'bad-farm.top');
check('自建优先，blockSource = user', bhit.blockSource === 'user', bhit.blockSource);
check('自建分数 >= 60', bhit.score >= 60, `实际 ${bhit.score}`);

console.log('\n[5] 导出格式可直接作为订阅源');
const exp = buildExport({ blocklist: ['a.com', 'bad domain!!', 'b.top'], allowlist: ['gov.cn'] });
check('导出含 domains', Array.isArray(exp.domains) && exp.domains.length === 2, JSON.stringify(exp.domains));
check('非法项被过滤', !exp.domains.some(x => x.d.includes(' ')));
check('导出自带 version/updated', exp.version === 1 && /^\d{4}-\d{2}-\d{2}$/.test(exp.updated));
check('导出能被自己重新解析', normalizeList(exp).length === 2);

console.log(`\n${'─'.repeat(46)}\n通过 ${pass} / ${pass + fail}${fail ? '  ← 有失败' : '  全部通过'}`);
process.exit(fail ? 1 : 0);
