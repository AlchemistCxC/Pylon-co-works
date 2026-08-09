# Pylon Issue Library Harness

双人双 Agent 执行入口：[`harness/README.md`](harness/README.md)

- 依赖与总索引：[`INDEX.md`](INDEX.md)
- 未决策阻塞：[`未决策项.md`](未决策项.md)
- 双人协作协议：[`harness/COLLABORATION.md`](harness/COLLABORATION.md)
- 文件所有权：[`harness/OWNERSHIP.md`](harness/OWNERSHIP.md)
- 契约冻结：[`harness/CONTRACT-FREEZE.md`](harness/CONTRACT-FREEZE.md)
- 旧单 Agent Harness：[`harness/MIGRATION.md`](harness/MIGRATION.md)（只读冻结，不再领取新任务）

长程 Agent 启动时先读本文件，再进入 `harness/README.md`。任务卡必须来自按依赖重排后的 Issue 子任务；不得把整个 Issue Library 当作单一串行任务执行。
