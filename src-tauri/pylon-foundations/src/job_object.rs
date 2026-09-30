//! Windows `KILL_ON_JOB_CLOSE` 进程树清理 job：全仓唯一的 unsafe 装配正身（#486 项5）。
//!
//! 此前 `pylon-core::agent_detection::probe`（版本探测子进程）与
//! `pylon-acp::process`（ACP agent 子进程）各有一份逐行同构的手抄装配：
//! `CreateJobObjectW` → `SetInformationJobObject`（KILL_ON_JOB_CLOSE）→
//! `AssignProcessToJobObject`，任一步失败 `CloseHandle` 后由调用方回退各自的
//! taskkill 路径。unsafe 代码只该有一份，故下沉本 crate（与 `child_command`
//! 同域：子进程收口）。
//!
//! 语义（两处原实现一致）：job 句柄关闭即终止 job 内全部进程（含成员派生的
//! 整棵子树，成员资格自动继承）。本模块不记日志、不回退——失败文案与 taskkill
//! 兜底属调用方契约，见各消费点。非 Windows 平台无此概念，全模块为空。

/// 挂接失败在哪一步。`Display` 给出失败的原生 API 名，调用方拼自己的日志前缀。
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobAttachFailure {
    /// `CreateJobObjectW` 失败（job 未创建，无句柄需关闭）。
    CreateJobObject,
    /// `SetInformationJobObject` 失败（已创建的 job 已在本模块内关闭）。
    SetJobLimits,
    /// `AssignProcessToJobObject` 失败（已创建的 job 已在本模块内关闭）。
    AssignProcess,
}

#[cfg(windows)]
impl core::fmt::Display for JobAttachFailure {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let name = match self {
            Self::CreateJobObject => "CreateJobObjectW failed",
            Self::SetJobLimits => "SetInformationJobObject failed",
            Self::AssignProcess => "AssignProcessToJobObject failed",
        };
        f.write_str(name)
    }
}

/// 已挂接进程的 `KILL_ON_JOB_CLOSE` job。`Drop` 关闭句柄（= 终止进程树）。
#[cfg(windows)]
pub struct KillOnCloseJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl KillOnCloseJob {
    /// 创建 job、设 `KILL_ON_JOB_CLOSE` 上限，并把 `process_handle`（另一进程的
    /// 裸句柄）挂入 job。任一步失败返回 `Err`，已创建的 job 句柄在本模块内关闭，
    /// 不留泄漏。
    ///
    /// # Safety
    /// `process_handle` 必须是本进程有权限操作的另一进程的有效裸句柄（消费点取自
    /// `Child::raw_handle`/`AsRawHandle`，天然满足）；挂接后该进程的生死与 job
    /// 绑定（句柄关闭即整树终止）。
    pub unsafe fn attach_process(
        process_handle: windows_sys::Win32::Foundation::HANDLE,
    ) -> Result<Self, JobAttachFailure> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(JobAttachFailure::CreateJobObject);
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            unsafe { CloseHandle(job) };
            return Err(JobAttachFailure::SetJobLimits);
        }
        if unsafe { AssignProcessToJobObject(job, process_handle) } == 0 {
            unsafe { CloseHandle(job) };
            return Err(JobAttachFailure::AssignProcess);
        }
        Ok(Self { handle: job })
    }
}

#[cfg(windows)]
impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

// HANDLE 是内核对象句柄（数字 token），跨线程移动/共享安全；裸指针本身非
// Send/Sync，显式标记（CloseHandle 线程安全）。Send+Sync 取两处原实现的并集：
// acp 侧需要 Sync（AcpClient 跨 tokio::spawn 共享），探测侧原本只需 Send。
#[cfg(windows)]
unsafe impl Send for KillOnCloseJob {}
#[cfg(windows)]
unsafe impl Sync for KillOnCloseJob {}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    /// 差分验收：job 句柄关闭必须终止已挂接的整棵进程树（KILL_ON_JOB_CLOSE）。
    ///
    /// 拉起一个长驻子进程（ping 自身 15 秒），挂进 job，随后丢弃 job 触发
    /// CloseHandle：子进程必须在此后短时间内退出，而不是活满 15 秒。
    #[test]
    fn closing_the_job_terminates_the_attached_process() {
        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 15 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn long-running child");
        {
            use std::os::windows::io::AsRawHandle;
            // SAFETY：句柄取自刚 spawn 的子进程（Child::raw_handle 同源），有效且本进程持有完全权限。
            let job = unsafe { KillOnCloseJob::attach_process(child.as_raw_handle()) }
                .expect("attach child to kill-on-close job");
            // 赋值已完成（子进程已在 job 内）；此处故意让 job 在作用域尾 Drop。
            let _ = job;
        }
        // job 关闭后进程树被终止；宽限 10 秒内必须收割到退出状态。
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let exited = loop {
            if let Ok(Some(_)) = child.try_wait() {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(exited, "KILL_ON_JOB_CLOSE 必须在 job 句柄关闭后终止子进程");
        // 兜底清理（仅断言失败时才真正需要）。
        let _ = child.kill();
        let _ = child.wait();
    }
}
