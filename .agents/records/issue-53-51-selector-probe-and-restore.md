# 开发记录 · #53/#51 选择器全套：空态探测 + 恢复期选择器恢复 + 切换错误 UX

## 元信息

- issue：[#53](https://github.com/AlchemistCxC/Pylon-co-works/issues/53)、[#51](https://github.com/AlchemistCxC/Pylon-co-works/issues/51)
- 类型：bug × 2（control-center）
- 分支：`Ru5t/Reflector`；spec：`.agents/spec/issue-selector-probe-and-restore.md`
- 参照：codge（本地 codeg-src，commit `b2eec98`）`probe_agent_options`（manager.rs:2240）；Zed `agent-client-protocol =2.1.0` 客户端（configOptions 权威回显 + watch 语义）

## 根因（证据）

1. **#53**：空态模型候选 = 该 agent 历史会话 `sessionConfig` 桶并集（`agentAdvertisedModels.ts` computeEntries）——agent 未跑过会话时为空。缺主动探测（对照 codge `probe_agent_options`：一次性会话 + 静默 emitter + 即断）。
2. **#51 选择器半边**：`load_persisted_session` 响应只进 runtimeStore（`agentWorkbenchLifecycle.ts` `applySessionStateResponse`），不进 workbench document（`document.session.options` 仅由 canonical journal 重放重建，`agentWorkbenchSession.ts bind()`）；新建路径是双写（`agentWorkbenchSessionCreation.ts:74-75`），load 路径漏 document 侧；send_message revive 的 `SessionMapping.new_response = None` 同样不发布。
3. **#51 UX 半边**：`.cc-widget-error` 撑排问题已由先前 PR（#156）浮层化修复；本轮补齐「不可切换 ≠ 切换失败」语义与短文案（`model_not_advertised` 把整份宣告列表拼进 message）。
4. **思考等级**：中控区控件（`SolidReasoningWidget`）、切换命令、后端校验（D97-6）早已存在，断链只在 2——恢复后 document 无 reasoning option，控件退化为默认表且 current 为空。

## 变更

### 后端

- **`session/create.rs`**
  - 新增 `ingest_established_config_options_event`：合成标准 `session/update` raw（`config_option_update`）走 `EventService::ingest_event` 同通道写 canonical journal（#110 F5 模式复用）；空 envelope 不写；超 `SELECTOR_ENVELOPE_MAX_BYTES`（256 KiB）不写只告警；失败仅 warn。
  - 新增 `response_config_options`（camel/snake 双形提取）。
  - 写入点 ×3：`create_session_slot`（建立期，模型事实写入之后）、`revive_session_slot`（send_message 复活路径，补 `new_response: None` 不回传响应的缺口）。
  - 新增命令 `probe_agent_selectors(agentId, cwd?, workspaceId?)`：`resolve_agent_runtime`（不 boot 进程）→ `session_creation` 锁内 `session_ready` 门 + `build_session_new_plan` → 一次性 `session/new` → `SessionInfo::apply_session_response` 同一套面解析（零特判）→ 序列化 `{configOptions, modes, modelSurface{kind,configId}, modelChoices, currentModel}` → `close_session_rpc(strict=false)` 即弃。不落槽位、不写 journal、不做 initial 下发、不参与 gateway 源校验。
- **`session/persist.rs`**：`load_persisted_session` 成功路径写入点（与建立期对称）。
- **`lib.rs`**：命令注册。

### 前端

- **`infrastructure/acp/sessionClient.ts`**：`probeAgentSelectors` + `AgentSelectorsSnapshot` 类型。
- **`sheets/agent-workbench/agentAdvertisedModels.ts`**：模块级探测缓存（5 min TTL、in-flight 防抖、失败占位）+ `noteAgentSelectorsSnapshot`（configOptions 经 `extractModelConfig` 提 id/label，无标准 option 退 `modelChoices`）+ `setAgentProbedModels`/`agentProbeFresh`/`markProbeInFlight`/`markProbeUnavailable`/`resetAgentProbeForTests`；`computeEntries` 改为「桶并集 ∪ 探测结果」（Map 覆盖语义：同 id 探测 label 胜出，位置保持桶序）；WeakMap 缓存行带 probe version（探测落位使缓存失效）。
- **`sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx`**：宿主 useEffect 按 agentId 拉探测（TTL 内跳过），落位推进本地 tick 重算 mount input；失败静默。
- **`plugins/core/sessionState/runtimeStoreSessionState.ts`**：`applyResponse` 把原始 configOptions envelope 写入 `SessionConfig.raw`（Settings 泛化配置面板的数据源；此前 raw 仅在 `config_option_update` push 时入库）。
- **`renderers/solid-workbench/input/workbenchOptionCatalog.ts`**：`shortControlCenterError`——稳定 code（`model_not_advertised`/`reasoning_not_advertised`/`model_switching_unavailable`）映射简短文案，未知文本截 80 字符；全文仍在浮层 `title`。
- **`renderers/solid-workbench/input/WorkbenchWidgets.solid.tsx`**：三个控件的错误文案改走 `shortControlCenterError`；`SolidModelWidget` 增「无模型面禁用态」（非草稿模式且候选为空 → `disabled` + title「该 agent 未宣告可切换模型」）。

## 测试与验证证据

- Rust 定向（`CARGO_TARGET_DIR=D:/pylon-acceptance-target`）：
  - `cargo fmt --check` ✅
  - `cargo test --lib session::` → **236 passed, 0 failed**（前置：`cargo build --bin pylon-fake-agent --features test-agent`，否则 23 个环境性红）
  - `cargo test --test integration --features test-agent` → **25 passed**（含新增 `issue53_selector_probe` 3 例：探测返回完整面 / 建立期 journal 恰一条 `session.config-updated` / 恢复期 journal 恰一条）
  - `cargo check --lib` ✅
- 前端：
  - `bunx tsc -b`：我方文件零错误（现存 6 个错误全部位于 #154 阶段 4 在途文件域 `src/components/__tests__/Settings*.test.tsx`、`agentStatusConsumerMatrix.test.tsx`，与本轮无关，见 L.md 报点）
  - `bun run check:ipc` ✅（后端 212 命令，双向一致）
  - eslint（本轮全部触碰文件）0 errors
  - vitest 定向：`agentAdvertisedModels`（10，含新增 4 例探测合并/回退/占位）、`runtimeStoreSessionState`（4，含 raw 契约变更与新增 raw 断言）、`workbenchOptionCatalog`（新增 `shortControlCenterError` 2 例）、`sessionModelState`、`agentAdvertisedModels.subscription`、`WorkbenchWidgets.solid`、`snapshotBridge`、`mockTauri`、`sessionSurfaceProjection` → **39+43 全绿**

## 契约变更声明

- `runtimeStoreSessionState` 首个用例的 `toEqual` 断言按新增 `raw` 字段更新（并新增独立 raw 断言）——非降级，字段语义见代码注释。
- canonical journal 复用既有 `session.config-updated` 类型（event_repo.rs:533 对 `config_option_update` 的映射），**零 schema 变更**。

## 遗留与边界

- 探测在 agent runtime 未建立时返回 `agent_runtime_unavailable`（不 boot 进程）；空态触发时机由 agent sheet 可用性天然保证。
- 思考等级的端到端真机验收（重启 → 历史会话 → 切换）依赖真 agent 宣告 thought_level 选项；fake agent 侧已覆盖 wire 语义。
- codge 的 Grok `_meta` 合成、Cursor parameterized 握手等 per-agent 适配是参照知识，Pylon 不引入 provider 特判（通用契约不变量保持）。

## 审查收口（2026-09-19，PR #177 审查轮）

- **title 全文回显缺口修复**：审查发现上轮实现中 `title` 与正文同为截短后的 80 字符串（`setError(shortControlCenterError(...))` 先截短再入信号），与上文「全文仍在浮层 `title`」的声明不符。已改为 **error 信号存完整原文、渲染侧正文走 `shortControlCenterError` 截短、`title` 挂全文**（模型/权限/思考三控件一致）；新增控件用例断言「正文=稳定短文案/截 80、title=完整后端原文」。
- **说明书漂移同步**：`docs/说明书/Pylon-插件化前后端拓扑全图.md` 的 `APP --> SETTINGS` 边改为 `SHEETLAYOUT --> SETTINGS`（#154 阶段 4 后 `Settings.tsx` 经 sheet 注册表挂载，不再由 App 直挂），节点标注「settings sheet 主区视图」。
- **合并**：`3a7ddb20` 合入 `github/main`（#175 squash `5953a3f7`），`.agents/L.md` 冲突按追加并集解决；PR diff 中 `vitest.config.ts`/issue-175 记录的幻影差异随合并消失。
- **仍遗留（本轮未处理，待裁定）**：① `ingest_established_config_options_event` 每次建立/恢复/revive 都追加一条 journal 记录，重复打开同一历史会话会线性累积重复行（重放语义幂等，仅 journal 体积增长）；② revive 写入路径无集成测试（仅与建立期同构保证）；③ #51 建议「错误可关闭/自动消退」未做，当前仍靠下次操作清除。
