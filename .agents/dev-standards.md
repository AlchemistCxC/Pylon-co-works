# Pylon 开发规范

适用 TypeScript/Solid/React 与 Rust/Tauri。领域名词以 [CONTEXT](../CONTEXT.md) 为准；模块责任边界见 [模块维护地图](../docs/说明书/Pylon-模块维护地图.md)，历史架构说明见 [项目架构参考](../docs/说明书/Pylon-项目架构参考.md)。规则服务于行为保持和可维护性，不要求为统一外观重写未涉及的代码。

协作流程见仓库根 [`AGENTS.md`](../AGENTS.md)。

## 模块与依赖

一个模块围绕同一数据所有者或能力组织。文件拆分需要说明调用者、输入输出、依赖和副作用：纯投影不发 IPC，宿主编排不拥有第二份 journal，渲染器通过 Host Port 消费文档与命令。先消除重复流程和所有权混淆，再决定是否抽文件。没有独立职责的单行代理或通用 `utils` 层不能算模块化。

新提取模块在文件头说明职责和副作用约束；不要逐行注释显然的赋值，也不要在源码重复容易过期的行号/文件数量。对外接口使用语义类型；避免把整个 store、controller 或可变全局对象传入纯函数。

不能用文件夹名字推断层级：`plugins/core` 是产品实现，`plugin-runtime` 是扩展机制，`kernel` 不是全部概念 Kernel。已有检查器是当前可执行边界；重构时若触发白名单，先判断是否暴露了不应存在的依赖，不自动新增豁免。

## 命名

| 对象 | 约定 | 示例 |
| --- | --- | --- |
| TS 内部变量、参数、普通函数 | camelCase，名字表达数据或动作 | `sessionResponse`、`loadGeneration`、`resolveModelChoices` |
| TS 类型、类、React/Solid 组件 | PascalCase；组件文件保留既有 `.solid.tsx` 后缀 | `WorkbenchDocument`、`SolidControlCenter` |
| 固定常量 | SCREAMING_SNAKE_CASE；普通不可变局部值仍用 camelCase | `MAX_PENDING_EVENTS`、`ownerKey` |
| Rust 变量、函数、模块 | snake_case；类型/trait/variant PascalCase；常量大写下划线 | `owner_key`、`SessionInfo`、`MAX_INSTANCES` |
| 布尔值 | 优先 `is/has/can/should`，也保留清楚的状态形容词 | `isCurrent`、`hasReplay`、`destroyed` |
| 数值 | 名称表达单位和意义 | `timeoutMs`、`receivedAt`、`eventCount`、`byteLimit` |
| 集合/映射/取消句柄 | 复数、`By…`、`cancel…` / `unsubscribe…` | `events`、`sessionsByOwner`、`cancelFrame` |

`props`、窄循环中的 `index`、泛型 `T` 等通用约定可以保留；跨几十行或跨模块的 `res/cfg/upd/data` 应改成具体语义名。不要只为减少字符而缩写。

身份命名必须区分 local session、remote ACP session、Agent Instance、Profile、owner key 和 generation。局部适配可以命名为 `localSessionId` / `remoteSessionId`，但公开 `Session.source` / `periId` 等历史字段不能顺手改名。JSON、ACP、IPC 参数、SQLite、配置文件、localStorage、CSS class、插件 contribution id 都是契约；改变它们需要单独迁移与消费者验证。对 wire 解构可使用 `{ session_id: sessionId }`，不可全局字符串替换。

语法检查覆盖内部绑定命名，无法判断身份含义或单位是否正确，后两者仍需沿调用链核对。检查通过不代表命名审阅完成。

## 样式与 Tailwind utilities

第一方 CSS 的所有权真值是 `src/plugins/product/firstPartyStyleOwnership.ts`（`check:first-party-styles` 门禁）：产品 CSS 由各第一方包 `styleAssets` 以 `?inline` 挂载、随插件生命周期回收；新增样式文件必须登记 owner、importer 与 lifecycle。Tailwind utilities 基线唯一入口是 `src/styles/tailwind.css`（kernel-static），`@theme inline` 只读消费 `index.css` 的 token。

- utility 类只用于新代码与结构性微调；既有 CSS 文件不迁移，也不用 utility 覆盖存量类——未分层 CSS 在层叠序上恒高于 `@layer utilities`，覆盖既有样式请改对应的 CSS 文件。**该约定只对存量「类」成立**：`src/index.css` 的全局元素 reset（`*, *::before, *::after`）落在 `@layer base`，层序 `base < theme < utilities` 亦在同文件声明。原因是元素级 reset 对**没有任何存量类**的纯 utility 元素同样生效，留在未分层区会让 `p-*` / `m-*` 全系恒败（issue #116 子项 1；首方包 plugin-manager 曾带着这个假绿合入）。新增全局元素规则照此办理：进 `@layer base`，或写成不压制 utility 的形态。
- `tailwind.css` 内禁止字面量色值，新增映射只允许 `var(--…)` 引用（`check:tailwind-tokens` 门禁）；`--ease-*`、`--motion-*`、`--shadow-*` 命名空间与既有 token 撞名，不映射，需要时用任意值语法（如 `shadow-[var(--shadow-soft)]`）。
- 禁用 `dark:` variant：主题是 CSS 变量换值，不存在 class 翻转。插件 `?inline` CSS 不得使用 `@apply`（不经过 Tailwind 入口编译），但可照常使用 utility 类名。
- utility 类名不对第三方 Suite 承诺稳定；第三方 Suite 视觉自足，不依赖宿主 Tailwind 版本与类集合。
- 样式注释文本里避免写出会被解析器误读的序列：星号紧跟斜杠会提前终止块注释，把注释文本变成活 CSS（tailwind.css 头部注释曾因此打断构建）。
- 派生色调（主色淡化背景、描边融合）一律用 index.css 派生色调层的 `*-soft`/`*-edge` token 或其 utility（`bg-accent-soft`、`border-danger-edge` 等）；禁止在 TS 类串或组件样式里新写 color-mix 或字面量色值——需要新档位时先在 index.css 派生色调层立 token，再映射进 tailwind.css。
- 每包允许至多一个自适应残量样式（lifecycle `adaptive`，`?inline` 随插件生命周期回收），只收模式切换、媒体查询、动效、`:has()` 这类 utilities 不宜表达的自适应规则；其余样式一律 utilities，绞杀时随组件迁移。
- 常用 variant 对照：展开态 `aria-expanded:`、键盘焦点 `focus-visible:`、减动效 `motion-reduce:`、窄屏 `max-[720px]:`、后代引用 `[.some-scope_&]:`（慎用，优先把判断放进组件状态）。

## Rust/WASM 计算核（#220）

计算核目标形态是 **JS 编排 + WASM 计算核 + Solid DOM 消费层**：计算住 Rust，编排（store、时钟、IPC、持久化、DOM）留 JS。选型与理由见 [ADR-0018](decisions/0018-frontend-compute-core-rust-wasm.md)。

- **落点**：计算核与被共享的契约 crate 都进 `src-tauri` 的 workspace。另起 workspace 会让它们脱离 `cargo test --workspace --lib` 与 `cargo fmt --all`，等于重建 #106 P0 关掉的测试黑洞。`crate-type = ["cdylib", "rlib"]`：wasm-bindgen 在非 wasm 目标可编译，纯逻辑在宿主跑原生单测（property test 靠这个，比在 wasm 里跑快得多）。
- **分层是硬约束**：计算核的每个出口都拆「纯内层函数（`Result<T, String>`）」+「`#[wasm_bindgen]` 薄壳（只做值/错误转换）」。`JsError::new` 在非 wasm 目标会走导入桩并 panic（`cannot call wasm-bindgen imported functions on non-wasm targets`），把可失败逻辑写在壳里会让宿主测试直接炸。
- **计算核不读环境**：不读时钟、store、registry，不做 IO，不发明活性判定（在途回合的权威在运行时内核，ADR-0017）。需要时间时由 JS 把 `now` 传进来。
- **迁移期只允许差分并存**：TS 基线与计算核的实现只能在 parity 差分阶段共存；parity 绿后 TS 侧退役，不留长期双实现。装载层（`src/infrastructure/compute/pylonCompute.ts`）不含计算逻辑，也不得就地补一份 TS 实现。
- **产物与工具链**：产物生成到 `src/wasm/`（不入库、不 lint、不 tsc），由 `scripts/build-wasm.mjs` 构建（源码哈希做戳，未变跳过；缺 `wasm32-unknown-unknown` 或 `wasm-pack` 时报出补齐命令）。vitest 的 `globalSetup` 与 `check:frontend` 的 `build:wasm` 步骤都会确保它存在。**wasm-opt 的特性开关必须与 rustc 默认发射的特性对齐**（见 `src-tauri/pylon-compute/Cargo.toml` 注释），否则 `-O` 直接验证失败。
- **产物记账**：`check:bundle` 的 wasm 预算段独立于 js 总额；新增 wasm 依赖后按实产物重定标，不把 wasm 折进 js 总额（会让既存产物变成超限）。
- **跨语言契约的单源方向**：成对的 wire 契约（事件类型词表等）以 Rust 为单源，TS 侧由脚本生成（`scripts/generate-canonical-event-types.mjs`），不用「两处手抄 + 门禁兜底」。

## 决策与开发笔记

会改变依赖方向、数据所有权或持久化契约的决定使用短记录：问题与约束、备选方案、决定、状态、后果、代码/测试证据。推翻旧决定时标注被哪条决定替代，而不是删除历史。一般局部重命名不必生成 ADR。

记录模板见 [`templates/adr.md`](templates/adr.md)，落地到 `decisions/`。

记录分别标注"当前事实""待实施""已验证""尚未复现"。外部路径不存在时注明不可用，优先读取仓内事实，不从历史施工书标题推断当前要求。文档与门禁、注释与类型冲突时先查代码和运行结果，再更新过期说明。

## 验证与交付

- 纯移动/内部重命名：定向行为测试、类型检查、import/边界检查；保持原导出入口直到所有消费者已迁移。
- 状态/调度：验证 owner/generation、取消后迟到结果、重复事件、暂停恢复、卸载清理及回放权威。涉及竞态才补相应并发/负载验证，不为普通文案或无副作用移动构造虚假性能测试。
- UI：除测试外检查受影响的真实布局与交互；浏览器 mock 不能证明真实 Agent IPC 正常。
- 最终执行仓库当前定义的 `check:frontend`、`check:solid`；Rust 变更使用匹配 crate 的测试、格式和 Clippy，集成时运行现有 Rust/ACP 门禁。测试失败保留证据并区分基线、环境与本次引入，不弱化门禁。
- PR 说明最终行为、必要权衡与验证限制；CI 绑定具体 head/base。按既有授权可用草稿 PR 触发 CI，通过后转为可审阅。是否合并遵循当前用户授权，绿色检查本身不扩大授权。

## 依据与本项目的选择

检索日期：2026-09-12；以下为一手资料，采用其原则，不照搬所有规则。

- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)：采用内部标识符 casing 和可读命名；保留 Pylon 既有文件命名与框架后缀，不迁入 Google 的全部工具链。
- [Rust API Guidelines：Naming](https://rust-lang.github.io/api-guidelines/naming.html)：采用 Rust 社区 naming / acronym 约定，不把 TS camelCase 强加给 Rust。
- [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow)：采用分支、review、检查与讨论记录；合并动作仍取决于本任务授权。
- [git-worktree](https://git-scm.com/docs/git-worktree)：采用独立工作目录隔离并行改动；依赖目录和构建输出也需避免共享写入争用。
- [C4 component diagram](https://c4model.com/diagrams/component)：按责任与接口描述组件；仅在关系难以用表格说明时画图，不为每个文件制造一张图。
- [Michael Nygard：Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)：采用小型决策记录、上下文与后果、被替代状态，避免持续膨胀的施工总文档。
