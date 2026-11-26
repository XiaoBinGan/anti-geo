/**
 * usage.js — 本地使用日志
 *
 * 为什么需要它：
 *   插件跑在用户机器上，开发者看不到任何表现。哪些站点适配失效、
 *   哪些容器选错、哪些是真投毒哪些是误报 —— 全都没有数据。
 *   这一路 6 个 bug 全靠手工贴探针输出才发现，不可持续。
 *
 * 隐私边界（硬性）：
 *   · 只存主机名，不存完整 URL
 *   · 不存页面正文、不存用户输入
 *   · 不存任何标识符
 *   · 只写 chrome.storage.local（不出本机）
 *   · 默认开启，可一键关闭与清空
 *   · 只有用户主动点「导出」才会生成文件
 */

const KEY = 'ag_usage';
const MAX_RECORDS = 300;

export const USAGE_DEFAULT = {
  usageLog: true, // 是否记录
};

/* ─────────────────────── 写入 ─────────────────────── */

/**
 * @param {object} rec 一条诊断记录
 *   ts            时间戳
 *   host          站点主机名
 *   platform      适配器名（或主机名）
 *   mode          'citations' | 'text-only' | 'none'
 *   cites         引用数
 *   distinct      独立站点数
 *   flagged       可疑数
 *   red           硬证据数
 *   pollution     污染度
 *   adapterHit    是否命中内置适配器
 *   overrideHit   是否用了用户探测的选择器
 *   fallback      是否走了"最大正文块"兜底
 *   containerCls  选中的容器 class（截断）
 *   deepChecked   深度核查页数
 *   ms            耗时
 *   err           错误信息
 */
export async function recordUsage(rec) {
  try {
    const got = await chrome.storage.local.get(KEY);
    const log = Array.isArray(got[KEY]) ? got[KEY] : [];

    // 同站点 60 秒内只记一条，避免流式生成刷屏
    const last = log[log.length - 1];
    if (
      last &&
      last.host === rec.host &&
      Math.abs((rec.ts || Date.now()) - (last.ts || 0)) < 60_000 &&
      last.mode === rec.mode &&
      last.cites === rec.cites
    ) {
      // 只更新计数
      last.hits = (last.hits || 1) + 1;
      last.ts = rec.ts || Date.now();
    } else {
      log.push({ ...rec, hits: 1 });
    }

    // 环形缓冲
    const trimmed = log.slice(-MAX_RECORDS);
    await chrome.storage.local.set({ [KEY]: trimmed });
  } catch {
    /* 存储满或权限问题都不该影响检测 */
  }
}

/* ─────────────────────── 读取与统计 ─────────────────────── */

export async function getUsage() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return Array.isArray(got[KEY]) ? got[KEY] : [];
  } catch {
    return [];
  }
}

export async function clearUsage() {
  try {
    await chrome.storage.local.remove(KEY);
  } catch {}
}

/**
 * 汇总成人类可读的统计。
 * 目标：让用户在导出前就能看到"问题在哪"，也方便我一眼判断。
 */
export function summarize(records) {
  const out = {
    total: 0,
    byHost: {},
    failures: [],   // 找不到容器 / 引用为 0 的站点
    textOnly: [],   // 只能做文本分析的站点
    suspicious: [], // 检测出问题的站点
    errors: [],
    pollutionBuckets: { green: 0, yellow: 0, red: 0 },
  };
  if (!Array.isArray(records) || !records.length) return out;

  out.total = records.reduce((a, r) => a + (r.hits || 1), 0);

  for (const r of records) {
    const h = r.host || 'unknown';
    const n = r.hits || 1;

    if (!out.byHost[h]) {
      out.byHost[h] = {
        host: h,
        platform: r.platform || '',
        runs: 0,
        cites: 0,
        maxPollution: 0,
        containerMissing: 0,
        textOnly: 0,
        fallback: 0,
        lastTs: 0,
      };
    }
    const b = out.byHost[h];
    b.runs += n;
    b.cites = Math.max(b.cites, r.cites || 0);
    b.maxPollution = Math.max(b.maxPollution, r.pollution || 0);
    if (r.mode === 'none' || (!r.containerCls && !r.fallback)) b.containerMissing += n;
    if (r.mode === 'text-only') b.textOnly += n;
    if (r.fallback) b.fallback += n;
    b.lastTs = Math.max(b.lastTs, r.ts || 0);

    if (r.err) out.errors.push({ host: h, err: String(r.err).slice(0, 120), ts: r.ts });

    if (r.pollution >= 55) out.pollutionBuckets.red += n;
    else if (r.pollution >= 25) out.pollutionBuckets.yellow += n;
    else out.pollutionBuckets.green += n;

    if (r.red > 0 || r.flagged > 0) {
      out.suspicious.push({
        host: h,
        cites: r.cites,
        flagged: r.flagged,
        red: r.red,
        pollution: r.pollution,
        ts: r.ts,
      });
    }
  }

  // 只保留需要关注的
  for (const b of Object.values(out.byHost)) {
    if (b.containerMissing >= 2 && b.cites === 0) {
      out.failures.push({ host: b.host, runs: b.runs, lastTs: b.lastTs });
    }
    // 纯文本模式只要出现过一次就值得记录 —— 说明该平台在 DOM 层不暴露来源
    if (b.textOnly >= 1) {
      out.textOnly.push({ host: b.host, runs: b.runs, textOnly: b.textOnly });
    }
  }

  out.failures.sort((a, b) => b.runs - a.runs);
  out.textOnly.sort((a, b) => b.textOnly - a.textOnly);
  out.suspicious.sort((a, b) => (b.pollution || 0) - (a.pollution || 0));
  out.errors = out.errors.slice(-20);

  return out;
}

/**
 * 生成导出包。
 * 结构刻意做成"我拿到就能直接改代码"的样子：每个主机一行诊断。
 */
export function buildExport(records, meta = {}) {
  const sum = summarize(records);
  return {
    format: 'anti-geo/usage-v1',
    exportedAt: new Date().toISOString(),
    version: meta.version || '',
    summary: {
      totalRuns: sum.total,
      hosts: Object.keys(sum.byHost).length,
      pollution: sum.pollutionBuckets,
      containerFailures: sum.failures.map((f) => f.host),
      textOnlyHosts: sum.textOnly.map((t) => t.host),
    },
    perHost: Object.values(sum.byHost).sort((a, b) => b.runs - a.runs),
    suspicious: sum.suspicious.slice(0, 50),
    errors: sum.errors,
    records, // 原始记录，保留细节
  };
}
