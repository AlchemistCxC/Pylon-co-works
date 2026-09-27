# Dev Record — #384 clippy 缺本地入口：补 `check:clippy` 并纳入 `check:all`

> 入库保留。产出路径：`.agents/records/384-clippy-local-gate.md`

## 元信息

- issue：#384（enhancement）——https://github.com/AlchemistCxC/Pylon-co-works/issues/384
- 分支：`kumo/prometheus`（共享分支，PR #374）
- 日期：2026-09-27
- 触发：#382 期间该分支 CI 红在 `pylon | clippy::items_after_test_module | src-tauri/src/lib.rs`；仓库主要求把「clippy 老是没人跑」变成结构性约束

## 目标与范围

**做什么**：

1. 新增 `scripts/check-clippy.mjs` + `bun run check:clippy`：语义与 CI 的 `rust-clippy` job 逐条一致（workspace `--all-targets` 收诊断 → 逐 crate 与 `artifacts/clippy-baseline.json` 比「基线外新增」）。
2. `check:all` 纳入 `check:clippy`。
3. `AGENTS.md` §2.4 补一条规则，并让完工判据点名 `check:clippy`。

**不做什么**：

- 不修 `src-tauri/src/lib.rs` 那条既有新诊断（属 #383 批的在库代码，非本 issue 域；见「未解问题」）。
- 不改 CI 的 `rust-clippy` job 结构、不改 `artifacts/clippy-baseline.json`（基线更新需与仓库主确认）。
- 不动 `scripts/check-clippy-baseline.mjs` 的判定语义。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/check-clippy.mjs` | 新脚本：cargo clippy → 逐 crate 基线比对；诊断 JSON 落系统临时目录 | 新增 |
| `package.json` | 增 `check:clippy`；`check:all` 链中插入 `check:clippy` | 修改 |
| `AGENTS.md` | §2.4 新增「clippy 是独立门禁」条目；完工判据点名 `check:clippy` | 修改 |

## 方案要点

1. **为什么是脚本而不是 package.json 里的一行 shell**：CI 的形态是「`cargo clippy --message-format=json` 落文件 → `for spec in …` 逐 crate 调 `check-clippy-baseline.mjs`」，需要循环与临时文件，用 Node 脚本跨平台且无需假定 `bash`。
2. **CRATES 列表与 ci.yml 循环必须同源**（脚本头注释已写死这条要求）：两处不同步就会出现「本地绿、CI 红」或反向漏判——正是本 issue 要消灭的形态。
3. **诊断 JSON 落 `os.tmpdir()`，不写仓库工作树**：CI 落 `artifacts/` 是为了上传失败证据包，本地没有这个需求，写工作树只会污染 `git status`。
4. **纳入 `check:all`**：规则靠记忆必然复发，「跑全门禁」是唯一不会漏的执行路径。代价是本地全门禁多一次 clippy（`--all-targets`，热缓存分钟级）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 有基线外新诊断时 exit 1 且逐 crate 打印 | ✅ 当前树实测：`pylon` 报 `added: [clippy::items_after_test_module \| src-tauri/src/lib.rs]`，脚本 exit 1，其余 5 个 crate `added: []` |
| 与 CI 判定一致 | ✅ 本地复现出与 CI 相同的判红 crate 与指纹（同一条 clippy 命令 + 同一基线） |
| 无新增诊断时 exit 0 | ✅ 机制同源（5 个 crate 的 0-added 分支实测通过）；当前树本身有一条真实新诊断，故整链绿需先修该诊断 |
| `check:all` 含 `check:clippy` | ✅ `"check:all": "… && bun run check:rust && bun run check:clippy && bun run check:solid"` |
| AGENTS.md 有条目 | ✅ §2.4 新条目 + 完工判据点名（§7 要求仓库主批准：本 issue 即仓库主指令） |

## 测试处置

- 新增测试：无（门禁脚本自身由 CI/本地实跑验证；判定逻辑在 `check-clippy-baseline.mjs`，其语义未改）。
- 修改/删除既有测试：无。

## 证据

- 命令与结果：
  - `node scripts/check-clippy.mjs` → exit 1，`check-clippy-baseline FAILED: 1 new diagnostic(s) in crate pylon`，指纹 `pylon | clippy::items_after_test_module | src-tauri/src/lib.rs | items after a test module`；`pylon-core/acp/session/foundations/pet-core` 均 `added: []`
  - 本地镜像 CI 的原始命令（`cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets --message-format=json` + 手抄循环）→ 与脚本结论一致
- 新 crate 的 clippy 现状（#382 交回）：`grep -c pylon-fake-agent /g/TEMP/clippy-local.json` → 0 条诊断
- 环境注记：本地一律 `CARGO_TARGET_DIR=D:/pylon-382-target`（G: 盘 99%）

## 与 spec 的偏差

无 spec（本 issue 由仓库主直接指令，规模小）；相对指令多做了两处、均已在上文说明理由：新增 `scripts/check-clippy.mjs`（而非只加规则）、把 `check:clippy` 并入 `check:all`。

## 未解问题

1. **分支 CI 仍红在别人的 lint**：`src-tauri/src/lib.rs:717` 起是 `#[cfg(test)] mod init_tracing_tests { … }`（717–~853），其后仍有 `pub fn startup_mark`（855）等条目 → `clippy::items_after_test_module`。引入提交 `ad3fcbd9`（#383 批）。修法：把该 test 模块整块移到文件末尾。**本批未动**（不在本批文件域，且 #383 可能同时在改该文件）。
2. **`pylon-fake-agent` 未纳入基线循环**：`--all-targets` 会编它（诊断数为 0），但循环清单里没有它 ⇒ 其诊断不会被判红。是否按 #247「新 crate 零警告新立」纳入，待仓库主裁断。
3. `check:all` 现在会因上述 lint 而红：这是它应有的行为（本地提前暴露 CI 判红），但会给并行施工者一个「不是自己引起」的红——已写进 AGENTS.md 条目解释。

## 并行交集

- `AGENTS.md`、`package.json`（后者在 #375/#376 声明域内：本批只改 `check:clippy`/`check:all` 两行，提交前已核对不含他人 hunk）
- 新增 `scripts/check-clippy.mjs`
- 未触碰 `src-tauri/**`、`artifacts/clippy-baseline.json`、`.github/workflows/ci.yml`
