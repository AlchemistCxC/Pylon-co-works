# 共享契约冻结协议

## 何时必须提案

B 或 A 要修改公共组件结构、props、selector、CSS token、overlay/z-index、store schema、IPC DTO、事件、持久化格式或构建依赖时，先创建 `contracts/proposals/<contract-id>.yaml`。

## 流程

```text
draft → proposed → reviewed → frozen → implemented → verified → superseded
               └→ rejected
```

1. 提案者记录当前契约证据、目标变化、兼容策略、受影响任务和测试。
2. A 审查业务与架构影响；B 涉及视觉契约时审查视觉承载能力。
3. 产品行为变化必须由用户拍板；纯实施契约可由 A 冻结。
4. 冻结后移至 `contracts/active/`，写入 `version` 和 `frozen_at_commit`。
5. 实现任务卡必须引用 `contract_refs`；不得实现未冻结 proposal。
6. 需要改 frozen contract 时新建下一版本，不直接改写历史版本。

## 兼容窗口

- 默认要求同一 PR 内完成 producer 和至少一个 consumer 测试。
- 跨 PR 时 producer 先提供兼容层，旧 consumer 保持可运行；最后一个 consumer 迁移并验证后才能删除兼容层。
- 删除或重命名稳定 selector/token/API 属破坏性变更，必须列出迁移清单。

## 裁决

- 实现冲突：A 按 frozen contract 裁决。
- 视觉表现未定义：B 提案，用户或 A 按是否涉及产品行为决定。
- 契约与当前源码不符：进入 `blocked_contract_drift`，先更新证据或新版本，不允许强行实现。
