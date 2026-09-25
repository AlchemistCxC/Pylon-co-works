# Dev Record — #343 插件开发套件刷新（SDK/随套件文档对齐 API 2.4）

## 元信息

- issue：[#343](https://github.com/AlchemistCxC/Pylon-co-works/issues/343)
- 分支：`kumo/prometheus`
- 提交范围：`5ee9d683`（含 `349f6d23` docs(343)）
- 日期：2026-09-25

## 目标与范围

把 `dist-plugin-devkit/pylon-plugin-devkit` 套件从 API 1.2 时代产物刷新到当前源码（API 2.4），
并修正随套件发行的文档版本漂移，重打发行 zip。

**不做**：API 契约变更（2.4 已在 #325-329 落地）；starter manifest 升版（api 1.1/1.2 仍在
allowlist 内且各演示对应 minor 的契约面）；`src-tauri/resources/sdk` 离线 SDK 专项处理
（由 `build:plugin-sdk` 顺带重建，#325-329 已修过内容）；仓库内 `examples/web-plugins/hello-starter/dist`
的去留（见未解问题）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | 头部：适用版本 0.2.2→0.3.0-AUE、生产契约最新 1.2→2.4 | 修改 |
| `scripts/plugin-devkit-README.md` | 前置条件 1.4.1→0.3.0-AUE；契约速查 api 词表→1.0–1.3 / 2.0–2.4 并标注 2.0 region 主轴 | 修改 |
| `scripts/pack-plugin-devkit.mjs` | TS starter 预构建 dist 由「拷贝仓库快照」改为「对套件 SDK 现打」（与 manager-demo 同模式） | 修改 |
| `dist-plugin-devkit/pylon-plugin-devkit/` | 整树重建 + 新 zip `pylon-plugin-devkit-v0.3.0-AUE.zip` | 产物（不入库） |
| `src-tauri/resources/sdk/` | 随 `build:plugin-sdk` 重建（20332B，64KB 上限内） | 产物（不入库） |

## 方案要点

1. **套件 SDK 不需要改源码**——`src/sdk` 与 `src/plugin-runtime/packageManifest.ts` 已是 2.4；
   陈旧只在产物层（bundle 常量 `PYLON_PLUGIN_API_LATEST` 停在 1.2）与文档层。
2. **TS starter dist 现打**：仓库内 `examples/web-plugins/hello-starter/dist/index.js` 是 API 1.1
   时代对 TS 源码打包的内嵌 SDK 快照（只有 pack 脚本消费它），直接拷贝会把陈旧字节带进套件。
   改为 pack 时对套件 `sdk/pylon-plugin-sdk.js` 现打，starter 预构建产物从此与套件 SDK 同源。
3. zip 命名跟随现行应用版本方案（`v0.3.0-AUE`）；保持旧包平铺结构（解压即得 `docs/`、`sdk/`、
   `README.md`），245 条目（旧包 197，增量主要是 1.3 起扩大的 Hook 锚点与 2.x 类型面）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun run build:plugin-sdk` | 绿（normal + offline，offline 20332B < 64KB 上限） |
| `bun scripts/pack-plugin-devkit.mjs` | 绿（G1 导出完整 / G2 TS starter 严格编译 / G3 manager-demo 严格编译） |
| 套件 `node verify.mjs` | 27 项全 PASS（结构 15 + 导出/版本 4 + exports 3 + manifest 3 + 类型树 2） |
| 套件 SDK 版本常量 | `PYLON_PLUGIN_API_LATEST = "2.4"`，allowlist 与 `shared/pylon-plugin-manifest.schema.json` api enum 一致（verify 把关） |
| 套件文档 | README 含 0.3.0-AUE；说明书头部 0.3.0-AUE / 最新 2.4 |
| starter 预构建 dist | `starter/typescript/dist/index.js` 与 `starter/manager-demo/dist/index.js` 内嵌 SDK 均为 2.4 |
| 新 zip | `pylon-plugin-devkit-v0.3.0-AUE.zip`，`testzip` 完整性 OK，平铺结构与旧包一致 |

## 测试处置

无测试增删改。`plugin-devkit-verify.mjs` 的版本断言在 #325-329 已改为从随包 schema 推导，
本次直接受益（不需要随 API 升版改断言）。

## 证据

- commit：`349f6d23`（docs + pack 脚本）；产物 zip `dist-plugin-devkit/pylon-plugin-devkit-v0.3.0-AUE.zip`
- 测试：pack 三门 G1/G2/G3 全 PASS；`node verify.mjs` ALL PASS（退出码 0）
- 手工验证：`zipfile.testzip()` 完整性 OK；套件 bundle 与两个 starter dist 的
  `PYLON_PLUGIN_API_LATEST` 均为 `"2.4"`；旧包 `v1.4.1.zip` 保留对照

## 与 spec 的偏差

未落 spec 文档：本案是产物刷新 + 三处文档头部对齐，无契约/结构决策，改动清单即规格。

## 未解问题

- 仓库内 `examples/web-plugins/hello-starter/dist/index.js`（tracked）自 pack 脚本改为现打后
  已无消费者，作为陈旧快照留在库里；是否 `git rm` / 改由脚本生成，留给后续 issue。
- 离线版 SDK 64KiB 上限（20332B）余量充足，2.x 类型面扩大不影响离线 bundle（类型不入 bundle）。

## 并行交集

- `docs/说明书/Pylon-插件系统说明书-开发者版.md`（仅头部 3 行；#339 文档站域为
  `docs/.vitepress/**`，不撞；#325-329 说明书同步已收口）
- `scripts/plugin-devkit-README.md`、`scripts/pack-plugin-devkit.mjs`（devkit 专属）
- `.agents/records/`、`.agents/L.md`（本记录与撤板）
