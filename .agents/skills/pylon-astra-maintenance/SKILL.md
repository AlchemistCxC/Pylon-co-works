---
name: pylon-astra-maintenance
description: 在 Pylon 的 TypeScript/Solid/React 与 Rust/Tauri 项目中执行分块重构、命名统一、模块标注与协作交接，适用于 Astra 持续维护任务。
---

# Pylon Astra 分块维护

适用于正在工作的 Pylon checkout。Astra 主模型保留目标、架构判断、实施、集成和验收的连续上下文；不要求更换模型，也不默认拆成规划者与廉价执行者。

## 先定位当前事实

用 `git rev-parse --show-toplevel` 定位仓库，读取当前 AGENTS、`CONTEXT.md`、`docs/说明书/Pylon-模块维护地图.md` 与目标模块。开发规范见 `docs/说明书/Pylon-开发与协作规范.md`。文件不存在时记录缺项，检查源码入口；不要凭旧 task 摘要、BOARD 声明或失效的 G: 路径断言已经完成。

记录 base/head、dirty paths、当前 PR 和有关门禁。需要同步 main 时保留在途工作后同步到工作分支；每块开始前复核涉及文件，不要求反复扫描整个仓库。新目标横跨全项目时先做一次覆盖清单，此后只追踪变化。

## 从责任决定切块

为目标块写清数据所有者、输入输出、所有调用者、状态/资源生命周期、允许依赖和验证命令。先找重复完整流程、调用不一致、职责重叠和已无消费者的旧路径；大文件行数仅用作定位。

纯转换留在无副作用模块，事务编排保留在 owner 宿主，renderer 只消费 Host Port。`plugins/core` 是产品实现，不能据名字迁入 Kernel。新模块头部说明责任与副作用约束；不要为追求文件数增加空代理、第二个 registry 或通用 store 容器。

移动与内部命名调整尽量保持协议不动；修改行为时单独说明原因。检查生产调用而不只看测试调用，防止把未接线但已有计划和局部消费者的模块误删为死代码。架构变化记录必要的上下文、取舍、后果与证据。

删除旧入口前搜索无扩展名 import、带扩展名 import、re-export 和动态加载；不能只搜完整文件名。删除后立即跑类型检查与入口挂载测试，再扩大集成验证。

## 命名与关键不变量

- TS 内部绑定 camelCase，类型/组件 PascalCase，固定常量 SCREAMING_SNAKE_CASE；Rust 采用 snake_case / PascalCase。框架文件后缀保持现有契约。
- 长作用域优先具体名称：`sessionResponse`、`configOptions`、`pendingEvents`。缩写 `props`、窄循环 `index`、泛型 `T` 可保留；不进行全项目文本替换。
- 区分 local/remote session id、agentId、profileId、ownerKey、generation；时间和容量标出单位。`source` / `periId` 等公开字段、ACP/IPC/SQLite/localStorage/CSS/plugin id 都不能作为普通变量随意改名。
- 不改变 commit-before-publish、replay 信任级别、事件去重、generation fence、取消和卸载清理。某个数组/快照是衍生值，不意味着可以另建可写状态源。

## 协作与持续推进

读取 BOARD 中与当前块相关的认领信息，核对对应代码/提交后再使用。多人工作先约定文件与接口责任，独立 worktree 隔离；共享契约由一个集成人处理。只有当前指令授权且任务确实可独立并行时才委派；交接明确目标、读写范围、禁止动作、验收和停止条件，不再增加代理层。

持续记录已完成块、仍缺证据的要求、真实运行句柄及下一块入口。用户中途纠正纳入当前目标，不重新定义较小的成功标准。声明“已修复”需要代码与行为证据；绿色单测不能证明 UI 美术或原生 Agent 全链路可用。

## 验收与输出

执行与变化匹配的定向测试和边界检查，再执行当前 package.json / workflow 中的集成门禁。只有竞态/负载相关变化才加对应压力验证；不因普通重命名重复大批不相关检查。

失败先复现并区分 baseline、环境和回归；保留日志，不为绿色结果放宽 allowlist、关闭规则或删除断言。CI 完成状态必须匹配本次 head/base，草稿、可审阅、已合并分别记录；合并权限来自用户，不来自 CI。

交付报告包括：模块/命名变化、行为保持依据、测试及 CI、剩余风险和下一块。目标包含整项目改造时，文档和 skill 的完成只算其中一块，不能代替后续生产代码整改。

需要回顾资料的适用边界时读取 [研究依据](references/development-sources.md)。
