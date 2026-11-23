/**
 * 反GEO · 元宝引用专项探针 v3
 *
 * 背景：元宝的 13 个引用在 hyc-common-markdown__ref-list__item 里，但页面里
 * 一个 <a href> 都没有。所以要么 URL 藏在别的属性里，要么要点开才出现。
 *
 * 用法：在元宝的对话页（已生成带引用的答案）→ F12 → Console → 粘贴 → 回车
 */
(() => {
  const out = {
    probe: 'anti-geo/3-元宝',
    url: location.href,
    found: {},
  };

  /* ── 1) 引用列表的条目长什么样 ── */
  const items = document.querySelectorAll('[class*="ref-list__item"]');
  out.refItemCount = items.length;

  out.refItems = [...items].slice(0, 6).map((el, i) => {
    // 收集所有属性（含 data-*）
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === 'class') continue;
      attrs[a.name] = a.value.slice(0, 120);
    }

    // 元素里任何地方出现 http 的文本
    const html = el.outerHTML;
    const urls = [...new Set((html.match(/https?:\/\/[^\s"'<>\\)]+/g) || []))].slice(0, 5);

    // 纯文本
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);

    // 子元素结构（只有 tag + class）
    const clone = el.cloneNode(true);
    clone.querySelectorAll('*').forEach((x) => {
      const c = typeof x.className === 'string' ? x.className.slice(0, 40) : '';
      [...x.attributes].forEach((a) => x.removeAttribute(a.name));
      if (c) x.setAttribute('class', c);
    });

    return {
      index: i,
      attrs,
      text,
      urlsInHtml: urls,
      skeleton: clone.outerHTML.slice(0, 800),
    };
  });

  /* ── 2) 列表整体的属性（可能有统一的数据源）── */
  const list = document.querySelector('[class*="ref-list"]');
  if (list) {
    const la = {};
    for (const a of list.attributes) {
      if (a.name === 'class') continue;
      la[a.name] = a.value.slice(0, 300);
    }
    out.listAttrs = la;
    // 列表内部所有 https（可能带 JSON）
    out.listUrls = [...new Set((list.outerHTML.match(/https?:\/\/[^\s"'<>\\)]+/g) || []))].slice(0, 20);
    out.listHtmlLen = list.outerHTML.length;
  }

  /* ── 3) 整个页面里所有 https 文本（找有没有没做成链接的 URL）── */
  const bodyHtml = document.body.innerHTML;
  const allUrls = [...new Set((bodyHtml.match(/https?:\/\/[^\s"'<>\\)]{10,}/g) || []))];
  out.allUrlsInPage = {
    count: allUrls.length,
    sample: allUrls.filter((u) => !/yuanbao|tencent|qq\.com|gtimg/.test(u)).slice(0, 15),
  };

  /* ── 4) 有没有可点击的引用触发器 ── */
  out.triggers = [...document.querySelectorAll('[class*="ref-list__trigger"], [class*="Sources"], [class*="source"]')]
    .slice(0, 4)
    .map((el) => ({
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      tag: el.tagName.toLowerCase(),
      clickable: !!(el.onclick || el.getAttribute('role') === 'button' || el.tagName === 'BUTTON' || el.tabIndex >= 0),
    }));

  /* ── 5) React/Vue 的 props 里有没有 url（从 __reactProps 之类挖）── */
  const propsHits = [];
  for (const el of items) {
    for (const k of Object.keys(el)) {
      if (!/^__react|^__vue|^_react/i.test(k)) continue;
      try {
        const s = JSON.stringify(el[k]);
        const urls = [...new Set((s.match(/https?:\/\/[^\s"\\]{10,}/g) || []))].slice(0, 3);
        if (urls.length) propsHits.push({ key: k, urls });
      } catch {}
    }
    if (propsHits.length >= 3) break;
  }
  out.frameworkPropsWithUrls = propsHits.slice(0, 3);

  const json = JSON.stringify(out, null, 2);
  try { copy(json); } catch {}
  console.log(json);
  console.log(`%c✓ 已复制（找到 ${out.refItemCount} 个引用条目）`, 'color:#16a34a;font-weight:bold');
  return out;
})();
