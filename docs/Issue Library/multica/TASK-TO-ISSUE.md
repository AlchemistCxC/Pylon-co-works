# Pylon → Multica 任务导入清单（TASK-TO-ISSUE）

> 由 `scripts/export_multica_issues.py` 生成（33 张卡，filter: status=planned）。
> 真值源：`docs/Issue Library/harness/tasks/*.yaml`。本文件是导入 Multica 的入口。

## 导入方式

在 Multica 中为每张卡创建一个 issue，标题用任务卡 id（如 `I06-A-DATA-01`），
描述粘贴下方对应章节。metadata 按约定设置（见 STATUS-MAPPING.md）。

## 任务列表

| 任务卡 | ISSUE | 类型 | 归属 | 角色 | 状态 | 依赖 |
|--------|-------|------|------|------|------|------|
| I01-A-TEST-01 | ISSUE-01 | TEST | S | 开阳 | planned | I01-A-BE-01,I01-A-FE-01 |
| I02-A-TEST-01 | ISSUE-02 | TEST | S | 开阳 | planned | I02-A-FE-01 |
| I03-A-TEST-01 | ISSUE-03 | TEST | S | 开阳 | planned | I03-A-FE-01 |
| I04-A-TEST-01 | ISSUE-04 | TEST | S | 开阳 | planned | I04-A-FE-01,I04-A-BE-01 |
| I05-A-TEST-01 | ISSUE-05 | TEST | S | 开阳 | planned | I05-A-FE-01 |
| I06-A-DATA-01 | ISSUE-06 | DATA | A | 天玑 | planned | I05-A-FE-01 |
| I06-A-FE-02 | ISSUE-06 | BE | A | 天玑 | planned | I06-A-DATA-01 |
| I06-A-FE-03 | ISSUE-06 | FE | A | 天玑 | planned | I06-A-FE-02 |
| I06-A-TEST-01 | ISSUE-06 | TEST | S | 开阳 | planned | I06-A-FE-03 |
| I06-B-UX-01 | ISSUE-06 | UX | B | blocked-awaiting-role-B | planned | I06-A-FE-02 |
| I07-A-TEST-01 | ISSUE-07 | TEST | S | 开阳 | planned | I07-A-FE-02 |
| I07-B-UX-01 | ISSUE-07 | UX | B | blocked-awaiting-role-B | planned | I07-A-FE-01 |
| I08-A-BE-01 | ISSUE-08 | BE | A | 天玑 | planned | I01-A-BE-01 |
| I08-A-FE-01 | ISSUE-08 | FE | A | 天玑 | planned | I07-A-FE-02 |
| I08-A-FE-02 | ISSUE-08 | FE | A | 天玑 | planned | I08-A-FE-01,I08-A-BE-01 |
| I08-B-FX-01 | ISSUE-08 | FX | B | blocked-awaiting-role-B | planned | I08-A-FE-01 |
| I09-A-FE-01 | ISSUE-09 | FE | A | 天玑 | planned | I01-A-FE-01 |
| I09-A-FE-02 | ISSUE-09 | FE | A | 天玑 | planned | I09-A-FE-01 |
| I10-A-FE-01 | ISSUE-10 | FE | A | 天玑 | planned | I09-A-FE-02 |
| I10-A-TEST-01 | ISSUE-10 | TEST | S | 开阳 | planned | I10-A-FE-01 |
| I10-B-FX-01 | ISSUE-10 | FX | B | blocked-awaiting-role-B | planned | I10-A-FE-01 |
| I11-A-BE-01 | ISSUE-11 | BE | A | 天玑 | planned | - |
| I11-A-BE-02 | ISSUE-11 | BE | A | 天玑 | planned | I11-A-BE-01 |
| I11-A-TEST-01 | ISSUE-11 | TEST | S | 开阳 | planned | I11-A-BE-02 |
| I12-A-BE-01 | ISSUE-12 | BE | A | 天玑 | planned | I01-A-BE-01 |
| I12-A-BE-02 | ISSUE-12 | BE | A | 天玑 | planned | I12-A-BE-01 |
| I12-A-SEC-01 | ISSUE-12 | SEC | A | 天玑+玉衡双审 | planned | I12-A-BE-01 |
| I12-A-TEST-01 | ISSUE-12 | TEST | S | 开阳 | planned | I12-A-BE-02,I12-A-SEC-01 |
| I12-B-UX-01 | ISSUE-12 | UX | B | blocked-awaiting-role-B | planned | I12-A-BE-01 |
| I13-A-FE-01 | ISSUE-13 | FE | A | 天玑 | planned | I03-A-FE-01 |
| I13-A-FE-02 | ISSUE-13 | FE | A | 天玑 | planned | I06-A-DATA-01 |
| I13-A-FE-03 | ISSUE-13 | FE | A | 天玑 | planned | I12-A-SEC-01 |
| I13-A-TEST-01 | ISSUE-13 | TEST | S | 开阳 | planned | I13-A-FE-02,I13-A-FE-03 |

---

## 各卡详情（导入 Multica issue 时粘贴对应章节）

## 任务卡：I01-A-TEST-01

**来源 ISSUE**：ISSUE-01（`docs/Issue Library/ISSUE-01.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I01-A-TEST-01.yaml` ← **执行前必读**

### 目标
Release 三链路真实证据采集

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I01-A-BE-01
- I01-A-FE-01

### 验收标准
- AC-1: Release 三链路真实证据采集；记录 Agent ready、ACP prompt response、assistant content，三者不以状态灯替代。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-01.md

### scope（严格遵守）
```text
allow:
  - src/identityStore.ts
  - src/runtimeStore.ts
  - src/application/transactions/**
  - src/workspace-sheets/**
  - src-tauri/src/runtime.rs
  - src-tauri/src/session/**
  - src-tauri/src/workspace*.rs
  - scripts/**
  - docs/Issue Library/ISSUE-01.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I01-A-TEST-01
pylon.issue = ISSUE-01
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I01-A-BE-01,I01-A-FE-01
pylon.level = L3
```


## 任务卡：I02-A-TEST-01

**来源 ISSUE**：ISSUE-02（`docs/Issue Library/ISSUE-02.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I02-A-TEST-01.yaml` ← **执行前必读**

### 目标
capability 状态矩阵回归

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I02-A-FE-01

### 验收标准
- AC-1: capability 状态矩阵回归；覆盖 connected、缺失 status、非法 capabilities、旧代际。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-02.md

### scope（严格遵守）
```text
allow:
  - src/infrastructure/acp/**
  - src/runtimeStore.ts
  - scripts/test-agent-contracts.mts
  - docs/Issue Library/ISSUE-02.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I02-A-TEST-01
pylon.issue = ISSUE-02
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I02-A-FE-01
pylon.level = L1
```


## 任务卡：I03-A-TEST-01

**来源 ISSUE**：ISSUE-03（`docs/Issue Library/ISSUE-03.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I03-A-TEST-01.yaml` ← **执行前必读**

### 目标
状态缺失/失败/事件矩阵测试

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I03-A-FE-01

### 验收标准
- AC-1: 状态缺失/失败/事件矩阵测试；Settings、titlebar、SheetTabStrip、InputBar 表现一致。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-03.md

### scope（严格遵守）
```text
allow:
  - src/components/settings/**
  - src/runtimeStore.ts
  - src/workspace-sheets/**
  - scripts/test-agent-unknown-status.mts
  - docs/Issue Library/ISSUE-03.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I03-A-TEST-01
pylon.issue = ISSUE-03
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I03-A-FE-01
pylon.level = L2
```


## 任务卡：I04-A-TEST-01

**来源 ISSUE**：ISSUE-04（`docs/Issue Library/ISSUE-04.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I04-A-TEST-01.yaml` ← **执行前必读**

### 目标
重连交错回归

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I04-A-FE-01
- I04-A-BE-01

### 验收标准
- AC-1: 重连交错回归；覆盖 catch 晚到、connected 早到、旧 capabilities 残留。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-04.md

### scope（严格遵守）
```text
allow:
  - src/components/Settings.tsx
  - src/components/settings/**
  - src/runtimeStore.ts
  - src-tauri/src/lifecycle/**
  - scripts/test-agent-reconnect-transaction.mts
  - docs/Issue Library/ISSUE-04.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I04-A-TEST-01
pylon.issue = ISSUE-04
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I04-A-FE-01,I04-A-BE-01
pylon.level = L1
```


## 任务卡：I05-A-TEST-01

**来源 ISSUE**：ISSUE-05（`docs/Issue Library/ISSUE-05.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I05-A-TEST-01.yaml` ← **执行前必读**

### 目标
切换状态竞态测试

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I05-A-FE-01

### 验收标准
- AC-1: 切换状态竞态测试；覆盖事件早到/晚到和查询失败，不伪造 connected。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-05.md

### scope（严格遵守）
```text
allow:
  - src/application/transactions/**
  - src/runtimeStore.ts
  - src/components/Settings.tsx
  - src/sheets/OverviewSheetView.tsx
  - docs/Issue Library/ISSUE-05.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I05-A-TEST-01
pylon.issue = ISSUE-05
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I05-A-FE-01
pylon.level = L2
```


## 任务卡：I06-A-DATA-01

**来源 ISSUE**：ISSUE-06（`docs/Issue Library/ISSUE-06.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I06-A-DATA-01.yaml` ← **执行前必读**

### 目标
消息仓库 schema 与 attempt/interrupted 契约

### 类型 / 归属 / 角色
- 类型：DATA
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I05-A-FE-01

### 验收标准
- AC-1: 消息仓库 schema 与 attempt/interrupted 契约；当前源码无 SQLite 实现时不得宣称已完成；先冻结 schema、事务和 recovery 状态。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
cd src-tauri && cargo test --lib --no-run
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-06.md

### scope（严格遵守）
```text
allow:
  - src/app/bootstrap/**
  - src/components/chat/**
  - src-tauri/src/session/**
  - src-tauri/src/acp/**
  - scripts/**
  - docs/Issue Library/ISSUE-06.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I06-A-DATA-01
pylon.issue = ISSUE-06
pylon.type = DATA
pylon.owner = A
pylon.role = 天玑
pylon.depends = I05-A-FE-01
pylon.level = L1
```


## 任务卡：I06-A-FE-02

**来源 ISSUE**：ISSUE-06（`docs/Issue Library/ISSUE-06.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I06-A-FE-02.yaml` ← **执行前必读**

### 目标
冷启动与 optimistic send 收敛

### 类型 / 归属 / 角色
- 类型：BE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I06-A-DATA-01

### 验收标准
- AC-1: 冷启动与 optimistic send 收敛；发送后输入清空、user optimistic 渲染、失败/退出恢复为 interrupted，不自动重发。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
cd src-tauri && cargo test --lib --no-run
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-06.md

### scope（严格遵守）
```text
allow:
  - src/app/bootstrap/**
  - src/components/chat/**
  - src-tauri/src/session/**
  - src-tauri/src/acp/**
  - scripts/**
  - docs/Issue Library/ISSUE-06.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I06-A-FE-02
pylon.issue = ISSUE-06
pylon.type = BE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I06-A-DATA-01
pylon.level = L1
```


## 任务卡：I06-A-FE-03

**来源 ISSUE**：ISSUE-06（`docs/Issue Library/ISSUE-06.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I06-A-FE-03.yaml` ← **执行前必读**

### 目标
真实 replay 失败证据采集与模型重建

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I06-A-FE-02

### 验收标准
- AC-1: 真实 replay 失败证据采集与模型重建；在继续补丁前保存精确切换序列、source/session、IPC replay、localStorage、runtime 摘要；未取得证据不得宣称修复。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-06.md

### scope（严格遵守）
```text
allow:
  - src/app/bootstrap/**
  - src/components/chat/**
  - src-tauri/src/session/**
  - src-tauri/src/acp/**
  - scripts/**
  - docs/Issue Library/ISSUE-06.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I06-A-FE-03
pylon.issue = ISSUE-06
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I06-A-FE-02
pylon.level = L3
```


## 任务卡：I06-A-TEST-01

**来源 ISSUE**：ISSUE-06（`docs/Issue Library/ISSUE-06.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I06-A-TEST-01.yaml` ← **执行前必读**

### 目标
真实 Tauri/ACP/SQLite Release 验收

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I06-A-FE-03

### 验收标准
- AC-1: 真实 Tauri/ACP/SQLite Release 验收；分别证明 runtime、ACP 响应、消息持久化与 UI，不用受控 mock 替代。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-06.md

### scope（严格遵守）
```text
allow:
  - src/app/bootstrap/**
  - src/components/chat/**
  - src-tauri/src/session/**
  - src-tauri/src/acp/**
  - scripts/**
  - docs/Issue Library/ISSUE-06.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I06-A-TEST-01
pylon.issue = ISSUE-06
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I06-A-FE-03
pylon.level = L3
```


## 任务卡：I06-B-UX-01

**来源 ISSUE**：ISSUE-06（`docs/Issue Library/ISSUE-06.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I06-B-UX-01.yaml` ← **执行前必读**

### 目标
消息流式/中断状态的沉浸视觉承载

### 类型 / 归属 / 角色
- 类型：UX
- 原归属：B
- 执行角色：blocked-awaiting-role-B（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I06-A-FE-02

### 验收标准
- AC-1: 消息流式/中断状态的沉浸视觉承载；只改已冻结视觉承载层，interrupted/pending/streaming 可辨识，提供 reduced-motion。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run build
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-06.md

### scope（严格遵守）
```text
allow:
  - src/app/bootstrap/**
  - src/components/chat/**
  - src-tauri/src/session/**
  - src-tauri/src/acp/**
  - scripts/**
  - docs/Issue Library/ISSUE-06.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I06-B-UX-01
pylon.issue = ISSUE-06
pylon.type = UX
pylon.owner = B
pylon.role = blocked-awaiting-role-B
pylon.depends = I06-A-FE-02
pylon.level = L2
```


## 任务卡：I07-A-TEST-01

**来源 ISSUE**：ISSUE-07（`docs/Issue Library/ISSUE-07.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I07-A-TEST-01.yaml` ← **执行前必读**

### 目标
source 清空与异步代际回归

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I07-A-FE-02

### 验收标准
- AC-1: source 清空与异步代际回归；覆盖 A→null→B、迟到 Git/Views 响应和切换期间关闭组件。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-07.md

### scope（严格遵守）
```text
allow:
  - src/sheets/file/**
  - src/workspaceStore.ts
  - scripts/**
  - docs/Issue Library/ISSUE-07.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I07-A-TEST-01
pylon.issue = ISSUE-07
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I07-A-FE-02
pylon.level = L2
```


## 任务卡：I07-B-UX-01

**来源 ISSUE**：ISSUE-07（`docs/Issue Library/ISSUE-07.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I07-B-UX-01.yaml` ← **执行前必读**

### 目标
FileSheet 空态与切换过渡视觉

### 类型 / 归属 / 角色
- 类型：UX
- 原归属：B
- 执行角色：blocked-awaiting-role-B（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I07-A-FE-01

### 验收标准
- AC-1: FileSheet 空态与切换过渡视觉；仅改局部视觉层，保留现有布局契约，过渡可关闭且不遮挡操作。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run build
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-07.md

### scope（严格遵守）
```text
allow:
  - src/sheets/file/**
  - src/workspaceStore.ts
  - scripts/**
  - docs/Issue Library/ISSUE-07.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I07-B-UX-01
pylon.issue = ISSUE-07
pylon.type = UX
pylon.owner = B
pylon.role = blocked-awaiting-role-B
pylon.depends = I07-A-FE-01
pylon.level = L2
```


## 任务卡：I08-A-BE-01

**来源 ISSUE**：ISSUE-08（`docs/Issue Library/ISSUE-08.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I08-A-BE-01.yaml` ← **执行前必读**

### 目标
workspace/Git source 与 runtime 一致性 guard

### 类型 / 归属 / 角色
- 类型：BE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I01-A-BE-01

### 验收标准
- AC-1: workspace/Git source 与 runtime 一致性 guard；source/Agent 不一致返回错误，不回退当前 runtime。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
cd src-tauri && cargo test --lib --no-run
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-08.md

### scope（严格遵守）
```text
allow:
  - src/sheets/file/**
  - src/workspaceStore.ts
  - src-tauri/src/workspace*.rs
  - scripts/**
  - docs/Issue Library/ISSUE-08.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I08-A-BE-01
pylon.issue = ISSUE-08
pylon.type = BE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I01-A-BE-01
pylon.level = L1
```


## 任务卡：I08-A-FE-01

**来源 ISSUE**：ISSUE-08（`docs/Issue Library/ISSUE-08.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I08-A-FE-01.yaml` ← **执行前必读**

### 目标
Views 只消费 touchedFiles 并统一 file/diff tab identity

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I07-A-FE-02

### 验收标准
- AC-1: Views 只消费 touchedFiles 并统一 file/diff tab identity；SCM 独占 Git，Views 不维护 gitStatus；同路径 file/diff tab 不互相覆盖。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-08.md

### scope（严格遵守）
```text
allow:
  - src/sheets/file/**
  - src/workspaceStore.ts
  - src-tauri/src/workspace*.rs
  - scripts/**
  - docs/Issue Library/ISSUE-08.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I08-A-FE-01
pylon.issue = ISSUE-08
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I07-A-FE-02
pylon.level = L1
```


## 任务卡：I08-A-FE-02

**来源 ISSUE**：ISSUE-08（`docs/Issue Library/ISSUE-08.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I08-A-FE-02.yaml` ← **执行前必读**

### 目标
真实编辑/save/working-diff vertical slice

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I08-A-FE-01
- I08-A-BE-01

### 验收标准
- AC-1: 真实编辑/save/working-diff vertical slice；保存成功更新磁盘基线，失败保留 dirty；外部修改进入冲突流程，不静默覆盖。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-08.md

### scope（严格遵守）
```text
allow:
  - src/sheets/file/**
  - src/workspaceStore.ts
  - src-tauri/src/workspace*.rs
  - scripts/**
  - docs/Issue Library/ISSUE-08.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I08-A-FE-02
pylon.issue = ISSUE-08
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I08-A-FE-01,I08-A-BE-01
pylon.level = L3
```


## 任务卡：I08-B-FX-01

**来源 ISSUE**：ISSUE-08（`docs/Issue Library/ISSUE-08.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I08-B-FX-01.yaml` ← **执行前必读**

### 目标
FileViewHost 动效与沉浸层接入

### 类型 / 归属 / 角色
- 类型：FX
- 原归属：B
- 执行角色：blocked-awaiting-role-B（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I08-A-FE-01

### 验收标准
- AC-1: FileViewHost 动效与沉浸层接入；只通过已冻结 host/selector 接入，不改业务状态；低性能与 reduced-motion 降级。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run build
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-08.md

### scope（严格遵守）
```text
allow:
  - src/sheets/file/**
  - src/workspaceStore.ts
  - src-tauri/src/workspace*.rs
  - scripts/**
  - docs/Issue Library/ISSUE-08.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I08-B-FX-01
pylon.issue = ISSUE-08
pylon.type = FX
pylon.owner = B
pylon.role = blocked-awaiting-role-B
pylon.depends = I08-A-FE-01
pylon.level = L2
```


## 任务卡：I09-A-FE-01

**来源 ISSUE**：ISSUE-09（`docs/Issue Library/ISSUE-09.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I09-A-FE-01.yaml` ← **执行前必读**

### 目标
统一 Sheet sidebar capability/context 响应式订阅

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I01-A-FE-01

### 验收标准
- AC-1: 统一 Sheet sidebar capability/context 响应式订阅；sidebarCollapsed 使用响应式订阅；无 sidebar 不生成可操作折叠按钮。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-09.md

### scope（严格遵守）
```text
allow:
  - src/workspace-sheets/**
  - src/workspaceStore.ts
  - src/domains/theme/**
  - src/App.tsx
  - src/App.css
  - scripts/**
  - docs/Issue Library/ISSUE-09.md
  - docs/Issue Library/harness/contracts/**
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I09-A-FE-01
pylon.issue = ISSUE-09
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I01-A-FE-01
pylon.level = L1
```


## 任务卡：I09-A-FE-02

**来源 ISSUE**：ISSUE-09（`docs/Issue Library/ISSUE-09.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I09-A-FE-02.yaml` ← **执行前必读**

### 目标
冻结 sidebar width token 与 WebView bounds contract

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I09-A-FE-01

### 验收标准
- AC-1: 冻结 sidebar width token 与 WebView bounds contract；统一 token 后 resize/折叠时 bounds 与 CSS 一致。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-09.md

### scope（严格遵守）
```text
allow:
  - src/workspace-sheets/**
  - src/workspaceStore.ts
  - src/domains/theme/**
  - src/App.tsx
  - src/App.css
  - scripts/**
  - docs/Issue Library/ISSUE-09.md
  - docs/Issue Library/harness/contracts/**
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I09-A-FE-02
pylon.issue = ISSUE-09
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I09-A-FE-01
pylon.level = L2
```


## 任务卡：I10-A-FE-01

**来源 ISSUE**：ISSUE-10（`docs/Issue Library/ISSUE-10.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I10-A-FE-01.yaml` ← **执行前必读**

### 目标
修复 Browser collapsed unavailable 文本泄漏

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I09-A-FE-02

### 验收标准
- AC-1: 修复 Browser collapsed unavailable 文本泄漏；折叠仅保留 icon/title/aria-label，unavailable 文本不出现在布局流中。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-10.md

### scope（严格遵守）
```text
allow:
  - src/sheets/browser/**
  - scripts/**
  - docs/Issue Library/ISSUE-10.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I10-A-FE-01
pylon.issue = ISSUE-10
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I09-A-FE-02
pylon.level = L1
```


## 任务卡：I10-A-TEST-01

**来源 ISSUE**：ISSUE-10（`docs/Issue Library/ISSUE-10.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I10-A-TEST-01.yaml` ← **执行前必读**

### 目标
Browser 折叠 DOM 与真实 bounds 回归

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I10-A-FE-01

### 验收标准
- AC-1: Browser 折叠 DOM 与真实 bounds 回归；网页验证 DOM，真实应用验证 child WebView bounds。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-10.md

### scope（严格遵守）
```text
allow:
  - src/sheets/browser/**
  - scripts/**
  - docs/Issue Library/ISSUE-10.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I10-A-TEST-01
pylon.issue = ISSUE-10
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I10-A-FE-01
pylon.level = L3
```


## 任务卡：I10-B-FX-01

**来源 ISSUE**：ISSUE-10（`docs/Issue Library/ISSUE-10.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I10-B-FX-01.yaml` ← **执行前必读**

### 目标
Browser sidebar 折叠/展开过渡

### 类型 / 归属 / 角色
- 类型：FX
- 原归属：B
- 执行角色：blocked-awaiting-role-B（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I10-A-FE-01

### 验收标准
- AC-1: Browser sidebar 折叠/展开过渡；动效不改变 disabled 语义和 WebView bounds，支持 reduced-motion。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run build
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-10.md

### scope（严格遵守）
```text
allow:
  - src/sheets/browser/**
  - scripts/**
  - docs/Issue Library/ISSUE-10.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I10-B-FX-01
pylon.issue = ISSUE-10
pylon.type = FX
pylon.owner = B
pylon.role = blocked-awaiting-role-B
pylon.depends = I10-A-FE-01
pylon.level = L2
```


## 任务卡：I11-A-BE-01

**来源 ISSUE**：ISSUE-11（`docs/Issue Library/ISSUE-11.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I11-A-BE-01.yaml` ← **执行前必读**

### 目标
确认 Tauri Webview 新窗口 API 与安全 scheme contract

### 类型 / 归属 / 角色
- 类型：BE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- 无

### 验收标准
- AC-1: 确认 Tauri Webview 新窗口 API 与安全 scheme contract；以当前依赖源码/API 文档证据确认 callback 签名；不凭经验写 on_new_window。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
cd src-tauri && cargo test --lib --no-run
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-11.md

### scope（严格遵守）
```text
allow:
  - src-tauri/src/browser.rs
  - src-tauri/src/browser_cmds.rs
  - src/sheets/browser/**
  - scripts/**
  - docs/Issue Library/ISSUE-11.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I11-A-BE-01
pylon.issue = ISSUE-11
pylon.type = BE
pylon.owner = A
pylon.role = 天玑
pylon.depends = 
pylon.level = L1
```


## 任务卡：I11-A-BE-02

**来源 ISSUE**：ISSUE-11（`docs/Issue Library/ISSUE-11.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I11-A-BE-02.yaml` ← **执行前必读**

### 目标
单 Browser WebView 新窗口复用

### 类型 / 归属 / 角色
- 类型：BE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I11-A-BE-01

### 验收标准
- AC-1: 单 Browser WebView 新窗口复用；http/https 导航到现有 child WebView，恶意 scheme 拒绝，不创建第二实例。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
cd src-tauri && cargo test --lib --no-run
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-11.md

### scope（严格遵守）
```text
allow:
  - src-tauri/src/browser.rs
  - src-tauri/src/browser_cmds.rs
  - src/sheets/browser/**
  - scripts/**
  - docs/Issue Library/ISSUE-11.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I11-A-BE-02
pylon.issue = ISSUE-11
pylon.type = BE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I11-A-BE-01
pylon.level = L3
```


## 任务卡：I11-A-TEST-01

**来源 ISSUE**：ISSUE-11（`docs/Issue Library/ISSUE-11.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I11-A-TEST-01.yaml` ← **执行前必读**

### 目标
Browser fixture 与真实 WebView 验收

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I11-A-BE-02

### 验收标准
- AC-1: Browser fixture 与真实 WebView 验收；fixture 覆盖 target blank/window.open/恶意 scheme/后退；真实应用验证拦截。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-11.md

### scope（严格遵守）
```text
allow:
  - src-tauri/src/browser.rs
  - src-tauri/src/browser_cmds.rs
  - src/sheets/browser/**
  - scripts/**
  - docs/Issue Library/ISSUE-11.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I11-A-TEST-01
pylon.issue = ISSUE-11
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I11-A-BE-02
pylon.level = L3
```


## 任务卡：I12-A-BE-01

**来源 ISSUE**：ISSUE-12（`docs/Issue Library/ISSUE-12.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I12-A-BE-01.yaml` ← **执行前必读**

### 目标
冻结 adapter catalog/instance/route domain contract

### 类型 / 归属 / 角色
- 类型：BE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I01-A-BE-01

### 验收标准
- AC-1: 冻结 adapter catalog/instance/route domain contract；平台类型、实例 identity、route binding 分离；secret 只返回 ref/脱敏状态。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
cd src-tauri && cargo test --lib --no-run
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-12.md

### scope（严格遵守）
```text
allow:
  - src-tauri/src/gateway/**
  - src-tauri/src/gateway_cmds.rs
  - src-tauri/src/export.rs
  - src/infrastructure/tauri/gatewayClient.ts
  - src/sheets/gateway/**
  - scripts/**
  - docs/Issue Library/ISSUE-12.md
  - docs/Issue Library/未决策项.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I12-A-BE-01
pylon.issue = ISSUE-12
pylon.type = BE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I01-A-BE-01
pylon.level = L1
```


## 任务卡：I12-A-BE-02

**来源 ISSUE**：ISSUE-12（`docs/Issue Library/ISSUE-12.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I12-A-BE-02.yaml` ← **执行前必读**

### 目标
QQ adapter factory/start/stop lifecycle

### 类型 / 归属 / 角色
- 类型：BE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I12-A-BE-01

### 验收标准
- AC-1: QQ adapter factory/start/stop lifecycle；registry/task/session/queue 在 start/stop/restart 收敛，不能重复注册。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
cd src-tauri && cargo test --lib --no-run
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-12.md

### scope（严格遵守）
```text
allow:
  - src-tauri/src/gateway/**
  - src-tauri/src/gateway_cmds.rs
  - src-tauri/src/export.rs
  - src/infrastructure/tauri/gatewayClient.ts
  - src/sheets/gateway/**
  - scripts/**
  - docs/Issue Library/ISSUE-12.md
  - docs/Issue Library/未决策项.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I12-A-BE-02
pylon.issue = ISSUE-12
pylon.type = BE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I12-A-BE-01
pylon.level = L3
```


## 任务卡：I12-A-SEC-01

**来源 ISSUE**：ISSUE-12（`docs/Issue Library/ISSUE-12.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I12-A-SEC-01.yaml` ← **执行前必读**

### 目标
凭据加密文件与备份实施契约

### 类型 / 归属 / 角色
- 类型：SEC
- 原归属：A
- 执行角色：天玑+玉衡双审（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I12-A-BE-01

### 验收标准
- AC-1: 凭据加密文件与备份实施契约；先完成算法、格式、ACL、损坏恢复和备份风险契约；不得自行改变已拍板备份行为。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
cd src-tauri && cargo test --lib --no-run
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-12.md

### scope（严格遵守）
```text
allow:
  - src-tauri/src/gateway/**
  - src-tauri/src/gateway_cmds.rs
  - src-tauri/src/export.rs
  - src/infrastructure/tauri/gatewayClient.ts
  - src/sheets/gateway/**
  - scripts/**
  - docs/Issue Library/ISSUE-12.md
  - docs/Issue Library/未决策项.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I12-A-SEC-01
pylon.issue = ISSUE-12
pylon.type = SEC
pylon.owner = A
pylon.role = 天玑+玉衡双审
pylon.depends = I12-A-BE-01
pylon.level = L3
```


## 任务卡：I12-A-TEST-01

**来源 ISSUE**：ISSUE-12（`docs/Issue Library/ISSUE-12.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I12-A-TEST-01.yaml` ← **执行前必读**

### 目标
真实 QQ Gateway 收发与重启恢复

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I12-A-BE-02
- I12-A-SEC-01

### 验收标准
- AC-1: 真实 QQ Gateway 收发与重启恢复；真实 start/stop/route/restart 证据，错误不泄露 secret。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-12.md

### scope（严格遵守）
```text
allow:
  - src-tauri/src/gateway/**
  - src-tauri/src/gateway_cmds.rs
  - src-tauri/src/export.rs
  - src/infrastructure/tauri/gatewayClient.ts
  - src/sheets/gateway/**
  - scripts/**
  - docs/Issue Library/ISSUE-12.md
  - docs/Issue Library/未决策项.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I12-A-TEST-01
pylon.issue = ISSUE-12
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I12-A-BE-02,I12-A-SEC-01
pylon.level = L3
```


## 任务卡：I12-B-UX-01

**来源 ISSUE**：ISSUE-12（`docs/Issue Library/ISSUE-12.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I12-B-UX-01.yaml` ← **执行前必读**

### 目标
Gateway 卡片/启停/风险提示视觉

### 类型 / 归属 / 角色
- 类型：UX
- 原归属：B
- 执行角色：blocked-awaiting-role-B（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I12-A-BE-01

### 验收标准
- AC-1: Gateway 卡片/启停/风险提示视觉；只改视觉承载；未实现平台不可伪造可用，凭据不回显。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run build
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-12.md

### scope（严格遵守）
```text
allow:
  - src-tauri/src/gateway/**
  - src-tauri/src/gateway_cmds.rs
  - src-tauri/src/export.rs
  - src/infrastructure/tauri/gatewayClient.ts
  - src/sheets/gateway/**
  - scripts/**
  - docs/Issue Library/ISSUE-12.md
  - docs/Issue Library/未决策项.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I12-B-UX-01
pylon.issue = ISSUE-12
pylon.type = UX
pylon.owner = B
pylon.role = blocked-awaiting-role-B
pylon.depends = I12-A-BE-01
pylon.level = L2
```


## 任务卡：I13-A-FE-01

**来源 ISSUE**：ISSUE-13（`docs/Issue Library/ISSUE-13.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I13-A-FE-01.yaml` ← **执行前必读**

### 目标
Settings domain config 替换 tier 一级导航

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I03-A-FE-01

### 验收标准
- AC-1: Settings domain config 替换 tier 一级导航；appearance/workspace/agent-connection domain 配置驱动导航，保留字段 tier 仅做 disclosure。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-13.md

### scope（严格遵守）
```text
allow:
  - src/components/Settings.tsx
  - src/components/Settings.css
  - src/components/settings/**
  - src/themeFieldDefs.ts
  - src-tauri/src/session/**
  - scripts/**
  - docs/Issue Library/ISSUE-13.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I13-A-FE-01
pylon.issue = ISSUE-13
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I03-A-FE-01
pylon.level = L1
```


## 任务卡：I13-A-FE-02

**来源 ISSUE**：ISSUE-13（`docs/Issue Library/ISSUE-13.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I13-A-FE-02.yaml` ← **执行前必读**

### 目标
历史保留策略设置契约与影响提示

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I06-A-DATA-01

### 验收标准
- AC-1: 历史保留策略设置契约与影响提示；设置只写策略，不绕过 Rust 删除；默认值/档位必须与实施契约一致。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L1

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-13.md

### scope（严格遵守）
```text
allow:
  - src/components/Settings.tsx
  - src/components/Settings.css
  - src/components/settings/**
  - src/themeFieldDefs.ts
  - src-tauri/src/session/**
  - scripts/**
  - docs/Issue Library/ISSUE-13.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I13-A-FE-02
pylon.issue = ISSUE-13
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I06-A-DATA-01
pylon.level = L1
```


## 任务卡：I13-A-FE-03

**来源 ISSUE**：ISSUE-13（`docs/Issue Library/ISSUE-13.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I13-A-FE-03.yaml` ← **执行前必读**

### 目标
Gateway 备份风险提示接入

### 类型 / 归属 / 角色
- 类型：FE
- 原归属：A
- 执行角色：天玑（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I12-A-SEC-01

### 验收标准
- AC-1: Gateway 备份风险提示接入；导出前普通提示说明备份持有者可解密凭据，不阻断、不伪装安全。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L2

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-13.md

### scope（严格遵守）
```text
allow:
  - src/components/Settings.tsx
  - src/components/Settings.css
  - src/components/settings/**
  - src/themeFieldDefs.ts
  - src-tauri/src/session/**
  - scripts/**
  - docs/Issue Library/ISSUE-13.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I13-A-FE-03
pylon.issue = ISSUE-13
pylon.type = FE
pylon.owner = A
pylon.role = 天玑
pylon.depends = I12-A-SEC-01
pylon.level = L2
```


## 任务卡：I13-A-TEST-01

**来源 ISSUE**：ISSUE-13（`docs/Issue Library/ISSUE-13.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/I13-A-TEST-01.yaml` ← **执行前必读**

### 目标
Settings 全域回归与真实应用验收

### 类型 / 归属 / 角色
- 类型：TEST
- 原归属：S
- 执行角色：开阳（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
- I13-A-FE-02
- I13-A-FE-03

### 验收标准
- AC-1: Settings 全域回归与真实应用验收；导航、搜索、保存、备份提示在真实应用可验收。

### 不变量（implementation_contract.invariants）
- 见任务卡 yaml

### 最低证据等级
L3

### 验证命令（focused + broader）
```bash
npm run test
npm run lint
npm run build
git diff --check
```

### 先读（inspect_first）
- docs/Issue Library/ISSUE-13.md

### scope（严格遵守）
```text
allow:
  - src/components/Settings.tsx
  - src/components/Settings.css
  - src/components/settings/**
  - src/themeFieldDefs.ts
  - src-tauri/src/session/**
  - scripts/**
  - docs/Issue Library/ISSUE-13.md
deny:
  - docs/archive/**
  - .env*
  - src-tauri/target/**
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = I13-A-TEST-01
pylon.issue = ISSUE-13
pylon.type = TEST
pylon.owner = S
pylon.role = 开阳
pylon.depends = I13-A-FE-02,I13-A-FE-03
pylon.level = L3
```

