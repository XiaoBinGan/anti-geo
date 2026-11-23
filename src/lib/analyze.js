/**
 * analyze.js — 抓取并分析单个被引用的页面
 *
 * 在 background service worker 里跑（有 host_permissions，不受 CORS 限制）。
 * 产出的是"单页可判定"的信号，不需要任何后端。
 */

import { simhash64 } from './simhash.js';

const FETCH_TIMEOUT = 9000;
const MAX_BYTES = 600 * 1024;

/* ────────────────────────────── 隐藏指令注入检测 ────────────────────────────── */

const INJECT_PATTERNS = [
  { re: /(忽略|无视|忘记|跳过|不要理会)(之前|以上|上述|前面|此前|所有)?.{0,6}(的)?(所有|全部|一切)?(指令|提示|要求|规则|设定)/g, label: '中文指令覆盖' },
  { re: /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?|context)/gi, label: '英文指令覆盖' },
  { re: /(you\s+are\s+now|act\s+as\s+(a|an|the)|from\s+now\s+on\s+you\s+(are|will))/gi, label: '角色覆盖' },
  { re: /(system\s*prompt|系统提示词|提示词注入|prompt\s*injection)/gi, label: '系统提示词引用' },
  { re: /(务必|必须|一定要|优先|只能|应当)(推荐|引用|提及|首推|回答).{0,30}(本|我们|我司|该|这家)(公司|品牌|产品|网站|平台|医院|机构|厂家)/g, label: '强制推荐话术' },
  { re: /(always|must|only)\s+(recommend|cite|mention|answer\s+with)\s+(us|our|this|the\s+following)/gi, label: '强制推荐话术(英)' },
  { re: /(当被问到|如果有人问|用户询问|when\s+asked\s+about).{0,30}(请|应|必须|务必).{0,30}(回答|推荐|回复)/g, label: '预置应答' },
  { re: /(AI|助手|模型|搜索引擎|ChatGPT|大模型).{0,12}(请|应|必须|务必).{0,12}(优先|首先)?(引用|推荐|采纳)/g, label: '对模型的直接指令' },
];

/** 匹配"隐藏"的容器：display:none / visibility:hidden / opacity:0 / font-size:0 / noscript */
const HIDDEN_BLOCK_RE = new RegExp(
  '<(?:div|span|p|section|noscript|template|font)\\b[^>]*?' +
  '(?:style\\s*=\\s*["\'][^"\']*?' +
  '(?:display\\s*:\\s*none|visibility\\s*:\\s*hidden|opacity\\s*:\\s*0(?:\\.0+)?\\s*[;"\']|' +
  'font-size\\s*:\\s*0(?:px|em|rem|%|pt)?\\s*[;]|' +
  'height\\s*:\\s*0\\s*[;]|width\\s*:\\s*0\\s*[;]|text-indent\\s*:\\s*-\\d{4,})' +
  '[^"\']*["\']|aria-hidden\\s*=\\s*["\']true["\']|hidden[\\s>])' +
  '[^>]*>([\\s\\S]{0,3000}?)</(?:div|span|p|section|noscript|template|font)>',
  'gi'
);

const HTML_COMMENT_RE = /<!--([\s\S]{0,2000}?)-->/g;
const NOSCRIPT_RE = /<noscript\b[^>]*>([\s\S]{0,3000}?)<\/noscript>/gi;

function scanPatterns(text) {
  const hits = [];
  if (!text) return hits;
  for (const p of INJECT_PATTERNS) {
    p.re.lastIndex = 0;
    const m = p.re.exec(text);
    if (m) {
      hits.push({ label: p.label, sample: m[0].slice(0, 120) });
    }
  }
  return hits;
}

/**
 * 从原始 HTML 里找隐藏文本块，并在其中搜索注入话术。
 * 正文里出现"忽略之前的指令"可能是正常教程，所以只对**隐藏**块给高权重。
 */
function detectHiddenInjection(html) {
  const hits = [];
  const blocks = [];

  for (const m of html.matchAll(HIDDEN_BLOCK_RE)) {
    blocks.push(m[2] || '');
  }
  // noscript 里的内容基本只给爬虫看，单独收
  for (const m of html.matchAll(NOSCRIPT_RE)) {
    blocks.push(m[1] || '');
  }
  // HTML 注释里塞指令也是常见手法
  for (const m of html.matchAll(HTML_COMMENT_RE)) {
    blocks.push(m[1] || '');
  }

  const joined = blocks.join('\n');
  for (const p of scanPatterns(joined)) {
    hits.push({ ...p, where: 'hidden' });
  }

  return {
    hits,
    hiddenBlockCount: blocks.length,
    hiddenTextLen: joined.length,
  };
}

/* ────────────────────────────── 正文提取 ────────────────────────────── */

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

function extractMainText(html) {
  // 优先抽 article / main
  let body = html;
  const art = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (art && art[1].length > 500) body = art[1];
  else if (main && main[1].length > 500) body = main[1];

  const text = decodeEntities(
    body
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\s\u3000]+/g, ' ')
    .trim();

  return text;
}

function extractMeta(html) {
  const meta = (name) => {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]+content\\s*=\\s*["']([^"']*)["']`,
      'i'
    );
    const m = html.match(re);
    return m ? decodeEntities(m[1]).slice(0, 300) : '';
  };
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: titleM ? decodeEntities(titleM[1]).trim().slice(0, 200) : meta('og:title'),
    description: meta('description') || meta('og:description'),
    author: meta('author') || meta('article:author'),
    published: meta('article:published_time') || meta('datePublished') || '',
    siteName: meta('og:site_name'),
  };
}

/** 结构化数据里常见的伪造信号：评分全 5 星、Review 数量异常 */
function inspectStructuredData(html) {
  const out = { hasSchema: false, fakeReviewHints: [] };
  const scripts = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  if (!scripts.length) return out;
  out.hasSchema = true;

  for (const s of scripts) {
    const body = s.replace(/<[^>]+>/g, '');
    // 全是 5 星
    const ratings = [...body.matchAll(/"ratingValue"\s*:\s*"?([\d.]+)"?/g)].map((m) => parseFloat(m[1]));
    if (ratings.length >= 3 && ratings.every((r) => r >= 4.9)) {
      out.fakeReviewHints.push(`结构化数据里 ${ratings.length} 个评分全部 ≥4.9`);
    }
    const counts = [...body.matchAll(/"reviewCount"\s*:\s*"?(\d+)"?/g)].map((m) => parseInt(m[1], 10));
    if (counts.some((c) => c > 5000)) {
      out.fakeReviewHints.push(`reviewCount 异常（${Math.max(...counts)}）`);
    }
  }
  return out;
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

export async function analyzePage(url) {
  const started = Date.now();
  const result = {
    url,
    ok: false,
    err: '',
    ms: 0,
    title: '',
    siteName: '',
    textLen: 0,
    simhash: [0, 0],
    hasAuthor: false,
    hasDate: false,
    inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 },
    schema: { hasSchema: false, fakeReviewHints: [] },
    httpStatus: 0,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);

  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      credentials: 'omit',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    result.httpStatus = resp.status;
    if (!resp.ok) {
      result.err = `HTTP ${resp.status}`;
      return result;
    }

    const ct = resp.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      result.err = `非 HTML（${ct.split(';')[0] || 'unknown'}）`;
      return result;
    }

    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf.slice(0, MAX_BYTES));
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    const meta = extractMeta(html);
    const text = extractMainText(html);

    result.ok = true;
    result.title = meta.title;
    result.siteName = meta.siteName;
    result.textLen = text.length;
    result.simhash = simhash64(text.slice(0, 20000));
    result.inject = detectHiddenInjection(html);
    result.schema = inspectStructuredData(html);

    const head = html.slice(0, 40000);
    result.hasAuthor = /作者|撰文|编辑\s*[:：]|author|by\s+[A-Z][a-z]+/i.test(head) || !!meta.author;
    result.hasDate =
      !!meta.published ||
      /20\d{2}\s*[年\-\/\.]\s*\d{1,2}\s*[月\-\/\.]\s*\d{1,2}/.test(head);
  } catch (e) {
    result.err = e.name === 'AbortError' ? '请求超时' : String(e.message || e);
  } finally {
    clearTimeout(timer);
    result.ms = Date.now() - started;
  }

  return result;
}

/** 并发受限的批量分析 */
export async function analyzeBatch(urls, concurrency = 4) {
  const results = new Map();
  const queue = [...urls];

  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      if (!u) break;
      results.set(u, await analyzePage(u));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length || 1) }, worker));
  return results;
}
