# Dev Record — #444 脱敏词表单源化（批次②③）+ export_session 路径收窄

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 批次①（注释路径随迁 + `scripts/sanitize-vocabulary.test.mts` parity 门禁）随 PR #438 落地，见该 PR 描述；本记录承接批次②③。

## 元信息

- issue：#444（refactor(export): 脱敏词表单源化 + export_session 路径收窄漂移修复）
- 分支：kumo/prometheus
- 提交范围：PR 描述为准（批次①后的增量批次）
- 日期：2026-09-30

## 目标与范围

- 批次②：export Strip 敏感 key 词表构建期生成——Rust `is_export_sensitive_key` 为单源，TS 侧（`threeSourceExport.ts::isSensitiveExportKey`）改消费生成物，`--check` 并入 `check:frontend` 链。
- 批次③：`export_session` 补 `redactAbsolutePath` 等价实现（落 `pylon-foundations`，Rust 单测），消除「路径收窄只在 TS 有」的能力漂移；用户导出与前端取证导出脱敏强度对齐。
- **不做什么**（issue 明言）：不做 `sanitize_batch` IPC 命令（browser 回退会令两份实现都活着，单源化落空）；不动 Redact 表（`is_sensitive_key` 含 attachment/header + 8KiB 截断，TS 有意不镜像，非漂移）；值正则不生成（Rust regex ↔ JS 方言差异，仍由 parity 测试看守两侧字面量）；browser 预览模式前端实现保留（`IS_TAURI=false` 无后端）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/generate-export-sanitize-vocabulary.mjs` | 全新：读 sanitize.rs `is_export_sensitive_key` 函数体字面量（exact/ends_with/contains 三组），渲染 TS 生成物；`--check` 校验模式；锚点紧——函数缺失、matches! 缺失、三组之外残留字面量、规则解析为空均报错退出 | 新增 |
| `src/domains/export/canonicalExportSanitizeVocabulary.generated.ts` | 生成物：`EXPORT_SANITIZE_EXACT_KEYS`（11）/ `_SUFFIXES`（3）/ `_CONTAINS`（1），as const，随附 Rust /// 文档 | 新增（生成） |
| `src/domains/export/threeSourceExport.ts` | `isSensitiveExportKey` 改消费生成物做规则组合（签名/行为不变）；文件头纪律段与脱敏段注释随迁（词表单源说明 + redactAbsolutePath 的 Rust 镜像指引） | 修改 |
| `scripts/sanitize-vocabulary.test.mts` | TS exact 名单来源从「源码 grep `lower === 'x'`」改为导入生成物常量；新增生成物↔Rust 源的 suffix/contains 数组精确比对；行为探针测试保留（生成物↔行为↔Rust 源三方互证）；头部注释重写 | 修改 |
| `package.json` | 新 `build:export-sanitize-vocabulary` / `check:export-sanitize-vocabulary`；`--check` 插入 `check:frontend` 与 `check:frontend:static`（check:retention-policy 之后） | 修改 |
| `src-tauri/pylon-foundations/src/sanitize.rs` | 新 `redact_absolute_path`（逐行为镜像 TS `redactAbsolutePath`）+ `redact_export_absolute_paths`（树收窄第二阶段）+ 私有 `redact_value_paths`；4 个新单测（TS 期望值互钉 / 边角 / 树遍历保形 / 与 Strip 组合） | 修改 |
| `src-tauri/src/export.rs` | `export_session` 管线改两段式 `redact_export_absolute_paths(&sanitize_export_messages(&messages))`；头部注释随迁；新接线表征单测 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 「契约单源」行族新增「export 脱敏词表单源」行 | 修改 |

## 方案要点

1. **词表生成方向**：按 dev-standards「跨语言契约的单源方向」以 Rust 为单源，TS 派生（先例：generate-retention-policy.mjs / generate-canonical-event-types.mjs）。不 `cargo run` 取值，直接解析源码字面量——不把 cargo 拖进纯前端门禁链。
2. **生成器防静默漏词**：函数体内每条 `"..."` 字面量必须被三组规则之一消费，残留即报错——Rust 侧引入新规则形态（如 `starts_with`）时必须显式接入生成器，绝不吐出看似正常的短表。
3. **门禁双层**：`check:export-sanitize-vocabulary`（生成物 ↔ Rust 源字节级同步，入 check:frontend 链）+ `sanitize-vocabulary.test.mts` 行为探针（生成物 ↔ `isSensitiveExportKey` 行为 ↔ Rust 源派生谓词）。值正则仍由该测试 JS 重放语义等价看守。
4. **批次③镜像口径**：`redact_absolute_path` 逐行为对齐 TS `redactAbsolutePath`——NUL→REDACTED、盘符（`/^[a-zA-Z]:[\\/]/` 的字节级等价判定）/UNC（`//`）/根相对（`/`、`\`）判绝对、尾分隔符剥离、非空末段取 `…/末段`、空段（裸根 `/`）→REDACTED、无分隔符盘符前缀（`C:`）不算绝对。**有意不含** obs05 `narrowPathValues` 的 ≥2 段豁免——那是该函数面向 ipc 命令串的特有裁决，issue 点名镜像的是 `redactAbsolutePath` 本体。
5. **接线两段式**：export_session 输出 `redact_export_absolute_paths(&sanitize_export_messages(&messages))`——对齐前端取证管线「sanitizeExportValue → 路径收窄」的顺序（敏感 key 剔除先行，路径收窄只作用于幸存字段）；markdown 与 JSON 两条输出同源受益。
6. **Rust 实现细节**：`next_back()`→`rev().find()`（clippy `double_ended_iterator_last`/`filter_next` 两条新诊断的清偿路径）；split 逐字符 + 空段过滤与 TS 正则 `[\\/]+` 切分 + filter(Boolean) 终态等价。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| parity 测试入 `bun run test`；生成器 `--check` 入 `check:frontend` | ✅ `sanitize-vocabulary.test.mts` 14/14 绿（vitest 纳管）；`check:export-sanitize-vocabulary` 入两条 check 链，实测「与 Rust 单源一致（exact 11 / 后缀 3 / contains 1）」 |
| export_session 路径收窄有 Rust 单测；前后端导出同一会话脱敏强度一致 | ✅ foundations 4 个新单测 + export.rs 接线表征测试；管线两段式与前端取证管线同构（sanitize → 收窄），期望值与 TS 测试同源互钉 |
| `check:clippy` 绿 | ✅ 本批两个 crate（pylon-foundations / pylon）基线外零新增（`added: []`，见证据） |

## 测试处置

- 新增（Rust，pylon-foundations）：`redact_absolute_path_mirrors_frontend_expectations`、`redact_absolute_path_edges`、`redact_export_absolute_paths_walks_strings_and_keeps_shape`、`redact_export_absolute_paths_composes_after_strip`。
- 新增（Rust，pylon）：`export::tests::export_pipeline_narrows_absolute_paths_after_strip`（与命令体内调用顺序逐字对应的接线表征）。
- 适配（vitest）：`scripts/sanitize-vocabulary.test.mts`——exact 名单来源改生成物导入 + suffix/contains 数组比对（原「TS 函数体内 `lower === 'x'` 源码 grep」随词表生成化失效，属契约迁移，非行为变更）；探针集不变。
- 既有测试零修改零删除：`threeSourceExport.test.ts` 25 用例原样绿（`isSensitiveExportKey` 签名与行为未变）。

## 证据

- 测试：
  - `cargo test --workspace --lib` → **9 目标全绿，合计 1667 passed / 0 failed**（pylon 970 / pylon-session 216 / pylon-foundations 91（含 4 新增）/ pylon-acp 186 / pylon-core 137 / 其余 38；pylon 含 1 新增接线测试）
  - `cargo fmt --all --check` → exit 0
  - `bun run test`（全量 vitest）→ **5179 passed / 0 failed**（665 文件；期间一次红灯为并发在途改动窗口内的 flake，重跑全绿，见「并行交集」）
  - `bun run check:export-sanitize-vocabulary` → exit 0
  - `bunx tsc -b` → exit 0
  - `bun scripts/check-doc-links.mjs` → 通过（4 项）；`check:maintenance` → exit 0
  - `bunx eslint <3 个改动 TS 文件>` → 0 error
- clippy：`bun run check:clippy` 整链 **exit 0**（并发批次入库后全量复跑；pylon-foundations / pylon 基线外 `added: []`。过程中 clippy 先后报 `double_ended_iterator_last`、`filter_next` 两条本批新诊断，均已修复而非入基线）。

## 与 spec 的偏差

- spec 批次③提过「`src-tauri/src/sanitize.rs`（re-export 面）」——实际该文件不存在，R21 的 re-export 是 `lib.rs:64` 对 `pylon_foundations::sanitize` 的整体引出，新函数零改动即对 `crate::sanitize` 可见，无偏差动作。
- 其余按 spec 落地。

## 未解问题

- `redact_absolute_path` 与 TS `redactAbsolutePath` 的行为互钉靠两侧**同期望值**单测（字面量重复），未做跨语言行为重放（如把 Rust 函数编译进测试夹具）——两函数共 9 条分支，期望值漂移风险低，值不值得上重放夹具留后续裁量。
- `export_session` 的 markdown 输出中，工具 title/status 不含路径字段，路径收窄的实际受益面是 JSON 导出与 markdown 正文中的消息文本；若未来 markdown 模板新增路径类字段，收窄已在管线上游生效。

## 并行交集

- 共享树内并发存在（均已 L.md 声明、域不重叠）：[kumo] #471 发行链（`scripts/pack_release.py`、`scripts/stage-docs-site.mjs`、`scripts/tests/test_pack_release.py`、`docs/说明书/Pylon-发行包清单.md`）与 event_repo 搜索批次（`src-tauri/pylon-session/src/event_repo/**`，未见于 L.md 在途条目）。本批提交一律 pathspec，不触碰上述文件。
- 本批碰过的共享文件：`package.json`（scripts 区段两行 + 两条 check 链各插一段）、`docs/说明书/Pylon-模块维护地图.md`（契约单源行族插一行）、`scripts/sanitize-vocabulary.test.mts`、`src/domains/export/threeSourceExport.ts`。
