/**
 * simhash.js — 64 位 SimHash 指纹 + 汉明距离
 *
 * 用途：判断被引用的多个页面是不是"同一个模板批量生成"的站群。
 * 纯前端可算，不需要历史图谱 —— 这是本插件能无后端运行的关键。
 */

/**
 * 分词：中文按 2-gram 字符切片，英文按词。
 * 混排文本（中文站常见）也能处理。
 */
export function tokenize(text) {
  if (!text) return [];
  const t = String(text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ');

  const out = [];
  for (const word of t.split(' ')) {
    if (!word) continue;
    if (/[\u3400-\u9fff]/.test(word)) {
      if (word.length === 1) {
        out.push(word);
      } else {
        // 中文按 2-gram 效果最好：单字太泛，3-gram 太稀疏
        for (let i = 0; i + 2 <= word.length; i++) out.push(word.slice(i, i + 2));
      }
    } else if (word.length >= 2) {
      out.push(word);
    }
  }
  return out;
}

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function popcount32(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

/**
 * 返回 [hi, lo] 两个 32 位无符号数，拼成 64 位指纹。
 */
export function simhash64(text) {
  const toks = tokenize(text);
  if (!toks.length) return [0, 0];

  const v = new Float64Array(64);
  for (const tk of toks) {
    const a = fnv1a(tk, 0x811c9dc5);
    const b = fnv1a(tk, 0x01000193);
    for (let i = 0; i < 32; i++) {
      v[i] += (a >>> i) & 1 ? 1 : -1;
      v[32 + i] += (b >>> i) & 1 ? 1 : -1;
    }
  }

  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 32; i++) {
    if (v[i] > 0) lo |= 1 << i;
    if (v[32 + i] > 0) hi |= 1 << i;
  }
  return [hi >>> 0, lo >>> 0];
}

/** 汉明距离，0 = 几乎完全相同 */
export function hamming(a, b) {
  if (!a || !b) return 64;
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

/** 相似度 0-1，便于展示 */
export function similarity(a, b) {
  return 1 - hamming(a, b) / 64;
}
