//! agent 子进程的 Windows 启动特调（#353；机制移植自 Apache-2.0 的 Codeg
//! `src-tauri/src/acp/agent_process.rs` 与 `src-tauri/src/process.rs`，出处
//! 登记见 `src-tauri/vendor/acp/ORIGIN.md` §6）。
//!
//! 两个关注点都只在 Windows 生效，其余平台与「直接 `Command::new`」逐字节一致：
//!
//! * **UNC pushd 绕行**：批处理启动器（`.cmd`/`.bat`）必经 `cmd.exe` 运行，而
//!   `cmd.exe` 无法以 UNC 路径为当前目录，会**静默**回落 `C:\Windows`——agent
//!   侧一切由 cwd 派生的行为（相对路径读写、`os.getcwd()`）随之全错且无任何
//!   报错。唯一窄条件（批处理启动器 ∧ 绝对路径 ∧ UNC cwd）改以
//!   `%SystemRoot%\System32\cmd.exe /d /s /c "pushd <unc> && <exe> <args>"`
//!   启动：`pushd` 把共享映射成临时盘符，cwd 因此真实成立。
//! * **裸名解析**：`Command::new("foo")` 在 Windows 走 `CreateProcessW` 的隐式
//!   后缀补全，只补 `.exe`——npm 安装的 CLI shim（`.cmd`/`.bat`）以裸名配置时
//!   spawn 直接 `NotFound`。构造期按 `.exe`→`.cmd`→`.bat` 扩展优先序在 PATH 上
//!   补全（Codeg `normalized_program` 语义）。纯增量：已是路径或解析不到时与
//!   现状一致。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use pylon_core::agent_launch_plan::LaunchPlan;

/// agent 子进程 `Command` 的唯一构造口（`spawn_agent_child` 专用）。
///
/// 绕行条件不满足时走直启：`apply_launch_plan` 仍一次应用 argv/cwd/env，
/// 与既有行为零差异。绕行路径下 argv 与 cwd 都由批行承载（`pushd` 即 cwd），
/// **不得**再 `current_dir(UNC)`——把 UNC 交给 `CreateProcess` 正是 `cmd.exe`
/// 拒绝并回落 `C:\Windows` 的形状；env 仍从 plan 通道应用。
pub(crate) fn agent_command(plan: &LaunchPlan) -> std::process::Command {
    #[cfg(windows)]
    {
        if let Some(detour) = unc_batch_detour(&plan.executable, plan.cwd.as_deref(), &plan.args) {
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new(detour.program);
            for (name, value) in &plan.env {
                command.env(name, value);
            }
            // raw_arg：批行已自带完整引号方案，std 的通用 quoting 会把整行再包
            // 一层双引号，cmd 的 /s 剥引号规则因此失效。
            command.raw_arg(detour.command_line);
            return command;
        }
    }
    let mut command = std::process::Command::new(direct_program(&plan.executable));
    super::launch_plan::apply_launch_plan(&mut command, plan);
    command
}

/// 直启程序名：Windows 下裸名先经 PATH 解析增补，其余原样。
fn direct_program(executable: &str) -> OsString {
    #[cfg(windows)]
    {
        if let Some(resolved) = resolve_windows_program(executable) {
            return resolved;
        }
    }
    OsString::from(executable)
}

/// 「裸名」判定：单个组件且无扩展名。配置成路径（含 `./shim.cmd`）或已带扩展
/// 名的都不做增补——回退必须纯增量，不改变任何本可直启的启动。
fn is_bare_program_name(program: &str) -> bool {
    let path = Path::new(program);
    path.components().count() == 1 && path.extension().is_none()
}

/// Windows：把裸名按 `.exe`→`.cmd`→`.bat` 的扩展优先序在 PATH 上补全。
///
/// 扩展优先而非目录优先（同 Codeg/`which`）：任何目录的 `foo.exe` 都赢过任何
/// 目录的 `foo.cmd`，与「CreateProcess 只会补 `.exe`」的既有优先级一致。
/// 只搜 PATH、不搜子进程 cwd：`cmd.exe` 的搜索序从当前目录开始，而绕行后
/// cwd 恰好指向工作区，搜索 cwd 等于允许仓库里同名的不可信 shim 抢启动。
#[cfg(windows)]
fn resolve_windows_program(program: &str) -> Option<OsString> {
    if !is_bare_program_name(program) {
        return None;
    }
    let path_var = std::env::var_os("PATH")?;
    for ext in ["exe", "cmd", "bat"] {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(format!("{program}.{ext}"));
            if candidate.is_file() {
                return Some(candidate.into_os_string());
            }
        }
    }
    None
}

/// 绕行的产物：实际要启动的程序与一条已含引号方案的原始命令行。
#[cfg(windows)]
struct UncBatchDetour {
    program: PathBuf,
    command_line: String,
}

/// Windows 唯一绕行决策点：批处理启动器 ∧ 绝对路径 ∧ UNC cwd。
///
/// 命令行与「是否设 current_dir」都从这一处读，两边不可能漂移。批行构造失败
/// （参数含 `\r`/`\n`/`\0`）时回落直启并留日志：这类参数本身已不可运行，不把
/// 连接整个打成失败，但 cwd 回落 `C:\Windows` 的旧行为必须可观测。
#[cfg(windows)]
fn unc_batch_detour(
    executable: &str,
    cwd: Option<&str>,
    args: &[String],
) -> Option<UncBatchDetour> {
    let pushd_cwd = windows_pushd_cwd(cwd, Path::new(executable))?;
    match make_unc_batch_command_line(&pushd_cwd, executable, args) {
        Ok(command_line) => Some(UncBatchDetour {
            program: system_cmd_exe(),
            command_line,
        }),
        Err(error) => {
            tracing::warn!("UNC workspace batch launch falls back to direct spawn: {error}");
            None
        }
    }
}

/// `cmd.exe` 从 `SystemRoot` 解析而非 PATH：绕行专挑系统的一份，避免工作区或
/// 用户 PATH 上的同名程序劫持这次启动。plan env 的覆盖在此之后才应用，拦不住
/// 这里的选择。
#[cfg(windows)]
fn system_cmd_exe() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("cmd.exe")
}

/// Windows 扩展长度 UNC 书写——`fs::canonicalize` 对共享路径的返回形状。
const VERBATIM_UNC_PREFIX: &str = r"\\?\UNC\";

fn is_windows_unc_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with(r"\\?\unc\")
        || (path.starts_with(r"\\") && !path.starts_with(r"\\?\") && !path.starts_with(r"\\.\"))
}

fn is_windows_batch_file(command: &Path) -> bool {
    let lower = command.to_string_lossy().to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// `cmd.exe` 无需搜索序就能直接运行的路径：盘符绝对（`C:\…`、`C:/…`）或 UNC。
///
/// `Path::is_absolute` 回答不了——它遵循**宿主**机的规则，而这个判定必须在
/// Linux CI 上同样成立、同样可测。盘相对（`C:x`）与根相对（`\x`）都按当前
/// 盘与目录解析，故都不算。前向斜杠 UNC（`//server/share`）**有意不识别**：
/// Win32 接受它，但 cmd 对前导 `/` 的解析不一致，且没有调用方产出该形状
/// （`which`、`PathBuf::join` 与系统对话框都交回反斜杠）；该形状保持直启。
fn is_absolute_windows_path(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    if text.starts_with(r"\\") {
        return true;
    }
    let bytes = text.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// `pushd` 需要映射的目录；`None` 表示直启才是正确选择。
///
/// 这是唯一决定启动是否绕行的地方：命令行与 `current_dir` 都读它，不会一边
/// 绕行一边又把 UNC 递给 `CreateProcess`。启动器必须已是绝对路径——Rust 对
/// 裸名按 PATH 解析、绝不查子进程 cwd，而 `cmd.exe` 自己的搜索序从当前目录
/// 开始，`pushd` 恰好刚把当前目录指向工作区；相对启动器进绕行会让仓库内的
/// `agent.cmd` 压过 PATH 上可信的那份，该形状保持直启（cwd 错误维持现状）。
///
/// 返回普通 `\\server\share\…` 书写并去尾分隔符：`pushd` 是 cmd **内建**，
/// 由 cmd 自己解析自己的命令行——它既解析不了扩展长度 `\\?\UNC\…`，也永远不会
/// 还原 quoting 给尾反斜杠加的倍增（那对「批文件会再解析的参数」是对的，对
/// cmd 内建是错的）；两种形状都会让 `pushd` 失败、`&&` 把整个 agent 启动带走。
fn windows_pushd_cwd(current_dir: Option<&str>, command: &Path) -> Option<String> {
    if !is_windows_batch_file(command) || !is_absolute_windows_path(command) {
        return None;
    }
    let dir = current_dir?;
    if !is_windows_unc_path(dir) {
        return None;
    }
    // `\\?\UNC\server\share` → `\\server\share`；普通 UNC 保留自己的前导双反斜杠。
    // 大小写不可预测——Windows 对 `\\?\unc\` 与 `\\?\UNC\` 一视同仁。
    let rest = match dir.get(..VERBATIM_UNC_PREFIX.len()) {
        Some(head) if head.eq_ignore_ascii_case(VERBATIM_UNC_PREFIX) => {
            &dir[VERBATIM_UNC_PREFIX.len()..]
        }
        // `is_windows_unc_path` 已证明头两个字节是 ASCII 反斜杠，切片既不会
        // 劈开字符也不会越界。
        _ => &dir[2..],
    };
    Some(format!(r"\\{}", rest.trim_end_matches(['\\', '/'])))
}

/// 追加一个参数，规则与 Rust 标准库启动 Windows 批处理文件时一致：cmd 元字符
/// 保持引号包裹，百分号无法展开环境变量。
#[cfg(any(windows, test))]
fn append_windows_batch_arg(output: &mut String, arg: &str) -> std::io::Result<()> {
    if arg.contains(['\r', '\n', '\0']) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "batch file arguments may not contain line breaks or NUL bytes",
        ));
    }

    const UNQUOTED: &str = r"#$*+-./:?@\_";
    let quote = arg.is_empty()
        || arg.ends_with('\\')
        || arg.chars().any(|ch| {
            (ch.is_ascii() && !(ch.is_ascii_alphanumeric() || UNQUOTED.contains(ch)))
                || ch.is_control()
        });

    if quote {
        output.push('"');
    }
    let mut backslashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            output.extend(std::iter::repeat_n('\\', backslashes * 2));
            output.push_str("\"\"");
        } else {
            output.extend(std::iter::repeat_n('\\', backslashes));
            if ch == '%' || ch == '\r' {
                output.push_str("%%cd:~,");
            }
            output.push(ch);
        }
        backslashes = 0;
    }
    if quote {
        output.extend(std::iter::repeat_n('\\', backslashes * 2));
        output.push('"');
    } else {
        output.extend(std::iter::repeat_n('\\', backslashes));
    }
    Ok(())
}

/// 拼装 `/e:ON /v:OFF /d /s /c "pushd <cwd> && <exe> <args>"`。
///
/// 不用 `call`：`call` 会再解析一遍参数，把元字符二次展开。这个短命 cmd 进程
/// 由批处理文件接管（`/c` 语义：批处理退出即退出）。
#[cfg(any(windows, test))]
fn make_unc_batch_command_line(
    cwd: &str,
    command: &str,
    args: &[String],
) -> std::io::Result<String> {
    let mut line = String::from("/e:ON /v:OFF /d /s /c \"pushd ");
    append_windows_batch_arg(&mut line, cwd)?;
    line.push_str(" && ");
    append_windows_batch_arg(&mut line, command)?;
    for arg in args {
        line.push(' ');
        append_windows_batch_arg(&mut line, arg)?;
    }
    line.push('"');
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_windows_unc_paths_without_misclassifying_device_or_drive_paths() {
        assert!(is_windows_unc_path(
            r"\\wsl.localhost\Ubuntu\home\user\repo"
        ));
        assert!(is_windows_unc_path(r"\\wsl$\Ubuntu\home\user\repo"));
        assert!(is_windows_unc_path(r"\\?\UNC\server\share\repo"));
        assert!(!is_windows_unc_path(r"C:\Users\user\repo"));
        assert!(!is_windows_unc_path(r"\\?\C:\Users\user\repo"));
        assert!(!is_windows_unc_path(r"\\.\pipe\pylon"));
    }

    #[test]
    fn detects_batch_launchers_case_insensitively() {
        assert!(is_windows_batch_file(Path::new("hermes.CmD")));
        assert!(is_windows_batch_file(Path::new("agent.BAT")));
        assert!(!is_windows_batch_file(Path::new("agent.exe")));
        assert!(!is_windows_batch_file(Path::new("hermes")));
    }

    /// 绕行只救一个组合。放宽会给不需要 cmd.exe 的 agent 前插一层；收紧则把
    /// agent 送回 `C:\Windows`。
    #[test]
    fn pushd_is_reserved_for_a_unc_workspace_behind_a_batch_launcher() {
        let batch = Path::new(r"C:\npm\hermes.cmd");

        assert_eq!(
            windows_pushd_cwd(Some(r"\\wsl.localhost\Ubuntu\home\user\repo"), batch).as_deref(),
            Some(r"\\wsl.localhost\Ubuntu\home\user\repo")
        );
        // 原生可执行文件吃 UNC cwd 毫无问题——没有 cmd.exe 参与。
        assert_eq!(
            windows_pushd_cwd(
                Some(r"\\wsl.localhost\Ubuntu\home\user\repo"),
                Path::new(r"C:\npm\uvx.exe")
            ),
            None
        );
        assert_eq!(windows_pushd_cwd(Some(r"C:\Users\user\repo"), batch), None);
        assert_eq!(windows_pushd_cwd(None, batch), None);
    }

    /// Rust 对裸名按 PATH 解析、绝不查子进程 cwd；`cmd.exe` 的搜索序从当前
    /// 目录**开始**——绕行后当前目录已指向工作区，相对启动器进绕行等于让仓库
    /// 内的 `hermes.cmd` 取代 PATH 上可信的那份。这些形状保持直启。
    #[test]
    fn a_relative_launcher_never_takes_the_detour() {
        let unc = r"\\wsl.localhost\Ubuntu\home\user\repo";
        for relative in [
            "hermes.cmd",
            r".\hermes.cmd",
            r"node_modules\.bin\hermes.cmd",
            // 根相对与盘相对都按 `pushd` 刚改到的盘与目录解析。
            r"\hermes.cmd",
            "C:hermes.cmd",
        ] {
            assert_eq!(
                windows_pushd_cwd(Some(unc), Path::new(relative)),
                None,
                "{relative} would be resolved out of the workspace"
            );
        }
        for absolute in [
            r"C:\npm\hermes.cmd",
            r"c:/npm/hermes.cmd",
            r"\\tools\share\hermes.cmd",
        ] {
            assert!(
                windows_pushd_cwd(Some(unc), Path::new(absolute)).is_some(),
                "{absolute} needs the detour"
            );
        }
    }

    /// `pushd` 是 cmd 内建，这个参数由 cmd 自己解析：它解析不了的三种书写必须
    /// 在到达之前被归一掉，否则 `&&` 会带着整个 agent 启动一起失败。
    #[test]
    fn pushd_cwd_is_spelled_the_only_way_cmd_can_resolve_it() {
        let batch = Path::new(r"C:\npm\hermes.cmd");
        // 扩展长度形状是 `fs::canonicalize` 在 Windows 上的产物，cmd.exe 全不认。
        for verbatim in [
            r"\\?\UNC\wsl.localhost\Ubuntu\home\user\repo",
            r"\\?\unc\wsl.localhost\Ubuntu\home\user\repo",
        ] {
            assert_eq!(
                windows_pushd_cwd(Some(verbatim), batch).as_deref(),
                Some(r"\\wsl.localhost\Ubuntu\home\user\repo")
            );
        }
        // 尾分隔符经 quoting 会变成成对反斜杠——对批文件会再解析的参数是对的，
        // cmd 内建不会去引号，`pushd` 会原样收到成对反斜杠并拒绝该路径。
        assert_eq!(
            windows_pushd_cwd(Some(r"\\srv\share\repo\"), batch).as_deref(),
            Some(r"\\srv\share\repo")
        );
        assert_eq!(
            windows_pushd_cwd(Some(r"\\srv\share\repo/"), batch).as_deref(),
            Some(r"\\srv\share\repo")
        );
    }

    #[test]
    fn unc_batch_command_uses_pushd_and_escapes_cmd_metacharacters() {
        let command = make_unc_batch_command_line(
            r"\\wsl.localhost\Ubuntu\home\a&b\repo",
            r"C:\Program Files\nodejs\hermes.cmd",
            &["acp".into(), "100% ready".into(), "x&whoami".into()],
        )
        .expect("valid command line");

        assert_eq!(
            command,
            r#"/e:ON /v:OFF /d /s /c "pushd "\\wsl.localhost\Ubuntu\home\a&b\repo" && "C:\Program Files\nodejs\hermes.cmd" acp "100%%cd:~,% ready" "x&whoami"""#
        );
    }

    #[test]
    fn unc_batch_command_rejects_line_breaks() {
        assert!(make_unc_batch_command_line(
            r"\\wsl.localhost\Ubuntu\home\user\repo",
            "hermes.cmd",
            &["line\nbreak".into()],
        )
        .is_err());
    }

    /// 裸名判定是 PATH 增补的闸门：路径与已带扩展名的一律不增补。
    #[test]
    fn bare_name_detection_gates_the_path_lookup() {
        assert!(is_bare_program_name("hermes"));
        assert!(!is_bare_program_name("hermes.cmd"), "带扩展名不增补");
        assert!(!is_bare_program_name(r"C:\npm\hermes.cmd"));
        assert!(!is_bare_program_name(r"./hermes"));
        assert!(!is_bare_program_name(r"node_modules\.bin\hermes"));
    }

    /// 非 Windows 也可判定：绕行条件不满足时构造结果与直启逐字段一致——
    /// 程序名就是 plan.executable，env 仍从 plan 应用。
    #[test]
    fn non_detour_launch_is_untouched() {
        let plan = LaunchPlan {
            provider: "custom".into(),
            executable: r"C:\npm\hermes.cmd".into(),
            args: vec!["acp".into()],
            cwd: Some(r"C:\Users\user\repo".into()),
            env: vec![("HERMES_HOME".into(), "F:/home".into())],
            owner_key: "k".into(),
            source: pylon_core::agent_launch_plan::LaunchPlanSource::Explicit,
            diagnostics: Vec::new(),
        };
        let command = agent_command(&plan);
        assert_eq!(command.get_program().to_string_lossy(), plan.executable);
        let env: Vec<_> = command
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| {
                    (
                        k.to_string_lossy().to_string(),
                        v.to_string_lossy().to_string(),
                    )
                })
            })
            .collect();
        assert_eq!(env, vec![("HERMES_HOME".into(), "F:/home".into())]);
    }

    /// 绕行构造（Windows 实机）：程序换成系统 cmd.exe，env 仍从 plan 应用。
    /// 批行本身的形状由 `unc_batch_command_uses_pushd_and_escapes_cmd_metacharacters`
    /// 逐字符钉死；`raw_arg` 不进 `get_args`，故这里只验证程序与 env 视图。
    #[cfg(windows)]
    #[test]
    fn detour_command_targets_the_system_cmd_exe() {
        let plan = LaunchPlan {
            provider: "custom".into(),
            executable: r"C:\npm\hermes.cmd".into(),
            args: vec!["acp".into()],
            cwd: Some(r"\\wsl.localhost\Ubuntu\home\user\repo".into()),
            env: vec![("HERMES_HOME".into(), "F:/home".into())],
            owner_key: "k".into(),
            source: pylon_core::agent_launch_plan::LaunchPlanSource::Explicit,
            diagnostics: Vec::new(),
        };
        let command = agent_command(&plan);
        let program = command.get_program().to_string_lossy().to_lowercase();
        assert!(program.ends_with(r"\system32\cmd.exe"), "actual: {program}");
        let env: Vec<_> = command
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| {
                    (
                        k.to_string_lossy().to_string(),
                        v.to_string_lossy().to_string(),
                    )
                })
            })
            .collect();
        assert_eq!(env, vec![("HERMES_HOME".into(), "F:/home".into())]);
    }

    /// 实机端到端（Windows）：绕行的批行走真 cmd.exe——`raw_arg` 管线、/s 剥引号、
    /// `pushd` 内建与批行 quoting 全部真实运转。UNC 共享离线造不出来，用本地
    /// 目录验证同一机制（`pushd` 对盘符路径同样成立）。
    #[cfg(windows)]
    #[test]
    fn detour_command_line_runs_a_real_batch_under_pushd() {
        let dir = std::env::temp_dir().join("pylon-353-pushd-probe");
        std::fs::create_dir_all(&dir).expect("create probe dir");
        let batch = dir.join("echo_cwd.cmd");
        std::fs::write(&batch, "@echo %CD%").expect("write probe batch");

        let line =
            make_unc_batch_command_line(&dir.to_string_lossy(), &batch.to_string_lossy(), &[])
                .expect("valid command line");
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let output = Command::new(system_cmd_exe())
            .raw_arg(line)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("spawn cmd");
        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let printed = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_lowercase();
        let expected = dir.to_string_lossy().trim_end_matches('\\').to_lowercase();
        assert_eq!(printed, expected, "批处理必须在 pushd 后的目录里运行");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
