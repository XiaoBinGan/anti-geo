import { getSettings, saveSettings } from '../lib/config.js';
import { buildExport, normalizeList, isSafeDomain } from '../lib/community.js';

const $ = (s) => document.querySelector(s);

const toLines = (arr) => (arr || []).join('\n');
const fromLines = (txt) =>
  String(txt || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

let saveTimer = null;
let savedEl;

function flashSaved(msg = '已保存') {
  savedEl.textContent = msg;
  savedEl.classList.add('on');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savedEl.classList.remove('on'), 1500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ts) {
  if (!ts) return '从未';
  const d = new Date(ts);
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (mins < 1440) return `${Math.floor(mins / 60)} 小时前`;
  return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/* ══════════════════════════ 载入 ══════════════════════════ */

async function load() {
  savedEl = $('#saved');
  const s = await getSettings();

  $('#enabled').checked = s.enabled !== false;
  $('#displayLevel').value = s.displayLevel || 'warn';
  $('#deepCheck').checked = s.deepCheck !== false;
  $('#maxFetch').value = s.maxFetch ?? 6;
  $('#minCitations').value = s.minCitations ?? 2;
  $('#blocklist').value = toLines(s.blocklist);
  $('#allowlist').value = toLines(s.allowlist);
  $('#extraSites').value = toLines(s.extraSites);
  $('#subUrl').value = s.subscriptionUrl || '';
  $('#externalSource').checked = s.externalSource === true;
  $('#externalSourceUrl').value = s.externalSourceUrl || 'http://127.0.0.1:8765/recent';

  wireBasic();
  wireExternal();
  wireSubscription();
  wireList();
  wireProbe();

  await refreshSubStatus();
  await renderOverrides();
}

/* ══════════════════════════ 基础设置 ══════════════════════════ */

function wireBasic() {
  $('#enabled').addEventListener('change', async (e) => {
    await saveSettings({ enabled: e.target.checked });
    flashSaved();
  });

  $('#displayLevel').addEventListener('change', async (e) => {
    await saveSettings({ displayLevel: e.target.value });
    flashSaved();
  });

  $('#deepCheck').addEventListener('change', async (e) => {
    await saveSettings({ deepCheck: e.target.checked });
    flashSaved();
  });

  $('#maxFetch').addEventListener('change', async (e) => {
    const v = Math.max(1, Math.min(12, parseInt(e.target.value, 10) || 6));
    e.target.value = v;
    await saveSettings({ maxFetch: v });
    flashSaved();
  });

  $('#minCitations').addEventListener('change', async (e) => {
    const v = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 2));
    e.target.value = v;
    await saveSettings({ minCitations: v });
    flashSaved();
  });

  const bindList = (id, key) => {
    let t;
    $(id).addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        await saveSettings({ [key]: fromLines(e.target.value) });
        flashSaved();
      }, 500);
    });
  };
  bindList('#extraSites', 'extraSites');
}

/* ══════════════════════════ 外部数据源 ══════════════════════════ */

function wireExternal() {
  $('#externalSource').addEventListener('change', async (e) => {
    await saveSettings({ externalSource: e.target.checked });
    flashSaved(e.target.checked ? '已启用外部数据源' : '已关闭');
    if (e.target.checked) testExternal();
  });

  let t;
  $('#externalSourceUrl').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(async () => {
      await saveSettings({ externalSourceUrl: e.target.value.trim() });
      flashSaved();
    }, 500);
  });

  $('#extTest').addEventListener('click', testExternal);
}

async function testExternal() {
  const st = $('#extStatus');
  const url = ($('#externalSourceUrl').value || '').trim() || 'http://127.0.0.1:8765/recent';
  st.className = 'status idle';
  st.textContent = '正在连接…';

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const n = Array.isArray(d?.sources) ? d.sources.length : 0;

    if (!n) {
      st.className = 'status ok';
      st.innerHTML = `连上了，但还没有抓取数据。<br/>去 AI 平台问一个问题，代理抓到来源后再回来测。`;
    } else {
      st.className = 'status ok';
      st.innerHTML =
        `连上了：当前缓冲区有 <b>${n}</b> 条来源（最近 3 分钟）<br/>` +
        d.sources
          .slice(0, 3)
          .map((x) => `· <code>${esc(x.host || x.url)}</code> ${esc((x.snippet || '').slice(0, 40))}`)
          .join('<br/>');
    }
  } catch (e) {
    st.className = 'status err';
    st.innerHTML =
      `连不上：${esc(String(e.message || e))}<br/>` +
      `确认 <code>mitmdump -s tools/antigeo_addon.py -p 8080</code> 正在跑，且端口没被占用。`;
  }
}

/* ══════════════════════════ 订阅 ══════════════════════════ */

async function refreshSubStatus() {
  const el = $('#subStatus');
  let st;
  try {
    st = await chrome.runtime.sendMessage({ type: 'AG_SUB_STATUS' });
  } catch {
    st = null;
  }

  if (!st || !st.url) {
    el.className = 'status idle';
    el.textContent = '尚未订阅。填一个地址点「保存并刷新」即可开始。';
    return;
  }

  if (st.error) {
    el.className = 'status err';
    el.innerHTML = `<b>拉取失败</b>：${esc(st.error)}<br/>上次成功拉取：${fmtTime(st.fetchedAt)}，当前沿用旧数据 ${st.domains?.length || 0} 条。`;
    return;
  }

  el.className = 'status ok';
  el.innerHTML =
    `已订阅<b>${esc(st.name || '社区名单')}</b>：<b>${st.domains?.length || 0}</b> 条域名` +
    (st.updated ? `（名单更新于 ${esc(st.updated)}）` : '') +
    `<br/>上次拉取：${fmtTime(st.fetchedAt)}　·　权重 45（低于你自己标的 60）`;
}

function wireSubscription() {
  $('#subSave').addEventListener('click', async () => {
    const url = $('#subUrl').value.trim();
    const btn = $('#subSave');
    btn.disabled = true;
    btn.textContent = '拉取中…';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'AG_SUB_REFRESH', url });
      if (r?.ok) flashSaved(`已订阅 ${r.count} 条`);
      else flashSaved(r?.error ? '失败：' + r.error : '已清空');
      await refreshSubStatus();
    } finally {
      btn.disabled = false;
      btn.textContent = '保存并刷新';
    }
  });

  $('#subNow').addEventListener('click', async () => {
    const url = $('#subUrl').value.trim();
    if (!url) return;
    const btn = $('#subNow');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'AG_SUB_REFRESH', url });
      if (r?.ok) flashSaved(`已刷新 ${r.count} 条`);
      else flashSaved(r?.error ? '失败：' + r.error : '完成');
      await refreshSubStatus();
    } finally {
      btn.disabled = false;
      btn.textContent = '立即刷新';
    }
  });

  $('#subClear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'AG_SUB_CLEAR' });
    $('#subUrl').value = '';
    await refreshSubStatus();
    flashSaved('已取消订阅');
  });
}

/* ══════════════════════════ 名单导入导出 ══════════════════════════ */

function wireList() {
  const bindList = (id, key) => {
    let t;
    $(id).addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        await saveSettings({ [key]: fromLines(e.target.value) });
        flashSaved();
      }, 500);
    });
  };
  bindList('#blocklist', 'blocklist');
  bindList('#allowlist', 'allowlist');

  $('#exportList').addEventListener('click', async () => {
    const s = await getSettings();
    let sub = null;
    try {
      sub = await chrome.runtime.sendMessage({ type: 'AG_SUB_STATUS' });
    } catch {}
    const data = buildExport({
      blocklist: s.blocklist,
      allowlist: s.allowlist,
      subscription: sub,
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `anti-geo-list-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);

    const st = $('#listStatus');
    st.style.display = 'block';
    st.className = 'status ok';
    st.textContent = `已导出 ${data.domains.length} 条可疑域名 + ${data.allow.length} 条白名单。可以直接托管成订阅地址分享给别人。`;
  });

  $('#importList').addEventListener('click', () => $('#importFile').click());

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const st = $('#listStatus');
    st.style.display = 'block';

    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const items = normalizeList(raw);

      // 导出的格式里 allow 是字符串数组
      const allowRaw = Array.isArray(raw?.allow) ? raw.allow : [];
      const allow = allowRaw
        .map((x) => String(typeof x === 'string' ? x : x?.d || '').trim().toLowerCase())
        .filter(isSafeDomain);

      if (!items.length && !allow.length) throw new Error('文件里没有可识别的域名');

      const s = await getSettings();
      const bl = new Set(s.blocklist.map((d) => d.toLowerCase()));
      const al = new Set(s.allowlist.map((d) => d.toLowerCase()));

      let addedBad = 0;
      for (const it of items) {
        if (!bl.has(it.d) && !al.has(it.d)) {
          bl.add(it.d);
          addedBad++;
        }
      }
      let addedGood = 0;
      for (const d of allow) {
        if (!al.has(d) && !bl.has(d)) {
          al.add(d);
          addedGood++;
        }
      }

      await saveSettings({ blocklist: [...bl], allowlist: [...al] });
      $('#blocklist').value = toLines([...bl]);
      $('#allowlist').value = toLines([...al]);

      st.className = 'status ok';
      st.textContent = `导入完成：新增 ${addedBad} 条可疑域名、${addedGood} 条白名单。`;
      flashSaved('已导入');
    } catch (err) {
      st.className = 'status err';
      st.textContent = '导入失败：' + String(err.message || err);
    } finally {
      e.target.value = '';
    }
  });
}

/* ══════════════════════════ 站点探测 ══════════════════════════ */

/** 在目标页面执行：只能引用自身作用域，不能引用外部变量 */
function pageProbe() {
  const PLATFORM = [
    'chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai', 'google.com',
    'googleusercontent.com', 'gstatic.com', 'bing.com', 'microsoft.com', 'msn.com',
    'doubao.com', 'bytedance.com', 'kimi.com', 'moonshot.cn', 'yuanbao.tencent.com',
    'tencent.com', 'metaso.cn', 'deepseek.com', 'zhipuai.cn', 'chatglm.cn', 'baidu.com',
  ];

  const escId = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

  function cssPath(el) {
    if (el.id && document.querySelectorAll('#' + escId(el.id)).length === 1) return '#' + escId(el.id);
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id && document.querySelectorAll('#' + escId(cur.id)).length === 1) {
        parts.unshift('#' + escId(cur.id));
        break;
      }
      const cls = [...(cur.classList || [])].filter((c) => /^[a-zA-Z_][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) sel += '.' + cls.map(escId).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function externalLinks(el) {
    let n = 0;
    for (const a of el.querySelectorAll('a[href^="http"]')) {
      try {
        const h = new URL(a.href).hostname.replace(/^www\./, '');
        if (!PLATFORM.some((p) => h === p || h.endsWith('.' + p))) n++;
      } catch {}
    }
    return n;
  }

  const POOL_SEL =
    'article, main, [class*="prose"], [class*="markdown"], [class*="answer"], ' +
    '[class*="message"], [class*="content"], [class*="response"], [class*="result"], ' +
    '[class*="chat"], [class*="bubble"]';

  const seen = new Set();
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(POOL_SEL)) {
    if (++i > 1200) break;
    const text = el.innerText || '';
    const len = text.length;
    if (len < 100) continue;
    const links = externalLinks(el);
    // 链接密度过高的是导航/列表，不是答案
    const density = el.querySelectorAll('a').length / Math.max(len, 1);
    if (density > 0.08) continue;
    const sel = cssPath(el);
    if (seen.has(sel)) continue;
    seen.add(sel);
    out.push({
      selector: sel,
      textLen: len,
      links,
      unique: document.querySelectorAll(sel).length,
      preview: text.replace(/\s+/g, ' ').slice(0, 120),
      score: len * 0.5 + links * 60,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 8).map(({ score, ...rest }) => rest);
}

let probedTabId = null;
let probedHost = '';
let probedCandidates = [];
let probedSelected = null;

async function doProbe() {
  const st = $('#probeStatus');
  const candsEl = $('#cands');
  candsEl.innerHTML = '';
  $('#probeActions').style.display = 'none';

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}

  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    st.className = 'status err';
    st.textContent = '当前标签页不是普通网页，无法探测。请切到一个 AI 搜索页面再试。';
    return;
  }

  st.className = 'status idle';
  st.textContent = '正在扫描这个页面的 DOM…';

  let results = null;
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageProbe,
    });
    results = r?.[0]?.result;
  } catch (e) {
    st.className = 'status err';
    st.textContent = '注入失败：' + String(e?.message || e) + '（可能是受限页面）';
    return;
  }

  if (!results || !results.length) {
    st.className = 'status err';
    st.innerHTML =
      '没找到候选容器。可能原因：<br/>· 这个页面还没有生成带引用的回答（先提个问题，等它答完）<br/>· 答案里没有外部链接引用<br/>· 这个站用了 Shadow DOM / iframe，探测看不到';
    return;
  }

  probedTabId = tab.id;
  probedHost = new URL(tab.url).hostname;
  probedCandidates = results;
  probedSelected = null;

  st.className = 'status ok';
  st.innerHTML = `在 <b>${esc(probedHost)}</b> 找到 ${results.length} 个候选。点选最像"答案正文"的那个：`;

  candsEl.innerHTML = results
    .map(
      (c, idx) => `
    <div class="cand" data-idx="${idx}">
      <div class="c-top">
        <span class="c-sel">${esc(c.selector)}</span>
        <span class="c-meta">${c.textLen} 字 · ${c.links} 外链${c.unique > 1 ? ` · 匹配 ${c.unique} 处` : ''}</span>
      </div>
      <div class="c-prev">${esc(c.preview)}</div>
    </div>`
    )
    .join('');

  candsEl.querySelectorAll('.cand').forEach((el) => {
    el.addEventListener('click', () => {
      candsEl.querySelectorAll('.cand').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      probedSelected = probedCandidates[Number(el.dataset.idx)];
      $('#probeActions').style.display = 'flex';
    });
  });
}

async function applyProbe() {
  if (!probedSelected || !probedHost) return;
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'AG_SET_OVERRIDE',
      host: probedHost,
      selector: probedSelected.selector,
    });
    if (r?.ok) {
      flashSaved('已记住这个站点的选择器');
      $('#probeActions').style.display = 'none';
      $('#probeStatus').className = 'status ok';
      $('#probeStatus').innerHTML = `已保存。<br/><code>${esc(probedHost)}</code> → <code>${esc(probedSelected.selector)}</code><br/>刷新那个页面就能生效。`;
      await renderOverrides();
    } else {
      flashSaved('保存失败：' + (r?.error || '未知'));
    }
  } catch (e) {
    flashSaved('保存失败');
  }
}

async function clearProbe() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}
  if (!tab?.url) return;
  const host = new URL(tab.url).hostname;
  await chrome.runtime.sendMessage({ type: 'AG_CLEAR_OVERRIDE', host });
  flashSaved('已清除本页覆盖');
  $('#probeStatus').className = 'status idle';
  $('#probeStatus').textContent = '已清除。这个页面会回到内置适配器逻辑。';
  $('#cands').innerHTML = '';
  $('#probeActions').style.display = 'none';
  await renderOverrides();
}

async function renderOverrides() {
  const el = $('#overrideList');
  const s = await getSettings();
  const ov = s.siteOverrides || {};
  const keys = Object.keys(ov);

  if (!keys.length) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML =
    '<div style="color:#9ca3af;font-size:11.5px;margin-top:14px">已保存的站点覆盖</div>' +
    keys
      .map(
        (h) => `
    <div class="o">
      <span style="font-weight:600;font-size:12.5px;white-space:nowrap">${esc(h)}</span>
      <code>${esc(ov[h])}</code>
      <button data-host="${esc(h)}">删除</button>
    </div>`
      )
      .join('');

  el.querySelectorAll('button[data-host]').forEach((b) => {
    b.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'AG_CLEAR_OVERRIDE', host: b.dataset.host });
      await renderOverrides();
      flashSaved('已删除');
    });
  });
}

function wireProbe() {
  $('#probeBtn').addEventListener('click', doProbe);
  $('#applyProbe').addEventListener('click', applyProbe);
  $('#probeClear').addEventListener('click', clearProbe);
}

/* ══════════════════════════ 启动 ══════════════════════════ */

load();
