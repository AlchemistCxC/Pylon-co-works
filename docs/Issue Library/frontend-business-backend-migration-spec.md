# Pylon 前端业务后端化规格

- 项目：`G:\Project\prism-desktop`
- 文档性质：实施规格，不直接修改产品行为
- 范围：第一优先级“消息快照持久化与搜索”、第二优先级“Profile / Session 用户数据持久化”
- 技术约束：Tauri v2 + React + TypeScript + Rust
- 总体原则：后端接管持久化、校验、迁移、搜索和原子事务；前端继续持有 React / Zustand 运行时状态与 UI 决策

---

## 0. 总体结论与边界

### 0.1 推荐实施顺序

1. `DS-01`：消息快照后端存储基础设施
2. `DS-02`：消息快照保存、读取、删除 command
3. `DS-03`：前端消息持久化接线与并发收敛
4. `DS-04`：跨会话消息搜索下沉
5. `DS-05`：旧 `localStorage` 消息快照迁移
6. `DS-06`：Profile / Session 统一用户数据存储
7. `DS-07`：Profile / Session 加载与保存接线
8. `DS-08`：Profile 删除原子事务下沉
9. `DS-09`：Session 删除持久化编排
10. `DS-10`：配置导入导出适配

### 0.2 明确保留在前端

以下逻辑不得下沉：

- `src/components/chat/sessionRuntimeStore.ts` 中的 Chat 运行时 reducer
- `src/components/chat/chatEventController.ts` 中的前端事件消费和 React 同步
- Zustand store 的即时 UI 状态
- Sheet 打开、聚焦、关闭、恢复等交互决策
- Theme、CSS 变量、动画、滚动和窗口内临时状态
- ACP replay 与前端 `Message[]` 的合并决策

### 0.3 两种 Session 模型不得合并

前端持久化 Session：

```ts
interface Session {
  id: string
  periId?: string
  source: string
  profileId: string
  // 用户界面与本地目录字段
}
```

后端运行时 Session：

```rust
struct SessionInfo {
    peri_id: String,
    generation: u64,
    // ACP 运行时字段
}
```

必须保留以下映射：

```text
Frontend Session.id
  -> Frontend Session.source
  -> Backend runtime.sessions[source]
  -> Backend SessionInfo.peri_id
```

`Session.id` 是 Pylon 本地用户数据主键；`peri_id` 是 ACP 远端会话标识，二者不可互换。

---

# 第一部分：消息快照持久化与搜索

## DS-01：消息快照后端存储基础设施

### 推荐项

**推荐：每个前端 Session 一个 versioned JSON 文件，使用 AppData 目录和原子替换。**

暂不推荐 SQLite。只有在会话数量、搜索耗时或多进程并发达到文件方案瓶颈后，再升级为 SQLite。

### 改动位置

新增：

```text
src-tauri/src/message_store.rs
```

修改：

```text
src-tauri/src/lib.rs
  - 顶部模块声明区
  - AppState 字段区
  - Tauri Builder 构造 AppState 的位置

src-tauri/src/error.rs
  - PylonError 枚举
  - PylonError::code()
  - error code 稳定性测试
```

### 具体改法

#### 1. 新增存储模型

```rust
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const MESSAGE_SNAPSHOT_VERSION: u32 = 1;
pub(crate) const MAX_MESSAGES_PER_SESSION: usize = 20_000;
pub(crate) const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_SEARCH_LIMIT: usize = 200;
pub(crate) const MAX_SEARCH_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredMessageSnapshot {
    pub version: u32,
    pub session_id: String,
    pub updated_at: u64,
    pub messages: Vec<serde_json::Value>,
}

pub(crate) struct MessageStore {
    root: PathBuf,
    write_lock: tokio::sync::Mutex<()>,
}
```

第一阶段将单条前端消息保留为 `serde_json::Value`，后端只校验持久化和搜索依赖的稳定字段：

- 顶层必须是消息数组
- 数量不得超过上限
- 单次快照序列化结果不得超过上限
- 搜索时只读取 `id`、`content`、`time`

不在第一阶段把所有前端 `Message` 变体复制为 Rust struct，避免 tool、reasoning、plan 等字段扩展导致双端 schema 高频同步。

#### 2. 存储路径

推荐目录：

```text
<AppData>/pylon/messages/<encoded-session-id>.json
```

通过 `tauri::Manager` 获取路径：

```rust
pub(crate) fn resolve_message_store_root(
    app: &tauri::AppHandle,
) -> Result<PathBuf, PylonError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| PylonError::MessageStore(error.to_string()))?
        .join("pylon")
        .join("messages");

    std::fs::create_dir_all(&root)
        .map_err(|error| PylonError::MessageStore(error.to_string()))?;

    Ok(root)
}
```

不要把原始 `session_id` 无校验地拼接为路径。推荐以 session id 的 UTF-8 字节做十六进制编码：

```rust
fn file_name_for_session(session_id: &str) -> Result<String, PylonError> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return Err(PylonError::MessageStore(
            "invalid message session id".to_string(),
        ));
    }

    let encoded = trimmed
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    Ok(format!("{encoded}.json"))
}
```

这样不需要猜测前端 Session id 将来允许哪些字符，也消除路径穿越风险。

#### 3. 原子写入

`MessageStore::save` 必须：

1. 在进入磁盘操作前完成 JSON 序列化与字节上限检查
2. 获取 `write_lock`
3. 写同目录唯一临时文件
4. `write_all`
5. `sync_all`
6. Windows 下先处理目标替换
7. rename 临时文件到正式文件
8. 失败时删除临时文件

推荐为每次写入生成不同临时文件名，避免异常退出遗留 `.tmp` 与下一次写入冲突：

```rust
fn temporary_path(path: &Path) -> PathBuf {
    let nonce: u64 = rand::random();
    path.with_extension(format!("json.{nonce}.tmp"))
}
```

同步文件 I/O 必须由 command 层放入 `tokio::task::spawn_blocking`，不得直接阻塞 async runtime。

#### 4. 读取与损坏处理

`MessageStore::load` 的语义：

- 文件不存在：返回空快照，不报错
- JSON 损坏：返回 `message_store_corrupt`，不得 panic
- 未知 version：返回 `message_store_version_unsupported`
- session id 与文件内 `sessionId` 不一致：返回损坏错误
- 合法文件：返回完整快照

不得在损坏时直接覆盖原文件。用户下一次成功保存时才由正常写入替换。

#### 5. AppState 接入

`src-tauri/src/lib.rs` 顶部新增：

```rust
mod message_store;
mod message_cmds;
```

`AppState` 新增：

```rust
pub(crate) message_store: Arc<message_store::MessageStore>,
```

在创建 `AppState` 前解析路径并构造：

```rust
let message_store_root = message_store::resolve_message_store_root(app.handle())?;
let message_store = Arc::new(message_store::MessageStore::new(message_store_root));
```

如果当前 Builder 结构不方便在 `.manage(AppState { ... })` 前取得 `AppHandle`，可以在 `.setup()` 中构造并通过独立 `.manage(MessageStore)` 管理。两种方案中推荐：

- `MessageStore` 不需要访问其他 AppState 字段时，直接 `manage(MessageStore)`
- command 使用 `tauri::State<'_, MessageStore>`
- 避免扩大 `AppState` 和 `AppStateHandles`

**推荐采用独立 managed state。**

#### 6. 错误类型

`src-tauri/src/error.rs` 新增：

```rust
#[error("Message store error: {0}")]
MessageStore(String),
```

错误码：

```rust
Self::MessageStore(_) => "message_store_error",
```

如果要让前端精确区分损坏和版本不支持，推荐第二步再拆为独立 enum；第一阶段保持单一稳定 code，message 仅用于展示和日志。

### 影响面

- 不改变 Chat UI 和消息模型
- 不改变 ACP `session/load`、replay、`session/update` 事件
- 不改变消息合并行为
- 改变持久化介质：Tauri 模式从 `localStorage` 改为 AppData 文件
- 浏览器 demo 模式继续使用 `localStorage`

### 验证方式

后端单元测试：

1. 保存后可按 session id 读取
2. 空消息数组可以保存
3. 文件不存在返回空快照
4. JSON 损坏返回结构化错误
5. 未知 version 返回错误
6. 空 session id 被拒绝
7. 超长 session id 被拒绝
8. 路径字符不会逃逸 root
9. 超过消息数量限制被拒绝
10. 超过字节限制被拒绝
11. 临时文件在失败后被清理
12. 并发保存最终得到完整 JSON，不出现半文件

真实验证：

```text
启动 Pylon
→ 打开一个会话并产生消息
→ 关闭应用
→ 检查 AppData 消息文件存在且 JSON 可解析
→ 重启应用
→ 消息恢复成功
```

### 风险与取舍

- JSON 文件方案搜索为线性扫描，但改动小、可审计、迁移简单
- SQLite 查询更强，但第一阶段会额外引入数据库 schema、连接、迁移和锁管理
- `serde_json::Value` 类型安全较弱，但能避免复制完整前端展示 schema
- 后端必须限制文件大小，否则恶意或异常前端可写入超大快照

---

## DS-02：消息保存、读取、删除 command

### 推荐项

**推荐：增加独立 message commands，不改 `src-tauri/src/session/` 中现有 ACP 生命周期 command。**

### 改动位置

新增：

```text
src-tauri/src/message_cmds.rs
```

修改：

```text
src-tauri/src/lib.rs
  - generate_handler![] 注册区
```

### 具体改法

#### 1. 保存 command

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveMessageSnapshotRequest {
    pub session_id: String,
    pub messages: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveMessageSnapshotResult {
    pub session_id: String,
    pub message_count: usize,
    pub bytes: usize,
    pub updated_at: u64,
}

#[tauri::command]
pub(crate) async fn save_message_snapshot(
    store: tauri::State<'_, MessageStore>,
    session_id: String,
    messages: Vec<serde_json::Value>,
) -> Result<SaveMessageSnapshotResult, PylonError> {
    // 构造 versioned envelope，spawn_blocking 写入
}
```

Tauri command 参数直接使用 `session_id` 和 `messages`，前端调用时 camelCase：

```ts
invoke('save_message_snapshot', { sessionId, messages })
```

不要再套一层 `{ request: ... }`，除非项目现有 Tauri command 全部采用 request wrapper。当前 command 多数直接暴露参数，因此保持项目现状。

#### 2. 读取 command

```rust
#[tauri::command]
pub(crate) async fn load_message_snapshot(
    store: tauri::State<'_, MessageStore>,
    session_id: String,
) -> Result<StoredMessageSnapshot, PylonError>
```

文件不存在返回：

```json
{
  "version": 1,
  "sessionId": "s1",
  "updatedAt": 0,
  "messages": []
}
```

#### 3. 删除 command

```rust
#[tauri::command]
pub(crate) async fn clear_message_snapshot(
    store: tauri::State<'_, MessageStore>,
    session_id: String,
) -> Result<(), PylonError>
```

语义：

- 文件存在：删除
- 文件不存在：成功
- 其他 I/O 错误：返回 `message_store_error`

#### 4. 注册 command

`src-tauri/src/lib.rs` 的 `generate_handler![]` 新增：

```rust
crate::message_cmds::save_message_snapshot,
crate::message_cmds::load_message_snapshot,
crate::message_cmds::clear_message_snapshot,
```

### 影响面

- 新增 IPC，不改现有 command wire
- 不改变 `load_persisted_session` 语义
- 不改变 `export_session` 从 ACP replay 导出的语义
- 前端消息快照和 ACP replay 继续保持两套职责

### 验证方式

使用 Tauri test 或真实 invoke 验证：

```text
save_message_snapshot(s1, A)
→ load_message_snapshot(s1) == A
→ clear_message_snapshot(s1)
→ load_message_snapshot(s1).messages == []
```

验证错误 DTO：

```json
{
  "code": "message_store_error",
  "message": "..."
}
```

### 风险与取舍

- command 传完整 `Message[]`，单次 IPC 载荷随长会话增长
- 当前前端本来就在做完整 JSON 快照，因此第一阶段行为和成本模型可控
- 后续若快照明显过大，再设计增量 append command；第一阶段不要同时重构消息事件模型

---

## DS-03：前端消息持久化接线与并发收敛

### 推荐项

**推荐：Tauri 模式使用 typed `messageClient`；浏览器模式保留现有 localStorage adapter。写入采用 per-session single-flight，禁止旧写覆盖新写。**

### 改动位置

新增：

```text
src/infrastructure/tauri/messageContracts.ts
src/infrastructure/tauri/messageClient.ts
src/components/chat/messagePersistenceAdapter.ts
```

修改：

```text
src/components/chat/messagePersistScheduler.ts
  - PersistSchedulerOptions
  - flushNow / flushAll
  - 应用级单例构造

src/components/chat/useMessagePersistence.ts
  - 注释和 force flush 接线

src/components/chat/useSessionLifecycle.ts
  - 当前 localStorage cached 读取区
  - replay 成功后的 localStorage 写回区

src/components/chat/chatEventController.ts
  - 后台消息调用 scheduler 的位置

src/components/chat/messagePersistence.ts
  - 保留 schema parse/legacy adapter
```

### 具体改法

#### 1. Typed client

`messageContracts.ts`：

```ts
import type { Message } from '../../components/chat/messageTypes'

export interface StoredMessageSnapshot {
  version: number
  sessionId: string
  updatedAt: number
  messages: Message[]
}

export interface SaveMessageSnapshotResult {
  sessionId: string
  messageCount: number
  bytes: number
  updatedAt: number
}

export function normalizeStoredMessageSnapshot(raw: unknown): StoredMessageSnapshot {
  if (!raw || typeof raw !== 'object') {
    return { version: 1, sessionId: '', updatedAt: 0, messages: [] }
  }
  const value = raw as Record<string, unknown>
  return {
    version: typeof value.version === 'number' ? value.version : 1,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    messages: Array.isArray(value.messages) ? value.messages as Message[] : [],
  }
}
```

`messageClient.ts`：

```ts
import type { ClientTransport } from '../acp/agentClient'
import { normalizeStoredMessageSnapshot } from './messageContracts'

export function createMessageClient(transport: ClientTransport) {
  return {
    saveSnapshot: (sessionId: string, messages: readonly unknown[]) =>
      transport.invoke('save_message_snapshot', { sessionId, messages }),

    loadSnapshot: (sessionId: string) =>
      transport.invoke('load_message_snapshot', { sessionId })
        .then(normalizeStoredMessageSnapshot),

    clearSnapshot: (sessionId: string) =>
      transport.invoke('clear_message_snapshot', { sessionId }),
  }
}
```

#### 2. Persistence adapter

```ts
export interface MessagePersistenceAdapter {
  load(sessionId: string): Promise<Message[]>
  save(sessionId: string, messages: readonly Message[]): Promise<void>
  clear(sessionId: string): Promise<void>
}
```

实现两个 adapter：

```text
TauriMessagePersistence
LocalStorageMessagePersistence
```

Tauri adapter 通过 `messageClient`；localStorage adapter 复用：

```text
parseMessageSnapshot
persistMessageSnapshot
clearMessageStorage
```

调用方通过 `IS_TAURI` 选择，不在 React 组件内重复写分支。

#### 3. Scheduler 异步化和 single-flight

当前 scheduler 的 `persist` 是同步 `void`，必须改为：

```ts
persist: (
  sessionId: string,
  messages: readonly unknown[],
) => Promise<void>
```

内部至少维护：

```ts
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const dirty = new Map<string, readonly unknown[]>()
const inFlight = new Map<string, Promise<void>>()
const flushRequested = new Set<string>()
```

推荐算法：

```ts
async function drain(sessionId: string): Promise<void> {
  if (inFlight.has(sessionId)) {
    flushRequested.add(sessionId)
    return inFlight.get(sessionId)
  }

  const run = (async () => {
    do {
      flushRequested.delete(sessionId)
      const pending = dirty.get(sessionId)
      if (pending === undefined) break
      dirty.delete(sessionId)
      await persist(sessionId, pending)
    } while (flushRequested.has(sessionId) || dirty.has(sessionId))
  })().finally(() => {
    inFlight.delete(sessionId)
  })

  inFlight.set(sessionId, run)
  return run
}
```

`markDirty`：

```ts
markDirty(sessionId, messages, force = false) {
  dirty.set(sessionId, messages)
  if (inFlight.has(sessionId)) flushRequested.add(sessionId)
  if (force) {
    clearTimer(sessionId)
    void drain(sessionId)
    return
  }
  resetTrailingTimer(sessionId, () => void drain(sessionId))
}
```

`flushAll` 应返回 Promise：

```ts
flushAll(): Promise<void>
```

应用真正退出时是否能等待 Promise 取决于当前窗口关闭链路。若无法可靠等待，则：

- 普通消息仍用 300ms debounce
- `done/error/cancel` 继续 force flush
- 切会话 force flush
- 不把应用卸载作为唯一数据安全保障

#### 4. 会话恢复

`src/components/chat/useSessionLifecycle.ts` 当前同步读取 `localStorage`，改为异步加载 adapter。

推荐将 session effect 主体收敛为内部 async 函数：

```ts
useEffect(() => {
  let disposed = false
  const loadGeneration = nextLoadGeneration(...)

  void (async () => {
    const cached = await messagePersistence.load(s.id)
    if (disposed || !isCurrentLoadGeneration(...)) return

    const stableCached = cached.map(message => ({
      ...message,
      running: false,
    }))

    const messages = controllerHandleRef.current
      ? controllerHandleRef.current.initSource(s.source, stableCached)
      : stableCached

    setMessages(messages)
    // 然后执行现有 new_session / load_persisted_session 流程
  })()

  return () => {
    disposed = true
  }
}, [sessionId])
```

必须保持：

- `sessionRef.current = s.source` 在异步等待前设置，避免 live event 丢失
- load generation 防止旧 session 的异步结果覆盖新 session
- cached 初始化必须发生在 `commitReplay` 前
- `running` 恢复为 `false`

#### 5. replay 成功后的写回

当前 `useSessionLifecycle.ts` 在 replay 成功后直接：

```ts
localStorage.setItem(...)
```

改为：

```ts
await messagePersistence.save(s.id, resolved)
```

保存失败：

- 不阻断 replay 成功状态
- 调用 `reportRuntimeError('保存会话消息', error)` 或进入统一持久化错误状态
- UI 继续显示 resolved messages

### 影响面

目标行为不变：

- 当前可见会话恢复相同消息
- 后台会话继续持久化
- replay 合并规则不变
- 终态继续强制 flush
- 写盘失败不导致 Chat 渲染失败

内部变化：

- scheduler 变成异步 single-flight
- 会话初始化增加后端加载等待
- 可先显示 loading 或保持当前空态，不能错误显示“无历史消息”

### 验证方式

前端测试：

1. 同一 session 的 A 写入未完成时产生 B，最终 B 一定最后保存
2. 多个 session 可并行写入，互不阻塞
3. force flush 会取消 debounce timer
4. persist reject 后 scheduler 不永久卡在 inFlight
5. reject 后产生新 dirty 能再次写入
6. session 快速切换时旧 load 不覆盖新 session
7. 后端 load 失败时迁移阶段可回退 localStorage
8. browser 模式不调用 Tauri command
9. replay 成功后调用后端 save
10. save 失败不丢失当前内存消息

### 风险与取舍

- 异步恢复会让首屏消息恢复晚于原同步 localStorage；需要 hydration 状态避免空态闪烁
- single-flight 增加 scheduler 复杂度，但这是避免乱序覆盖的必要条件
- 不推荐每条 ACP chunk 直接增量写后端，会显著放大 IPC 和磁盘写入次数

---

## DS-04：跨会话消息搜索下沉

### 推荐项

**推荐：第一阶段后端按文件线性扫描；搜索 command 使用 `spawn_blocking`；前端只负责防抖、展示和导航。**

### 改动位置

后端：

```text
src-tauri/src/message_store.rs
  - search 方法

src-tauri/src/message_cmds.rs
  - search_message_snapshots command

src-tauri/src/lib.rs
  - generate_handler![] 注册
```

前端：

```text
src/infrastructure/tauri/messageContracts.ts
src/infrastructure/tauri/messageClient.ts
src/sheets/search/SearchSheetView.tsx
src/domains/search/snapshotSearch.ts
```

### 具体改法

#### 1. 后端搜索 DTO

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageSearchResult {
    pub session_id: String,
    pub message_id: String,
    pub snippet: String,
    pub time: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageSearchResponse {
    pub results: Vec<MessageSearchResult>,
    pub truncated: bool,
}
```

#### 2. 搜索 command

```rust
#[tauri::command]
pub(crate) async fn search_message_snapshots(
    store: tauri::State<'_, MessageStore>,
    query: String,
    limit: Option<usize>,
) -> Result<MessageSearchResponse, PylonError>
```

规则：

- `query.trim()` 为空时直接返回空结果
- limit 缺省 200
- limit clamp 到 1..=500
- 文件遍历顺序必须稳定，按文件名排序
- 每个文件内按 messages 原顺序
- 只匹配 `content` 字符串
- 大小写不敏感
- snippet 保持现状：内容前 120 个 Unicode 字符，而不是前 120 个 UTF-8 字节
- 结果达到 limit 后停止并设置 `truncated = true`
- 单个损坏文件：记录 warning，跳过该文件；不要让全部搜索失败

Rust snippet 必须按 char 截断：

```rust
let snippet = content.chars().take(120).collect::<String>();
```

#### 3. 前端 client

```ts
searchSnapshots: (query: string, limit?: number) =>
  transport.invoke('search_message_snapshots', { query, limit })
    .then(normalizeMessageSearchResponse)
```

#### 4. SearchSheetView

删除 Tauri 模式下：

- 枚举 `localStorage.length`
- 构建 `snapshotKeys`
- 直接调用 `snapshotSearch(localStorage, ...)`

新增：

- 150ms trailing debounce
- request generation 或 Abort-like 序号
- loading 状态
- error 状态
- 仅接受最后一次 query 的响应

推荐结构：

```ts
const requestRef = useRef(0)

useEffect(() => {
  const value = query.trim()
  if (!value) {
    setResults([])
    setTruncated(false)
    return
  }

  const requestId = ++requestRef.current
  const timer = window.setTimeout(() => {
    void messageClient.searchSnapshots(value, 200)
      .then(response => {
        if (requestRef.current !== requestId) return
        setResults(response.results)
        setTruncated(response.truncated)
      })
      .catch(error => {
        if (requestRef.current !== requestId) return
        reportRuntimeError('搜索会话消息', error)
        setResults([])
        setTruncated(false)
      })
  }, 150)

  return () => window.clearTimeout(timer)
}, [query])
```

浏览器 demo 模式继续使用 `snapshotSearch`，因此该纯函数暂不删除。

### 影响面

不改变：

- 搜索框交互
- 结果字段
- 点击结果导航
- 空结果展示
- 截断提示

可能产生的细微差异：

- Rust `to_lowercase()` 与 JS `toLocaleLowerCase()` 对极少数 Unicode 字符的语义不同
- 文件遍历顺序改为稳定排序后，跨 session 结果顺序可能比当前 localStorage key 枚举更稳定，但不保证逐字相同

如果产品要求结果顺序完全不变，需要先定义现有顺序是否属于业务契约。推荐将稳定排序视为内部改进，不承诺 localStorage 枚举顺序。

### 验证方式

1. 中文搜索
2. ASCII 英文大小写搜索
3. 数字和标点搜索
4. 内容超过 120 字符时按字符正确截断
5. 多 session 顺序稳定
6. 达到 limit 时 `truncated = true`
7. 损坏一个文件不影响其他文件结果
8. 快速输入多个 query 时只显示最后一次结果
9. 点击结果仍写入 `pendingMessageLocation` 并打开正确 session

### 风险与取舍

- 文件线性扫描的复杂度为 O(全部已保存消息)
- 第一阶段已有硬结果上限，但没有硬扫描消息上限；建议增加 `MAX_SCANNED_MESSAGES`，例如 100_000
- 搜索达到扫描上限同样设置 `truncated = true`
- 后续性能不够时再增加内存索引或 SQLite FTS，不改变前端 command 契约

---

## DS-05：旧 localStorage 消息快照迁移

### 推荐项

**推荐：按 session 懒迁移，不做启动时全量迁移。后端保存成功后删除对应旧 key。**

### 改动位置

```text
src/components/chat/messagePersistence.ts
src/components/chat/messagePersistenceAdapter.ts
src/components/chat/useSessionLifecycle.ts
src/sheets/search/SearchSheetView.tsx
```

### 具体改法

Tauri 模式加载某 session 时：

```text
1. load_message_snapshot(sessionId)
2. 后端 messages 非空：直接使用
3. 后端为空：检查 localStorage 的 pylon-msgs-${sessionId}
4. legacy 有合法消息：save_message_snapshot
5. 后端保存成功：删除旧 localStorage key
6. 后端保存失败：保留旧 key，下次重试
```

为区分“后端文件不存在”和“合法空快照”，推荐 `load_message_snapshot` 返回：

```json
{
  "found": false,
  "version": 1,
  "sessionId": "s1",
  "updatedAt": 0,
  "messages": []
}
```

因此 DTO 应增加：

```rust
pub found: bool
```

不能仅通过 `messages.length === 0` 判断是否需要迁移，因为用户可能确实清空过消息。

迁移函数：

```ts
async function loadWithLegacyMigration(sessionId: string): Promise<Message[]> {
  const backend = await tauriAdapter.loadSnapshot(sessionId)
  if (backend.found) return backend.messages

  const legacy = localStorageAdapter.loadSync(sessionId)
  if (legacy.length === 0) return []

  await tauriAdapter.save(sessionId, legacy)
  localStorageAdapter.clearSync(sessionId)
  return legacy
}
```

搜索迁移问题：

- 未被打开过的旧 session 仍在 localStorage，后端搜索不到
- 为保持迁移期跨会话搜索完整性，推荐搜索页第一次使用时执行一次“仅枚举 key 的批量迁移”
- 批量迁移逐个 session 保存，失败保留 key，成功删除 key
- 加进程级标记，当前启动周期只执行一次

可选方案：

- 方案 A，推荐：搜索页首次打开时迁移全部旧消息 key
- 方案 B：应用启动时迁移全部 key，冷启动成本不可控
- 方案 C：永久双搜后端和 localStorage，迁移长期不收敛

### 影响面

- 旧用户消息不会因切换存储介质而丢失
- 某个 session 第一次打开时会多一次后端保存
- 搜索页第一次打开可能有短暂迁移 loading

### 验证方式

1. 仅有旧 localStorage 快照时可以恢复
2. 迁移成功后旧 key 被删除
3. 保存失败时旧 key 保留
4. 后端已有空快照时不错误导入旧数据
5. 搜索页首次打开后可搜索未打开过的旧 session
6. 重复迁移幂等

### 风险与取舍

- 懒迁移降低冷启动成本，但必须额外处理搜索完整性
- 全量迁移更简单，但可能在大量消息时阻塞首屏
- 推荐使用懒迁移 + 搜索页一次性迁移

---

# 第二部分：Profile / Session 用户数据持久化

## DS-06：Profile / Session 统一用户数据存储

### 推荐项

**推荐：后端使用一个 versioned `user-data.json` 原子存储 profiles、activeProfileId 和 frontend sessions。**

不推荐把数据并入后端 `SessionInfo`，也不推荐第一阶段拆成 profiles、sessions 两个文件，因为 Profile 删除需要跨集合原子更新。

### 改动位置

新增：

```text
src-tauri/src/user_store.rs
src-tauri/src/user_cmds.rs
```

修改：

```text
src-tauri/src/lib.rs
  - 模块声明
  - manage UserStore
  - generate_handler![]

src-tauri/src/error.rs
  - UserStore 错误变体和 code
```

### 具体改法

#### 1. 数据模型

```rust
pub(crate) const USER_DATA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileRecord {
    pub id: String,
    pub name: String,
    pub persona: String,
    pub model: String,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecord {
    pub id: String,
    pub peri_id: Option<String>,
    pub name: String,
    pub source: String,
    pub profile_id: String,
    pub created_at: u64,
    pub last_active_at: u64,
    pub platform: String,
    pub workdir: String,
    pub session_prompt: String,
    pub skills: Vec<String>,
    pub hooks: Vec<String>,
    pub auto_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserDataEnvelope {
    pub version: u32,
    pub profiles: Vec<ProfileRecord>,
    pub active_profile_id: String,
    pub sessions: Vec<SessionRecord>,
    pub revision: u64,
}
```

虽然第一阶段不实现多进程冲突检测，也建议从 v1 起保存 `revision`：

- 每次后端成功写入 `revision + 1`
- 前端暂时只回读，不必携带 expected revision
- 后续增加乐观锁时无需迁移文件结构

#### 2. 默认值归属

当前默认 Profile 在 `src/identityStore.ts`：

```text
riccati
serina
```

推荐第一阶段仍由前端传入初始化默认值，而不是在 Rust 复制 persona 和 model 文本。

`load_user_data` 文件不存在时返回：

```json
{
  "found": false,
  "version": 1,
  "profiles": [],
  "activeProfileId": "",
  "sessions": [],
  "revision": 0
}
```

前端发现 `found=false` 后：

1. 使用现有 `DEFAULT_PROFILES`
2. 导入旧 localStorage 数据
3. 调用 `save_user_data`

这样默认产品配置仍由前端单源维护，避免 Rust 和 TypeScript 两份默认 persona 漂移。

#### 3. Normalize 规则

后端保存前必须执行：

Profile：

- id trim 后不能为空
- id 去重，重复 id 返回校验错误，不静默丢弃写入请求
- name 空时规范化为 `profile-${id}` 或返回错误；推荐保持现有前端语义，使用 fallback
- persona、model 接受空字符串
- avatar 空白转 None

Session：

- id trim 后不能为空
- id 不得重复
- source trim 后不能为空；为空时 fallback `local:${id}`，保持现有前端语义
- profileId 不存在时 fallback 到第一个 Profile
- name 空时 fallback `session-${id}`
- createdAt、lastActiveAt 必须是有限非负整数
- skills、hooks 只保留字符串

全局：

- profiles 为空的保存请求应拒绝，防止后端写出不可恢复状态
- activeProfileId 不存在时 fallback 到第一个 Profile
- Session profile fallback 与 active profile fallback 必须在同一 normalize 中完成

#### 4. 存储路径与原子写

推荐：

```text
<AppData>/pylon/user-data.json
```

使用独立：

```rust
pub(crate) struct UserStore {
    path: PathBuf,
    write_lock: tokio::sync::Mutex<()>,
}
```

所有 read-modify-write command 必须持有同一 `write_lock` 覆盖完整事务：

```text
lock
→ read current
→ normalize/mutate
→ serialize
→ atomic write
→ unlock
```

不能只在最后写文件时加锁，否则两个并发删除/保存都可能基于同一个旧版本计算并互相覆盖。

#### 5. 错误类型

`PylonError` 新增：

```rust
#[error("User data error: {0}")]
UserData(String),
```

错误码：

```rust
Self::UserData(_) => "user_data_error",
```

校验错误如果需要前端精确展示，可后续拆分 `user_data_validation_error`；第一阶段不依赖 message 文案分支。

### 影响面

- 不改变 Profile / Session 前端类型
- 不改变 ACP runtime session
- 不改变新建、恢复、关闭远端 session 的 command
- Profile 与 Session 持久化从两个 localStorage envelope 改为一个后端原子文件
- 浏览器 demo 继续使用现有 localStorage 实现

### 验证方式

后端测试：

1. 文件不存在返回 `found=false`
2. 保存后可完整加载
3. activeProfileId fallback
4. Session profileId fallback
5. 重复 Profile id 拒绝
6. 重复 Session id 拒绝
7. 空 Profile 列表拒绝
8. 损坏 JSON 返回结构化错误，不覆盖原文件
9. read-modify-write 并发不会丢更新
10. revision 每次成功写入递增

### 风险与取舍

- 统一文件让 Profile 删除具备事务性，但任意 Session 更新都会重写整个文件
- 当前 Profile/Session 数据量小，整体重写成本可接受
- 如果未来 Session 数量达到数万，应改用数据库；前端 command 契约可保持不变

---

## DS-07：Profile / Session 加载与保存接线

### 推荐项

**推荐：增加 IdentityPersistence adapter；Tauri 模式后端保存，browser 模式复用现有 localStorage。Zustand 继续即时更新，保存失败通过 `lastPersistError` 暴露。**

### 改动位置

新增：

```text
src/infrastructure/tauri/userContracts.ts
src/infrastructure/tauri/userClient.ts
src/infrastructure/tauri/identityPersistence.ts
src/infrastructure/local/identityPersistence.ts
```

修改：

```text
src/identityStore.ts
  - hydrateProfiles / hydrateSessions
  - setActiveProfile
  - addProfile
  - addSession
  - updateSession
  - setSessionPeriId

src/app/bootstrap/bootstrapApplication.ts
  - identity hydration 加入统一 bootstrap

src/App.tsx
  - hydrateDomains 接线

src/profilePersistence.ts
src/sessionPersistence.ts
  - 保留 browser / migration 纯函数，不再作为 Tauri 主存储
```

### 具体改法

#### 1. User commands

`user_cmds.rs` 第一阶段新增：

```rust
load_user_data
save_user_data
```

签名：

```rust
#[tauri::command]
pub(crate) async fn load_user_data(
    store: tauri::State<'_, UserStore>,
) -> Result<LoadUserDataResult, PylonError>

#[tauri::command]
pub(crate) async fn save_user_data(
    store: tauri::State<'_, UserStore>,
    data: UserDataEnvelope,
) -> Result<UserDataEnvelope, PylonError>
```

保存 command 返回后端 normalize 且 revision 已更新的完整 envelope。前端不得假设输入一定原样保存。

#### 2. Typed client

```ts
export function createUserClient(transport: ClientTransport) {
  return {
    loadUserData: () =>
      transport.invoke('load_user_data')
        .then(normalizeUserDataEnvelope),

    saveUserData: (data: UserDataEnvelope) =>
      transport.invoke('save_user_data', { data })
        .then(normalizeUserDataEnvelope),
  }
}
```

#### 3. Adapter

```ts
export interface IdentityPersistence {
  load(defaultProfiles: readonly Profile[]): Promise<IdentitySnapshot>
  save(snapshot: IdentitySnapshot): Promise<IdentitySnapshot>
}
```

Tauri adapter：

- 调 `load_user_data`
- `found=false` 时执行旧数据迁移
- 调 `save_user_data`
- 返回后端 normalize 结果

Local adapter：

- 调现有 `loadProfiles`、`loadSessions`
- 调现有 `persistProfiles`、`persistSessions`
- 用 Promise 包装，保持调用层接口一致

#### 4. Bootstrap hydration

当前 App bootstrap 的 `hydrateDomains` 只明确调用 workspace hydration。推荐把 identity hydration 纳入统一事务：

```ts
hydrateDomains: async () => {
  await useIdentityStore.getState().hydrateIdentity()
  useWorkspaceStore.getState().hydrateWorkspaceSheets()
}
```

因此 `bootstrapApplication` 的依赖类型应允许：

```ts
hydrateDomains: () => void | Promise<void>
```

并在 bootstrap 内：

```ts
await deps.hydrateDomains()
```

顺序：

```text
load user data
→ profiles/sessions ready
→ hydrate workspace
→ fetch agents
→ prune agent sheets
→ register listeners
```

这样 workspace 和 session 关联校验可以使用已恢复的 identity 状态。

#### 5. Store 保存语义

普通交互 action 推荐：

```text
立即更新 Zustand 内存
→ 异步保存完整 identity snapshot
→ 保存成功应用后端 revision/normalize 结果
→ 保存失败设置 lastPersistError
```

为避免连续 action 乱序覆盖，identity 保存也必须 single-flight/coalescing。建议新增 store 外部协调器：

```text
src/infrastructure/tauri/identitySaveScheduler.ts
```

语义与消息 scheduler 相同：

- 一次只保存一个完整 identity snapshot
- 保存期间出现新状态，只保留最新 snapshot
- 旧请求完成后继续保存最新 snapshot
- 后端返回结果只在没有更新 snapshot 排队时回写 store，避免旧 normalize 结果覆盖新内存状态

`setSessionPeriId` 等 action 不应直接各自 `await invoke`。

### 影响面

保持：

- Profile 切换即时响应
- 新建 Session 立即出现在 UI
- 保存失败不阻断当前操作
- `lastPersistError` 继续提示未保存

变化：

- hydration 从同步 localStorage 变为异步后端读取
- 应用启动必须等待 identity hydration 完成后再进入 ready
- 连续更新通过 coalescing 减少写盘

### 验证方式

1. Profile 切换立即更新 UI
2. 保存失败设置 `lastPersistError`
3. 后续保存成功清除错误
4. 连续更新 A/B 最终后端保存 B
5. hydrate 完成前不错误创建默认重复 Session
6. 重启后 Profile / Session 完整恢复
7. browser demo 不依赖 Tauri
8. bootstrap identity 失败进入 failed/retry 状态

### 风险与取舍

- 异步 hydration 会增加启动链复杂度，但核心持久数据必须在 ready 前恢复
- 即时内存更新意味着保存失败时内存与磁盘短暂不一致；当前产品已有 `lastPersistError`，推荐沿用这一取舍
- 若要求强一致，应让每个 action 等待后端后再更新 UI，但不推荐，会显著恶化交互

---

## DS-08：Profile 删除原子事务下沉

### 推荐项

**推荐：后端 command 原子完成 Profile 删除、Session profile fallback 和 activeProfile fallback；前端继续处理 workspace/UI 联动。**

### 改动位置

后端：

```text
src-tauri/src/user_cmds.rs
  - delete_profile command

src-tauri/src/user_store.rs
  - delete_profile transaction

src-tauri/src/lib.rs
  - command 注册
```

前端：

```text
src/infrastructure/tauri/userClient.ts
src/identityStore.ts
  - removeProfile

src/application/transactions/
  - 建议新增 removeProfileTransaction.ts
```

### 具体改法

后端 command：

```rust
#[tauri::command]
pub(crate) async fn delete_profile(
    store: tauri::State<'_, UserStore>,
    profile_id: String,
) -> Result<UserDataEnvelope, PylonError>
```

完整事务：

```text
获取 write_lock
→ 读取当前 user-data
→ Profile 不存在：返回当前数据或 validation error
→ profiles.len <= 1：拒绝
→ 删除目标 Profile
→ fallbackProfileId = 删除后第一个 Profile.id
→ 所有 session.profileId == 删除 id 的记录改为 fallback
→ activeProfileId == 删除 id 时改为 fallback
→ revision + 1
→ 原子写文件
→ 返回完整 envelope
```

前端 `removeProfile`：

```text
调用 delete_profile
→ 用返回结果一次性替换 profiles/sessions/activeProfileId
→ 根据返回 activeProfileId 修正 workspace sheetAgentStates
→ 保存后的后端数据为权威
```

前端 workspace patch 规则保留：

- 若某 agent state 的 `activeProfileId` 指向已删 Profile，改为后端返回的 fallback
- 其他 agent state 不动

不要让后端读取或修改 workspace sheet 文件，因为这是另一持久化域。

### 影响面

保持：

- 不能删除最后一个 Profile
- 删除 Profile 后相关 Session 自动 fallback
- 删除 active Profile 后自动选择 fallback
- workspace agent state 同步修正

改进：

- 不再出现 profiles 保存成功、sessions 保存失败的半事务

### 验证方式

1. 删除非 active Profile
2. 删除 active Profile
3. 多个 Session 引用被删 Profile
4. 无 Session 引用被删 Profile
5. 删除最后一个 Profile 被拒绝
6. 写盘失败时前端不应用删除结果
7. 重启后 fallback 结果一致
8. workspace agent state 只修改引用被删 Profile 的项

### 风险与取舍

- 前端必须等后端删除成功再更新 Profile UI；删除是低频破坏性操作，推荐强一致
- 与普通 setActiveProfile 的即时更新策略不同，这是有意设计

---

## DS-09：Session 删除持久化编排

### 推荐项

**推荐：ACP close 严格成功后再删除前端用户记录；消息文件和用户记录清理失败时报告错误，但不恢复已经关闭的远端 Session。**

### 改动位置

后端：

```text
src-tauri/src/user_cmds.rs
  - delete_session_record

src-tauri/src/user_store.rs
  - session record 删除事务
```

前端：

```text
src/application/transactions/removeSessionTransaction.ts
src/components/SessionSettings.tsx
src/components/Sidebar.tsx
src/identityStore.ts
```

### 具体改法

后端 command：

```rust
#[tauri::command]
pub(crate) async fn delete_session_record(
    store: tauri::State<'_, UserStore>,
    session_id: String,
) -> Result<UserDataEnvelope, PylonError>
```

只删除 `user-data.json` 里的 frontend Session 记录，不操作：

- ACP `close_session`
- runtime.sessions
- workspace sheet
- message snapshot

前端 transaction 依赖改为：

```ts
export interface RemoveSessionDeps {
  findSession: (id: string) => Session | undefined
  closeSession: (source: string) => Promise<unknown>
  clearMessageSnapshot: (id: string) => Promise<unknown>
  deleteSessionRecord: (id: string) => Promise<IdentitySnapshot>
  applyIdentitySnapshot: (snapshot: IdentitySnapshot) => void
  clearRuntimeAndUi: (session: Session) => void
  reportError: (action: string, error: unknown) => void
}
```

推荐执行顺序：

```text
1. findSession
2. close_session(source)
   - 失败：返回 transport，停止
3. 并行执行：
   - clear_message_snapshot(session.id)
   - delete_session_record(session.id)
4. delete_session_record 成功：应用后端返回 identity snapshot
5. 清 runtime/workspace/sessionUiState
6. 消息删除失败：报告残留错误，但 transaction 主结果仍成功
```

第 3 步不能完全用 `Promise.all`，因为需要区分用户记录删除是否成功。推荐：

```ts
const [messageResult, recordResult] = await Promise.allSettled([
  deps.clearMessageSnapshot(id),
  deps.deleteSessionRecord(id),
])
```

处理：

- record fulfilled：应用 snapshot
- record rejected：报告“远端会话已关闭，但本地记录删除失败”，仍清理内存 UI；下次启动 normalize 或重试任务处理残留
- message rejected：报告“消息快照未删除”，不阻止删除

为避免重启后残留 Session 重新出现，推荐 record 删除失败时将 session id 写入内存 tombstone，并在本次运行的 hydration/列表中隐藏；下一次应用启动无法依赖内存 tombstone，因此后续应提供清理重试。第一阶段更简单的方案：

- record 删除失败时不清前端 Session，明确显示“远端已关闭，本地删除失败，可重试”
- 但这会留下不可恢复的远端会话映射状态

综合取舍，**推荐将 `delete_session_record` 放在 `close_session` 之后并要求成功，消息删除尽力而为；用户记录删除失败时保留前端 Session 并标记错误。** 用户再次删除时 `close_session` 可能返回 session_not_found，因此重试需要识别该错误并继续本地删除。

重试规则：

```text
close_session 成功
或 close_session 返回 session_not_found
→ 允许继续 delete_session_record
```

前端按结构化错误 `code === 'session_not_found'` 分支，不匹配 message 文案。

### 影响面

- 正常删除行为不变
- 本地记录删除失败时错误更明确
- 重试删除可容忍远端已不存在
- 消息文件删除失败不会阻止 Session 删除

### 验证方式

1. close 成功、记录删除成功、消息删除成功
2. close 失败：不删本地记录
3. close 返回 session_not_found：继续本地删除
4. 记录删除失败：保留 Session 并显示错误
5. 消息删除失败：Session 仍删除，显示残留提示
6. 删除后重启不恢复 Session
7. runtime、workspace、session UI 状态正确清理

### 风险与取舍

- 跨 ACP runtime、用户数据文件、消息文件无法形成真正的单一事务
- 推荐明确每一步的失败语义，而不是伪装成原子事务
- 不建议新增一个后端大 command 同时关闭 ACP 和删所有数据，会把本地持久化与远端运行时强耦合

---

## DS-10：配置导入导出适配

### 推荐项

**推荐方案 A：保留现有前端配置文件格式和 preflight；仅将 Profile / Session 部分写入后端 user store。**

不推荐方案 B：把 Theme、Workspace、Window、Profile、Session 全部交给 Rust 解析。

### 改动位置

```text
src/configExportImport.ts
src/application/transactions/importConfigurationTransaction.ts
src/components/Settings.tsx
src/infrastructure/tauri/userClient.ts
```

### 具体改法

#### 导出

当前 `buildExportPayload(localStorage)` 面向 localStorage 白名单。改为异步聚合：

```ts
export async function buildExportPayload(deps: {
  storage: Storage
  loadUserData: () => Promise<UserDataEnvelope>
}): Promise<string>
```

导出 envelope 保持现有顶层兼容格式；Profile / Session 对应 key 的 value 继续序列化为旧格式字符串：

```text
pylon-profiles
pylon-sessions
```

这样旧版本 Pylon 仍可识别导出文件，且现有 preflight 不必立即重写。

#### 导入

当前 transaction：

```text
preflight
→ 写 localStorage 白名单
→ rehydrate
```

改为：

```text
preflight
→ 将 pylon-profiles / pylon-sessions 解析成 UserDataEnvelope
→ 调 save_user_data
→ 其他前端配置 key 写 localStorage
→ rehydrate identity/workspace/theme
```

回滚策略：

1. 导入前调用 `load_user_data` 备份后端用户数据
2. 备份前端 localStorage 白名单
3. 先校验全部数据，不写入
4. 保存后端 user data
5. 写前端 localStorage 配置
6. 任一步失败：
   - 恢复后端 user data 备份
   - 恢复 localStorage 备份
7. 统一 rehydrate

由于后端和 localStorage 不共享事务，回滚只能尽力而为。返回结果必须区分：

- validation
- transport
- rollback_failed
- mismatch

### 影响面

- 导出文件格式保持兼容
- 用户仍可导入旧版本配置
- Profile / Session 实际落盘位置改变，但导入导出 UX 不变
- 导出函数从同步变为异步

### 验证方式

1. 导出包含当前后端 Profile / Session
2. 导出后旧 preflight 可解析
3. 导入旧 localStorage 格式后正确写入 user store
4. 后端保存失败时不修改前端配置
5. 前端配置写入失败时回滚后端 user data
6. 回滚失败返回明确结果
7. 导入成功后统一 rehydrate，无需刷新应用

### 风险与取舍

- 后端文件和 localStorage 之间无法获得数据库级事务
- 保持旧导出格式会保留部分 legacy 复杂度，但迁移风险最低
- 待全部旧版本兼容窗口结束后，再考虑导出格式 v2

---

# 第三部分：统一 command 清单

## 后端新增 commands

```text
save_message_snapshot
load_message_snapshot
clear_message_snapshot
search_message_snapshots

load_user_data
save_user_data
delete_profile
delete_session_record
```

## 前端新增 typed clients

```text
src/infrastructure/tauri/messageClient.ts
src/infrastructure/tauri/userClient.ts
```

业务组件和 store 不得直接散落新增 command 字符串。

---

# 第四部分：统一验证矩阵

## 4.1 静态验证

```text
npm run lint
npm run build
cargo check
cargo test --lib --no-run
```

## 4.2 前端测试

```text
npm run test:frontend
```

重点 focused tests：

```text
message persistence adapter
message scheduler single-flight
session lifecycle hydration race
search latest-request-wins
profile/session backend persistence
profile deletion fallback
session deletion partial failure
configuration import rollback
```

## 4.3 后端测试

```text
cargo test --lib message_store
cargo test --lib message_cmds
cargo test --lib user_store
cargo test --lib user_cmds
```

## 4.4 完整验证

```text
cargo test --lib
npm run build
git diff --check
```

## 4.5 真实运行时验收

### 消息

```text
创建会话
→ 发送多轮消息，包含 reasoning 和 tool
→ 等待 done
→ 关闭并重启 Pylon
→ 消息完整恢复，所有 running=false
→ 跨会话搜索命中正确消息
→ 点击结果定位正确会话和 message id
```

### Profile

```text
新增 Profile
→ 切换 active Profile
→ 重启
→ Profile 和 activeProfileId 正确恢复
```

### Profile 删除

```text
Profile B 被多个 Session 引用
→ 删除 Profile B
→ Session 全部 fallback
→ 重启
→ fallback 结果保持
```

### Session 删除

```text
删除 Session
→ 确认 close_session 成功或 session_not_found 被容忍
→ user-data 中记录消失
→ message snapshot 文件消失
→ 重启后 Session 不恢复
```

### 迁移

```text
预置旧 pylon-profiles / pylon-sessions / pylon-msgs-* localStorage
→ 启动新版
→ 后端文件生成
→ 数据完整恢复
→ 成功迁移的旧 key 被删除
```

---

# 第五部分：实施检查点

## Checkpoint A：消息后端化完成

必须同时满足：

- 三个消息存储 command 可用
- 消息 scheduler 无乱序覆盖
- Tauri 模式不再以 localStorage 作为消息主存储
- browser demo 保持可用
- replay 行为未改
- 旧消息可迁移

## Checkpoint B：搜索后端化完成

必须同时满足：

- 搜索不再由 Tauri 前端扫描 localStorage
- 结果上限、snippet、导航行为保持
- 损坏单文件不拖垮全局搜索
- 快速 query 不出现旧响应覆盖

## Checkpoint C：用户数据后端化完成

必须同时满足：

- Tauri 模式 Profile / Session 主存储为 `user-data.json`
- identity hydration 进入 bootstrap
- 普通保存具备 single-flight
- Profile 删除后端原子完成
- Session 删除部分失败语义明确
- 配置导入导出兼容旧格式

---

# 第六部分：明确不在本规格实施的内容

- 不修改 ACP 协议
- 不修改 `session/new`、`session/load`、`session/close` 的 wire
- 不修改 Chat reducer 事件语义
- 不把前端 `Message` 完整复制为 Rust 强类型模型
- 不引入 SQLite
- 不实现多进程 revision 冲突拒绝
- 不下沉 workspace、theme、pet、window size
- 不改变现有 UI 设计
- 不改变跨会话搜索为分词、模糊或正则搜索
