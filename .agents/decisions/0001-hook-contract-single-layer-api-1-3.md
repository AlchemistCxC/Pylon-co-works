# ADR-0001 废弃 agent.hook 七 phase 契约,以单层 23 锚点词表作为插件 API 1.3 契约

- **日期**:2026-09-14
- **状态**:已采用

## 背景与约束

hook 系统存在两层重叠契约:

1. **agent.hook 七 phase 契约**(`src/contracts/agentHook.ts`,施工方案书 v3 §4.2):7 phase + observe/transform/gate 三效应,执行器为 `src/host/hookPipeline.ts` → `hookPhaseAdapter.ts` 适配。生产代码中 `registerHookPhaseRunner` 零调用(仅测试使用),即该契约无任何真实贡献者。
2. **插件 24 锚点词表**(`src/plugin-runtime/hooks/hookTypes.ts`,开发者手册 §6.2):`HookRuntime` 统一执行,pipeline/notification 模式 + cancel/transform 语义,Kernel Hook 桥(P55-D1)已投产。

两层经 `HOOK_PHASE_MAP` 重叠,且事件方言分裂:kernel 桥派发裸 wire payload(`{source, content, blocks}`),七 phase 适配层派发 `ProductHookEvent`(`{phase, agentId, message, now}`)。同一锚点 `message.user.beforeSend` 的 transform 改写 `content` 只对 GUI/kernel 路径生效、改写 `message` 只对 CLI 路径生效——单一插件 handler 无法两端通用(issue 决策会话确认)。

约束:仓内无任何插件注册过 hook(builtin 五包不注册,demo 仅引用字段),契约形状变更此刻免费;一旦有第三方插件按任一方言注册,迁移即成破坏性变更。另 issue #37 证明「派发面 vs 词表」漂移会静默吞掉插件决策,词表需要一份可门禁的单一事实源。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 保留双层,七 phase 为产品内部面、词表为插件面,补齐适配层 | 永久维护 `HOOK_PHASE_MAP` 翻译层与两种事件方言;方言失配只能缓解不能根除;适配层无生产贡献者却占三条测试与文档成本 |
| 单层化但以七 phase(7 名词)为词表 | 表达力不足:生命周期配对(creating/created…)、permission.request、tool 观察锚点无处安放;kernel 桥已按词表投产,倒向迁移成本更高 |
| 双方言并存,文档标注 | 插件 transform 必须探测字段存在性,正是 #37 类「静默不生效」问题的温床 |

## 决定

1. **删除七 phase 契约层**:`src/contracts/agentHook.ts`、`src/host/hookPipeline.ts`、`src/plugin-runtime/hooks/hookPhaseAdapter.ts`、`src/components/chat/hookRuntime.ts`(shim)全部移除;`sessionHookTransactions` 重写为对 `HookRuntime.invoke` 的直接类型化调用。三效应语义由词表模式覆盖:observe→notification、gate→pipeline+cancel、transform→pipeline+event 改写。
2. **词表定稿为 API 1.3 契约**:23 锚点(移除 `agent.chunk`、`message.agent.committed`,新增 `permission.request`),每锚点一份类型化事件 schema 与超时预算;`message.user.beforeSend` 统一 `{source, content, blocks}` 方言。`PYLON_PLUGIN_API_LATEST = '1.3'`,`capabilities`/`dangerousHooks` 校验谓词改为 `>= 1.2`。
3. **词表三方同源门禁**:TS `HOOK_NAMES`、Rust 锚点常量、开发者手册 §6.2 词表块由 `scripts/check-hook-anchor-parity.mts` 强制相等,防 #37 类漂移复发。

## 后果

- 正面:单一事实源消除双方言;`HOOK_TIMEOUT_MS=50` 死常量与 `HookPipelineOptions.timeoutMs` 死参数清除;锚点集有机器门禁;后续锚点增减只动词表 + schema + 各缝派发点三处且被门禁看住。
- 负面:七 phase 文档语义(施工方案书 v3 §4.2)失去代码对应物,需在开发记录中留档;CLI 域发送链迁移方言属行为等价改造,依赖测试护航。
- 风险:第三方插件若已在仓外按 1.2 词表注册 `agent.chunk`/`message.agent.committed`,升 1.3 后注册被拒——缓解:两锚点本就无派发方,注册即死代码;手册明示 1.3 移除清单。

## 证据

- 七 phase 层零生产贡献者:`registerHookPhaseRunner` 全仓仅 `src/components/chat/__tests__/hookRuntime.test.ts:16` 调用(2026-09-14 grep)。
- 方言分裂:`src/infrastructure/hooks/hookBridgeDispatcher.ts:62`(裸 payload)vs `src/plugin-runtime/hooks/hookPhaseAdapter.ts:71-84`(ProductHookEvent 适配)。
- 词表漂移实例:#37(`permission.request` 由 `src-tauri/src/dispatcher/mod.rs:640` 派发、不在词表、`dangerousHooks` 校验连带不可达)。
- 升版隐患:`src/plugin-runtime/packageManifest.ts:119,138` 以 `=== PYLON_PLUGIN_API_LATEST` 判定新字段,升 1.3 将误拒 1.2 manifest 的 `dangerousHooks`,本 ADR 随附修复。
- API 版本锚点:`src/plugin-runtime/packageManifest.ts:6`。
