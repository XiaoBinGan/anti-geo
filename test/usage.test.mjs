/**
 * 使用记录：去重、环形缓冲、统计、导出结构
 * node test/usage.test.mjs
 */
import { summarize, buildExport } from '../src/lib/usage.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const now = Date.now();
const records = [
  // 正常站：有引用，低污染
  { ts: now - 5000, host: 'perplexity.ai', platform: 'Perplexity', mode: 'citations',
    cites: 6, distinct: 4, flagged: 0, red: 0, pollution: 12,
    containerCls: 'prose', fallback: false, deepChecked: 6, hits: 1 },
  // 检出投毒
  { ts: now - 4000, host: 'chatglm.cn', platform: '智谱清言', mode: 'citations',
    cites: 40, distinct: 5, flagged: 3, red: 3, pollution: 83,
    containerCls: 'message-content-wrapper', fallback: false, deepChecked: 6, hits: 2 },
  // 元宝：纯文本
  { ts: now - 3000, host: 'yuanbao.tencent.com', platform: '腾讯元宝', mode: 'text-only',
    cites: 0, distinct: 0, flagged: 1, red: 1, pollution: 70,
    containerCls: '', fallback: true, deepChecked: 0, hits: 1 },
  // 适配失效：连续两次找不到引用
  { ts: now - 2000, host: 'broken-site.com', platform: '', mode: 'none',
    cites: 0, distinct: 0, flagged: 0, red: 0, pollution: 0,
    containerCls: '', fallback: false, hits: 2 },
  // 有错误
  { ts: now - 1000, host: 'error-site.com', platform: '', mode: 'citations',
    cites: 2, distinct: 2, flagged: 0, red: 0, pollution: 5,
    containerCls: 'x', fallback: false, err: 'timeout', hits: 1 },
];

console.log('\n[1] 汇总');
const sum = summarize(records);
console.log(`    总次数 ${sum.total} · 站点 ${Object.keys(sum.byHost).length}`);
console.log(`    污染分桶: 红 ${sum.pollutionBuckets.red} / 黄 ${sum.pollutionBuckets.yellow} / 绿 ${sum.pollutionBuckets.green}`);
check('总次数含 hits 加权', sum.total === 7, String(sum.total));
check('站点数 5', Object.keys(sum.byHost).length === 5);
check('红桶 3（含 hits=2 的智谱）', sum.pollutionBuckets.red === 3, String(sum.pollutionBuckets.red));

console.log('\n[2] 失效识别');
console.log('    failures:', JSON.stringify(sum.failures));
check('识别出 broken-site.com', sum.failures.some((f) => f.host === 'broken-site.com'));
check('没把正常站误判为失效', !sum.failures.some((f) => f.host === 'perplexity.ai'));

console.log('\n[3] 纯文本站点');
console.log('    textOnly:', JSON.stringify(sum.textOnly));
check('识别出元宝走纯文本', sum.textOnly.some((t) => t.host === 'yuanbao.tencent.com'));

console.log('\n[4] 可疑列表按污染度排序');
console.log('    ', sum.suspicious.map((s) => `${s.host}:${s.pollution}`).join(', '));
check('最高污染度在首位', sum.suspicious[0]?.pollution === 83, JSON.stringify(sum.suspicious[0]));
check('只收录有 flagged/red 的', sum.suspicious.length === 2, String(sum.suspicious.length));

console.log('\n[5] 错误收集');
check('记录了 timeout', sum.errors.some((e) => e.err === 'timeout'));

console.log('\n[6] 导出结构');
const exp = buildExport(records, { version: '0.4.1' });
console.log(`    format=${exp.format} hosts=${exp.summary.hosts} failures=${JSON.stringify(exp.summary.containerFailures)}`);
check('format 标识正确', exp.format === 'anti-geo/usage-v1');
check('含版本号', exp.version === '0.4.1');
check('summary 有 containerFailures', exp.summary.containerFailures.includes('broken-site.com'));
check('perHost 按次数降序', exp.perHost[0].runs >= exp.perHost[exp.perHost.length - 1].runs);
check('原始记录完整保留', exp.records.length === records.length);
check('导出可 JSON 序列化', typeof JSON.stringify(exp) === 'string');

console.log('\n[7] 空数据不崩');
const empty = summarize([]);
check('空数组返回 total=0', empty.total === 0);
check('空导出可序列化', typeof JSON.stringify(buildExport([], {})) === 'string');
check('null 输入不崩', summarize(null).total === 0);

console.log(`\n${'─'.repeat(46)}\n通过 ${pass} / ${pass + fail}${fail ? '  ← 有失败' : '  全部通过'}`);
process.exit(fail ? 1 : 0);
