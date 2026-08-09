# ISSUE-12：Gateway 适配器商店与实例生命周期

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-12`
- 原问题编号：`#7`
- 状态：已交付（方案已写入）
- 依赖：依赖 ISSUE-01；不阻塞 ISSUE-07/08
- 简介：将 Gateway 从路由概览扩展为 adapter catalog、凭据配置和实例启停管理。
- 来源：`docs/release-issues.md`

## 已拍板决策（2026-08-09）

### D-08：Gateway 凭据使用 AES-256-GCM 版本化 envelope

- 算法固定为 AES-256-GCM；每次写入生成新的 12-byte CSPRNG nonce，禁止 nonce 在同一主密钥下复用。
- 主密钥为 32-byte 随机值，以 Base64 存入 Pylon 用户数据目录 `.env` 的专用字段；首次缺失自动生成，日志不得输出。
- 密文文件使用版本化 envelope，至少包含：`version`、`algorithm`、`keyId`、`nonce`、`ciphertext`、`tag`。二进制字段统一 Base64。
- AAD 固定绑定文件 format version、credential id 与 adapter instance id，防止跨实例替换密文。
- 写入使用同目录临时文件、flush、原子替换；认证失败、字段缺失或版本未知时进入明确损坏状态，不返回部分明文、不静默重置。
- 主密钥轮换采用“新 keyId 写入 + 全量解密重加密 + 原子切换”；失败保留旧文件和旧主密钥引用，可安全重试。
- Windows 上创建 `.env` 与凭据文件后收紧为当前用户和 SYSTEM 可访问；无法设置 ACL 时阻止凭据写入并显示错误，不降级为普通明文文件。
- 删除实例时仅删除引用计数归零的 credential；删除密文不承诺物理介质安全擦除，UI 与文档不得作此声明。
- 配置备份继续按已拍板行为同时包含密文文件与主密钥且包本身不加密；导出 UI 必须明确风险。


### D-01：同一平台支持多个 Bot 实例

- Gateway 区分平台 catalog 与具体 adapter instance。
- 同一平台可以创建多个 Bot，例如多个 QQ Bot。
- registry、route 和 lifecycle 以稳定 `instanceId` 为主键，不以 platform key 代替实例身份。

实施方案成熟度：**已有领域方向，实例 schema/factory 尚未设计。**

### D-02：凭据存入 Pylon 本地加密文件

- 普通配置、前端 DTO、状态接口和日志只保存/返回 `credentialRef` 与脱敏状态，不返回 secret。
- 加密主密钥从 Pylon 用户数据目录 `.env` 读取。
- 首次缺少主密钥时自动生成高强度随机密钥并写入用户数据目录 `.env`，不得写入项目仓库；日志不得记录密钥。
- 删除 Bot 实例时，删除不再被其他实例引用的凭据。

实施方案成熟度：**仅有产品决策；加密算法、nonce、文件格式、密钥轮换、Windows ACL 和失败恢复尚无实施方案。**

### D-03：配置备份包含凭据文件与主密钥，备份包不加密

- 配置备份同时包含本地加密凭据文件和用于解密的主密钥。
- 备份包不再额外加密，由用户自行保管。
- 该决策意味着拿到备份即可恢复并解密 Bot 凭据，实施时不得宣称备份具备泄露保护。

实施方案成熟度：**仅有产品决策，导出格式、风险提示和导入冲突策略尚未定义。**

## 并行执行元数据

```yaml
formal_id: ISSUE-12
status: 已交付（方案已写入）
lane: gateway
priority: P1
stage: producer
size: XL
dependencies: ["01-A"]
blocks: ["13-A"]
likely_modify: ["src-tauri/src/gateway/", "src-tauri/src/gateway_cmds.rs", "src/sheets/gateway/"]
do_not_modify: ["未有真实 adapter 不启用平台"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

### D-04：删除 Gateway adapter instance 时保留 Route 并禁用

- 删除 Bot/adapter instance 后，引用该实例的 Route 不级联删除。
- Route 保留原有配置，但状态变为 `disabled`，明确显示“适配器实例不存在”。
- disabled Route 不得继续 ingest 或 deliver 平台消息。
- 用户可以编辑 Route，重新绑定到现有 adapter instance 后恢复启用。
- Route 列表、Gateway 状态和日志必须区分“实例已删除”与“Agent/平台连接错误”。

实施方案成熟度：**已有明确产品行为；Route disabled schema、重绑定校验和删除事务尚需代码级设计。**

### D-05：停止 Gateway Bot 实例时同时关闭平台 Session

- 用户停止某个 Bot/adapter instance 时，该实例当前维护的平台 Session 同步关闭并从运行时 registry 收敛。
- Route 配置保留，不因 stop 被删除或禁用；它们仍绑定原 adapter instance，等待实例重新启动。
- 停止期间不 ingest、不 deliver，也不保留可被误认为在线的平台 Session 状态。
- 实例重新启动后，根据保留的 Route 和平台实体重新建立新的平台 Session；不得把旧运行时连接对象直接复活。
- stop 必须等待接收循环、发送队列和平台 Session task 收敛；失败时显示明确错误，不得只改前端状态。

实施方案成熟度：**已有明确产品行为；平台 Session close 能力、队列收敛、重启重建和失败补偿尚需代码级设计。**

### D-06：Gateway adapter instance 使用独立 autoStart 设置

- 每个 adapter instance 独立保存 `autoStart` 配置。
- 新建实例默认 `autoStart=false`，只有用户显式开启后才参与 Pylon 重启自动启动。
- Pylon 启动时只尝试启动 `autoStart=true` 且配置完整的实例；凭据缺失、Route 无效或平台不支持时进入明确错误状态，不阻塞其他实例启动。
- 手动停止实例后，本次运行期不得因为全局启动流程或 Route 自动将其重新启动；autoStart 只决定应用重启后的启动策略。
- 设置变更必须持久化，启动恢复过程必须幂等，重复启动不得创建重复 registry/task/平台 Session。

实施方案成熟度：**已有明确产品行为；实例配置 schema、启动恢复顺序、失败重试和与 runtime 上限联动尚需代码级设计。**

### D-07：导出未加密凭据备份时显示普通风险提示

- 配置备份包含 Gateway 加密凭据文件和对应主密钥，备份包本身不加密。
- 导出界面显示普通风险提示，明确说明持有备份文件的人可以恢复并解密 Bot 凭据。
- 提示不要求二次确认，不阻断导出流程。
- 不得使用“安全加密备份”等可能误导用户的文案；导出日志不得包含凭据或主密钥内容。

实施方案成熟度：**已有明确产品行为；提示位置、文案样式和导出 DTO 尚需实现设计。**

## 原始问题记录

原问题编号：#7
严重度：P1
状态：已交付（方案已写入）

问题现象：
宫木云汇报：
“GatewaySheet 不完备，没办法为 Agent 增添适配器（QQ 适配器已有）；只有一个新增路由功能，没有 QQ Bot、微信 Bot、其他平台 Bot 接入选项，可能需要拓展功能。”

产品决策：
GatewaySheet 采用“适配器商店式”管理：平台卡片（QQ / 微信 / 其他）→ 配置凭据 → 启停 → 再建路由。

问题根因：
Gateway 后端虽然定义了通用 `PlatformAdapter` trait 和运行时注册表，但生产代码只实现并在启动期注册 QQ Adapter；适配器注册依赖具体 Rust 实现、凭据和长连接任务，`reload_gateway` 明确不会改变已注册适配器。前端 `GatewaySheetView` 只读取 `adapter_keys()` 并编辑静态 routes，没有适配器目录、实例配置、凭据写入、启停和连接状态 command，因此它本质上是“路由概览页”，不是适配器管理器。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src-tauri/src/gateway/mod.rs:20-22`
  - 生产模块只有 `pub mod qq`，没有微信或其他平台实现。
- `G:/Project/prism-desktop/src-tauri/src/gateway/mod.rs:36-53,134-160`
  - 有通用 PlatformAdapter trait 和 adapters registry，架构允许多平台。
- `G:/Project/prism-desktop/src-tauri/src/gateway/mod.rs:297-320`
  - register 只接受已经构造好的 Rust adapter 实例，没有前端可调用的创建/启停 command。
- `G:/Project/prism-desktop/src-tauri/src/gateway_cmds.rs:198-248`
  - gateway_status 只返回 adapter key/routes/qq/inject；reload_gateway 只热重载配置，并明确“凭据与已注册适配器不受影响（启动生效）”。
- `G:/Project/prism-desktop/src/sheets/gateway/GatewaySheetView.tsx:78-146`
  - UI 只有已注册适配器列表、平台会话、路由新增和 inject 只读信息。
- `G:/Project/prism-desktop/src/infrastructure/tauri/gatewayClient.ts:11-17`
  - 无 list catalog、configure、start、stop、test adapter command。

解决方案：

方案 A（推荐，适配器商店 + 实例生命周期）：
- 改动位置：Gateway 后端 adapter registry/lifecycle、新增 adapter 配置模型和 commands；前端 GatewaySheet registry/client/view。
- 具体改法：
  1. 区分“平台类型”和“Bot 实例”：
     ```ts
     interface AdapterCatalogItem {
       platform: 'qq' | 'wechat' | string
       label: string
       availability: 'built-in' | 'not-installed' | 'unsupported'
       credentialFields: CredentialField[]
       capabilities: string[]
     }
     interface AdapterInstance {
       id: string
       platform: string
       label: string
       enabled: boolean
       status: 'stopped' | 'starting' | 'connected' | 'error'
       lastError?: string
     }
     ```
  2. 新增 commands：`gateway_adapter_catalog`、`gateway_adapter_instances`、`configure_gateway_adapter`、`start_gateway_adapter`、`stop_gateway_adapter`、`test_gateway_adapter`。
  3. 凭据不得经 gateway_status 回传明文。后端只返回 `configured: boolean`、脱敏 app id 尾号和错误状态；secret 使用受保护本地存储或环境引用。
  4. 把当前启动期 QQ 注册流程收敛为 adapter factory/lifecycle，由 `start_gateway_adapter(instanceId)` 创建 QqAdapter、启动 WS 并注册；stop 时取消任务、注销 registry、收敛发送队列。
  5. PlatformAdapter registry key 不能继续只用 `platform_key`，否则同平台无法多 Bot 实例；推荐 registry 以 instance id 为主键，source route 明确引用 adapter instance id。第一阶段若只允许每平台一个实例，也要在契约中显式限制。
  6. GatewaySheet 主区先展示平台卡片：QQ 标记 built-in；微信/其他只有后端实现存在时才可配置，未实现平台显示“未安装/待支持”，不能创建假适配器。
  7. 平台卡片完成凭据配置和连接成功后，才开放“新增路由”；route 编辑器选择 adapter instance、source、agent、profile、session、白名单和 reset 策略，不再让用户手写裸 source/agentId 两个输入框。
- 影响面：GatewaySheet 从只读/路由页升级为平台连接管理器；需要改后端适配器生命周期和配置契约。QQ 正常消息路由语义应保持，微信/其他平台必须分别实现真实 adapter 后才能启用。
- 验证方式：
  1. QQ 平台卡片可配置、测试连接、启动、停止、重启恢复。
  2. 错误凭据显示结构化错误且不泄露 secret。
  3. 适配器未连接时禁止或警告创建对应路由。
  4. 启动后 adapter instance 状态和 gateway_status 一致。
  5. stop 后不再 ingest/deliver，已有 session 的处置策略明确。
  6. 微信卡片在无实现时必须 disabled；实现后通过同一 catalog/instance contract 接入。
- 风险与取舍：这是架构级扩展，不是单纯前端补按钮；微信等平台的认证、事件、限流和消息能力不同，不能假设复用 QQ 凭据字段。商店只负责统一生命周期壳，各平台仍需独立 adapter 实现。

重构方案：

```text
Adapter Catalog（平台能力描述）
        ↓ 创建/配置
Adapter Instance（凭据引用 + 生命周期 + 状态）
        ↓ 绑定
Route（source/entity → adapter instance → agent/profile/session）
```

路由必须依赖适配器实例，而不是用 source 前缀隐式猜平台连接。

---

### 源码复核后的实施细化

1. 先冻结 adapter domain contract：catalog（平台类型）与 instance（具体 Bot）分离，route 只引用 instance id。
2. 第一切片只增加 `catalog`/`instances` 只读 command 和前端卡片，不宣称能创建微信/其他平台；当前生产 `gateway/mod.rs` 只有 `qq` 模块，`GatewayCore` 的 registry 只接受已构造的 `PlatformAdapter`。
3. 第二切片把启动期 QQ 注册抽成 factory，明确 credentials → adapter instance → task handle → registry key 的生命周期；stop 必须注销、取消 task、处理 pending delivery。
4. 第三切片才接 configure/start/stop/test commands，并建立 secret 不回传、错误码稳定、重启恢复和 reload 不影响运行实例的测试。
5. 依赖 #13：单活 GUI 仍可管理多实例，但 route 和 runtime 必须显式 agentId；不能让 `gateway_status` 的 adapter key 继续承担实例 identity。

可行性：架构基础存在，但方案 A 是低可行性的跨后端扩展；QQ 可先落地，微信/其他必须按真实协议逐个实现。

---


## 逐项验收清单

### 6.13 问题 #7：Gateway 适配器商店与实例生命周期

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| catalog/instance DTO | 平台类型与 Bot 实例分离；未实现平台状态稳定；secret 不序列化回前端 | `src-tauri/src/gateway*` Rust tests；gatewayContracts tests | [x]（I12-A-BE-01：`gateway/catalog.rs`+`gateway/instance.rs` wire 形状/secret 丢弃/未实现平台稳定测试；`gatewayClient.ts` 冻结 typed client 面。gatewayContracts 测试不在卡 scope.allow，未改） |
| QQ factory/lifecycle | configure/start/stop/restart 后 registry、task handle、状态一致 | Gateway Rust focused tests/fake adapter | [ ]（I12-A-BE-02） |
| route 绑定 | route 引用 adapter instance id；不存在/未连接实例返回明确错误 | Gateway route/command tests | [x]（I12-A-BE-01：`EntityBinding.instance_id` + wire `instanceId` + `resolve_route_status`（Active/Unbound/InstanceMissing/InstanceNotConnected）+ `GatewayError::InstanceNotFound/InstanceNotConnected` 稳定码） |
| secret 与错误码 | 错误凭据不泄露 secret，返回结构化 error/status | Gateway command tests | [x]（I12-A-BE-01：`InstanceState::to_dto` 丢弃 secret、DTO 无凭据值字段、`to_dto_drops_credential_secret_never_serialized` + `instance_contract_error_codes_are_stable`） |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 平台卡片 | QQ 显示 built-in；微信/其他无实现时显示未安装/待支持且不可启用 | `http://localhost:5173/` → Gateway Sheet | [ ] |
| 实例配置 UI | 凭据字段、configured 状态、启停 pending/error、脱敏标识显示正确 | `http://localhost:5173/` → Gateway Sheet → 平台卡片 | [ ] |
| 路由依赖 | 未连接实例不能创建路由；连接后 route editor 可选择 instance/agent/profile/session | `http://localhost:5173/` → Gateway Sheet → 新增路由 | [ ] |
| 真实平台连接 | 网页模式无真实长连接，本等级只验 UI 与 mock contract | 同上 | [-] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| QQ 配置与测试连接 | 正确凭据连接成功；错误凭据显示结构化错误且不泄露 secret | 真实应用 → Gateway Sheet → QQ 卡片 | [ ] |
| start/stop | start 后可 ingest/deliver；stop 后不再收发，状态与 `gateway_status` 一致 | 真实应用 → Gateway Sheet；真实 QQ Bot | [ ] |
| 路由收发 | 平台消息按 adapter instance/source 路由到目标 Agent，回复返回同一平台实体 | 真实 QQ 群/私聊；Gateway Sheet；Runtime Sheet | [ ] |
| 重启恢复 | 应用重启后 enabled 实例按策略恢复；凭据无需重新明文输入 | Release `pylon.exe` → Gateway Sheet | [ ] |
| 未实现平台 | 微信/其他没有真实 adapter 时始终不可启用，不出现假成功 | 真实应用 → Gateway Sheet | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-10 | BE-01 契约冻结 | I12-A-BE-01：冻结 adapter catalog/instance/route domain contract——`gateway/catalog.rs`（PlatformAvailability/CredentialField/AdapterCapabilities/AdapterCatalogItem + `builtin_catalog`）、`gateway/instance.rs`（InstanceStatus/CredentialStatus/AdapterInstance + `InstanceState::to_dto` secret 丢弃）、`EntityBinding.instance_id`（yaml `instance`/wire `instanceId`）+ `resolve_route_status`（D-04 disabled 语义）、`GatewayError::InstanceNotFound/InstanceNotConnected` 稳定码、`gateway_catalog` 只读命令、`gatewayClient.ts` catalog/instances typed 面。证据：`cargo test --lib` 439 passed / 0 failed；focused `cargo test --lib --no-run` 绿（本机内存受限以 `--jobs 1` 跑）。QQ factory/lifecycle 留待 I12-A-BE-02。 | I12-A-BE-01 |
| 2026-08-09 | 产品拍板 | 删除 Gateway adapter instance 后保留引用 Route，标记 disabled/实例不存在，不级联删除。 | 对应未决策项：Gateway 删除实例后的 Route 处理 |
| 2026-08-09 | 产品拍板 | 停止 Gateway Bot 实例时同时关闭其平台 Session；Route 保留，重启后重新建立 Session。 | 对应未决策项：Gateway stop 后平台 Session 处理 |
| 2026-08-09 | 产品拍板 | Gateway 每个 adapter instance 独立 autoStart；新实例默认关闭，只有显式开启后才在 Pylon 重启时自动启动。 | 对应未决策项：Gateway 实例重启后的自动启动 |
| 2026-08-09 | 产品拍板 | 导出包含凭据与主密钥的未加密备份时显示普通风险提示，不要求二次确认。 | 对应未决策项：未加密备份风险提示 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| 后端已有通用 Adapter trait/registry | 属实 | `src-tauri/src/gateway/mod.rs:36-53,138-163,299-315` | 在现有 registry 上新增 catalog/instance/factory，不平行重写 Gateway。 |
| 前端已有实例生命周期 API | 不属实 | `src/infrastructure/tauri/gatewayClient.ts:4-15` 只有 status/sessions/reload | 新增 catalog/instances/configure/start/stop/test typed client。 |
| reload 可创建/停止 adapter | 不属实 | `src-tauri/src/gateway_cmds.rs:198-248` 仅热重载配置 | QQ 启动期注册抽成 factory/lifecycle。 |
| 加密实施契约未决 | 已解决 | ISSUE-12 D-08 | 按 AES-256-GCM envelope、ACL、原子写、轮换和损坏恢复实施。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- ✅ Gateway 当前确有通用 `PlatformAdapter`/registry，但生产模块仅有 QQ，`gateway_status` 只返回已注册 key/routes，未提供 catalog/instance lifecycle commands。证据：`src-tauri/src/gateway/mod.rs:36-53,138-160,299-315`、`src-tauri/src/gateway_cmds.rs:198-248`、`src/infrastructure/tauri/gatewayClient.ts`。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I12-A-BE-01` | BE | A | I01-A-BE-01 | 冻结 adapter catalog/instance/route domain contract；平台类型、实例 identity、route binding 分离；secret 只返回 ref/脱敏状态。 | L1 |
| `I12-A-BE-02` | BE | A | I12-A-BE-01 | QQ adapter factory/start/stop lifecycle；registry/task/session/queue 在 start/stop/restart 收敛，不能重复注册。 | L3 |
| `I12-A-SEC-01` | SEC | A | I12-A-BE-01 | 凭据加密文件与备份实施契约；先完成算法、格式、ACL、损坏恢复和备份风险契约；不得自行改变已拍板备份行为。 | L3 |
| `I12-B-UX-01` | UX | B | I12-A-BE-01 | Gateway 卡片/启停/风险提示视觉；只改视觉承载；未实现平台不可伪造可用，凭据不回显。 | L2 |
| `I12-A-TEST-01` | TEST | S | I12-A-BE-02, I12-A-SEC-01 | 真实 QQ Gateway 收发与重启恢复；真实 start/stop/route/restart 证据，错误不泄露 secret。 | L3 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
