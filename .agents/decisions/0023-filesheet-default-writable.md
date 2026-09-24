# ADR-0023 FileSheet 默认可写（重审 #252）

- **日期**：2026-09-24
- **状态**：已采用
- **关联**：Epic #280 · issue #252（已关闭，本 ADR 重审其结论）· issue #284（施工卡）· 设计案 `.agents/spec/filesheet-strengthening/A-kernel-perf.md`

## 背景与约束

#252（2026-09）确立「FileSheet 打开文件默认只读，显式点编辑才可写」，动机是防误改真实仓库文件（阅读是高频路径，可写态不应是默认态）。FileSheet 补强计划（Epic #280）裁决**双轨并进 + 放宽为默认可写**：编辑器要成为「agent 工作区的可写投影」，常驻的进/出编辑摩擦与该定位相悖；且 0-A1 内核合一后只读/编辑仅是同一 CodeMirror 实例的 editable 两档，「模式」的存在感已天然弱化。

约束：外部修改绝不静默覆盖（AC-1，`write_text` 的 expectedBaseline/force 语义）必须原样保留；关闭/导航守卫必须保留；truncated/binary/超限文件强制只读（后端物理约束）。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 维持 #252 默认只读 | 与「可写投影」定位相悖；进/出编辑摩擦是「强大编辑器」目标的主要体验税 |
| 默认可写 + 手动只读 pin | 多一套 per-file 状态管理与持久化语义；当前无需求证据，留待后续按需立项 |
| 默认可写 + workspace 级只读总开关 | 与本 ADR 不冲突，作为后续可选项（阶段一再议），不阻塞本决策 |

## 决定

1. FileSheet 打开文件**即可编辑**（内核 editable 常态 true）；「编辑/退出编辑」按钮与 host 的 editing 状态机退役。
2. 强制只读仅保留**物理例外**：truncated / binary / 超限（>1MB）——后端约束映射为内核只读档。
3. **写冲突锁**（0-A3）：agent 写盘冷却窗口内临时禁编辑，锁内禁保存——承接 #252「防并发写踩踏」的合理内核。
4. #252 的「防误改」由三层新机制承接：expectedBaseline 保存期冲突检测（不变）＋ 关闭/导航守卫（不变）＋ 写冲突锁（新增）。
5. 测试翻转：默认只读断言改为「默认可写 + 物理例外只读」；「脏态退出编辑确认」随按钮退役移除（等价守卫由 FileSheetView 的 tab 关闭/切换 confirm 承接，已有测试覆盖）。

## 后果

- 正面：阅读→修改零摩擦；状态机少一个模式维度；与 A 案单内核模型一致（editable 只是 compartment 翻转）。
- 负面：误触键入即 dirty（无确认直接改工作区缓冲）；#252 原诉求的保护从「模式门槛」弱化为「保存期校验」。
- 风险：用户误改后未察觉——缓解：tab dirty 圆点 + 状态栏未保存统计 + 关闭守卫 confirm；后续可按需补 workspace 只读总开关（开放问题，不阻塞）。

## 证据

- 旧默认只读：`src/sheets/file/FileViewHost.tsx` #252 注释与 `useState(false)`（commit 4969bc34 前身）；测试 `FileViewHost.save.test.tsx` 默认只读断言（已翻转）。
- 物理例外只读：`FileTabView.tsx` `writable={!truncated}` → 内核 readonly compartment；后端 `workspace.rs` BinaryFile/TooLarge/truncated 语义（不变）。
- 保存期冲突检测：`workspace.rs` write_text expected_baseline/Conflict（不变）；宿主 conflict banner（不变）。
- 关闭守卫：`FileSheetView.tsx` canLeaveActiveTab/beforeunload/registerWorkspaceLiveCloseGuard（不变）。
