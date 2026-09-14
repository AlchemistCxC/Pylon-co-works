//! `pylon-webview2-mcp` —— 面向 Pylon（Tauri 2 / Windows WebView2）前端的 MCP 调试服务器。
//!
//! 进程模型：MCP 客户端用 stdio 拉起本进程，本进程通过 WebView2 的
//! `--remote-debugging-port` 反连被调试的 app。因此本服务器**不需要**在 app 内
//! 驻留任何代码，也不需要 app 是 dev 构建。
//!
//! 命令行参数只用于本地调试（以及一个机器上跑多个实例时错开端口）。
//! MCP 客户端通常不带参数直接拉起。

mod args;
mod cdp;
mod error;
mod jsscript;
mod mcp;
mod tools;

use std::path::PathBuf;

use error::Error;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 9222;
const DEFAULT_TIMEOUT_MS: u64 = 20_000;

#[derive(Debug)]
struct Options {
    host: String,
    port: u16,
    timeout_ms: u64,
    cwd: PathBuf,
}

#[derive(Debug)]
enum Parsed {
    Run(Box<Options>),
    Help,
    Version,
}

impl Options {
    fn parse(argv: impl Iterator<Item = String>) -> std::result::Result<Parsed, String> {
        let arguments: Vec<String> = argv.collect();
        // `--help` / `--version` 先于一切校验。用户问「怎么用」时，
        // 另一个参数写错不该变成回答——那只会让人先改错再重问一遍。
        if arguments
            .iter()
            .any(|value| value == "-h" || value == "--help")
        {
            return Ok(Parsed::Help);
        }
        if arguments
            .iter()
            .any(|value| value == "-V" || value == "--version")
        {
            return Ok(Parsed::Version);
        }

        let mut host = DEFAULT_HOST.to_string();
        let mut port = DEFAULT_PORT;
        let mut timeout_ms = DEFAULT_TIMEOUT_MS;
        let mut cwd =
            std::env::current_dir().map_err(|error| format!("无法确定当前工作目录：{error}"))?;

        let mut arguments = arguments.into_iter();
        while let Some(argument) = arguments.next() {
            // 同时接受 `--port 9222` 与 `--port=9222`：MCP 客户端配置里两种写法都常见。
            let (flag, inline) = match argument.split_once('=') {
                Some((flag, value)) => (flag.to_string(), Some(value.to_string())),
                None => (argument, None),
            };
            let mut take_value = |name: &str| -> std::result::Result<String, String> {
                match inline.clone() {
                    Some(value) => Ok(value),
                    None => arguments.next().ok_or_else(|| format!("{name} 需要一个值")),
                }
            };

            match flag.as_str() {
                // 带 `=值` 的形式（`--help=x`）走不到预扫描，这里兜底。
                "-h" | "--help" => return Ok(Parsed::Help),
                "-V" | "--version" => return Ok(Parsed::Version),
                "--host" => host = take_value("--host")?,
                "--port" => {
                    let value = take_value("--port")?;
                    port = value
                        .parse()
                        .map_err(|_| format!("--port 需要 0-65535 的整数，收到 {value:?}"))?;
                }
                "--timeout-ms" => {
                    let value = take_value("--timeout-ms")?;
                    timeout_ms = value
                        .parse()
                        .map_err(|_| format!("--timeout-ms 需要非负整数，收到 {value:?}"))?;
                }
                "--cwd" => cwd = PathBuf::from(take_value("--cwd")?),
                other => {
                    return Err(format!(
                    "未知参数 {other:?}。可用：--host --port --timeout-ms --cwd --help --version"
                ))
                }
            }
        }

        Ok(Parsed::Run(Box::new(Options {
            host,
            port,
            timeout_ms,
            cwd,
        })))
    }
}

#[tokio::main]
async fn main() {
    let parsed = match Options::parse(std::env::args().skip(1)) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("[pylon-webview2-mcp] 参数错误：{message}");
            // 2 是命令行用法约定，与「运行期失败」区分开。
            std::process::exit(2);
        }
    };

    let options = match parsed {
        Parsed::Help => {
            print_help();
            return;
        }
        Parsed::Version => {
            println!("pylon-webview2-mcp {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Parsed::Run(options) => *options,
    };

    // 启动横幅走 stderr：stdout 是 MCP 协议通道，写一行非 JSON 就会让客户端解析失败。
    eprintln!(
        "[pylon-webview2-mcp] v{} 启动：CDP 端点 http://{}:{}，默认超时 {}ms，工作目录 {}",
        env!("CARGO_PKG_VERSION"),
        options.host,
        options.port,
        options.timeout_ms,
        options.cwd.display()
    );

    let server = mcp::Server::new(options.cwd, options.host, options.port, options.timeout_ms);
    if let Err(error) = server.serve().await {
        report_fatal(&error);
        std::process::exit(1);
    }
}

fn report_fatal(error: &Error) {
    eprintln!("[pylon-webview2-mcp] 致命错误：{error}");
}

fn print_help() {
    println!(
        "\
pylon-webview2-mcp {version} —— Pylon（Tauri 2 / WebView2）前端的 MCP 调试服务器

用法：
  pylon-webview2-mcp [选项]

选项：
  --host <地址>         WebView2 调试端点地址（默认 {host}）
  --port <端口>         WebView2 调试端点端口（默认 {port}）
  --timeout-ms <毫秒>   单次 CDP 调用的默认超时（默认 {timeout}）
  --cwd <目录>          tauri_event_catalog 扫描源码时的根目录（默认当前目录）
  -h, --help            显示本帮助
  -V, --version         显示版本

前置条件：
  Pylon 必须在 src-tauri/tauri.conf.json 的 app.windows[].additionalBrowserArgs
  里带上 --remote-debugging-port={port} 并重启。该字段会整串替换 wry 的默认参数，
  所以默认项 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection
  必须自己写回。详见 tools/webview2-mcp/README.md。

协议：
  在 stdin/stdout 上讲 MCP（JSON-RPC 2.0，一行一条报文）。
  stdout 只承载协议报文；所有诊断输出走 stderr。
",
        version = env!("CARGO_PKG_VERSION"),
        host = DEFAULT_HOST,
        port = DEFAULT_PORT,
        timeout = DEFAULT_TIMEOUT_MS,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(arguments: &[&str]) -> std::result::Result<Parsed, String> {
        Options::parse(arguments.iter().map(|s| s.to_string()))
    }

    fn run_options(arguments: &[&str]) -> Options {
        match parse(arguments) {
            Ok(Parsed::Run(options)) => *options,
            other => panic!(
                "期望 Run，实际是其它结果：{}",
                matches!(other, Ok(Parsed::Run(_)))
            ),
        }
    }

    #[test]
    fn defaults_are_the_local_webview2_port() {
        let options = run_options(&[]);
        assert_eq!(options.host, DEFAULT_HOST);
        assert_eq!(options.port, DEFAULT_PORT);
        assert_eq!(options.timeout_ms, DEFAULT_TIMEOUT_MS);
    }

    #[test]
    fn accepts_both_space_and_equals_forms() {
        assert_eq!(run_options(&["--port", "9333"]).port, 9333);
        assert_eq!(run_options(&["--port=9333"]).port, 9333);
        assert_eq!(run_options(&["--host=0.0.0.0"]).host, "0.0.0.0");
        assert_eq!(run_options(&["--timeout-ms", "500"]).timeout_ms, 500);
    }

    #[test]
    fn help_and_version_short_circuit_before_validation() {
        // --help 出现在非法参数之后也应当直接返回帮助，而不是先报参数错。
        assert!(matches!(
            parse(&["--port", "not-a-number", "--help"]),
            Ok(Parsed::Help)
        ));
        assert!(matches!(parse(&["-V"]), Ok(Parsed::Version)));
    }

    #[test]
    fn rejects_unparseable_and_out_of_range_port() {
        let error = parse(&["--port", "abc"]).unwrap_err();
        assert!(error.contains("--port"), "{error}");
        assert!(parse(&["--port", "70000"]).is_err());
        assert!(parse(&["--port", "-1"]).is_err());
    }

    #[test]
    fn rejects_a_flag_without_its_value() {
        let error = parse(&["--port"]).unwrap_err();
        assert!(error.contains("需要一个值"), "{error}");
    }

    #[test]
    fn rejects_unknown_flags_loudly() {
        let error = parse(&["--wat"]).unwrap_err();
        assert!(error.contains("未知参数"), "{error}");
        assert!(error.contains("--port"), "错误里应列出可用参数：{error}");
    }

    #[test]
    fn cwd_override_is_honoured() {
        let options = run_options(&["--cwd", "/tmp/elsewhere"]);
        assert_eq!(options.cwd, PathBuf::from("/tmp/elsewhere"));
    }
}
