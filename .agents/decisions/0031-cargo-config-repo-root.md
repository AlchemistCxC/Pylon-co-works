# ADR-0031 构建配置置于仓库根：cargo 配置发现按 cwd，`--manifest-path` 不携带 manifest 目录的 `.cargo/`

- **日期**：2026-09-27
- **状态**：已采用（实施见 #399）

## 背景与约束

`src-tauri/.cargo/config.toml`（#106 P6 引入）设 `[target.x86_64-pc-windows-msvc] linker = "rust-lld"`
与 `[profile.dev] debug = "line-tables-only"`。cargo 的配置发现**从 cwd 逐级向上**，`--manifest-path`
只改变 manifest 选择、**不**把 manifest 所在目录的 `.cargo/config.toml` 纳入；局部探针实测：cwd 在
仓库根 + `--manifest-path sub/Cargo.toml` 时，manifest 目录的配置完全不加载。

于是本仓同一 workspace 出现两种形态：

- 形态 S（配置生效）：`cd src-tauri && cargo …` —— `scripts/generate-acp-golden-trace.mjs:63`、
  `package.json` 的 `check:rust`、`.github/workflows/ci.yml:276`。
- 形态 R（配置失效 → 退回 MSVC `link.exe`、`debug` 取 profile 默认）：`cargo --manifest-path src-tauri/Cargo.toml …`
  —— `scripts/check-acp-shadow-parity.mjs:41/86/273`、`scripts/check-clippy.mjs:35`、`ci.yml:400`、`ci.yml:306`。

`-C linker` 参与每个 unit 的 rustc flag 哈希，且 `-C extra-filename` 不含 linker ⇒ 两形态写**同一批产物路径**、
互相作废。实测同一 target 目录：形态 S 编 9 个 crate → 切形态 R 再编 9 个 → 切回 S 又编 9 个（`pylon-fake-agent` 图，
9 个 crate 全量）。

代价（CI run 36319970454 / 36317357926 / 36312288458 同型）：`rust-shadow` job 995s，其中
`check:acp-shadow` 一步 **784s**（脚本自报：generator 357–419s、fixture A 295–305s、fixture B 1.1s、
背压 51–58s），而测试本体仅 0.27–0.36s。同一命令的 fixture A 与 B 差约 300 倍，即「A 重编、B 复用」。

约束：不改构建行为契约（linker 与调试信息口径不变）；不动 CI job 结构、rust-cache 配置、
shadow 比较逻辑、golden 基线；不改任何 cargo 调用点的 cwd 与参数。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 改 `check-acp-shadow-parity.mjs` 的 cargo 调用为 `cwd: src-tauri` | 只修一处调用点：`check-clippy.mjs`、CI clippy job、`ci.yml` 的 `cargo check --manifest-path` 以及未来新增的调用点仍会踩同一坑；调用方需要知道 cargo 的配置发现规则才对 |
| CI 环境变量 `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=rust-lld` | 只管 CI：本地 `check:rust`（先 `cd src-tauri` 再跑 `check:acp-shadow`）仍双向震荡；且把一处配置拆成「文件 + env」两处真源 |
| 两处都不动，改脚本为显式 `--config target.…linker="rust-lld"` | 把配置内容复制进调用点，rust-lld 换版本/换 linker 时要改多处 |
| 维持现状 | 每次 run 白付约 5–8 min 编译，且本地每次 `check:rust` 一样付；成因（cwd 决定配置可见性）在源码里看不出来，后来者会反复重新发现 |

## 决定

`.cargo/config.toml` 置于**仓库根**（由 `src-tauri/.cargo/` 上移）。任何 cwd——仓库根、`src-tauri`、
子 crate、`tools/` 下的独立 workspace——向上走都能命中同一份配置，`cd` 与 `--manifest-path` 两种写法
收敛到同一构建指纹。文件头写明位置约定与成因，防后来者"顺手归位"。

## 后果

- **正面**：cwd 不再影响构建指纹；`check:acp-shadow` 的 generator 与 fixture 落同一形态（本地实测
  fixture A 295s 量级 → 3.9s）；`check:clippy.mjs`、CI clippy job、`ci.yml` 的 `--manifest-path` 调用点
  一并修复，无需逐个改造。
- **负面**：`tools/webview2-mcp`（不属 `src-tauri` workspace）从仓库根构建时也会吃到 `linker = "rust-lld"`
  与 `[profile.dev] debug`；该 crate 只有 release 构建入口（`release:portable`），验证通过（见证据）。
- **风险**：配置路径变更使 rust-cache 键变化（rust-cache 把 `.cargo/config.toml` 计入键）→ 三个 Rust job
  各付一次冷编译；此后收敛为单形态。回滚 = 把文件移回 `src-tauri/.cargo/`，无数据与契约变更。

## 证据

- 配置与位置约定：`.cargo/config.toml:15-22`
- 双 cwd 指纹探针（临时 target 目录，`pylon-fake-agent` 图，cargo 1.98.1）：
  - 迁移前：形态 S 9 → 形态 R 9 → 切回 S 9（三向都整图重编）
  - 迁移后：全新 target + 仓库根 cwd 的 rustc 命令行含 `-C linker=rust-lld` 12 次；形态 S → 形态 R → 切回 S
    → 子 crate cwd（`src-tauri/pylon-acp`）依次 **0 / 0 / 0 / 0** 次重编
- 行为结论不变：`bun run check:acp-shadow` → exit 0，`ok/deterministic` true、8 scenario × 9 字段 parity 全 true
- 调用点未变：`git diff` 不含 `scripts/**`、`.github/workflows/**`
