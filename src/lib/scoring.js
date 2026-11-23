/**
 * scoring.js — 把单页信号 + 答案内跨引用信号，合成可解释的污染分
 *
 * 设计原则：
 *   1. 每个扣分项都必须能说出人话，用户不信黑盒分数。
 *   2. 单一证据不给死刑，多个弱信号叠加才判红（降低误伤）。
 *   3. 分数是"这条引用有多可疑"，不是"这个品牌在作弊"。
 */

import { hamming } from './simhash.js';
import {
  registrableDomain,
  normalizeHost,
  isPrimarySource,
  domainShapeScore,
} from './domains.js';
import { analyzeSnippet, identicalSnippetGroups } from './snippet.js';

export const LEVELS = {
  green: { key: 'green', label: '低风险', color: '#16a34a' },
  yellow: { key: 'yellow', label: '存疑', color: '#d97706' },
  red: { key: 'red', label: '高风险', color: '#dc2626' },
};

function levelOf(score) {
  if (score >= 55) return LEVELS.red;
  if (score >= 25) return LEVELS.yellow;
  return LEVELS.green;
}

/**
 * @param {string[]} citationUrls  AI 答案里出现的引用 URL（已去重）
 * @param {Map<string,object>} analyses  url -> analyzePage 结果
 * @param {object} opts
 *   opts.blocklist    : string[]  你自己标记的可疑注册域（权重 60）
 *   opts.subscription : Array<{d,reason,score}>  订阅的社区名单（权重默认 45）
 *   opts.allowlist    : string[]  白名单（分数打到 20%）
 *   opts.snippets     : Map<string,string>  url -> 被喂给模型/展示给用户的摘要片段
 */
export function scoreCitations(citationUrls, analyses, opts = {}) {
  // 三级名单：
  //   userBlock — 你自己标的，权重最高（60）
  //   subBlock  — 订阅来的，权重次之（默认 45），因为别人的判断可能过时或有误
  //   allowlist — 白名单，直接把分数打到 20%
  const userBlock = new Set((opts.blocklist || []).map((d) => String(d).toLowerCase()));
  const subBlock = new Map();
  for (const item of opts.subscription || []) {
    const d = typeof item === 'string' ? item : item?.d;
    if (!d) continue;
    const score = typeof item === 'object' && Number.isFinite(item.score) ? item.score : 45;
    const reason = typeof item === 'object' && item.reason ? item.reason : '';
    subBlock.set(String(d).toLowerCase(), { score: Math.max(0, Math.min(100, score)), reason });
  }
  const allowlist = new Set((opts.allowlist || []).map((d) => String(d).toLowerCase()));
  const snippets = opts.snippets || null;

  // ── 第一遍：整理基础信息 ──
  const items = citationUrls.map((url) => {
    const host = normalizeHost(url);
    const reg = registrableDomain(host);
    const a = analyses.get(url) || null;
    const userHit = userBlock.has(reg) || userBlock.has(host);
    const subHit = subBlock.get(reg) || subBlock.get(host) || null;
    const snipText = snippets ? snippets.get(url) || '' : '';
    const snipInfo = snipText && snipText.length >= 20 ? analyzeSnippet(snipText) : null;
    return {
      url,
      host,
      reg,
      analysis: a,
      flags: [],
      score: 0,
      isPrimary: isPrimarySource(host),
      allowlisted: allowlist.has(reg) || allowlist.has(host),
      blocked: userHit || !!subHit,
      blockSource: userHit ? 'user' : subHit ? 'subscription' : '',
      subInfo: subHit,
      snippet: snipText,
      snipInfo,
    };
  });

  const regCount = new Map();
  for (const it of items) regCount.set(it.reg, (regCount.get(it.reg) || 0) + 1);

  // ── 预计算：正文相似矩阵（n ≤ 12，O(n²) 无压力） ──
  // 站群判定的经典条件是"≥3 个独立站点同模板"。
  // 只有 2 个站点同模板时，更可能是通稿转载，降权处理。
  const nearDup = items.map(() => ({ count: 0, bestD: 64, bestHost: '', bestReg: '' }));
  for (let i = 0; i < items.length; i++) {
    const a = items[i].analysis;
    if (!a?.ok || a.textLen <= 400) continue;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const b = items[j].analysis;
      if (!b?.ok || b.textLen <= 400) continue;
      if (items[i].reg === items[j].reg) continue; // 同站内页不算
      const d = hamming(a.simhash, b.simhash);
      if (d <= 12) {
        nearDup[i].count++;
        if (d < nearDup[i].bestD) {
          nearDup[i].bestD = d;
          nearDup[i].bestHost = items[j].host;
          nearDup[i].bestReg = items[j].reg;
        }
      }
    }
  }

  // ── 预计算：一字不差的 snippet 分组 ──
  // 三个互不相关的站点给模型喂了完全相同的摘要 → 摘要本身就是批量复制的
  const normSnip = (t) => String(t || '').replace(/\s+/g, '').slice(0, 240);
  const snipHashes = items
    .filter((it) => it.snippet && it.snippet.length >= 20)
    .map((it) => ({ url: it.url, hash: normSnip(it.snippet) }));
  const dupSnip = identicalSnippetGroups(snipHashes);

  // ── 第二遍：逐条打分 ──
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const a = it.analysis;
    let s = 0;

    // 1) 命中可疑名单（自己标的 > 订阅来的）
    if (it.blockSource === 'user') {
      s += 60;
      it.flags.push({ t: 'bad', text: '该域名在你自己维护的可疑来源名单中' });
    } else if (it.blockSource === 'subscription') {
      s += it.subInfo?.score ?? 45;
      it.flags.push({
        t: 'bad',
        text: '该域名在订阅的社区可疑来源名单中' + (it.subInfo?.reason ? `（${it.subInfo.reason}）` : ''),
      });
    }

    // 2) 隐藏指令注入 —— 最硬的证据，直接接近封顶
    if (a?.ok && a.inject?.hits?.length) {
      const n = a.inject.hits.length;
      s += 55;
      it.flags.push({
        t: 'bad',
        text: `页面里藏了给 AI 看的指令（${a.inject.hits.map((h) => h.label).join('、')}）`,
        detail: a.inject.hits.map((h) => `「${h.sample}」`).join('\n'),
      });
    }

    // 2.5) snippet 层 —— 模型实际读到的摘要里就有问题
    const sn = it.snipInfo;
    if (sn) {
      if (sn.injectHits.length) {
        s += 45;
        it.flags.push({
          t: 'bad',
          text: `平台喂给模型的摘要里含指令型话术（${[...new Set(sn.injectHits.map((h) => h.label))].join('、')}）`,
          detail: sn.injectHits.map((h) => `「${h.sample}」`).join('\n'),
        });
      } else if (sn.promoEndorse >= 2) {
        s += 25;
        it.flags.push({
          t: 'bad',
          text: `摘要用了 ${sn.promoEndorse} 次第三方背书口吻（强烈推荐 / 首选合作伙伴）`,
        });
      }
      if (sn.boilerplateScore >= 0.75) {
        s += 10;
        it.flags.push({ t: 'warn', text: '摘要行文是内容农场八股（首先/其次/综上）' });
      }
    }

    // 3) 同域重复引用
    //    注意：AI 搜索一次返回同站多个页面是常态（实测智谱单次答案里 maigoo 出现 12 次），
    //    所以只在极端聚集时才计分，且权重要低 —— 否则大面积误报。
    const dup = regCount.get(it.reg) || 1;
    if (dup >= 5) {
      s += 8;
      it.flags.push({ t: 'warn', text: `同一站点被检索命中 ${dup} 个页面，占比偏高` });
    } else if (dup >= 3) {
      it.flags.push({ t: 'info', text: `同一站点被检索命中 ${dup} 个页面` });
    }

    // 4) 跨引用模板相似 —— 站群在单次答案内的可判定形态
    const nd = nearDup[i];
    if (nd.count >= 2) {
      // ≥3 个独立站点正文几乎同模板：这是站群批量生成的强证据
      s += 50;
      it.flags.push({
        t: 'bad',
        text: `正文与另外 ${nd.count} 个站点的页面几乎完全相同（最高相似度 ${((1 - nd.bestD / 64) * 100).toFixed(0)}%），是同一模板批量生成`,
        detail: `对照：${nd.bestHost}`,
      });
    } else if (nd.count === 1) {
      // 只有 2 个站点同模板：可能是通稿转载，只作参考
      s += 12;
      it.flags.push({
        t: 'warn',
        text: `正文与另一站点高度相似（${((1 - nd.bestD / 64) * 100).toFixed(0)}%），可能是同模板或转载`,
        detail: `对照：${nd.bestHost}`,
      });
    }

    // 4.5) 摘要一字不差 —— 比整页相似更硬
    const dupS = dupSnip.get(it.url);
    if (dupS && dupS.count >= 2) {
      s += 40;
      it.flags.push({
        t: 'bad',
        text: `提供给模型的摘要与另外 ${dupS.count} 个站点的摘要一字不差`,
        detail: '对照：' + dupS.peers.map((u) => {
          try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
        }).join('、'),
      });
    } else if (dupS && dupS.count === 1) {
      s += 15;
      it.flags.push({ t: 'warn', text: '摘要与另一个站点完全相同，可能是同源复制' });
    }

    // 5) 域名形态
    const shape = domainShapeScore(it.host);
    if (shape.score >= 0.25) {
      s += Math.round(shape.score * 18);
      it.flags.push({ t: 'warn', text: `域名形态可疑：${shape.flags.join('，')}` });
    }

    // 6) 内容质量
    if (a?.ok) {
      if (a.textLen < 300) {
        s += 8;
        it.flags.push({ t: 'warn', text: `正文极短（${a.textLen} 字），内容农场特征` });
      }
      if (!a.hasAuthor) {
        s += 4;
        it.flags.push({ t: 'info', text: '无作者署名' });
      }
      if (!a.hasDate) {
        s += 3;
        it.flags.push({ t: 'info', text: '无发布时间' });
      }
      if (a.schema?.fakeReviewHints?.length) {
        s += 8;
        it.flags.push({ t: 'warn', text: a.schema.fakeReviewHints.join('；') });
      }
    } else if (a && !a.ok) {
      it.flags.push({ t: 'info', text: `页面无法读取（${a.err}），未能核查` });
    }

    // 白名单直接把分数打回安全区
    if (it.allowlisted) {
      s = Math.round(s * 0.2);
      it.flags.unshift({ t: 'good', text: '在可信白名单中' });
    }

    // 单一弱信号不判黄：只有一条 warn 且没有任何硬证据时，压在绿区。
    // 这条是"可用性"的关键 —— 否则大量正常站点会因为「无作者/无日期」被误标。
    const hardHits = it.flags.filter((f) => f.t === 'bad').length;
    const warnHits = it.flags.filter((f) => f.t === 'warn').length;
    if (hardHits === 0 && warnHits <= 1) s = Math.min(s, 24);

    it.score = Math.max(0, Math.min(100, s));
    it.level = levelOf(it.score);
  }

  // ── 第三遍：答案级汇总 ──
  const n = items.length;
  const flagged = items.filter((it) => it.score >= 25).length;
  const red = items.filter((it) => it.score >= 55).length;
  const hasPrimary = items.some((it) => it.isPrimary);

  const distinctRegs = new Set(items.map((it) => it.reg)).size;
  const avg = n ? items.reduce((acc, it) => acc + it.score, 0) / n : 0;

  let pollution = Math.round(avg * 0.65 + (n ? (flagged / n) * 45 : 0));
  if (n >= 3 && distinctRegs <= 2) pollution += 18;
  if (n >= 3 && !hasPrimary) pollution += 10;
  if (red >= 2) pollution += 10;
  pollution = Math.max(0, Math.min(100, pollution));

  // 生成的结论句：要像人说的话
  const conclusions = [];
  if (red >= 1) {
    conclusions.push(`${red} 条引用命中了硬性投毒证据（隐藏指令注入 / 站群模板 / 可疑名单）`);
  }
  if (flagged > 0 && red === 0) {
    conclusions.push(`${flagged} 条引用存在多项可疑特征`);
  }
  if (n >= 3 && distinctRegs <= 2) {
    conclusions.push(`答案的 ${n} 条引用集中在 ${distinctRegs} 个站点，来源过于单一`);
  }
  if (n >= 3 && !hasPrimary) {
    conclusions.push('全部是二手聚合内容，没有一手来源（官方 / 政府 / 学术）支撑');
  }
  if (!conclusions.length) {
    conclusions.push('引用来源分散，未发现明显投毒特征');
  }

  return {
    citations: items,
    summary: {
      total: n,
      flagged,
      red,
      distinctDomains: distinctRegs,
      hasPrimary,
      pollution,
      level: levelOf(pollution),
      conclusions,
    },
  };
}


/* ══════════════════════════════════════════════════════════════
 * 纯文本模式 —— 平台不给来源时（元宝 / 豆包未检索时）的唯一兜底
 *
 * 拿不到引用 URL，就没法做域名分析。但答案是模型吐出来的正文，
 * 里面照样能看出投毒的语言特征：指令话术、第三方背书口吻、八股结构。
 * 价值不如引用分析，但聊胜于投放，且绝不误判 —— 没有域名证据就不给红。
 * ══════════════════════════════════════════════════════════════ */
export function scoreAnswerText(text) {
  const out = {
    mode: 'text-only',
    textLen: 0,
    pollution: 0,
    level: LEVELS.green,
    flags: [],
    conclusions: [],
  };
  if (!text || typeof text !== 'string') return out;

  const t = text.replace(/\s+/g, ' ').trim();
  out.textLen = t.length;
  if (t.length < 30) return out;

  const sn = analyzeSnippet(t);
  let s = 0;

  if (sn.injectHits.length) {
    s += 45;
    out.flags.push({
      t: 'bad',
      text: `答案正文里含指令型话术（${[...new Set(sn.injectHits.map((h) => h.label))].join('、')}）`,
      detail: sn.injectHits.map((h) => `「${h.sample}」`).join('\n'),
    });
  }
  if (sn.promoEndorse >= 2) {
    s += 25;
    out.flags.push({
      t: 'warn',
      text: `答案里出现 ${sn.promoEndorse} 次第三方背书口吻（强烈推荐 / 首选合作伙伴）`,
    });
  }
  if (sn.boilerplateScore >= 0.75) {
    s += 10;
    out.flags.push({ t: 'warn', text: '答案是内容农场八股结构（首先/其次/综上）' });
  }

  // 纯文本模式最多判黄：没有域名证据，不下"投毒"结论
  if (out.flags.some((f) => f.t === 'bad') && sn.injectHits.length) {
    // 只有明确的指令注入才允许判红
    out.level = LEVELS.red;
  } else if (s >= 20) {
    out.level = LEVELS.yellow;
  } else {
    out.level = LEVELS.green;
  }

  out.pollution = Math.min(100, s);

  if (!out.flags.length) {
    out.conclusions.push('这个平台没有展示引用来源，只做了正文措辞分析，未发现明显投毒话术');
  } else {
    out.conclusions.push('这个平台没有展示引用来源，以下结论仅基于答案正文的措辞');
  }
  out.conclusions.push('无法核查引用域名 —— 想查来源需要用代理抓取平台返回的数据');

  return out;
}
