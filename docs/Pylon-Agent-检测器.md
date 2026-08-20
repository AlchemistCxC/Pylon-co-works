# Pylon Agent 检测器

`pylon-detect` 是不依赖已启动桌面应用的本地 ACP Agent 检测程序。它与设置页的“检测 Agent”按钮调用同一个 Rust 检测核心；两条入口共享 `shared/agent-catalog.json` 的 provider、启动命令和配置证据规则。

```text
pylon-detect [--json] [--detector <id>] [--home <path>] [--search-root <path>]
```

- 不传参数时检查 PATH 与有限的平台安装目录，并从当前用户目录读取配置证据。
- `--detector` 可重复，只运行指定 detector。
- `--home` 覆盖配置目录所属的用户目录，便于诊断和自动化测试。
- `--search-root` 可重复；一旦提供，只在这些目录中找可执行文件，不再扩展平台目录或读取 Windows App Paths。
- `--json` 输出稳定的 `{ "candidates": [...] }` 文档。

配置证据只读取 catalog 明确列出的相对文件，单文件上限 256 KiB，不递归扫描。JSON/YAML 解析成功后仅输出命中的字段名（例如 `provider`、`model`），不输出字段值，因此 API key、token 和模型服务凭据不会进入 GUI 或 CLI 结果。

开发环境运行：

```text
cargo run --manifest-path src-tauri/Cargo.toml --bin pylon-detect -- --help
cargo run --manifest-path src-tauri/Cargo.toml --bin pylon-detect -- --json
```
