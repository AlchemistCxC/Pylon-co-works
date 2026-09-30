# Dev Record — #471 本地预演 zip 混入 docs-site 历史哈希 chunk

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-471-docs-site-stale-chunks.md`

## 元信息

- issue：#471（bug；assignee=kumo）
- 分支：`kumo/prometheus`
- 提交范围：`d817df3b..`（本批）；L.md 声明 `7c2a9a81`
- 日期：2026-09-30

## 目标与范围

达成 issue 验收口径：**「本地 zip 内容与 CI 全新构建一致」**——发行 zip 的 `resources/docs-site/**` 与暂存源逐文件一致。

**不做什么**：不改 `stage-docs-site.mjs` 清理逻辑（见下方归因修正）；不清理 `target/release/resources/` 本体（tauri 所有地，文件锁风险）；不动 bundle.resources 声明与运行时资源解析。

## 归因修正（issue 的表面归因不成立）

issue 标题称「stage-docs-site 本地 staging 不清旧构建产物」，实测**不成立**：`stage-docs-site.mjs` 每轮 rm+重铺暂存源（EBUSY 退化清空重铺），当前暂存源 56 文件单代哈希。真正累积点在下游：

1. `tauri build` 把 `bundle.resources` 增量合并拷进 `target/release/resources/`，**从不清理旧文件**。本机（0.3.4-LBI 构建机原样）实测 `target/release/resources/docs-site/` 78 文件、`app.*.js` 4 代——78−56=**22** 恰等于 issue 的 manifest 304 vs 282 差值。
2. `pack_release.py` 的 `collect_source_files` 直接 walk `target/release/resources/` 收进 zip，docs-site 无排除逻辑 → 历史代际全数入包。CI 全新 checkout target 干净，故仅路径 A（本地构建）受影响，与 issue 现象吻合。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/pack_release.py` | 常量区 +`DOCS_SITE_STAGED_DIR`；新 `collect_docs_site()`；`collect_source_files` walk 排除 docs-site + 追加暂存源收集；`require_docs_site` 守卫移到暂存源 | 修改 |
| `scripts/tests/test_pack_release.py` | `DocsSitePackagingTests`：夹具随迁暂存源 + 两个新测试 | 修改 |
| `scripts/stage-docs-site.mjs` | 仅头注释（staging→入包链路表述随 #471 修正） | 修改 |
| `docs/说明书/Pylon-发行包清单.md` | 资源表 docs-site 行 + 构建步骤 3 的顺序理由 | 修改 |

## 方案要点

docs-site 改取**暂存源** `src-tauri/resources/docs-site/` 进 zip，与仓内两处同构先例一致：SDK 在 walk 中跳过改取 `dist-plugin-sdk`；runtime/git 用 repo 源遮蔽 target 部分拷贝。暂存源每轮由 `stage-docs-site.mjs` rm+重铺保证新鲜，取源即与 CI 全新 checkout 同构，且对 target 区文件锁免疫（不做 rm，无 EBUSY 面）。守卫 `require_docs_site` 同步钉到暂存源——守卫对象必须与实际入包源一致，否则漏跑 `docs:build:offline` 会被上一轮 target 残留掩盖。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `python scripts/tests/test_pack_release.py` 全绿 | 45/45 OK（uv cpython-3.12.13） |
| 真环境：修复前口径对真实 target 收集 | 78 项 docs-site 入 zip，其中 **22 项残留**（`app.*`×3 旧代、`theme.*`×3、`@localSearchIndexroot.*`×3、`VPLocalSearchBox.*`×3、旧 `md.*.js` 等，名单见下方证据） |
| 真环境：修复后收集 == 暂存源逐文件 | 56==56 True；残留泄漏 0；全量 `collect_source_files` 281 项（较 CI 282 少 1 = 本机已清盘的 `pylon-cli.exe`，与 docs-site 无关） |
| 守卫钉在源：仅 target 有拷贝、暂存源缺失必须报错 | `test_guard_pins_to_staged_source_not_target_copy` 通过 |

## 测试处置

- 新增：`test_guard_pins_to_staged_source_not_target_copy`（守卫半边钉）、`test_stale_target_copy_does_not_leak_into_collection`（全量 `collect_source_files` 级回归钉：target 旧哈希 chunk 不泄漏、暂存源逐文件入包、fonts 等其余资源不受影响；exe/loader/sdk/mcp 全用临时夹具，不触发真实构建）。
- 随迁：`DocsSitePackagingTests.setUp/tearDown`（+mock `DOCS_SITE_STAGED_DIR`）；`test_staged_docs_site_passes_entry_check_and_audit`（夹具从 target 拷贝迁到暂存源）；`test_missing_entry_fails_the_build_with_remedy` 断言不变。

## 证据

- 真环境实证（`target/release/resources/docs-site/` 持 4 代 78 文件的原状下）：修复后 `collect_docs_site()` 56 项 == `rglob` 暂存源 56 项；`collect_source_files` 全量 281 项、docs-site 56 项与源一致、`docs-site 残留泄漏: []`。被挡在包外的 22 项含 `app.CLfql29P.js`/`app.DnrBFsgs.js`/`app.L1hFduX_.js`、`theme.CFl4uwB1.js`/`theme.DSsYA8b2.js`/`theme.D_jCcptY.js`、`@localSearchIndexroot.{BQXawywN,CmvuLt2F,DDOhHfSh}.js`、`VPLocalSearchBox.{5EXe5aNz,CMn1TPM5,DNn2mfhk}.js` 及 8 项旧 `md.*{,.lean}.js`。
- 测试：`python scripts/tests/test_pack_release.py -v` → `Ran 45 tests ... OK`（exit 0）。
- clippy 门禁口径：本批 diff **零 Rust 面**（`git diff d817df3b -- src-tauri/` 为空）。本地 `bun run check:clippy` 红——红因是**共享树上他人在途改动**（施工期间 `git status` 出现 `src-tauri/**` 未提交脏文件：`pylon-foundations/src/sanitize.rs` 在 :204 附近新增 50 行、`.last()` 新代码触发基线外新诊断 `clippy::double_ended_iterator_last`；另有 `pylon-session/src/event_repo/*`、`src/{export,lib,permission,session/mod}.rs` 等，对应对话板 #379 批在途）；期间还观测到一次瞬时 E0282（对方写文件中间态被并发编译捕获，重跑消失）。对照：**main @ d817df3b 的 CI clippy job 绿**（run 36733502142，pylon-foundations `added: []`）。本批不触碰他人在途域、不改基线、不代修对方代码。
- 门禁限制：本机 `webview2-mcp.exe` 与 release 根 `WebView2Loader.dll` 已被 G 盘应急清理（L.md #401 条），真环境全量验证对这两处二进制定位器用了临时夹具/mock——与 #471 的收集逻辑正交，已在验证脚本中显式披露。未跑完整 `release:portable` 全链（Rust 重编不构成本修复的风险面）；zip 级验收条件已由收集函数级实证覆盖。

## 与 spec 的偏差

无实质偏差。spec 计划新增 1 个回归钉，实际落了 2 个（守卫半边单独成测）——守卫移源是该修复的行为面之一，值得独立钉住。

## 未解问题

1. `target/release/resources/` 的同类增量残留对**未来若启用的安装器 bundle**（NSIS/MSI 取 target 拷贝）仍潜伏；当前发行形态只有便携 zip（取源已治），不动 tauri 所有地，此风险仅在引入安装器发行时需要重审。
2. `.sha256` CRLF 已知问题仍未修（承接 0.3.3/0.3.4 记录，与本 issue 无关，留观察）。

## 并行交集

`scripts/pack_release.py`、`scripts/tests/test_pack_release.py`（#372 域早已收工，无在途冲突）；`docs/说明书/Pylon-发行包清单.md`；`scripts/stage-docs-site.mjs`（仅注释）。施工范围已在 L.md 声明（`7c2a9a81`）。
