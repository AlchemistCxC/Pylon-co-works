# Pylon 原生 Kanban 双 Agent 自动化设计

> 状态：设计已完成，尚未执行 Hermes board/project/profile 创建与运行时迁移。
>
> 当前日期基线：2026-07-31。
>
> 事实源：Hermes Agent v0.18.2 当前 CLI、官方 Kanban/worker-lanes 文档、当前 Pylon 仓库与 `.agents/tasks/`。

## 1. 目标

让 Pylon 的 Backend/Frontend 两条开发 Lane 在主控会话退出、压缩或换新后仍能持续执行；每张任务由独立 Hermes Worker 进程完成，主控只负责规划、集成、集中验证和异常决策。

需要自动化：

- ready task 路由到正确 Lane；
- 启动独立 Hermes Worker；
- 固定 Backend/Frontend 工作区；
- 记录 PID、日志、运行历史和退出结果；
- dependency 完成后自动放行；
- crash/timeout/stale claim 的回收与有限重试；
- Worker 完成后返回 commit、changed files、tests 和未验收层级；
- checkpoint 前暂停继续扩张。

不自动化：

- 从模糊产品目标发明实现任务；
- 跨端任务拆分和契约决策；
- cherry-pick 冲突的自主解决；
- 集中测试失败后的任意 Debug；
- 真实 Tauri/Peri/Prism 验收结论扩大；
- 修改 Hermes `config.yaml`。

## 2. 为什么采用 Hermes 原生 Kanban

Hermes v0.18.2 已提供：

- SQLite 持久任务板；
- 原子 claim 与 dependency；
- 以 profile 名作为 worker lane assignee；
- Gateway 内置 Dispatcher；
- `hermes -p <assignee> chat -q <prompt>` 独立进程启动；
- 固定 workspace、task/run/profile 环境变量；
- worker stdout/stderr 日志、PID、run history；
- stale claim、timeout、crash、failure limit；
- `kanban_complete`、`kanban_block`、`kanban_comment`、`kanban_heartbeat`；
- worker 自动注入 Kanban lifecycle guidance。

因此不继续开发自建 PID/PTY/tmux Supervisor。仓库当前自研 queue/bootstrap 保留到迁移完成，但最终运行时生命周期真值应只有 Hermes Kanban。

## 3. 最终架构

```text
主控会话（可随时换新）
├─ 读取 ORCHESTRATOR_HANDOFF.md
├─ 设计/修订版本化 YAML 任务卡
├─ 同步 YAML → Hermes Kanban
├─ 审核 Worker 结果
├─ 执行 Integration Gate
└─ 创建 Debug/后续任务与 checkpoint

Hermes Kanban Board: pylon
├─ Backend task → assignee pylon-backend
│  └─ workspace dir:G:\Project\prism-desktop-backend
├─ Frontend task → assignee pylon-frontend
│  └─ workspace dir:G:\Project\prism-desktop-frontend
└─ Checkpoint task → 人工/主控 gate，不分配开发 Worker

Git
├─ main: G:\Project\prism-desktop
├─ agent/backend: G:\Project\prism-desktop-backend
└─ agent/frontend: G:\Project\prism-desktop-frontend
```

## 4. 主控 350k 上下文能自主运行多久

### 4.1 进程层面的持续时间

一旦任务已同步到 Kanban、Gateway Dispatcher 正常、两条 Lane 有可执行 task：

- Worker 的执行不占用主控上下文；
- 主控会话退出后任务仍可继续；
- Gateway/Dispatcher 重启后，SQLite board、run history、comments 和 dependency 仍存在；
- 理论持续时间由任务图、Gateway 可用性、API 额度、机器在线时间和任务自身阻塞决定，不由主控 350k 限制。

因此“已规划任务的执行层”可以跨主控会话持续数天或数周。

### 4.2 当前任务图的无人值守上限

当前版本化任务卡只有 14 张，其中第一轮 2 张已完成。剩余：

- Backend 5 张；
- Frontend 7 张；
- 部分被 checkpoint/producer contract 阻塞。

按现有依赖设计，在没有主控补充真实 checkpoint、任务卡和 Debug 决策时，系统只能运行到第一个人工 gate 或 unresolved blocker。实际是“若干任务/一个阶段”，不是无限期自主产品开发。

### 4.3 主控上下文的职责预算

主控不应常驻监视 Worker 日志。每次新主控只处理一个 Coordination Cycle：

1. 读取 handoff、Git/Kanban 状态；
2. 审核本轮完成卡和 commit；
3. 执行一次 Integration Gate；
4. 处理一次 checkpoint；
5. 创建下一批 2–6 张任务卡；
6. 更新 handoff 后退出或换新。

一个 350k 主控若遵循定向读取，通常可处理多个 Coordination Cycle；但系统设计不依赖该估计。任何主控在约 220k 开始压缩交接，260k 后不新增规划范围。

### 4.4 真正的停止条件

系统自动暂停而不是猜测：

- 无 ready task；
- checkpoint pending；
- task `kanban_block(needs_input/capability)`；
- 连续失败达到 circuit breaker；
- worker 没有 commit/结构化结果；
- integration conflict；
- build/test 失败；
- 任务需要尚未冻结的前后端契约；
- 任务卡与当前源码冲突，必须重新规划。

## 5. 生命周期真值

迁移完成后：

```text
.agents/tasks/*.yaml = 版本化任务规格
Hermes Kanban DB     = 唯一运行时状态
Git commit           = 代码产物真值
.agents/contracts/   = 前后端契约真值
ORCHESTRATOR_HANDOFF = 新主控接管入口
```

禁止继续让以下两套状态同时驱动执行：

```text
G:\Project\prism-desktop-agent-state\queue.json
Hermes Kanban DB
```

迁移期规则：旧 queue 只读冻结；Kanban 灰度成功前不删除。

## 6. Profile 与 Lane

计划创建两个专用 Hermes profile：

```text
pylon-backend
pylon-frontend
```

Profile 名即 Kanban assignee。

Backend 身份：

- Rust/Tauri；
- 修改 `src-tauri/**`、必要后端文档/contract；
- 禁止 `src/**`；
- 禁止 skill；
- ACP 以 `F:\A-I\Agent\Peri` 当前源码为准；
- Prism 以 `G:\Project\prism` 当前源码为准；
- task 内最小验证；
- commit 后 `kanban_complete`。

Frontend 身份：

- React/TypeScript/Zustand/CSS；
- 修改 `src/**`、业务 `scripts/**`、必要前端文档/contract；
- 禁止 `src-tauri/**`；
- 禁止 skill；
- 只消费 frozen contract；
- 保持已有设计、CSS 同步删改；
- commit 后 `kanban_complete`。

注意：创建 profile 会修改 Hermes profile 数据。未得到用户明确授权前不得执行。禁止擅自修改任何 profile 的 `config.yaml`。

## 7. Board、Project 和 Workspace

计划资源：

```text
Board slug: pylon
Project: Pylon
Primary repo: G:\Project\prism-desktop
Backend workspace: dir:G:\Project\prism-desktop-backend
Frontend workspace: dir:G:\Project\prism-desktop-frontend
```

固定 worktree 而不是每卡新建 worktree，原因：

- 每 Lane 同时只允许一个 Worker；
- node_modules/target 可复用；
- 路径稳定；
- Agent 分支历史可连续；
- 减少 worktree 清理和上下文定位成本。

必须保证：

```text
Backend lane concurrency = 1
Frontend lane concurrency = 1
```

两 Lane 可并行，同 Lane 不能并发写固定目录。

## 8. YAML → Kanban 映射

新增 `scripts/agent-workflow/sync_kanban.py`：

输入：

- `.agents/tasks/index.yaml`；
- 每张 task YAML；
- board/profile/workspace 映射。

行为：

1. 校验任务卡字段和依赖引用；
2. 解析显式/自动 Lane；
3. 跨端任务标记 `needs_split`，不创建卡；
4. 用 `idempotency-key = pylon:<task-id>` 创建/复用卡；
5. 设置 assignee、workspace、priority、max runtime；
6. 把 task dependencies 映射为 Kanban links；
7. checkpoint dependency 保留为人工 gate；
8. 输出 task ID 映射表，但不复制第二套运行状态。

任务正文只做索引，不复制全部仓库信息：

```text
你是 Pylon <Lane> Worker。
规格：.agents/tasks/<lane>/<id>.yaml
先读 AGENTS.md、Lane 身份和任务卡。
禁止 skill；遇事不决参考当前源码。
只完成当前任务；创建一个 commit。
完成时调用 kanban_complete，返回 commit、changed_files、tests、unverified、follow_ups。
```

## 9. Worker 终止契约

完成必须调用 `kanban_complete`，summary 至少包含：

```json
{
  "task_id": "BE-B1-001",
  "commit": "<sha>",
  "changed_files": [],
  "tests": [
    {"command": "...", "exit_code": 0, "proves": "..."}
  ],
  "unverified": [],
  "follow_ups": []
}
```

阻塞调用 `kanban_block`：

- `dependency`：等待父卡/契约；
- `needs_input`：需用户/产品决策；
- `capability`：工具链或外部环境缺失；
- `transient`：可能重试的临时失败。

不允许仅自然语言说“完成”后退出。

## 10. Integration Gate

新增 `scripts/agent-workflow/integration_gate.py`，只做机械操作：

1. 获取已完成卡结构化结果；
2. 验证 commit 存在且来自预期 Lane；
3. 检查 Lane worktree clean；
4. 在 main 显式 cherry-pick；
5. 冲突立即停止并生成报告；
6. 执行任务/checkpoint 定义的适用测试；
7. 通过后同步 main 到两个 Lane；
8. 写 integration report；
9. 允许后续 dependency 继续。

禁止 Integration Gate：

- 自动解决冲突；
- 自动重构；
- 根据失败日志自行修改产品源码；
- 把 build/fake/curl 扩大成真实验收。

失败后由新主控读取报告，创建精确 Debug task。

## 11. Checkpoint

Checkpoint 是独立人工 gate，不作为普通开发 Worker 卡。

```text
Level 1: Worker task 内 targeted test/build/check
Level 2: 2–4 张强相关卡后的 Lane checkpoint
Level 3: 真实 Tauri/Peri/Prism/process/artifact milestone
```

Checkpoint pending 时，相关后续任务不得 ready。

失败处理：

```text
真实错误 → 归属判断 → 新 Debug YAML/Kanban card → dependency link → Worker 修复 → 重跑 gate
```

## 12. 监控

新增 `workflow_status.py` 聚合：

- `hermes kanban list/stats/diagnostics`；
- `hermes kanban runs/log`；
- main/backend/frontend Git 状态；
- 最近完成 commit；
- checkpoint 与 integration report。

主控不轮询自然语言输出；只在：

- card done；
- card blocked；
- circuit breaker；
- checkpoint；
- integration failure；

这些事件上介入。

## 13. 灰度迁移步骤

### 阶段 A：创建运行资源

需要用户明确授权后：

1. 创建 `pylon` board；
2. 创建 `Pylon` project 并绑定 board；
3. 创建 `pylon-backend` / `pylon-frontend` profiles；
4. 不修改 profile config.yaml；
5. 确认至少一个 Gateway 的内置 Dispatcher 正常。

### 阶段 B：实现同步器

1. 写 `sync_kanban.py`；
2. dry-run 展示 Lane、workspace、dependency、priority；
3. 同步一张低风险 Frontend 或 Backend 卡；
4. `hermes kanban dispatch --dry-run`；
5. 手动 dispatch 一次，核实 profile、workspace、AGENTS.md、日志和完成工具。

### 阶段 C：一轮真实自动执行

1. 选择一张独立小任务；
2. Worker 自动 spawn；
3. commit + `kanban_complete`；
4. 主控执行 Integration Gate；
5. 验证依赖放行与下一个 Worker spawn。

### 阶段 D：切换真值

1. Kanban DB 成为 canonical runtime state；
2. 旧 `queue.json/current.json/events.jsonl` 冻结只读；
3. `lane_status.py` 改读 Kanban 或由 `workflow_status.py` 替代；
4. `bootstrap/finish/handoff` 标记 legacy；
5. 稳定两轮后再删除旧状态写路径。

## 14. 当前未执行事项

截至本设计文档写入时：

- 未创建 `pylon` board；
- 未创建 Hermes Project；
- 未创建 `pylon-backend` / `pylon-frontend` profile；
- 未修改 Hermes config.yaml；
- 未实现 `sync_kanban.py`；
- 未实现 `integration_gate.py`；
- 未执行原生 Kanban Worker 灰度；
- 旧自研 queue 仍是当前运行记录，但两 Lane 当前均无 active task。

## 15. 关键结论

- 已同步的任务执行不依赖主控上下文，可以跨会话运行。
- 产品规划不能无限自主；任务图耗尽、checkpoint 或真实错误时必须由新主控接管。
- 主控应短周期、可替换：规划一批、集成一批、更新 handoff、退出。
- Hermes Kanban 管运行时生命周期；仓库 YAML 管版本化任务规格；Git 管代码产物；契约文件管跨端真值。
