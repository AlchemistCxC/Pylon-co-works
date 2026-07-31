# 子 Agent 派发任务卡模板

> 用途：把 .agents/tasks/backend/BE-*.yaml 展开为自包含指令，派发给 delegate_task 子 agent。
> 子 agent 无对话上下文，不能问问题——本卡必须自包含。
> 每卡对应一个 commit，由子 agent 自己提交，不 push。

## 派发前主控检查
- [ ] YAML 任务卡已存在（.agents/tasks/backend/）
- [ ] 依赖任务已合入（dependencies.tasks 全部完成）
- [ ] 工作区无冲突文件未提交改动（git status 检查）
- [ ] 目标文件路径无冲突

## 派发文本模板

```
# 任务：<BE-ID> <标题>

## 背景
项目：Pylon（Tauri v2 + Rust 后端），工作区 G:\Project\prism-desktop。
本任务属于 gateway（平台适配器层）开发，设计定稿见 docs/后端开发与交接手册.md 的 B10 相关小节。
<YAML 的 source_facts 要点>

## 目标
<YAML goal.technical_result>

## 实现要求
<YAML guidance.invariants 展开，精确到函数签名/结构字段>

## 参考源码
<inspect_first 路径逐条列出，注明"照抄/参考/仅阅读">

## 文件边界
新建/修改：<likely_modify 列表>
禁止修改：src/**（前端）、src-tauri/src/lib.rs、src-tauri/src/acp.rs、G:\Project\prism、他人未提交改动

## 验证（必须全部通过）
export PATH="/f/Coding/rust/toolchain/.cargo/bin:/f/Coding/c/mingw64/mingw64/bin:$PATH"
export TMP=F:/tmp && unset RUSTFLAGS
cd /g/Project/prism-desktop/src-tauri
cargo check --offline        # 必须零 warning
cargo test --offline --lib <你的测试 filter>   # 必须全绿

## 提交
git add <你新建/修改的文件>
git commit -m "feat(gateway): <BE-ID> <中文标题>"
不要 push。

## 铁律
1. 只改任务指定文件，不碰前端 src/、不碰 lib.rs/acp.rs（除非任务明确要求）
2. cargo check 零 warning 才提交；warning 必须消除（不是 allow 掩盖）
3. 测试要真实断言，不许空测试
4. 完成后报告：改动文件、测试结果、commit hash
```

## 派发参数（delegate_task）
- goal：上面的完整任务文本（自包含）
- context：附加信息（工具链/项目结构/参考路径），子 agent 可见
- 完成后主控必须核验：git log 有对应 commit、cargo test 结果复跑、文件内容抽查
