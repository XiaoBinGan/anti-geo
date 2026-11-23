/**
 * 反GEO · DOM 诊断探针 v2
 *
 * 用途：当 v1 报 extAnchors: 0（找不到外部引用链接）时，用它看页面到底长什么样。
 * 不依赖 <a href>，而是扫 class 名、文本角标、可能的引用容器。
 *
 * 用法：F12 → Console → 粘贴 → 回车（结果自动进剪贴板）
 */
(() => {
  const out = {
    probe: 'anti-geo/2',
    url: location.href,
    host: location.hostname,
    title: document.title,
    bodyTextLen: (document.body.innerText || '').length,
  };

  /* ── 1) 所有 class 名统计（谁在承载引用） ── */
  const classCount = new Map();
  for (const el of document.querySelectorAll('*')) {
    const c = typeof el.className === 'string' ? el.className : el.getAttribute?.('class') || '';
    for (const k of c.split(/\s+/)) {
      if (!k || k.length > 60) continue;
      classCount.set(k, (classCount.get(k) || 0) + 1);
    }
  }
  const classList = [...classCount.entries()].sort((a, b) => b[1] - a[1]);

  // 可疑的引用类名
  const REF_RE = /cit|source|refer|ref-|_ref|footnote|superscript|search-?result|link-?card|attribution|corpus|knowledge|web/i;
  out.refClasses = classList
    .filter(([k]) => REF_RE.test(k))
    .slice(0, 40)
    .map(([k, n]) => ({ cls: k, count: n }));

  out.classTop = classList.slice(0, 60).map(([k, n]) => `${k}(${n})`);

  /* ── 2) 所有 a 标签（含内部） ── */
  const allA = [...document.querySelectorAll('a[href]')];
  const extA = allA.filter((a) => {
    try {
      const u = new URL(a.getAttribute('href'), location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      const h = u.hostname.replace(/^www\./, '');
      return h !== location.hostname.replace(/^www\./, '') &&
        !/doubao|bytedance|kimi|moonshot|yuanbao|tencent|deepseek|metaso|zhipu|chatglm|baike|beian|miit|gov\.cn$/.test(h);
    } catch { return false; }
  });
  out.anchors = {
    total: allA.length,
    external: extA.length,
    sample: allA.slice(0, 10).map((a) => ({
      href: (a.getAttribute('href') || '').slice(0, 80),
      text: (a.textContent || '').trim().slice(0, 30),
      cls: (typeof a.className === 'string' ? a.className : '').slice(0, 50),
    })),
  };

  /* ── 3) 数字角标（[1] [2] 1 2 上标）── */
  const badges = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  let guard = 0;
  while ((node = walker.nextNode()) && guard < 20000) {
    guard++;
    const t = (node.textContent || '').trim();
    if (!/^\[?\d{1,2}\]?$/.test(t)) continue;
    const p = node.parentElement;
    if (!p) continue;
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    badges.push({
      text: t,
      tag: p.tagName.toLowerCase(),
      cls: (typeof p.className === 'string' ? p.className : '').slice(0, 60),
      parentCls: (typeof p.parentElement?.className === 'string' ? p.parentElement.className : '').slice(0, 60),
    });
    if (badges.length >= 20) break;
  }
  out.numberBadges = badges;

  /* ── 4) 含"参考/来源/引用/searching"文本的元素 ── */
  const refText = [];
  for (const el of document.querySelectorAll('div,span,button,a,p,li,section')) {
    const t = (el.textContent || '').trim();
    if (t.length > 60) continue;
    if (!/(参考|来源|引用|检索|搜索了|找到\s*\d+|共\s*\d+\s*篇|参考资料|citation|source)/i.test(t)) continue;
    if (el.childElementCount > 3) continue;
    refText.push({
      text: t.slice(0, 50),
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
    });
    if (refText.length >= 15) break;
  }
  out.refTextNodes = refText;

  /* ── 5) 最大的几个文本块（找答案区） ── */
  const blocks = [];
  for (const el of document.querySelectorAll('div,article,section,main')) {
    const t = (el.textContent || '').trim();
    if (t.length < 100) continue;
    if (t.length > 80000) continue;
    const links = el.querySelectorAll('a').length;
    blocks.push({
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
      tag: el.tagName.toLowerCase(),
      textLen: t.length,
      links,
      preview: t.replace(/\s+/g, ' ').slice(0, 80),
    });
  }
  blocks.sort((a, b) => b.textLen - a.textLen);
  out.bigBlocks = blocks.slice(0, 8);

  /* ── 6) shadow DOM 里的东西 ── */
  const shadowInfo = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.shadowRoot) {
      shadowInfo.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 50),
        innerLen: (el.shadowRoot.textContent || '').length,
        links: el.shadowRoot.querySelectorAll('a[href]').length,
      });
    }
    if (shadowInfo.length >= 10) break;
  }
  out.shadowHosts = shadowInfo;

  /* ── 7) 答案区 HTML 片段（去掉长属性，只看结构） ── */
  const best = blocks[0];
  if (best) {
    const el = [...document.querySelectorAll('div,article,section,main')]
      .filter((e) => (typeof e.className === 'string' ? e.className : '').slice(0, 70) === best.cls)
      .sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0];
    if (el) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script,style,svg').forEach((x) => x.remove());
      // 只保留 tag + class，去掉所有其他属性
      clone.querySelectorAll('*').forEach((x) => {
        const c = typeof x.className === 'string' ? x.className.slice(0, 40) : '';
        [...x.attributes].forEach((a) => x.removeAttribute(a.name));
        if (c) x.setAttribute('class', c);
      });
      out.answerHtml = clone.outerHTML.slice(0, 3000);
    }
  }

  const json = JSON.stringify(out, null, 2);
  try { copy(json); } catch {}
  console.log(json);
  console.log('%c✓ 已复制到剪贴板', 'color:#16a34a;font-weight:bold');
  return out;
})();
