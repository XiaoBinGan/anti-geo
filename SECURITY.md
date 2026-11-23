# 安全策略

## 支持的版本

只对最新 release 提供安全修复。

## 报告漏洞

**请不要开公开 issue。**

优先用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)（仓库 Security 标签页 → Report a vulnerability）。

邮件方式：在 issue 里用 `security-contact` 标签开一个不含细节的占位 issue，我会私信你。

请包含：

- 影响版本
- 复现步骤（最小可复现）
- 影响范围（能读到什么 / 能改什么）
- 如果涉及第三方页面，说明是哪个站点的什么结构触发的

48 小时内回复，7 天内给修复或缓解方案。

## 这个扩展的攻击面

因为它是浏览器扩展，安全关注点主要是：

| 风险 | 说明 | 现状 |
|---|---|---|
| **跨站抓取** | 扩展会请求被引用的页面（`<all_urls>` 权限） | 用 `credentials: 'omit'`，不带 cookie；只读 HTML，执行任何脚本 |
| **响应体污染** | 恶意页面可能塞入超长内容撑爆内存 | 单页最多读 600KB，正文截断 20k 字符 |
| **注入伪造** | 恶意页面可能伪造结构骗过高分 | 评分只有下限没有上限；白名单无法被页面影响 |
| **外部名单** | 订阅的 JSON 可能是恶意构造的 | 域名严格正则校验，非法项丢弃；不执行任何内容 |
| **代理取数** | 本地 mitmproxy 服务可能被其他程序访问 | 只监听 `127.0.0.1`，只读 GET |

## 不做的事

- 不执行被引用页面里的脚本
- 不改写 HTTP 响应（代理 addon 只读）
- 不把页面内容发送到任何地方
