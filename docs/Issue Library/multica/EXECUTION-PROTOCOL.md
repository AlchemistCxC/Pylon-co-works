# Agent 执行协议（天璇小队）

> 本协议是天璇小队在 Multica 中执行 Pylon 任务卡的统一行为规范。
> 所有 Agent 执行前必须读完本协议 + 对应任务卡 yaml。

## 0. 路径约定（跨机器）

- 所有路径用**仓库相对路径**（相对 Pylon 仓库根 `G:\Project\prism-desktop`，写作 `docs/...`、`src-tauri/...`）
- 严禁硬编码绝对路径（天璇小队可能跑在不同机器）
- 仓库根识别：`git rev-parse --show-toplevel`（在 Multica daemon 的 workdir 下执行）

## 1. 领卡协议（天璇）

1. 从 Multica issue 列表选择 `backlog` 状态的卡
2. `read_file` 任务卡 yaml：`docs/Issue Library/harness/tasks/<task_id>.yaml`
3. 检查依赖：`depends_on` 里的前置卡，查其任务卡 yaml 的 `status` 是否为 `integrated/verified/closed`（或对应 Multica issue 为 done）
4. 前置未完成 → 标记 blocked（写明缺哪个前置），不派活
5. 前置完成 → 按 AGENT-ROLES 映射路由给执行角色（天玑/开阳/天权…），issue 状态 `backlog → in_progress`
6. 同一时刻一个角色只接一张卡（避免工作区并发冲突）

## 2. 执行协议（天玑/开阳/天权…）

1. **先读任务卡 yaml**（inspect_first 字段列出的文件优先），再读 ISSUE 文档对应章节
2. 建分支：`a/<task_id>-<slug>`（Pylon 分支规范；Multica 执行同样适用）
3. **scope 铁律**：
   - 只修改 `scope.allow` 列出的路径
   - `scope.deny` 列出的路径禁止碰（含 `docs/archive/**`、`.env*`、`src-tauri/target/**`）
   - 越界发现 → 停下，issue 评论报告，不得顺手改
4. **TDD**：先写 focused test（RED）→ 实现 → test 绿（GREEN）
5. **验证命令**（按任务卡 commands.focused / broader，逐条执行并记录结果）：
   ```bash
   npm run test -- --run <focused-test>     # focused
   npm run lint && npm run build            # broader
   python "docs/Issue Library/harness/scripts/validate_harness.py"   # 总校验
   git diff --check
   cd src-tauri && cargo test --lib          # 涉及 Rust 的卡
   ```
6. **commit 格式**：`<type>(<area>): [<task_id>] <中文结果>`（如 `feat(frontend): [I06-A-FE-02] ...`）
   一个可验收子任务一个 commit，不混其他任务
7. 实现完成 + L1 证据通过 → 交给玉衡审查（issue 评论 @ 玉衡 mention）

## 3. 审查协议（玉衡）

1. 拉分支 diff：`git diff origin/main...<branch>`
2. 核对：scope 越界？测试真实通过？commit 粒度？有无 `unwrap`/死代码/协议错误？
3. 结论：
   - 通过 → issue 评论"审查通过" → 状态 `in_review` → 天璇/天权合并到 main
   - 打回 → issue 评论列问题 → 状态回 `in_progress`（changes_requested）→ 派回原角色修复
4. 涉及安全（SEC 卡）必须双审（玉衡 + 天璇复核）

## 4. 回报协议（所有角色）

每个执行步骤完成，在 issue 评论记录（= handoff 的 Multica 版）：

```markdown
**步骤**：实现 / 测试 / 审查 / 合并
**commit**：<hash>（<message>）
**验证结果**：
- npm run test -- --run ...：通过（N passed）
- npm run lint / build：通过
- validate_harness.py：45 cards DAG acyclic
- git diff --check：通过
**证据等级**：L1（测试/lint/build）——未做 L2/L3 真实验收
**下一步**：<确定动作>
**阻塞**：无（或写明）
```

## 5. 验收协议

- **Agent 只能推到 `in_review`**；`done` 必须人工（宫木云）确认
- 真实验收（L2 网页 / L3 真实 Tauri/ACP）由人在打包环境执行，Agent 不得用 L1 冒充
- 验收通过后：任务卡 yaml 的 `status` 更新为 `verified_lN` → Multica issue 标 `done`

## 6. 失控停止条件（来自 harness SAFETY.md）

出现以下情况立即停下、写 issue 评论报告、不清理现场：

- diff 出现 scope 外文件
- 依赖/契约与 base 漂移
- 测试产生不可解释的数据删除/网络写入/外部副作用
- 同一修复策略失败两次且没有新增证据
- 工作区包含不属于当前任务的未提交变更
