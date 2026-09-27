//! ACP 子进程管理（R9/P3-1 拆分自 acp.rs；行为零变化）。
//!
//! `ManagedChild`：子进程 + Windows Job Object 进程树清理。spawn 后立即把子进程
//! 挂进 `KILL_ON_JOB_CLOSE` job（句柄关闭即终止整棵进程树，成员资格自动继承给
//! 后续派生进程）；job 创建/挂接失败回退 `taskkill /T /F`，再回退 `Child::kill`。
//! `Drop` 兜底 `kill_and_wait`，保证任何错误路径不遗留进程树。

use std::process::Child;
use std::time::Duration;

use super::AcpError;

/// #348 A3：Windows spawn 统一收口——隐藏子进程控制台窗口（CREATE_NO_WINDOW）。
///
/// pylon-acp 内所有生产 spawn（agent 本体、taskkill 兜底、agent 侧 terminal
/// shell）都必须经本函数，避免只在一处补、其余路径在用户桌面闪窗。
/// 非 Windows 为 no-op。
///
/// 实现委托 [`pylon_foundations::child_command::HideConsoleWindow`]：#361 改发行
/// 构建为 GUI 子系统后，闪窗问题**不限于 pylon-acp**（git / reg.exe / npm 探针 /
/// 插件进程同样会弹黑框），单一实现放地基 crate 才能全仓收口。
pub(crate) fn hide_console_window(command: &mut std::process::Command) {
    use pylon_foundations::child_command::HideConsoleWindow;
    command.hide_console_window();
}

/// #363-1：给 agent 侧子进程钉死 UTF-8 输出环境。
///
/// 四项与 Codeg `process.rs:56-63` 一致：Python 两件（`PYTHONUTF8` 让 Python 的
/// stdio 走 UTF-8 而不看系统代码页；`PYTHONIOENCODING` 兜住更老的解释器）与 POSIX
/// locale 两件（`LANG`/`LC_ALL` = `C.UTF-8`，被 git、coreutils、MSYS2/Git-for-Windows
/// 尊重）。没有这一层时，非英文 locale 的宿主机上 agent 及其派生的 git/node/python
/// 会输出本地化文本，`stderr.rs` 的英文标记分级与错误子串匹配**静默失效**。
///
/// 与 `pylon-foundations::git` 的 `LC_ALL=C` 不矛盾：`C.UTF-8` 仍是英语 locale
/// （沿 `C` 语义），只是码集固定为 UTF-8；git 那处是给 git 单独钉英语以便子串匹配，
/// 两边目标一致、取值相容。git 路径**不调本函数**，以免覆盖它自己的钉法。
///
/// 用 `.env()` 逐个覆盖（而非 `env_clear`）：其余环境照常继承，只把这几项钉死。
/// 调用点把它们放在 `apply_launch_plan` **之前**，于是用户在 agents.yaml 里显式写的
/// 同名 env 仍然赢——这里是默认值，不是不可覆盖的强制值。
pub(crate) fn set_utf8_env(command: &mut std::process::Command) {
    command
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8");
}

/// agent 侧子进程的统一启动收口：隐藏控制台窗口 + UTF-8 环境。
///
/// 两个关注点各自独立（`hide_console_window` 还要给 taskkill 这类不经本函数的
/// spawn 用），这里只是把「agent 子进程」这一类调用点的两件一次做齐。
pub(crate) fn configure_agent_child(command: &mut std::process::Command) {
    set_utf8_env(command);
    hide_console_window(command);
}

/// #363-2：`ETXTBSY` 重试预算（1 秒）与退避上限（25 ms）。
///
/// 要覆盖的窗口是**另一个线程的 fork→exec 间隙**：Rust 以 `O_CLOEXEC` 打开文件，
/// 但 CLOEXEC 只在 exec 时生效；另一线程 `fork()` 会复制 fd 表，此时写 fd 仍然开着，
/// 于是这个窗口内 exec 同一文件会拿到 `ETXTBSY`。窗口自闭合（微秒级，机器繁忙时变宽），
/// 所以正确的处置是**在预算内重试**，而不是把这类瞬时失败当成结论。
const EXEC_BUSY_RETRY_BUDGET: Duration = Duration::from_secs(1);
const EXEC_BUSY_MAX_BACKOFF: Duration = Duration::from_millis(25);

/// Unix 的 `ETXTBSY`。写常量而不引 `libc`：本 crate 不为一个 errno 新增依赖；
/// 值来自 Linux/glibc 的 `include/uapi/asm-generic/errno.h`（26）。判定同时看
/// `ErrorKind`，所以即使某平台的 std 把它映到别的 code，主路径仍然命中。
#[cfg(unix)]
const ETXTBSY: i32 = 26;

/// 这个 `io::Error` 是否表示「可执行文件被写者占住」。
fn is_exec_busy(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::ExecutableFileBusy {
        return true;
    }
    #[cfg(unix)]
    {
        if error.raw_os_error() == Some(ETXTBSY) {
            return true;
        }
    }
    false
}

/// 在预算内对 `ETXTBSY` 做指数退避重试；**非 busy 错误一次都不重试**。
///
/// 「非 busy 不重试」不是省事：`NotFound` / `InvalidFilename` 是调用方决定回退路径的
/// 依据（`.cmd`/`.bat` 的 shell 绕行，见 #353），把它们也塞进重试只会让调用方自己的
/// 兜底迟到一秒。预算耗尽时返回**原始** `io::Error`，不重新归类。
pub(crate) async fn spawn_retrying_exec_busy<T, F>(attempt: F) -> std::io::Result<T>
where
    F: FnMut() -> std::io::Result<T>,
{
    spawn_retrying_exec_busy_within(EXEC_BUSY_RETRY_BUDGET, attempt).await
}

async fn spawn_retrying_exec_busy_within<T, F>(
    budget: Duration,
    mut attempt: F,
) -> std::io::Result<T>
where
    F: FnMut() -> std::io::Result<T>,
{
    // `tokio::time::Instant` 而非 `std::time::Instant`：暂停时钟的测试推进 deadline
    // 时必须同时推进 sleep。
    let deadline = tokio::time::Instant::now() + budget;
    let mut backoff = Duration::from_millis(1);
    loop {
        match attempt() {
            Err(error) if is_exec_busy(&error) => {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    return Err(error);
                }
                tokio::time::sleep(backoff.min(deadline - now)).await;
                backoff = (backoff * 2).min(EXEC_BUSY_MAX_BACKOFF);
            }
            outcome => return outcome,
        }
    }
}

/// Windows：内核级进程树清理句柄。关闭句柄即终止 job 内全部进程（含子进程
/// 后续派生的整棵进程树，成员资格自动继承）。
#[cfg(windows)]
struct JobObject {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

// HANDLE 是内核对象句柄（数字 token），跨线程移动/共享安全；裸指针本身非
// Send/Sync，显式标记（CloseHandle 线程安全，AcpClient 需保持 Send/Sync 供
// tokio::spawn 使用）。
#[cfg(windows)]
unsafe impl Send for JobObject {}
#[cfg(windows)]
unsafe impl Sync for JobObject {}

/// 被管理的 ACP 子进程（acp/mod.rs 的 `AcpClient.child` 持有）。
pub struct ManagedChild {
    child: Option<Child>,
    /// Windows：进程树清理 job。句柄关闭即终止整棵进程树（KILL_ON_JOB_CLOSE）；
    /// 创建/挂接失败时为 None，kill 时回退 taskkill。
    #[cfg(windows)]
    job: Option<JobObject>,
}

impl ManagedChild {
    pub fn empty() -> Self {
        Self {
            child: None,
            #[cfg(windows)]
            job: None,
        }
    }

    pub fn new(child: Child) -> Self {
        let mut managed = Self {
            child: Some(child),
            #[cfg(windows)]
            job: None,
        };
        #[cfg(windows)]
        managed.attach_job();
        managed
    }

    /// Windows：spawn 后立即把子进程挂进 KILL_ON_JOB_CLOSE job。赋值发生在子进程
    /// 完成初始化（读 stdin）之前，其后续派生的进程自动继承 job 成员资格；
    /// 任一环节失败仅记 warn 并回退 taskkill（不阻塞 spawn）。
    #[cfg(windows)]
    fn attach_job(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let Some(child) = self.child.as_ref() else {
            return;
        };
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            tracing::warn!(
                "ACP: CreateJobObjectW failed ({}); taskkill fallback",
                std::io::Error::last_os_error()
            );
            return;
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set_ok == 0 {
            tracing::warn!(
                "ACP: SetInformationJobObject failed ({}); taskkill fallback",
                std::io::Error::last_os_error()
            );
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return;
        }
        if unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } == 0 {
            tracing::warn!(
                "ACP: AssignProcessToJobObject failed ({}); taskkill fallback",
                std::io::Error::last_os_error()
            );
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return;
        }
        self.job = Some(JobObject { handle: job });
    }

    pub fn take_stdin(&mut self) -> Result<std::process::ChildStdin, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stdin.take())
            .ok_or(AcpError::Child("no stdin".to_string()))
    }

    pub fn take_stdout(&mut self) -> Result<std::process::ChildStdout, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stdout.take())
            .ok_or(AcpError::Child("no stdout".to_string()))
    }

    pub fn take_stderr(&mut self) -> Result<std::process::ChildStderr, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stderr.take())
            .ok_or(AcpError::Child("no stderr".to_string()))
    }

    /// 直接子进程 PID（AcpClient::child_id 测试辅助用；进程已退出/未 spawn 为 None）。
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    pub fn has_child(&self) -> bool {
        self.child.is_some()
    }

    /// 监听子进程退出（不持有 `Child`，避免与 kill/Drop 争用句柄）。
    ///
    /// Windows：`OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject(INFINITE)`；
    /// 其他平台暂不实现（返回 false）。用于 SDK 后端：SDK 的 EOF 语义在洪泛/
    /// 批量场景不可靠，子进程退出才是权威崩溃信号。
    pub fn spawn_exit_watcher(pid: u32, on_exit: impl FnOnce() + Send + 'static) -> bool {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
            use windows_sys::Win32::System::Threading::{
                OpenProcess, WaitForSingleObject, INFINITE,
            };
            let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                return false;
            }
            // HANDLE 是内核对象句柄（数值），以 isize 跨线程传递后还原。
            let handle = handle as isize;
            std::thread::spawn(move || {
                let handle = handle as *mut core::ffi::c_void;
                unsafe {
                    WaitForSingleObject(handle, INFINITE);
                    CloseHandle(handle);
                }
                on_exit();
            });
            true
        }
        #[cfg(not(windows))]
        {
            let _ = (pid, on_exit);
            false
        }
    }

    /// Non-blocking process status used by supervisors that own their own
    /// protocol/event loops. `None` means the child is still running.
    pub fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, AcpError> {
        self.child
            .as_mut()
            .map(|child| child.try_wait())
            .transpose()
            .map(|status| status.flatten())
            .map_err(|error| AcpError::Child(format!("try_wait failed: {error}")))
    }

    /// Request termination while retaining ownership for escalation. The
    /// Windows job-object/taskkill path terminates the complete process tree.
    pub fn terminate_gracefully(&mut self) -> Result<(), AcpError> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        child
            .kill()
            .map_err(|error| AcpError::Child(format!("terminate failed: {error}")))
    }

    /// Windows：`taskkill /T /F` 递归杀进程树（job 挂接失败时的兜底——job 成功
    /// 时 kill_and_wait 走 job 关闭路径）。`Child::kill` 只杀直接子进程，
    /// peri/hermes 派生的子进程会残留。进程已退出时 taskkill 报错——静默返回
    /// false，由调用方回退普通 kill 路径。
    #[cfg(windows)]
    fn kill_process_tree(pid: u32) -> bool {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_console_window(&mut command);
        command
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    pub fn kill_and_wait(&mut self) -> Result<(), AcpError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        #[cfg(windows)]
        if self.job.is_some() {
            // Windows：关闭 job 句柄（KILL_ON_JOB_CLOSE）即终止整棵进程树，
            // 随后 wait 回收直接子进程（进程可能已抢先退出，wait 报错仅记 warn）。
            self.job = None;
            if let Err(error) = child.wait() {
                tracing::warn!("wait after job close: {error}");
            }
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                #[cfg(windows)]
                if Self::kill_process_tree(child.id()) {
                    // taskkill /T 已杀整个进程树；wait 回收句柄（进程可能已
                    // 抢先退出，wait 报错仅记 warn，不视为失败）。
                    if let Err(error) = child.wait() {
                        tracing::warn!("wait after taskkill: {error}");
                    }
                    return Ok(());
                }
                child
                    .kill()
                    .map_err(|error| AcpError::Child(format!("kill failed: {error}")))?;
                child
                    .wait()
                    .map_err(|error| AcpError::Child(format!("wait failed: {error}")))?;
                Ok(())
            }
            Err(error) => {
                // try_wait 失败时仍必须继续清理，不能把已取出的 Child
                // 直接丢弃，否则 initialize/switch/Drop 错误路径可能遗留子进程。
                let kill_result = child.kill();
                let wait_result = child.wait();
                match (kill_result, wait_result) {
                    (Ok(()), Ok(_)) => Err(AcpError::Child(format!(
                        "try_wait failed: {error}; child killed and waited"
                    ))),
                    (kill_error, wait_error) => Err(AcpError::Child(format!(
                        "try_wait failed: {error}; kill: {}; wait: {}",
                        kill_error
                            .map(|_| "ok".to_string())
                            .unwrap_or_else(|err| err.to_string()),
                        wait_error
                            .map(|_| "ok".to_string())
                            .unwrap_or_else(|err| err.to_string()),
                    ))),
                }
            }
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if let Err(error) = self.kill_and_wait() {
            tracing::warn!("cleanup ACP child: {}", error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #363-1：四项 UTF-8 环境必须都钉上（`get_envs` 是唯一可离线断言的视图）。
    #[test]
    fn utf8_env_pins_all_four_variables() {
        let mut command = std::process::Command::new("agent");
        set_utf8_env(&mut command);
        let rendered: std::collections::HashMap<String, String> = command
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().to_string(),
                        value.to_string_lossy().to_string(),
                    )
                })
            })
            .collect();
        assert_eq!(rendered.get("PYTHONUTF8").map(String::as_str), Some("1"));
        assert_eq!(
            rendered.get("PYTHONIOENCODING").map(String::as_str),
            Some("utf-8")
        );
        assert_eq!(rendered.get("LANG").map(String::as_str), Some("C.UTF-8"));
        assert_eq!(rendered.get("LC_ALL").map(String::as_str), Some("C.UTF-8"));
    }

    /// 收口后用户显式声明的同名 env 仍然赢：本函数只提供默认值。
    #[test]
    fn explicit_launch_env_overrides_the_utf8_default() {
        let mut command = std::process::Command::new("agent");
        configure_agent_child(&mut command);
        command.env("LANG", "zh_CN.UTF-8");
        let lang = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("LANG"))
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().to_string());
        assert_eq!(lang.as_deref(), Some("zh_CN.UTF-8"));
    }

    fn busy_error() -> std::io::Error {
        std::io::Error::from(std::io::ErrorKind::ExecutableFileBusy)
    }

    /// #363-2：busy 错误在预算内重试到成功（1ms + 2ms 退避，实测毫秒级）。
    #[tokio::test]
    async fn busy_spawn_retries_until_it_succeeds() {
        let mut attempts = 0;
        let result = spawn_retrying_exec_busy(|| {
            attempts += 1;
            if attempts < 3 {
                Err(busy_error())
            } else {
                Ok(attempts)
            }
        })
        .await;
        assert_eq!(result.expect("第三次必须成功"), 3);
        assert_eq!(attempts, 3);
    }

    /// 非 busy 错误**不重试**：调用方要用它立刻决定回退路径，不该被我们的预算拖住。
    #[tokio::test]
    async fn non_busy_errors_are_returned_on_the_first_attempt() {
        for kind in [
            std::io::ErrorKind::NotFound,
            std::io::ErrorKind::InvalidFilename,
            std::io::ErrorKind::PermissionDenied,
        ] {
            let mut attempts = 0;
            let result: std::io::Result<()> = spawn_retrying_exec_busy(|| {
                attempts += 1;
                Err(std::io::Error::from(kind))
            })
            .await;
            let error = result.expect_err("必须返回原始错误");
            assert_eq!(error.kind(), kind, "错误必须原样返回");
            assert_eq!(attempts, 1, "{kind:?} 不得重试");
        }
    }

    /// 预算耗尽返回**原始** busy 错误（不重新归类、不换成超时错误）。
    /// 用 40ms 预算而非默认 1s，避免测试白等。
    #[tokio::test]
    async fn retry_budget_exhaustion_returns_the_original_busy_error() {
        let mut attempts = 0;
        let result: std::io::Result<()> =
            spawn_retrying_exec_busy_within(Duration::from_millis(40), || {
                attempts += 1;
                Err(busy_error())
            })
            .await;
        let error = result.expect_err("预算耗尽必须报错");
        assert_eq!(error.kind(), std::io::ErrorKind::ExecutableFileBusy);
        assert!(attempts > 1, "必须真的重试过（实际 {attempts} 次）");
    }

    /// 退避有上界：整个预算内的等待不超过预算 + 一次退避——退避不得无界增长。
    #[tokio::test]
    async fn backoff_stays_within_the_budget() {
        let budget = Duration::from_millis(40);
        let start = std::time::Instant::now();
        let mut attempts = 0;
        let _: std::io::Result<()> = spawn_retrying_exec_busy_within(budget, || {
            attempts += 1;
            Err(busy_error())
        })
        .await;
        let elapsed = start.elapsed();
        assert!(attempts > 1, "必须真的重试过（实际 {attempts} 次）");
        // 上界给得宽松：tokio 定时器在负载下会超时到达，卡在 budget+25ms 这种紧
        // 贴边值上会变成 CI flake。真正要钉的是「退避不会无界增长」——数量级即可。
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "退避必须被 deadline 与上限夹住（量级判断），实际 {elapsed:?}"
        );
    }

    /// 非 Unix 平台没有 ETXTBSY 这个概念：errno 判定必须不误伤。
    #[test]
    fn only_busy_errors_are_classified_as_busy() {
        assert!(is_exec_busy(&busy_error()));
        assert!(!is_exec_busy(&std::io::Error::from(
            std::io::ErrorKind::NotFound
        )));
        #[cfg(unix)]
        {
            assert!(is_exec_busy(&std::io::Error::from_raw_os_error(ETXTBSY)));
            assert!(!is_exec_busy(&std::io::Error::from_raw_os_error(2)));
        }
    }

    /// A1a 步骤 8：子进程退出监听必须触发（SDK 后端的权威崩溃信号）。
    #[test]
    fn exit_watcher_fires_on_process_exit() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd");
        let pid = child.id();
        let (tx, rx) = std::sync::mpsc::channel();
        assert!(
            ManagedChild::spawn_exit_watcher(pid, move || {
                let _ = tx.send(());
            }),
            "watcher must be available on windows"
        );
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("exit watcher must fire");
        let _ = child.wait();
    }
}
