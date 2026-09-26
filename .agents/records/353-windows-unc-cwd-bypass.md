# Dev Record — #353 Windows `.cmd/.bat` agent + UNC 工作区的 pushd 绕行

## 元信息

- issue：[#353](https://github.com/AlchemistCxC/Pylon-co-works/issues/353)
- 分支：`kumo/353-unc-cwd`（独立 worktree `G:/Project/prism-team-workdir/pylon-353`，避让共享树 #363 在途脏文件）
- 提交范围：`0838dc6e..<head>`
- 日期：2026-09-27

## 目标与范围

**做什么**（引用 issue 期望行为原话）：在「执行文件为 `.cmd`/`.bat` ∧ cwd 为 UNC 路径」这一窄条件下，以 `%SystemRoot%\System32\cmd.exe /d /s /c "pushd <unc> && <cmd> <args>"` 形态启动，并对参数做防注入 quoting；条件不满足时保持现状行为不变。附带落地 issue 建议项：spawn 期「Windows 裸名 → `.cmd/.bat` 解析」从检测期补到启动期。

**不做什么**：spawn NotFound 后的重试式回退（用 Codeg 的构造期解析语义替代）；「空 env 值 = 删除变量」约定（Codeg McpServer 通道特有）；前向斜杠 UNC（`//server/share`）识别（无调用方产出该形状，保持直启）；非 Windows 平台任何行为变化。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-acp/src/windows_launch.rs` | 全文件：UNC/批处理/绝对性判定、`windows_pushd_cwd` 决策、`append_windows_batch_arg`/`make_unc_batch_command_line` 防注入 quoting、`system_cmd_exe`、`resolve_windows_program` + `is_bare_program_name`、`agent_command` 构造口 + 10 项内联单测 | 新增 |
| `src-tauri/pylon-acp/src/engine.rs` | `spawn_agent_child` 的 Command 构造段：`Command::new(&plan.executable)` + `apply_launch_plan` 两处改经 `windows_launch::agent_command(&plan)` | 修改 |
| `src-tauri/pylon-acp/src/lib.rs` | `mod windows_launch;` 一行 | 修改 |
| `src-tauri/vendor/acp/ORIGIN.md` | §6 追加 #353 出处登记（Codeg 逐函数迁入 + 适配差异） | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native ACP 行内补 `windows_launch.rs` 一句（spawn 期 Windows 特调唯一口） | 修改 |

## 方案要点

- **单一决策点**：`windows_pushd_cwd(cwd, launcher)` 是唯一判定「是否绕行」的函数，命令行与「是否设 `current_dir`」都读它，两边不可能漂移。窄条件 = 批处理启动器（`.cmd`/`.bat`，大小写不敏感）∧ Windows 绝对路径（盘符绝对或 UNC；`Path::is_absolute` 遵循宿主规则，故自写判定保证 Linux CI 可测）∧ cwd 为 UNC（含 `\\?\UNC\` 扩展长度形状）。
- **`pushd` 目标串归一**：`pushd` 是 cmd 内建、由 cmd 解析自己的命令行——扩展长度 `\\?\UNC\…` 它解析不了，尾反斜杠经 quoting 倍增后它也不还原；一律还原成普通 `\\server\share` 并去尾分隔符，否则 `pushd` 失败经 `&&` 带走整个启动。
- **防注入 quoting**：`append_windows_batch_arg` 逐字符规则与 Rust std 启动批处理文件同族（cmd 元字符引号包裹、`%`→`%%cd:~,` 阻断环境展开、反斜杠在引号/尾随时的倍增、含 `\r`/`\n`/`\0` 直接拒绝）。
- **绕行分支的 env/cwd**：argv 与 cwd 由批行承载，`current_dir(UNC)` 绝不再设（那正是 cmd.exe 拒绝并静默回落 `C:\Windows` 的形状）；plan env 照常应用。`cmd.exe` 取 `%SystemRoot%\System32`（防工作区/用户 PATH 劫持），batch 行构造失败（参数含控制字符）时 warn 后回落直启——可观测的旧行为，不把连接打成失败。
- **裸名解析**：仅「单组件且无扩展名」的裸名参与，按 `.exe`→`.cmd`→`.bat` 扩展优先序（任何目录的 `.exe` 赢过任何目录的 `.cmd`，与 CreateProcess 只补 `.exe` 的既有优先级一致）搜 PATH、不搜子进程 cwd（cmd 搜索序从当前目录开始，绕行后当前目录就是工作区，搜 cwd 等于允许仓库内同名 shim 抢启动）；`which` 依赖用 std `PATH` 切分 + `is_file` 替代。
- **接缝最小化**：`spawn_agent_child` 只换构造两行，`hide_console_window`、hermes 运行时适配、`ManagedChild`（Job Object 树清理）全部原位不动——#363 的 spawn 收口（`configure_agent_child`/`spawn_retrying_exec_busy`）合入时与本接缝正交可叠加。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `.cmd`/`.bat` 绝对路径 ∧ UNC cwd（含 `\\?\UNC\` 两变种、尾分隔符）→ 决策返回归一后的 `\\…` 串 | ✅ `pushd_is_reserved_for_a_unc_workspace_behind_a_batch_launcher`、`pushd_cwd_is_spelled_the_only_way_cmd_can_resolve_it` |
| 原生 `.exe` ∧ UNC、批处理 ∧ 盘符 cwd、无 cwd、相对/根相对/盘相对启动器 ∧ UNC → 一律不绕行 | ✅ 同上两用例 + `a_relative_launcher_never_takes_the_detour` |
| 设备路径 `\\.\pipe\…`、`\\?\C:\…` 不判 UNC；批处理判定大小写不敏感 | ✅ `detects_windows_unc_paths_…`、`detects_batch_launchers_case_insensitively` |
| 批行形状逐字符钉死（`&`、空格、`%` 展开阻断、整行引号方案） | ✅ `unc_batch_command_uses_pushd_and_escapes_cmd_metacharacters` |
| 含 `\n` 的参数被批行构造拒绝 | ✅ `unc_batch_command_rejects_line_breaks` |
| 裸名闸门：带分隔符/扩展名不增补 | ✅ `bare_name_detection_gates_the_path_lookup` |
| 条件不满足时构造结果与直启一致（程序名 + env 视图） | ✅ `non_detour_launch_is_untouched` |
| 绕行构造目标为 `%SystemRoot%\System32\cmd.exe` | ✅ `detour_command_targets_the_system_cmd_exe`（Windows） |
| 批行走真 cmd.exe：`raw_arg` 管线 + `/s` 剥引号 + `pushd` 内建 + `%CD%` 打印 = pushd 目录 | ✅ `detour_command_line_runs_a_real_batch_under_pushd`（Windows 实机端到端；UNC 共享离线不可造，用本地目录验证同一机制） |
| 既有 `apply_launch_plan` 契约不变 | ✅ 既有 `launch_plan.rs` 测试全数通过，未改动该模块 |

## 测试处置

新增：`windows_launch.rs` 内联 10 项（6 项自 Codeg 移植，4 项新增：裸名闸门、非绕行等价、绕行目标程序、实机 pushd 端到端）。修改/删除既有测试：无。

## 证据

- commit：见 PR（分支 `kumo/353-unc-cwd`，基线 `0838dc6e`）。
- 测试：`CARGO_TARGET_DIR=D:/pylon-tmp/pylon-353-target PYLON_FAKE_AGENT_BIN=<共享树既有 fake-agent> cargo test -p pylon-acp --lib` → **170 passed; 0 failed**（含新增 10 项）；`cargo fmt -p pylon-acp -- --check` 通过；`cargo clippy -p pylon-acp --lib --tests` 0 警告。
- 手工验证：实机端到端用例即真 spawn（`cmd.exe /d /s /c "pushd <dir> && echo_cwd.cmd"`），断言 `%CD%` 输出等于 pushd 目录；真实 UNC 共享（`\\wsl.localhost\…`）需运行期环境，判定逻辑已由纯函数用例覆盖。

## 与 spec 的偏差

无实质偏差。批行构造失败的处置在 spec 写为「warn 后回落直启」，实现一致；额外在 dev record 固化了「fake-agent 借用共享树二进制」这一测试环境事实（本仓该用例需 `PYLON_FAKE_AGENT_BIN` 或预构建 `--features test-agent`）。

## 未解问题

- 真实 UNC 共享下的整机验收（连真 agent 打印 cwd）未做：需要 `\\wsl.localhost\…` 工作区与已装 npm shim agent 的运行环境；issue 复现路径的机制层（cmd.exe 对 UNC cwd 的回落 + pushd 映射）已分别由实机端到端与纯函数用例覆盖。如需可后续在带 WSL 的实机上走 `webview2-acceptance` 补一轮。

## 并行交集

- 共享树零触碰（`src-tauri/**` 未动）；本分支与 #363（`engine.rs`/`process.rs`/`terminal_runtime.rs` spawn 收口）在 `spawn_agent_child` 构造段正交，合并时按 hunk 叠加即可。
- `ORIGIN.md` §6 为追加式条目，与 #362/#363 的追加条目互不覆盖。
- `docs/说明书/Pylon-模块维护地图.md` Native ACP 行与 #361-363 的更新句不相邻。
