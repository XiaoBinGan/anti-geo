/** 真实站点抓取探测：验证正文提取与隐藏指令检测不误报。node test/probe.mjs */
import { analyzePage } from '../src/lib/analyze.js';

const urls = [
  'https://example.com/',
  'https://zh.wikipedia.org/wiki/SimHash',
  'https://www.gov.cn/',
  'https://news.ycombinator.com/',
];

for (const u of urls) {
  const r = await analyzePage(u);
  const inject = r.inject?.hits?.length ?? 0;
  console.log(
    `${r.ok ? '✓' : '✗'} ${u}
    status=${r.httpStatus} ms=${r.ms} 正文=${r.textLen}字 作者=${r.hasAuthor} 日期=${r.hasDate}
    隐藏块=${r.inject?.hiddenBlockCount ?? 0} 注入命中=${inject}` +
      (inject ? `  ⚠ ${JSON.stringify(r.inject.hits)}` : '') +
      `\n    title="${(r.title || '').slice(0, 60)}"${r.err ? ' err=' + r.err : ''}`
  );
}
