# Dev Record — #185 WebView2 bootstrapper 出库（便携包不再内置安装器）

## 元信息

- issue：[#185](https://github.com/AlchemistCxC/Pylon-co-works/issues/185)
- 分支：`Ru5t/Reflector`
- 提交范围：`8d31b5e6..<PR head>`
- 日期：2026-09-19

## 目标与范围

`MicrosoftEdgeWebview2Setup.exe`（1.7MB PE32，87eb901c 为 CI 干净 checkout 而入库）撤出
源码仓库；便携包不再内置 WebView2 安装器，Runtime 按 Windows 自带处理（ADR-0014，
仓库主 2026-09-19 拍板"准许变更发布包"）。**不做什么**：不改 `tauri.conf.json` 的
`webviewInstallMode`、不动 `--with-runtime` 机制、不改写历史。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `resources/release/tools/MicrosoftEdgeWebview2Setup.exe` | 整文件 | 删除（git rm） |
| `scripts/pack_release.py` | docstring 产物布局、`collect_source_files` 签名与收集块、`build_manifest`/`write_zip` 的 `webview2_bootstrapper` 参数、manifest 字段、`--without-webview2` 选项 | 修改 |
| `resources/release/tools/install-webview2.bat` | 重写为兜底引导：同目录手动安装器优先 → `%TEMP%` 下载 fwlink（LinkId=2124703）→ `/silent /install` | 重写 |
| `scripts/tests/test_pack_release.py` | `write_zip` 调用去第 5 参；新增 manifest 无 `webview2Bootstrapper` 断言；新增 `WebView2BootstrapperTests` | 修改/新增 |
| `.gitignore` | 撤销受控例外（37-43 行块），改为忽略本地手动副本 | 修改 |
| `docs/说明书/Pylon-发行包清单.md` | §1 结论、§2 表格与 manifest 描述、§3 前提第 6 项、§4 降级打包块、§5 验收项 | 修改 |
| `.agents/decisions/0014-release-zip-without-webview2-bootstrapper.md` | ADR | 新增 |

## 方案要点

- 兜底链设计：`install-webview2.bat` 优先使用同目录手动放置的安装器（覆盖完全离线场景），
  否则经 PowerShell（显式 TLS1.2）从微软官方 fwlink 下载 Evergreen Bootstrapper 到
  `%TEMP%` 后 `/silent /install`——与 Tauri NSIS `downloadBootstrapper` 同源，单一权威链接。
- bat 内容须过发行内容审计（`scan_text_file`）：确认 `https://` 不触发 `DRIVE_PATH_RE`
  （`\b[A-Za-z]:[\\/]` 的词边界在 "ttps:" 处不成立）、`%TEMP%` 变量不展开为盘符路径、
  无 `SENSITIVE_KEY_RE` 命中；并以真实文件落了单测钉住。
- `:install` 标签依赖 cmd 对 CRLF 的要求，写后强制转换 CRLF。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun run test:pack`（CI 同款命令） | **22 tests OK**（退出码 0），含新增 `test_shipped_fallback_bat_passes_release_audit` |
| `python -m py_compile scripts/pack_release.py` | OK |
| `--help` 无 `--without-webview2`，docstring 产物布局已更新 | OK |
| `--verify-only release/pylon-0.2.1-win64.zip`（未触碰路径回归） | verify OK（213 项 manifest 全一致） |
| fwlink 可达性 | 302 → 200，`application/octet-stream`，1,844,944 字节 |
| 残留引用 | `without-webview2`/`webview2Bootstrapper` 仅存于「说明其移除」的文档/注释/测试断言 |

## 测试处置

契约变更随测试同步修改（issue #185 已声明此偏差）：

1. `StagingTests.test_write_zip_has_single_top_dir_and_manifest_hash`：`write_zip` 5 参 → 4 参；
2. 同测试新增断言：manifest 不含 `webview2Bootstrapper`（防回潜）；
3. 新增 `WebView2BootstrapperTests.test_shipped_fallback_bat_passes_release_audit`：
   真实 bat 必须通过 `reject_forbidden` + `scan_text_file`。

## 证据

- commit：见 PR（`8d31b5e6` L.md 声明 + 本次工作提交）
- 测试：`bun run test:pack` → `Ran 22 tests ... OK`
- 手工验证：fwlink HEAD 请求 200（octet-stream）；0.2.1 旧包 verify-only 通过

## 与 spec 的偏差

未落 `.agents/spec/`（一次性、不入库）：需求在会话中由仓库主直接拍板（"准许变更发布包"），
决策全文已入库 ADR-0014，追溯链由 issue + ADR + 本记录承载。

## 未解问题

- 完整 `release:portable` 端到端未在本机重跑（需全量前端+Tauri+cargo 构建）；CI dispatch
  或下次发版时自然覆盖。改动对收集逻辑是纯删除分支，离线单测已覆盖收集契约的外围。

## 并行交集

本次碰过的共享文件：`.gitignore`、`docs/说明书/Pylon-发行包清单.md`、
`scripts/pack_release.py`、`scripts/tests/test_pack_release.py`、`resources/release/tools/`。
