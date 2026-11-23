/**
 * 反GEO · 元宝引用浮层探针 v5（自动点击）
 *
 * 为什么需要它：元宝的引用 URL 可能只在「点开 Sources 浮层」时才有，
 * 但手动点开再切到 Console，页面失焦浮层就关了。
 * 这个版本自己在页面里点、自己扫、自己关 —— 不依赖鼠标。
 *
 * 用法：元宝对话页 → F12 → Console → 粘贴 → 回车（等待几秒）
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { probe: 'anti-geo/5-元宝自动点击', url: location.href, steps: [] };

  const isExt = (href) => {
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      const h = u.hostname.replace(/^www\./, '');
      if (h === location.hostname.replace(/^www\./, '')) return false;
      // 排除腾讯自家 CDN / 埋点 / 图标
      if (/(^|\.)(tencent\.com|qq\.com|gtimg\.com|myqcloud\.com|hunyuan\.tencent\.com|w3\.org|googletagmanager\.com|google-analytics\.com)$/.test(h)) return false;
      if (/\.(png|jpg|jpeg|gif|svg|webp|ico|css|js)(\?|$)/i.test(u.pathname)) return false;
      return true;
    } catch { return false; }
  };

  const scanAnchors = () =>
    [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter(isExt);

  const scanHttpText = () => {
    const found = new Set();
    const html = document.body.innerHTML;
    for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
      if (isExt(m[0])) found.add(m[0]);
    }
    return [...found];
  };

  const before = { anchors: new Set(scanAnchors()), texts: new Set(scanHttpText()) };
  out.baseline = { anchors: before.anchors.size, httpTexts: before.texts.size };

  /* ── 找所有可能的引用触发器 ── */
  const triggerSel = [
    '[class*="ref-list__trigger"]',
    '[class*="ref-list"]',
    '[class*="Sources"]',
    '[class*="source-list"]',
    '[class*="citation"]',
    '[class*="reference"]',
  ].join(',');

  const triggers = [...document.querySelectorAll(triggerSel)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  out.triggerCount = triggers.length;

  /* ── 逐个点开，扫新增 ── */
  const discovered = new Set();
  for (let i = 0; i < Math.min(triggers.length, 8); i++) {
    const t = triggers[i];
    const step = { i, cls: (typeof t.className === 'string' ? t.className : '').slice(0, 50) };
    try {
      t.click();
      await sleep(500);

      const nowA = scanAnchors().filter((a) => !before.anchors.has(a));
      const nowT = scanHttpText().filter((a) => !before.texts.has(a));

      // 浮层里出现的域名文本（如 "finance.sina.cn"）
      const popupTexts = [...document.querySelectorAll('[class*="popup"],[class*="tooltip"],[class*="overlay"],[class*="modal"],[class*="drawer"],[class*="panel"]')]
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((s) => s.length > 10 && s.length < 2000)
        .slice(0, 3);

      step.newAnchors = nowA.slice(0, 8);
      step.newHttpTexts = nowT.slice(0, 8);
      step.popupTexts = popupTexts.map((s) => s.slice(0, 150));

      nowA.forEach((a) => discovered.add(a));
      nowT.forEach((a) => discovered.add(a));

      // 关闭浮层
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(250);
    } catch (e) {
      step.error = String(e.message || e).slice(0, 100);
    }
    out.steps.push(step);
    if (discovered.size >= 6) break;
  }

  /* ── 如果点击没收获，看看 React state 里有没有 ── */
  if (!discovered.size) {
    out.reactSearch = [];
    const roots = [];
    for (const el of document.querySelectorAll('[class*="ref-list"], [class*="agent-chat"]')) roots.push(el);
    for (const el of roots.slice(0, 4)) {
      for (const k of Object.keys(el)) {
        if (!/^__react/i.test(k)) continue;
        try {
          const s = JSON.stringify(el[k]);
          const urls = [...new Set((s.match(/https?:\/\/[^\s"\\]{12,}/g) || []))]
            .filter(isExt)
            .slice(0, 5);
          if (urls.length) out.reactSearch.push({ key: k, urls });
        } catch {}
      }
    }
  }

  out.discovered = [...discovered];
  out.conclusion = discovered.size
    ? `点开后拿到 ${discovered.size} 个外部链接`
    : '点击浮层后仍然没有外部链接 —— 元宝不在 DOM 里暴露来源 URL';

  const json = JSON.stringify(out, null, 2);
  try { copy(json); } catch {}
  console.log(json);
  console.log(
    discovered.size
      ? `%c✓ 拿到 ${discovered.size} 个链接，已复制`
      : '%c✗ 确认无 URL，已复制',
    'color:#16a34a;font-weight:bold'
  );
  return out;
})();
