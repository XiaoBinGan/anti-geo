/**
 * content.js v2 — 找引用、注入旁注 UI、渲染证据
 *
 * 与 v1 的三个关键差异：
 *   1. 深度 DOM 遍历：穿透 open ShadowRoot 和同源 iframe
 *   2. 通用容器发现：不依赖 class 名，用文本量 / 外链数 / 链接密度 / 结构特征打分
 *   3. 两级扫描：流式生成时只做轻量的域名级判断，答案稳定后才抓页面深度核查
 */
(() => {
  'use strict';
  if (window.__AG_LOADED__) return;
  window.__AG_LOADED__ = true;

  const HOSTNAME = location.hostname.replace(/^www\./, '');

  /* ══════════════════════════ 状态 ══════════════════════════ */

  let lastResult = null;
  let lastKey = '';
  let lastCites = [];
  let ui = null;
  let citationIndex = new Map();

  let scanTimer = null;
  let deepTimer = null;
  let stableKey = '';
  let stableSince = 0;
  let deepDone = false;
  let lastSettings = {};

  /* ══════════════════════════ 平台适配 ══════════════════════════ */

  const PLATFORM_HOSTS = [
    'chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai',
    'google.com', 'googleusercontent.com', 'gstatic.com', 'bing.com',
    'microsoft.com', 'msn.com', 'doubao.com', 'bytedance.com', 'kimi.com',
    'moonshot.cn', 'yuanbao.tencent.com', 'tencent.com', 'metaso.cn',
    'deepseek.com', 'zhipuai.cn', 'chatglm.cn', 'baidu.com',
  ];

  function isPlatformHost(h) {
    h = String(h || '').replace(/^www\./, '');
    return PLATFORM_HOSTS.some((p) => h === p || h.endsWith('.' + p));
  }

  /**
   * 内置适配器只是"提示"，不是唯一依据 —— 选择器全失效时通用算法会兜住。
   * 想加平台优先用设置页的「探测」，比改这里靠谱。
   */
  const ADAPTERS = [
    {
      host: ['perplexity.ai'],
      name: 'Perplexity',
      answerSelectors: [
        '[class*="prose"]', '.prose', '[data-testid*="answer"]',
        '[class*="AnswerBody"]', '[class*="answer"]',
      ],
    },
    {
      host: ['chatgpt.com', 'chat.openai.com'],
      name: 'ChatGPT',
      answerSelectors: [
        '[data-message-author-role="assistant"]', 'article .markdown', '.markdown.prose',
        '[class*="markdown"]',
      ],
    },
    {
      host: ['google.com'],
      name: 'Google AI Overview',
      answerSelectors: ['#m-x-content', '[data-attrid*="AIOverview"]', 'div[role="region"]'],
      scopeFilter: (el) => /AI Overview|AI 概览|AI 摘要|AI 模式/i.test(el.textContent || ''),
    },
    {
      host: ['bing.com'],
      name: 'Bing Copilot',
      answerSelectors: ['[class*="copilot"]', '#b_sydConvCont', 'main [class*="response"]'],
    },
    {
      // 实测（2026-11）：页面 class 全是 Tailwind + hash（flex/items-center/dbx-*），
      // 几乎没有稳定语义类 —— 主要靠 data-testid 和反向定位兜底
      host: ['doubao.com'],
      name: '豆包',
      answerSelectors: [
        '[data-testid="message_text_content"]',
        '[data-testid="receive_message"]',
        '[data-testid*="message"]',
        '[class*="md-box-root"]',
        '[class*="message-content"]',
        '[class*="receive"]',
        '[class*="markdown"]',
        '[class*="bubble"]',
      ],
    },
    {
      // 实测（2026-11）：首页有 resource-placement-card（推荐卡片，不是答案）；
      // 对话页的答案区在 next-sidebar 之外，靠 markdown / segment 容器
      host: ['kimi.com', 'moonshot.cn'],
      name: 'Kimi',
      answerSelectors: [
        '.markdown',
        '.segment-assistant',
        '.chat-content-item-assistant',
        '[class*="markdown-container"]',
        '[class*="markdown"]',
        '.chat-content-item',
      ],
    },
    {
      // 实测结构（2026-11）：对话框 agent-dialogue__content > agent-chat__bubble
      host: ['yuanbao.tencent.com'],
      name: '腾讯元宝',
      answerSelectors: [
        '[class*="agent-chat__bubble__content"]',
        '[class*="hyc-common-markdown"]',
        '[class*="agent-dialogue__content"]',
        '[class*="hyc-content"]',
        '[class*="markdown"]',
      ],
    },
    {
      host: ['metaso.cn'],
      name: '秘塔',
      answerSelectors: ['[class*="markdown"]', '[class*="answer"]', '[class*="content"]'],
    },
    {
      host: ['chat.deepseek.com'],
      name: 'DeepSeek',
      answerSelectors: ['[class*="ds-markdown"]', '[class*="markdown"]'],
    },
    {
      // 实测结构（2026-11）：答案在 div.message-content-wrapper，
      // 祖先链 assistant-message-item__bubble-content > __content > __main > assistant-message-item
      // 引用是 span.search-source-item-label > a，锚文本是域名
      host: ['chatglm.cn', 'zhipuai.cn'],
      name: '智谱清言',
      answerSelectors: [
        '.message-content-wrapper',
        '[class*="assistant-message-item__bubble-content"]',
        '[class*="message-content"]',
        '[class*="markdown-body"]',
        '[class*="markdown"]',
      ],
    },
  ];

  const ADAPTER =
    ADAPTERS.find((a) => a.host.some((h) => HOSTNAME === h || HOSTNAME.endsWith('.' + h))) || null;

  /* ══════════════════════════ 深度 DOM 遍历 ══════════════════════════ */

  /**
   * 收集所有可访问的根：document + open shadowRoot + 同源 iframe document。
   * 带节点预算，避免在巨型页面上卡死。
   */
  function collectRoots(budget = 3000) {
    const roots = [document];
    const seenShadow = new Set();

    function walk(root) {
      let els;
      try {
        els = root.querySelectorAll('*');
      } catch {
        return;
      }
      for (const el of els) {
        if (--budget <= 0) return;

        if (el.shadowRoot && !seenShadow.has(el.shadowRoot)) {
          seenShadow.add(el.shadowRoot);
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
          if (budget <= 0) return;
        }

        if (el.tagName === 'IFRAME') {
          try {
            const doc = el.contentDocument;
            if (doc && doc.documentElement && !roots.includes(doc)) {
              roots.push(doc);
              walk(doc);
              if (budget <= 0) return;
            }
          } catch {
            /* 跨域 iframe，跳过 */
          }
        }
      }
    }

    walk(document);
    return roots;
  }

  /* ══════════════════════════ 引用识别 ══════════════════════════ */

  function resolveHref(raw) {
    try {
      const u = new URL(raw, location.href);

      // 豆包：所有外链都套一层 https://link.wtturl.cn/?target=<encoded>
      if (/(^|\.)wtturl\.cn$/.test(u.hostname)) {
        const t = u.searchParams.get('target');
        if (t) return t.startsWith('http') ? t : decodeURIComponent(t);
      }
      // 知乎 / 微博 / 短链等常见跳转
      if (/(^|\.)(link\.zhihu\.com|link\.csdn\.net|t\.cn|url\.cn|dwz\.cn)$/.test(u.hostname)) {
        const t = u.searchParams.get('target') || u.searchParams.get('url');
        if (t) return t.startsWith('http') ? t : decodeURIComponent(t);
      }
      // 通用：任何带 ?target=<http...> 的跳转
      {
        const t = u.searchParams.get('target');
        if (t && /^https?:/i.test(t)) return t;
      }

      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
        const q = u.searchParams.get('q') || u.searchParams.get('url');
        if (q) return new URL(q, location.href).href;
      }
      if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname === '/ck/a') {
        const enc = u.searchParams.get('u') || '';
        if (enc.startsWith('a1')) {
          try {
            const b = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            const s = decodeURIComponent(escape(atob(b)));
            if (/^https?:/.test(s)) return s;
          } catch {}
        }
      }
      return u.href;
    } catch {
      return null;
    }
  }

  /**
   * 去掉跟踪参数 —— ChatGPT 的引用 URL 全带 ?utm_source=chatgpt.com（实测 7 条全中），
   * Perplexity 带 ?utm_source=perplexity。不清掉会导致同一页面被当成不同引用。
   */
  const TRACKING_KEY = /^(utm_[a-z]+|fbclid|gclid|msclkid|_hsenc|_hsmi|ref_src|ref_url|spm|scm|from|share_token)$/i;

  function cleanUrl(href) {
    try {
      const u = new URL(href);
      const kill = [];
      u.searchParams.forEach((_v, k) => {
        if (TRACKING_KEY.test(k)) kill.push(k);
      });
      if (kill.length) {
        for (const k of kill) u.searchParams.delete(k);
      }
      // 去掉「文本片段」指令 #:~:text=xxx —— Kimi/Chrome 用它高亮原文，
      // 同一个页面会因片段不同被当成不同引用
      if (u.hash.startsWith('#:~:')) u.hash = '';
      return u.href;
    } catch {
      return href;
    }
  }

  function isExternalHref(href) {
    try {
      const u = new URL(href);
      if (!/^https?:$/.test(u.protocol)) return false;
      return !isPlatformHost(u.hostname);
    } catch {
      return false;
    }
  }

  function countExternalLinks(el) {
    let n = 0;
    let links;
    try {
      links = el.querySelectorAll('a[href]');
    } catch {
      return 0;
    }
    for (const a of links) {
      const h = resolveHref(a.getAttribute('href'));
      if (h && isExternalHref(h)) n++;
      if (n > 60) break;
    }
    return n;
  }

  /* ══════════════════════════ 容器发现 ══════════════════════════ */

  const BAD_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT']);

  /**
   * 给一个元素打"它可能是答案正文"的分。
   * 返回 <= 0 表示不合格。
   */
  /**
   * 给一个元素打分，判断它像不像"答案正文"。
   * 同时返回外链数（ext）和 DOM 深度（depth），供最终选择使用。
   */
  function analyzeContainer(el, knownExt = null) {
    const fail = { ok: false, score: 0, ext: 0, depth: 0 };
    if (!el || el.nodeType !== 1) return fail;
    if (BAD_TAGS.has(el.tagName)) return fail;

    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return fail;
    try {
      if (el.closest('nav, header, footer, aside, [role="navigation"]')) return fail;
    } catch {}

    let linkCount;
    try {
      linkCount = el.querySelectorAll('a[href]').length;
    } catch {
      return fail;
    }
    if (!linkCount || linkCount > 60) return fail;

    const ext = knownExt ?? countExternalLinks(el);
    if (!ext) return fail;

    const len = (el.textContent || '').length;
    if (len < 120 || len > 200000) return fail;

    const density = linkCount / Math.max(len, 1);
    if (density > 0.1) return fail;

    let depth = 0;
    let cur = el;
    while (cur && cur.parentElement && depth < 40) {
      depth++;
      cur = cur.parentElement;
    }

    const paragraphs = el.querySelectorAll('p, li').length;
    let score = Math.log2(len) * 10 + ext * 25 + Math.min(depth, 25) * 2;
    score += Math.min(paragraphs * 4, 40);

    const sig = (
      (typeof el.className === 'string' ? el.className : '') + ' ' +
      (el.id || '') + ' ' +
      (el.getAttribute('data-testid') || '')
    ).toLowerCase();
    if (/answer|response|message|prose|markdown|reply|completion|output|chat/.test(sig)) score += 120;
    if (/nav|menu|sidebar|comment|footer|header|toolbar|breadcrumb|related|recommend|carousel/.test(sig)) score -= 200;

    return { ok: true, score, ext, depth, paragraphs };
  }

  /**
   * 找出页面上所有答案容器，按文档顺序返回（最后一个 = 最新回答）。
   */
  function findAnswerRoots(overrideSelector) {
    const roots = collectRoots();
    const cands = [];
    const seen = new Set();

    const consider = (el, bonus = 0, knownExt = null) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      const info = analyzeContainer(el, knownExt);
      if (!info.ok) return;
      cands.push({ el, score: info.score + bonus, ext: info.ext, depth: info.depth, paragraphs: info.paragraphs });
    };

    // ① 用户探测出来的选择器优先级最高
    if (overrideSelector) {
      for (const r of roots) {
        try {
          for (const el of r.querySelectorAll(overrideSelector)) consider(el, 5000);
        } catch {
          /* 选择器坏掉就忽略 */
        }
      }
    }

    // ② 内置适配器
    if (ADAPTER) {
      for (const sel of ADAPTER.answerSelectors) {
        for (const r of roots) {
          let nodes = [];
          try {
            nodes = r.querySelectorAll(sel);
          } catch {
            continue;
          }
          for (const el of nodes) {
            if (ADAPTER.scopeFilter && !ADAPTER.scopeFilter(el)) continue;
            consider(el, 800);
          }
        }
      }
    }

    // ③ 反向定位 —— 从外部引用链接向上找公共祖先。
    //    这样页面上有多少个 div 都不影响耗时：只处理 anchors × 深度 个节点。
    if (!cands.length) {
      const stat = new Map(); // el -> 外部引用链接计数
      let anchorBudget = 500;

      for (const r of roots) {
        let anchors = [];
        try {
          anchors = r.querySelectorAll('a[href]');
        } catch {
          continue;
        }
        for (const a of anchors) {
          if (--anchorBudget <= 0) break;
          const h = resolveHref(a.getAttribute('href'));
          if (!h || !isExternalHref(h)) continue;

          let cur = a.parentElement;
          let d = 0;
          while (cur && d < 16) {
            const st = stat.get(cur);
            if (st) st.ext++;
            else stat.set(cur, { ext: 1 });
            cur = cur.parentElement;
            d++;
          }
        }
      }

      // 只给"至少含 2 条外链"的祖先打分，按外链数降序取前 80 个
      const pool = [...stat.entries()]
        .filter(([, st]) => st.ext >= 2)
        .sort((a, b) => b[1].ext - a[1].ext)
        .slice(0, 80);

      for (const [el, st] of pool) consider(el, 0, st.ext);
    }

    if (!cands.length) return [];

    // 选择原则：
    //   1. 外链数最多 —— 保证不漏掉答案里的任何一条引用
    //   2. 外链数并列时取 DOM 最深 —— 保证不会选到整个 body（把导航也算进来）
    // 三级排序：
    //   1. 外链数最多 —— 不漏引用
    //   2. 段落最多 —— 区分「答案主体」和「末尾的纯链接列表」
    //      （实测豆包：参考列表 ol 有 3 段，真正答案 data-testid=message_text_content 有 16 段）
    //   3. DOM 最深 —— 更精确，不会选到整个 body
    const maxExt = Math.max(...cands.map((c) => c.ext || 0));
    let best = cands.filter((c) => (c.ext || 0) === maxExt);
    if (!best.length) best = cands;

    const maxParas = Math.max(...best.map((c) => c.paragraphs || 0));
    if (maxParas > 0) {
      const byParas = best.filter((c) => (c.paragraphs || 0) === maxParas);
      if (byParas.length) best = byParas;
    }

    best.sort((a, b) => {
      if ((b.depth || 0) !== (a.depth || 0)) return (b.depth || 0) - (a.depth || 0);
      return b.score - a.score;
    });

    const maxDepth = best[0].depth || 0;
    const final = best.filter((c) => (c.depth || 0) === maxDepth);

    // 文档顺序（最后一个 = 最新回答）
    final.sort((a, b) => {
      if (a.el === b.el) return 0;
      try {
        return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      } catch {
        return 0;
      }
    });

    return final.map((c) => c.el);
  }

  /**
   * 没有外链时的兜底：用"最大的一块正文"当答案容器。
   * 元宝这类平台不暴露来源 URL，analyzeContainer 会因为 ext=0 全部过滤掉，
   * 导致纯文本模式根本触发不了。这里单独找一个够大的文本块。
   */
  function findLargestTextBlock() {
    const roots = collectRoots();
    let best = null;
    let bestScore = 0;

    for (const r of roots) {
      let nodes = [];
      try {
        nodes = r.querySelectorAll('div, article, section, main, [class*="bubble"], [class*="content"]');
      } catch {
        continue;
      }
      let i = 0;
      for (const el of nodes) {
        if (++i > 1200) break;
        if (BAD_TAGS.has(el.tagName)) continue;
        try {
          if (el.closest('nav, header, footer, aside, [role="navigation"]')) continue;
        } catch {}

        const text = (el.textContent || '').trim();
        const len = text.length;
        if (len < 200 || len > 40000) continue;

        const links = el.querySelectorAll('a').length;
        // 段落数至少 2，避免把一行长文本当答案
        const paras = el.querySelectorAll('p, li, br').length;
        if (paras < 2 && len < 500) continue;

        // 链接密度过高 = 导航/列表
        if (links / Math.max(len, 1) > 0.05) continue;

        let score = Math.log2(len) * 10 + Math.min(paras * 3, 40);
        const sig = ((typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '')).toLowerCase();
        if (/answer|response|message|markdown|bubble|content|reply/.test(sig)) score += 100;
        if (/nav|menu|sidebar|footer|header|toolbar|breadcrumb/.test(sig)) score -= 200;

        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    return best;
  }

  /* ══════════════════════════ 引用收集 ══════════════════════════ */

  /**
   * 抓引用旁边的"摘要"—— 也就是平台展示给用户看的来源片段。
   * 这比整页正文更接近"模型实际读到的东西"，是判投毒最关键的一层。
   *
   * 做法：从引用链接向上找最近的"卡片式"容器
   *   （文本 40–1500 字、外部链接 ≤4 个），取它的文本。
   */
  function extractSnippet(anchor, maxLen = 700) {
    let cur = anchor.parentElement;
    let depth = 0;
    while (cur && depth < 7) {
      let linkCount = 0;
      try {
        linkCount = cur.querySelectorAll('a[href]').length;
      } catch {
        return '';
      }
      // 链接太多 → 是列表/导航，不是卡片
      if (linkCount > 4) return '';

      const t = (cur.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 2000) return ''; // 已经超出卡片尺度
      if (t.length >= 40) {
        if (linkCount <= 4) return t.slice(0, maxLen);
      }
      cur = cur.parentElement;
      depth++;
    }
    return '';
  }

  const ANCHOR_SEL = 'a[href^="http"], a[href^="//"], a[href^="/url?"], a[href^="/ck/a"]';

  function collectCitations(roots) {
    /** url -> {url, host, anchors[]} */
    const map = new Map();

    for (const root of roots) {
      let anchors = [];
      try {
        anchors = root.querySelectorAll(ANCHOR_SEL);
      } catch {
        continue;
      }

      for (const a of anchors) {
        const raw = a.getAttribute('href');
        if (!raw) continue;
        // 导航 / 页脚 / 侧栏里的链接不是答案引用
        try {
          if (a.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
        } catch {}
        const resolved = resolveHref(raw);
        if (!resolved || !isExternalHref(resolved)) continue;
        const href = cleanUrl(resolved);

        let host;
        try {
          host = new URL(href).hostname.replace(/^www\./, '');
        } catch {
          continue;
        }

        const key = href.split('#')[0].replace(/\/+$/, '');
        if (!map.has(key)) map.set(key, { url: href, host, anchors: [], snippet: '' });
        const entry = map.get(key);
        if (!entry.anchors.includes(a)) entry.anchors.push(a);

        // 每个 URL 最多尝试 3 个锚点，取最长的那段摘要
        if (entry.anchors.length <= 3 && entry.snippet.length < 120) {
          const sn = extractSnippet(a);
          if (sn.length > entry.snippet.length) entry.snippet = sn;
        }
      }
    }

    return [...map.values()];
  }

  /* ══════════════════════════ 样式 ══════════════════════════ */

  function injectStyles() {
    if (document.getElementById('__ag_style')) return;
    const st = document.createElement('style');
    st.id = '__ag_style';
    st.textContent = `
      .__ag-bar{
        display:flex;align-items:center;gap:10px;margin:8px 0 14px;padding:8px 12px;
        border-radius:10px;font:500 13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
        border:1px solid;cursor:pointer;user-select:none;transition:box-shadow .15s;
      }
      .__ag-bar:hover{box-shadow:0 2px 12px rgba(0,0,0,.1)}
      .__ag-bar.__ag-green{background:#f0fdf4;border-color:#bbf7d0;color:#166534}
      .__ag-bar.__ag-yellow{background:#fffbeb;border-color:#fde68a;color:#92400e}
      .__ag-bar.__ag-red{background:#fef2f2;border-color:#fecaca;color:#991b1b}
      .__ag-dot{
        display:inline-block;width:7px;height:7px;border-radius:50%;margin:0 2px 0 3px;
        vertical-align:middle;cursor:pointer;position:relative;top:-1px;transition:transform .12s;
      }
      .__ag-dot:hover{transform:scale(1.5)}
      .__ag-dot.__ag-green{background:#16a34a}
      .__ag-dot.__ag-yellow{background:#d97706}
      .__ag-dot.__ag-red{background:#dc2626;animation:__ag_pulse 1.6s infinite}
      @keyframes __ag_pulse{
        0%{box-shadow:0 0 0 0 rgba(220,38,38,.6)}
        70%{box-shadow:0 0 0 6px rgba(220,38,38,0)}
        100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}
      }
      .__ag-badge{
        display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;
        padding:0 5px;border-radius:9px;font-size:11px;font-weight:700;color:#fff;flex:none;
      }
      .__ag-link{color:inherit;text-decoration:underline;text-underline-offset:2px;opacity:.8}
      .__ag-link:hover{opacity:1}
      .__ag-close{margin-left:2px;font-size:16px;line-height:1;opacity:.45;padding:0 4px}
      .__ag-close:hover{opacity:1}
      .__ag-spin{opacity:.6;font-size:11px;margin-left:auto}
      /* 正文里的可疑引用：划掉 + 淡红底 */
      a.__ag-flagged-ref{
        background:rgba(220,38,38,.09)!important;
        text-decoration:line-through!important;
        text-decoration-color:rgba(220,38,38,.55)!important;
        text-decoration-thickness:1.5px!important;
        border-radius:2px;padding:0 1px;
      }
      a.__ag-flagged-ref.__ag-yellow-ref{
        background:rgba(217,119,6,.10)!important;
        text-decoration-color:rgba(217,119,6,.5)!important;
      }
      /* 隐藏模式：整段折叠 */
      .__ag-hide-refs a.__ag-flagged-ref{display:none!important}
      .__ag-hide-refs a.__ag-flagged-ref::after{
        content:"[可疑来源]";display:inline;color:#991b1b;font-size:.9em;
        text-decoration:none;background:rgba(220,38,38,.08);border-radius:3px;padding:0 3px;
      }
      .__ag-bar-btn{
        border:1px solid currentColor;background:transparent;color:inherit;
        font:inherit;font-size:11.5px;padding:2px 8px;border-radius:6px;
        cursor:pointer;opacity:.85;white-space:nowrap;
      }
      .__ag-bar-btn:hover{opacity:1;background:rgba(255,255,255,.5)}
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ══════════════════════════ UI ══════════════════════════ */

  function ensureUI(root) {
    if (ui?.bar?.isConnected) return ui;

    injectStyles();

    const bar = document.createElement('div');
    bar.className = '__ag-bar';
    bar.setAttribute('data-ag', 'bar');
    bar.dataset.ag = 'bar';
    bar.addEventListener('click', (e) => {
      if (e.target.closest('.__ag-close')) {
        if (ui) ui.dismissed = true; // 用户主动关的，别自愈复活
        bar.remove();
        return;
      }
      openPanel();
    });

    // 插在答案容器**前面**而不是里面 —— 平台重渲染答案时不会把我们冲掉
    const parent = root?.parentNode;
    if (parent && root !== document.body && parent.nodeType === 1) {
      try {
        parent.insertBefore(bar, root);
      } catch {
        document.body.appendChild(bar);
      }
    } else {
      Object.assign(bar.style, {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483646',
        maxWidth: '340px', boxShadow: '0 6px 24px rgba(0,0,0,.18)', margin: '0',
        background: '#fff', borderColor: '#e5e7eb',
      });
      document.body.appendChild(bar);
    }

    ui = { bar, root, panel: null };
    return ui;
  }

  function renderBar(result, state = 'done') {
    const bar = ui?.bar;
    if (!bar) return;
    const s = result.summary;

    bar.className = `__ag-bar __ag-${s.level.key}`;

    if (state === 'text-only') {
      const badge = `<span class="__ag-badge" style="background:${s.level.color}">${s.pollution}</span>`;
      bar.className = `__ag-bar __ag-${s.level.key}`;
      bar.innerHTML =
        badge +
        `<span>本答案没有展示来源 · 仅做了措辞分析</span>` +
        `<span class="__ag-link" style="margin-left:auto">详情</span>` +
        `<span class="__ag-close">×</span>`;
      bar.title = '反GEO：平台未展示引用来源，只能分析答案正文的措辞';
      return;
    }

    if (state === 'lite') {
      bar.innerHTML =
        `<span class="__ag-badge" style="background:${s.level.color}">${s.pollution}</span>` +
        `<span>已扫到 ${s.total} 条引用，正在核查页面…</span>` +
        `<span class="__ag-spin">稍候</span>` +
        `<span class="__ag-close">×</span>`;
      bar.title = '反GEO 正在抓取被引用的页面做深度核查';
      return;
    }

    const n = s.total;
    let text;
    if (s.level.key === 'green') {
      text = `已核查 ${n} 条引用，未发现投毒特征`;
    } else {
      text = `${n} 条引用中 <b>${s.flagged}</b> 条可疑`;
      if (s.red > 0) text += `（${s.red} 条硬证据）`;
      if (s.distinctDomains <= 2 && n >= 3) text += ` · 来源仅 ${s.distinctDomains} 个站点`;
    }

    const canHide = s.level.key !== 'green';
    bar.innerHTML =
      `<span class="__ag-badge" style="background:${s.level.color}">${s.pollution}</span>` +
      `<span>${text}</span>` +
      (canHide ? `<button class="__ag-bar-btn" data-ag-act="toggle-hide" style="margin-left:auto">隐藏可疑引用</button>` : '<span style="margin-left:auto"></span>') +
      `<span class="__ag-link">详情</span>` +
      `<span class="__ag-close">×</span>`;
    bar.title = '反GEO：点击查看每条引用的证据';

    // 「隐藏可疑引用」开关
    const hideBtn = bar.querySelector('[data-ag-act="toggle-hide"]');
    if (hideBtn) {
      hideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = document.documentElement.classList.toggle('__ag-hide-refs');
        hideBtn.textContent = on ? '恢复显示' : '隐藏可疑引用';
      });
    }
  }

  /**
   * 横条该不该显示 / 还在不在 —— 统一判断 + 重建。
   * 平台重渲染会把我们插的节点冲掉，这时必须重建，否则就"时而不见"。
   */
  function ensureBarVisible(roots) {
    if (!lastResult) return false;
    if (ui?.dismissed) return false;
    if (ui?.bar?.isConnected) return true;
    if (!roots || !roots.length) return false;

    const lvl = lastSettings.displayLevel || 'warn';
    const s = lastResult.summary;
    if (!s) return false;
    const shouldShow = lvl === 'all' || s.level.key !== 'green' || s.flagged > 0;
    if (!shouldShow) return false;

    ensureUI(roots[roots.length - 1]);
    const state = lastResult.mode === 'text-only' ? 'text-only' : 'done';
    renderBar(lastResult, state);
    renderDots(lastResult);
    return true;
  }

  function renderDots(result) {
    if (!result) return;
    for (const c of result.citations) {
      const loc = citationIndex.get(c.url);
      if (!loc?.anchors?.length) continue;
      for (const a of loc.anchors) {
        if (!a?.isConnected) continue;
        if (a.nextElementSibling?.classList?.contains('__ag-dot')) continue;
        const dot = document.createElement('span');
        dot.className = `__ag-dot __ag-${c.level.key}`;
        dot.setAttribute('data-ag', 'dot');
        dot.dataset.ag = 'dot';
        dot.title = `反GEO ${c.score} 分 · ${c.level.label}\n${c.flags.map((f) => '· ' + f.text).join('\n')}`;
        dot.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openPanel(c.url);
        });
        try {
          a.insertAdjacentElement('afterend', dot);
          // 正文里直接标出来：可疑的引用划掉
          if (c.level.key === 'red') {
            a.classList.add('__ag-flagged-ref');
          } else if (c.level.key === 'yellow') {
            a.classList.add('__ag-flagged-ref', '__ag-yellow-ref');
          }
          a.setAttribute('data-ag', 'ref');
          a.dataset.ag = 'ref';
        } catch {}
      }
    }
  }

  /* ══════════════════════════ 详情面板 ══════════════════════════ */

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function openPanel(focusUrl) {
    if (!lastResult) return;
    if (ui?.panel) {
      ui.panel.remove();
      ui.panel = null;
    }

    const host = document.createElement('div');
    host.setAttribute('data-ag', 'panel');
    host.dataset.ag = 'panel';
    host.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:min(440px,92vw);z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const s = lastResult.summary;
    const rows = lastResult.citations
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((c) => {
        const flags = c.flags
          .map(
            (f) =>
              `<li class="f f-${f.t}"><span class="dot d-${f.t}"></span><div>${escapeHtml(f.text)}${
                f.detail ? `<pre>${escapeHtml(f.detail)}</pre>` : ''
              }</div></li>`
          )
          .join('');
        return `
        <div class="card ${c.url === focusUrl ? 'focus' : ''}">
          <div class="head">
            <span class="score" style="background:${c.level.color}">${c.score}</span>
            <div class="meta">
              <div class="host">${escapeHtml(c.host)}</div>
              <a class="url" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.url.slice(0, 100))}</a>
            </div>
            <div class="acts">
              <button data-act="block" data-domain="${escapeHtml(c.reg)}" title="加入可疑名单">⊘</button>
              <button data-act="allow" data-domain="${escapeHtml(c.reg)}" title="加入白名单">✓</button>
            </div>
          </div>
          <ul class="flags">${flags || '<li class="f f-good"><span class="dot d-good"></span><div>未发现异常</div></li>'}</ul>
        </div>`;
      })
      .join('');

    const deepNote = lastResult.deep
      ? `已深度核查 ${lastResult.deepChecked} 页`
      : '域名级快速判断';

    const extList = Array.isArray(lastResult.externalOnly) ? lastResult.externalOnly : [];
    const extBlock = extList.length
      ? `<div class="ext">
           <div class="ext-h">另有 <b>${extList.length}</b> 条来源模型读过、但没展示给你</div>
           ${extList.slice(0, 6).map((e) => `<div class="ext-i"><span class="ext-h2">${escapeHtml(e.host)}</span>${e.snippet ? `<span class="ext-s">${escapeHtml(e.snippet.slice(0, 80))}</span>` : ''}</div>`).join('')}
         </div>`
      : '';

    shadow.innerHTML = `
      <style>
        :host{all:initial}
        .wrap{height:100%;display:flex;flex-direction:column;background:#fff;
          box-shadow:-8px 0 32px rgba(0,0,0,.16);
          font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937}
        .top{padding:16px 18px 12px;border-bottom:1px solid #e5e7eb}
        .title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;flex-wrap:wrap}
        .pill{padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#fff}
        .sub{margin-top:8px;color:#6b7280;font-size:12px}
        .concl{margin:10px 0 0;padding:0;list-style:none}
        .concl li{margin:3px 0;color:#374151;font-size:12.5px;padding-left:10px;position:relative}
        .concl li::before{content:"·";position:absolute;left:0;color:#9ca3af}
        .body{flex:1;overflow:auto;padding:12px 14px 24px;background:#f9fafb}
        .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:10px}
        .card.focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.12)}
        .head{display:flex;gap:10px;align-items:flex-start}
        .score{flex:none;min-width:34px;height:22px;padding:0 8px;border-radius:11px;color:#fff;
          font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}
        .meta{flex:1;min-width:0}
        .host{font-weight:600;font-size:13px}
        .url{color:#6b7280;font-size:11.5px;text-decoration:none;word-break:break-all;display:block}
        .url:hover{color:#4f46e5;text-decoration:underline}
        .acts{display:flex;gap:4px}
        .acts button{width:26px;height:26px;border:1px solid #e5e7eb;background:#fff;border-radius:6px;
          cursor:pointer;font-size:13px;color:#6b7280;line-height:1}
        .acts button:hover{background:#f3f4f6;color:#111827}
        .flags{list-style:none;margin:10px 0 0;padding:0}
        .f{display:flex;gap:7px;font-size:12.5px;margin:5px 0;color:#374151}
        .dot{flex:none;width:6px;height:6px;border-radius:50%;margin-top:8px}
        .d-bad{background:#dc2626}.d-warn{background:#d97706}.d-info{background:#9ca3af}.d-good{background:#16a34a}
        .f pre{margin:4px 0 0;padding:6px 8px;background:#f3f4f6;border-radius:6px;font-size:11.5px;
          white-space:pre-wrap;word-break:break-all;color:#4b5563}
        .f-bad{color:#991b1b;font-weight:500}
        .foot{padding:10px 18px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;
          display:flex;justify-content:space-between;align-items:center}
        .ext{margin-top:10px;padding:9px 11px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px}
        .ext-h{font-size:12px;color:#5b21b6;margin-bottom:6px}
        .ext-i{display:flex;gap:8px;font-size:11.5px;color:#6b7280;margin:3px 0;align-items:baseline}
        .ext-h2{font-weight:600;color:#4c1d95;flex:none}
        .ext-s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .x{margin-left:auto;cursor:pointer;font-size:18px;color:#9ca3af;padding:0 6px}
        .x:hover{color:#111827}
        .tag{font-size:10.5px;color:#9ca3af;border:1px solid #e5e7eb;border-radius:4px;padding:1px 4px}
      </style>
      <div class="wrap">
        <div class="top">
          <div class="title">
            反GEO · 引用溯源
            <span class="pill" style="background:${s.level.color}">污染度 ${s.pollution}</span>
            <span class="tag">${escapeHtml(ADAPTER?.name || HOSTNAME)}</span>
            <span class="x" id="close">×</span>
          </div>
          <div class="sub">共 ${s.total} 条引用 · ${s.distinctDomains} 个独立站点 · ${escapeHtml(deepNote)}</div>
          ${extBlock}
          <ul class="concl">${s.conclusions.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>
        <div class="body">${rows || '<div style="color:#9ca3af;padding:20px;text-align:center">这个答案没有外部引用</div>'}</div>
        <div class="foot"><span>纯本地检测 · 不上传任何数据</span><span id="opts" style="cursor:pointer;color:#4f46e5">设置</span></div>
      </div>`;

    shadow.getElementById('close').addEventListener('click', () => {
      host.remove();
      ui.panel = null;
    });
    shadow.getElementById('opts').addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'AG_OPEN_OPTIONS' });
      } catch {}
    });

    shadow.querySelectorAll('.acts button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await chrome.runtime.sendMessage({
            type: btn.dataset.act === 'block' ? 'AG_ADD_BLOCK' : 'AG_ADD_ALLOW',
            domain: btn.dataset.domain,
          });
          btn.textContent = '✓';
          btn.disabled = true;
          btn.style.color = '#16a34a';
          scheduleScan(300);
        } catch {}
      });
    });

    document.body.appendChild(host);
    ui.panel = host;

    const onDocClick = (e) => {
      if (!host.contains(e.target)) {
        host.remove();
        ui.panel = null;
        document.removeEventListener('click', onDocClick, true);
      }
    };
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  }

  /* ══════════════════════════ 扫描 ══════════════════════════ */

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function getSettings() {
    return sendMessage({ type: 'AG_GET_SETTINGS' }).then((r) => r || {});
  }

  async function doAnalyze(cites, deep, answerText = '') {
    return sendMessage({
      type: 'AG_ANALYZE',
      urls: cites.map((c) => c.url),
      sources: cites.map((c) => ({ url: c.url, snippet: c.snippet || '' })),
      pageUrl: location.href,
      deep,
      answerText,
    });
  }

  /** 从答案容器里取正文 —— 纯文本模式用 */
  function extractAnswerText(roots, maxLen = 8000) {
    let best = '';
    for (const r of roots) {
      const t = (r.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > best.length && t.length < 30000) best = t;
    }
    return best.slice(0, maxLen);
  }

  async function scan() {
    const settings = await getSettings();
    lastSettings = settings;
    if (settings.enabled === false) return;

    const overrides = settings.siteOverrides || {};
    const overrideSel = overrides[HOSTNAME] || overrides[location.hostname] || '';

    let roots = findAnswerRoots(overrideSel);
    if (!roots.length) {
      // 没有外链 → findAnswerRoots 全部过滤掉了。退一步找最大正文块，
      // 让纯文本模式仍然能工作（元宝 / 豆包未检索时就是这种情况）
      const fallback = findLargestTextBlock();
      // 诊断信息：出问题时在控制台看 window.__ANTIGEO__
      try {
        window.__ANTIGEO__ = window.__ANTIGEO__ || {};
        window.__ANTIGEO__.fallback = fallback
          ? { cls: (typeof fallback.className === 'string' ? fallback.className : '').slice(0, 50), len: (fallback.textContent || '').length }
          : null;
      } catch {}
      if (fallback) roots = [fallback];
    }
    if (!roots.length) {
      ui?.bar?.remove();
      return;
    }

    const cites = collectCitations(roots);
    citationIndex = new Map(cites.map((c) => [c.url, c]));

    const minCites = settings.minCitations ?? 2;
    if (cites.length < minCites) {
      // 平台没给引用（元宝 / 豆包未检索）→ 退化为只分析答案正文
      const answerText = extractAnswerText(roots);
      if (answerText.length >= 200) {
        const key2 = 'text:' + answerText.length + ':' + answerText.slice(0, 40);
        if (key2 !== lastKey) {
          lastKey = key2;
          const tr = await doAnalyze([], false, answerText);
          if (tr && tr.mode === 'text-only') {
            lastResult = tr;
            const lvl2 = settings.displayLevel || 'warn';
            const show2 = lvl2 === 'all' || tr.summary.level.key !== 'green';
            if (show2) {
              ensureUI(roots[roots.length - 1]);
              renderBar(tr, 'text-only');
            } else {
              ui?.bar?.remove();
            }
            try { window.__AG_LAST__ = lastResult; } catch {}
          }
        }
      } else {
        ui?.bar?.remove();
      }
      return;
    }

    const key = cites.map((c) => c.url).sort().join('|');
    const changed = key !== lastKey;

    if (!changed && lastResult) {
      // 内容没变：补画（应对 SPA 重渲染）
      // 关键：平台可能把横条冲掉了，这里必须检查并重建，否则横条再也不回来
      ensureBarVisible(roots);
      renderDots(lastResult);
      if (!deepDone && Date.now() - stableSince > 2200) scheduleDeep(0);
      return;
    }

    lastKey = key;
    lastCites = cites;
    stableKey = key;
    stableSince = Date.now();
    deepDone = false;
    clearTimeout(deepTimer);

    // ── 第一级：轻量判断，立即出条 ──
    const lite = await doAnalyze(cites, false);
    if (!lite || lite.error || lite.skipped) return;

    lastResult = lite;
    const lastRoot = roots[roots.length - 1];
    ensureUI(lastRoot);

    const showLite =
      settings.displayLevel === 'all' || lite.summary.level.key !== 'green' || lite.summary.flagged > 0;

    if (showLite) {
      renderBar(lite, settings.deepCheck === false ? 'done' : 'lite');
    } else {
      ui?.bar?.remove();
    }
    renderDots(lite);

    // ── 第二级：答案稳定 2.2 秒后，抓页面深度核查 ──
    if (settings.deepCheck !== false) scheduleDeep(2200);

    // popup 随时能查
    try {
      window.__AG_LAST__ = lastResult;
    } catch {}
  }

  function scheduleDeep(delay) {
    clearTimeout(deepTimer);
    deepTimer = setTimeout(async () => {
      if (deepDone) return;
      if (lastKey !== stableKey) return; // 内容又变了，放弃这次深度核查
      if (!lastCites.length) return;

      deepDone = true;
      const deep = await doAnalyze(lastCites, true);
      if (!deep || deep.error || deep.skipped) return;

      lastResult = deep;

      const lvl = lastSettings.displayLevel || 'warn';
      const shouldShow =
        lvl === 'all' || deep.summary.flagged > 0 || deep.summary.level.key !== 'green';

      // 关键：如果轻量阶段已经显示过横条，深度核查后即使变成"绿"也不要凭空消失——
      // 那样用户会觉得"刚才还在，一眨眼没了"。改成保留横条 + 结论文案。
      const wasVisible = !!ui?.bar?.isConnected;

      if (shouldShow || wasVisible) {
        if (!ui?.bar?.isConnected) {
          const roots = findAnswerRoots(
            (lastSettings.siteOverrides || {})[HOSTNAME] ||
              (lastSettings.siteOverrides || {})[location.hostname] ||
              ''
          );
          if (roots.length) ensureUI(roots[roots.length - 1]);
        }
        renderBar(deep, 'done');
      } else {
        ui?.bar?.remove();
      }

      // 深度结果可能改变分数，圆点要重画
      document.querySelectorAll('[data-ag="dot"]').forEach((d) => d.remove());
      renderDots(deep);

      try {
        window.__AG_LAST__ = lastResult;
      } catch {}
    }, delay);
  }

  function scheduleScan(delay = 1200) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scan().catch((e) => {
        try {
          window.__ANTIGEO__ = window.__ANTIGEO__ || {};
          window.__ANTIGEO__.lastError = String((e && e.message) || e);
        } catch {}
      });
    }, delay);
  }

  /* ══════════════════════════ 启动 ══════════════════════════ */

  function boot() {
    scheduleScan(1000);

    // 只观察明显变化，避免流式生成时疯狂重扫
    let pending = null;
    const mo = new MutationObserver((muts) => {
      let real = false;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.hasAttribute?.('data-ag') || n.id === '__ag_style') continue;
          real = true;
          break;
        }
        if (real) break;
        for (const n of m.removedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.hasAttribute?.('data-ag')) continue;
          real = true;
          break;
        }
        if (real) break;
      }
      if (!real) return;
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        scheduleScan(1200);
      }, 600);
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // 自愈：每 2.5s 看一眼横条还在不在。只在"该显示但不在"时才干活，开销接近零。
    setInterval(() => {
      if (!lastResult || ui?.dismissed || ui?.bar?.isConnected) return;
      const ov = lastSettings.siteOverrides || {};
      const sel = ov[HOSTNAME] || ov[location.hostname] || '';
      try {
        const roots = findAnswerRoots(sel);
        if (roots.length) ensureBarVisible(roots);
      } catch {}
    }, 2500);

    // SPA 路由
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      lastKey = '';
      lastResult = null;
      lastCites = [];
      deepDone = false;
      clearTimeout(deepTimer);
      ui?.panel?.remove();
      ui?.bar?.remove();
      ui = null;
      scheduleScan(1500);
    }, 1200);
  }

  // popup 查询：顶层注册，popup 打开时一定有人应答
  try {
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg?.type === 'AG_GET_LAST') {
        sendResponse({
          result: lastResult,
          host: HOSTNAME,
          platform: ADAPTER?.name || HOSTNAME,
          deepDone,
        });
      }
      return false;
    });
  } catch {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
