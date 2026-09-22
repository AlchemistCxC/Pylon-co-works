# Dev Record — 「默认携带 PortableGit」旧表述清偿（hermes runtime）

> 2026-09-23 实机验收（webview2 MCP，实例 `F:\A-I\Platform\Pylon\pylon.exe` 2026-09-22 构建）曾把
> 「便携包缺 `resources/runtime/git`、回退到开发机树」记为部署缺陷。用户澄清：**默认发行不携带
> PortableGit 本就是 2026-08-31 决定的现状**，误导来自代码与文档里的旧表述。本条清偿表述，不改行为。

## 元信息

- issue：无（用户指令的直接修正；验收四项功能问题另登记 [#250](https://github.com/AlchemistCxC/Pylon-co-works/issues/250)，与本条无关）
- 日期：2026-09-23
- 分支：`Ru5t/crate-extraction`
- 文件域：`src-tauri/pylon-core/src/hermes/runtime.rs`、`docs/说明书/Pylon-发行包清单.md`

## 变更

`runtime.rs`（6 处）：

1. 模块头注释：删除「The release packager places a complete PortableGit tree at `resources/runtime/git`」旧断言，改为「默认发行不携带（2026-08-31 决定，`--with-runtime` 才有）」并写明探测顺序。
2. `HERMES_GIT_BASH_PATH` 文档注释：「select the bundled Bash」→ 不预设来源。
3. `HermesRuntimeSelection.bundled` 字段补语义注释：仅 `--with-runtime` 包内树为 true。
4. `apply_to_command` 内注释：「the bundled MSYS」→「the selected MSYS」。
5. **找不到 Bash 的用户可见错误文案**：旧文案「Pylon 发布包应包含 resources\runtime\git」对默认包用户是错误指引，改为「默认发行不携带 PortableGit：可安装 Git for Windows、设置 `PYLON_HERMES_RUNTIME_DIR`，或 agents.yaml 指定 `HERMES_GIT_BASH_PATH`」。
6. `bundled_runtime_roots()` → `pack_runtime_roots()`，返回 `(root, bundled)` 对：**exe 同级包内树才标 `bundled=true`；`CARGO_MANIFEST_DIR` 开发树与 `PYLON_HERMES_RUNTIME_DIR` 覆盖目录标 `false`**。此前的写法会把开发机树在运行日志里标成 `bundled: true`——正是验收误诊的直接来源。日志字段值在开发树命中时由 true 变 false（观测量修正，选择顺序与探测行为不变）。

`Pylon-发行包清单.md`（1 处）：

- §1 解析顺序句与代码实际顺序对齐：① `PYLON_HERMES_RUNTIME_DIR` → ② 包内 `resources/runtime/git` → ③ `HERMES_GIT_BASH_PATH` → ④ 系统 Git Bash；旧句为「包内 → 环境变量 → 系统」且漏 `HERMES_GIT_BASH_PATH`。代码顺序未动（改代码顺序属行为变更，超出「修正表述」授权）。

## 验证

- `cargo test -p pylon-core --lib`：**118 passed / 0 failed**（含 hermes::runtime 16 项）
- `cargo clippy -p pylon-core --lib`：本次改动文件 0 warning（分支既有 `agent_detection.rs:1088` `needless_return` 1 条，非本条文件域，未动）

## 影响面

- 纯表述 + 日志观测量修正；运行时选择顺序、探测、PATH 注入等行为路径零变化。
- 前端/插件不受影响；发行包内容不受影响。
