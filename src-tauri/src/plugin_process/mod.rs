//! Plugin-owned process supervisor (Phase 8).
//!
//! Every process is resolved from the active package manifest, tagged with a
//! runtime instance, attached to the existing Windows Job Object abstraction,
//! and observed through one bounded Tauri event stream. JSON-RPC requests are
//! correlated in native code so deactivation can settle every pending caller.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::acp::ManagedChild;

const MAX_WRITE_BYTES: usize = 16 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProcessStatus {
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ProcessProtocol {
    Raw,
    Lines,
    JsonLines,
    JsonRpc,
    Http,
}

impl Default for ProcessProtocol {
    fn default() -> Self {
        Self::JsonRpc
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum RestartPolicy {
    Never,
    OnFailure,
    Always,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self::Never
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestartOptions {
    #[serde(default)]
    policy: RestartPolicy,
    #[serde(default)]
    max_attempts: u32,
    #[serde(default = "default_backoff")]
    backoff_ms: u64,
}

fn default_backoff() -> u64 {
    250
}

impl Default for RestartOptions {
    fn default() -> Self {
        Self {
            policy: RestartPolicy::Never,
            max_attempts: 0,
            backoff_ms: default_backoff(),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ShutdownMethod {
    Stdin,
    JsonRpc,
    Signal,
    Kill,
}

impl Default for ShutdownMethod {
    fn default() -> Self {
        Self::Stdin
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShutdownOptions {
    #[serde(default)]
    method: ShutdownMethod,
    #[serde(default = "default_shutdown_timeout")]
    timeout_ms: u64,
}

fn default_shutdown_timeout() -> u64 {
    2_000
}

impl Default for ShutdownOptions {
    fn default() -> Self {
        Self {
            method: ShutdownMethod::Stdin,
            timeout_ms: default_shutdown_timeout(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginPath {
    namespace: String,
    #[serde(default)]
    path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginProcessOptions {
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<PluginPath>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    protocol: ProcessProtocol,
    #[serde(default)]
    restart: RestartOptions,
    #[serde(default)]
    shutdown: ShutdownOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginProcessDescriptor {
    process_id: String,
    plugin_id: String,
    runtime_instance_id: String,
    executable_id: String,
    status: ProcessStatus,
    pid: Option<u32>,
    restart_attempts: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginProcessEvent {
    process_id: String,
    plugin_id: String,
    runtime_instance_id: String,
    sequence: u64,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
}

struct PendingRequest {
    sender: oneshot::Sender<Result<Value, String>>,
}

struct SpawnRecipe {
    executable: std::path::PathBuf,
    cwd: std::path::PathBuf,
    options: PluginProcessOptions,
}

struct ProcessRecord {
    process_id: String,
    plugin_id: String,
    runtime_instance_id: String,
    executable_id: String,
    recipe: SpawnRecipe,
    child: Mutex<ManagedChild>,
    stdin: Mutex<Option<std::process::ChildStdin>>,
    status: Mutex<ProcessStatus>,
    pending: Mutex<HashMap<String, PendingRequest>>,
    stdout_line_buffer: Mutex<Vec<u8>>,
    logs: Mutex<VecDeque<PluginProcessEvent>>,
    sequence: AtomicU64,
    restart_attempts: AtomicU32,
    stopping: AtomicBool,
}

impl ProcessRecord {
    fn descriptor(&self) -> PluginProcessDescriptor {
        PluginProcessDescriptor {
            process_id: self.process_id.clone(),
            plugin_id: self.plugin_id.clone(),
            runtime_instance_id: self.runtime_instance_id.clone(),
            executable_id: self.executable_id.clone(),
            status: self
                .status
                .lock()
                .map(|value| *value)
                .unwrap_or(ProcessStatus::Failed),
            pid: self.child.lock().ok().and_then(|child| child.pid()),
            restart_attempts: self.restart_attempts.load(Ordering::SeqCst),
        }
    }
}

pub(crate) struct PluginProcessSupervisor {
    processes: Mutex<HashMap<String, Arc<ProcessRecord>>>,
    next_process: AtomicU64,
    next_request: AtomicU64,
}

impl Default for PluginProcessSupervisor {
    fn default() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            next_process: AtomicU64::new(1),
            next_request: AtomicU64::new(1),
        }
    }
}

impl PluginProcessSupervisor {
    fn spawn<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        plugin_id: String,
        runtime_instance_id: String,
        package_instance_id: Option<String>,
        executable_id: String,
        options: PluginProcessOptions,
    ) -> Result<PluginProcessDescriptor, String> {
        validate_options(&options)?;
        let executable = crate::plugin_cmds::resolve_executable(
            &app,
            &plugin_id,
            package_instance_id.as_deref(),
            &executable_id,
        )
        .map_err(|error| error.to_string())?;
        let cwd_spec = options.cwd.clone().unwrap_or(PluginPath {
            namespace: "runtime".into(),
            path: String::new(),
        });
        let cwd = crate::plugin_cmds::resolve_plugin_owned_path(
            &app,
            &plugin_id,
            &runtime_instance_id,
            package_instance_id.as_deref(),
            &cwd_spec.namespace,
            &cwd_spec.path,
        )
        .map_err(|error| error.to_string())?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let process_id = format!(
            "proc-{stamp}-{}",
            self.next_process.fetch_add(1, Ordering::SeqCst)
        );
        let record = Arc::new(ProcessRecord {
            process_id: process_id.clone(),
            plugin_id,
            runtime_instance_id,
            executable_id,
            recipe: SpawnRecipe {
                executable,
                cwd,
                options,
            },
            child: Mutex::new(ManagedChild::empty()),
            stdin: Mutex::new(None),
            status: Mutex::new(ProcessStatus::Starting),
            pending: Mutex::new(HashMap::new()),
            stdout_line_buffer: Mutex::new(Vec::new()),
            logs: Mutex::new(VecDeque::new()),
            sequence: AtomicU64::new(0),
            restart_attempts: AtomicU32::new(0),
            stopping: AtomicBool::new(false),
        });
        self.processes
            .lock()
            .map_err(|_| "plugin process registry lock poisoned".to_string())?
            .insert(process_id, record.clone());
        if let Err(error) = launch(app.clone(), record.clone()) {
            *record
                .status
                .lock()
                .map_err(|_| "process status lock poisoned")? = ProcessStatus::Failed;
            emit_value(&app, &record, "spawn-error", json!({ "message": error }));
            return Err(error);
        }
        Ok(record.descriptor())
    }

    fn get(&self, process_id: &str) -> Result<Arc<ProcessRecord>, String> {
        self.processes
            .lock()
            .map_err(|_| "plugin process registry lock poisoned".to_string())?
            .get(process_id)
            .cloned()
            .ok_or_else(|| format!("plugin process not found: {process_id}"))
    }

    fn list(
        &self,
        runtime_instance_id: Option<&str>,
    ) -> Result<Vec<PluginProcessDescriptor>, String> {
        let mut result = self
            .processes
            .lock()
            .map_err(|_| "plugin process registry lock poisoned".to_string())?
            .values()
            .filter(|record| {
                runtime_instance_id
                    .map(|owner| record.runtime_instance_id == owner)
                    .unwrap_or(true)
            })
            .map(|record| record.descriptor())
            .collect::<Vec<_>>();
        result.sort_by(|left, right| left.process_id.cmp(&right.process_id));
        Ok(result)
    }

    fn logs(
        &self,
        process_id: &str,
        stream: Option<&str>,
        limit: usize,
    ) -> Result<Vec<PluginProcessEvent>, String> {
        if !matches!(stream, None | Some("stdout") | Some("stderr")) {
            return Err(format!(
                "invalid process log stream: {}",
                stream.unwrap_or_default()
            ));
        }
        let record = self.get(process_id)?;
        let logs = record
            .logs
            .lock()
            .map_err(|_| "plugin process logs lock poisoned".to_string())?;
        let limit = limit.clamp(1, 2_000);
        let mut result = logs
            .iter()
            .rev()
            .filter(|entry| stream.map(|value| entry.kind == value).unwrap_or(true))
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        result.reverse();
        Ok(result)
    }

    fn write(&self, process_id: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err(format!("process write exceeds {MAX_WRITE_BYTES} bytes"));
        }
        let record = self.get(process_id)?;
        let mut slot = record
            .stdin
            .lock()
            .map_err(|_| "plugin process stdin lock poisoned".to_string())?;
        let stdin = slot
            .as_mut()
            .ok_or_else(|| format!("plugin process stdin closed: {process_id}"))?;
        stdin.write_all(bytes).map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())
    }

    async fn request(
        &self,
        process_id: &str,
        method: String,
        params: Option<Value>,
        timeout_ms: u64,
        client_request_id: Option<String>,
    ) -> Result<Value, String> {
        let record = self.get(process_id)?;
        if record.recipe.options.protocol != ProcessProtocol::JsonRpc {
            return Err("request is only available for json-rpc processes".into());
        }
        if method.trim().is_empty() {
            return Err("json-rpc method is empty".into());
        }
        let request_id = client_request_id.unwrap_or_else(|| {
            format!(
                "{}:{}",
                process_id,
                self.next_request.fetch_add(1, Ordering::SeqCst)
            )
        });
        if request_id.is_empty() || request_id.len() > 256 {
            return Err("invalid json-rpc request id".into());
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = record
                .pending
                .lock()
                .map_err(|_| "json-rpc pending lock poisoned".to_string())?;
            if pending.contains_key(&request_id) {
                return Err(format!("duplicate json-rpc request id: {request_id}"));
            }
            pending.insert(request_id.clone(), PendingRequest { sender });
        }
        let message = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params.unwrap_or(Value::Null),
        });
        if let Err(error) = self.write_json_line(&record, &message) {
            record
                .pending
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&request_id));
            return Err(error);
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms.max(1)), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("json-rpc process exited before response".into()),
            Err(_) => {
                self.cancel(process_id, &request_id)?;
                Err(format!("json-rpc request timed out after {timeout_ms}ms"))
            }
        }
    }

    fn write_json_line(&self, record: &Arc<ProcessRecord>, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        self.write(&record.process_id, &bytes)
    }

    fn cancel(&self, process_id: &str, request_id: &str) -> Result<(), String> {
        let record = self.get(process_id)?;
        let removed = record
            .pending
            .lock()
            .map_err(|_| "json-rpc pending lock poisoned".to_string())?
            .remove(request_id);
        if let Some(pending) = removed {
            let _ = pending
                .sender
                .send(Err("json-rpc request cancelled".into()));
        }
        self.write_json_line(
            &record,
            &json!({
                "jsonrpc": "2.0",
                "method": "$/cancelRequest",
                "params": { "id": request_id }
            }),
        )
    }

    async fn terminate<R: tauri::Runtime>(
        &self,
        app: AppHandle<R>,
        process_id: &str,
    ) -> Result<(), String> {
        let record = self.get(process_id)?;
        record.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut status) = record.status.lock() {
            if matches!(*status, ProcessStatus::Exited | ProcessStatus::Failed) {
                return Ok(());
            }
            *status = ProcessStatus::Stopping;
        }
        emit_value(&app, &record, "status", json!({ "status": "stopping" }));
        let shutdown = &record.recipe.options.shutdown;
        match shutdown.method {
            ShutdownMethod::Stdin => {
                if let Ok(mut stdin) = record.stdin.lock() {
                    stdin.take();
                }
            }
            ShutdownMethod::Signal => {
                #[cfg(unix)]
                if let Some(pid) = record.child.lock().ok().and_then(|child| child.pid()) {
                    let _ = Command::new("kill")
                        .args(["-TERM", &pid.to_string()])
                        .status();
                }
                #[cfg(windows)]
                if let Ok(mut stdin) = record.stdin.lock() {
                    // Windows has no safe per-child POSIX signal for an
                    // arbitrary GUI parent console. EOF is the graceful
                    // signal; timeout still closes the Job Object.
                    stdin.take();
                }
            }
            ShutdownMethod::JsonRpc => {
                let _ = self
                    .write_json_line(&record, &json!({ "jsonrpc": "2.0", "method": "shutdown" }));
            }
            ShutdownMethod::Kill => return self.kill(&app, process_id),
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(shutdown.timeout_ms);
        while tokio::time::Instant::now() < deadline {
            let status = record
                .status
                .lock()
                .map(|value| *value)
                .unwrap_or(ProcessStatus::Failed);
            if matches!(status, ProcessStatus::Exited | ProcessStatus::Failed) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.kill(&app, process_id)
    }

    fn kill<R: tauri::Runtime>(&self, app: &AppHandle<R>, process_id: &str) -> Result<(), String> {
        let record = self.get(process_id)?;
        record.stopping.store(true, Ordering::SeqCst);
        record.stdin.lock().ok().and_then(|mut stdin| stdin.take());
        let result = record
            .child
            .lock()
            .map_err(|_| "plugin process child lock poisoned".to_string())?
            .kill_and_wait()
            .map_err(|error| error.to_string());
        finish_record(app, &record, None, "killed");
        result
    }
}

fn validate_options(options: &PluginProcessOptions) -> Result<(), String> {
    if options.args.len() > 256 {
        return Err("plugin process args exceeds 256 entries".into());
    }
    if options
        .args
        .iter()
        .any(|value| value.contains('\0') || value.len() > 32 * 1024)
    {
        return Err("plugin process contains invalid argument".into());
    }
    if options.env.len() > 256
        || options.env.iter().any(|(key, value)| {
            key.is_empty()
                || key.contains(['=', '\0'])
                || value.contains('\0')
                || key.len() > 1024
                || value.len() > 32 * 1024
        })
    {
        return Err("plugin process contains invalid environment".into());
    }
    Ok(())
}

fn command_for(record: &ProcessRecord) -> Command {
    #[cfg(windows)]
    let mut command = {
        let executable = windows_process_path(&record.recipe.executable);
        let is_script = record
            .recipe
            .executable
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        if is_script {
            let mut command =
                Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
            // `call` makes cmd parse the following path as a batch target even
            // when CreateProcess quoting has wrapped the absolute path.
            command.args(["/D", "/S", "/C", "call"]).arg(executable);
            command
        } else {
            Command::new(executable)
        }
    };
    #[cfg(not(windows))]
    let mut command = Command::new(&record.recipe.executable);
    command
        .args(&record.recipe.options.args)
        .current_dir({
            #[cfg(windows)]
            {
                windows_process_path(&record.recipe.cwd)
            }
            #[cfg(not(windows))]
            {
                record.recipe.cwd.clone()
            }
        })
        .envs(&record.recipe.options.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[cfg(windows)]
fn windows_process_path(path: &std::path::Path) -> std::path::PathBuf {
    // canonicalize() returns verbatim `\\?\` paths. cmd.exe cannot execute a
    // batch target with that prefix, so remove only the transport prefix after
    // containment has already been proven on the canonical path.
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}").into();
    }
    value
        .strip_prefix(r"\\?\")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

fn launch<R: tauri::Runtime>(app: AppHandle<R>, record: Arc<ProcessRecord>) -> Result<(), String> {
    let mut child = command_for(&record).spawn().map_err(|error| {
        format!(
            "spawn {} failed: {error}",
            record.recipe.executable.display()
        )
    })?;
    let stdin = child.stdin.take().ok_or("spawned process has no stdin")?;
    let stdout = child.stdout.take().ok_or("spawned process has no stdout")?;
    let stderr = child.stderr.take().ok_or("spawned process has no stderr")?;
    {
        *record
            .stdin
            .lock()
            .map_err(|_| "process stdin lock poisoned")? = Some(stdin);
        *record
            .child
            .lock()
            .map_err(|_| "process child lock poisoned")? = ManagedChild::new(child);
        *record
            .status
            .lock()
            .map_err(|_| "process status lock poisoned")? = ProcessStatus::Running;
    }
    emit_value(
        &app,
        &record,
        "status",
        json!({ "status": "running", "pid": record.descriptor().pid }),
    );
    spawn_reader(app.clone(), record.clone(), stdout, true);
    spawn_reader(app.clone(), record.clone(), stderr, false);
    spawn_monitor(app, record);
    Ok(())
}

fn spawn_reader<R: tauri::Runtime, T: Read + Send + 'static>(
    app: AppHandle<R>,
    record: Arc<ProcessRecord>,
    mut reader: T,
    stdout: bool,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let chunk = &buffer[..length];
                    emit_bytes(
                        &app,
                        &record,
                        if stdout { "stdout" } else { "stderr" },
                        chunk,
                    );
                    if stdout
                        && matches!(
                            record.recipe.options.protocol,
                            ProcessProtocol::Lines
                                | ProcessProtocol::JsonLines
                                | ProcessProtocol::JsonRpc
                        )
                    {
                        process_stdout_lines(&app, &record, chunk);
                    }
                }
                Err(error) => {
                    emit_value(
                        &app,
                        &record,
                        "stream-error",
                        json!({
                            "stream": if stdout { "stdout" } else { "stderr" },
                            "message": error.to_string(),
                        }),
                    );
                    break;
                }
            }
        }
    });
}

fn process_stdout_lines<R: tauri::Runtime>(
    app: &AppHandle<R>,
    record: &Arc<ProcessRecord>,
    bytes: &[u8],
) {
    let Ok(mut buffer) = record.stdout_line_buffer.lock() else {
        return;
    };
    buffer.extend_from_slice(bytes);
    if buffer.len() > MAX_LINE_BYTES {
        buffer.clear();
        emit_value(
            app,
            record,
            "protocol-error",
            json!({ "message": "stdout line exceeds 16 MiB" }),
        );
        return;
    }
    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut line = buffer.drain(..=index).collect::<Vec<_>>();
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        if record.recipe.options.protocol == ProcessProtocol::Lines {
            emit_value(
                app,
                record,
                "line",
                json!({ "text": String::from_utf8_lossy(&line) }),
            );
            continue;
        }
        match serde_json::from_slice::<Value>(&line) {
            Ok(value) => {
                if record.recipe.options.protocol == ProcessProtocol::JsonRpc {
                    route_json_rpc(app, record, value);
                } else {
                    emit_value(app, record, "json-line", value);
                }
            }
            Err(error) => emit_value(
                app,
                record,
                "protocol-error",
                json!({ "message": error.to_string() }),
            ),
        }
    }
}

fn route_json_rpc<R: tauri::Runtime>(
    app: &AppHandle<R>,
    record: &Arc<ProcessRecord>,
    value: Value,
) {
    if let Some(id) = value.get("id").and_then(json_rpc_id) {
        let pending = record
            .pending
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&id));
        if let Some(pending) = pending {
            let result = if let Some(error) = value.get("error") {
                Err(format!("json-rpc error: {error}"))
            } else {
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = pending.sender.send(result);
            return;
        }
    }
    emit_value(app, record, "json-rpc", value);
}

fn json_rpc_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn spawn_monitor<R: tauri::Runtime>(app: AppHandle<R>, record: Arc<ProcessRecord>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(20));
        let status = match record.child.lock() {
            Ok(mut child) if child.has_child() => child.try_wait(),
            Ok(_) => return,
            Err(_) => {
                finish_record(&app, &record, None, "child-lock-poisoned");
                return;
            }
        };
        match status {
            Ok(None) => continue,
            Ok(Some(exit)) => {
                let code = exit.code();
                let should_restart = !record.stopping.load(Ordering::SeqCst)
                    && match record.recipe.options.restart.policy {
                        RestartPolicy::Never => false,
                        RestartPolicy::Always => true,
                        RestartPolicy::OnFailure => !exit.success(),
                    };
                let attempt = record.restart_attempts.load(Ordering::SeqCst);
                if should_restart && attempt < record.recipe.options.restart.max_attempts {
                    let next = record.restart_attempts.fetch_add(1, Ordering::SeqCst) + 1;
                    if let Ok(mut status) = record.status.lock() {
                        *status = ProcessStatus::Starting;
                    }
                    settle_pending(&record, "plugin process restarting");
                    emit_value(
                        &app,
                        &record,
                        "restart",
                        json!({ "attempt": next, "exitCode": code }),
                    );
                    std::thread::sleep(Duration::from_millis(
                        record
                            .recipe
                            .options
                            .restart
                            .backoff_ms
                            .saturating_mul(next as u64),
                    ));
                    if let Err(error) = launch(app.clone(), record.clone()) {
                        finish_record(&app, &record, None, &error);
                    }
                    return;
                }
                finish_record(&app, &record, code, "exited");
                return;
            }
            Err(error) => {
                finish_record(&app, &record, None, &error.to_string());
                return;
            }
        }
    });
}

fn settle_pending(record: &ProcessRecord, reason: &str) {
    let pending = record
        .pending
        .lock()
        .map(|mut map| map.drain().map(|(_, pending)| pending).collect::<Vec<_>>())
        .unwrap_or_default();
    for request in pending {
        let _ = request.sender.send(Err(reason.to_string()));
    }
}

fn finish_record<R: tauri::Runtime>(
    app: &AppHandle<R>,
    record: &Arc<ProcessRecord>,
    exit_code: Option<i32>,
    reason: &str,
) {
    if let Ok(mut status) = record.status.lock() {
        *status = if exit_code.is_some() || reason == "killed" {
            ProcessStatus::Exited
        } else {
            ProcessStatus::Failed
        };
    }
    if let Ok(mut stdin) = record.stdin.lock() {
        stdin.take();
    }
    settle_pending(record, &format!("plugin process stopped: {reason}"));
    emit_value(
        app,
        record,
        "exit",
        json!({ "exitCode": exit_code, "reason": reason }),
    );
}

fn emit_bytes<R: tauri::Runtime>(
    app: &AppHandle<R>,
    record: &Arc<ProcessRecord>,
    kind: &str,
    bytes: &[u8],
) {
    let payload = PluginProcessEvent {
        process_id: record.process_id.clone(),
        plugin_id: record.plugin_id.clone(),
        runtime_instance_id: record.runtime_instance_id.clone(),
        sequence: record.sequence.fetch_add(1, Ordering::SeqCst) + 1,
        kind: kind.to_string(),
        data_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        value: None,
    };
    if let Ok(mut logs) = record.logs.lock() {
        logs.push_back(payload.clone());
        while logs.len() > 2_000 {
            logs.pop_front();
        }
    }
    let _ = app.emit(crate::event_names::PLUGIN_PROCESS, payload);
}

fn emit_value<R: tauri::Runtime>(
    app: &AppHandle<R>,
    record: &Arc<ProcessRecord>,
    kind: &str,
    value: Value,
) {
    let payload = PluginProcessEvent {
        process_id: record.process_id.clone(),
        plugin_id: record.plugin_id.clone(),
        runtime_instance_id: record.runtime_instance_id.clone(),
        sequence: record.sequence.fetch_add(1, Ordering::SeqCst) + 1,
        kind: kind.to_string(),
        data_base64: None,
        value: Some(value),
    };
    let _ = app.emit(crate::event_names::PLUGIN_PROCESS, payload);
}

#[tauri::command]
pub(crate) async fn plugin_process_spawn(
    app: AppHandle,
    plugin_id: String,
    runtime_instance_id: String,
    package_instance_id: Option<String>,
    executable_id: String,
    options: Option<PluginProcessOptions>,
) -> Result<PluginProcessDescriptor, String> {
    app.state::<crate::AppState>().plugin_processes.spawn(
        app.clone(),
        plugin_id,
        runtime_instance_id,
        package_instance_id,
        executable_id,
        options.unwrap_or_default(),
    )
}

#[tauri::command]
pub(crate) async fn plugin_process_list(
    app: AppHandle,
    runtime_instance_id: Option<String>,
) -> Result<Vec<PluginProcessDescriptor>, String> {
    app.state::<crate::AppState>()
        .plugin_processes
        .list(runtime_instance_id.as_deref())
}

#[tauri::command]
pub(crate) async fn plugin_process_logs(
    app: AppHandle,
    process_id: String,
    stream: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<PluginProcessEvent>, String> {
    app.state::<crate::AppState>().plugin_processes.logs(
        &process_id,
        stream.as_deref(),
        limit.unwrap_or(200),
    )
}

#[tauri::command]
pub(crate) async fn plugin_process_write(
    app: AppHandle,
    process_id: String,
    data_base64: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("invalid process write base64: {error}"))?;
    app.state::<crate::AppState>()
        .plugin_processes
        .write(&process_id, &bytes)
}

#[tauri::command]
pub(crate) async fn plugin_process_request(
    app: AppHandle,
    process_id: String,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
    request_id: Option<String>,
) -> Result<Value, String> {
    app.state::<crate::AppState>()
        .plugin_processes
        .request(
            &process_id,
            method,
            params,
            timeout_ms.unwrap_or(30_000),
            request_id,
        )
        .await
}

#[tauri::command]
pub(crate) async fn plugin_process_cancel(
    app: AppHandle,
    process_id: String,
    request_id: String,
) -> Result<(), String> {
    app.state::<crate::AppState>()
        .plugin_processes
        .cancel(&process_id, &request_id)
}

#[tauri::command]
pub(crate) async fn plugin_process_terminate(
    app: AppHandle,
    process_id: String,
) -> Result<(), String> {
    app.state::<crate::AppState>()
        .plugin_processes
        .terminate(app.clone(), &process_id)
        .await
}

#[tauri::command]
pub(crate) async fn plugin_process_kill(app: AppHandle, process_id: String) -> Result<(), String> {
    app.state::<crate::AppState>()
        .plugin_processes
        .kill(&app, &process_id)
}

use tauri::Manager;

#[cfg(test)]
mod tests;
