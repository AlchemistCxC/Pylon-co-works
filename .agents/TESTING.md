# 测试与 Debug 节点

## Level 1：任务开发中

目标是快速开发，不机械跑全套。

- 运行 1–3 个直接覆盖当前改动的 targeted tests。
- 类型或模块接线变化时运行一次 build/cargo check。
- 不默认运行真实 Tauri、真实 Peri、真实 Prism 或完整测试矩阵。
- 测试失败必须区分当前回归、既有失败和环境阻塞。

## Level 2：Lane Checkpoint

每完成 2–4 个强相关任务、一个共享模块闭环或准备跨 Lane 消费契约时执行。

Frontend：

```bash
npm run test:frontend
npm run build
```

Backend：

```bash
export PATH="/f/Coding/rust/toolchain/.cargo/bin:/f/Coding/c/mingw64/mingw64/bin:$PATH"
export TMP=F:/tmp   # C 盘满，cargo 必须指过去
cd src-tauri
unset RUSTFLAGS     # GNU 工具链，禁止 lld 替代 MinGW ld
cargo check --offline
cargo test --lib --no-run
cargo test --lib <focused> -- --nocapture
```

只跑受影响的 focused tests，不机械跑全部真实环境。

## Level 3：Milestone Integration

以下节点才进行集中真实验收：

- Workspace Sheet 主链
- ACP 单 active Agent 主链
- Prism 读/写链
- Workspace/Runtime 闭环
- Git 只读闭环
- 多 Agent runtime
- 发行候选

证据严格分层：browser、Tauri invoke/event、真实 Peri JSONL、真实 Prism 临时数据、Windows process、artifact read-back。

## Debug 归属

- 单 Lane 局部回归：创建该 Lane debug task。
- 前后端契约不匹配：先确认 producer 契约，再创建 consumer 修复 task。
- 集成修复超过小型接线范围：不得在 checkpoint 中顺手扩大，退回新任务卡。
