# Dev Record — #371 离线文档站进发行包（pylon-docs scheme + Docs Sheet）

## 元信息

- issue：[#371](https://github.com/AlchemistCxC/Pylon-co-works/issues/371)（enhancement，已认领）
- 分支：`kumo/prometheus`
- 提交范围：`ac297a37`（构建链）`a2cbe02e`（Rust）`f959b48c`（前端）`486bca6b`（打包检查）`7a713bc2`（清单）；`lib.rs` 接线 hunk 按 L.md 约定随 #361-363 批次连带入库（本文验证均在含该 hunk 的工作树状态完成）
- 日期：2026-09-26/27

## 目标与范围

issue 原话：「把文档站以**离线**形态塞进发行包，并在应用内打开」；托管机制按仓库主裁决走自定义 URI scheme + 专用文档 Sheet，**不引入监听端口**（#367 姿态不变）。

不做什么：不放宽 Browser Sheet 的 http/https 白名单；不动在线站点构建（`docs.yml` 零改动）；不删除 `docs/说明书/**` 随包 markdown（与站点并存，去留留裁决）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `docs/.vitepress/config.ts` | 离线变体开关（base 回根 + `stripWebfonts` vite 插件） | 修改 |
| `scripts/stage-docs-site.mjs` | 离线构建 + 暂存 `src-tauri/resources/docs-site/` + 三守卫 | 新增 |
| `package.json` | `docs:build:offline` 脚本；`release:portable` 在 tauri build 前插步 | 修改 |
| `.gitignore` | 忽略 `/src-tauri/resources/docs-site/`（先例 runtime/git） | 修改 |
| `src-tauri/tauri.conf.json` | `bundle.resources` + `resources/docs-site`；csp/devCsp 六指令配对加 `pylon-docs:` `http://pylon-docs.localhost` | 修改 |
| `src-tauri/src/docs_sheet/{mod,resource,cmds}.rs` | 资源协议（clean URL/穿越拒绝/缓存策略）、单 WebView Sheet 管理器、9 个命令 | 新增 |
| `src-tauri/src/browser/mod.rs` | `host_additional_browser_args` 提 `pub(crate)` 供共用（#308 约束） | 修改 |
| `src-tauri/src/lib.rs` | `mod docs_sheet`、scheme 注册、AppState 字段、命令清单、setup 阶段 6b | 修改（连带入库） |
| `src/infrastructure/tauri/docsClient.ts` | typed client | 新增 |
| `src/sheets/docs/DocsSheetView.tsx` | Sheet 壳（自动 start / bounds / 可见性 / 卸载回收 / 最小导航条） | 新增 |
| `src/sheets/docs/__tests__/DocsSheetView.boundsSync.test.tsx` | 同步契约用例 ×3 | 新增 |
| `src/plugins/core/sheet/builtinWorkspacePlugins.ts` | 注册 `docs` 工作区（`reference` 分类「参考与帮助」，数据驱动分组新增首例） | 修改 |
| `src/workspace-sheets/launchIcons.{tsx,solid.tsx}` | `book-open` 键（两份键表同步） | 修改 |
| `scripts/pack_release.py` | `require_docs_site()` 存在性检查 + 布局注释 | 修改 |
| `scripts/tests/test_pack_release.py` | `DocsSitePackagingTests` ×2 | 修改 |
| `docs/说明书/Pylon-发行包清单.md` | §1/§2/§4/§5 增补 docs-site | 修改 |

## 方案要点

1. **base 用 `/` 而非 issue 设想的相对 `./`**：VitePress 要求 base 以 `/` 起止，相对 base 在嵌套路由下解析到错误层级；且 `pylon-docs://localhost/` scheme 天然提供「每源根目录」语义，根绝对路径在 scheme 源内正确解析——离线变体只需把 `/Pylon-co-works/` 换成 `/`。
2. **裁字体用 vite `resolveId` 虚拟空模块短路 `@fontsource/`**：整棵字体子树（woff 引用都在其 CSS url() 里）不进 dist，client/SSG 两束同效；`custom.css` 字体栈已含系统 CJK 衬线回退，样式零改动。staging 脚本守卫按**单文件体积（>512KB）+ 总体积（>8MB）**判定而非「禁一切字体」——VitePress 默认主题自带的 Inter UI 子集（KB 级）保留，避免守卫耦合 vitepress 内部实现。
3. **资源协议与 `pylon-plugin` 先例的两处刻意差异**：root 解析 **bundle 资源目录**（`resource_dir()/docs-site`，随包分发）而非用户数据目录；支持 **clean URL**（exact → +".html" → +"/index.html"，初始加载/刷新/历史恢复会发无后缀请求）。无 Range（无媒体）；`assets/`（哈希名）immutable 缓存，html `no-cache`。
4. **入口 URL 形态**照 `pylon-plugin://localhost/...` 前端先例；导航守卫同时放行 scheme 形态与 Windows 归一后的 `pylon-docs.localhost` host 形态，不依赖 wry 归一细节。外链 fail-closed：`on_navigation` 只放行文档站自身、`on_new_window` 一律 Deny（GitHub 等外链不代开系统浏览器，避免耦合两套浏览器语义）。
5. **子 WebView 环境参数一致性（#308 坑）**：复用 `browser::host_additional_browser_args`（提为 `pub(crate)`），保证与宿主主 WebView 同一 WebView2 环境。
6. 前端壳对齐 BrowserSheetView 的依赖形态：`syncBounds` 依赖 `snapshot.phase`（ready 转换后重发 bounds）、可见性随 `isActive && !modalOverlayOpen`、卸载非 idle 即 close；start 幂等（后端对已存在 WebView 只更新 bounds）。
7. 打包链：`release:portable` 把 `docs:build:offline` 插在 `tauri build --no-bundle` **之前**；`pack_release.py` 泛化遍历自然收集 `resources/docs-site/**`，新增 `require_docs_site()` 显式存在性检查（缺 `index.html` → `PackError` 带补构建命令）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 离线构建产物形态 | ✅ 2.42 MB（原 26 MB）；index.html 在；无 >512KB 字体分块；无 `/Pylon-co-works/` 前缀（守卫实测拦截过一次真实走样——曾抓到 fontsource 漏裁） |
| 在线站点零变化 | ✅ 无环境变量构建：base 前缀在 index.html 出现，332 个 CJK woff2 照旧 |
| `.gitignore` 生效 | ✅ 构建/暂存后 `git status` 无 docs-site 产物 |
| `check:csp` | ✅ 通过（exit 0，csp/devCsp 六条口径） |
| Rust 单测 | ✅ `cargo test --lib -- docs_sheet` 10 passed / 0 failed（clean URL、穿越拒绝、mime、缓存策略、守卫语义、URL 白名单、idle 语义） |
| 打包器单测 | ✅ `bun run test:pack` = `python -m unittest discover scripts/tests` **Ran 28 tests, OK**（含新增 2 例） |
| 前端用例 | ✅ vitest `DocsSheetView.boundsSync.test.tsx` 3 passed（折叠重同步、非活动不 start、覆盖层让位） |
| 类型/lint | ✅ `tsc -b` exit 0；eslint 对全部触达文件 0 error 0 warning |
| 边界门禁 | ✅ `check:solid` 全绿（运行时边界/主题契约/插件清单/context 接线等）；`check:docs` exit 0 |
| 真机 Sheet 打开 | ⚠️ **本机未完成**——见下「验证限制」 |

**验证限制（如实记录）**：① G 盘余 ~3.5GB，完整 `release:portable`（tauri release 构建）本机未跑；② 复跑全 crate 测试时撞上 #361-363 在途中间态（`session_expiry_platform_tests` 引用其改名中的符号，非 #371 域），`docs_sheet` 定向 10/10 为其之前全 crate 编译通过状态下取得；③ 真机验收（Docs Sheet 打开离线站、搜索可用、外链 fail-closed、dev 态资源缺失报错形态）待 lib.rs 连带入库后由 CI 出包或空闲时段实机执行——清单 §5 已加对应验收项。

## 测试处置

新增：`docs_sheet` Rust 单测 10 例、`DocsSitePackagingTests` 2 例、`DocsSheetView.boundsSync.test.tsx` 3 例。修改既有测试：无。删除：无。

## 证据

- commit：`ac297a37` / `a2cbe02e` / `f959b48c` / `486bca6b` / `7a713bc2`
- 测试：`cargo test --lib -- docs_sheet` → `10 passed; 0 failed`；`bun run test:pack` → `Ran 28 tests, OK`；vitest → `3 passed`；`check:csp` / `check:docs` / `tsc -b` exit 0
- 手工验证：`bun run docs:build:offline` 与 `bun run docs:build` 双向构建实测（产物形态见验收表）

## 与 spec 的偏差

1. base 采用 `/`（spec 已预记此修正，issue 原文的 `./` 不可行）。
2. issue 立项期评论建议的「清单删 46 行 repair-hermes、47 行改零 Agent 模板」**不属本项**——那是 #372 的改动且已由 #372 落地；本项只增补 docs-site 内容。
3. 守卫从「禁一切 Web 字体」放宽为「体积阈值」（VitePress 主题 Inter 子集保留）。
4. spec 预估离线包 ~4MB，实测 2.42MB（更优）。

## 未解问题

- `docs/说明书/**` markdown 与离线站点并存的去留（issue 留仓库主裁决）。
- 真机验收（上节限制 ③）。
- 文档 Sheet 是否需要缩放/字号档位（VitePress 自适应，暂不做）。

## 并行交集

- `src-tauri/src/lib.rs`：与 #361-363 批次共享（其 `mod logging`/init_tracing 与本项 `mod docs_sheet` 等注册，改动点不相邻）；按 L.md 约定本项 hunk 随其批次连带提交。
- `scripts/pack_release.py`、`scripts/tests/test_pack_release.py`：#372 在途期间避让，其收工后基于新基线落笔。
- `docs/说明书/Pylon-发行包清单.md`：#361 在途期间避让，其入库后增补。
- 事故披露：`12a8acd7` 因 `-m` 消息引号吞掉 pathspec 变成整 index 提交，连带入库了 #372 已 staged 的三个删除（内容即其计划内改动，无实质影响）；已在 L.md 与 issue 说明。
