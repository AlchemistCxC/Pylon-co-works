# Dev Record — #258 stderr 处理管线去重与分配削减

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/258
- 分支：`kumo/prometheus`（堆叠于 PR #257 的 #253/#254/#255 提交之上，文件域完全不相交）
- 提交范围：`243f9de3..fa94f759`（代码提交 `fa94f759`）
- 日期：2026-09-23

## 目标与范围

消除 agent stderr 逐行处理路径上的重复计算与多余分配，**行为逐字节不变**：

- `pylon-acp/src/stderr.rs`：每行 3 次完整 JSON 解析收敛为 1 次；等级判定一次复用（echo + hub push）；消掉整行 clone。
- `pylon-foundations/src/sanitize.rs`：`sanitize_message(String)` → `&str`。
- `pylon-acp/src/stderr_tail.rs`：`sanitize_diagnostic` 消除无命中规则的全量拷贝；`summarize_parser_error` 正则 OnceLock 预编译。

不做：`StderrTail` 保留/截断策略、echo tracing 宏分支结构、wire_trace/engine 等其他已排查候选（另行立项）、前端。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-acp/src/stderr.rs` | `stderr_fields`/`level_from_fields`/`unstructured_level`/`code_from_fields` 拆分；`classify_stderr_level`/`extract_stderr_code` 退化为薄入口（公开签名不变）；`spawn_stderr_reader` 循环解析收敛；新增 `mod tests` 7 条钉子测试 | 修改 |
| `src-tauri/pylon-acp/src/stderr_tail.rs` | `sanitize_diagnostic` 加 `is_match` 守卫；`ParserErrorPatterns` + `parser_error_patterns()`（OnceLock）；`summarize_parser_error` 改消费预编译表（输出构造逻辑逐行保留） | 修改 |
| `src-tauri/pylon-foundations/src/sanitize.rs` | `sanitize_message` 签名 `String` → `&str`（非 REDACTED 路径补 `to_owned()` 喂给按值收参的 `truncate`） | 修改 |
| `src-tauri/src/runtime_log/mod.rs` | `sanitize_message` 薄包装签名跟随；`push_with_context` 内调用点 `&message.into()` | 修改 |
| `src-tauri/src/permission.rs` | `interaction` prompt 构造处借用化（`&raw_input`）一行 | 修改 |

## 方案要点

- **解析一次的语义陷阱**：原 `classify_stderr_level` 在「行是 JSON object 但 `level` 缺失/类型不可辨」时会**落回非结构化整行致命信号扫描**（`{"msg":"core dumped"}` → error）。收敛时不能把 structured 分支写成「缺 level 返回 info」，必须 `Option` 落回——`level_from_fields` 返回 `Option<&'static str>`，`None` 走 `unstructured_level`。钉子测试 `object_without_usable_level_falls_through_to_marker_scan` 专钉此语义。
- **非 object 的合法 JSON**（数组/标量，如 `"fatal string"`）原实现走整行扫描，`stderr_fields` 对其返回 None 保持同路径（测试 `non_object_json_goes_through_marker_scan`）。
- **`sanitize_diagnostic` 等价论证**：旧 fold 对无命中规则做 `Cow::Borrowed.into_owned()` = 拷贝一份相同值；新循环直接跳过该规则，规则施加顺序（逐规则作用于累积串）不变，有命中时 `replace_all` 必返回 Owned。
- **`summarize_parser_error` 保留 `.ok()` 跳过语义**：`position`/`missing_field` 存为 `Option<Regex>`，categories 用 `filter_map(Regex::new.ok)`——静态 pattern 意外失效时行为与旧实现一致（分支跳过），而非 panic。
- `sanitize_message(&str)` 分配账：调用方免 clone；REDACTED 路径少一次拷贝；非 REDACTED 路径函数内 `to_owned()` 与原调用方 clone 等量。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 新增 stderr 分类钉子测试全绿 | ✅ 7/7（`stderr::tests::*`） |
| `stderr_tail.rs` 既有测试未修改且全绿 | ✅ 6/6 零改动 |
| `cargo test --workspace` | ✅ 1411 通过 / 0 失败 / 4 ignored |
| `cargo fmt --all -- --check` | ✅ 干净 |
| clippy 基线零新增 | ✅ 仅存量 6 条（`session/create.rs`×4、`dispatcher/routing.rs`、`pylon-core/agent_detection.rs`，均为 #155/#163 域既有）；本次触碰文件零警告 |

## 测试处置

- 新增：`pylon-acp/src/stderr.rs` `mod tests` 7 条（结构化字符串/数字 level、object 缺 level 落回、非 object JSON、非结构化 marker 表、code 提取、一次解析派生与公开入口逐行对拍）。
- 修改/删除：无（stderr_tail 既有 6 条与全部其余测试零改动）。

## 证据

- commit：`fa94f759`
- 测试：`cargo test --workspace`（`CARGO_TARGET_DIR=D:/pylon-acceptance-target`）→ 12 个 test binary 全 `ok`，合计 1411 passed / 0 failed；`cargo fmt --all -- --check` rc=0；clippy 上述基线外无输出。
- 收益定位（改前实测代码）：`stderr.rs:81/:90/:113/:131`（3 次解析 + 2 次分类 + 整行 clone）、`stderr_tail.rs:178-184`（每行最多 17 次分配）、`:296-348`（每调用最多 7 次 `Regex::new`）。

## 与 spec 的偏差

无实质偏差。spec 预想 `runtime_log:192` 写成 `sanitize_message(message)`，实际因 `message` 形参是 `impl Into<String>`（不保证 `&str`）改为 `sanitize_message(&message.into())`，等价且最小。

## 未解问题

- 同类已排查未立项候选（后续可各自成 issue）：`wire_trace.rs` 满容量逐出 O(n) min-scan（会话期 O(n²)）；`engine.rs` replay 广播零订阅者仍深克隆 + 双锁；`hook_bridge.rs` 整请求 clone 后 emit；前端 `toolPresentation` 输出行数双遍统计、`GenerationFooter` 每 tick 重切分等。

## 并行交集

- 本次触碰：`pylon-acp/src/{stderr,stderr_tail}.rs`、`pylon-foundations/src/sanitize.rs`、`src/runtime_log/mod.rs`、`src/permission.rs`（均已在 L.md [2026-09-23 05] 条目声明）。
- 观察到但不碰：`scripts/code-stats*.mts`（另一会话 #259 在途域）。
