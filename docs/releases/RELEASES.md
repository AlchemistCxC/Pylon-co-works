# 发行包内容记录

> 本目录记录 Pylon 各版本发行包（zip）的内容、结构与用途。
> 更新时机：每次发布 release 后，把实际打进去的文件登记到此。

## 目录结构

| 版本 | 日期 | 对应 commit | zip 大小 | 链接 |
|:--|:--|:--|:--|:--|
| v1.3.1 | 2026-08-19 | f07337a | 38.2 MB | https://github.com/AlchemistCxC/Pylon-co-works/releases/tag/v1.3.1 |
| v1.3.0 | 2026-08-19 | 9368318 | 36.3 MB | https://github.com/AlchemistCxC/Pylon-co-works/releases/tag/v1.3.0 |

---

## 标准发行包结构（v1.3.x 起）

zip 内 5 个组件，根目录平铺（仅字体带 `resources/fonts/` 子路径）：

```
pylon-<version>-win64.zip
├── pylon.exe              主程序（Tauri GUI，~40 MB）
├── pylon-cli.exe          CLI 工具（命令表见 docs/Pylon-CLI-命令表.md，~2.6 MB）
├── pylon-detect.exe       Agent 检测 CLI（~2.5 MB）
├── WebView2Loader.dll     WebView2 加载器（Tauri 运行时依赖）
└── resources/fonts/
    └── SGr-IosevkaSS18.ttc   等宽字体（UI 渲染必需，旁置不嵌入）
```

### 组件说明

| 组件 | 用途 | 体积变化说明 |
|:--|:--|:--|
| `pylon.exe` | 桌面主程序：ACP 多 Agent 工作台 + Prism 注入 + 插件宿主 | 1.3.0 modern GUI 后 ~42.5MB → pylon-core 拆分后 40.6MB |
| `pylon-cli.exe` | CLI：会话/agent 命令 | 42.7MB → 2.6MB（pylon-core 拆分，-94%） |
| `pylon-detect.exe` | agent runtime 检测 CLI | 42.6MB → 2.5MB（拆分后新纳入 zip） |
| `WebView2Loader.dll` | Tauri v2 运行时必需 | ~0.2MB |
| 字体 ttc | UI 等宽字体（资源旁置） | ~18MB 压缩后进 zip |

### 打包命令（对应 scripts/pack_release.py / 手动 python）

```python
files = [
    ('src-tauri/target/release/pylon.exe', 'pylon.exe'),
    ('src-tauri/target/release/pylon-cli.exe', 'pylon-cli.exe'),
    ('src-tauri/target/release/pylon-detect.exe', 'pylon-detect.exe'),
    ('src-tauri/target/release/WebView2Loader.dll', 'WebView2Loader.dll'),
    ('src-tauri/target/release/resources/fonts/SGr-IosevkaSS18.ttc', 'resources/fonts/SGr-IosevkaSS18.ttc'),
]
```

### 发布注意事项

- **不含 portable data/**：发布 zip 不带数据目录（数据留本地，portable 模式自动建）。备份脚本 `scripts/backup-portable-data.sh`。
- **构建前提**：pylon.exe 未运行；MinGW 在 PATH 首位（`/f/Coding/mingw64/bin`）；`unset RUSTFLAGS`。
- **版本号四处对齐**：package.json / package-lock.json / tauri.conf.json / Cargo.toml。
- **gh release create 必须在 push 之后**（否则 tag 指向旧 commit），详见 skill github-release-ops。

---

## 各版本增量

### v1.3.1（2026-08-19, f07337a）
- fix(stderr)：回显级别跟随 classify_stderr_level，消除满屏 ERROR agent_stderr_echo
- fix(portable)：setup 自动迁移 AppData 旧数据（修复 UI 迁移按钮时序缺陷）
- chore：bump 1.3.1 + portable 数据备份脚本
- **发行包结构：** 标准 5 组件（见上），zip 38.2MB

### v1.3.0（2026-08-19, 9368318）
- 50-commit modern GUI 重构：界面模式插件化、pylon-core 子 crate 拆分
- **发行包结构：** 标准 5 组件，zip 36.3MB（pylon-detect 首次纳入）

### v1.2.0（2026-08-18）
- 强插件系统（历史版本，结构同 5 组件）

### v1.1.0（2026-08-16）
- 历史版本：4 组件（无 pylon-detect.exe）
