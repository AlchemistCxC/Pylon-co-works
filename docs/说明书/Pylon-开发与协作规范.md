# Pylon 开发与协作规范

适用 TypeScript/Solid/React 与 Rust/Tauri。领域名词以 [CONTEXT](../../CONTEXT.md) 为准；实际职责见 [模块维护地图](Pylon-模块维护地图.md)，历史架构说明见 [项目架构参考](Pylon-项目架构参考.md)。规则服务于行为保持和可维护性，不要求为统一外观重写未涉及的代码。

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

## 多人协作与交接

1. 动工前记录 branch、base/head、工作区状态，更新远端引用并检查在途 PR 与 BOARD；未提交内容按文件或 hunk 保留。用户要求同步 main 时先同步，再做新改动。
2. 按责任块认领文件与接口。人或 agent 并行工作使用不同分支/worktree；共享协议、锁文件、门禁入口与公共类型由一个集成责任人处理。认领说明应包含目标、可写范围、禁止改动、依赖、验收与停止条件。不要虚构 GitHub owner 或把讨论多人流程当作启动子代理的授权。
3. 每块先记录当前入口、所有调用者、既有测试和保持不变的行为，再实施。一次提交围绕一个可审阅变化；新业务逻辑与纯移动/重命名尽量分开，便于区分回归来源。
4. 冲突按双方最终意图解决。不能整文件接受一方、覆盖别人的在途改动或清空未跟踪文件；共同编辑的文件使用明确路径/hunk 暂存。只在确有并行独立收益且已获授权时委派，主负责人保留架构判断、集成与最终验收。
5. 交接写明基准提交、已落地行为、测试命令/退出码、未解问题、下一块依赖和可重现证据。BOARD 保留短摘要，详细过程放在当前工作区的开发记录，持久规则回写本说明书。

## 决策与开发笔记

会改变依赖方向、数据所有权或持久化契约的决定使用短记录：问题与约束、备选方案、决定、状态、后果、代码/测试证据。推翻旧决定时标注被哪条决定替代，而不是删除历史。一般局部重命名不必生成 ADR。

记录分别标注“当前事实”“待实施”“已验证”“尚未复现”。外部路径不存在时注明不可用，优先读取仓内事实，不从历史施工书标题推断当前要求。文档与门禁、注释与类型冲突时先查代码和运行结果，再更新过期说明。

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
