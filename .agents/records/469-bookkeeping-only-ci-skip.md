# Dev Record — #469 簿记类文档改动免 CI（ci 路由 + 门禁总闸）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/<issue>-<slug>.md`

## 元信息

- issue：[#469](https://github.com/AlchemistCxC/Pylon-co-works/issues/469)（ACh 授权改 CI）
- 分支：`ci/469-bookkeeping-skip`（基于 `origin/main @ 0b14a59c`）；纯簿记样本 `worker/469-bookkeeping-sample`
- 提交范围：`0b14a59c..1bafec9d`（本笔）+ `1bafec9d..ce4ed507`（样本笔）
- 日期：2026-09-30
- PR：[#473](https://github.com/AlchemistCxC/Pylon-co-works/pull/473)（机制）、[#474](https://github.com/AlchemistCxC/Pylon-co-works/pull/474)（纯簿记样本）

## 目标与范围

**做**：让「只碰簿记类文件」的 PR 跳过 CI 的五个重活，同时**不绕门禁**——办法是新增一个**恒有产出**的汇总作业（`门禁总闸`），把「是否有重活失败」的表达权收口到它一条检查上。

**不做**：不动任何业务代码 / 测试 / 契约；不动其他 workflow；不引第三方 action（路径判定走 `git diff` 的 bash，不引 `dorny/paths-filter`）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | 新增 `changes` 作业（`判定改动面`）；`frontend` / `frontend-test` / `rust-test` / `rust-clippy` / `rust-shadow` 各加 `needs: changes` + 作业级 `if`；文件末尾新增 `ci-gate`（`门禁总闸`） | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 「验证」节补一句 #469 后的 CI job 形态 | 修改 |
| `.agents/L.md` | 开工声明；样本笔撤 `#266` 刀 5 与本批条目 | 修改 |
| `.agents/records/469-bookkeeping-only-ci-skip.md` | 本记录 | 新增 |

## 方案要点

### 白名单（正向）

免 CI 的路径只有这些（正则见 `ci.yml` 的 `changes` 作业）：

```text
AGENTS.md  README.md  .agents/L.md  .agents/BOARD.md
.agents/{records,decisions,spec,templates}/**
```

**正向**语义：任何没列出的路径都会照常触发重活。特别地 `docs/说明书/**`、`CONTEXT.md`、`.agents/dev-standards.md` **不在**名单内——它们是 `check-doc-links` / `check-hook-anchor-parity` 的输入，改它们必须跑 CI。改这份白名单等于改门禁范围，属**显式动作**。

比较基点：PR 事件取 `pull_request.base.sha`（`actions/checkout` 默认落在 merge ref，故 `git diff base.sha HEAD` 恰为该 PR 的改动）；push 事件取 `github.event.before`；取不到或为全零时**按「不只是簿记」兜底**。`fetch-depth: 0` 必须（默认 depth 1 会让 `git diff <sha>` 失败）。

### `门禁总闸` 为什么必须存在

重活被跳过时，其检查结论是 `skipped`。GitHub 官方文档（《Troubleshooting required status checks》《Control jobs with conditions》）明确：**作业级跳过的检查算通过**（"A job that is skipped will report its status as 'Success'... even if it is a required check"；接受的状态是 `success` / `skipped` / `neutral`）。

**但矩阵作业是例外，且本次实测到了**：跳过发生在矩阵展开**之前**，只产出一个「未展开名」的检查 —— 本次样本 PR 的检查名就是字面的 `前端测试（vitest 分片 ${{ matrix.shard }}/2）`，旧 ruleset 要的 `前端测试（vitest 分片 1/2）` / `（分片 2/2）`**根本没有产出**。若它们仍是必需检查，则检查恒缺、PR 恒卡。

⇒ 必需检查**不能**继续挂在 5 个重活（尤其矩阵作业）上，必须收敛到一条恒有产出的检查。`ci-gate` 用 `if: always()` + `needs:` 全列实现：重活任一 `failure`/`cancelled` ⇒ 它失败；其余（含 `skipped`）⇒ 它成功。`if: always()` 不能省，否则上游失败时它自己也不跑，检查一样恒缺。

### 顺序约束（不可倒）

1. 先合 `ci.yml`（此时 ruleset 仍要旧 6 条，本笔改的是 ci.yml ⇒ 非簿记 ⇒ 全部产出 ⇒ 可合）；
2. 确认 `门禁总闸` 在 main 上真的产出；
3. **再**改 ruleset（必需检查只留 `门禁总闸`）。

倒过来 = gate 不产出时所有 PR 卡死。此外中途有一个**必须缩短的窗口**：`ci.yml` 已合、ruleset 未改的这段时间里，簿记类 PR 会跳过重活，而旧 ruleset 仍要求两条矩阵检查名 ⇒ 纯簿记 PR 卡住。**这两步应由同一个人连续执行。**

### ruleset（`main-protection-owner-bypass`，id `23202065`）

- 改前必需检查 6 条：`前端静态门禁（lint + tsc + build）`、`前端测试（vitest 分片 1/2）`、`前端测试（vitest 分片 2/2）`、`Rust（fmt + 测试 + 构建）`、`Rust（clippy 基线门禁）`、`Rust（ACP shadow parity）`；另含 `deletion`（禁删分支）与 `non_fast_forward`（禁 force push），`strict_required_status_checks_policy: false`。
- 目标：收敛为单条 `{"context":"门禁总闸","integration_id":15368}`；`context` 必须**逐字**等于 job 的 `name`。
- **本次未执行**：`AquaTur5235` 在本仓库是 write 协作者（`GET /repos/...` → `permissions.admin = false`），改 ruleset 需管理员权限。实测：原样 `PUT /repos/.../rulesets/23202065`（无净变更）→ `404 Not Found`；对照组（`target: "bogus-target"` 的 `POST /repos/.../rulesets`，**必定**校验失败）→ 同样 `404`，即权限判定先于载荷校验；探针后 ruleset 语义与 `updated_at` 均未变。⇒ 待有 admin 权限者执行。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 本笔 PR 的 7 条检查全部产出且绿 | ✅ PR #473：`判定改动面` 8s、前端静态 2m51s、vitest 4m1s / 4m2s、Rust 7m26s、clippy 4m48s、shadow 5m12s、`门禁总闸` 4s —— 7/7 pass，run 墙钟 **468s** |
| `changes` 判定正确（本笔） | ✅ 日志「改动文件：`.agents/L.md` / `.github/workflows/ci.yml` / `docs/说明书/…模块维护地图.md`」⇒ `bookkeeping_only=false` |
| `门禁总闸` 汇总语义 | ✅ 日志「各作业结果：success,success,success,success,success,success」⇒ 门禁通过 |
| 纯簿记 PR ⇒ 5 重活 skipped、`门禁总闸` success | ✅ PR #474：`判定改动面` success 6s；`前端静态门禁` / `前端测试（未展开名）` / `Rust（fmt+测试+构建）` / `Rust（clippy）` / `Rust（ACP shadow parity）` 全部 **skipped**；`门禁总闸` **success** 2s。日志「各作业结果：success,skipped,skipped,skipped,skipped,skipped」⇒「门禁通过（skipped 按不适用处理）」。run 墙钟 **15s**（对照 468s） |
| ruleset 改前 JSON 存档 | ✅ `E:\Acode\FILES\任务\工作台优化\报告等\13-施工单-簿记类文档改动免CI（ci路由+门禁总闸）\2026-09-30-ruleset-23202065-before.json` |
| ruleset 改后 JSON | ✗ **未产出**（无 admin 权限，见上） |
| ruleset 收敛后「允许合并」端到端 | ✗ **未达成**（同上）。样本 PR #474 当前 base 为 `ci/469-bookkeeping-skip`（其检查全绿但无需合并）；ruleset 收敛后需把它 base 改成 `main` 再验 |
| `#266` 刀 5 的 L.md 遗留撤掉 | ◑ 条目已在样本笔撤掉；该笔合入需 ruleset 先收敛 |
| **`push` 到 main 的事件路径**（`changes` 取 `github.event.before`；施工单 §四 第 2 步「确认 `门禁总闸` 在 main 上产出」） | ✗ **未验证** —— 本会话未合并任何 PR，故没有任何 push-to-main 运行。该分支的 bash 逻辑（非全零 `before`、`git diff before HEAD`）只在代码审查层面成立，未被执行过 |

## 测试处置

**新增/修改单测：无**（CI 配置，无被测单元）。行为可观测面 = CI 自身 + 纯簿记样本 PR #474。

## 证据

- commit：`e30df5bc`（L.md 声明）、`b9791fec`（ci.yml + 说明书同步）、`ce4ed507`（样本笔）、本记录一笔
- 完整命令与输出落盘：`E:\Acode\FILES\任务\工作台优化\报告等\13-施工单-簿记类文档改动免CI（ci路由+门禁总闸）\`
- 本地五步门禁**未跑**：本笔零业务代码改动，施工单 §六.8 明示不必跑（CI 已跑全套，见上）

## 与 spec 的偏差

施工单 §六.1 原写「`frontend-test` 是 2 片矩阵，`if:` 加在作业级 ⇒ 两片都 skipped ✓」。**在新 ruleset 下成立**（gate 是唯一必需检查，矩阵检查名不重要），**但在「ci.yml 已合、ruleset 未改」的过渡窗口里不成立**：跳过的矩阵作业只产出未展开名（本次样本 PR 实测到），旧 ruleset 要的两条展开名恒缺 ⇒ 纯簿记 PR 卡死。故施工单 §四 的合并顺序必须与 ruleset 收敛**成对**执行，不能只合 `ci.yml`。

另：本机 `github.com:443` 不通（`git push` / `fetch` 均失败），远端分支与提交改用 GitHub git-data API 等价建立（blob→tree→commit→ref），提交内容与本地逐字节一致（树 SHA 相同），仅提交对象的时间写法不同 ⇒ commit SHA 与本地不同。

## 未解问题

1. **ruleset 收敛未执行**（权限），故 #469 的最终目标尚未生效，「允许合并」的端到端证据待补。
2. 样本 PR #474 的 base 现为 `ci/469-bookkeeping-skip`，ruleset 收敛后需改为 `main` 才有意义。
3. 本地分支与远端因网络不可达而 SHA 不同（内容一致）；网络恢复后 `git fetch` + 对齐即可。
4. **`push` 到 main 的事件路径未实测**（见验收表末行）：`ci.yml` 合入后第一次 main push 才能验证；若该路径有问题，表现是 main 上的 run 红或 `changes` 报错，不阻塞任何 PR（main push 无需合并），修法局部。
5. CI 既有告警：`actions/checkout@v4` 目标是 Node 20、被强制跑在 Node 24（`##[warning]`），所有 job 均有，非本次引入，未处理。

## 并行交集

- `.github/workflows/ci.yml`：本次新增 2 个作业、5 个作业各加 2 行。与 `#401` / `#413` 的 ci.yml 改动不重叠，但同属一个文件，后续批次请按 hunk 分账。
- `docs/说明书/Pylon-模块维护地图.md`：「验证」节一句。与在途 `#454` / `#375`+#`376` 的说明书改动邻接，冲突时保留双方。
- `.agents/L.md`：撤 `#266` 刀 5 与本批条目。
