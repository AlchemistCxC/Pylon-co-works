# Pylon 主控/接手交接文档

> 给下一位主控会话或接手者。不要依赖上一段聊天历史。
>
> 工作区：`G:\Project\prism-desktop`
>
> 更新：2026-07-31（对齐 main HEAD，见下）
>
> 接管后必须先刷新实时状态：`git status --short --branch && git log -5 --oneline`

## 1. 当前状态总览

| 项 | 值 |
|:--|:--|
| 分支 | main（与 origin 同步，未 push 时另行确认） |
| 验证基线 | cargo check 零 error（5 warning 全在 runtime.rs 未接线）；cargo test 101 passed / 0 failed；npm run build 通过 |
| 后端边界 | 只动 `src-tauri/**`、`agents.yaml`、`.agents/`、docs；不碰 `src/` 前端（宫木云在改，大量未提交改动） |
| 工具链 | Rust GNU：`export PATH="/f/Coding/rust/toolchain/.cargo/bin:/f/Coding/c/mingw64/mingw64/bin:$PATH"`；`unset RUSTFLAGS`；`TMP=F:/tmp`（C 盘满）；cargo 用 `--offline` |

## 1.1 工具链与参考源码位置

| 项 | 位置 | 用途 |
|:--|:--|:--|
| Rust 工具链 | `F:\Coding\rust\toolchain\.cargo\bin\`（cargo 1.97.0 GNU） | 编译/测试；`F:\Hermes\rust\` 是僵尸目录勿用 |
| MinGW windres | `F:\Coding\c\mingw64\mingw64\bin\` | build.rs 注入 manifest（测试 exe 必需） |
| Go | `F:\Hermes\Go\bin\go`（1.24.0） | 非 Pylon 用（其他项目） |
| Python | `F:\Hermes\hermes-agent\venv\Scripts\python`（3.11.15） | 脚本/验证 |
| JDK/Gradle/protoc | `F:\Hermes\jdk17` / `F:\Hermes\gradle-8.10` / `F:\Hermes\protoc\bin` | 非 Pylon 用 |
| 临时目录 | `F:/tmp`（TMP/TEMP 环境变量） | C 盘满，cargo 必须指过去 |
| **Peri 源码（ACP 真值）** | `F:\A-I\Agent\Peri` | ACP 协议/method/通知/replay 以它为准 |
| **Hermes 源码（gateway 参考）** | `F:\Hermes\hermes-agent` | B10 设计参考：`gateway/platforms/base.py`（truncate/媒体/代理）、`gateway/platforms/qqbot/adapter.py`（重连/心跳/resume/交互审批）、`gateway/dead_targets.py`、`gateway/session.py` |
| **Prism 源码（HTTP 真值）** | `G:\Project\prism`（V1.0，含 qq 模块）；旧版打包 `/f/Hermes/projects/prism-v3-src.zip` | route/认证以它为准；qq 模块是适配器移植参考 |
| 官方 schema | cargo registry `agent-client-protocol-schema-1.4.0` | ACP 类型全集（request_permission 等） |
| Claude Code 源码图 | `references/claude-code-sourcemap/`（本地） | 工具设计对比参考 |

## 2. 本次会话已完成（2026-07-31）

### 后端功能
- **P0-1 崩溃自动重连**：指数退避 5 次 + keep_sessions + generation 迁移 + 防重入（8 commit）
- **P0-2 Session Inspector**：全局聚合命令（2 commit）
- **宠物完善**：睡眠闭环/记忆里程碑/Agent 事件/状态落盘持久化（4 commit）
- **B7a-1 AgentRuntime/Manager 结构**：`runtime.rs` per-agent 隔离运行时（1 commit）

### 文档与架构
- README 整体重构（门面化）
- 后端手册源码驱动重构（§1-8 全章节）
- **架构定稿**：Pylon = ACP 消息网关（平台 → gateway → ACP → 本地 agent）；Prism = 本地注入插件；QQ 适配器直连；静态 EntityBinding 首版 + 指令切换二期
- 设计审核 9 条全部落盘（权限审批平台表达/切断方案/去重/回复语义/媒体/失败处理/限速/会话超时/运维）

### 子 agent 基建（新增）
- `.agents/tasks/backend/BE-B10-001~006.yaml` 任务卡（YAML，对齐现有体系）
- `.agents/templates/subagent_dispatch.md` 派发模板
- **批 1 验收完成**：BE-B10-001 route（a9b300c）/ 002 truncate（30e3cc5）/ 003 dedup（293a6a8），101 测试全绿
- gateway 骨架已预建（`gateway/mod.rs` + 占位文件，53b0381）

## 3. 下一步（按优先级）

| 序 | 任务 | 说明 |
|:--|:--|:--|
| 1 | **B7a-2 AppState 迁移** | runtime.rs 接线：AppState 移除 8 个 per-agent 字段 → `runtimes` manager；命令层 77 处 `state.xxx` 替换；AppStateHandles 改 runtime handles；自动重连闭包 per-runtime 化；消除 5 个 dead_code warning |
| 2 | **批 2 派发** | BE-B10-004（auth，零依赖）先派；完成后 005+006 并行（依赖 004）。派发方法见 `.agents/templates/subagent_dispatch.md` |
| 3 | **B10.1 gateway 骨架接线** | PlatformAdapter trait + GatewayCore；**必须移除 route/truncate/dedup 的 `#[allow(dead_code)]`**（检查点） |
| 4 | **B9 权限审批流** | B9.1 wire 实测方向 → 挂起 → 模式判定 → 契约 → 集成测试 |
| 5 | 后续 | B10.2 QQ 适配器组装（auth/events/send/ws）→ B10.3 路由+会话生命周期 → B11 注入钩子 → B4.2/B3/B2/B1.2/B5 |

## 4. 工作区边界（务必遵守）

- **前端 `src/` 有大量未提交改动（宫木云）**：不 reset/clean/restore/add 他人文件，不 merge 前端
- `references/claude-code-rendering.md` 有未提交大改（参考文档，不碰）
- 后端当前零未提交（交接时点）；任何新增改动按"一条一 commit"
- 子 agent 派发：任务卡 YAML → 展开自包含文本 → delegate_task；子 agent 自己 commit 不 push；主控验收（复跑测试 + 抽查）

## 5. 已知事项/坑

- gateway 三个文件有 `#[allow(dead_code)]`（未接线暂存，B10.1 接线时移除——见上检查点）
- 子 agent 在施工中间态会让 cargo test 全量失败（如 truncate 曾 1 failed）；验收时区分"子 agent 中间态"与"真 bug"
- 子 agent 执行 cargo test 可能触发授权拦截（安全机制）；被拦时主控补跑
- 测试 exe 依赖 windres manifest（build.rs 已处理）；0xc0000139 = harness 阻塞，不得写成通过
- MCP 配置重启丢（B4.2 待做）；Prism route audit（B3）未做

## 6. 文档索引

- `README.md` — 项目门面
- `docs/后端开发与交接手册.md` — 后端源码地图/契约/状态（§1.1 施工进度、§6.1 B9-B11 详章）
- `docs/archive/` — 历史规划/审计文档（RustPlan-v1 等）
- `.agents/` — 任务卡体系 + 派发模板 + 本交接文档
