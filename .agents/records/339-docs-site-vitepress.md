# Dev Record — #339 引入 VitePress 文档站（公开文档的导航/搜索/在线入口）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#339
- 分支：`kumo/docs-site`（隔离工作树 `../prism-docs-site`；主工作树 `kumo/prometheus` 上 #334-336 在途未受影响）
- 提交范围：`47c6e67d..HEAD`（本 PR 共 2 个 commit）
- 日期：2026-09-25

## 目标与范围

目标：引入 VitePress 文档站，外部用户获得导航、全文搜索与在线入口；文档源保持仓库内单源、篇目零改动。**不做什么**：篇目搬移/改名/改内容；`.agents/**`、`AGENTS.md`、`CONTEXT.md` 不进站点；`docs:build` 不进 PR CI 门禁；中文 URL 美化留待后续。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `docs/.vitepress/config.ts` | 站点配置：lang/base/rewrites/侧边栏分组/本地中文搜索/死链豁免/srcExclude | 新增 |
| `docs/index.md` | 首页（hero + features，素材取自根 README） | 新增 |
| `docs/.vitepress/theme/index.ts` | 主题扩展：加载 Source Serif 4 + Noto Serif SC（fontsource 自托管分块） | 新增 |
| `docs/.vitepress/theme/custom.css` | 排版覆盖：全站衬线字体栈、抗锯齿、中文行距 1.85 | 新增 |
| `docs/.vitepress/.gitignore` | 忽略 VitePress 的 `cache/`、`dist/` | 新增 |
| `package.json` | scripts 增加 `docs:dev/build/preview`；dev 依赖 +vitepress、+@fontsource/noto-serif-sc、+@fontsource/source-serif-4 | 修改 |
| `bun.lock` | 随上同步 | 修改 |
| `.github/workflows/docs.yml` | main push（paths 过滤）+ 手动触发 → 构建并发布 GitHub Pages | 新增 |
| `README.md` | 简介段后加一行「在线文档」入口 | 修改 |
| `.agents/decisions/0026-docs-site-vitepress.md` | 选型 ADR | 新增 |
| `.agents/records/339-docs-site-vitepress.md` | 本记录 | 新增 |

## 方案要点

- `srcDir=docs/` 直接复用既有篇目：`docs/README.md` 保留为「文档目录」索引页（nav 入口），说明书 8 篇 + `Pylon-插件设置选项贡献.md` 全部收录，**零改动**。
- **`rewrites` 把 10 个页面映射为 ASCII 路由**（`/manual/*`、`/dev/*`），文件不搬移不改名：中文（百分号编码）路径在 vitepress 1.6.4 下直链加载正文空白（客户端导航正常，浏览器实测定位），ASCII 路由绕开该缺陷。
- **排版**：全站衬线——西文 Source Serif 4 与中文 Noto Serif SC（同源配对，fontsource 自托管、`unicode-range` 分块按需加载），`.vitepress/theme/` 扩展默认主题；中文行距 1.85；覆盖选择器与默认主题 `:root:where(:lang(zh))` 对齐。
- `tactical-blue/**`（内部验收记录）经 `srcExclude` 排除；`.agents/**` 等协作文档天然不在 srcDir 内。
- `ignoreDeadLinks` 按链接形态豁免：仓库源码/协作文档/仓外归档（CI 必然缺失）+ **百分号编码 CJK 链接**（1.6.4 死链检查器与 rewrites 互斥的误报，豁免前已核对产物链接全部指向 ASCII 路由）；站内 ASCII 死链仍被拦截。
- `base=/Pylon-co-works/` 对应 GitHub Pages 项目页；部署 workflow 沿用 ci.yml 惯例（bun 装依赖、Node 22 宿主跑 vitepress）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun run docs:build` 退出码 0 | ✅ build complete in 8.88s |
| 死链门禁（构建内建） | ✅ 豁免修正后 0 dead link |
| dist 含首页 + 索引 + 说明书 8 篇 + 插件设置贡献页，路由全 ASCII | ✅ dist 清单核对（`/manual/*`、`/dev/*`） |
| 篇目间交叉链接指向重写后路由 | ✅ 逐页 grep `href` 核对，无残留百分号编码链接 |
| `tactical-blue` 不进 dist | ✅ `find … -path "*tactical*"` 计数 0 |
| `bun run check:docs`（仓库既有门禁） | ✅ 退出码 0 |
| `eslint` config.ts / theme/index.ts | ✅ 退出码 0 |
| 直链加载内容页（rewrite 后路由） | ✅ h1 + 7393 字符正文（浏览器实测） |
| 衬线字体生效 | ✅ `document.fonts.check` 中文/西文均 true；body 计算字体 `Source Serif 4 → Noto Serif SC`；行高 29.6px（16×1.85） |
| preview：首页 / 篇目页 / 索引页 | ✅ curl 200 + 截屏目检两页 |
| 篇目零改动 | ✅ `git diff 47c6e67d -- docs/说明书 docs/README.md docs/Pylon-插件设置选项贡献.md` 为空 |

## 测试处置

修改或删除的测试：无。新增测试：无（纯文档工具链；门禁 = 构建 + 内建死链检查 + eslint + 仓库既有 `check:docs`）。

## 证据

- commit：见本 PR（feat 主体 + docs(record) 两个提交）。
- 构建：`vitepress v1.6.4 … build complete in 7.29s`，退出码 0。
- preview：`http://localhost:4173/Pylon-co-works/` → 200；说明书篇目页（百分号编码 URL）→ 200；`README.html` → 200。

## 与 spec 的偏差

- spec 阶段曾把 `Pylon-插件设置选项贡献.md` 误判为缺失文件的既有死链；构建产物核对证实 `docs/Pylon-插件设置选项贡献.md` 真实存在，对应豁免已撤销。
- **后续追加了 spec 未含的两项**（同一 issue 内）：① 全站衬线排版（用户追加需求：中文衬线、西文自定）；② `rewrites` ASCII 路由——浏览器验收中发现 vitepress 1.6.4 中文路径直链空白缺陷，且该缺陷使原「中文 URL 观感」遗留一并消除。
- 本地预览坑（已写入 ADR）：`docs:preview` 的 sirv 在启动时固化文件清单，重建 dist 后必须重启预览服务，否则新哈希资源 404。

## 未解问题

- Pages 首次启用需仓库设置：Settings → Pages → Source 选 **GitHub Actions**（workflow 已含 `actions/configure-pages`）。
- 篇目内指向仓库源码的相对链接在站点上点击 404（豁免只保证构建过）；后续可加 remark 链接改写指向 GitHub blob。

## 并行交集

- `package.json`、`bun.lock`（共享依赖文件；本分支基于 github/main，不含 #334-336 相关改动）。
- `README.md`（仅简介段后 1 行）。
- 其余改动均在 `docs/.vitepress/**`、`docs/index.md`、`.github/workflows/docs.yml`、`.agents/{decisions,records}/**`，与 L.md 在途声明无重叠。
