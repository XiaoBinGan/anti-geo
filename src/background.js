/**
 * background.js — 唯一做"脏活"的地方：抓页面、算指纹、评分
 * content script 只负责找引用和画画，不碰网络。
 */

import { analyzePage } from './lib/analyze.js';
import { scoreCitations, scoreAnswerText } from './lib/scoring.js';
import { getSettings, cacheGet, cacheSet, DEFAULT_SETTINGS } from './lib/config.js';
import { getSubscription, refreshSubscription, maybeAutoRefresh } from './lib/community.js';

/* ───────────────────────── 消息路由 ───────────────────────── */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'AG_ANALYZE') {
    handleAnalyze(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true; // 异步
  }
  if (msg?.type === 'AG_GET_SETTINGS') {
    getSettings().then(sendResponse);
    return true;
  }
  if (msg?.type === 'AG_ADD_BLOCK') {
    addBlocklist(msg.domain).then(sendResponse);
    return true;
  }
  if (msg?.type === 'AG_ADD_ALLOW') {
    addAllowlist(msg.domain).then(sendResponse);
    return true;
  }
  if (msg?.type === 'AG_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  /* ── 社区名单 ── */
  if (msg?.type === 'AG_SUB_REFRESH') {
    refreshSubscription(msg.url || '', { force: true })
      .then(async (r) => {
        if (msg.url) await chrome.storage.sync.set({ subscriptionUrl: msg.url });
        sendResponse({ ...r, status: await getSubscription() });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'AG_SUB_STATUS') {
    getSubscription().then(sendResponse);
    return true;
  }
  if (msg?.type === 'AG_SUB_CLEAR') {
    refreshSubscription('', { force: true })
      .then(async () => {
        await chrome.storage.sync.set({ subscriptionUrl: '' });
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  /* ── 站点适配覆盖 ── */
  if (msg?.type === 'AG_SET_OVERRIDE') {
    setOverride(msg.host, msg.selector).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'AG_CLEAR_OVERRIDE') {
    clearOverride(msg.host).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  return false;
});

/* ───────────────────────── 主分析流 ───────────────────────── */

async function handleAnalyze({ urls = [], sources = [], pageUrl = '', deep = true, answerText = '' }) {
  const settings = await getSettings();
  if (!settings.enabled) return { skipped: true, reason: 'disabled' };

  const uniq = [...new Set(urls)].filter(Boolean);

  // 没有引用但有答案正文 → 纯文本模式（元宝 / 豆包未检索时走这里）
  if (!uniq.length) {
    if (!answerText || answerText.length < 100) {
      return { skipped: true, reason: 'no-citations-and-no-text' };
    }
    const t = scoreAnswerText(answerText);
    return {
      mode: 'text-only',
      textOnly: t,
      pageUrl,
      summary: {
        total: 0,
        flagged: t.flags.filter((f) => f.t !== 'info').length,
        red: t.level.key === 'red' ? 1 : 0,
        distinctDomains: 0,
        hasPrimary: false,
        pollution: t.pollution,
        level: t.level,
        conclusions: t.conclusions,
      },
      citations: [],
      settings: {
        displayLevel: settings.displayLevel,
        minCitations: settings.minCitations,
        deepCheck: false,
      },
    };
  }

  // 两级：deep=false 只做域名级评分（流式生成时用，几十毫秒返回）
  //       deep=true 才真的抓页面（答案稳定后才调用一次）
  const wantDeep = settings.deepCheck && deep !== false;

  // 抓取预算：白名单和一手源不浪费配额，优先抓"看起来可疑"的
  let target = [];
  if (wantDeep) {
    const skip = new Set([...(settings.allowlist || []).map((d) => d.toLowerCase())]);
    const ordered = uniq
      .map((u, i) => ({ u, i, host: safeHost(u) }))
      .filter((x) => x.host && !skip.has(x.host) && !skip.has(regOf(x.host)))
      .sort((a, b) => a.i - b.i);
    target = ordered.slice(0, Math.max(1, settings.maxFetch)).map((x) => x.u);
  }

  const analyses = new Map();

  // 先查缓存
  const need = [];
  for (const u of target) {
    const c = await cacheGet(u);
    if (c) analyses.set(u, c);
    else need.push(u);
  }

  // 限量并发抓取
  const CONCURRENCY = 4;
  const queue = [...need];
  async function worker() {
    while (queue.length) {
      const u = queue.shift();
      if (!u) break;
      let r;
      try {
        r = await analyzePage(u);
      } catch (e) {
        r = {
          url: u, ok: false, err: String(e?.message || e), title: '', textLen: 0,
          simhash: [0, 0], hasAuthor: false, hasDate: false,
          inject: { hits: [], hiddenBlockCount: 0, hiddenTextLen: 0 },
          schema: { hasSchema: false, fakeReviewHints: [] }, httpStatus: 0, ms: 0,
        };
      }
      analyses.set(u, r);
      cacheSet(u, r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));

  const sub = await getSubscription();

  // 摘要来源优先级：外部数据源（代理抓的 rag snippet）> 页面 DOM 抓的
  const snippetMap = new Map();
  for (const src of sources || []) {
    if (src?.url && src?.snippet && src.snippet.length >= 20) {
      snippetMap.set(src.url, src.snippet);
    }
  }

  const external = await fetchExternalSources(settings);
  for (const src of external) {
    if (src?.url && src?.snippet && src.snippet.length >= 20) {
      snippetMap.set(src.url, src.snippet); // 外部覆盖 DOM
    }
  }

  // 模型读过、但平台没展示给用户的来源 —— 这类最能说明问题
  const shownUrls = new Set(uniq);
  const externalOnly = external
    .filter((s) => s?.url && !shownUrls.has(s.url))
    .slice(0, 20)
    .map((s) => ({ url: s.url, host: s.host || safeHost(s.url), snippet: (s.snippet || '').slice(0, 300) }));

  const scored = scoreCitations(uniq, analyses, {
    blocklist: settings.blocklist,
    allowlist: settings.allowlist,
    subscription: sub.domains || [],
    snippets: snippetMap,
  });

  return {
    ...scored,
    pageUrl,
    deep: wantDeep,
    deepChecked: target.length,
    externalUsed: external.length > 0,
    externalOnly,
    settings: {
      displayLevel: settings.displayLevel,
      minCitations: settings.minCitations,
      deepCheck: settings.deepCheck,
    },
  };
}

/**
 * 从本地代理取数服务拿 rag snippet。
 * 超时必须短（1.5s）—— 拿不到就算了，别拖慢正常检测。
 */
async function fetchExternalSources(settings) {
  if (!settings.externalSource) return [];
  const url = settings.externalSourceUrl || 'http://127.0.0.1:8765/recent';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.sources) ? d.sources : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function regOf(host) {
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const multi = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'co.uk',
    'co.jp', 'com.hk', 'com.tw', 'com.au', 'com.sg', 'co.kr', 'com.br', 'co.in'];
  const last2 = parts.slice(-2).join('.');
  return multi.includes(last2) ? parts.slice(-3).join('.') : last2;
}

/* ───────────────────────── 名单维护 ───────────────────────── */

async function addBlocklist(domain) {
  if (!domain) return { ok: false };
  const s = await getSettings();
  const set = new Set(s.blocklist.map((d) => d.toLowerCase()));
  set.add(domain.toLowerCase());
  await chrome.storage.sync.set({ blocklist: [...set] });
  // 顺手从白名单里摘掉
  const allow = new Set(s.allowlist.map((d) => d.toLowerCase()));
  if (allow.delete(domain.toLowerCase())) {
    await chrome.storage.sync.set({ allowlist: [...allow] });
  }
  return { ok: true };
}

async function addAllowlist(domain) {
  if (!domain) return { ok: false };
  const s = await getSettings();
  const set = new Set(s.allowlist.map((d) => d.toLowerCase()));
  set.add(domain.toLowerCase());
  await chrome.storage.sync.set({ allowlist: [...set] });
  const bl = new Set((s.blocklist || []).map((d) => d.toLowerCase()));
  if (bl.delete(domain.toLowerCase())) {
    await chrome.storage.sync.set({ blocklist: [...bl] });
  }
  return { ok: true };
}

/* ───────────────────────── 站点适配覆盖 ───────────────────────── */

async function setOverride(host, selector) {
  if (!host || !selector) return { ok: false, error: '参数不完整' };
  const s = await getSettings();
  const overrides = { ...(s.siteOverrides || {}) };
  overrides[host] = selector;
  await chrome.storage.sync.set({ siteOverrides: overrides });
  return { ok: true, overrides };
}

async function clearOverride(host) {
  const s = await getSettings();
  const overrides = { ...(s.siteOverrides || {}) };
  delete overrides[host];
  await chrome.storage.sync.set({ siteOverrides: overrides });
  return { ok: true, overrides };
}

/* ───────────────────────── 自定义站点注册 ───────────────────────── */

async function syncExtraSites() {
  const s = await getSettings();
  const sites = (s.extraSites || []).filter(Boolean);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['ag-extra'] }).catch(() => {});
    if (!sites.length) return;
    const matches = sites.map((h) => (h.startsWith('*://') ? h : `*://${h}/*`));
    await chrome.scripting.registerContentScripts([
      {
        id: 'ag-extra',
        matches,
        js: ['src/content/content.js'],
        runAt: 'document_idle',
      },
    ]);
  } catch (e) {
    console.warn('[反GEO] 自定义站点注册失败', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS).then((got) => {
    // 首次安装写入默认值，方便用户直接改
    chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...got });
  });
  syncExtraSites();
});

chrome.runtime.onStartup.addListener(() => {
  syncExtraSites();
  maybeAutoRefresh().catch(() => {});
});

// service worker 每次唤醒也检查一次（到 24h 才真的发请求）
maybeAutoRefresh().catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.extraSites) syncExtraSites();
});
