---
name: release
description: Pylon 一键发行流程——用户要求「构建 release / 发版 / 打包新版本 / 更新版本号 / 上传 GitHub Release」时使用。核心是 scripts/pack_release.py 的发行编排（--bump 版本号落位并提交 / --build 本地全链构建 / --upload 打 tag 触发 CI 发布）。加载后 MUST 先询问用户两件事：①版本号（版本方案 X.Y.Z-SUF）②是否上传 GitHub（决定是否走发布）；然后按本 skill 的路径执行。普通改动后的日常构建（check:all、非发行用 tauri debug）不必加载本 skill。
---

# Pylon 发行（一键版本号 + 构建 + 上传）

发行权威事实在《`docs/说明书/Pylon-发行包清单.md`》§4/§4.1 与 `.github/workflows/release.yml` 头注（#232：**打 tag 即发行**）。本 skill 是 agent 的操作路径。

## 第 0 步：先问，再动手（MUST）

用户要求构建 release 时，**必须先问清两件事再执行**：

1. **版本号**——先读当前版本（`package.json` 的 `version`，三处主版本 + 成员 crate 应一致），报给用户，按 `X.Y.Z-SUF` 方案建议下一号（如 `0.3.1-FMF` → `0.3.2-EFF`），**等用户确认**。
2. **是否上传 GitHub**——上传 = 走完整发布（tag 推送触发 CI 构建并发布 GitHub Release）；不上传 = 只本地落位 + 构建预演。

## 脚本入口（scripts/pack_release.py）

```bash
python scripts/pack_release.py --bump 0.3.2-EFF          # 版本号落位 9 文件 + pathspec 提交
python scripts/pack_release.py --bump 0.3.2-EFF --build  # 落位 + 本地全链构建（预演）
python scripts/pack_release.py --upload                  # main 归属守卫 + 打 v<ver> tag + 推送 → CI 发布
python scripts/pack_release.py                           # 旧行为：对已构建产物打包（编排参数都不带时）
```

- `--bump` 落位域：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri` 根 + 携带同版本号的成员 crate 各自 `Cargo.toml`、`Cargo.lock`（成员清单动态发现，独立版本号的 crate 不动）。任一文件计数不对即**整体中止不写盘**；提交 pathspec 只带这些文件，message 自动按先例格式生成。
- `--no-commit`：只改文件不提交（少用）。
- `--build`：本地跑 `bun run release:portable` 全链（#232 定位为**预演/排障**，正式发布由 CI 构建）。目标盘余量 < 10 GiB 会拒绝启动——历史教训：G 盘满时构建死在半路（os error 112），届时按 #228 纪律设 `CARGO_TARGET_DIR` 到余量充足的盘（如 D 盘）。
- `--upload` 守卫：HEAD 必须是 `<remote>/main` 的祖先（remote 自动选 `github`，回退 `origin`），否则拒绝并提示先合并 PR；tag 已存在也拒绝（CI 重试走 release.yml 的 `workflow_dispatch`，在 tag ref 上 dispatch 等价重推）。

## 路径 A：只构建，不上传（用户答「不上传」）

```bash
python scripts/pack_release.py --bump <确认的版本号> --build
```

产物在 `release/pylon-<ver>-win64.zip`（+ `.sha256` + `.manifest.json`）。构建是 release 级全链，**分钟级到几十分钟量级**——放后台跑（`run_in_background`），完成后再验收。

## 路径 B：完整发行（用户答「上传」）

1. `python scripts/pack_release.py --bump <版本号> --build` —— 落位提交 + 本地预演（磁盘守卫自动跑）。预演过了才配发布。
2. 推分支、开 PR（**不自动合并**，PR 描述写明这是版本号落位提交、关联 issue）。等 PR CI 绿后合并（合并动作按当轮用户授权行事）。
3. 切到 main 并更新：`git checkout main && git pull`（版本提交此时已在 main 上）。
4. `python scripts/pack_release.py --upload` —— 打 `v<版本号>` tag 推送，release.yml 自动构建并上传 zip/`.sha256`/`.manifest.json` 到该 tag 的 Release。
5. 盯 CI：`gh run watch`（或 Actions 页）。**pr/CI 不等待就向用户说明正在跑**；CI 红了抓日志修复。
6. 验收：`gh release view v<版本号>` 确认三件资产在位、zip 顶层目录 `pylon-<版本号>-win64/`、manifest 与 zip 一致（脚本 `--verify-only` 可离线复核）。

## 路径 C：版本已在 main，只补发布

第 3-6 步同路径 B，从 `--upload` 开始。

## 坑（本仓实测）

- **构建机 python**：2026-09-30 起系统 `python`/`python3`/`py` 已修复为 uv 托管 CPython 3.12（`~/.local/bin` 无后缀 shim 前置于 WindowsApps + HKCU `PythonCore\3.12` 影子注册覆盖死掉的 `F:\Python`，详见 `.agents/records/2026-09-30-release-0.3.4-LBI.md` §踩坑）。若复发（典型症状：静默无输出、exit 49）：改用全路径 `$APPDATA/uv/python/cpython-3.12-windows-x86_64-none/python.exe`，并把该目录前置到 PATH 再跑构建链（bun 子进程里的裸 `python` 也要靠它）。
- **tag 必须在 main 上**：打在未合并分支的 tag 会被 release.yml 的 main 归属守卫拒掉。
- **tag 错位 = 静默错发**：CI 校验 tag = `package.json` = `tauri.conf.json`，`--bump` 保证一致性，**不要手改版本号文件**。
- **网络/代理**：git 推送走 `git config --global http.proxy`；`gh` 命令**不读 git 代理配置**，需 `export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897`（端口以实际代理为准）。
- **共享工作树**：`--bump` 的提交是 pathspec 的，但开工前后仍按惯例先 `git status` 核对，别把他人的在途改动卷进来。
- **发行内容门禁**：本地打包即跑全量审计（禁绝对路径/敏感键/禁名文件）；`--with-runtime` 才带 Hermes PortableGit。这些规矩见《Pylon-发行包清单》，本 skill 不重复。
- 版本提交自身的 issue 关联：脚本生成的 message 已带 `(#402)`，勿删；PR 描述按 §2.5 写 issue 处置。
