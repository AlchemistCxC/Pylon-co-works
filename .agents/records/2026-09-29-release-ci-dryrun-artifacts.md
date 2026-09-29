# Dev Record — Release CI 预演模式产物留痕修复

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 用户指派免登记 issue（2026-09-29 会话原话「本次工作无需登记issue」）。

## 元信息

- issue：无（用户明示免登记）
- 分支：`kumo/fix-release-dryrun-artifacts`（基于 main `fd7fdbb0`）
- 提交范围：`fd7fdbb0..a5340468`（单提交，仅 `.github/workflows/release.yml` +32/−1）
- 日期：2026-09-29

## 目标与范围

用户在 main 上 workflow_dispatch 触发 Release（run 36519625450），构建绿但「没有成功上传构建产物」。

**诊断**：非故障——该 run 是预演模式（分支 dispatch，ref 非 `refs/tags/`），发布步骤被 `if: startsWith(github.ref, 'refs/tags/')` 门住整步 skip（日志零行）；打包本身成功（`pylon-0.3.3-LFC-win64.zip` verify OK）。正式发行路径（打 tag）昨日 v0.3.3-LFC 已验证可用。

**真缺陷**：预演静默成功且零产出，与「发布步骤静默失败」在运行页无法区分；产物留 runner 即焚，预演也拿不到东西。

**不做**：不改「打 tag 即发行」流程与两道 fail-fast 守卫（版本一致性、main 归属）；不让分支 dispatch 具备发布能力（守卫只覆盖 tag ref，放开即绕过 #232 设计）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `.github/workflows/release.yml` | 头注预演说明；新增「运行模式标注」步（checkout 后）；新增「预演产物上传（run artifact）」步（打包后、发布步前） | 修改 |

- 模式标注：tag ref → summary「正式发行」；分支 dispatch → summary「预演（含构建版本与打 tag 指引）」，写 `$GITHUB_STEP_SUMMARY` + stdout。
- 预演产物：`actions/upload-artifact@v4`，name `pylon-preview-win64`，收 `release/pylon-*-win64.zip`(+`.sha256`/`.manifest.json`)，`retention-days: 7`，**`if-no-files-found: error`**——打包零产出从静默绿变红。

## 方案要点

- 修「不可区分」而非改「不发布」：预演的语义保留，但绿 run 必须伴随（a）产物可取（b）模式自述。
- `if-no-files-found: error` 是本修复的实质门禁增量：此后任何打包链回归在预演模式同样红灯。
- 正式路径零触碰：发布步、两道守卫、concurrency、permissions 均未动。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| YAML 语法 | ✅ `bunx yaml-lint` successful |
| 预演端到端：分支 dispatch 后 run 页出现可下载 artifact | ✅ run 36522268399（修复分支）conclusion success，artifact `pylon-preview-win64`（zip+sha256+manifest 三件） |
| 预演 summary 显式标注 | ✅ 运行摘要出现「Release：预演（dispatch @ 分支名，构建版本 v0.3.3-LFC）…不发布 GitHub Release」 |
| 正式路径不变 | ✅ diff 仅头注+两步新增，发布步与守卫零改动 |

## 测试处置

无测试增删（workflow 层改动；`bun run test:pack` 在被验证 run 内原样执行并通过）。

## 证据

- commit：`a5340468`
- 诊断证据：run 36519625450（main dispatch）——job 绿、`发布到 GitHub Release` 日志零行（整步 skip）、`打包发行包` 末行 `verify OK: ...\release\pylon-0.3.3-LFC-win64.zip`
- 验证证据：run 36522268399（修复分支 dispatch）——见上表
- 手工验证：`gh release view v0.3.3-LFC` 三资产齐备（正式路径健康旁证）

## 与 spec 的偏差

未落 spec（轻量单文件 CI 修复，用户免登记 issue）。

## 未解问题

- `v0.3.3-LFC` 版本号与 main 当前 package.json 一致，若要发新版本仍需走 release skill 的 `--bump` 落位后打新 tag；预演不会也不应替代这一步。

## 并行交集

- 仅 `.github/workflows/release.yml` 一个共享文件，已随 `a5340468` 提交推送，无在途遗留；不与 CI（ci.yml）、发行脚本（scripts/pack_release.py）相交。
