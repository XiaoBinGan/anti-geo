/**
 * community.js — 订阅名单（共享免疫）
 *
 * 思路：单机能看到的证据是局部的，但"这个域名是内容农场"这件事是全局的。
 * 于是让大家交换的只是**域名清单**，不交换任何个人数据：
 *   - 不采集你问了什么
 *   - 不采集你看了哪个答案
 *   - 不采集你的任何标识
 *   - 只发一个 URL 去 GET 一份公开 JSON
 *
 * 名单格式（v1）：
 * {
 *   "version": 1,
 *   "updated": "2026-11-20",
 *   "name": "社区可疑来源名单",
 *   "domains": [
 *     { "d": "example-farm.com", "reason": "contentfarm", "score": 55 },
 *     { "d": "example-clinic.top", "reason": "astroturf",   "score": 60 }
 *   ]
 * }
 *
 * 也接受最简形式： ["a.com", "b.com"]
 */

const STORAGE_KEY = 'ag_subscription';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 一天

/** 订阅名单的默认扣分权重：低于你自己手动标的（60），因为外来的没那么可信 */
export const SUBSCRIPTION_WEIGHT = 45;

/** 只接受规规矩矩的注册域，防远端 JSON 塞奇怪内容 */
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63}(?<!-))+$/i;

export function isSafeDomain(d) {
  return typeof d === 'string' && d.length <= 253 && DOMAIN_RE.test(d);
}

/** 把各种可能的输入格式统一成 [{d, reason, score}] */
export function normalizeList(raw) {
  if (!raw) return [];
  let arr = null;

  if (Array.isArray(raw)) arr = raw;
  else if (Array.isArray(raw.domains)) arr = raw.domains;
  else return [];

  const out = [];
  const seen = new Set();

  for (const item of arr) {
    let d = null;
    let reason = '';
    let score = SUBSCRIPTION_WEIGHT;

    if (typeof item === 'string') {
      d = item;
    } else if (item && typeof item === 'object') {
      d = item.d ?? item.domain ?? item.host;
      reason = typeof item.reason === 'string' ? item.reason.slice(0, 40) : '';
      if (Number.isFinite(item.score)) score = Math.max(0, Math.min(100, item.score));
    }

    if (!d) continue;
    d = String(d).trim().toLowerCase().replace(/^www\./, '');
    if (!isSafeDomain(d)) continue;
    if (seen.has(d)) continue;
    seen.add(d);
    out.push({ d, reason, score });
  }
  return out;
}

/* ─────────────────────── 存储 ─────────────────────── */

export async function getSubscription() {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const v = got[STORAGE_KEY];
    if (!v) return { url: '', fetchedAt: 0, domains: [], name: '', error: '' };
    return v;
  } catch {
    return { url: '', fetchedAt: 0, domains: [], name: '', error: '' };
  }
}

async function setSubscription(v) {
  await chrome.storage.local.set({ [STORAGE_KEY]: v });
}

/** 拉取并落库。返回 {ok, count, error} */
export async function refreshSubscription(url, { force = false } = {}) {
  if (!url) {
    await setSubscription({ url: '', fetchedAt: 0, domains: [], name: '', error: '' });
    return { ok: true, count: 0, error: '' };
  }

  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, count: 0, error: '地址必须以 http(s):// 开头' };
  }

  const cur = await getSubscription();
  if (!force && cur.url === url && Date.now() - cur.fetchedAt < REFRESH_INTERVAL) {
    return { ok: true, count: cur.domains.length, error: '', cached: true };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);

  try {
    const resp = await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const raw = await resp.json();
    const domains = normalizeList(raw);

    if (!domains.length && raw) {
      throw new Error('名单格式无法识别（需要 {"domains":[...]} 或 ["a.com"]）');
    }

    const payload = {
      url,
      fetchedAt: Date.now(),
      domains,
      name: typeof raw?.name === 'string' ? raw.name.slice(0, 60) : '',
      updated: typeof raw?.updated === 'string' ? raw.updated.slice(0, 30) : '',
      error: '',
    };
    await setSubscription(payload);
    return { ok: true, count: domains.length, error: '' };
  } catch (e) {
    const err = e.name === 'AbortError' ? '拉取超时' : String(e?.message || e);
    // 拉取失败不清空旧名单，留着继续用
    await setSubscription({ ...cur, url, error: err });
    return { ok: false, count: cur.domains.length, error: err };
  } finally {
    clearTimeout(timer);
  }
}

/** 后台定时刷新（到点了才拉，不会每次启动都打） */
export async function maybeAutoRefresh() {
  const cur = await getSubscription();
  if (!cur.url) return;
  if (Date.now() - cur.fetchedAt < REFRESH_INTERVAL) return;
  await refreshSubscription(cur.url, { force: true });
}

/* ─────────────────────── 导入 / 导出 ─────────────────────── */

/** 把用户自己的标记导出成社区可交换格式 */
export function buildExport({ blocklist = [], allowlist = [], subscription = null }) {
  return {
    version: 1,
    updated: new Date().toISOString().slice(0, 10),
    name: '导出的来源名单',
    generatedBy: 'anti-geo',
    domains: blocklist
      .filter(isSafeDomain)
      .map((d) => ({ d, reason: 'user-marked', score: 60 })),
    allow: allowlist.filter(isSafeDomain),
    imported: subscription?.domains?.length ?? 0,
  };
}
