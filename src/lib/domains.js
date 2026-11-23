/**
 * domains.js — 域名工具：注册域提取、平台自身识别、一手源判定、域名形态可疑度
 */

/** 常见双段公共后缀，用于正确取 registrable domain */
const MULTI_SUFFIX = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'co.uk', 'org.uk',
  'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'co.kr',
  'or.kr', 'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.sg', 'com.au', 'net.au',
  'org.au', 'com.br', 'com.mx', 'co.in', 'net.in', 'org.in', 'co.za', 'com.tr',
  'co.nz', 'com.my', 'co.th', 'com.ph', 'com.vn', 'co.id', 'com.ar', 'com.co',
  'com.pe', 'com.ua', 'com.pl', 'co.il', 'com.sa', 'com.eg', 'gov.hk', 'edu.hk',
]);

export function registrableDomain(hostname) {
  if (!hostname) return '';
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIX.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

export function normalizeHost(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** AI 搜索平台自身的域名，不算引用源 */
export const PLATFORM_HOSTS = [
  'chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai', 'google.com',
  'googleusercontent.com', 'gstatic.com', 'bing.com', 'microsoft.com', 'msn.com',
  'doubao.com', 'bytedance.com', 'kimi.com', 'moonshot.cn', 'yuanbao.tencent.com',
  'tencent.com', 'metaso.cn', 'deepseek.com', 'zhipuai.cn', 'chatglm.cn',
  'baidu.com',
];

export function isPlatformHost(hostname) {
  const h = hostname.replace(/^www\./, '');
  return PLATFORM_HOSTS.some((p) => h === p || h.endsWith('.' + p));
}

/** 判断是否属于"一手/权威源" */
export function isPrimarySource(hostname) {
  const h = hostname.toLowerCase();
  if (/\.gov(\.[a-z]{2})?$/.test(h)) return true;
  if (/\.edu(\.[a-z]{2})?$/.test(h)) return true;
  if (/\.ac(\.[a-z]{2})?$/.test(h)) return true;
  if (/\.mil(\.[a-z]{2})?$/.test(h)) return true;
  if (/(^|\.)(who\.int|who\.int|un\.org|worldbank\.org|imf\.org|oecd\.org)$/.test(h)) return true;
  return false;
}

/** 平台级白名单：这些域名出现即视为正常来源（可被用户配置覆盖） */
export const DEFAULT_ALLOWLIST = [
  // 百科 / 知识库
  'wikipedia.org', 'wikidata.org', 'britannica.com', 'baike.baidu.com',
  // 学术
  'arxiv.org', 'nature.com', 'science.org', 'cell.com', 'thelancet.com',
  'nejm.org', 'sciencedirect.com', 'springer.com', 'wiley.com', 'ieee.org',
  'acm.org', 'pubmed.ncbi.nlm.nih.gov', 'cochrane.org', 'cnki.net',
  'wanfangdata.com.cn', 'cqvip.com', 'doaj.org', 'semanticscholar.org',
  // 卫生 / 医学
  'who.int', 'cdc.gov', 'nih.gov', 'mayoclinic.org', 'msdmanuals.cn',
  'msdmanuals.com', 'nhs.uk', 'fda.gov', 'nmpa.gov.cn',
  // 权威媒体
  'people.com.cn', 'xinhuanet.com', 'news.cn', 'cctv.com', 'thepaper.cn',
  'caixin.com', 'chinadaily.com.cn', 'reuters.com', 'apnews.com', 'bbc.com',
  // 标准 / 技术
  'iso.org', 'iec.ch', 'w3.org', 'ietf.org', 'github.com',
  'developer.mozilla.org', 'stackoverflow.com',
  // 政府统计
  'stats.gov.cn', 'stats.gov',
];

/**
 * 域名形态可疑度 0-1。内容农场/站群域名常有的形态特征。
 * 这里只输出信号，不输出结论。
 */
export function domainShapeScore(hostname) {
  const h = hostname.replace(/^www\./, '');
  const label = h.split('.')[0] || '';
  let score = 0;
  const flags = [];

  if (h.length > 26) { score += 0.15; flags.push('域名超长'); }
  const hyphens = (h.match(/-/g) || []).length;
  if (hyphens >= 3) { score += 0.2; flags.push(`连字符 ${hyphens} 个`); }
  if (h !== h.replace(/-{2,}/g, '')) { score += 0.25; flags.push('连续连字符'); }

  const digits = (label.replace(/[^0-9]/g, '').length);
  if (digits >= 5) { score += 0.25; flags.push(`数字 ${digits} 个`); }

  // 元音比例过低 → 随机串
  const alpha = label.replace(/[^a-z]/g, '');
  if (alpha.length >= 8) {
    const vowels = (alpha.match(/[aeiou]/g) || []).length;
    if (vowels / alpha.length < 0.18) { score += 0.3; flags.push('字母串像随机生成'); }
  }
  // 子域层级过深
  if (h.split('.').length >= 4) { score += 0.15; flags.push('子域层级过深'); }

  // 廉价/滥用率高的 TLD
  if (/\.(top|xyz|buzz|click|loan|work|shop|vip|cc|icu|biz|info|link|online|site|live|club)$/i.test(h)) {
    score += 0.12;
    flags.push('低门槛 TLD');
  }

  return { score: Math.min(1, score), flags };
}
