# Dev Record — #346 README 与 docs/说明书 全面对照源码刷新

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/346-docs-refresh.md`

## 元信息

- issue：#346
- 分支：`kumo/prometheus`（滚动 PR #344）
- 提交范围：`65946879..b04f8b5c`（4 个 docs 提交；协调提交 `4fe89286` 为 L.md 声明）
- 日期：2026-09-26

## 目标与范围

README.md 与 `docs/说明书/` 全部 8 篇逐条对照当前源码核查，修正可证伪的过时表述，补齐重大文档缺口。**不做什么**：不动任何源码；不登记 ADR（无路线决策）；不处理 `docs/.vitepress`（#339 域）。

## 方法

5 路并行只读 Explore 子 agent 分域审计（README+架构参考 / 开发者版 / 用户版+拓扑全图 / 维护地图+检测器+docs 索引 / CLI+发行包清单），每条发现须附源码 `file:line` 证据；主会话汇总裁决后统一施改。审计合计约 40 条有效发现，另有 1 条存疑（ADR 编号引用）经主会话核验 `.agents/decisions/` 后确认为**非漂移**、未改动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `README.md` | 代码地图（acp/session 双层表述、补 workspace crate 条目）；release:portable 描述（WASM、webview2-mcp） | 修改 |
| `Pylon-项目架构参考.md` | 核验日期；Product Plugin 计数五→七（卷首/§3/§10 基线加注）；§5 补 4 crate 行；§13 路径迁 pylon-session、event_repo 目录化、ChatView→chatReplayCoordinator | 修改 |
| `Pylon-插件系统说明书-开发者版.md` | §6 清单补 7 成员 + 新增 §6.12（ccWidget/presets/management API）；§6.2/6.3/6.5 枚举补全；§6.8 sidebar `query?` 与右栏 wire 协议订正；§6.11 API 表/示例/removeValue；§6.11.5 发行包 SDK 全量；§12 命令计数 64→83 | 修改 |
| `Pylon-插件系统说明书-用户版.md` | 版本 0.2.2→0.3.0-AUE；契约线 1.0–1.3 与 2.0–2.4（2.0 破坏性）；「等待能力授权」徽标表述；§3.2 安装入口；§11 api 取值 | 修改 |
| `Pylon-插件化前后端拓扑全图.md` | 核验日期；RUST 子图补 workspace crates 层并连边；ACP 节点改 pylon-acp；PSKIN→CMDREG 边修正；REGISTRIES 补 5 registry；SQLITE 表名订正；锚点表持久化事实迁移 | 修改 |
| `Pylon-模块维护地图.md` | applicationRuntime 转发行标记已执行；Clippy workspace 单跑；分片计数 650+；markdown 两文件路径；前端根文件行 + test-support 行；event_repo 目录化 | 修改 |
| `Pylon-Agent-检测器.md` | TTL 三态 Success/Unknown/Failure（600/60/15s）；`--json` 顶层形状 `{report, diagnostics, preflight}` | 修改 |
| `Pylon-CLI-命令表.md` | 版本号；内置命令 64→83；补 `interface.tactical-blue.activate` | 修改 |
| `Pylon-发行包清单.md` | §4.1 发行流程重写（#232 打 tag 即 CI 发行）；SDK 全量随包反转；ZIP 表补 3 行；构建步骤补 WASM/SDK 收集路径 | 修改 |

## 方案要点

- 以源码为唯一真源；#345 在途改动在审计期间由其会话合入（b3893d2b），开发者版按合入后现状核对，无搭车提交。
- mermaid 改动遵守该图自身维护规则 5：避免 ASCII 括号等易碎 token，且以真实 parser 验证（见证据）。
- 拓扑全图新增 `RUSTCRATES` 子图 + 4 条实线边表达「宿主模块的实体在 crate」；锚点表同步并注明宿主路径保留兼容 re-export。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 每处修改有源码依据 | 达成（审计记录 file:line 证据，见 issue 评论汇总） |
| 不与在途任务冲突 | 达成（#345 已先行合入；唯一文件域交集消除） |
| `check:docs` 门禁 | 绿（doc-links 4 项通过；check:docs 退出码 0） |
| mermaid 真实 parser 验证 | 通过（mermaid.parse → flowchart-v2 OK） |

## 测试处置

无测试修改（纯文档变更）。

## 证据

- commit：`65946879`（README）、`ca9ddc93`（架构参考+拓扑全图）、`d9973c9a`（插件系统两版）、`b04f8b5c`（维护地图等四篇）
- 测试：`bun scripts/check-doc-links.mjs` → 「文档链接检查通过（4 项）」exit 0；`bun run check:docs` → exit 0；`mermaid.parse`（happy-dom + mermaid）→ diagram 1 parse OK
- 手工验证：mermaid 解析脚本 `/tmp/mermaid-check/check.mjs`（临时目录安装，未触及仓库依赖）

## 与 spec 的偏差

无实质偏差。spec 预估「§6.11 块需绕开」因 #345 先行合入而自然解除。

## 未解问题

- 架构参考 §6/§8 的 ADR 编号引用经核验 `.agents/decisions/` 存在（ADR-0004/0017/0022），非漂移；无需处理。
- 维护地图「4439 用例」为运行时数字，静态不可复核，已按该文档自身原则改为「随代码计算」。

## 并行交集

- `README.md`：与 #339（VitePress 文档站，隔离工作树 `../prism-docs-site`）存在汇流可能，其合入前需 rebase 对齐。
- 本次未触碰任何源码与他人文件域。
