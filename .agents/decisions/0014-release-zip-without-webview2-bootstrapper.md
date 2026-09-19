# ADR-0014 发行包不再分发 WebView2 bootstrapper

- **日期**：2026-09-19
- **状态**：已采用（仓库主 2026-09-19 决定，issue #185）

## 背景与约束

便携包自 2026-09-11（87eb901c）起内置受控的 `MicrosoftEdgeWebview2Setup.exe`（1.7MB
PE32）。入库原因是 release CI 是干净 checkout，`pack_release.py` 缺它即失败（实测
run 34592441017）。代价：二进制常年占据仓库与 clone 体积，且随包安装器会随时间陈旧；
打包脚本、manifest 与文档还为它维护「默认必须 / `--without-webview2` 降级」双态契约。

WebView2 Evergreen Runtime 在 Windows 11 与持续更新的 Windows 10 上由系统自带；缺失
集中于旧版/离线机器，属少数场景。约束：缺 Runtime 的机器仍需有可用安装路径，发行
三件套（zip/sha256/manifest）的交付校验流程不能破坏。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 保留入库（现状） | 二进制撑大仓库；包内安装器随时间陈旧；为它维护双态打包契约 |
| 出库但 CI 打包时现取、包仍内置 | zip 体积不变；构建链仍要维护下载与校验，收益只剩仓库瘦身 |
| 出库且包不再内置、无任何兜底 | 旧/离线机器缺 Runtime 时 `pylon.exe` 无法启动且无自救路径 |

## 决定

1. `MicrosoftEdgeWebview2Setup.exe` 以 `git rm` 撤出源码仓库（不做历史改写，blob 留存于历史）；
2. `pack_release.py` 删除 bootstrapper 收集逻辑、`--without-webview2` 选项与 manifest 的
   `webview2Bootstrapper` 字段；
3. `tools/install-webview2.bat` 改为兜底引导：优先使用同目录手动放置的安装器（覆盖离线
   场景），否则从微软官方 fwlink（LinkId=2124703，与 Tauri NSIS 的
   `downloadBootstrapper` 同源）联网下载后静默安装；
4. `.gitignore` 撤销受控例外并忽略本地手动副本；`docs/说明书/Pylon-发行包清单.md` 同步。

## 后果

- 正面：仓库少 1.7MB 二进制；zip 瘦身；不再维护入库安装器的新鲜度与双态打包契约；
- 负面：缺 Runtime 且完全离线、又未手动放置安装器的机器无法就地静默安装；
- 风险：fwlink 不可达时兜底失效——缓解：bat 失败时输出手动下载地址；企业离线场景走
  NSIS/MSI 离线安装器路线（发行包清单 §7）。

## 证据

- `scripts/pack_release.py`（collect_source_files / build_manifest / write_zip / parse_args）
- `resources/release/tools/install-webview2.bat`（兜底下载）
- `scripts/tests/test_pack_release.py`（WebView2BootstrapperTests + manifest 字段断言）
- `docs/说明书/Pylon-发行包清单.md` §1/§2/§3/§4/§5
