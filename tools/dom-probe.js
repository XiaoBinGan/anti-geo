/**
 * 反GEO · DOM 结构探针
 *
 * 用法（最简，零风险）：
 *   1. 在目标 AI 页面提一个问题，等它答完（要有引用链接）
 *   2. F12 打开 DevTools → Console
 *   3. 把本文件全部内容粘贴进去 → 回车
 *   4. 结果已自动复制到剪贴板，直接粘给我
 *
 * 它只读 DOM 结构，不改任何东西，不发任何请求。
 */
(() => {
  const PLATFORM = [
    'chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai',
    'google.com', 'googleusercontent.com', 'gstatic.com', 'bing.com',
    'microsoft.com', 'msn.com', 'doubao.com', 'bytedance.com', 'kimi.com',
    'moonshot.cn', 'yuanbao.tencent.com', 'tencent.com', 'metaso.cn',
    'deepseek.com', 'zhipuai.cn', 'chatglm.cn', 'baidu.com',
  ];
  const isPlatformHost = (h) =>
    PLATFORM.some((p) => h === p || h.endsWith('.' + p));

  /* ── 收集所有可访问的根（含 open shadow root / 同源 iframe） ── */
  function collectRoots(budget = 4000) {
    const roots = [document];
    const seen = new Set();
    (function walk(root) {
      let els;
      try { els = root.querySelectorAll('*'); } catch { return; }
      for (const el of els) {
        if (--budget <= 0) return;
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
          if (budget <= 0) return;
        }
        if (el.tagName === 'IFRAME') {
          try {
            const d = el.contentDocument;
            if (d && d.documentElement && !roots.includes(d)) { roots.push(d); walk(d); }
          } catch {}
        }
      }
    })(document);
    return roots;
  }

  const roots = collectRoots();

  /* ── 外部引用链接 ── */
  function extHref(a) {
    try {
      const raw = a.getAttribute('href') || '';
      let u = new URL(raw, location.href);
      // 豆包跳转：link.wtturl.cn/?target=<encoded>
      if (/(^|\.)wtturl\.cn$/.test(u.hostname)) {
        const t = u.searchParams.get('target');
        if (t) u = new URL(t.startsWith('http') ? t : decodeURIComponent(t));
      }
      {
        const t = u.searchParams.get('target');
        if (t && /^https?:/i.test(t)) u = new URL(t);
      }
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
        const q = u.searchParams.get('q') || u.searchParams.get('url');
        if (q) u = new URL(q, location.href);
      }
      if (u.hash.startsWith('#:~:')) u.hash = '';
      if (!/^https?:$/.test(u.protocol)) return null;
      if (isPlatformHost(u.hostname.replace(/^www\./, ''))) return null;
      if (u.hostname === location.hostname) return null;
      // 去掉跟踪参数（ChatGPT / Perplexity 的引用 URL 都带 utm_source）
      try {
        const kill = [];
        u.searchParams.forEach((_v, k) => {
          if (/^(utm_[a-z]+|fbclid|gclid|msclkid|_hsenc|_hsmi|ref_src|ref_url|spm|scm|from|share_token)$/i.test(k)) kill.push(k);
        });
        for (const k of kill) u.searchParams.delete(k);
      } catch {}
      return u.href;
    } catch { return null; }
  }

  const extAnchors = [];
  for (const r of roots) {
    let as;
    try { as = r.querySelectorAll('a[href]'); } catch { continue; }
    for (const a of as) {
      if (a.closest('nav, header, footer, aside, [role="navigation"]')) continue;
      const h = extHref(a);
      if (h) extAnchors.push({ a, href: h });
    }
  }

  /* ── 向上累计每个祖先包含多少外链 ── */
  const stat = new Map();
  for (const { a } of extAnchors) {
    let cur = a.parentElement;
    let d = 0;
    while (cur && d < 20) {
      const s = stat.get(cur) || { ext: 0, minDepth: d };
      s.ext++;
      stat.set(cur, s);
      cur = cur.parentElement;
      d++;
    }
  }

  /* ── 生成稳定 CSS 路径 ── */
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  function cssPath(el) {
    if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id && document.querySelectorAll('#' + esc(cur.id)).length === 1) {
        parts.unshift('#' + esc(cur.id));
        break;
      }
      const cls = [...(cur.classList || [])].filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 3);
      if (cls.length) sel += '.' + cls.map(esc).join('.');
      const p = cur.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  /* ── 祖先链摘要（帮我看清层级） ── */
  function chain(el, n = 5) {
    const out = [];
    let cur = el;
    let d = 0;
    while (cur && cur.nodeType === 1 && d < n) {
      const cls = (typeof cur.className === 'string' ? cur.className : '')
        .split(/\s+/).filter(Boolean).slice(0, 3).join('.');
      out.push(`${cur.tagName.toLowerCase()}${cur.id ? '#' + cur.id : ''}${cls ? '.' + cls : ''}`);
      cur = cur.parentElement;
      d++;
    }
    return out.join(' < ');
  }

  /* ── 候选容器 ── */
  const cands = [];
  for (const [el, s] of stat) {
    if (s.ext < 2) continue;
    let tag = el.tagName;
    // html / body 永远是"包含所有"的容器，对定位答案区没意义
    if (['HTML', 'BODY', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE'].includes(tag)) continue;

    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const links = el.querySelectorAll('a[href]').length;
    if (text.length < 15) continue;
    // 密度过滤只对大块生效 —— 小容器本来就链接密集（比如一句话里三个引用）
    if (text.length > 100 && links / Math.max(text.length, 1) > 0.12) continue;

    cands.push({
      selector: cssPath(el),
      ext: s.ext,
      textLen: text.length,
      totalLinks: links,
      paragraphs: el.querySelectorAll('p, li').length,
      className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
      id: el.id || '',
      testid: el.getAttribute('data-testid') || '',
      role: el.getAttribute('role') || '',
      chain: chain(el),
      preview: text.slice(0, 90),
      depth: (() => { let d = 0, c = el; while (c && c.parentElement && d < 50) { d++; c = c.parentElement; } return d; })(),
    });
  }

  // 和插件一致的选择规则：外链最多 → 并列时取最深
  // 小卡片：文本 20–60 字、含外链 —— 通常是来源列表的每一条
  const smallBlocks = [];
  for (const [el, st] of stat) {
    if (st.ext < 1) continue;
    if (['HTML', 'BODY', 'NAV', 'HEADER', 'FOOTER', 'ASIDE'].includes(el.tagName)) continue;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 20 || text.length >= 60) continue;
    smallBlocks.push({
      selector: cssPath(el),
      textLen: text.length,
      className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
      preview: text.slice(0, 60),
    });
  }
  smallBlocks.sort((a, b) => b.textLen - a.textLen);

  cands.sort((a, b) => b.ext - a.ext || b.depth - a.depth);
  if (cands.length) {
    const maxExt = cands[0].ext;
    const pool = cands.filter((c) => c.ext === maxExt);
    pool.sort((a, b) => b.depth - a.depth);
    cands.forEach((c) => { c.pluginsPick = false; });
    if (pool[0]) pool[0].pluginsPick = true;
    // 把插件会选的那个提到最前面，方便对照
    const idx = cands.indexOf(pool[0]);
    if (idx > 0) { const [x] = cands.splice(idx, 1); cands.unshift(x); }
  }

  /* ── 引用链接本身的形态 ── */
  // 同一个 URL 常有两种形态：正文里的 inline 链接 + 底部的来源卡片
  const shapeMap = new Map();
  for (const { a, href } of extAnchors) {
    if (!shapeMap.has(href)) shapeMap.set(href, []);
    const p = a.parentElement;
    const gp = p?.parentElement;
    shapeMap.get(href).push({
      anchorText: (a.textContent || '').trim().slice(0, 50),
      path: `${p?.tagName.toLowerCase() || '?'}${p?.className && typeof p.className === 'string' ? '.' + p.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''}` +
            ` < ${gp?.tagName.toLowerCase() || '?'}${gp?.className && typeof gp.className === 'string' ? '.' + gp.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''}`,
      parentTextLen: (p?.textContent || '').replace(/\s+/g, ' ').trim().length,
      title: a.getAttribute('title') || '',
      ariaLabel: a.getAttribute('aria-label') || '',
    });
  }
  const anchorShapes = [...shapeMap.entries()].slice(0, 8).map(([href, shapes]) => ({
    href: href.slice(0, 100),
    occurrences: shapes.length,
    shapes,
  }));

  const out = {
    probe: 'anti-geo/1',
    url: location.href,
    host: location.hostname,
    title: document.title,
    roots: roots.length,
    hasShadow: roots.length > 1,
    extAnchors: extAnchors.length,
    candidates: cands.slice(0, 10),
    smallBlocks: smallBlocks.slice(0, 8),
    anchorShapes,
  };

  const json = JSON.stringify(out, null, 2);
  try { copy(json); } catch {}
  console.log(json);
  console.log('%c✓ 已复制到剪贴板（共 ' + out.candidates.length + ' 个候选容器）', 'color:#16a34a;font-weight:bold');
  return out;
})();
