# Dev Record — #402 一键发行编排（--bump/--build/--upload）+ 发行 skill

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#402
- 分支：`kumo/prometheus`（共享分支，PR #403，同 #374 先例）
- 提交范围：`bf888832..22be4ab7`（本批三提交：`4470fcc1` 实现 + `22be4ab7` bun 垫片修复 + `14dc1b8c` 0.3.2-EFF 落位）
- 日期：2026-09-27

## 目标与范围

用户原话：「写个一键改版本号功能到打包脚本里：包含：重命名版本号并提交，然后build release，还能选择是否上传」「写一个skill，内容就是打包脚本的用法，并且说明：当用户要求构建release时询问版本号，是否上传」。

**做**：`pack_release.py` 编排入口（`--bump` 落位并提交 / `--build` 本地全链 / `--upload` 守卫后打 tag 触发 CI 发行）、发行 skill、说明书 §4/§4.1 同步、0.3.2-EFF 实跑发行。
**不做**：不改 pack 既有「收集/审计/压缩」契约（不带编排参数时行为与历史一致）；不改 release.yml（#232 打 tag 即发行语义零改动）；不做 PR 创建/合并自动化。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/pack_release.py` | 新增「版本落位与发行编排」段（成员发现/lock 补丁/bump/提交/磁盘预检/构建/远端选择/upload 守卫）+ `parse_args`/`main` 编排分支 + `parse_version_from_cargo_toml` 重构为共用 `parse_package_field_from_toml` | 修改 |
| `scripts/tests/test_pack_release.py` | 新增 `ReleaseOrchestrationTests`（11 用例）+ `FakeGit` 替身 | 修改 |
| `.agents/skills/release/SKILL.md` | 整文件：交互前置（先问版本号/是否上传）+ 路径 A/B/C + 坑清单 | 新增 |
| `docs/说明书/Pylon-发行包清单.md` | §4 编排入口一段、§4.1 `--upload` 一段 | 修改 |
| 9 个版本文件（`14dc1b8c`） | 0.3.1-FMF → 0.3.2-EFF | 修改 |

## 方案要点

- **落位域 = 先例 `6e7a22d3` 的 9 文件**；成员 crate 清单不硬编码（#259 教训），从 `[workspace] members` 动态解析，凡 `[package] version` 与应用版本一致的成员随动，独立版本号的 crate（pylon-core 等 v1.0.0）不受影响。
- **原子性**：manifest 计数与 lock 条目完整性全部先算后核，通过才统一写盘——半套落位比失败更糟。
- **上传 = tag 推送**（#232），`--upload` 只做三道守卫（版本一致/tag 未存在/HEAD 是远端 main 祖先）+ 打 tag + 推送；PR 创建/合并留在人/agent 手里，不自动化。
- **磁盘预检**：构建目标盘 < 10 GiB 拒绝启动（#228/#399 的 os error 112 两次教训）。
- **提交纪律**：`_git` 走参数列表不经 shell（L.md 088a5096 反引号教训）；pathspec 只带 9 文件（§2.5）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `--bump` 落位 9 文件、lock 仅版本行变化、`resolve_version()` 一致 | ✅ `14dc1b8c` diff 与 `6e7a22d3` 逐文件一致（9 文件，lock 12 行=6 个 version 行） |
| 版本提交仅含版本文件、先例格式 message | ✅ commit stat 9 files / message `chore(release): 0.3.2-EFF 版本号落位（…）` |
| `--upload` 三守卫（main 归属/tag 已存在/fetch 失败） | ✅ 各有单测（FakeGit 序列） |
| `--build` 磁盘阈值拒绝 | ✅ 实跑真拦一次（G 盘 6.1 GiB → 拒绝，见下）+ 阈值单测 |
| `test:pack` 新增用例绿、既有不红 | ✅ 43 tests OK（新增 11） |

## 实跑记录（首次发行编排，0.3.2-EFF）

1. `--bump 0.3.2-EFF`：落位 + 提交 `14dc1b8c`。
2. `--build` 第一次：磁盘预检**真拦**（G 盘 6.1 GiB < 10 GiB）——守卫按设计工作。按 #228 纪律 `CARGO_TARGET_DIR=D:/pylon-target` 重跑（0.3.1-FMF 同款）；顺带删可再生 `src-tauri/target/debug/incremental`（1.4G，#399 批先例）缓解 G 盘。
3. `--build` 第二次：先撞 **bun 垫片 WinError 2**（npm 风格 .cmd 不能被 CreateProcess 裸启动）→ `22be4ab7` 修复（`shutil.which` 按 PATHEXT 解析，.cmd/.bat 经 `cmd /c`）。
4. `--build` 第三次成功：D 盘全量重编，产出 `release/pylon-0.3.2-EFF-win64.zip`（39,030,120 字节）+ `.sha256` + `.manifest.json`，`verify OK: manifest 与 ZIP 内容一致（302 项）`。
5. PR #403 评论补 #402 处置（`Closes #402`）；合并后 main 上 `--upload` 打 `v0.3.2-EFF` 推送，release.yml 构建上传（结果见 issue 评论区回写）。

## 测试处置

新增 `ReleaseOrchestrationTests` 11 用例（格式校验/同步落位/计数原子性/版本源漂移原子性/lock 缺条目不落盘/提交 pathspec 与 message/磁盘阈值/upload 三守卫+成功序列+目标不匹配/远端选择）；既有 32 用例零改动全绿。

## 证据

- commit：`4470fcc1`、`22be4ab7`、`14dc1b8c`
- 测试：`bun run test:pack` → `Ran 43 tests ... OK`（退出码 0）
- 实机：`release/pylon-0.3.2-EFF-win64.zip` 39,030,120 bytes；`verify OK: manifest 与 ZIP 内容一致（302 项）`；磁盘预检拦截日志与 bun 垫片 traceback 见 `/tmp/pylon-build-0332.log` 前两轮
- 发行：tag `v0.3.2-EFF`（合并后由 `--upload` 打发）→ Release 资产三件在位（见 issue 评论区）

## 与 spec 的偏差

- spec 未预见的两处实跑修复：磁盘预检真拦（预期行为）与 bun 垫片 WinError 2（`22be4ab7`，spec 方案节未写 Windows 可执行解析细节）。
- 其余与 spec 一致。

## 未解问题

- `release/` 目录仍并存 0.3.1-FMF 与 0.3.2-EFF 两套产物（打包器只覆写同名文件，不清理旧版本产物）——无实害，暂不处理。
- C 盘余量 0.6 GiB、G 盘长期紧张：盘位治理属工作机问题，不在本仓范围（L.md #375-376/#399 条目已有记录）。
