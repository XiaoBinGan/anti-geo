# 贡献指南

## 最有价值的贡献：加一个平台

插件的容器发现是**反向定位**（从外链向上找公共祖先），所以大多数平台零配置就能用。但每个平台的引用结构不同，实测过的才算可靠。

加一个平台大约三步，十分钟：

### 1. 抓一份真实结构

在目标平台的对话页问一个**会触发检索**的问题（例如「2026年XX排名前十，请联网搜索并列出参考来源」），等答案出完，然后：

```bash
cat tools/dom-probe.js | pbcopy    # macOS，其他系统用 clip/xclip
```

`F12` → Console → 粘贴 → 回车。结果自动进剪贴板。

### 2. 看探针输出

```json
{
  "extAnchors": 6,
  "candidates": [
    { "selector": "div.markdown", "ext": 6, "textLen": 940, "paragraphs": 9, "pluginsPick": true }
  ],
  "anchorShapes": [
    { "href": "https://...", "occurrences": 1, "shapes": [{ "path": "div.pua-ref-renderer < div.paragraph" }] }
  ]
}
```

`pluginsPick: true` 的就是插件当前会选的容器。**先看它选对没有**——如果选错了，说明选择逻辑需要改进，这比加适配器更重要。

### 3. 写适配器

在 [src/content/content.js](src/content/content.js) 的 `ADAPTERS` 里加一项：

```js
{
  host: ['your-site.com'],
  name: '你的平台',
  answerSelectors: ['.markdown', '[class*="answer-body"]'],
  // scopeFilter: (el) => /AI/.test(el.textContent),  // 只在特定区域生效
}
```

同时在 `manifest.json` 的 `content_scripts.matches` 里加 `https://your-site.com/*`。

**记得在注释里写实测日期和观察到的结构**，否则半年后没人知道为什么这么写。

### 4. 补一条回归测试

如果结构有代表性，把探针输出存成 `test/fixtures/real-<平台>.json`，在 [test/real-snapshot.test.mjs](test/real-snapshot.test.mjs) 加一个用例。这样平台改版时测试会先挂，而不是用户先发现。

## 其他贡献

| 类型 | 从哪下手 |
|---|---|
| 检测规则 | [src/lib/snippet.js](src/lib/snippet.js) 的话术正则、[src/lib/domains.js](src/lib/domains.js) 的域名特征 |
| 评分权重 | [src/lib/scoring.js](src/lib/scoring.js)，每项都对应一句人话，改完记得跑测试 |
| 性能 | 目前大页面 1.27 秒，瓶颈在 `collectRoots` 的 DOM 遍历 |
| 文档 | README 的「已知限制」随时可以补 |

## 提交前必须过

```bash
npm test        # 全部测试（单元 + 真浏览器）
```

浏览器测试需要本机有 Chrome/Edge/Chromium，没有会自动跳过。

## 代码约定

- **不加依赖**。整个项目零运行时依赖，这是刻意的。
- **不引入构建步骤**。改完刷新扩展就能跑。
- **检测逻辑必须在 `src/lib/`，UI 只在 `src/content/`**。这样检测引擎能单独复用（比如将来的自建检索层）。
- **每个扣分项都要能说人话**。用户不信黑盒分数，证据卡里每一条都得是完整的句子。

## 关于「实测优先」

这个项目里已有 6 个 bug 是靠真实数据的：

- 同域多页被判成占位（智谱单次答案里同一站被引 13 次）
- 跳转外链拿不到真域名（豆包全走 `link.wtturl.cn`）
- 文本片段导致去重失效（Kimi 的 `#:~:text=`）
- 容器选到参考列表而不是正文（豆包）
- 无外链时找不到答案容器（元宝）
- 空引用时纯文本模式没触发

**没有一个是从代码里看出来的。** 所以：提 PR 时带上实测数据，比带上解释有用得多。

## PR 要求

- 一个 PR 解决一个可观察的问题
- 描述里写清楚：改之前什么现象、改之后什么现象、怎么验证的
- 涉及评分权重的改动，附上改动前后的对比数字
- 不要顺手重构无关代码

## 许可

贡献即表示同意以 [MIT](LICENSE) 许可发布。
