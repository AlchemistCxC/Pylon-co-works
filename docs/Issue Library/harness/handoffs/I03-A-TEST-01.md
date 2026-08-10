# I03-A-TEST-01 handoff

## 状态

- owner: S（开阳-自动化测试）
- branch: `a/I03-A-TEST-01-unknown-status-matrix`
- base: `origin/main`（I03-A-FE-01 `f38142a` 已合入）
- evidence: L2（前端网页验收已执行，L1 全绿）
- current: implementation complete; review pending（交玉衡）

## 已完成

- `src/components/settings/__tests__/agentStatusSelector.test.ts`（扩充）：normalize 矩阵（缺失→unknown、缺失+crashed→crashed、非法字符串→error+诊断、显式 unknown 字符串按非法、合法状态透传、error 诊断透传）+ 单一 selector 矩阵（active 无快照→unknown、非 active→inactive、有快照透传）+ statusLabel 全状态文案。
- `src/components/settings/__tests__/agentStatusEventMatrix.test.ts`（新）：store 级事件矩阵（connected/error/disconnected 事件 → selector 一致；事件序列末态一致；切换/重启清空快照回 unknown 不残留假绿；非 active 事件写 store 但显示 inactive；capability hook 契约：无快照时 raw store 无记录 → 能力层按未连接 gate）。
- `src/workspace-sheets/__tests__/agentStatusConsumerMatrix.test.tsx`（新，jsdom）：全消费方一致性——SheetTabStrip（tab `data-agent-state` unknown/connected/inactive + aria-label）、WorkspaceTitlebar（状态灯 mode none 全灰→cascade 全亮）、Settings（Agent 状态区「状态未知」→「已连接」、error 显示最近错误）。
- ISSUE-03.md §6.4：L1 三行 + L2 两行验收勾选 ✅。

## 验证

- TDD RED：临时换回 pre-FE-01 `agentTypes.ts`（`f38142a^1`）→ 三测试文件 22 失败（典型：`AssertionError: expected 'connected' to be 'unknown'`，即假绿 bug）。
- TDD GREEN：恢复 FE-01 实现 → 同三文件 41 passed。
- focused：`npm run test` → 48 files / 286 passed（含本卡 41 项矩阵用例）。
- broader：`npm run lint` ✅；`npm run build`（tsc -b + vite build）✅；`git diff --check` ✅。
- L2（前端网页）：vite dev server + Playwright（系统 Edge）14/14 DOM 断言通过，两张全页截图：
  - 无快照首帧：清空 `agentStatuses` 后 titlebar 状态灯 mode=none 全灰无 ok 灯、Agent tab `data-agent-state=unknown`（无 connected/disconnected）、InputBar 发送/附件按钮 disabled、Settings「状态：状态未知」且无「已连接」假绿。
  - 快照到达：注入 connected（peri）/error（hermes）mock event 后，titlebar cascade、Agent tab connected、InputBar 按钮可用、Settings「状态：已连接」同一帧更新。
  - 说明：验收地址 `localhost:5173` 被无关进程占用（Multica desktop 自身 electron-vite），实际验证端口 5174，行为等价。
  - L2 截图已随回报评论附件交付（`l2-evidence/01-no-snapshot-first-frame.png`、`02-snapshot-arrival.png`）。

## 注意事项

- scope 遵守：仅改动 `src/components/settings/**`、`src/workspace-sheets/**`、`docs/Issue Library/ISSUE-03.md` 与任务卡要求的 handoff 路径；未触碰 `src/infrastructure/acp/**`（capability hook 以 store 契约测试覆盖）、`src/demo/**`、`.env*`、`src-tauri/target/**`。
- L2 演示状态控制通过页面内 `import('/src/runtimeStore.ts')` 清空/注入快照（Vite dev 模块实例唯一），未改动任何生产源码。
- 本地 `npm install-scripts approve esbuild` 在 package.json 写入的 `allowScripts` 已还原，不入本卡提交。
- L3（真实 Tauri 冷启动/事件恢复）未执行，留待后续真实应用验收卡。
