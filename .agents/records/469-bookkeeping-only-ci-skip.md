# Dev Record — #469 簿记类文档改动免 CI（ci 路由 + 门禁总闸）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 本记录为**最终态**（2026-10-02 重做），取代 2026-09-30 那份记录「阻塞态」的草稿（其内容已随旧 PR #473/#474 关闭作废）。

## 元信息

- issue：[#469](https://github.com/Teens-in-Times/Pylon-co-works/issues/469)（已重开，ACh 授权改 CI）
- 分支：`ci/469-bookkeeping-skip.1`（基于 `origin/main @ d993324c`）
- 日期：2026-10-02（重做；首轮 2026-09-30 因本账号无 admin 权限改不了 ruleset 而中止于草稿）
- 仓库：`Teens-in-Times/Pylon-co-works`（已自 `AlchemistCxC` 迁移；本账号现为 admin，ruleset 可直接改）
- PR：机制 PR 与纯簿记样本 PR 编号见「验收」节

## 目标与范围

**做**：只碰**簿记类**文件的 PR 不再跑五个重活，改为 `判定改动面` + `门禁总闸` 两步；同时**不绕门禁**——任何非簿记改动照跑全套，总闸汇总。`main` 的 ruleset 必需检查由旧 6 条收敛为 `门禁总闸` 一条。

**不做**：不碰业务代码 / 测试 / 契约；不碰其他 workflow（`docs.yml` / `release.yml` / `cargo-mutants.yml` / `cache-cleanup.yml`）、`scripts/`、`package.json`；不引第三方 action（路径判定用 `git diff` 的 bash，不引 `dorny/paths-filter`）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | 新增 `changes` 作业（`判定改动面`）；`frontend` / `frontend-test` / `rust-test` / `rust-clippy` / `rust-shadow` 各加 `needs: changes` + 作业级 `if`；文件末尾新增 `ci-gate`（`门禁总闸`） | 修改（自 `origin/ci/469-bookkeeping-skip` 移植补丁；与旧分支那份的差异**仅** main 后新增的 #488 批② `check-await-holding.mjs` 对账三行） |
| `docs/说明书/Pylon-模块维护地图.md` | 「验证」节长句插一句 #469 口径（不回退该段既有 #488 批② / #489 内容） | 修改 |
| `.agents/L.md` | 开工声明（含过渡窗口警告）；样本 PR 撤 `#266` 刀5 与本批条目 | 修改 |
| `.agents/records/469-bookkeeping-only-ci-skip.md` | 本记录 | 新增 |

## 方案要点

### 白名单（正向）

免 CI 的路径只有这些（正则见 `ci.yml` 的 `changes` 作业）：

```text
AGENTS.md  README.md  .agents/L.md  .agents/BOARD.md
.agents/{records,decisions,spec,templates}/**
```

**正向**语义：任何没列出的路径都会照常触发重活。特别地 `docs/说明书/**`、`CONTEXT.md`、`.agents/dev-standards.md` **不在**名单内——它们是 `check-doc-links` / `audit-maintenance` / `check-hook-anchor-parity` 的输入（`check:docs` / `check:solid`），改它们必须跑 CI（`.agents/` 簿记文件经全量 grep 核实**没有**任何门禁读取）。改这份白名单等于改门禁范围，属**显式动作**。

比较基点：PR 事件取 `pull_request.base.sha`（`actions/checkout` 默认落在 merge ref，`git diff base.sha HEAD` 恰为该 PR 的改动）；push 事件取 `github.event.before`；取不到或为全零时**按「不只是簿记」兜底**（照常跑重活）。`fetch-depth: 0` 必须（默认 depth 1 会让 `git diff <sha>` 失败）。

### `门禁总闸` 为什么必须存在

重活被跳过时，其检查结论是 `skipped`。GitHub 官方文档（《Troubleshooting required status checks》《Control jobs with conditions》）明确：**作业级跳过的检查算通过**（接受的状态是 `success` / `skipped` / `neutral`；"A job that is skipped will report its status as 'Success'... even if it is a required check"）。

**但矩阵作业是例外（2026-09-30 实测）**：跳过发生在矩阵展开**之前**，只产出一个「未展开名」检查——字面的 `前端测试（vitest 分片 ${{ matrix.shard }}/2）`；旧 ruleset 要的 `前端测试（vitest 分片 1/2）` / `（分片 2/2）` **根本没有产出**。若它们仍是必需检查，则检查恒缺、纯簿记 PR 恒卡。

⇒ 必需检查**不能**继续挂在 5 个重活（尤其矩阵）上，必须收敛到一条恒有产出的检查。`ci-gate` 用 `if: always()` + `needs:` 全列实现：六项里任一 `failure`/`cancelled` ⇒ 它失败；其余（含 `skipped`）⇒ 它成功。`if: always()` 不能省，否则上游失败时它自己也不跑，检查一样恒缺。

### 顺序约束（不可倒）

1. 先合 `ci.yml` 这一笔（此时 ruleset 仍要旧 6 条；本笔改了 ci.yml ⇒ 非簿记 ⇒ 全部产出 ⇒ 可合）；
2. 确认 `门禁总闸` 在 **main 的 push 运行**里产出且绿；
3. **再**收敛 ruleset（必需检查只留 `门禁总闸`）——②与③之间不插别的工作；
4. 最后用一笔**只改 `.agents/L.md`** 的纯簿记样本 PR 取端到端读数，并合掉它（顺带清 `#266` 刀5 的 L.md 遗留）。

★ **过渡窗口**：本批合并后、ruleset 收敛前，**任何纯簿记 PR 都会被卡**（矩阵跳过只产出未展开名 ⇒ 两条矩阵必需检查恒缺）——此窗口越短越好，窗口内不开纯簿记 PR。倒序（先改 ruleset）的失败模式：gate 若不产出，所有 PR 卡死。

### ruleset（`main-protection-owner-bypass`，id `23202065`）

- **改前**必需检查 6 条：`前端静态门禁（lint + tsc + build）`、`前端测试（vitest 分片 1/2）`、`前端测试（vitest 分片 2/2）`、`Rust（fmt + 测试 + 构建）`、`Rust（clippy 基线门禁）`、`Rust（ACP shadow parity）`；另含 `deletion`（禁删分支）与 `non_fast_forward`（禁 force push）；`bypass_actors: []`。
- **改后**必需检查 1 条：`[{"context":"门禁总闸","integration_id":15368}]`——`context` 逐字等于 job 的 `name`；其余规则与条件原样带回。
- 改动由本账号（admin）直接执行：改前 GET 存档落报告目录，PUT 后复核只剩一条。

## 验收标准与结果（2026-10-02 全部达成）

| 验收项 | 结果 |
| --- | --- |
| 本笔 PR 的 7 条检查全部产出且绿（`判定改动面` + 5 重活 + `门禁总闸`） | ✅ PR [#522](https://github.com/Teens-in-Times/Pylon-co-works/pull/522)（run 37007083989，墙钟 8m28s）：`判定改动面` 7s、`前端静态门禁（lint + tsc + build）` 3m36s、`前端测试（vitest 分片 1/2）` 4m36s、`（分片 2/2）` 3m39s、`Rust（fmt + 测试 + 构建）` 7m45s、`Rust（clippy 基线门禁）` 4m13s、`Rust（ACP shadow parity）` 4m56s、`门禁总闸` 3s —— 8/8 行 pass（矩阵一 job 两行） |
| 合入后 main 的 push 运行里 `门禁总闸` 产出且绿 | ✅ run [37008042999](https://github.com/Teens-in-Times/Pylon-co-works/actions/runs/37008042999)（merge commit `11ee32c8`）：八个作业全 success，含 `判定改动面` 与 `门禁总闸`（push 路径首次实测） |
| ruleset 收敛：改前/改后 JSON + 复核只剩一条 | ✅ id `23202065`：改前 6 条（静态门禁 / 分片 1/2、2/2 / fmt+测试+构建 / clippy / shadow）→ 改后 `["门禁总闸"]`；`bypass_actors: []` 与 deletion / non_fast_forward 原样；PUT 落点 `updated_at 2026-10-02T20:51:22.539+08:00`；前后 JSON 落报告目录 |
| 端到端样本 PR：`判定改动面` pass / 5 重活 skipped / `门禁总闸` success / `MERGEABLE` 且非 `BLOCKED` | ✅ PR [#523](https://github.com/Teens-in-Times/Pylon-co-works/pull/523)（只改 `.agents/L.md`；run 37009464788，墙钟约 15s）：`判定改动面` pass 7s；五个重活全 skipped（矩阵呈未展开名 `前端测试（vitest 分片 ${{ matrix.shard }}/2）`，收敛后的 ruleset 下无碍）；`门禁总闸` pass 4s；`mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`；已合并（merge commit `c8c5e925`） |
| 样本 PR 合入后 `.agents/L.md` 的 `#266` 刀5 与 `#469` 两条消失 | ✅ main 上 L.md 两子串均 False（文件 23 行），`#266` 刀5 遗留随之清偿 |

> 完整命令与输出落盘：`E:\Acode\FILES\任务\工作台优化\报告等\13-施工单-簿记类文档改动免CI（ci路由+门禁总闸）\`（仓外报告目录）。

## 测试处置

**新增/修改/删除单测：无**（CI 配置，无被测单元）⇒ 工单系统 §四的反向验证（改坏被测函数看测试变红）不适用。行为可观测面 = CI 自身 + 纯簿记样本 PR（本单唯一的端到端验证面）。

## 回滚

- **ruleset**：改前 GET 存档（报告目录 `2026-10-02-ruleset-23202065-before.json`；或 2026-09-30 存档，内容相同）原样 PUT 回去即恢复。
- **ci.yml**：本色可整体 revert（`git revert <本笔提交>`）。
- ★ 若 gate 上线后发现不产出（PR 卡「必需检查缺失」）⇒ **先回滚 ruleset**（分钟级），再查 gate。

## 遗留

- 无（本单验收 1–5 全部达成；本记录的运行读数由一笔收敛后的纯簿记小 PR 回填——彼时纯簿记 PR 已放行）。

## 环境事实（供追溯）

- 本机 `github.com:443` 不可达（git push / fetch 失败：`Connection was reset` / `Could not connect`），`api.github.com` 正常 ⇒ 本批三笔远端提交（机制 `5af0cf3d`、样本 `794e8ab0`、记录回填）均经 git-data API 等价建立：blob/树 SHA 与本地逐字节一致，仅 commit SHA 不同（机制笔本地 `9f6166ea`）。网络恢复后 `git fetch origin` 即可对齐本地分支。
- CI 既有告警（非本次引入）：`actions/checkout@v4` 目标 Node 20、被强制跑在 Node 24，所有 job 均有。
