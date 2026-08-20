//! Pylon CLI client — standalone named-pipe/Unix-socket client.
//!
//! Extracted from the Tauri main library so `pylon-cli` and other standalone
//! binaries do not link the whole GUI stack. Contains only the wire framing,
//! protocol constants and the `invoke_running_kernel` client entry point.

use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

pub const PROTOCOL_VERSION: u64 = 1;
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TIMEOUT_MS: u64 = 300_000;
pub const MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;

#[cfg(windows)]
pub const WINDOWS_PIPE_NAME: &str = r"\\.\pipe\com.prism.desktop.pylon";

#[cfg(unix)]
pub fn unix_socket_path() -> std::path::PathBuf {
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR").filter(|value| !value.is_empty()) {
        return std::path::PathBuf::from(runtime).join("pylon.sock");
    }
    let uid = unsafe { libc::geteuid() };
    std::path::PathBuf::from(format!("/tmp/pylon-{uid}.sock"))
}

pub(crate) async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> Result<(), String> {
    let mut frame = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    frame.push(b'\n');
    writer
        .write_all(&frame)
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())
}

pub(crate) async fn read_frame<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<Value, String> {
    let mut frame = Vec::new();
    let read = reader
        .take(MAX_FRAME_BYTES + 1)
        .read_until(b'\n', &mut frame)
        .await
        .map_err(|error| error.to_string())?;
    if read == 0 {
        return Err("Pylon CLI connection closed".into());
    }
    if frame.len() as u64 > MAX_FRAME_BYTES {
        return Err("Pylon CLI response exceeds 16 MiB".into());
    }
    serde_json::from_slice(&frame).map_err(|error| error.to_string())
}

/// Connect to a running Pylon kernel and execute one CLI command.
pub async fn invoke_running_kernel(
    command: String,
    args: Value,
    timeout_ms: u64,
    client_type: &str,
) -> Result<Value, String> {
    #[cfg(windows)]
    let stream = {
        use tokio::net::windows::named_pipe::ClientOptions;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            match ClientOptions::new().open(WINDOWS_PIPE_NAME) {
                Ok(client) => break client,
                Err(error) if tokio::time::Instant::now() < deadline => {
                    let _ = error;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => return Err(format!("connect {WINDOWS_PIPE_NAME} failed: {error}")),
            }
        }
    };
    #[cfg(unix)]
    let stream = tokio::net::UnixStream::connect(unix_socket_path())
        .await
        .map_err(|error| error.to_string())?;

    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    write_frame(
        &mut writer,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pylon.handshake",
            "params": { "protocolVersion": PROTOCOL_VERSION, "clientType": client_type }
        }),
    )
    .await?;
    let handshake = read_frame(&mut reader).await?;
    if let Some(error) = handshake.get("error") {
        return Err(format!("Pylon CLI handshake failed: {error}"));
    }
    write_frame(
        &mut writer,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "pylon.execute",
            "params": {
                "command": command,
                "args": args,
                "timeoutMs": timeout_ms.clamp(1, MAX_TIMEOUT_MS),
            }
        }),
    )
    .await?;
    let response = read_frame(&mut reader).await?;
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Pylon CLI error")
            .to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_match_decision() {
        assert_eq!(MAX_FRAME_BYTES, 16 * 1024 * 1024);
        assert_eq!(DEFAULT_TIMEOUT_MS, 30_000);
        assert_eq!(MAX_TIMEOUT_MS, 300_000);
    }

    #[tokio::test]
    async fn client_framing_rejects_oversized_response() {
        let bytes = vec![b'x'; MAX_FRAME_BYTES as usize + 1];
        let mut reader = BufReader::new(bytes.as_slice());
        assert!(read_frame(&mut reader)
            .await
            .unwrap_err()
            .contains("16 MiB"));
    }
}
