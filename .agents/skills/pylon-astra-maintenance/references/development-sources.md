# 研究依据与 Pylon 经验

检索于 2026-09-12。skill 是 Pylon 工作流适配，不是 Astra 的隐藏能力说明，也不要求模型特有 API。

| 资料 | 采用内容 | 边界 |
| --- | --- | --- |
| [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) | 清楚的内部命名和 casing | 不强制替换现有框架约定、wire 字段和整个工具链 |
| [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/naming.html) | Rust 命名与 acronym 规则 | 不跨语言统一成同一种大小写 |
| [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow) | 分支、PR、review 与检查 | 默认不自动合并用户分支 |
| [git-worktree](https://git-scm.com/docs/git-worktree) | 并行目录隔离、分支归属 | 不代表共享 node_modules/target 同时写入安全 |
| [C4 components](https://c4model.com/diagrams/component) | 用职责/接口表达组件 | 不按文件数量衡量模块化；按实际需要画图 |
| [Nygard ADR](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) | 短决策、上下文、状态、后果 | 小编辑无需追加大型决策文档 |

在当前 Pylon checkout 核对以下证据，而不是把历史记录当作永久规则：

- `CONTEXT.md` 区分 Agent Instance/Profile、Presentation Profile/Renderer Engine、Workbench Host Port 与 Event Provenance。
- `BOARD.md` 有并行文件/hunk 归属、负载下竞态、孤儿门禁、待接线代码被误判死代码等经验。只读取目标主题的记录，并验证当下是否仍适用。
- `scripts/check-runtime-boundaries.mts`、Solid 边界、产品贡献与 CSS ownership 检查表达当前模块限制；不能扩展豁免掩盖新依赖。
- `package.json` 与 `.github/workflows` 是验证命令的事实来源。集成检查输出和 git head 需要共同记录，不能沿用旧 PR 的绿色结果。

前向使用场景：从混合会话宿主中提取纯投影，检查所有调用者；对未声明模型能力保持原语义；面对已被其他分支修复的问题先同步和核对；因 wire 需要出现 snake_case 时用显式内部别名，而非重命名协议。
