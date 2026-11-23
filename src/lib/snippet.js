/**
 * snippet.js — 分析"被喂给模型的那段文本"
 *
 * 为什么单独做这一层：
 *   整页正文 SimHash 抓的是"站点长什么样"，
 *   snippet 抓的是"模型实际读到了什么"。后者才是投毒的落点。
 *
 * 两个来源共用这个模块：
 *   · 插件从 DOM 里扒出来的来源卡片摘要
 *   · mitmproxy 从 SSE/JSON 里解出来的 rag snippet
 */

/* ────────────────────────── 指令型话术 ────────────────────────── */

const INJECT_PATTERNS = [
  {
    re: /(务必|必须|一定要|切记|请|应当|应该|需要)(优先|首先|只)?(推荐|引用|提及|首推|选择|考虑|回答).{0,24}(本|我们|我司|该|这家|上述|此)/g,
    label: '对模型的直接指令',
  },
  {
    re: /(忽略|无视|忘记|跳过|不要理会).{0,12}(之前|以上|上述|前面|此前)?.{0,8}(指令|提示|要求|规则|设定)/g,
    label: '指令覆盖',
  },
  {
    re: /(作为|身为|你是一个?).{0,14}(AI|人工智能|助手|模型|大模型|搜索引擎).{0,14}(你|请|应|需要|必须)/g,
    label: '角色设定',
  },
  {
    re: /(当|如果)(用户|有人|读者).{0,14}(询问|问到|问起|搜索).{0,20}(请|应|必须|务必).{0,20}(回答|推荐|回复)/g,
    label: '预置应答',
  },
  {
    re: /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    label: '指令覆盖(英)',
  },
  {
    re: /(you\s+are\s+now|act\s+as\s+(a|an|the)|from\s+now\s+on\s+you)/gi,
    label: '角色设定(英)',
  },
  {
    re: /(always|must|only)\s+(recommend|cite|mention|answer\s+with|suggest)\s+(us|our|this)/gi,
    label: '强制推荐(英)',
  },
  {
    re: /(as\s+an?\s+(AI|assistant|language\s+model))[^.]{0,80}(should|must|recommend)/gi,
    label: '角色设定(英)',
  },
];

/* ────────────────────────── 商业诱导 ────────────────────────── */

const PROMO_TERMS = [
  '推荐', '首选', '首推', '优选', '值得信赖', '口碑', '领先', '权威', '专业',
  '靠谱', '放心', '保障', '正品', '官方授权', '销量第一', '排名第一', '行业第一',
  '全国第一', '榜首', '排名首位', '性价比之王', '强烈推荐', '首选合作伙伴',
  '不二之选', 'top', 'best', 'leading', 'trusted', 'authorized', 'number one',
];

// 自我宣称（官网首页常见，单独不足以定罪）
const PROMO_SELF = [
  /(排名|销量|口碑|实力|综合)(第一|首位|榜首|冠军|领先)/g,
  /(行业标杆|标杆企业|领军企业|龙头企业)/g,
  /(值得信赖|值得选择|品质保障|官方授权|正品保障)/g,
];

// 第三方背书口吻（"强烈推荐""首选合作伙伴"）—— 测评稿的口吻，才是投毒特征
const PROMO_ENDORSE = [
  /(强烈推荐|首推|首选合作伙伴|不二之选|性价比之王|最佳选择|首选品牌)/g,
  /(我们推荐|建议优先选择|优先考虑该)/g,
  /(highly\s+recommend|top\s+choice|best\s+pick)/gi,
];

/* ────────────────────────── 内容农场八股 ────────────────────────── */

const BOILERPLATE = [
  /首先[，,]/g, /其次[，,]/g, /再次[，,]/g, /最后[，,]/g,
  /综上所述/g, /总的来说/g, /值得一提的是/g, /不难看出/g, /由此可见/g,
  /在当今(数字化|信息|竞争)?(时代|社会)/g, /随着.{0,8}(发展|普及|提升)/g,
  /本文将从.{0,20}(维度|方面|角度)/g, /深度解析/g, /全面解析/g,
  /firstly/gi, /secondly/gi, /in\s+conclusion/gi, /it\s+is\s+worth\s+noting/gi,
];

/* ────────────────────────── 主函数 ────────────────────────── */

/**
 * @param {string} text 被喂给模型的文本片段
 * @returns {{len:number, injectHits:Array, promoScore:number, promoHeavy:number,
 *            boilerplateScore:number, flags:Array, snippetHash:string}}
 */
export function analyzeSnippet(text) {
  const out = {
    len: 0,
    injectHits: [],
    promoScore: 0,
    promoSelf: 0,
    promoEndorse: 0,
    boilerplateScore: 0,
    flags: [],
    snippetHash: '',
  };

  if (!text || typeof text !== 'string') return out;

  const t = text.replace(/\s+/g, ' ').trim();
  out.len = t.length;
  if (out.len < 20) return out;

  // ① 指令型话术 —— 最强信号
  for (const p of INJECT_PATTERNS) {
    p.re.lastIndex = 0;
    const m = p.re.exec(t);
    if (m) out.injectHits.push({ label: p.label, sample: m[0].slice(0, 100) });
  }

  if (out.injectHits.length) {
    out.flags.push({
      t: 'bad',
      text: `喂给模型的摘要里含指令型话术（${[...new Set(out.injectHits.map((h) => h.label))].join('、')}）`,
      detail: out.injectHits.map((h) => `「${h.sample}」`).join('\n'),
    });
  }

  // ② 商业诱导密度
  let promoCount = 0;
  const lower = t.toLowerCase();
  for (const term of PROMO_TERMS) {
    if (lower.includes(term)) promoCount++;
  }

  let selfCount = 0;
  for (const re of PROMO_SELF) {
    re.lastIndex = 0;
    const m = t.match(re);
    if (m) selfCount += m.length;
  }

  let endorseCount = 0;
  for (const re of PROMO_ENDORSE) {
    re.lastIndex = 0;
    const m = t.match(re);
    if (m) endorseCount += m.length;
  }

  out.promoSelf = selfCount;
  out.promoEndorse = endorseCount;

  // 归一化：每 100 字出现几个诱导词
  const per100 = (promoCount / Math.max(t.length, 1)) * 100;
  out.promoScore = Math.min(1, per100 / 3 + Math.min(selfCount + endorseCount * 2, 9) / 9);

  if (endorseCount >= 2) {
    out.flags.push({
      t: 'bad',
      text: `摘要用了 ${endorseCount} 次第三方背书口吻（强烈推荐 / 首选合作伙伴），这是测评稿而非事实陈述`,
    });
  } else if (endorseCount >= 1 && selfCount >= 2) {
    out.flags.push({ t: 'warn', text: '摘要同时出现自我宣称和推荐口吻' });
  } else if (out.promoScore >= 0.7) {
    out.flags.push({ t: 'warn', text: '摘要的商业诱导密度偏高' });
  }

  // ③ 内容农场八股
  let bpCount = 0;
  for (const re of BOILERPLATE) {
    re.lastIndex = 0;
    const m = t.match(re);
    if (m) bpCount += m.length;
  }
  // 每 100 字有几个八股标记
  out.boilerplateScore = Math.min(1, ((bpCount / Math.max(t.length, 1)) * 100) / 2.2);

  if (out.boilerplateScore >= 0.75) {
    out.flags.push({ t: 'warn', text: '八股式行文（首先/其次/综上），内容农场的典型结构' });
  }

  return out;
}

/**
 * 找出"一字不差"的 snippet 组。
 * 三个互不相关的站点给模型喂了完全相同的摘要 —— 这比整页相似更硬：
 * 说明摘要本身就是批量复制的，模型读到的是同一段话。
 *
 * @param {Array<{url:string, hash:string}>} items
 * @returns {Map<string, {count:number, peers:string[]}>}
 */
export function identicalSnippetGroups(items) {
  const byHash = new Map();
  for (const it of items) {
    if (!it?.hash) continue;
    if (!byHash.has(it.hash)) byHash.set(it.hash, []);
    byHash.get(it.hash).push(it.url);
  }

  const out = new Map();
  for (const [, urls] of byHash) {
    if (urls.length < 2) continue;
    for (const u of urls) {
      out.set(u, { count: urls.length - 1, peers: urls.filter((x) => x !== u) });
    }
  }
  return out;
}
