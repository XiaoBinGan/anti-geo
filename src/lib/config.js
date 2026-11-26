/**
 * config.js — 设置与缓存
 */

import { DEFAULT_ALLOWLIST } from './domains.js';

export const DEFAULT_SETTINGS = {
  enabled: true,
  /** 最低展示级别：all | warn（只显示黄红）| bad（只显示红） */
  displayLevel: 'warn',
  /** 是否抓取引用页面做深度核查（关掉=只看域名信号，更快更省） */
  deepCheck: true,
  /** 深度核查最多抓几个页面 */
  maxFetch: 6,
  /** 只在答案引用数 >= 该值时提示 */
  minCitations: 2,
  allowlist: DEFAULT_ALLOWLIST,
  blocklist: [],
  /** 用户自定义要注入的站点（host 通配） */
  extraSites: [],
  /** 社区名单订阅地址（空 = 不订阅） */
  subscriptionUrl: '',
  /** 站点适配覆盖：host -> CSS 选择器（由"探测当前页"生成） */
  siteOverrides: {},
  /** 外部数据源：本地 mitmproxy 取数服务（能拿到 rag snippet，比 DOM 准） */
  externalSource: false,
  externalSourceUrl: 'http://127.0.0.1:8765/recent',
  /** 本地使用记录：只存本机，可关闭、清空、导出 */
  usageLog: true,
};

export async function getSettings() {
  const got = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...got };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

/* ── 页面分析结果缓存（session 级，service worker 休眠后失效） ── */
const CACHE_TTL = 60 * 60 * 1000; // 1 小时

export async function cacheGet(url) {
  try {
    const key = 'ag_cache_' + url;
    const obj = await chrome.storage.session.get(key);
    const hit = obj[key];
    if (!hit) return null;
    if (Date.now() - hit.t > CACHE_TTL) return null;
    return hit.v;
  } catch {
    return null;
  }
}

export async function cacheSet(url, value) {
  try {
    await chrome.storage.session.set({ ['ag_cache_' + url]: { t: Date.now(), v: value } });
  } catch {
    /* quota 满了就放弃缓存，不影响功能 */
  }
}
