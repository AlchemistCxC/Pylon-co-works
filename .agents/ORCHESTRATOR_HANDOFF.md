# Pylon 自动化主控接管文档

> 给下一位全新主控会话。不要依赖上一段聊天历史。
>
> 工作区：`G:\Project\prism-desktop`
>
> 当前主分支 HEAD：`c1b7462`
>
> 本文写于 2026-07-31；接管后必须先刷新实时状态。

## 1. 你的身份

你是 Pylon 双 Agent 开发系统的 Planner / Integrator / Checkpoint Controller，不是 Backend 或 Frontend Worker。

你的职责：

- 结合当前源码设计任务卡；
- 拆分跨端 producer/consumer；
- 维护 contract 和 dependency；
- 把版本化 YAML 同步到 Hermes 原生 Kanban；
- 审核 Worker commit 和结构化结果；
- 执行机械 Integration Gate；
- 集中测试并根据真实错误创建 Debug task；
- 更新本 handoff 后退出或换新。

不负责：

- 长时间亲自开发 Backend/Frontend 产品功能；
- 无目标读取全仓库；
- 自动解决 cherry-pick 冲突；
- 让测试脚本自行修改源码；
- 擅自修改 Hermes `config.yaml`；
- 擅自创建/修改其他 profile，除非用户明确授权。

## 2. 开工读取顺序

严格定向读取：

1. `AGENTS.md`
2. `.agents/CONSTITUTION.md`
3. `.agents/REPOSITORY.md`
4. `.agents/KANBAN_AUTOMATION_DESIGN.md`
5. 本文件
6. `.agents/tasks/index.yaml`
7. 只读取当前要迁移/执行的任务卡
8. 必要时读取 Hermes 官方 Kanban/worker-lanes 文档或当前 Hermes CLI help

不要先完整读取：

- 两份 700/1370 行交接手册；
- `src-tauri/src/lib.rs`；
- `src-tauri/src/acp.rs`；
- `src/store.ts`；
- `ChatView.tsx`；
- 全部 task YAML；
- 全部 Git 历史。

## 3. 首先执行的实时检查

```bash
cd /g/Project/prism-desktop

git status --short --branch
git log -8 --oneline --decorate
git worktree list
python scripts/agent-workflow/lane_status.py

hermes --version
hermes profile list
hermes kanban boards list
hermes project list
hermes gateway status
```

核实：

- main/backend/frontend worktree 是否 clean；
- 两个 Lane 是否被其他 Agent 重新领取；
- 是否已经有人创建 `pylon` board/project/profile；
- Gateway Dispatcher 是否运行；
- 本文事实是否已过时。

## 4. 当前 Git 状态快照

主工作区：

```text
G:\Project\prism-desktop
branch: main
HEAD: c1b7462 feat: 完成 Workspace Sheet 固定与管理菜单
origin/main: bbe3d60
main ahead origin/main: 6
```

Worktrees：

```text
G:\Project\prism-desktop-backend
branch: agent/backend
HEAD: a8bee22 Merge branch 'main' into agent/backend

G:\Project\prism-desktop-frontend
branch: agent/frontend
HEAD: 5cecdb9 Merge branch 'main' into agent/frontend
```

安全分支：

```text
safety/pre-dual-agent-workflow → b57a6fc
```

第一轮已完成并集成：

```text
BE-B0-001
Lane commit: 4e94650
main cherry-pick: 809f793
结果：agent-status.v2 frozen

FE-F0-008
Lane commit: 2662417
main cherry-pick: c1b7462
结果：Workspace Menu + pinned reducer/persistence
```

验证：

```text
Sheet state targeted：通过
Sheet persistence targeted：通过
npm run build：通过，3361 modules
主 chunk：923.01 kB / gzip 288.76 kB
Backend Rust fresh verification：本会话 cargo command not found，未证明
```

## 5. 当前旧任务队列快照

```text
Backend
- done: BE-B0-001
- ready: BE-B1-001, BE-B3-001
- pending: BE-B2-001, BE-B4-001, BE-B5-001
- active: none

Frontend
- done: FE-F0-008
- ready: FE-F1-001, FE-F5-001, FE-F4-001
- pending: FE-F1-002, FE-F0-009, FE-F2-001, FE-F6-001
- active: none

Checkpoint: none
```

旧运行状态目录：

```text
G:\Project\prism-desktop-agent-state
```

迁移到原生 Kanban 前不要删除或重置。

## 6. Hermes 当前事实快照

```text
Hermes Agent v0.18.2 (2026.7.7.2)
```

Profiles：

```text
default
l-m       gateway running
riccati   gateway running
yjd
shared
```

当前不存在：

```text
pylon-backend profile
pylon-frontend profile
Pylon Hermes Project
pylon Kanban board
```

Kanban：

```text
current board: default
counts: empty
```

官方/CLI 已确认：

- profile 名是默认 worker lane assignee；
- Dispatcher spawn：`hermes -p <assignee> chat -q <prompt>`；
- Gateway 内置 Dispatcher 默认由 `kanban.dispatch_in_gateway` 控制；
- task 支持固定 `dir:<path>` workspace；
- worker 自动有 Kanban lifecycle guidance 和 `kanban_*` tools；
- logs/runs/PID/timeout/retry/stale claim 已原生提供。

## 7. 用户已经同意的方向与尚需授权的边界

用户希望研究并推进自动化，认同双 Agent。设计结论是迁移到 Hermes 原生 Kanban，不自建 Supervisor。

但是创建以下持久资源属于 Hermes profile/project/board 变更：

```text
board: pylon
project: Pylon
profile: pylon-backend
profile: pylon-frontend
```

新主控开始实际创建前，应向用户做一次明确的范围确认，尤其 profile 创建。不得修改任何 profile 的 `config.yaml`；用户长期禁止擅自改 Hermes config.yaml。

如果用户已经在新会话明确说“按设计执行/创建”，即可执行，不必重复问。

## 8. 下一步实施顺序

### Step 1：创建原生资源

在用户授权后，先查看 help，再执行等价命令：

```text
hermes kanban boards create pylon ...
hermes project create Pylon ... --board pylon
hermes profile create pylon-backend ...
hermes profile create pylon-frontend ...
```

Profile 如何 clone：优先选择一个拥有开发工具但身份干净的基线；不要猜。先看 `hermes profile create --help`，确认 clone 选项和是否复制 config/memory/skills。目标是专用 profile，禁止 skill，不能污染其他 profile。

不要修改 config.yaml。若必须配置 profile identity，应优先通过仓库 AGENTS.md 和 Kanban task body，而不是 profile config。

### Step 2：实现 `sync_kanban.py`

路径：

```text
scripts/agent-workflow/sync_kanban.py
```

要求：

- `--dry-run` 默认不产生 side effect；
- 读取 `.agents/tasks/index.yaml`；
- 校验 dependency 与 Lane；
- idempotency key：`pylon:<task-id>`；
- Backend assignee/workspace：`pylon-backend` + `dir:G:\Project\prism-desktop-backend`；
- Frontend：`pylon-frontend` + `dir:G:\Project\prism-desktop-frontend`；
- 跨端 `needs_split` 不创建；
- 已完成的 BE-B0-001/FE-F0-008 不应重新执行；可不导入，或导入为历史 done，但不要 spawn；
- 创建 dependency links；
- task body 指向版本化 YAML，要求 commit + structured `kanban_complete`；
- 不维护第二套 queue state。

先 dry-run，人工审核输出。

### Step 3：灰度一张卡

推荐优先候选：

```text
FE-F1-001 清理 RightPanel Reserved Tabs（小、独立）
```

备选：

```text
FE-F4-001 消费 frozen Agent status v2
```

不建议首张灰度卡：

```text
BE-B1-001（生命周期大任务）
BE-B3-001（Prism route audit）
```

流程：

1. sync 单张；
2. `hermes kanban dispatch --dry-run --board pylon`；
3. 确认 assignee/profile/workspace；
4. dispatch；
5. 检查 `kanban log/runs/show`；
6. 检查 Agent 是否读 AGENTS.md、禁止 skill、在正确 worktree；
7. 检查 commit 和 `kanban_complete` metadata。

### Step 4：实现机械 Integration Gate

路径：

```text
scripts/agent-workflow/integration_gate.py
```

先只支持单任务显式执行，不做常驻 daemon：

```bash
python scripts/agent-workflow/integration_gate.py --task <kanban-task-id>
```

要求见设计文档第 10 节。任何冲突/测试失败停止并报告，不自动 Debug。

### Step 5：稳定两轮后迁移真值

- 原生 Kanban 成为 runtime canonical；
- 旧 queue 冻结；
- 新 `workflow_status.py` 取代 `lane_status.py`；
- legacy bootstrap/finish/handoff 标注弃用；
- 不要一次性删除旧系统。

## 9. 当前任务卡优先级建议

迁移后第一阶段：

```text
Frontend 灰度：FE-F1-001
Frontend 后续：FE-F1-002（依赖 FE-F1-001）
Backend：BE-B1-001
Frontend contract consumer：FE-F4-001
Backend Prism：BE-B3-001
```

现有评分系统原本会在新 Frontend cycle 偏向 FE-F4-001（阻塞另一 Lane/契约消费），但灰度自动化优先选择小而独立的 FE-F1-001，不必沿用旧评分。

## 10. 集中测试边界

日常 Worker 只做任务卡最小验证。

Integration Gate 至少：

```text
Frontend：targeted + npm run build；2–4 卡后 npm run test:frontend
Backend：cargo check/focused（若环境有 cargo）；无 cargo 必须标 capability blocker
```

真实 milestone 才跑：

```text
Tauri invoke/event
真实 Peri JSONL
真实 Prism 临时数据
Windows process
artifact read-back
```

## 11. 风险与陷阱

1. **双运行时真值**：不要让旧 queue 和 Kanban 同时分发任务。
2. **固定 worktree 并发**：同 Lane 只能一个 Worker。
3. **Profile 污染**：不要直接使用 yjd/riccati 长期跑 Pylon；不要改其 config。
4. **Skill**：任务明确禁止 skill；不要通过 `--skill` 强制加载。
5. **Agent 自称完成**：必须有 commit + `kanban_complete`。
6. **Integration 自动 Debug**：禁止。
7. **cargo 缺失**：当前 yjd shell `cargo` 不在 PATH；先按 `dev-environment`/实时系统定位，不能把未跑写成通过。
8. **origin 落后**：main 当前 ahead 6，尚未推送。
9. **文档过时**：手册只读对应章节，以源码和 contract 为准。
10. **主控上下文**：约 220k 开始更新本文，260k 后不设计新阶段。

## 12. 新主控本轮完成定义

推荐只完成一个自动化迁移阶段：

```text
资源创建（经授权）
+ sync_kanban.py dry-run
+ 一张灰度 Worker card
+ 结果审查
+ 更新本文
```

不要在同一 350k 会话里同时完成：全部任务导入、Integration Gate 全功能、多个 milestone 和产品 Debug。

## 13. 收尾要求

每个主控会话结束前更新本文：

- 当前 Git/Kanban/Profile/Project/Board 状态；
- 本轮新增资源和 commit；
- 已验证与未验证；
- 当前 running/ready/blocked card；
- 下一步第一条命令；
- 不要重新做什么。

若设计发生重大变化，同步更新：

```text
.agents/KANBAN_AUTOMATION_DESIGN.md
```

本文是新会话唯一主控入口；聊天历史仅作次要参考。
