# ADR-0026 文档站选型：VitePress（源仍为仓库 Markdown 单源，站点只收录公开文档）

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0026-docs-site-vitepress.md`

- **日期**：2026-09-25
- **状态**：已采用（工具由用户拍板：「vitePress吧」；收录范围由用户选定「只放公开文档」）
- **议题**：issue #339

## 背景与约束

`docs/` 下 11 篇中文 Markdown（说明书 8 篇约 3600 行 + docs 索引 + 插件设置贡献篇 + tactical-blue 内部验收记录）以裸文件形态随仓库维护：对 AI 协作友好（PR review、直读），但外部用户没有导航、没有全文搜索、没有在线入口，README 是唯一门面。

约束：

1. **文档源必须保持仓库内单源**，照旧走 PR review——协作模型与 AI 协作直读都依赖这一点，不允许出现第二份事实（站外 SaaS 或 wiki 副本）。
2. 篇目被 AI 会话频繁同步编辑（见 `.agents/L.md` 多条在途声明），**不搬移、不改名、不改内容**。
3. 工具链现有 Vite + Bun + Node 22；仓库主语言中文，未来可能有英文 i18n 需求。
4. 当前 9 个公开页面规模，性能不是决定因素（四候选均在秒级）。

## 备选方案

| 方案 | 结论与理由 |
| --- | --- |
| **VitePress** | **采用**。与现有 Vite 工具链同源（配置即 TS）；中文开源社区事实标准（Vite/Vitest/Element Plus 官网均用）；本地全文搜索、i18n 开箱即用；`srcDir=docs/` 直接复用既有篇目，零改动接入。 |
| Docusaurus | 否决。功能最全（版本化文档、博客、翻译工作流）但最重最慢（webpack 底座）；当前规模无版本化需求，属过度配置。将来若出现「按 release 锁定旧版文档」的真实需求可重议。 |
| Rspress | 否决。构建最快（Rspack 底座）、中文排版体验好，但社区最小、冷门问题可检索资料少；性能优势在该规模不可感知。 |
| mdBook | 否决。Rust 单二进制、构建最快，但无 i18n 框架、无产品首页、无组件嵌入，形态是「手册」而非「文档站」，与插件生态的对外定位不匹配。 |
| GitHub Wiki / 外部 SaaS（GitBook 等） | 否决。wiki 不走 PR review、易与代码漂移；SaaS 引入第二事实源，违反约束 1。 |

## 决定

1. **VitePress 1.6.4**，`srcDir=docs/`；篇目零改动接入。**URL 经 `rewrites` 映射为 ASCII 路由**（`/manual/*`、`/dev/*`），文件不搬移不改名——中文路由在 1.6.4 下有直链加载缺陷（见后果 2），故不用。
2. 站点收录范围：`docs/README.md`（保留为「文档目录」索引页）+ `docs/说明书/` 8 篇 + `docs/Pylon-插件设置选项贡献.md`；首页素材取自根 README。**排除** `tactical-blue/**`（内部验收记录）与一切 `.agents/**`、`AGENTS.md`、`CONTEXT.md`。
3. 死链策略：篇目引用的仓库内源码/协作文档/仓外归档链接用 `ignoreDeadLinks` **按链接形态**（`/src/`、`/scripts/`、`/examples/`、根 README、CONTEXT、AGENTS、dev-standards、`/Docs/`）豁免，保证构建确定性（仓外路径在 CI 必然不存在）；站内死链仍被拦截。另豁免**百分号编码 CJK 链接**：1.6.4 的死链检查拿 rewrite 后的目标路由比对「源页清单」（构建插件 `pages` = srcDir 源文件），篇目间中文相对链接必然误报——豁免前已逐页核对产物链接确实指向重写后的 ASCII 路由。
4. 部署：GitHub Pages 项目页（`base=/Pylon-co-works/`），`.github/workflows/docs.yml` 仅 main push（paths 过滤）+ 手动触发；沿用 CI 惯例（bun 装依赖、Node 宿主跑 vitepress）。
5. **排版**：全站衬线——西文 Source Serif 4（与思源宋体同源配对，`@fontsource` 自托管分块，不依赖 Google CDN），中文 Noto Serif SC（思源宋体）；中文行距 1.85；经 `.vitepress/theme/` 扩展默认主题实现。

## 后果

- **正面**：外部用户获得导航、全文搜索与在线入口；篇目零 diff（协作模型零扰动）；构建秒级（11 页 ~9s）；净增 3 个 dev 依赖（vitepress + 2 个 fontsource 字体包）；URL 为 ASCII 路由，可读且直链可靠。
- **负面 / 代价**：
  1. **vitepress 1.6.4 两个坑已实证并绕开**：① 中文（百分号编码）路径直链加载时正文空白（客户端导航正常）——已用 `rewrites` 映射 ASCII 路由绕开；② 死链检查器与 rewrites 互斥（拿目标路由比对源页清单）——已按链接形态精准豁免并人工核对产物链接。
  2. 篇目内指向仓库源码的相对链接在站点上点击 404（豁免只保证构建过）；后续可加 remark 链接改写指向 GitHub blob。
  3. `docs:build` 不在 PR CI 门禁内（改动 docs/** 的 PR 依赖本地构建或部署 workflow 兜底）。
  4. CJK 字体分块共 332 个 woff2（dist ~26MB）：Pages 限额内无碍，浏览器按 `unicode-range` 只拉取页面用到的分块（实际每页几百 KB）；`docs:preview`（sirv）在启动时固化文件清单，**重建 dist 后必须重启预览服务**，否则新哈希资源 404、页面裸奔——本地预览易踩。
- **风险**：Pages 首次启用需仓库设置切到 GitHub Actions 来源；workflow 已含 `actions/configure-pages`，若 API 启用失败则需手动。
