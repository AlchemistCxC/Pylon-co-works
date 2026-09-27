# Dev Record — #363 ACP 子进程生命周期：spawn 卫生三项 + GUI 会话空闲回收

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/363-acp-subprocess-lifecycle.md`

## 元信息

- issue：[#363](https://github.com/AlchemistCxC/Pylon-co-works/issues/363)
- 分支：`kumo/prometheus`
- 提交范围：本批（#361/#362/#363 单 PR）自 `82631455` 之后
- 日期：2026-09-27

## 目标与范围

**做什么**（issue 四项，均围绕「agent 子进程怎么起、什么时候收」）：

1. **UTF-8 环境钉死**：起 agent 子进程时统一注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` / `LANG=C.UTF-8` / `LC_ALL=C.UTF-8`。
2. **`ETXTBSY` 重试**：spawn 在预算内指数退避重试；**非 busy 错误不重试**（否则只是拖延调用方自己的回退）。
3. **node 版本管理器 PATH 修复**：启动时（仅在 node 不在 PATH 时）探测 9 种管理器的 bin 目录并前插 PATH。
4. **GUI 本地会话空闲回收**：把空闲回收从「平台来源」推广到全部连接，豁免改用既有强信号（在途回合 / 在场交互 / prompt 闸门），超时可配、`0` 关闭。

**不做什么**（issue 明写或本批裁定）：

- 裸名 → `.cmd`/`.bat` 解析与 UNC cwd 绕行（**#353** 覆盖）。
- 回合级 liveness 截断（**#216**，已 CLOSED；issue 明写不是同一件事）。
- 不改 `pylon-foundations/src/git.rs` 的 `LC_ALL=C`（那是 git 输出解析的「英语」要求，与 agent 子进程的「UTF-8」是两个方向，见方案要点 1）。
- 不迁 Codeg 的 `ensure_user_npm_prefix_in_path`（Pylon 无对应 npm-global 目录）。
- **不给 GUI 加「断线自动重连」**：这是它自身的独立议题（见「未解问题」1）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-acp/src/process.rs` | `set_utf8_env` / `configure_agent_child` / `is_exec_busy` / `spawn_retrying_exec_busy{,_within}` + 用例 | 修改 |
| `src-tauri/pylon-acp/src/engine.rs` | `spawn_agent_child` 接入环境钉死与重试 | 修改 |
| `src-tauri/pylon-acp/src/terminal_runtime.rs` | `create_shell` 同一处置 | 修改 |
| `src-tauri/pylon-core/src/node_path.rs` | 9 种管理器候选、semver 排序、nvm alias、volta shim 判定、PATH 前插 | 新增 |
| `src-tauri/pylon-core/src/lib.rs` | 模块登记 | 修改 |
| `src-tauri/src/session/expiry.rs` | 回收范围/豁免/超时重写 + 连接级回收 | 修改 |
| `src-tauri/src/session/session_expiry_platform_tests.rs` | 契约改写 + 新增豁免/连接用例 | 修改 |
| `src-tauri/src/session/mod.rs` | 陈旧测试样本清理（#354 契约更新，见「测试处置」） | 修改 |
| `src-tauri/src/lifecycle/mod.rs` | `stop_agent_runtime` 提 `pub(crate)`（实现零改动） | 修改 |
| `src-tauri/src/lib.rs` | `run()` 启动首段调用 `ensure_node_in_path()` | 修改 |
| `src-tauri/vendor/acp/ORIGIN.md` | §6 出处登记 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native ACP / Native session / 可复用 Agent 能力三行 | 修改 |

## 方案要点

### 1. UTF-8 环境

四项键值照搬 Codeg。接线点是 `configure_agent_child`（= UTF-8 环境 + 隐藏控制台窗口），只用在**agent 侧子进程**：agent 本体（`spawn_agent_child`，SDK 与 stdio 两个后端共用）与 agent 侧 terminal（`create_shell`）。顺序上放在 `apply_launch_plan` **之前**，于是用户在 `agents.yaml` 里显式写同名 env 仍然赢——这里是默认值，不是不可覆盖的强制值（有单测钉住）。

与 `git.rs` 的 `LC_ALL=C` 不冲突：`C.UTF-8` 仍是英语 locale（沿 `C` 语义），只是码集固定为 UTF-8；git 路径**故意不调** `set_utf8_env`，以免覆盖它自己的英语钉法。`pylon-acp/src/stderr.rs` 的英文标记分级因此不受影响（locale 仍是 C 族），非英文宿主机上反而更稳。

### 2. `ETXTBSY` 重试

要覆盖的是**另一个线程 fork→exec 间隙**：Rust 以 `O_CLOEXEC` 打开文件，但 CLOEXEC 只在 exec 生效；另一线程 `fork()` 复制 fd 表时写 fd 仍开着，窗口内 exec 同一文件得 `ETXTBSY`。窗口自闭合，所以正确处置是重试。

- 预算 deadline 1 秒、退避 1ms 起 ×2、上限 25ms、最后一次 sleep 夹到剩余时间。
- 判定同时看 `ErrorKind::ExecutableFileBusy` 与（Unix）`raw_os_error() == 26`；不引 `libc`（不为一个常量新增依赖）。Windows 不会命中（`raw_os_error` 分支仅在 unix）。
- **非 busy 一次即返**且错误原样传递：`NotFound`/`InvalidFilename` 是调用方决定回退路径的依据（#353 的 `.cmd` 绕行），塞进重试只会让调用方的兜底迟到。
- 重试包住整个 `spawn()`（闭包 `FnMut() -> io::Result<T>`）。`std::process::Command::spawn` 可重复调用；Unix exec 失败的中间子进程由 std 回收、Windows `CreateProcess` 要么给 child 要么什么都不给——不泄漏、不重复副作用。

### 3. node 版本管理器 PATH

`pylon-core/src/node_path.rs`：`ensure_node_in_path()` 先判 `node_on_path`（按 PATH 逐目录找 `node.exe`/`node`），**已在 PATH 上就立即返回**，不动用户自己配好的环境。命中则**前插** PATH（进程级，不落盘）。

9 种管理器与顺序：nvm（`NVM_DIR`/`~/.nvm`，`alias/default` 的**数值前缀**解析 + semver 数值降序）/ nvm-windows（`NVM_SYMLINK`、`NVM_HOME`/`%APPDATA%\nvm`）/ fnm（`FNM_MULTISHELL_PATH`、`FNM_DIR`）/ volta（`VOLTA_HOME`，**仅当 `tools/image/node` 有镜像才前插 shim 目录**）/ asdf / mise|rtx / n（`N_PREFIX`）/ Homebrew / Scoop。

两处有意偏离上游（均登记在 `vendor/acp/ORIGIN.md` §6）：① 候选目录计算不做平台 cfg 门（由「该目录下真有 node 二进制」做唯一筛选），使纯函数在任何平台可单测；只有绝对路径默认值（`/usr/local` 下的 n、Homebrew）保留平台门。② 不迁 npm-global 那条。

volta 的「只有 shim 没有镜像」是 issue 点名的行为：此时**不**把 shim 目录加进候选，下游拿到的就是干净的「找不到 node」，而不是 Volta 的晦涩运行时错误。

调用位置：`lib.rs::run()` 的启动首段（`install_process_registrations()` 之后、配置装载与 Tauri builder 之前）。这是**读 PATH** 的工作（agent 探测/preflight 跑在 `setup()`）之前的最早位置。

### 4. 空闲回收

**回收范围**：删掉 `is_platform_source` 守卫，改为按**活跃信号**豁免。

| 来源 | 超时来源 | 默认 | 关闭 |
| --- | --- | --- | --- |
| 平台来源（有 binding） | binding `reset` / `idle_minutes`（**语义与文案逐字保持**） | idle / 1440 分钟 | `reset: off` |
| 非平台（GUI local） | `PYLON_SESSION_IDLE_TIMEOUT_SECS` | 1440 分钟 | `0` |

**四类豁免**（任一命中即跳过，取代原来的「非平台一律跳过」）：per-source prompt 锁占用（保留，锁中毒 fail-closed）、`SessionInfo::turn_in_flight()`（ADR-0017 进程内标记，与 `turn_ledger.begin` 同点设置）、交互队列中存在 `session_id == peri_id` 的在场条目（`settle` 即出队，故在场即非终态）、per-runtime `prompt_gate` 被占用（`try_lock_owned` 非阻塞）。后两条是**连接级**信号，命中时该连接的会话本轮全部跳过。

**会话回收不破坏数据**：`remove_if_current_expired`（纯内存：删映射 + binding_health + prompt 锁）→ `close_session_rpc`（ACP `session/close`）。**不碰** SQLite journal 与前端 identity store；前端会话列表才是权威，下次发消息走 `known_peri_id` → `session/load` revive 自愈。

**连接级回收**（回应 issue 点名的「一直挂着 agent 子进程」）：子进程属于**连接**（`AgentRuntime.acp` 的 `ManagedChild`），只回收会话不会释放它。所以每轮扫完后，对**零会话**、闲置超时、`Connected` 且无活跃信号的 runtime 调既有 `lifecycle::stop_agent_runtime`（Job Object 杀进程树 + 归还实例预算槽），不另写 kill 逻辑。收完状态回落 `Disconnected`，下一轮不会重复收。

**为什么默认 1440 分钟而不是 Codeg 的 180 秒**：Codeg 的前端每 30 秒给连接发 keepalive 且断线有自动重连；Pylon 两者都没有——GUI prompt 路径只判 `Crashed`，打到已停止的连接直接 `ConnectionClosed`。照搬 180 秒会让用户离开三分钟后回来发消息就吃硬错误。默认取「与无 binding 会话原本就已生效的隐式默认」一致的 1440，把「更快回收」留给配置（该决定登记在 `DEFAULT_GUI_IDLE_TIMEOUT_SECS` 注释与 `ORIGIN.md` §6）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| (1) 四项 UTF-8 环境都注入，且用户显式 env 仍能覆盖 | 通过（`utf8_env_pins_all_four_variables`、`explicit_launch_env_overrides_the_utf8_default`） |
| (2) busy 在预算内重试到成功 | 通过（`busy_spawn_retries_until_it_succeeds`，3 次尝试） |
| (2) 非 busy 一次即返且错误原样 | 通过（`non_busy_errors_are_returned_on_the_first_attempt`，NotFound/InvalidFilename/PermissionDenied 各 `attempts == 1`） |
| (2) 预算耗尽返回**原始** busy 错误 | 通过（`retry_budget_exhaustion_returns_the_original_busy_error`） |
| (3) 9 种管理器候选 | 通过（15 条 node_path 用例，真实临时目录夹具） |
| (3) nvm `default` alias 数值前缀 + semver 降序 | 通过（`nvm_default_alias_numeric_prefix_selects_the_newest_match`：`18` → `v18.20.4` 而非 `v18.0.0`） |
| (3) 符号别名回退最新 | 通过（`nvm_symbolic_alias_falls_back_to_the_newest_installed_version`） |
| (3) volta 只有 shim 无镜像 → 不前插 | 通过（`volta_shim_without_a_node_image_is_withheld` / `..._is_used_once_a_node_image_exists` 成对） |
| (3) node 已在 PATH → 不动 PATH | 通过（`node_on_path_*` 两条 + `ensure_node_in_path` 的早返回） |
| (4) GUI local 超时后被回收（取代原豁免） | 通过（`expiry_watcher_reclaims_idle_local_source_and_resets_platform_sources`） |
| (4) 四类豁免逐条 | 通过（4 条专用用例：prompt 锁由既有 TOCTOU 用例覆盖，另有在途回合 / 在场交互 / prompt 闸门三条） |
| (4) `0` 关闭（会话路径与连接路径都关） | 通过（`disabled_gui_timeout_reclaims_nothing` + `gui_idle_timeout_parsing`） |
| (4) 零会话闲置连接走 stop 路径 | 通过（`idle_connection_without_sessions_is_reclaimed`：断言 `is_dead()` 且状态回落 `Disconnected`） |
| (4) 连接回收的豁免与重复收保护 | 通过（`idle_connection_with_a_pending_interaction_is_exempt`、`disconnected_connection_is_not_reclaimed_again`） |
| (4) 平台来源路径语义不变 | 通过（既有 platform 用例保留；`expired_reason` 的 `daily`/`off`/idle 与文案逐字对照） |
| TOCTOU 复核纪律不回归 | 通过（`expiry_watcher_keeps_session_refreshed_after_snapshot`，填充会话改为「当下活跃」以在新区间下仍只测该性质） |

## 测试处置

- 新增：`pylon-acp` 的 process 用例 8 条（UTF-8 2 + 重试 4 + 判定 1 + 既有 exit watcher 1）；`pylon-core::node_path` 15 条；`session_expiry_platform_tests` 8 条（契约改写 1 + 豁免 3 + 关闭 1 + 连接 3）。
- 修改既有行为测试（**逐个点名**）：
  1. `session_expiry_platform_tests::expiry_watcher_skips_local_sessions_and_resets_platform_sessions` → 改名 `expiry_watcher_reclaims_idle_local_source_and_resets_platform_sources`：**契约变更**（GUI local 不再无条件豁免），断言从「必须保留 local」翻转为「超时 + 无活跃信号 → 必须回收」。
  2. `session_expiry_platform_tests::expiry_watcher_keeps_session_refreshed_after_snapshot`：其 50k `local-fill-*` 填充会话在原契约下天然豁免、新契约下会参与回收（会让该用例顺带测到无关路径）。改为把填充会话的 `updated_at` 设为**当下**，用例仍只测 TOCTOU 复核；填充规模与握手不变。
  3. `session::tests::prompt_error_indicates_missing_session_matching`：**不是本批引入，属陈旧样本**。样本 `{"code":-32000,"message":"session missing"}` 是 #354 落地 `-32000 → RpcFailureKind::AuthRequired` 一票判定前的旧契约；#354 已在其自己的 `src-tauri/src/acp/tests.rs` 修正同类样本，但漏了本文件（而 #354 在 `L.md` 声明不碰 `session/**`，本目录属本批声明域）。故由本批把该样本从「应命中 SessionMissing」移到「协议码优先于文本」的 transient 列表，并补注释说明。**这是测试跟随契约，不是放宽断言**：`-32602` 的两条 SessionMissing 样本仍在。

## 证据

- commit：见本批 PR
- 测试：
  - `cargo test --workspace --lib` → exit 0，`1527 passed; 0 failed; 4 ignored`
  - 定向：`cargo test -p pylon-core --lib node_path::` → `15 passed; 0 failed`
  - 定向：`cargo test -p pylon-acp --lib process::` → `8 passed; 0 failed`
  - 定向：`cargo test --lib session_expiry` → `12 passed; 0 failed`
- clippy / fmt：`cargo clippy --workspace --all-targets` 无本批新增告警（本批文件零命中）；`cargo fmt --all -- --check` 干净
- 独立审查（子 agent，对抗式）：
  - 逐项裁定 **1 / 2 / 3 / 4 全部 DELIVERED**（含 issue 点名的两个子行为：volta 的「未安装而非晦涩错误」、`0` 关闭对两条路径都成立）。
  - 确认平台路径语义与文案逐字保持、回收非破坏（journal 与前端 store 不受影响）、`turn_in_flight` 与 `turn_ledger` 等价（mark 与 `ledger.begin` 同点设置，且有「mark 无 ledger」的生产交叉检查）、`prompt_gate` 判定与 prompt 路径自身同形。
  - 必修项已全部处理：测试文件缺 `check_session_expiry_with` 绑定（本批补显式 import）、`session_expired` 成生产死代码且我原先挂的 `cfg_attr` 方向写反（改为 `#[cfg(test)]` 门控）、node_path 注释夸大了「早于任何多线程」（改为陈述真实约束）、退避用例的紧贴墙上界会 flake（放宽到量级判断）、缺连接级回收用例（已补 3 条）。
  - **保留的判断**：连接回收会让用户下一次发送拿到硬错误（Pylon 无 GUI 断线自动重连）——审查建议的三种处置里，本批取「修正文档措辞 + 只对零会话保守启用」，把「GUI 断线懒重连」作为独立议题（见未解问题 1），未擅自新增重连链路。

## 与 spec 的偏差

1. **spec 写环境变量名 `PYLON_GUI_SESSION_IDLE_MINUTES`（分钟、默认 1440）**：实际取 `PYLON_SESSION_IDLE_TIMEOUT_SECS`（秒、默认 86400）。理由是 issue 明写「对齐 Codeg `CODEG_ACP_IDLE_TIMEOUT_SECS`」——同族命名便于对照，而默认值差异另在注释与 ORIGIN 登记。
2. **spec 只要求「回收会话」**：实际补了连接级回收（零会话 + 闲置 + Connected → 走既有 stop 路径）。issue 的描述点名「被遗弃的 GUI 会话会一直挂着 **agent 子进程**、文件句柄与内存」，而子进程属于连接、只回收会话不会释放它；不补这一条等于没解决 issue 点名的现象。
3. **spec 说 `libc` 依赖「优先不新增」**：落地为写字面量 26 + `ErrorKind` 主判定，未新增依赖。
4. **spec 的「未决问题 1/2」保留**（默认超时与「有会话时是否也收连接」），并把「GUI 断线懒重连」转成独立 issue。
5. spec 未预见：`session/mod.rs` 里 #354 留下的陈旧测试样本（见「测试处置」3）。

## 整 PR 审查后的追加修正（提交 `088a5096`）

整 PR 审查（1 个独立子 agent，覆盖全部批次）提了一条落在这块的 CONCERN，已修：

**问题**：连接级回收只判「零会话 + 闲置超时 + Connected」，但回收把 runtime 置为
`Disconnected`，而**这个状态不会自愈**——自动重连只管 `Crashed`/`Error`，平台 ingest
对非 Connected 实例直接拒绝（`route.rs` 的 `IngestReject::InstanceNotConnected`）且无
fallback。于是「挂机 24 小时、期间没有任何会话」的网关 agent 会被静默杀掉，之后所有
入站平台消息被拒到有人手动重连为止——一次性、不可恢复、且没有任何用户可见的错误。

**修法**：新增 `platform_may_route_to(state, agent_id)`，命中即跳过连接回收：
1. `gateway.routes()` 里有 `agent_id` 命中该 agent 的显式路由；
2. `unbound_policy == ActiveAgent`（缺省值）**且**确有适配器注册（`adapter_keys()` 非空）
   —— 未绑定来源的平台消息会回退到 active agent，即便它没有显式路由。

反向保证不变：没有平台路径能到该 agent 时回收照常生效，且不构成静默不可恢复——用户
切到它（`switch_agent` 会连接 Disconnected 目标）或打开它的会话都会重连。

顺带修正两处措辞（审查指出）：闲置时钟实际是 `last_connected_at`（连接建立时刻），
原日志「闲置超过 N 秒」不准确，改为「自连接起已超过 N 秒」；并在 `reclaimable` 前补注释
说明「对零会话 runtime，连接建立时刻与最后活动时刻等价」（连接级活动只有 prompt 与
交互，两者都已被豁免）。

新增测试 `connection_routed_by_the_gateway_is_never_reclaimed`（路由指向运行时键 →
断言 `acp` 未死且状态仍为 Connected）。`cargo test --lib session_expiry` → 13 passed。

**仍然未解**：`#356` 落地后需把其私有交互队列纳入豁免（本批只认 `runtime.interactions`），
已记入 `L.md` 交接点。

## 未解问题

1. **GUI 断线懒重连缺失（新登记 issue）**：连接级回收后，用户下一次发送会直接失败直到手动重连/切 agent——因为 `session/prompt.rs` 只判 `Crashed`，`AcpClient` 对已停止连接返回 `ConnectionClosed`。本批用「只对零会话 + 默认 24 小时」把触发面压到最小，并把默认值做成可配；真正的修法是给 GUI prompt 路径补与平台侧 `ensure_runtime_ready` 同形的懒重连。**已另行登记**（见本批 PR 的新 issue 号）。
2. **默认超时 1440 分钟 vs Codeg 的 180 秒**：若仓库主裁定照 Codeg，必须先落未解问题 1 的懒重连，否则用户会看到硬错误。
3. **`node_on_path` 只看 `node.exe`（Windows）**：`node.cmd`/`node.bat` 不算命中。这与 `std::process::Command::new("node")` 的真实可执行性一致（`CreateProcess` 补 `.exe`、不走 `PATHEXT`），所以是「与 spawn 相关的那个 PATH 判定」，但若未来真的要用 `.cmd` 形式的 node，需要同步放宽。
4. **volta 的镜像判定只看「目录里有条目」**：`tools/image/node` 下若有杂散文件会误判为已装。安装器总会设 `VOLTA_HOME`，所以 Windows 上未探测 `%LOCALAPPDATA%\Volta` 这一点也未处理。
5. **`ensure_node_in_path` 的 `set_var` 与 `init_tracing` 的 worker 线程并存**：Windows 下环境访问由 PEB 锁串行化，且那些线程不读 PATH，故当前无实际风险；若要绝对干净，可把调用移到 `main()` 的 `init_tracing` 之前。

## 并行交集

- `src-tauri/pylon-acp/src/{process,engine,terminal_runtime}.rs`：与 #354 声明域相邻（#354 明写不碰这三件）✓；#352 因 `engine.rs` 属本批在途脏文件而**另开独立 worktree 分支**避让 ✓。
- `src-tauri/src/session/mod.rs`：本批 hunk 在 `:408-445` 与测试尾部；#376 的 `evt_load_compact` hunk 在 `:841-856`，**不由本批提交**（私有 index 分账）。
- `src-tauri/src/lifecycle/mod.rs`：本批只把 `stop_agent_runtime` 提为 `pub(crate)`（一行可见性 + 注释），实现零改动。
- `src-tauri/src/lib.rs`：与 #371 的 docs_sheet 接线同文件，按其在 `L.md` 的请求连带提交。
- `src-tauri/pylon-core/**`：本批新增 `node_path` 与 `pylon-core → pylon-foundations` 依赖边（见 #361 记录）。
- `docs/说明书/Pylon-模块维护地图.md`：本批三行表述随本批提交（未被他人带走）。
