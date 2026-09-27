# Dev Record — #386/#387 0.3.1 发行回归修复（启动参数翻倍 + hermes 构建机路径）

> 入库保留。产出路径：`.agents/records/2026-09-27-386-387-launch-args-and-hermes-runtime.md`

## 元信息

- issue：[#386](https://github.com/AlchemistCxC/Pylon-co-works/issues/386)（LaunchPlan 双重应用）、[#387](https://github.com/AlchemistCxC/Pylon-co-works/issues/387)（CARGO_MANIFEST_DIR 候选泄露），均本 agent 认领
- 分支：`kumo/prometheus`；基准 `3ee39beb`（0.3.1-FMF 发行记录）+ `c3ad5919`（L.md 声明）
- 日期：2026-09-27
- 用户指令：「把githbash和这个bug全修了，修完重新打包，替换原有的同版本应用」

## 根因（诊断证据）

**#386**：#353 重构后 `engine.rs::spawn_agent_child` 调 `windows_launch::agent_command(&plan)`（直启分支内部已 `apply_launch_plan` 一次，windows_launch.rs:52），随后 engine.rs:640 又 `apply_launch_plan` 一次。`command.args()` 为追加语义 → argv 翻倍。实锤：WMI `Win32_Process` 抓到发行版真实命令行 `"F:\...\venv\Scripts\hermes.exe" acp acp`（agents.yaml 只有 `args: [acp]`）；壳外 `hermes acp acp` 逐字重现 `hermes: error: unrecognized arguments: acp`。env/cwd 覆盖式 setter 无害，仅 args 累加。**影响面=所有非空 args 的 agent**（peri `acp`、claude-code `--acp` 同样中招）；`args: []` 的 hermes-2 不受影响——即「有的 Hermes 能连、有的不能」的原因。

**#387**：`hermes::runtime::pack_runtime_roots()` 无条件把 `env!("CARGO_MANIFEST_DIR")` 相对候选编译进二进制（原注释称 release harmless，实测 release 同样生效）：发行日志出现 `bash=G:\Project\prism-team-workdir\...\resources/runtime/git\bin/bash.exe bundled=false`——构建机 checkout 被选为运行时（路径泄露 + 开发机上可能压过健康系统 Git）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/pylon-acp/src/windows_launch.rs` | `agent_command` 收口为 agent 子进程 `Command` 唯一构造口：plan（argv/cwd/env）**恰好应用一次**（直启全量；绕行仅 env、argv/cwd 由批行承载）；`set_utf8_env`（#363-1 默认先于 plan env）与 `hide_console_window`（#348 A3）一并内聚 |
| `src-tauri/pylon-acp/src/engine.rs` | `spawn_agent_child` 删除第二次 `apply_launch_plan` 与 `configure_agent_child`；hermes runtime env 应用保持在 plan 之后 |
| `src-tauri/pylon-acp/src/process.rs` | `configure_agent_child` 文档注释改写：现服务非 plan 通道（agent 侧 terminal）及其单测 |
| `src-tauri/pylon-core/src/hermes/runtime.rs` | `pack_runtime_roots()` 两个 manifest 候选加 `#[cfg(debug_assertions)]`；「release harmless」注释删除 |

## 门禁

- `cargo test -p pylon-acp -p pylon-core`：185 + 133 passed / 0 failed
- `cargo test --workspace`（`CARGO_TARGET_DIR=D:/pylon-acceptance-target`）：**1644 passed / 0 failed**（首跑 13 失败均系 D 盘全新 target 缺 `pylon-fake-agent` 夹具 bin，构建夹具后全绿；与本次改动无关）
- `cargo fmt --all -- --check`：rc=0；`bun run check:clippy`：`added: []`（基线外零新增）
- 测试处置：强化 `non_detour_launch_is_untouched`（新增 `get_args()==["acp"]` #386 回归钉 + cwd + utf8 四项默认 env 断言）、`detour_command_targets_the_system_cmd_exe`（`get_args` 恰为一条批行、`get_current_dir()==None`、env 断言）；其余无改动

## 打包与实机替换验收

- `CARGO_TARGET_DIR=D:/pylon-acceptance-target bun run release:portable` → **EXIT=0**；verify OK：manifest ⇔ ZIP 逐项一致（306 项；tag 构建为 302，增量为分支后续入库的 SDK 类型树等内容）；sha256 = `10f1bbc1a013abb8160403d3146fa4f2bb4a7082c69a31700c53cb4e988525d2`
- 替换 `F:\A-I\Platform\Pylon\`：除 `agents.yaml`（包内为零 Agent 模板，**不得覆盖用户配置**）与 `data/` 外全量覆盖；exe FileVersion=0.3.1-FMF（LastWriteTime 2026-09-27 15:53）；删除 #372 已废弃的 `tools/repair-hermes-acp.{bat,ps1}`；`tools/webview2-mcp/pylon-webview2-mcp.exe` 因正被本会话 MCP 进程占用，验收后停进程再替换完成；临时解压目录已清

| 验收项 | 结果 |
| --- | --- |
| #387 bash 解析 | ✅ 启动日志 `bash=F:\Git\bin\bash.exe root=F:\Git bundled=false`——系统 Git，`G:\Project` 路径消失 |
| #386 参数恰好一次 | ✅ WMI 捕获 `"F:\...\hermes.exe" acp`（修复前为 `acp acp`） |
| hermes（riccati profile）连接 | ✅ 适配器启动 → 插件加载 → OpenAI client 建立 → ACP session `f50ee72f-…` 创建；无 `unrecognized arguments`；UI 无错误横幅 |
| 用户数据完整性 | ✅ `agents.yaml`/`agents.yaml.bak`/`data/`/`portable.flag` 原样保留 |

## 与 spec 的偏差

无（规格 `.agents/spec/386-launch-plan-double-apply.md` 按约定一次性、不入库）。

## 未解问题 / 备注

- ⚠️ **G 盘 100% 满（余 287M）**：本轮所有 cargo 构建走 `CARGO_TARGET_DIR=D:/pylon-acceptance-target`；G 盘 `src-tauri/target` 的 debug 缓存已在链接期触磁盘不足，后续 agent 注意。
- claude-code / peri 未做真机复验（单测已钉 argv 恰好一次）；如需可按同法各发起一次会话。
- `tools/webview2-mcp/pylon-webview2-mcp.exe` 替换发生在 MCP 进程停止后，若它方正持旧进程需重启会话侧 MCP。
- `release/pylon-0.3.1-FMF-win64.*` 为同版本号重打包（内容=分支 HEAD）；GitHub Release 上的 0.3.1-FMF 附件未动，是否更新远端附件留仓库主裁决。
