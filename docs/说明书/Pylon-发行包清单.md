# Pylon 发行包清单

本文是 Windows 发行包的施工与验收清单，权威依据是
`scripts/prepare_hermes_runtime.py`、`scripts/pack_release.py` 和
`src-tauri/tauri.conf.json`。它描述当前实现需要什么，不代表未来安装器一定采用
相同的目录名。

## 1. 先看结论

一个可交付的 win64 便携包必须同时包含：

- Pylon 主程序及启动所需的 Tauri/WebView2 loader；
- Agent 检测器；
- 前端资源（字体等）；
- `agents.example.yaml` 和便携模式启动说明；
- `portable.flag` 与空的 `data/` 目录；
- 离线插件 SDK（单文件 ESM + manifest schema，不含 testing harness）；
- WebView2 安装引导（或明确声明由分发渠道另行提供）；
- 包外的 SHA-256 文件和 manifest。

默认发行**不携带** Hermes 的 PortableGit 运行时（2026-08-31 决定）：Windows 上 Hermes 解析 Bash 的顺序是包内 `resources/runtime/git` → `PYLON_HERMES_RUNTIME_DIR` → 本机健康的系统 Git Bash（探测校验，不盲信 `PATH`，避免命中 WSL 的 `bash.exe` 或残缺安装）。需要把完整运行时打进发行包时，对 `pack_release.py` 使用 `--with-runtime`；此时树必须完整。该运行时只给 `provider=hermes` 的 Windows subprocess ACP 子进程使用，不会改写系统 `PATH`，也不会让其他 Agent 自动使用它。

## 2. ZIP 内的目录和文件

打包脚本生成单一顶层目录 `pylon-<version>-win64/`。下表按当前脚本的硬性程度列出
内容：

| 路径 | 要求 | 用途 |
| --- | --- | --- |
| `pylon.exe` | 必须 | Tauri GUI 主程序 |
| `pylon-detect.exe` | 必须 | 本机 ACP Agent 探测器 |
| `WebView2Loader.dll` | 必须 | Windows WebView2 启动依赖；缺失可能导致 `0xC0000135` |
| `pylon-cli.exe` | 建议；存在时自动收集 | CLI 管理工具；当前脚本缺失时只警告 |
| `resources/fonts/*` | 按构建资源实际生成 | 内置字体与呈现资源 |
| `resources/runtime/git/**` | 可选（`--with-runtime`，Hermes） | 完整 PortableGit；至少应能找到 `bin/bash.exe`、`usr/bin/msys-2.0.dll` 及 `true/cat/mktemp/mv/awk/grep.exe`。默认打包会剔除整个 `resources/runtime/` |
| `resources/runtime/portable-git.json` | 可选（`--with-runtime`） | PortableGit 版本、来源和 SHA-256 元数据 |
| `resources/runtime/README.txt` | 可选（`--with-runtime`） | 运行时用途、许可和准备方式说明 |
| `resources/sdk/pylon-plugin-sdk.js` | 必须 | 离线插件 SDK（单文件浏览器 ESM）：无 Node/源码环境的相对 import 目标；由 `bun run build:plugin-sdk` 生成 |
| `resources/sdk/pylon-plugin-manifest.schema.json` | 必须 | `pylon-plugin.json` 编辑器校验/补全 schema；与离线 SDK 一起发布 |
| `agents.example.yaml` | 必须 | 不含真实路径/密钥的配置模板 |
| `README.txt` | 必须 | 解压后首次运行和 Hermes 说明 |
| `portable.flag` | 必须 | 触发便携模式 |
| `data/` | 必须为空目录 | 首次运行时保存会话、插件、MCP 等本地数据 |
| `tools/install-webview2.bat` | 必须 | 联网安装 WebView2 的引导脚本 |
| `tools/MicrosoftEdgeWebview2Setup.exe` | 默认必须 | Evergreen Bootstrapper；使用 `--without-webview2` 时可省略 |

`<version>` 必须同时来自 `package.json`、`src-tauri/tauri.conf.json` 和
`src-tauri/Cargo.toml`，三处不一致时打包应停止。

ZIP 同目录另生成：

- `pylon-<version>-win64.zip.sha256`：ZIP 本身的 SHA-256；
- `pylon-<version>-win64.manifest.json`：每个文件的大小和 SHA-256，以及是否携带
  WebView2 bootstrapper。

这两个文件是交付校验材料，不需要再放进 ZIP 内。

## 3. 构建前提

在 Windows x64 构建机准备：

1. Bun（1.4+，依赖安装与脚本编排，`bun install`）与 Node.js 22（vite/vitest 等工具仍由 Node 宿主执行）；
2. Rust stable、Tauri 2 所需 Windows 构建工具；
3. Python 3；
4. 能启动目标 Windows WebView2 的环境；
5. 仅当要打 `--with-runtime` 包：首次准备 PortableGit 时可访问 Git for Windows release 下载地址；
6. 若需要把 WebView2 一起放进包，提前取得微软 Evergreen Bootstrapper，并放到
   `resources/release/tools/MicrosoftEdgeWebview2Setup.exe`。

PortableGit 二进制树不入 Git 源码仓库。默认发行不需要准备它；`--with-runtime` 打包时，
`prepare_hermes_runtime.py` 会把下载文件缓存在 `.cache/pylon/portable-git/`，把校验通过的完整树暂存到
`src-tauri/resources/runtime/git/`，重复构建会复用校验通过的树。切换上游版本时应
同步更新 `portable-git.json`，不要手工拼接或只复制 `bash.exe`。

## 4. 推荐构建流程

在仓库根目录执行：

```bash
bun install
bun run release:portable
```

`release:portable` 依次完成：

1. 构建前端（`tsc -b` + vite build）；
2. 生成正常版与离线版 SDK（正常版留在构建目录，离线版由 Tauri 复制到 release resources）；
3. 构建 Tauri release（不生成安装器；`beforeBuildCommand` 会再执行一次 `bun run build`）；
4. 构建 `pylon-detect.exe`；
5. 收集文件、审计、压缩并核对 manifest。默认剔除 `resources/runtime/`（PortableGit）；打包器会拒绝缺失、超 64 KiB 或混入 testing/宿主闭包的离线 SDK。

如果分发渠道不携带 WebView2 bootstrapper，可在完成前端、SDK、Tauri 和 detector 构建后
显式降级打包：

```bash
bun run build
bun run build:plugin-sdk
bun run tauri -- build --no-bundle
cargo build --manifest-path src-tauri/Cargo.toml --release --bin pylon-detect
python scripts/pack_release.py --without-webview2
```

需要内嵌 PortableGit 的发行，先准备运行时，再对打包脚本加 `--with-runtime`：

```bash
bun run prepare:hermes-runtime
python scripts/pack_release.py --with-runtime
```

降级包仍必须带 `tools/install-webview2.bat`，并在发布说明中明确首次运行可能需要联网
安装 WebView2。常规包不应使用该降级选项。

## 5. 打包前后验收

### 构建前

- [ ] 三处版本号一致，目标架构为 win64。
- [ ] 仅 `--with-runtime` 包：`python scripts/prepare_hermes_runtime.py` 成功，且运行时校验通过。
- [ ] 仅 `--with-runtime` 包：`resources/runtime/git/bin/bash.exe`、`usr/bin/msys-2.0.dll` 和关键命令均存在，
      `portable-git.json` 的 URL、版本和 SHA-256 与本次树一致。
- [ ] `resources/sdk/pylon-plugin-sdk.js` 与 manifest schema 存在，且 runtime 不含 `testing.js`、`PluginScope` 或 `createMockContext`。
- [ ] 离线 SDK bundle 不超过 64 KiB；正常版 package（含 `./testing` 类型入口）在插件开发套件中可独立导入。
- [ ] `agents.yaml`、`.env`、密钥和本机绝对路径没有被放入待打包目录。

### 打包后

- [ ] `python scripts/pack_release.py --verify-only <zip>` 通过。
- [ ] 使用 `Get-FileHash <zip> -Algorithm SHA256`（或等价工具）核对 `.sha256`。
- [ ] ZIP 只有一个 `pylon-<version>-win64/` 顶层目录，并包含空 `data/`。
- [ ] 解压到全新目录后可启动 `pylon.exe`；没有 WebView2 时，安装引导可工作。
- [ ] 使用 `provider=hermes` 的 Agent 发起一次真实 ACP 会话：默认包确认 Hermes 能解析
      本机标准路径的健康 Git Bash 并完成最小工具调用；`--with-runtime` 包确认 Hermes 使用包内 Bash。
- [ ] 使用一个非 Hermes Agent 启动会话，确认它不继承 Hermes 的 Bash 路径和变量。
- [ ] 检查 `manifest.json` 中的文件数量、大小和 hash 与 ZIP 内容一致。
- [ ] 仅 `--with-runtime` 包：保留 PortableGit 自带的 `LICENSE.txt`、`README.portable` 及其余上游许可/声明，
      不要为了缩小体积删除运行时文件。

## 6. 明确不能放进发行包的内容

打包脚本会拒绝或应人工清除以下内容：

- `agents.yaml`、`.env`、API key、token、密码和真实本机路径；
- 源码目录 `src/`、`src-tauri/src/`、`.git/`、`node_modules/`；
- `*.pdb`、`*.rlib`、`*.d`、开发期 target 中间文件；
- `--with-runtime` 包中未经校验的残缺 PortableGit 目录（默认包则根本不携带该树）。

默认发行不携带运行时：Hermes 依赖探测校验过的本机系统 Git Bash；探测会拒绝 WSL
的 `bash.exe` 与残缺安装，不接受任意 `PATH` 命中，因此不要用"把某个 bash 塞进
包里凑数"的方式绕过。

PortableGit 上游文本中的示例路径和许可内容属于第三方运行时，脚本对该树采用结构
校验而非把上游文档当作 Pylon 配置扫描；不要因此修改或删减上游文件。

## 7. 安装包（NSIS/MSI）补充

安装包不是 ZIP 的替代审计对象。`tauri.conf.json` 仍声明 `resources/runtime`，但默认
安装包与默认 ZIP 一致，不包含 PortableGit；只有按 `--with-runtime` 语义构建的安装包
才必须检查安装后的资源目录仍包含完整 PortableGit：

```bash
bun run tauri -- build --bundles nsis,msi
```

安装后应从实际安装目录验证：默认包确认 Hermes 解析本机系统 Git Bash，
`--with-runtime` 包确认 `resources/runtime/git` 完整，并分别测试 Hermes 与非 Hermes
Agent。安装器的 WebView2 下载策略由 Tauri 配置决定；若企业环境禁止联网，仍应提供
可离线获得 WebView2 的交付方案。

## 8. 运行时升级记录

本节仅影响 `--with-runtime` 发行；默认发行不携带 PortableGit，无需此节。

升级 PortableGit 时按以下顺序操作：

1. 更新 `src-tauri/resources/runtime/portable-git.json` 的版本、asset、URL 和 hash；
2. 运行 `python scripts/prepare_hermes_runtime.py --force`；
3. 重新构建并执行本清单的 Hermes/非 Hermes 验收；
4. 保留上游许可证和来源记录，并在发布说明中记录新版本与 ZIP hash。

不要把下载缓存或 `src-tauri/resources/runtime/git/` 强行加入源码提交；它们属于构建
输入和发布产物，不属于项目源文件。
