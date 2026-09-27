# Dev Record — #361 发行版 pylon.exe 是 console 子系统

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/361-release-gui-subsystem.md`

## 元信息

- issue：[#361](https://github.com/AlchemistCxC/Pylon-co-works/issues/361)
- 分支：`kumo/prometheus`
- 提交范围：本批（#361/#362/#363 单 PR）自 `82631455` 之后
- 日期：2026-09-27

## 目标与范围

**做什么**：让 release 构建的 `pylon.exe` 落在 GUI 子系统（PE `OptionalHeader.Subsystem` = 2），debug 保留 console（= 3）；并保证改成 GUI 子系统后**没有**子进程再往桌面上弹控制台窗口。

**不做什么**：

- **#330**（发行构建内置 CDP 调试端口 9222）只被 issue 备注为「建议同批」，它是独立 OPEN issue，不在本批处置、也不因本 PR 关闭。
- 不加发行包启动器脚本（GUI 子系统已消除控制台窗口）。
- 不动其他 bin 的子系统：`pylon-cli` / `pylon-detect` / `pylon-fake-agent` 是给人读输出的控制台工具。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/main.rs` | crate 根属性 + 日志守卫绑定 | 修改 |
| `src-tauri/pylon-foundations/src/child_command.rs` | `HideConsoleWindow` trait（std/tokio 双实现）+ 差分验收用例 | 新增 |
| `src-tauri/pylon-foundations/src/lib.rs` | 模块登记 | 修改 |
| `src-tauri/pylon-foundations/Cargo.toml` | windows-sys 加 dev-dependency（`Win32_System_Console`） | 修改 |
| `src-tauri/pylon-foundations/src/git.rs` | `run_git_with_timeout_env` 收口 | 修改 |
| `src-tauri/pylon-core/Cargo.toml` | 新增 `pylon-foundations` 依赖边 | 修改 |
| `src-tauri/pylon-core/src/agent_detection.rs` | reg.exe / taskkill / 版本探针 / npm.cmd 四处收口 | 修改 |
| `src-tauri/pylon-core/src/agent_diagnostics.rs` | reg.exe 收口 | 修改 |
| `src-tauri/pylon-core/src/hermes/runtime.rs` | 内联 `creation_flags` 改为共享收口 | 修改 |
| `src-tauri/pylon-acp/src/process.rs` | `hide_console_window` 委托共享实现 | 修改 |
| `src-tauri/src/plugin_process/mod.rs` | `command_for` 收口 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native ACP 行表述 | 修改 |
| `docs/说明书/Pylon-发行包清单.md` | 打包后验收项新增子系统/不弹窗检查 | 修改 |

## 方案要点

1. **属性落点**：`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 必须写在二进制 crate 根（`lib.rs` 上的同类属性不作用于 bin 的 PE 头）。`[profile.release]` 未覆盖 `debug_assertions`，所以 `not(debug_assertions)` 恰好等于「release = GUI、dev/test = console」。
2. **issue 的耦合前提被实测推翻了一半**：issue 说「#348 已完成三处生产 spawn 的 `CREATE_NO_WINDOW` 覆盖，所以可以改子系统」。实测全仓后确认——**那三处都在 pylon-acp 内**，而闪窗风险来自**全部**生产 spawn：`git`（workbench 热路径）、`reg.exe`、`npm.cmd`、版本探针、hermes 的 Git Bash 预检、插件进程都缺这个标志位。只改子系统会让这些路径开始各自弹一个可见控制台窗口。
3. **收口下沉到地基 crate**：新增 `pylon_foundations::child_command::HideConsoleWindow`（trait 同时实现 `std::process::Command` 与 `tokio::process::Command`），把原有的两处实现（pylon-acp 的 `hide_console_window`、hermes 的内联 `creation_flags`）统一到它并覆盖全部生产 spawn。
4. **新增依赖边 `pylon-core → pylon-foundations`**：这是本批唯一的 crate 图变更。方向向下（foundations 不依赖任何本仓 crate，无环），与 `pylon-acp`/`pylon-session` 已有的同类边一致；不加这条边则 pylon-core 的探测类 spawn 漏收口。**已按纪律在 PR 描述中显式提出，供仓库主裁断**（未擅自登记 ADR——决策未完成前不登记）。
5. **`eprintln!` 是 GUI 子系统下的地雷**：release 双击启动的进程没有控制台，stderr 句柄无效，而 Rust 的 `eprintln!` 写失败会 **panic**。因此本批把启动兜底路径的 `eprintln!` 换成 `logging::note_to_stderr`（忽略错误 + 同步追加到当日日志文件）。详见 #362 的开发记录。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| release 的 `pylon.exe` PE Subsystem == 2 | 通过（见「证据」，实测读数） |
| debug 的 `pylon.exe` PE Subsystem == 3 | 通过 |
| `pylon-cli.exe` 未受波及（仍 console） | 通过 |
| 全部生产 spawn 带 `CREATE_NO_WINDOW` | 通过（独立审查逐点枚举 11 处生产 spawn 全覆盖，无遗漏；测试/开发 bin 不计） |
| 「不弹控制台窗口」可机器验证 | 通过——新增**差分**用例：把测试可执行文件自己再拉起一次，子进程用 `GetConsoleWindow()` 报告窗口句柄。控制组（不加标志位）非 0，加了标志位为 0 |
| 发行包验收清单含子系统检查 | 通过（`docs/说明书/Pylon-发行包清单.md`） |

## 测试处置

- 新增：`pylon-foundations/src/child_command.rs` 三条用例——`both_command_kinds_still_spawn_with_the_flag`（加了标志位仍能 spawn）、`hiding_the_console_window_removes_the_window_handle`（差分验收）、`console_probe_child`（探针本体，非探测模式空过）。
- 修改/删除既有测试：**无**。

## 证据

- commit：见本批 PR
- 测试：`cargo test -p pylon-foundations --lib child_command` → `3 passed; 0 failed`（exit 0）
- PE 头读数（自建 `node` 脚本读 `e_lfanew@0x3C` → PE 签名 → `OptionalHeader+0x44`，PE32/PE32+ 该偏移相同）：

```
校准（同法）：C:\Windows
otepad.exe          -> Subsystem=2 (GUI)
             C:\Windows\System32\cmd.exe     -> Subsystem=3 (console)
改动前：      release/pylon.exe                 -> magic=0x20b Subsystem=3 (console)
改动后（重建）：
  DEBUG   src-tauri/target/debug/pylon.exe         -> Subsystem=3 (console)  ← debug 保留 console ✓
  RELEASE src-tauri/target/release/pylon.exe       -> Subsystem=2 (GUI)      ← 本项要达成 ✓
  RELEASE src-tauri/target/release/pylon-cli.exe   -> Subsystem=3 (console)  ← 未受波及 ✓
```

- 独立审查（子 agent，对抗式）：确认属性落点合法且只作用于 `pylon` bin；独立枚举全仓生产 spawn **无遗漏**；无回归向量（全仓无 `Stdio::inherit`、无 `GetConsoleWindow`/`AttachConsole` 读取、凭据提示早已关闭）；`tokio 1.53.1` 的 `creation_flags` 在 vendored 源码 `process/mod.rs:675-678` 实证存在；新依赖边无环且不违反任何成文规则；PE 偏移算术正确。

## 与 spec 的偏差

1. **spec 未提「收口要跨 crate」**：实测发现漏收口的 spawn 分布在 pylon-core / pylon-foundations / 主 crate，因此新增了共享模块与一条依赖边（spec 只写了 pylon-acp 的三处）。理由见方案要点 2/4。
2. **spec 说「若无既有落点则用一次性命令验证，不新增常驻门禁」**：实际新增了一条**常驻差分用例**（用 windows-sys 的 `GetConsoleWindow`），因为它把「不弹窗」从人工验收提升为可回归的机器断言，成本只有十几行 + 一个 windows-only dev-dependency。
3. **spec 未预见 `eprintln!` 在 GUI 子系统下 panic**：由独立审查指出后修正（见 #362 记录）。
4. 新增的启动期 `note_to_stderr` 收口、`logging` 模块与日志目录解析属于 #362 范围，此处只作交叉引用。

## 未解问题

1. **`pylon-core → pylon-foundations` 这条依赖边需仓库主裁断**。它是本批为收口不得不加的向下边；若仓库主认为 pylon-core 应保持「零本仓依赖」的独立库定位，替代方案是在 pylon-core 内留一份等价实现（代价是同一标志位两处维护）。
2. **实机「不弹窗」只覆盖到标志位生效层面**：差分用例证明子进程拿不到控制台窗口句柄，但没有覆盖「用户在真实发行包里逐个功能点操作时无闪窗」这一整面。建议发行前按 `docs/说明书/Pylon-发行包清单.md` 的新增验收项实机过一遍。

## 并行交集

- 本批期间共享工作树同时有 #371（docs_sheet）、#354（fs 错误码）、#376（内存载荷）、#352（独立 worktree）在途。本文件域内文件与它们的交集：
  - `src-tauri/src/lib.rs`：本批 hunk（`init_tracing`/`LogGuard`/漂移检查/`run()` 的 PATH 修复/`note_to_stderr` 替换）与 #371 的 docs_sheet 接线 hunk 同文件。**按 #371 在 `L.md` 的明确请求，本批连带提交其 hunk**（`docs_sheet/` 已入库，无悬空引用）。
  - `src-tauri/src/session/mod.rs`：本批 hunk 在 `:408-445`（lag warn 节流）与测试尾部；#376 的 `evt_load_compact` hunk 在 `:841-856`。**本批提交用私有 index 只取自己的 hunk**，不带入 #376 的在途改动。
  - `src-tauri/Cargo.lock`：含 `tracing-appender`（本批）与 `symlink`（他人在**已提交**的 manifest 里声明、lock 尚未跟上的条目），一并提交以保持 lock 与 manifest 一致。
  - `docs/说明书/Pylon-发行包清单.md` 与 `Pylon-模块维护地图.md`：本批的表述改动**被其他 agent 的提交连带带入库**（分别为 `7a713bc2` 与 #354 的记账提交），因此本批 PR 的 diff 里看不到这两处。内容已在库中且正确，此处留档以免后人误判为丢失。
