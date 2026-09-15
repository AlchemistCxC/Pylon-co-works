# Dev Record — #107 清理零引用孤儿工具脚本与根目录垃圾文件

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/107-scripts-orphan-cleanup.md`

## 元信息

- issue：#107
- 分支：`Ru5t/Reflector`
- 提交范围：`52cb4de3..7b348d78`（273064ac L.md 施工预告；7b348d78 删除四个孤儿脚本）
- 日期：2026-09-16

## 目标与范围

清出 2026-09-16 盘点确认的零引用、零记录遗留文件，使 `scripts/` 仅保留在岗脚本。

**不做什么**：不动 `pack-plugin-devkit.mjs`、`plugin-devkit-verify.mjs`（离线 devkit 打包链，verify 被拷贝进套件使用）；不动 `backup-portable-data.sh`（手动运维工具，去留另行决定）；不新增白名单豁免；不碰 `src-tauri` 他人 WIP。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/acceptance-pet-runtime.mts` | 整文件 | 删除 |
| `scripts/hermes-wire-test.py` | 整文件 | 删除 |
| `scripts/smoke-release-sdk.mjs` | 整文件 | 删除 |
| `scripts/convert-presets-to-delta.mts` | 整文件 | 删除 |
| `.agents/L.md` | 尾部追写 #107 条目 | 修改（单独提交 273064ac） |
| （未跟踪，仅本地清理，无提交）`nul`、`_rustfail.log`、`tsc.log`、`pylon-acceptance.log`、`产出路径：`、`入库保留。规格文档（spec）不保留，……`、`scripts/agent-workflow/`、`scripts/__pycache__/`、`scripts/tests/__pycache__/` | — | 删除 |

## 方案要点

- 判据为「全仓内容检索零引用」（package.json、`.github/workflows`、`docs/说明书/`、`.agents/` 全量）；删除前二次复查仍为零引用。
- 职能替代关系：`hermes-wire-test.py` 由 `check-acp-shadow-parity.mjs` + golden trace 覆盖；`smoke-release-sdk.mjs` 由 `pack_release.py` 内建自校验吸收；`convert-presets-to-delta.mts` 为 W2-15/F3-B 一次性迁移，早已完成。
- git 历史在 2026-08-20 压缩为单一快照，更早使用轨迹不可考；「零引用」指仓库内自动化、文档、开发记录均无引用，不排除历史上有人手工执行。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 删除前全仓引用扫描零引用 | ✅（含删除当日二次复查） |
| `bun run check:docs` 通过 | ✅ exit 0 |
| vitest 收录集不受影响 | ✅ 3789 passed / 0 failed，exit 0 |

## 测试处置

无测试修改或删除。被删四个文件均非 `scripts/*.test.mts` 收录对象，也无测试导入。

## 证据

- commit：`273064ac`（L.md 预告）、`7b348d78`（删除，-247 行）
- 测试：`bun run check:docs` exit 0；`bun run test` 3789 passed / 0 failed exit 0
- 手工验证：删除后 `git status --short` 仅剩 `?? target/`；`ls` 确认全部垃圾文件不存在

## 与 spec 的偏差

未落地 spec 文档——用户以「垃圾文件授权出库」直接授权，审计证据与范围由 issue #107 承接。

## 未解问题

- `backup-portable-data.sh` 与 `pack-plugin-devkit.mjs`/`plugin-devkit-verify.mjs` 的去留/文档化未决，已在 #107 约束中划出本次不碰。
- `scripts/agent-workflow/` 源文件从未入库，仅剩 pyc 编译缓存，内容不可追溯。

## 并行交集

`.agents/L.md`（尾部追写，遵守只追写协议）。其余改动均为删除/本地清理，无共享文件写入。
