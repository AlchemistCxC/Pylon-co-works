# Dev Record — #372 发行包内容清偿（README.txt 失实 / 下线修复脚本 / agents.yaml 模板化）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#372](https://github.com/AlchemistCxC/Pylon-co-works/issues/372)
- 分支：`kumo/prometheus`
- 提交范围：`0838dc6e..本次 head`（含 github/main 合入与 L.md 声明提交）
- 日期：2026-09-26

## 目标与范围

清偿发行包三件失实/过时内容：A) `README.txt` 的 Hermes 段与包自身矛盾（声称自带
PortableGit，实际默认包自 2026-08-31 起剔除 `resources/runtime/`）+ 结尾 `npx tauri`
命令与本仓 bun 工具链不符；B) 下线 `tools/repair-hermes-acp.{bat,ps1}`（包内最旧、
只对源码版 Hermes 有效、上游已修且本仓零引用）；C) `agents.example.yaml`（纯文档，
需手动复制才有用）替换为随包零 Agent 的 `agents.yaml` 模板。

**不做**：仓库根 `agents.example.yaml`（开发模板 + 测试夹具，`tests.rs` 以
`include_str!` 引用）不动；`load.rs`/`gateway/mod.rs` 指仓库根夹具的注释不动（语义
仍准确）；Hermes 运行时解析逻辑（`pylon-core` `hermes::runtime`）零改动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `resources/release/agents.template.yaml` | 新零 Agent 模板（`agents: {}` + 注释；头部面向随包语境：包内已名 `agents.yaml`，直接编辑即可） | 新增 |
| `resources/release/agents.example.yaml` | 旧占位示例模板（`exe: C:\\path\\to\\your-agent.exe`） | 删除 |
| `resources/release/tools/repair-hermes-acp.bat` / `.ps1` | Hermes ACP 修复脚本整两件 | 删除 |
| `resources/release/README.txt` | 【配置 Agent】YAML 段（复制改名 → 包内直接编辑）；【Hermes（Windows）】整段重写（四步 Bash 解析顺序，对齐发行包清单 §1）；删 repair 段；【安装包】`npx` → `bun run tauri --` | 修改 |
| `scripts/pack_release.py` | docstring 布局行；`AGENTS_TEMPLATE_{SOURCE,PACKAGED}_NAME` 常量；`reject_forbidden` 禁止名语义（包根 `agents.yaml` 唯一放行点）；模板收集循环改 (源名, 包内名) 二元组；删 repair 强制收集块 | 修改 |
| `scripts/tests/test_pack_release.py` | 新增 `AgentsTemplatePackagingTests`（4 用例）；`test_reject_forbidden_names_and_suffixes` 断言更新 | 修改 |
| `docs/说明书/Pylon-发行包清单.md` | §1 清单行；§2 表格（删 repair 行、agents 行改写）；§5 构建前检查项措辞；§6 禁入内容例外语义 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §9 配置来源：补「发行包首跑来源是第 2 档而非第 3 档，效果同为零 Agent」 | 修改 |
| `src-tauri/src/agent_config/embedded_agents.yaml` | 交叉引用注释（指向包内 `agents.yaml` 与模板源，不再提 `agents.example.yaml`） | 修改 |

## 方案要点

1. **仓库侧文件名 `agents.template.yaml` 是被迫的也是恰当的**：`.gitignore` 的
   `agents.yaml` 模式无斜杠、任意层级匹配，`resources/release/agents.yaml` 会直接
   无法入库；且仓库侧不占用被禁名字，「改名发生在打包器」的语义天然清晰。
2. **禁止名语义**：`reject_forbidden` 对 `FORBIDDEN_NAMES` 增加「`posix == 包根
   agents.yaml`」放行点。防泄漏本意不变——工作树任何位置的 `agents.yaml`（真实配置）
   仍一律拒绝；包根那份只能由打包器从模板改名收取，内容是零 Agent 空表。
   `FORBIDDEN_SUFFIXES` 与 `.env` 后缀检查原样保留（中途曾误删后缀检查，已复原）。
3. **#326 约束的落法**：新模板不含任何 `exe:` 行（测试断言钉死）；「裸启动零 Agent、
   无占位 Agent」口径不破。行为差异仅一处且是改善：发行包首跑配置来源从第 3 档
   （内嵌兜底）变为第 2 档（exe 旁 `agents.yaml`），两者都是零 Agent 空态。
4. **README.txt 的 Hermes 段照抄权威源**：按 `Pylon-发行包清单.md` §1 的四步解析
   顺序（`PYLON_HERMES_RUNTIME_DIR` → 包内 `resources\runtime\git`（仅
   `--with-runtime`）→ `HERMES_GIT_BASH_PATH` → 探测校验的系统 Git Bash）改写为
   用户语言，补「本机无 Git for Windows 时请先安装」的指引；保留仍准确的两段
   （Bash 卡死自愈、`HERMES_CONCURRENT_TOOL_TIMEOUT_S`）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `python scripts/tests/test_pack_release.py` 全绿 | ✅ `Ran 26 tests ... OK`（原 22 + 新 4） |
| `repair-hermes-acp` 全仓零残留 | ✅ grep 仅 `.agents/records/` 历史记录（按 issue 约定不改） |
| `agents.example.yaml` 无发行语境残留 | ✅ 剩余命中均为仓库根夹具引用（`tests.rs:1333`、`load.rs:79`、`gateway/mod.rs:161`、架构参考 §9——均指仓库根文件，语义不变）与新加的防回潜断言自身 |
| README.txt 不再含失实表述 | ✅ 「自带完整的 Git for Windows PortableGit」「请勿从发行包中删除」「npx tauri」均已移除；含四步解析顺序与 bun 命令 |
| 新模板零 Agent | ✅ 含 `agents: {}`，无 `exe:` 行（测试 `test_template_exists_is_zero_agent_and_replaces_example`） |
| 新模板/README 过真实审计 | ✅ 手工以 `reject_forbidden` + `scan_text_file`（strict UTF-8）验证通过 |
| Rust agent_config 域不受影响 | ✅ `cargo test -p pylon --lib agent_config`：64 passed, 0 failed |

## 测试处置

- 新增（`AgentsTemplatePackagingTests`）：`test_agents_yaml_allowed_only_as_packaged_template_location`（位置敏感放行）、
  `test_template_is_collected_under_packaged_name`（改名映射钉死）、
  `test_template_exists_is_zero_agent_and_replaces_example`（零 Agent + 旧模板不得回潜）、
  `test_template_passes_release_audit_under_packaged_name`（模板过包内名审计）。
- 修改：`AuditTests::test_reject_forbidden_names_and_suffixes`（裸 `agents.yaml` 从
  无条件拒绝表移到位置敏感断言，补 `resources/agents.yaml`）；`AuditTests::test_scan_allows_placeholder_path`
  的 rel 参数 `agents.example.yaml` → `agents.template.yaml`（断言不变）。

## 证据

- commit：`12dbc095`（本任务主体，7 文件）。**并行事故如实记录**：三个删除
  （`agents.example.yaml`、`repair-hermes-acp.{bat,ps1}`）原由本任务 `git rm` 暂存，
  被并行 agent 的 `12a8acd7`（自称只提交 `.agents/L.md`，实际 pathspec 未生效）从
  共享 index 连带扫入并先行入库；内容结果与本任务预期一致，按「不改写历史」禁区
  未回退，`12dbc095` 补齐其全部配套（打包器收集/审计/清单/README 段落）。
- 测试：`python scripts/tests/test_pack_release.py` → `Ran 26 tests, OK`，退出码 0；
  `cargo test -p pylon --lib agent_config` → `64 passed; 0 failed`。
- 手工验证：两份新发行文本文件过 `reject_forbidden`/`scan_text_file` strict UTF-8 审计；
  `release/pylon-0.3.0-AUE-win64.manifest.json` 实证 `agents.example.yaml`/`README.txt`/
  repair 脚本的现行包内位置（包根与 `tools/`），确认 `tauri.conf.json` resources 不含
  `resources/release/`、无双份拷贝问题。
- 限制：未跑完整 `bun run release:portable` 出包验证（需全量构建；打包器逻辑改动已被
  单测与真实函数审计覆盖）。

## 与 spec 的偏差

无实质偏差。spec 验收标准 6 预估「按需抽跑」，实际执行了 agent_config 域全量 64 用例。

## 未解问题

无。

## 并行交集

本次碰过的共享文件：`docs/说明书/Pylon-发行包清单.md`、`docs/说明书/Pylon-项目架构参考.md`、
`scripts/pack_release.py`、`scripts/tests/test_pack_release.py`、`resources/release/**`、
`src-tauri/src/agent_config/embedded_agents.yaml`。与 L.md 在途的 #351（`src/` 下沉 + 
`scripts/check-runtime-boundaries.mts`/`audit-maintenance.test.mts`）、#348/#349
（`pylon-acp`/session）、#370（ChatView.css）、#371（离线文档站，已声明避让
`pack_release`/清单）、#373（solidRendererSurface 测试）文件域无交集。工作树内
`src/plugins/core/renderer/__tests__/solidRendererSurface.test.ts` 与 `.agents/L.md`
的在途改动非本次所为，未纳入任何提交。
