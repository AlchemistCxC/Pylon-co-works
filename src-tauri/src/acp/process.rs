//! ACP 子进程管理（R9/P3-1 拆分自 acp.rs；行为零变化）。
//!
//! `ManagedChild`：子进程 + Windows Job Object 进程树清理。spawn 后立即把子进程
//! 挂进 `KILL_ON_JOB_CLOSE` job（句柄关闭即终止整棵进程树，成员资格自动继承给
//! 后续派生进程）；job 创建/挂接失败回退 `taskkill /T /F`，再回退 `Child::kill`。
//! `Drop` 兜底 `kill_and_wait`，保证任何错误路径不遗留进程树。

use std::process::Child;

use super::AcpError;

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
pub(crate) struct ManagedChild {
    child: Option<Child>,
    /// Windows：进程树清理 job。句柄关闭即终止整棵进程树（KILL_ON_JOB_CLOSE）；
    /// 创建/挂接失败时为 None，kill 时回退 taskkill。
    #[cfg(windows)]
    job: Option<JobObject>,
}

impl ManagedChild {
    pub(crate) fn empty() -> Self {
        Self {
            child: None,
            #[cfg(windows)]
            job: None,
        }
    }

    pub(crate) fn new(child: Child) -> Self {
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

    pub(crate) fn take_stdin(&mut self) -> Result<std::process::ChildStdin, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stdin.take())
            .ok_or(AcpError::Child("no stdin".to_string()))
    }

    pub(crate) fn take_stdout(&mut self) -> Result<std::process::ChildStdout, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stdout.take())
            .ok_or(AcpError::Child("no stdout".to_string()))
    }

    pub(crate) fn take_stderr(&mut self) -> Result<std::process::ChildStderr, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stderr.take())
            .ok_or(AcpError::Child("no stderr".to_string()))
    }

    /// 直接子进程 PID（AcpClient::child_id 测试辅助用；进程已退出/未 spawn 为 None）。
    pub(crate) fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    pub(crate) fn has_child(&self) -> bool {
        self.child.is_some()
    }

    /// Non-blocking process status used by supervisors that own their own
    /// protocol/event loops. `None` means the child is still running.
    pub(crate) fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, AcpError> {
        self.child
            .as_mut()
            .map(|child| child.try_wait())
            .transpose()
            .map(|status| status.flatten())
            .map_err(|error| AcpError::Child(format!("try_wait failed: {error}")))
    }

    /// Windows：`taskkill /T /F` 递归杀进程树（job 挂接失败时的兜底——job 成功
    /// 时 kill_and_wait 走 job 关闭路径）。`Child::kill` 只杀直接子进程，
    /// peri/hermes 派生的子进程会残留。进程已退出时 taskkill 报错——静默返回
    /// false，由调用方回退普通 kill 路径。
    #[cfg(windows)]
    fn kill_process_tree(pid: u32) -> bool {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    pub(crate) fn kill_and_wait(&mut self) -> Result<(), AcpError> {
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
