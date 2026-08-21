pub use pylon_core::cli_client::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliFrontendRequest {
    request_id: String,
    command: String,
    #[serde(default)]
    args: Value,
    timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliFrontendCancel {
    request_id: String,
}

pub(crate) struct PylonCliBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    next_request: AtomicU64,
    started: AtomicBool,
}

impl Default for PylonCliBridge {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(1),
            started: AtomicBool::new(false),
        }
    }
}

impl PylonCliBridge {
    fn next_request_id(&self) -> String {
        format!(
            "cli-{}-{}",
            std::process::id(),
            self.next_request.fetch_add(1, Ordering::SeqCst)
        )
    }

    async fn dispatch(
        &self,
        app: &AppHandle,
        request: CliFrontendRequest,
    ) -> Result<Value, String> {
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Pylon CLI pending lock poisoned".to_string())?
            .insert(request.request_id.clone(), sender);
        if let Err(error) = app.emit(crate::event_names::PYLON_CLI_REQUEST, request.clone()) {
            self.pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&request.request_id));
            return Err(format!("emit CLI request failed: {error}"));
        }
        let timeout_ms = request.timeout_ms.clamp(1, MAX_TIMEOUT_MS);
        match tokio::time::timeout(Duration::from_millis(timeout_ms), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Pylon CLI frontend response channel closed".into()),
            Err(_) => {
                self.cancel(app, &request.request_id, "request timed out");
                Err(format!("Pylon CLI request timed out after {timeout_ms}ms"))
            }
        }
    }

    fn respond(&self, request_id: &str, result: Result<Value, String>) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "Pylon CLI pending lock poisoned".to_string())?
            .remove(request_id)
            .ok_or_else(|| format!("Pylon CLI request not pending: {request_id}"))?;
        sender
            .send(result)
            .map_err(|_| format!("Pylon CLI response receiver closed: {request_id}"))
    }

    fn cancel(&self, app: &AppHandle, request_id: &str, reason: &str) -> bool {
        let pending = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(request_id));
        if let Some(pending) = pending {
            let _ = app.emit(
                crate::event_names::PYLON_CLI_CANCEL,
                CliFrontendCancel {
                    request_id: request_id.to_string(),
                },
            );
            let _ = pending.send(Err(reason.to_string()));
            true
        } else {
            false
        }
    }

    fn start(self: &Arc<Self>, app: AppHandle) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let bridge = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_server(app, bridge).await {
                tracing::error!("Pylon CLI server stopped: {error}");
            }
        });
    }
}

#[tauri::command]
pub(crate) async fn pylon_cli_ready(app: AppHandle) -> Result<(), String> {
    let bridge = app.state::<crate::AppState>().pylon_cli.clone();
    bridge.start(app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn pylon_cli_respond(
    app: AppHandle,
    request_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let response = match error {
        Some(error) => Err(error),
        None => Ok(result.unwrap_or(Value::Null)),
    };
    app.state::<crate::AppState>()
        .pylon_cli
        .respond(&request_id, response)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeCaptureResult {
    artifact_ref: String,
    mime: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub(crate) async fn pylon_window_capture(
    app: AppHandle,
    artifact_path: String,
    format: Option<String>,
) -> Result<NativeCaptureResult, String> {
    let format = format.unwrap_or_else(|| "png".into());
    if !matches!(format.as_str(), "png" | "webp") {
        return Err(format!("unsupported capture format: {format}"));
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let path = std::path::PathBuf::from(&artifact_path);
    let (pixels, width, height) =
        capture_window_pixels(position.x, position.y, size.width, size.height)?;
    let image_format = if format == "webp" {
        image::ImageFormat::WebP
    } else {
        image::ImageFormat::Png
    };
    image::save_buffer_with_format(
        &path,
        &pixels,
        width,
        height,
        image::ColorType::Rgba8,
        image_format,
    )
    .map_err(|error| format!("write capture failed: {error}"))?;
    Ok(NativeCaptureResult {
        artifact_ref: path.to_string_lossy().to_string(),
        mime: if format == "webp" {
            "image/webp"
        } else {
            "image/png"
        }
        .into(),
        width,
        height,
    })
}

#[cfg(windows)]
fn capture_window_pixels(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err(format!("invalid capture size: {width}x{height}"));
    }
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("GetDC failed".into());
        }
        let memory = CreateCompatibleDC(screen);
        if memory.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("CreateCompatibleDC failed".into());
        }
        let bitmap = CreateCompatibleBitmap(screen, width as i32, height as i32);
        if bitmap.is_null() {
            DeleteDC(memory);
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("CreateCompatibleBitmap failed".into());
        }
        let previous = SelectObject(memory, bitmap);
        let copied = BitBlt(
            memory,
            0,
            0,
            width as i32,
            height as i32,
            screen,
            x,
            y,
            SRCCOPY | CAPTUREBLT,
        );
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let rows = if copied != 0 {
            GetDIBits(
                memory,
                bitmap,
                0,
                height,
                pixels.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);
        if copied == 0 || rows != height as i32 {
            return Err("BitBlt/GetDIBits capture failed".into());
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok((pixels, width, height))
    }
}

#[cfg(not(windows))]
fn capture_window_pixels(
    _x: i32,
    _y: i32,
    _width: u32,
    _height: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    Err("native window capture is not implemented on this platform".into())
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

fn rpc_id_key(id: &Value) -> Option<String> {
    match id {
        Value::String(value) => Some(format!("s:{value}")),
        Value::Number(value) => Some(format!("n:{value}")),
        _ => None,
    }
}

async fn run_connection<S>(
    stream: S,
    app: AppHandle,
    bridge: Arc<PylonCliBridge>,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    let (outgoing, mut responses) = mpsc::unbounded_channel::<Value>();
    let writer_task = tokio::spawn(async move {
        while let Some(value) = responses.recv().await {
            let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
            writer
                .write_all(&bytes)
                .await
                .map_err(|error| error.to_string())?;
            writer.flush().await.map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    });
    let requests = Arc::new(Mutex::new(HashMap::<String, String>::new()));
    let mut handshaken = false;
    loop {
        let mut frame = Vec::new();
        let read = (&mut reader)
            .take(MAX_FRAME_BYTES + 1)
            .read_until(b'\n', &mut frame)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        if frame.len() as u64 > MAX_FRAME_BYTES {
            let _ = outgoing.send(rpc_error(Value::Null, -32600, "frame exceeds 16 MiB"));
            break;
        }
        while matches!(frame.last(), Some(b'\n' | b'\r')) {
            frame.pop();
        }
        let request = match serde_json::from_slice::<JsonRpcRequest>(&frame) {
            Ok(request) if request.jsonrpc == "2.0" => request,
            Ok(_) => {
                let _ = outgoing.send(rpc_error(Value::Null, -32600, "jsonrpc must be 2.0"));
                continue;
            }
            Err(error) => {
                let _ = outgoing.send(rpc_error(Value::Null, -32700, error.to_string()));
                continue;
            }
        };
        let id = request.id.clone().unwrap_or(Value::Null);
        if !handshaken {
            if request.method != "pylon.handshake" {
                let _ = outgoing.send(rpc_error(id, -32001, "pylon.handshake required"));
                continue;
            }
            let protocol = request
                .params
                .get("protocolVersion")
                .and_then(Value::as_u64);
            let client_type = request.params.get("clientType").and_then(Value::as_str);
            if protocol != Some(PROTOCOL_VERSION)
                || !matches!(client_type, Some("cli" | "agent-tool"))
            {
                let _ = outgoing.send(rpc_error(id, -32002, "unsupported handshake"));
                continue;
            }
            handshaken = true;
            let _ = outgoing.send(rpc_result(
                id,
                json!({
                    "kernelVersion": env!("CARGO_PKG_VERSION"),
                    "protocolVersion": PROTOCOL_VERSION,
                }),
            ));
            continue;
        }
        match request.method.as_str() {
            "pylon.execute" => {
                let Some(key) = request.id.as_ref().and_then(rpc_id_key) else {
                    let _ = outgoing.send(rpc_error(
                        id,
                        -32600,
                        "pylon.execute requires string/number id",
                    ));
                    continue;
                };
                let Some(command) = request.params.get("command").and_then(Value::as_str) else {
                    let _ = outgoing.send(rpc_error(id, -32602, "command is required"));
                    continue;
                };
                let timeout_ms = request
                    .params
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(DEFAULT_TIMEOUT_MS)
                    .clamp(1, MAX_TIMEOUT_MS);
                let frontend_id = bridge.next_request_id();
                requests
                    .lock()
                    .ok()
                    .map(|mut map| map.insert(key.clone(), frontend_id.clone()));
                let frontend = CliFrontendRequest {
                    request_id: frontend_id,
                    command: command.to_string(),
                    args: request
                        .params
                        .get("args")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                    timeout_ms,
                };
                let outgoing = outgoing.clone();
                let requests = requests.clone();
                let app = app.clone();
                let bridge = bridge.clone();
                tokio::spawn(async move {
                    let response = match bridge.dispatch(&app, frontend).await {
                        Ok(result) => rpc_result(id, result),
                        Err(error) => rpc_error(id, -32010, error),
                    };
                    requests.lock().ok().and_then(|mut map| map.remove(&key));
                    let _ = outgoing.send(response);
                });
            }
            "pylon.cancel" => {
                let cancel_id = request.params.get("id").and_then(rpc_id_key);
                let frontend_id = cancel_id
                    .as_ref()
                    .and_then(|key| requests.lock().ok().and_then(|map| map.get(key).cloned()));
                let cancelled = frontend_id
                    .as_deref()
                    .map(|request_id| bridge.cancel(&app, request_id, "request cancelled"))
                    .unwrap_or(false);
                if request.id.is_some() {
                    let _ = outgoing.send(rpc_result(id, json!({ "cancelled": cancelled })));
                }
            }
            _ => {
                if request.id.is_some() {
                    let _ = outgoing.send(rpc_error(id, -32601, "method not found"));
                }
            }
        }
    }
    drop(outgoing);
    writer_task.await.map_err(|error| error.to_string())?
}

#[cfg(windows)]
async fn run_server(app: AppHandle, bridge: Arc<PylonCliBridge>) -> Result<(), String> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut first = true;
    loop {
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .reject_remote_clients(true);
        let server = options
            .create(WINDOWS_PIPE_NAME)
            .map_err(|error| error.to_string())?;
        first = false;
        server.connect().await.map_err(|error| error.to_string())?;
        if !windows_client_is_current_user(&server) {
            tracing::warn!("Pylon CLI rejected named-pipe client owned by another user");
            continue;
        }
        let app = app.clone();
        let bridge = bridge.clone();
        tokio::spawn(async move {
            if let Err(error) = run_connection(server, app, bridge).await {
                tracing::warn!("Pylon CLI connection failed: {error}");
            }
        });
    }
}

#[cfg(windows)]
fn windows_client_is_current_user(
    server: &tokio::net::windows::named_pipe::NamedPipeServer,
) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe fn token_user_buffer(process: HANDLE) -> Option<(HANDLE, Vec<usize>)> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let mut length = 0u32;
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut length) };
        if length == 0 {
            unsafe { CloseHandle(token) };
            return None;
        }
        let words = (length as usize).div_ceil(std::mem::size_of::<usize>());
        let mut buffer = vec![0usize; words];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        } == 0
        {
            unsafe { CloseHandle(token) };
            return None;
        }
        Some((token, buffer))
    }

    unsafe {
        let mut client_pid = 0u32;
        if GetNamedPipeClientProcessId(server.as_raw_handle() as HANDLE, &mut client_pid) == 0 {
            return false;
        }
        let client = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, client_pid);
        if client.is_null() {
            return false;
        }
        let current_token = token_user_buffer(GetCurrentProcess());
        let client_token = token_user_buffer(client);
        let same = match (&current_token, &client_token) {
            (Some((_, current)), Some((_, candidate))) => {
                let current = &*(current.as_ptr() as *const TOKEN_USER);
                let candidate = &*(candidate.as_ptr() as *const TOKEN_USER);
                EqualSid(current.User.Sid, candidate.User.Sid) != 0
            }
            _ => false,
        };
        if let Some((token, _)) = current_token {
            CloseHandle(token);
        }
        if let Some((token, _)) = client_token {
            CloseHandle(token);
        }
        CloseHandle(client);
        same
    }
}

#[cfg(unix)]
async fn run_server(app: AppHandle, bridge: Arc<PylonCliBridge>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let path = unix_socket_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    let listener = tokio::net::UnixListener::bind(&path).map_err(|error| error.to_string())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    loop {
        let (stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
        let app = app.clone();
        let bridge = bridge.clone();
        tokio::spawn(async move {
            if let Err(error) = run_connection(stream, app, bridge).await {
                tracing::warn!("Pylon CLI connection failed: {error}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_ids_are_typed_and_limits_match_decision() {
        assert_eq!(rpc_id_key(&json!(1)).as_deref(), Some("n:1"));
        assert_eq!(rpc_id_key(&json!("1")).as_deref(), Some("s:1"));
        assert_eq!(MAX_FRAME_BYTES, 16 * 1024 * 1024);
        assert_eq!(DEFAULT_TIMEOUT_MS, 30_000);
    }

    #[test]
    fn native_capture_rejects_invalid_dimensions_before_platform_io() {
        assert!(capture_window_pixels(0, 0, 0, 100).is_err());
        assert!(capture_window_pixels(0, 0, 100, 0).is_err());
    }
}
