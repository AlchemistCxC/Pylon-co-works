//! #106 P1：测试专用假 ACP agent（feature-gated：`--features test-agent` 才编译）。
//!
//! 以 Rust 子进程替代全部内嵌 Python 假 agent 脚本：stdin 逐行读 JSON-RPC、
//! stdout 写响应/通知（与真实 ACP wire 同为 UTF-8，无宿主 locale 变量）。
//! 行为按 `--scenario` 旗标路由，每个场景对应一份已删除脚本的精确语义
//! （见各场景变体注释）；跨场景共性（trace 落盘 / stderr 标记 / 文件屏障 /
//! 时序延迟）由独立旗标承担。
//!
//! 确定性：响应体一律 serde_json::Value 序列化（键序稳定），输出顺序即处理
//! 顺序（逐行阻塞读），无随机数、无真实时钟依赖（屏障用文件存在性）。
//!
//! 构建：`cargo build --bin pylon-fake-agent --features test-agent`
//! 单测：`cargo test --bin pylon-fake-agent --features test-agent`

use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = Config::parse(&args).unwrap_or_else(|error| {
        eprintln!("pylon-fake-agent: {error}\n{}", Config::usage());
        std::process::exit(2);
    });
    if let Some(marker) = &config.stderr_marker {
        eprintln!("{marker}");
        let _ = std::io::stderr().flush();
    }
    // hang：常驻进程（进程树击杀测试的孙进程），stdin 为 null 时读循环会立即
    // EOF 退出，故在读循环之前拦截驻留。
    if config.scenario == "hang" {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }
    // 启动即退（EOF/预检失败时序测试；--exit-code 控制退出码）：一个字节都不应答。
    if config.scenario == "exit-immediately" {
        std::process::exit(config.exit_code);
    }
    // close-stdin-after-init（#157 确定性写失败场景）：应答首请求（initialize）后
    // 关闭自身 stdin 读端并驻留。进程不退出 ⇒ exit watcher / stdout EOF 都不参与
    // 竞争；Pylon 后续写入必 broken pipe ⇒ 写失败路径的断言信号只能来自写失败本身
    // （旧 crash-after-init 的子进程即刻退出，全量并行下崩溃信号可能与 prepare_rpc
    // 竞争，测试偶发红）。须在主读循环之前拦截——读循环锁住 stdin 且读循环无法
    // 关闭自身句柄后继续驻留。
    if config.scenario == "close-stdin-after-init" {
        let mut agent = FakeAgent::new(config);
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        if let Some(Ok(line)) = stdin.lock().lines().next() {
            agent.handle_line(line.trim(), &mut out);
            let _ = out.flush();
        }
        close_stdin_read_end();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }
    // 启动采样探针：env-probe 把环境变量**原值**写入 trace（hermes env 注入断言
    // 读裸文本）；argv-probe 写 {argv, marker} JSON（wrapper argv 检查）。随后对
    // initialize 应答一次空 result 即退出。
    if config.scenario == "env-probe" || config.scenario == "argv-probe" {
        if let Some(path) = &config.trace_file {
            let payload = if config.scenario == "env-probe" {
                let name = config.env_var.as_deref().unwrap_or("HERMES_HOME");
                std::env::var(name).unwrap_or_else(|_| config.env_default.clone())
            } else {
                json!({
                    "argv": std::env::args().collect::<Vec<_>>(),
                    "marker": config
                        .env_var
                        .as_deref()
                        .and_then(|name| std::env::var(name).ok())
                        .unwrap_or_else(|| config.env_default.clone())
                })
                .to_string()
            };
            std::fs::write(path, format!("{payload}\n")).ok();
        }
    }
    let mut agent = FakeAgent::new(config);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line.unwrap_or_else(|error| {
            eprintln!("pylon-fake-agent: stdin read failed: {error}");
            std::process::exit(1);
        });
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match agent.handle_line(line, &mut out) {
            Flow::Continue => {}
            Flow::Exit => break,
        }
    }
}

/// 一行输入处理后的控制流：绝大多数场景常驻到 stdin EOF；crash/flood 显式退出。
enum Flow {
    Continue,
    Exit,
}

/// 关闭自身 stdin 的底层句柄/描述符（close-stdin-after-init 场景用）。
/// Rust std 不拥有标准流——drop `Stdin` 不会关闭底层句柄，须显式接管所有权关闭；
/// 关闭后本进程不再触碰 stdin（调用方随后驻留）。进程保持存活，管道读端消失 ⇒
/// 对端（Pylon）后续写入必 broken pipe。
#[cfg(windows)]
fn close_stdin_read_end() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    let handle = std::io::stdin().as_raw_handle();
    if !handle.is_null() {
        let owned = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) };
        drop(owned);
    }
}

#[cfg(unix)]
fn close_stdin_read_end() {
    use std::os::unix::io::FromRawFd;
    let stdin = unsafe { std::fs::File::from_raw_fd(0) };
    drop(stdin);
}

// ── 配置与旗标解析 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
struct Config {
    scenario: String,
    /// session/new 响应里的 sessionId（alive / stream / session-capable 族用）。
    session_id: Option<String>,
    /// crash-after-init：首响应后等待毫秒数再退出（crash-loop 用 200）。
    delay_ms: u64,
    /// flood：initialize 后连发的 session/update 条数。
    chunks: u32,
    /// stream 族：prompt 响应前先发的 agent_message_chunk 文本。
    prompt_chunk: Option<String>,
    /// stream 族：chunk 发出后、trace 写入与响应前的延迟（b11 = 200ms）。
    prompt_delay_ms: u64,
    /// stream 族：prompt 回 JSON-RPC error（-32000，message = 此值）。
    prompt_error: Option<String>,
    /// stream 族：session/load 先发两条回放 chunk 并回 loaded:true（b11 回放）。
    replay_load: bool,
    /// permission-proactive：主动 permission 请求的 id（JSON 值：`5` / `"perm-pa"`）。
    permission_id: Option<Value>,
    /// permission-proactive：主动 permission 请求的 params（完整 JSON 对象）。
    permission_params: Option<Value>,
    /// permission-proactive：initialize 应答后、发出请求前的延迟。
    permission_delay_ms: u64,
    /// interact-proactive（#230）：主动请求的方法名（如 elicitation/create），
    /// id/params 复用 --permission-id / --permission-params。
    proactive_method: Option<String>,
    /// permission-proactive：initialize 之外的行的处置——落 trace（静默）或回 {}。
    post_init_respond: bool,
    /// 收到的请求行落盘文件（收到即逐行 flush；写入范围由 trace_mode 限定）。
    trace_file: Option<String>,
    /// trace 范围：all = 所有行；post-init = initialize 之外全部（含客户端应答）；
    /// prompt-only = 仅 session/prompt 请求。
    trace_mode: TraceMode,
    /// 启动时写 stderr 的标记行（证据源：agent stderr → RuntimeLogHub）。
    stderr_marker: Option<String>,
    /// set-config-option：五种应答模式（#97 模型切换矩阵）。
    set_config_mode: String,
    /// 文件屏障：进入等待前 touch ready，轮询 release 出现（10s 超时退出 1）。
    barrier_ready: Option<String>,
    barrier_release: Option<String>,
    /// recovery-generation：等待的方法名与屏障后注入的 outcome。
    wait_method: Option<String>,
    outcome: Option<String>,
    /// revive-load：session/load 的完整响应体（根级 availableModels 宣告）。
    load_result: Option<Value>,
    /// error-echo：每个请求都回的 JSON-RPC 错误三元组。
    error_code: Option<i64>,
    error_message: Option<String>,
    error_data: Option<Value>,
    /// replay-history：session/load 回放的 chunk 文本数组（JSON）。
    load_chunks: Option<Vec<String>>,
    /// alive 族：session/new 响应前的延迟（延迟应答测试）。
    new_delay_ms: u64,
    /// prompt-hang：prompt 后不发响应的挂起时长。
    prompt_hang_ms: u64,
    /// env-probe / argv-probe：启动时采样的环境变量名与缺省值。
    env_var: Option<String>,
    env_default: String,
    /// exit 场景的退出码（stderr-marker 已在启动时输出）。
    exit_code: i32,
    /// stream-forever：chunk 间隔毫秒。
    chunk_interval_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum TraceMode {
    All,
    PostInit,
    PromptOnly,
}

impl Config {
    fn usage() -> String {
        // 场景清单与来源脚本一一对应；语义细节见各场景在 handle_request 的分支注释。
        "usage: pylon-fake-agent --scenario <NAME> [flags]\n\
         scenarios:\n\
         \x20 golden 家族（同一 handler，prompt 分支不同）: initialize | new_load | prompt | tool |\n\
         \x20   permission | done_error | cancel | reconnect\n\
         \x20 alive                  通用应答（loadSession 能力 + 会话回显 + end_turn）\n\
         \x20 crash-after-init       alive 应答首请求后退出（--delay-ms 造 crash-loop）\n\
         \x20 close-stdin-after-init alive 应答首请求后关自身 stdin 读端并驻留（写失败测试）\n\
         \x20 flood                  initialize 应答后连发 --chunks 条 update 再退出\n\
         \x20 stream | prompt-error | replay-load   b10/b11 流式/错误注入/回放装载\n\
         \x20 permission-proactive   initialize 后主动 request_permission（--permission-id/params）\n\
         \x20 interact-proactive      initialize 后主动发任意 client request（#230：--proactive-method，id/params 复用 permission 旗标）\n\
         \x20 set-config-option      #97 session/set_config_option 应答矩阵（--mode）\n\
         \x20 empty | session-capable | revive-echo | revive-load | resume-only\n\
         \x20 fork | rebind             #98 fork 执行链 / revive 后 identity 变化的 rebind\n\
         \x20 echo-empty | close-unsupported | trace-all | id-kinds | caps | probe\n\
         \x20 recovery-generation | plugin-fixture | hang | exit-immediately\n\
         \x20 error-echo | bad-caps | env-probe | argv-probe | init-params-probe | silent\n\
         \x20 control-echo | malformed-echo | prompt-hang | prompt-cancel-respond\n\
         \x20 replay-history | update-isolation | replay-eof\n\
         flags:\n\
         \x20 --session-id <id> --delay-ms <n> --chunks <n> --prompt-chunk <text>\n\
         \x20 --prompt-delay-ms <n> --prompt-error <msg> --permission-id <json>\n\
         \x20 --permission-params <json> --permission-delay-ms <n> --post-init-respond\n\
         \x20 --trace-file <path> --trace-mode <all|post-init|prompt-only>\n\
         \x20 --stderr-marker <text> --mode <m> --barrier-ready <p> --barrier-release <p>\n\
         \x20 --wait-method <m> --outcome <o> --advertise-models <json>\n\
         \x20 --error-code <n> --error-message <msg> --error-data <json>\n\
         \x20 --load-chunks <json-array> --new-delay-ms <n> --prompt-hang-ms <n>\n\
         \x20 --env-var <name> --env-default <value>"
            .to_string()
    }

    fn parse(args: &[String]) -> Result<Config, String> {
        let mut config = Config {
            scenario: String::new(),
            session_id: None,
            delay_ms: 0,
            chunks: 300,
            prompt_chunk: None,
            prompt_delay_ms: 0,
            prompt_error: None,
            replay_load: false,
            permission_id: None,
            permission_params: None,
            permission_delay_ms: 0,
            proactive_method: None,
            post_init_respond: false,
            trace_file: None,
            trace_mode: TraceMode::PostInit,
            stderr_marker: None,
            set_config_mode: "confirm".to_string(),
            barrier_ready: None,
            barrier_release: None,
            wait_method: None,
            outcome: None,
            load_result: None,
            error_code: None,
            error_message: None,
            error_data: None,
            load_chunks: None,
            new_delay_ms: 0,
            prompt_hang_ms: 200,
            env_var: None,
            env_default: "<absent>".to_string(),
            exit_code: 0,
            chunk_interval_ms: 150,
        };
        let mut index = 0;
        while index < args.len() {
            let flag = args[index].as_str();
            let value = |index: &mut usize, flag: &str| -> Result<String, String> {
                *index += 1;
                args.get(*index)
                    .cloned()
                    .ok_or_else(|| format!("{flag} requires a value"))
            };
            match flag {
                "--scenario" => config.scenario = value(&mut index, flag)?,
                "--session-id" => config.session_id = Some(value(&mut index, flag)?),
                "--delay-ms" => {
                    config.delay_ms = value(&mut index, flag)?
                        .parse()
                        .map_err(|_| format!("{flag} expects a number"))?
                }
                "--chunks" => {
                    config.chunks = value(&mut index, flag)?
                        .parse()
                        .map_err(|_| format!("{flag} expects a number"))?
                }
                "--prompt-chunk" => config.prompt_chunk = Some(value(&mut index, flag)?),
                "--prompt-delay-ms" => {
                    config.prompt_delay_ms = value(&mut index, flag)?
                        .parse()
                        .map_err(|_| format!("{flag} expects a number"))?
                }
                "--prompt-error" => config.prompt_error = Some(value(&mut index, flag)?),
                "--replay-load" => config.replay_load = true,
                "--permission-id" => {
                    config.permission_id = Some(
                        serde_json::from_str(&value(&mut index, flag)?)
                            .map_err(|error| format!("{flag} expects a JSON value: {error}"))?,
                    );
                }
                "--permission-params" => {
                    config.permission_params = Some(
                        serde_json::from_str(&value(&mut index, flag)?)
                            .map_err(|error| format!("{flag} expects a JSON object: {error}"))?,
                    );
                }
                "--permission-delay-ms" => {
                    config.permission_delay_ms = value(&mut index, flag)?
                        .parse()
                        .map_err(|_| format!("{flag} expects a number"))?
                }
                "--proactive-method" => config.proactive_method = Some(value(&mut index, flag)?),
                "--post-init-respond" => config.post_init_respond = true,
                "--trace-file" => config.trace_file = Some(value(&mut index, flag)?),
                "--trace-mode" => {
                    config.trace_mode = match value(&mut index, flag)?.as_str() {
                        "all" => TraceMode::All,
                        "post-init" => TraceMode::PostInit,
                        "prompt-only" => TraceMode::PromptOnly,
                        other => return Err(format!("unknown --trace-mode {other}")),
                    };
                }
                "--stderr-marker" => config.stderr_marker = Some(value(&mut index, flag)?),
                "--mode" => config.set_config_mode = value(&mut index, flag)?,
                "--barrier-ready" => config.barrier_ready = Some(value(&mut index, flag)?),
                "--barrier-release" => config.barrier_release = Some(value(&mut index, flag)?),
                "--wait-method" => config.wait_method = Some(value(&mut index, flag)?),
                "--outcome" => config.outcome = Some(value(&mut index, flag)?),
                "--advertise-models" => {
                    config.load_result = Some(
                        serde_json::from_str(&value(&mut index, flag)?)
                            .map_err(|error| format!("{flag} expects a JSON object: {error}"))?,
                    );
                }
                "--error-code" => {
                    config.error_code = Some(
                        value(&mut index, flag)?
                            .parse()
                            .map_err(|_| format!("{flag} expects a number"))?,
                    )
                }
                "--error-message" => config.error_message = Some(value(&mut index, flag)?),
                "--error-data" => {
                    config.error_data = Some(
                        serde_json::from_str(&value(&mut index, flag)?)
                            .map_err(|error| format!("{flag} expects a JSON value: {error}"))?,
                    );
                }
                "--load-chunks" => {
                    config.load_chunks = Some(
                        serde_json::from_str(&value(&mut index, flag)?).map_err(|error| {
                            format!("{flag} expects a JSON string array: {error}")
                        })?,
                    );
                }
                "--new-delay-ms" => {
                    config.new_delay_ms = value(&mut index, flag)?
                        .parse()
                        .map_err(|_| format!("{flag} expects a number"))?
                }
                "--prompt-hang-ms" => {
                    config.prompt_hang_ms = value(&mut index, flag)?
                        .parse()
                        .map_err(|_| format!("{flag} expects a number"))?
                }
                "--env-var" => config.env_var = Some(value(&mut index, flag)?),
                "--env-default" => config.env_default = value(&mut index, flag)?,
                "--exit-code" => {
                    config.exit_code = value(&mut index, flag)?
                        .parse()
                        .map_err(|_| format!("{flag} expects a number"))?
                }
                "--chunk-interval-ms" => {
                    config.chunk_interval_ms = value(&mut index, flag)?
                        .parse()
                        .map_err(|_| format!("{flag} expects a number"))?
                }
                other => return Err(format!("unknown flag {other}")),
            }
            index += 1;
        }
        if config.scenario.is_empty() {
            return Err("--scenario is required".to_string());
        }
        Ok(config)
    }
}

// ── 场景路由与请求处理 ──────────────────────────────────────────────────────────

struct FakeAgent {
    config: Config,
    /// golden 家族：已收到 prompt 请求、响应被暂扣的请求 id（permission/cancel 流）。
    pending_prompt: Option<Value>,
    /// recovery-generation：见过的 session/* 方法（_test/seen 回读）。
    seen: Vec<String>,
    trace: Option<std::fs::File>,
    /// plugin-fixture：slow 延迟应答的取消登记与 shutdown 顽固标志。
    cancelled: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    stubborn: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl FakeAgent {
    fn new(config: Config) -> Self {
        // 启动采样探针场景自己写 trace（Value 落盘），不走逐行 trace 通道——
        // File::create 会把探针已写入的内容截断。
        let trace = if matches!(config.scenario.as_str(), "env-probe" | "argv-probe") {
            None
        } else {
            config.trace_file.as_ref().map(|path| {
                std::fs::File::create(path).unwrap_or_else(|error| {
                    eprintln!("pylon-fake-agent: cannot create trace file {path}: {error}");
                    std::process::exit(1);
                })
            })
        };
        Self {
            config,
            pending_prompt: None,
            seen: Vec::new(),
            trace,
            cancelled: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            stubborn: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn handle_line(&mut self, line: &str, out: &mut impl Write) -> Flow {
        let request: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => return Flow::Continue,
        };
        self.write_trace(line, &request);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(method) = method else {
            // 客户端应答（无 method）：golden permission 流——收到后结束暂扣的 prompt。
            if let Some(id) = self.pending_prompt.take() {
                Self::write_frame(
                    out,
                    &Self::response(&id, Some(json!({"stopReason": "end_turn"})), None),
                );
            }
            return Flow::Continue;
        };
        self.handle_request(&method, &request, out)
    }

    /// trace 写入范围：all = 全部；post-init = initialize 外全部；prompt-only = 仅 prompt 请求。
    fn write_trace(&mut self, raw_line: &str, request: &Value) {
        let mode = self.config.trace_mode;
        let method = request.get("method").and_then(Value::as_str);
        let wanted = match mode {
            TraceMode::All => true,
            TraceMode::PostInit => method != Some("initialize"),
            TraceMode::PromptOnly => method == Some("session/prompt"),
        };
        if wanted {
            if let Some(file) = self.trace.as_mut() {
                let _ = writeln!(file, "{raw_line}");
                let _ = file.flush();
            }
        }
    }

    fn response(id: &Value, result: Option<Value>, error: Option<Value>) -> Value {
        let mut frame = json!({"jsonrpc": "2.0", "id": id});
        let object = frame.as_object_mut().expect("frame is an object");
        match (result, error) {
            (Some(result), _) => {
                object.insert("result".into(), result);
            }
            (None, Some(error)) => {
                object.insert("error".into(), error);
            }
            (None, None) => {
                object.insert("result".into(), Value::Null);
            }
        }
        frame
    }

    fn write_frame(out: &mut impl Write, frame: &Value) {
        let _ = writeln!(out, "{frame}");
        let _ = out.flush();
    }

    fn emit_update(&mut self, out: &mut impl Write, session_id: &str, update: Value) {
        Self::write_frame(
            out,
            &json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"sessionId": session_id, "update": update}
            }),
        );
    }

    fn chunk_update(text: &str) -> Value {
        // 原脚本形态：content 只有 text 键（无 type）——golden 基线逐字节一致的前提。
        json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"text": text}
        })
    }

    /// 文件屏障：touch ready → 轮询 release（10s 超时退出 1）。
    fn barrier(config: &Config) {
        let (Some(ready), Some(release)) = (&config.barrier_ready, &config.barrier_release) else {
            return;
        };
        std::fs::write(ready, b"").ok();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !std::path::Path::new(release).exists() {
            if std::time::Instant::now() > deadline {
                eprintln!("pylon-fake-agent: barrier timed out waiting for {release}");
                std::process::exit(1);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn sleep_ms(ms: u64) {
        if ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
    }

    fn handle_request(&mut self, method: &str, request: &Value, out: &mut impl Write) -> Flow {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let config = self.config.clone();
        match config.scenario.as_str() {
            // ── golden 家族：单一 handler，prompt 行为按场景名分支 ──
            "initialize" | "new_load" | "prompt" | "tool" | "permission" | "done_error"
            | "cancel" | "reconnect" => self.handle_golden(method, &id, &params, out),
            "alive" | "crash-after-init" | "close-stdin-after-init" => {
                if method == "session/new" {
                    Self::sleep_ms(config.new_delay_ms);
                }
                let response =
                    Self::alive_result(method, &params, self.config.session_id.as_deref());
                Self::write_frame(out, &Self::response(&id, Some(response), None));
                if config.scenario == "crash-after-init" {
                    Self::sleep_ms(config.delay_ms);
                    return Flow::Exit;
                }
                Flow::Continue
            }
            "flood" => {
                if method == "initialize" {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    for _ in 0..config.chunks {
                        self.emit_update(out, "flood", Self::chunk_update("x"));
                    }
                    Flow::Exit
                } else {
                    Flow::Continue
                }
            }
            // ── b10 流式 / b11 trace+错误注入+回放装载 / prompt hook trace ──
            "stream" | "prompt-error" | "replay-load" => {
                match method {
                    "session/new" => {
                        let session_id = config
                            .session_id
                            .as_deref()
                            .unwrap_or("fake-inject-session");
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": session_id})), None),
                        );
                    }
                    "session/load" if config.replay_load || config.scenario == "replay-load" => {
                        let session_id = params
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        self.emit_update(
                            out,
                            &session_id,
                            json!({
                                "sessionUpdate": "user_message_chunk",
                                "content": {"type": "text", "text": "persona\n\n---\n\nold question"}
                            }),
                        );
                        self.emit_update(out, &session_id, Self::chunk_update("old answer"));
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"loaded": true})), None),
                        );
                    }
                    "session/prompt" => {
                        let session_id = params
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        if let Some(text) = &config.prompt_chunk {
                            self.emit_update(out, &session_id, Self::chunk_update(text));
                            Self::sleep_ms(config.prompt_delay_ms);
                        }
                        // trace 已在 write_trace 以 prompt-only 范围落盘。
                        let response = match &config.prompt_error {
                            Some(message) => Self::response(
                                &id,
                                None,
                                Some(json!({"code": -32000, "message": message})),
                            ),
                            None => {
                                Self::response(&id, Some(json!({"stopReason": "end_turn"})), None)
                            }
                        };
                        Self::write_frame(out, &response);
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // ── p1 矩阵 / auto_reconnect permission / permission.rs 超时闭环 ──
            "permission-proactive" => {
                if method == "initialize" {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    Self::sleep_ms(config.permission_delay_ms);
                    let permission = json!({
                        "jsonrpc": "2.0",
                        "id": config.permission_id.clone().unwrap_or(json!(5)),
                        "method": "session/request_permission",
                        "params": config.permission_params.clone().unwrap_or(Value::Null),
                    });
                    Self::write_frame(out, &permission);
                } else if config.post_init_respond {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                }
                // trace 已在 write_trace 以 post-init 范围落盘（静默模式不回包）。
                Flow::Continue
            }
            // ── #230：任意 client request 主动桥（elicitation/create 等）——
            // CLI interaction list/respond 私有交互链路的 native 验收源。──
            "interact-proactive" => {
                if method == "initialize" {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    Self::sleep_ms(config.permission_delay_ms);
                    let proactive = json!({
                        "jsonrpc": "2.0",
                        "id": config.permission_id.clone().unwrap_or(json!(5)),
                        "method": config.proactive_method.clone().unwrap_or_else(|| "elicitation/create".to_string()),
                        "params": config.permission_params.clone().unwrap_or(Value::Null),
                    });
                    Self::write_frame(out, &proactive);
                } else if config.post_init_respond {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                }
                Flow::Continue
            }
            // ── #97：session/set_config_option 五模式矩阵 ──
            "set-config-option" => {
                match method {
                    "session/new" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(json!({
                                    "sessionId": config.session_id.as_deref().unwrap_or("ms-session"),
                                    "configOptions": [
                                        {"id": "model-selection", "category": "model",
                                         "options": [{"valueId": "m-1", "name": "One"}, {"valueId": "m-2", "name": "Two"}],
                                         "currentValue": "m-1"},
                                        {"id": "reasoning_effort", "category": "thought_level",
                                         "options": [{"valueId": "low"}, {"valueId": "high"}],
                                         "currentValue": "low"}
                                    ]
                                })),
                                None,
                            ),
                        );
                    }
                    "session/set_config_option" => {
                        let mode = config.set_config_mode.as_str();
                        if mode == "reject" {
                            Self::write_frame(
                                out,
                                &Self::response(
                                    &id,
                                    None,
                                    Some(
                                        json!({"code": -32000, "message": "model rejected by agent"}),
                                    ),
                                ),
                            );
                            return Flow::Continue;
                        }
                        if mode == "barrier" {
                            Self::barrier(&config);
                        }
                        let requested = params.get("value").cloned().unwrap_or(Value::Null);
                        let result = if mode == "echo-empty" {
                            json!({})
                        } else if mode == "legacy" {
                            // 旧形 key/value 回显（dispatcher 协议路由测试用）。
                            json!({"configOptions": [{"key": "model", "value": "gpt-4"}]})
                        } else if let Some(current) = mode.strip_prefix("echo-adopted:") {
                            json!({"configOptions": [
                                {"id": "model-selection", "category": "model",
                                 "options": [{"valueId": "m-1"}, {"valueId": "m-2"}],
                                 "currentValue": current},
                                {"id": "reasoning_effort", "category": "thought_level",
                                 "options": [{"valueId": "low"}, {"valueId": "high"}],
                                 "currentValue": "low"}
                            ]})
                        } else {
                            json!({"configOptions": [
                                {"id": "model-selection", "category": "model",
                                 "options": [{"valueId": "m-1"}, {"valueId": "m-2"}],
                                 "currentValue": requested},
                                {"id": "reasoning_effort", "category": "thought_level",
                                 "options": [{"valueId": "low"}, {"valueId": "high"}],
                                 "currentValue": "low"}
                            ]})
                        };
                        Self::write_frame(out, &Self::response(&id, Some(result), None));
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            "empty" => {
                let result = if method == "session/new" {
                    json!({"sessionId": config.session_id.as_deref().unwrap_or("empty-session")})
                } else {
                    json!({})
                };
                Self::write_frame(out, &Self::response(&id, Some(result), None));
                Flow::Continue
            }
            // instance_registry：loadSession 会话能力 + 固定名会话（复活注册表场景）。
            "session-capable" | "revive-echo" => {
                match method {
                    "initialize" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(
                                    json!({"agentCapabilities": {"sessionCapabilities": {"loadSession": {}}}}),
                                ),
                                None,
                            ),
                        );
                    }
                    "session/new" => {
                        let session_id = config.session_id.as_deref().unwrap_or(
                            if config.scenario == "revive-echo" {
                                "newly-created"
                            } else {
                                "shared-name"
                            },
                        );
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": session_id})), None),
                        );
                    }
                    "session/load" if config.scenario == "revive-echo" => {
                        let session_id = params.get("sessionId").cloned().unwrap_or(Value::Null);
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": session_id})), None),
                        );
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // model_switch 复活宣告：session/load 回根级 availableModels（完整响应体由旗标注入）。
            "revive-load" => {
                let result = if method == "initialize" {
                    json!({"agentCapabilities": {"sessionCapabilities": {"loadSession": {}}}})
                } else if method == "session/load" {
                    config.load_result.clone().unwrap_or(json!({}))
                } else {
                    json!({})
                };
                Self::write_frame(out, &Self::response(&id, Some(result), None));
                Flow::Continue
            }
            // revive resume 路径：resume 回显；load = 契约破坏（立即退出）；new 不应到达。
            "resume-only" => {
                match method {
                    "initialize" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(
                                    json!({"agentCapabilities": {"sessionCapabilities": {"resume": {}}}}),
                                ),
                                None,
                            ),
                        );
                    }
                    "session/resume" => {
                        let session_id = params.get("sessionId").cloned().unwrap_or(Value::Null);
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": session_id})), None),
                        );
                    }
                    "session/load" => {
                        eprintln!(
                            "pylon-fake-agent: load must not be called after successful resume"
                        );
                        std::process::exit(1);
                    }
                    "session/new" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(json!({"sessionId": "unexpected-new"})),
                                None,
                            ),
                        );
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // fork 执行链（#98 fork 用例；语义对照已删除的 FORK_SCRIPT）：
            // initialize 同时宣告 fork 与 loadSession（gate 要 fork，parent 侧
            // 的 load 判定要 loadSession）；session/fork 成功回 child id 与一个
            // 未知厂商扩展字段——后者是「raw envelope 保真」的回归面；
            // `--outcome error` 时回 -32000（失败回滚用例走这条）。
            "fork" => {
                match method {
                    "initialize" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(
                                    json!({"agentCapabilities": {"sessionCapabilities": {"fork": {}, "loadSession": {}}}}),
                                ),
                                None,
                            ),
                        );
                    }
                    "session/fork" => {
                        let response = if config.outcome.as_deref() == Some("error") {
                            Self::response(
                                &id,
                                None,
                                Some(json!({
                                    "code": config.error_code.unwrap_or(-32000),
                                    "message": config
                                        .error_message
                                        .as_deref()
                                        .unwrap_or("fork unavailable"),
                                })),
                            )
                        } else {
                            Self::response(
                                &id,
                                Some(json!({
                                    "sessionId": config.session_id.as_deref().unwrap_or("remote-child"),
                                    "_vendorExtension": {"future": true},
                                })),
                                None,
                            )
                        };
                        Self::write_frame(out, &response);
                    }
                    // 其余方法沿用旧脚本的 parent 回显（load 等路径原样）。
                    _ => {
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": "remote-parent"})), None),
                        );
                    }
                }
                Flow::Continue
            }
            // revive 后远端 identity 变化（#98 rebind 用例；语义对照已删除的
            // rebind 脚本）：只宣告 loadSession，session/load 回一个**新** id
            // （默认 remote-rebound，可用 `--session-id` 改），从而触发显式 rebind。
            "rebind" => {
                let result = if method == "initialize" {
                    json!({"agentCapabilities": {"sessionCapabilities": {"loadSession": {}}}})
                } else if method == "session/load" {
                    json!({"sessionId": config.session_id.as_deref().unwrap_or("remote-rebound")})
                } else {
                    json!({})
                };
                Self::write_frame(out, &Self::response(&id, Some(result), None));
                Flow::Continue
            }
            // lifecycle restart 矩阵：对一切请求回空 result。
            "echo-empty" => {
                Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                Flow::Continue
            }
            // session close 策略矩阵：session/close 报 -32601，其余空 result。
            "close-unsupported" => {
                let response = if method == "session/close" {
                    Self::response(
                        &id,
                        None,
                        Some(json!({"code": -32601, "message": "Method not found"})),
                    )
                } else {
                    Self::response(&id, Some(json!({})), None)
                };
                Self::write_frame(out, &response);
                Flow::Continue
            }
            // session generation 拦截：全部请求原样落 trace + 空 result。
            "trace-all" => {
                Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                Flow::Continue
            }
            // OBS-01：initialize 后发四类 id 形态报文；prompt 期 string-id permission 闭环。
            "id-kinds" => {
                match method {
                    "initialize" => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                        Self::write_frame(
                            out,
                            &json!({"jsonrpc": "2.0", "method": "session/update",
                                    "params": {"sessionId": "s-1"}}),
                        );
                        Self::write_frame(
                            out,
                            &Self::response(&json!(7), Some(json!({"ok": true})), None),
                        );
                        Self::write_frame(
                            out,
                            &Self::response(&json!("str-id-1"), Some(json!({"ok": true})), None),
                        );
                        Self::write_frame(
                            out,
                            &Self::response(&Value::Null, Some(Value::Null), None),
                        );
                    }
                    "session/new" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(json!({"sessionId": "fake-session-1"})),
                                None,
                            ),
                        );
                    }
                    "session/prompt" => {
                        Self::write_frame(
                            out,
                            &json!({"jsonrpc": "2.0", "id": "perm-1",
                                    "method": "session/request_permission",
                                    "params": {"sessionId": "fake-session-1", "toolCallId": "tc-1",
                                               "options": [{"optionId": "allow_once"}, {"optionId": "deny"}]}}),
                        );
                        Self::write_frame(
                            out,
                            &json!({"jsonrpc": "2.0", "method": "session/update",
                                    "params": {"sessionId": "fake-session-1", "toolCallId": "tc-1",
                                               "type": "tool_call_update"}}),
                        );
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"stopReason": "end_turn"})), None),
                        );
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // 能力协商：initialize 回完整 agentCapabilities + protocolVersion。
            "caps" => {
                let result = if method == "initialize" {
                    json!({"protocolVersion": 1,
                           "agentCapabilities": {"loadSession": true, "promptCapabilities": {"image": true}}})
                } else {
                    json!({})
                };
                Self::write_frame(out, &Self::response(&id, Some(result), None));
                Flow::Continue
            }
            // lifecycle 连续性探针：missing 报错、timeout 静默、其余回放探测。
            "probe" => {
                if method == "initialize" {
                    Self::write_frame(
                        out,
                        &Self::response(
                            &id,
                            Some(json!({"agentCapabilities": {"loadSession": true}})),
                            None,
                        ),
                    );
                } else if method == "session/load" {
                    let session_id = params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if session_id == "remote-missing" {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                None,
                                Some(json!({"code": -32602, "message": "session not found"})),
                            ),
                        );
                    } else if session_id != "remote-timeout" {
                        self.emit_update(
                            out,
                            session_id,
                            Self::chunk_update("probe-replay-must-not-apply"),
                        );
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": session_id})), None),
                        );
                    }
                    // remote-timeout：不回包（客户端超时路径）。
                } else {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                }
                Flow::Continue
            }
            // revive 恢复代际竞态：等待指定方法 → 屏障 → 按 outcome 回错/成功。
            "recovery-generation" => {
                if method == "initialize" {
                    let wait_resume = config.wait_method.as_deref() == Some("session/resume");
                    let capabilities = if wait_resume {
                        json!({"agentCapabilities": {"sessionCapabilities": {"resume": {}, "loadSession": {}}}})
                    } else {
                        json!({"agentCapabilities": {"sessionCapabilities": {"loadSession": {}}}})
                    };
                    Self::write_frame(out, &Self::response(&id, Some(capabilities), None));
                } else if method == "_test/seen" {
                    Self::write_frame(
                        out,
                        &Self::response(&id, Some(json!({"methods": self.seen.clone()})), None),
                    );
                } else if method.starts_with("session/") {
                    self.seen.push(method.to_string());
                    let mut error = None;
                    if Some(method) == config.wait_method.as_deref() {
                        Self::barrier(&config);
                        if config.outcome.as_deref() == Some("error") {
                            error = Some(json!({"code": -32000, "message": "session unavailable"}));
                        }
                    }
                    let result = json!({"sessionId": "remote-original"});
                    Self::write_frame(out, &Self::response(&id, Some(result), error));
                } else {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                }
                Flow::Continue
            }
            // 插件进程监督夹具（plugin_process 测试专用，语义对照已删除的 service.py）：
            // echo / slow（延迟应答线程）/ armStubborn（shutdown 拒绝退出）/ crash（exit 7）/
            // flood（stderr+progress 洪泛）/ spawnChild（自我再执行 hang 孙进程）。
            "plugin-fixture" => {
                match method {
                    "$/cancelRequest" => {
                        let id = request
                            .get("params")
                            .and_then(|params| params.get("id"))
                            .map(|value| value.to_string())
                            .unwrap_or_default();
                        self.cancelled.lock().unwrap().insert(id);
                    }
                    "shutdown" => {
                        if self.stubborn.load(std::sync::atomic::Ordering::Acquire) {
                            std::thread::sleep(std::time::Duration::from_secs(60));
                        }
                        return Flow::Exit;
                    }
                    "echo" => {
                        let params = request.get("params").cloned().unwrap_or(Value::Null);
                        Self::write_frame(out, &Self::response(&id, Some(params), None));
                    }
                    "slow" => {
                        let request_id = id.clone();
                        let cancelled = std::sync::Arc::clone(&self.cancelled);
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(10));
                            if cancelled.lock().unwrap().contains(&request_id.to_string()) {
                                return;
                            }
                            let stdout = std::io::stdout();
                            let mut lock = stdout.lock();
                            Self::write_frame(
                                &mut lock,
                                &Self::response(&request_id, Some(json!("late")), None),
                            );
                        });
                    }
                    "armStubborn" => {
                        self.stubborn
                            .store(true, std::sync::atomic::Ordering::Release);
                        Self::write_frame(out, &Self::response(&id, Some(json!("armed")), None));
                    }
                    "crash" => {
                        std::process::exit(7);
                    }
                    "flood" => {
                        let stderr = std::io::stderr();
                        let mut err_lock = stderr.lock();
                        for index in 0..2048 {
                            let _ = writeln!(err_lock, "err-{index:04}-{}", "x".repeat(512));
                        }
                        let _ = err_lock.flush();
                        drop(err_lock);
                        for index in 0..2048 {
                            Self::write_frame(
                                out,
                                &json!({"jsonrpc": "2.0", "method": "progress",
                                        "params": {"index": index}}),
                            );
                        }
                        Self::write_frame(out, &Self::response(&id, Some(json!("drained")), None));
                    }
                    "spawnChild" => {
                        let pid_file = request
                            .get("params")
                            .and_then(|params| params.get("pidFile"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_default();
                        let self_exe = std::env::current_exe().unwrap_or_else(|error| {
                            eprintln!("pylon-fake-agent: current_exe failed: {error}");
                            std::process::exit(1);
                        });
                        let child = std::process::Command::new(self_exe)
                            .args(["--scenario", "hang"])
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .spawn()
                            .unwrap_or_else(|error| {
                                eprintln!("pylon-fake-agent: spawnChild failed: {error}");
                                std::process::exit(1);
                            });
                        std::fs::write(&pid_file, child.id().to_string()).ok();
                        Self::write_frame(out, &Self::response(&id, Some(json!(child.id())), None));
                    }
                    _ => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                None,
                                Some(json!({"code": -32601, "message": "missing"})),
                            ),
                        );
                    }
                }
                Flow::Continue
            }
            "hang" => {
                // 供 spawnChild/进程树击杀测试的常驻进程（实际拦截在读循环前，本分支
                // 仅兜底——例如以管道喂入且永不关闭的非常规用法）。
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                }
            }
            // 每请求回同一个 JSON-RPC 错误（connect 预检/初始化失败分类测试）。
            "error-echo" => {
                let error = json!({
                    "code": config.error_code.unwrap_or(-32041),
                    "message": config.error_message.clone().unwrap_or_else(|| "error".into()),
                    "data": config.error_data.clone().unwrap_or(Value::Null),
                });
                Self::write_frame(out, &Self::response(&id, None, Some(error)));
                Flow::Continue
            }
            // 非对象 agentCapabilities（Capability 阶段失败分类）。
            "bad-caps" => {
                let result = if method == "initialize" {
                    json!({"agentCapabilities": []})
                } else {
                    json!({})
                };
                Self::write_frame(out, &Self::response(&id, Some(result), None));
                Flow::Continue
            }
            // initialize 应答一次空 result 即退出（EOF 时序 / writer EPIPE 测试）。
            "env-probe" | "argv-probe" => {
                Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                if method == "initialize" {
                    return Flow::Exit;
                }
                Flow::Continue
            }
            // initialize 应答 initialize 的 params 落盘（clientCapabilities wire 断言）。
            "init-params-probe" => {
                if method == "initialize" {
                    if let (Some(path), Some(request_params)) =
                        (&config.trace_file, request.get("params"))
                    {
                        std::fs::write(path, format!("{request_params}\n")).ok();
                    }
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    return Flow::Exit;
                }
                Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                Flow::Continue
            }
            // initialize → {}，此后对所有请求保持静默（客户端 rpc_timeout 路径）。
            "silent" => {
                if method == "initialize" {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                }
                Flow::Continue
            }
            // 控制请求回显：trace 全量；有 id 才应答（通知不回包）；close 回 closed。
            "control-echo" => {
                if request.get("id").is_some() {
                    let result = if method == "session/close" {
                        json!({"closed": true})
                    } else {
                        json!({})
                    };
                    Self::write_frame(out, &Self::response(&id, Some(result), None));
                }
                Flow::Continue
            }
            // 每请求先发一行坏 JSON 再正常应答（解码容错测试）。
            "malformed-echo" => {
                let _ = writeln!(out, "{{malformed-json");
                let _ = out.flush();
                let result = if method == "session/new" {
                    json!({"sessionId": "after-malformed"})
                } else {
                    json!({})
                };
                Self::write_frame(out, &Self::response(&id, Some(result), None));
                Flow::Continue
            }
            // prompt 挂起（不回包）直到收到 cancel 才发一条 'cancelled' update。
            "prompt-hang" => {
                match method {
                    "initialize" => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                    "session/prompt" => {
                        Self::sleep_ms(config.prompt_hang_ms);
                    }
                    "session/cancel" => {
                        let session_id = params
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        self.emit_update(out, &session_id, Self::chunk_update("cancelled"));
                    }
                    _ => {}
                }
                Flow::Continue
            }
            // prompt 挂起后由 cancel 触发对原 prompt id 的 cancelled 终态响应。
            "prompt-cancel-respond" => {
                match method {
                    "initialize" => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                    // #324 集成切片：send_message 路径先建会话再 prompt——
                    // 本场景原先只服务直连 AcpClient 的传输层测试，补 session/new
                    // 应答使内核级 send→cancel→中性结算 E2E 可达。
                    "session/new" => {
                        let session_id = config
                            .session_id
                            .as_deref()
                            .unwrap_or("fake-cancel-session");
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(json!({"sessionId": session_id})),
                                None,
                            ),
                        );
                    }
                    "session/prompt" => {
                        self.pending_prompt = Some(id.clone());
                    }
                    "session/cancel" => {
                        if let Some(pending) = self.pending_prompt.take() {
                            Self::write_frame(
                                out,
                                &Self::response(
                                    &pending,
                                    Some(json!({"stopReason": "cancelled"})),
                                    None,
                                ),
                            );
                        }
                    }
                    _ => {}
                }
                Flow::Continue
            }
            // session/load 回放：按 --load-chunks 文本数组发 update 后回 loaded:true。
            "replay-history" => {
                match method {
                    "initialize" => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                    "session/load" => {
                        let session_id = params
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        for text in config.load_chunks.clone().unwrap_or_default() {
                            self.emit_update(out, &session_id, Self::chunk_update(&text));
                        }
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"loaded": true})), None),
                        );
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // 回放隔离：夹入其他 session 的 update，目标会话只应收到自己的两条。
            "update-isolation" => {
                if method == "initialize" {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                } else if method == "session/load" {
                    let session_id = params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    for (update_session, text) in [
                        (session_id.as_str(), "target-1"),
                        ("other-session", "must-not-leak"),
                        (session_id.as_str(), "target-2"),
                    ] {
                        self.emit_update(out, update_session, Self::chunk_update(text));
                    }
                    Self::write_frame(
                        out,
                        &Self::response(&id, Some(json!({"loaded": true})), None),
                    );
                }
                Flow::Continue
            }
            // 回放中途 EOF：发一条 history-1 即退出（ConnectionClosed 快速收敛）。
            "replay-eof" => {
                if method == "initialize" {
                    Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                } else if method == "session/load" {
                    let session_id = params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    self.emit_update(out, &session_id, Self::chunk_update("history-1"));
                    return Flow::Exit;
                }
                Flow::Continue
            }
            // 初始 options 全量宣告 + set_model/set_mode/set_config_option 逐项回显
            //（new_session 初始 options 的 wire 顺序测试用）。
            "initial-options-echo" => {
                match method {
                    "session/new" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(json!({
                                    "sessionId": config.session_id.as_deref().unwrap_or("p28-session"),
                                    "models": {
                                        "currentModelId": "provider:old",
                                        "availableModels": [
                                            {"modelId": "provider:old", "name": "Old"},
                                            {"modelId": "provider:new", "name": "New"}
                                        ]
                                    },
                                    "modes": {
                                        "currentModeId": "default",
                                        "availableModes": [
                                            {"id": "default", "name": "Default"},
                                            {"id": "accept_edits", "name": "Accept Edits"}
                                        ]
                                    },
                                    "configOptions": [{
                                        "id": "reasoning_effort",
                                        "name": "Reasoning effort",
                                        "category": "thought_level",
                                        "options": [{"id": "none"}, {"id": "high"}],
                                        "currentValue": "none"
                                    }]
                                })),
                                None,
                            ),
                        );
                    }
                    "session/set_model" => {
                        let model_id = params.get("modelId").cloned().unwrap_or(Value::Null);
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(json!({"models": {"currentModelId": model_id}})),
                                None,
                            ),
                        );
                    }
                    "session/set_mode" => {
                        let mode_id = params.get("modeId").cloned().unwrap_or(Value::Null);
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(json!({"modes": {"currentModeId": mode_id}})),
                                None,
                            ),
                        );
                    }
                    "session/set_config_option" => {
                        let config_id = params.get("configId").cloned().unwrap_or(Value::Null);
                        let value = params.get("value").cloned().unwrap_or(Value::Null);
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(
                                    json!({"configOptions": [{"id": config_id, "currentValue": value}]}),
                                ),
                                None,
                            ),
                        );
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // session/new 报指定 JSON-RPC 错误（provider 未配置等失败路径）。
            "new-error" => {
                let response = if method == "session/new" {
                    Self::response(
                        &id,
                        None,
                        Some(json!({
                            "code": config.error_code.unwrap_or(-32603),
                            "message": config.error_message.clone().unwrap_or_else(|| "error".into())
                        })),
                    )
                } else {
                    Self::response(&id, Some(json!({})), None)
                };
                Self::write_frame(out, &response);
                Flow::Continue
            }
            // prompt 永不响应（首 token 超时路径），其余正常应答。
            "prompt-silent" => {
                match method {
                    "session/prompt" => {}
                    _ => {
                        let response =
                            Self::alive_result(method, &params, self.config.session_id.as_deref());
                        Self::write_frame(out, &Self::response(&id, Some(response), None));
                    }
                }
                Flow::Continue
            }
            // prompt 后无限流式 chunk（持续活动截断测试：活动期间不得超时）。
            "stream-forever" => {
                match method {
                    "session/new" => {
                        let response =
                            Self::alive_result(method, &params, self.config.session_id.as_deref());
                        Self::write_frame(out, &Self::response(&id, Some(response), None));
                    }
                    "session/prompt" => {
                        let session_id = params
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let mut index = 0_u64;
                        loop {
                            let frame = json!({
                                "jsonrpc": "2.0", "method": "session/update",
                                "params": {"sessionId": session_id, "update": {
                                    "sessionUpdate": "agent_message_chunk",
                                    "content": {"type": "text", "text": format!("chunk{index}")}
                                }}
                            });
                            let payload = format!("{frame}\n");
                            if out.write_all(payload.as_bytes()).is_err() {
                                break;
                            }
                            let _ = out.flush();
                            index += 1;
                            std::thread::sleep(std::time::Duration::from_millis(
                                config.chunk_interval_ms,
                            ));
                        }
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // resume 报 archived、load 回显、new = 契约破坏（exit 1）。
            "resume-archived-load-echo" => {
                match method {
                    "initialize" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(
                                    json!({"agentCapabilities": {"sessionCapabilities": {"resume": {}, "loadSession": {}}}}),
                                ),
                                None,
                            ),
                        );
                    }
                    "session/resume" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                None,
                                Some(json!({"code": -32000, "message": "session archived"})),
                            ),
                        );
                    }
                    "session/load" => {
                        let session_id = params.get("sessionId").cloned().unwrap_or(Value::Null);
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": session_id})), None),
                        );
                    }
                    "session/new" => {
                        eprintln!("pylon-fake-agent: new must not be called after load success");
                        std::process::exit(1);
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // resume/load 都报错 → 调用方只能新建。
            "resume-load-error-new" => {
                match method {
                    "initialize" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(
                                    json!({"agentCapabilities": {"sessionCapabilities": {"resume": {}, "loadSession": {}}}}),
                                ),
                                None,
                            ),
                        );
                    }
                    "session/resume" | "session/load" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                None,
                                Some(json!({"code": -32000, "message": "session unavailable"})),
                            ),
                        );
                    }
                    "session/new" => {
                        let session_id =
                            config.session_id.as_deref().unwrap_or("recreated-session");
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": session_id})), None),
                        );
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // resume 能力是布尔（形态非法）→ 不得 resume；load 回显。
            "resume-bool-load-echo" => {
                match method {
                    "initialize" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                &id,
                                Some(
                                    json!({"agentCapabilities": {"sessionCapabilities": {"resume": true, "loadSession": {}}}}),
                                ),
                                None,
                            ),
                        );
                    }
                    "session/resume" => {
                        eprintln!("pylon-fake-agent: malformed boolean capability must not resume");
                        std::process::exit(1);
                    }
                    "session/load" => {
                        let session_id = params.get("sessionId").cloned().unwrap_or(Value::Null);
                        Self::write_frame(
                            out,
                            &Self::response(&id, Some(json!({"sessionId": session_id})), None),
                        );
                    }
                    _ => {
                        Self::write_frame(out, &Self::response(&id, Some(json!({})), None));
                    }
                }
                Flow::Continue
            }
            // load 报 not-found，其余一律回新建会话 id。
            "load-error-else-new" => {
                let response = if method == "session/load" {
                    Self::response(
                        &id,
                        None,
                        Some(json!({"code": -32000, "message": "session not found"})),
                    )
                } else {
                    Self::response(
                        &id,
                        Some(
                            json!({"sessionId": config.session_id.as_deref().unwrap_or("fresh-session")}),
                        ),
                        None,
                    )
                };
                Self::write_frame(out, &response);
                Flow::Continue
            }
            // 一切请求都回同一个 sessionId（无持久化 id 直接新建路径）。
            "new-always" => {
                Self::write_frame(
                    out,
                    &Self::response(
                        &id,
                        Some(
                            json!({"sessionId": config.session_id.as_deref().unwrap_or("direct-new")}),
                        ),
                        None,
                    ),
                );
                Flow::Continue
            }
            unknown => {
                eprintln!("pylon-fake-agent: unknown scenario {unknown}");
                std::process::exit(2);
            }
        }
    }

    /// alive 族各方法的 result（也服务于 crash-after-init 的首响应）。
    fn alive_result(method: &str, params: &Value, session_id: Option<&str>) -> Value {
        match method {
            "initialize" => json!({"agentCapabilities": {"loadSession": true}}),
            "session/new" => json!({"sessionId": session_id.unwrap_or("fake-session-1")}),
            "session/load" => json!({
                "sessionId": params.get("sessionId").cloned().unwrap_or(json!("fake-session-1"))
            }),
            "session/prompt" => json!({"stopReason": "end_turn"}),
            _ => json!({}),
        }
    }

    /// golden 家族（语义逐行对照已删除的 GOLDEN_AGENT_SCRIPT）。
    fn handle_golden(
        &mut self,
        method: &str,
        id: &Value,
        params: &Value,
        out: &mut impl Write,
    ) -> Flow {
        let scenario = self.config.scenario.clone();
        match method {
            "initialize" => {
                Self::write_frame(
                    out,
                    &Self::response(
                        id,
                        Some(json!({"agentCapabilities": {"loadSession": true}})),
                        None,
                    ),
                );
            }
            "session/new" => {
                Self::write_frame(
                    out,
                    &Self::response(id, Some(json!({"sessionId": "golden-session"})), None),
                );
            }
            "session/load" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("golden-session");
                for text in ["history-1", "history-2"] {
                    self.emit_update(out, session_id, Self::chunk_update(text));
                }
                Self::write_frame(
                    out,
                    &Self::response(id, Some(json!({"loaded": true})), None),
                );
            }
            "session/prompt" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("golden-session");
                self.pending_prompt = Some(id.clone());
                if scenario != "cancel" {
                    self.emit_update(out, session_id, Self::chunk_update("golden reply"));
                }
                match scenario.as_str() {
                    "tool" => {
                        self.emit_update(
                            out,
                            session_id,
                            json!({"sessionUpdate": "tool_call", "toolCallId": "tc-golden",
                                   "title": "golden tool", "status": "in_progress"}),
                        );
                        self.emit_update(
                            out,
                            session_id,
                            json!({"sessionUpdate": "tool_call_update", "toolCallId": "tc-golden",
                                   "status": "completed",
                                   "content": [{"type": "text", "text": "tool output"}]}),
                        );
                        Self::write_frame(
                            out,
                            &Self::response(id, Some(json!({"stopReason": "end_turn"})), None),
                        );
                        self.pending_prompt = None;
                    }
                    "permission" => {
                        Self::write_frame(
                            out,
                            &json!({
                                "jsonrpc": "2.0", "id": 9001,
                                "method": "session/request_permission",
                                "params": {"sessionId": session_id, "toolCallId": "tc-golden",
                                           "options": [{"optionId": "allow_once", "name": "Allow once"},
                                                       {"optionId": "deny", "name": "Deny"}]}
                            }),
                        );
                    }
                    "done_error" => {
                        Self::write_frame(
                            out,
                            &Self::response(
                                id,
                                None,
                                Some(json!({"code": -32000, "message": "golden failure"})),
                            ),
                        );
                        self.pending_prompt = None;
                    }
                    "cancel" => {}
                    _ => {
                        Self::write_frame(
                            out,
                            &Self::response(id, Some(json!({"stopReason": "end_turn"})), None),
                        );
                        self.pending_prompt = None;
                    }
                }
            }
            "session/cancel" => {
                if let Some(pending) = self.pending_prompt.take() {
                    // cancel 场景的提交序：先补发被暂扣的 reply，再回 cancelled
                    //（因果序保持，不与客户端通知竞争）。
                    if scenario == "cancel" {
                        self.emit_update(out, "golden-session", Self::chunk_update("golden reply"));
                    }
                    Self::write_frame(
                        out,
                        &Self::response(&pending, Some(json!({"stopReason": "cancelled"})), None),
                    );
                }
            }
            _ => {
                Self::write_frame(out, &Self::response(id, Some(json!({})), None));
            }
        }
        Flow::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(scenario: &str) -> Config {
        Config::parse(&["--scenario".to_string(), scenario.to_string()]).expect("config")
    }

    fn drive(scenario: &str, lines: &[Value]) -> Vec<Value> {
        drive_with(config(scenario), lines)
    }

    fn drive_with(cfg: Config, lines: &[Value]) -> Vec<Value> {
        let mut agent = FakeAgent::new(cfg);
        let mut out = Vec::new();
        for line in lines {
            let _ = agent.handle_line(&line.to_string(), &mut out);
        }
        String::from_utf8(out)
            .expect("UTF-8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("frame"))
            .collect()
    }

    fn request(id: Value, method: &str) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": {"sessionId": "s"}})
    }

    #[test]
    fn config_parse_requires_scenario_and_rejects_unknown_flags() {
        assert!(Config::parse(&[]).is_err());
        assert!(Config::parse(&["--scenario".into(), "alive".into(), "--nope".into()]).is_err());
        let parsed = Config::parse(&[
            "--scenario".into(),
            "crash-after-init".into(),
            "--delay-ms".into(),
            "200".into(),
        ])
        .expect("config");
        assert_eq!(parsed.scenario, "crash-after-init");
        assert_eq!(parsed.delay_ms, 200);
    }

    #[test]
    fn alive_answers_capabilities_new_load_and_prompt() {
        let frames = drive(
            "alive",
            &[
                request(json!(1), "initialize"),
                request(json!(2), "session/new"),
                request(json!(3), "session/prompt"),
            ],
        );
        assert_eq!(
            frames[0]["result"]["agentCapabilities"]["loadSession"],
            true
        );
        assert_eq!(frames[1]["result"]["sessionId"], "fake-session-1");
        assert_eq!(frames[2]["result"]["stopReason"], "end_turn");
    }

    #[test]
    fn alive_session_id_override_and_load_echo() {
        let mut cfg = config("alive");
        cfg.session_id = Some("e11-session".into());
        let mut agent = FakeAgent::new(cfg);
        let mut out = Vec::new();
        let _ = agent.handle_line(&request(json!(1), "session/load").to_string(), &mut out);
        let frames: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            frames[0]["result"]["sessionId"], "s",
            "load 必须回显请求 sessionId"
        );
    }

    #[test]
    fn golden_prompt_emits_reply_then_end_turn() {
        let frames = drive(
            "prompt",
            &[
                request(json!(1), "initialize"),
                request(json!(2), "session/prompt"),
            ],
        );
        assert_eq!(
            frames[0]["result"]["agentCapabilities"]["loadSession"],
            true
        );
        assert_eq!(
            frames[1]["method"], "session/update",
            "reply chunk 必须先于响应"
        );
        assert_eq!(
            frames[1]["params"]["update"]["content"]["text"],
            "golden reply"
        );
        assert_eq!(frames[2]["result"]["stopReason"], "end_turn");
    }

    #[test]
    fn golden_cancel_withholds_reply_until_cancel_notification() {
        // 语义锚点：原 cancel_fixture_reply_waits_for_cancel——barrier 应答 → reply → cancelled。
        let frames = drive(
            "cancel",
            &[
                request(json!(1), "session/prompt"),
                request(json!(2), "fixture/barrier"),
                json!({"jsonrpc": "2.0", "method": "session/cancel"}),
            ],
        );
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0]["id"], 2, "barrier 应答必须先于补发的 reply");
        assert_eq!(frames[1]["method"], "session/update");
        assert_eq!(frames[2]["id"], 1);
        assert_eq!(frames[2]["result"]["stopReason"], "cancelled");
    }

    #[test]
    fn golden_permission_waits_for_client_response_before_settling() {
        let mut agent = FakeAgent::new(config("permission"));
        let mut out = Vec::new();
        let _ = agent.handle_line(&request(json!(1), "session/prompt").to_string(), &mut out);
        let frames: Vec<Value> = String::from_utf8(out.clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(frames[0]["method"], "session/update", "reply chunk");
        let permission = frames
            .iter()
            .find(|frame| frame["method"] == "session/request_permission")
            .expect("permission request");
        assert_eq!(permission["id"], 9001);
        assert_eq!(permission["params"]["options"][0]["optionId"], "allow_once");
        // 客户端应答后，暂扣的 prompt 以 end_turn 收敛。
        let _ = agent.handle_line(
            &json!({"jsonrpc": "2.0", "id": 9001, "result": {"outcome": {"outcome": "selected"}}})
                .to_string(),
            &mut out,
        );
        let all: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let last = all.last().expect("settled prompt response");
        assert_eq!(last["id"], 1);
        assert_eq!(last["result"]["stopReason"], "end_turn");
    }

    #[test]
    fn set_config_option_modes_route_correctly() {
        let set_request = || {
            let mut request = request(json!(1), "session/set_config_option");
            request["params"]["value"] = json!("m-2");
            request
        };
        // confirm：回显请求值。
        let frames = drive("set-config-option", &[set_request()]);
        assert_eq!(
            frames[0]["result"]["configOptions"][0]["currentValue"], "m-2",
            "confirm 模式必须回显请求值"
        );
        // reject：错误应答。
        let mut cfg = config("set-config-option");
        cfg.set_config_mode = "reject".into();
        let frames = drive_with(cfg, &[set_request()]);
        assert_eq!(frames[0]["error"]["code"], -32000);
        assert_eq!(frames[0]["error"]["message"], "model rejected by agent");
        // echo-empty：空 result。
        let mut cfg = config("set-config-option");
        cfg.set_config_mode = "echo-empty".into();
        let frames = drive_with(cfg, &[set_request()]);
        assert_eq!(frames[0]["result"], json!({}));
        // echo-adopted:high：权威钳制值。
        let mut cfg = config("set-config-option");
        cfg.set_config_mode = "echo-adopted:high".into();
        let frames = drive_with(cfg, &[set_request()]);
        assert_eq!(
            frames[0]["result"]["configOptions"][0]["currentValue"], "high",
            "echo-adopted 必须回权威值而非请求值"
        );
    }

    #[test]
    fn permission_proactive_emits_request_after_initialize() {
        let mut cfg = config("permission-proactive");
        cfg.permission_id = Some(json!("perm-pa"));
        cfg.permission_params = Some(json!({"sessionId": "s", "toolCallId": "call-9"}));
        let mut agent = FakeAgent::new(cfg);
        let mut out = Vec::new();
        let _ = agent.handle_line(&request(json!(1), "initialize").to_string(), &mut out);
        let frames: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(frames.len(), 2, "initialize 应答 + 主动 permission 请求");
        assert_eq!(frames[1]["id"], "perm-pa");
        assert_eq!(frames[1]["method"], "session/request_permission");
        assert_eq!(frames[1]["params"]["toolCallId"], "call-9");
    }

    #[test]
    fn trace_post_init_skips_initialize_and_writes_client_responses() {
        let path = std::env::temp_dir().join(format!(
            "pylon-fake-bin-trace-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut cfg = config("permission-proactive");
        cfg.trace_file = Some(path.to_string_lossy().into_owned());
        cfg.trace_mode = TraceMode::PostInit;
        let mut agent = FakeAgent::new(cfg);
        let mut sink = Vec::new();
        let _ = agent.handle_line(&request(json!(1), "initialize").to_string(), &mut sink);
        let _ = agent.handle_line(
            &json!({"jsonrpc": "2.0", "id": 5, "result": {}}).to_string(),
            &mut sink,
        );
        drop(agent);
        let traced = std::fs::read_to_string(&path).expect("trace file");
        std::fs::remove_file(&path).ok();
        let lines: Vec<Value> = traced
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            lines.len(),
            1,
            "initialize 之外的行（含客户端应答）才落 trace"
        );
        assert_eq!(lines[0]["id"], 5);
    }

    #[test]
    fn flood_emits_configured_chunk_count_then_exits() {
        let mut cfg = config("flood");
        cfg.chunks = 3;
        let mut agent = FakeAgent::new(cfg);
        let mut out = Vec::new();
        let flow = agent.handle_line(&request(json!(1), "initialize").to_string(), &mut out);
        assert_eq!(
            std::mem::discriminant(&flow),
            std::mem::discriminant(&Flow::Exit)
        );
        let frames: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(frames.len(), 4, "1 应答 + 3 update");
        assert_eq!(frames[1]["params"]["update"]["content"]["text"], "x");
    }

    #[test]
    fn replay_load_emits_two_history_chunks_and_loaded() {
        let frames = drive("replay-load", &[request(json!(1), "session/load")]);
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames[0]["params"]["update"]["sessionUpdate"],
            "user_message_chunk"
        );
        assert_eq!(
            frames[1]["params"]["update"]["content"]["text"],
            "old answer"
        );
        assert_eq!(frames[2]["result"]["loaded"], true);
    }
}
