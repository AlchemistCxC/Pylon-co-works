//! Git 接口（B5）：固定 runner → 只读查询 + 受限写操作。
//!
//! 安全面：
//! - 命令以参数数组执行（无 shell 拼接，防注入）
//! - 固定 cwd（调用方传入已校验的工作区 root）
//! - diff 的 path 参数做相对路径 + containment 校验（复用 workspace 语义）
//! - 输出截断（diff 256KB / status 2000 条 / history 200 条）
//! - 输出有界（G5-4）：读任务分块 drain，stdout 只保留前 MAX_READ_BYTES（16MB）、
//!   stderr 保留前 64KB；超限继续读入丢弃直到 EOF（防 git 阻塞写管道 = A1 不回归、
//!   防 EPIPE 误报失败），内存有界、超限保留头部（E17：截断标记文案不变）
//! - tokio process + 超时（大仓库防挂起）
//! - 非 git 仓库 / git 不可用 → 明确错误（code=git_error）
//! - 写操作只开放 stage/unstage/commit/branch/pull/push；不提供 reset、force push、
//!   forced checkout，且禁止交互式凭据提示

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

/// diff 输出上限（字节）。
pub const MAX_DIFF_BYTES: usize = 256 * 1024;
/// status 条目上限。
pub const MAX_STATUS_ENTRIES: usize = 2000;
/// history 条数上限。
pub const MAX_HISTORY: usize = 200;
/// git 命令超时。
pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// pull/push 允许更长的本地/网络传输时间，但仍保持有界。
pub const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(60);
/// G5-4：stdout 读取保留上限——超大 diff/status 只保留头部，其余继续读入丢弃。
/// pub（新测试引用）；≥ MAX_DIFF_BYTES 且覆盖巨型 diff 首段（E17：16MB 上限远超现实场景）。
pub const MAX_READ_BYTES: usize = 16 * 1024 * 1024;
/// G5-4：stderr 读取保留上限（64KB > 512 字节错误截断点）。
const MAX_STDERR_KEEP_BYTES: usize = 64 * 1024;
/// G5-4：读任务单次 read 分块大小。
const READ_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    /// porcelain 状态码（如 " M"/"A "/"??"；v2 的 '.' 归一为空格，与 v1 wire 兼容）。
    pub status: String,
    /// 是否已暂存（索引区变更）。
    pub staged: bool,
}

/// ISSUE-15 W1：分支信息（porcelain v2 `--branch` header 解析）。
/// detached HEAD → `branch.head (detached)`；无提交（unborn）→ `branch.oid (initial)`。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    /// 当前分支名；detached HEAD 时为 None。
    pub branch: Option<String>,
    /// HEAD 是否处于 detached 状态。
    pub detached: bool,
    /// HEAD commit 完整 oid；无任何提交时为 None。
    pub head: Option<String>,
}

/// ISSUE-15 W1：`git status --porcelain=v2 -z --branch` 的完整结果（branch + entries）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub branch: GitBranchInfo,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub author: String,
    /// Unix 秒时间戳（前端自行格式化）。
    pub date: String,
    pub subject: String,
}

/// 写操作统一回执：摘要供 UI 反馈，最新 status 供调用方原子刷新。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    pub summary: String,
    pub status: GitStatusResult,
}

fn is_git_error(stderr: &str) -> bool {
    stderr.contains("not a git repository") || stderr.contains("Not a git repository")
}

/// G5-4：有界 drain——分块读取，只保留前 keep_bytes，超限继续读入并丢弃直到 EOF。
/// 禁止用 `tokio::io::take` 提前关流：take 达上限即关闭读端，git 继续写管道会
/// EPIPE/SIGPIPE（写失败），超限输出被误报为"git 命令失败"；本循环读到 EOF，
/// 管道始终被消费（不回归 A1 管道缓冲死锁），内存有界（保留上限 + 分块缓冲）。
async fn drain_bounded<R>(out: &mut R, keep_bytes: usize) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(keep_bytes.min(8192));
    let mut chunk = [0u8; READ_CHUNK_BYTES];
    loop {
        match tokio::io::AsyncReadExt::read(out, &mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < keep_bytes {
                    let keep = n.min(keep_bytes - buf.len());
                    buf.extend_from_slice(&chunk[..keep]);
                }
            }
            Err(_) => break,
        }
    }
    buf
}

async fn run_git_with_timeout(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(String, String), String> {
    // 审查修复：超时必须 kill 子进程（Command::output 默认 kill_on_drop=false，
    // 超时后 git 会滞留并占用 index 锁）。
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // G5-5：固定 C locale——is_git_error 依赖英文文案（"not a git
        // repository"），宿主 locale（如 zh_CN）下 git 输出本地化文案会误判普通
        // 失败（message 语义漂移）。只覆盖 LC_ALL/LANG 两个变量，不 env_clear
        // （保留 PATH 等）；Windows 无 locale 变量时零影响。
        .env("LC_ALL", "C")
        .env("LANG", "C")
        // 写操作不能弹出终端/GCM 凭据窗口；缺少凭据时明确失败并交给 UI 展示。
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("git 不可用: {error}"))?;
    // A1 死锁修复（2026-08-02）：wait 之前必须真正并发读 stdout/stderr。原实现
    // 把读管道写成 async 块，只在 wait 返回后才 join——两个读 future 在子进程
    // 运行期间从未被 poll，输出超过 OS 管道缓冲（Windows 默认 4096B）时子进程
    // 阻塞在 write 上永不退出 → 必现 10s 超时。这里 take 出管道句柄后用
    // tokio::spawn 启动两个读任务与 wait 并发消费（各自 5s 超时防挂死，
    // 进程退出即 EOF），读任务返回 Vec<u8> 而非共享缓冲。
    // G5-4：读任务从 read_to_end（内存无界，大仓库可 GB 级）改为手动 drain 循环
    // （drain_bounded）：stdout 只保留前 MAX_READ_BYTES、stderr 保留前
    // MAX_STDERR_KEEP_BYTES，超限继续读入丢弃直到 EOF——禁止 take 提前关流
    // （git EPIPE → 误报失败），管道始终被消费（A1 不回归）。
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let read_stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout.as_mut() {
            tokio::time::timeout(Duration::from_secs(5), drain_bounded(out, MAX_READ_BYTES))
                .await
                .unwrap_or_default()
        } else {
            Vec::new()
        }
    });
    let read_stderr_task = tokio::spawn(async move {
        if let Some(err) = stderr.as_mut() {
            tokio::time::timeout(
                Duration::from_secs(5),
                drain_bounded(err, MAX_STDERR_KEEP_BYTES),
            )
            .await
            .unwrap_or_default()
        } else {
            Vec::new()
        }
    });
    // 审查修复：超时必须 kill 子进程（Command::output 默认 kill_on_drop=false，
    // 超时后 git 会滞留并占用 index 锁）。
    let status = match tokio::time::timeout(timeout, async {
        let status = child
            .wait()
            .await
            .map_err(|error| format!("git 命令失败: {error}"))?;
        Ok::<std::process::ExitStatus, String>(status)
    })
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("git 命令超时".to_string());
        }
    };
    let stdout_bytes = read_stdout_task.await.unwrap_or_default();
    let stderr_bytes = read_stderr_task.await.unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
    if !status.success() {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        let detail = detail.chars().take(512).collect::<String>();
        return Err(if is_git_error(&stderr) {
            format!("not a git repository: {detail}")
        } else {
            format!("git 命令失败 ({detail})")
        });
    }
    Ok((stdout, stderr))
}

async fn run_git(cwd: &Path, args: &[&str]) -> Result<(String, String), String> {
    run_git_with_timeout(cwd, args, GIT_TIMEOUT).await
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("至少选择一个文件".to_string());
    }
    if paths.len() > MAX_STATUS_ENTRIES {
        return Err(format!("单次最多处理 {MAX_STATUS_ENTRIES} 个文件"));
    }
    if let Some(path) = paths
        .iter()
        .find(|path| !crate::workspace::is_safe_relative_path(path))
    {
        return Err(format!("Git path 必须是相对路径且不能穿越: {path}"));
    }
    Ok(())
}

fn operation_summary(stdout: &str, fallback: &str) -> String {
    let summary = stdout.trim();
    if summary.is_empty() {
        return fallback.to_string();
    }
    summary.chars().take(2048).collect()
}

async fn operation_result(
    cwd: &Path,
    stdout: &str,
    fallback: &str,
) -> Result<GitOperationResult, String> {
    Ok(GitOperationResult {
        summary: operation_summary(stdout, fallback),
        status: git_status(cwd).await?,
    })
}

/// porcelain v1 的 XY 码转 v2（'.' 表示"无变更"）→ v1 空格表示，保持 wire 兼容。
fn normalize_status_code(xy: &str) -> String {
    xy.chars().map(|c| if c == '.' { ' ' } else { c }).collect()
}

/// porcelain v2 -z 记录（NUL 分隔）的普通条目：`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`。
/// 路径可能含空格 → splitn 限制字段数，末段整体作为路径。
fn parse_regular_entry(rest: &str) -> Option<(String, bool, String)> {
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next()?;
    let path = parts.last().unwrap_or("").to_string();
    if path.is_empty() {
        return None;
    }
    let staged = xy.chars().next().map(|c| c != '.').unwrap_or(false);
    Some((normalize_status_code(xy), staged, path))
}

/// rename/copy 条目：`2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <dst>\0<src>\0`。
/// 返回路径（目标）与"下一记录为 src、需跳过"标记。
fn parse_rename_entry(rest: &str) -> Option<(String, bool, String, bool)> {
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next()?;
    let path = parts.last().unwrap_or("").to_string();
    if path.is_empty() {
        return None;
    }
    let staged = xy.chars().next().map(|c| c != '.').unwrap_or(false);
    Some((normalize_status_code(xy), staged, path, true))
}

/// unmerged 条目：`u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`。
fn parse_unmerged_entry(rest: &str) -> Option<(String, bool, String)> {
    let mut parts = rest.splitn(10, ' ');
    let xy = parts.next()?;
    let path = parts.last().unwrap_or("").to_string();
    if path.is_empty() {
        return None;
    }
    let staged = xy.chars().next().map(|c| c != '.').unwrap_or(false);
    Some((normalize_status_code(xy), staged, path))
}

/// porcelain v2 -z 解析（纯函数，可注入合成输入单测）。
/// 记录以 NUL 分隔；header `# branch.oid <oid>` / `# branch.head <name>`；
/// 条目 `1`/`2`/`u`/`?`/`!`。路径永不加引号：修复 v1 下含符号路径被 C-quote 的失真，
/// 以及 `line[3..].split(" -> ")` 对文件名含 ` -> ` 的误切分。状态码重建为 v1 兼容
/// 两字符（'.' → 空格；untracked/ignored 为 "??"/"!!"）。
fn parse_status_v2(input: &str) -> GitStatusResult {
    let mut branch = GitBranchInfo {
        branch: None,
        detached: false,
        head: None,
    };
    let mut entries = Vec::new();
    let records: Vec<&str> = input.split('\0').collect();
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        i += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.oid ") {
            let oid = rest.trim();
            // unborn 分支（无任何提交）的占位 oid 不构成真实 head
            branch.head = (oid != "(initial)").then(|| oid.to_string());
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.head ") {
            let name = rest.trim();
            if name == "(detached)" {
                branch.branch = None;
                branch.detached = true;
            } else {
                branch.branch = Some(name.to_string());
            }
            continue;
        }
        if entries.len() >= MAX_STATUS_ENTRIES {
            // 超限仍须消费 rename 的 src 记录，避免把 src 误解析成独立条目
            if record.starts_with("2 ") {
                i += 1;
            }
            continue;
        }
        let parsed = if let Some(rest) = record.strip_prefix("? ") {
            Some(("??".to_string(), false, rest.to_string(), false))
        } else if let Some(rest) = record.strip_prefix("! ") {
            Some(("!!".to_string(), false, rest.to_string(), false))
        } else if let Some(rest) = record.strip_prefix("1 ") {
            parse_regular_entry(rest).map(|(s, st, p)| (s, st, p, false))
        } else if let Some(rest) = record.strip_prefix("2 ") {
            parse_rename_entry(rest)
        } else if let Some(rest) = record.strip_prefix("u ") {
            parse_unmerged_entry(rest).map(|(s, st, p)| (s, st, p, false))
        } else {
            None
        };
        let Some((status_code, staged, path, skip_source)) = parsed else {
            continue;
        };
        if skip_source {
            i += 1;
        }
        entries.push(GitStatusEntry {
            path,
            status: status_code,
            staged,
        });
    }
    GitStatusResult { branch, entries }
}

/// 工作区变更列表 + 分支信息（ISSUE-15 W1）：`git status --porcelain=v2 -z --branch`。
/// - v2 -z 以 NUL 分隔、路径永不加引号：修复 v1 下含符号（如 U+2192）路径被
///   C-quote 成 `"a → b.txt"` 导致的路径失真，以及文件名含 ` -> ` 的误切分。
/// - `--branch` header 在同一进程返回 `# branch.oid` / `# branch.head`
///   （detached 为 `(detached)`、无提交时为 `(initial)`），供 GitPanel 展示。
pub async fn git_status(cwd: &Path) -> Result<GitStatusResult, String> {
    let (stdout, _) = run_git(cwd, &["status", "--porcelain=v2", "-z", "--branch"]).await?;
    Ok(parse_status_v2(&stdout))
}

/// 工作区/暂存区 diff：staged=true → `git diff --cached`；否则 `git diff`。
/// path 可选（必须相对且不穿越）。输出截断 MAX_DIFF_BYTES。
pub async fn git_diff(cwd: &Path, path: Option<&str>, staged: bool) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path {
        if !crate::workspace::is_safe_relative_path(path) {
            return Err("diff path 必须是相对路径且不能穿越".to_string());
        }
        args.push("--");
        args.push(path);
    }
    let (stdout, _) = run_git(cwd, &args).await?;
    if stdout.len() <= MAX_DIFF_BYTES {
        return Ok(stdout);
    }
    let mut end = MAX_DIFF_BYTES.saturating_sub(3);
    while end > 0 && !stdout.is_char_boundary(end) {
        end -= 1;
    }
    Ok(format!(
        "{}...（diff 超过 {MAX_DIFF_BYTES} 字节已截断）",
        &stdout[..end]
    ))
}

/// 提交历史：`git log --format=%H%x00%an%x00%at%x00%s`（NUL 分隔字段，行分隔 commit）。
/// 审查修复：limit=0 返回空列表（原实现 max(1) 会错误返回 1 条）。
pub async fn git_history(cwd: &Path, limit: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let limit = match limit {
        Some(0) => return Ok(Vec::new()),
        Some(n) => n.min(MAX_HISTORY),
        None => 50,
    };
    let format = "%H%x00%an%x00%at%x00%s";
    let (stdout, _) = match run_git(
        cwd,
        &["log", &format!("-n{limit}"), &format!("--format={format}")],
    )
    .await
    {
        Ok(result) => result,
        // 空仓库（无任何 commit）视为空历史，而非错误
        Err(error) if error.contains("does not have any commits") => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut commits = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.split('\0');
        let (hash, author, date, subject) = (
            fields.next().unwrap_or("").to_string(),
            fields.next().unwrap_or("").to_string(),
            fields.next().unwrap_or("").to_string(),
            fields.next().unwrap_or("").to_string(),
        );
        if hash.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            hash,
            author,
            date,
            subject,
        });
        if commits.len() >= limit {
            break;
        }
    }
    Ok(commits)
}

/// 将选定的工作区相对路径加入 index。参数通过 `--` 与 git 选项隔离。
pub async fn git_stage(cwd: &Path, paths: &[String]) -> Result<GitOperationResult, String> {
    validate_paths(paths)?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    let (stdout, _) = run_git(cwd, &args).await?;
    operation_result(cwd, &stdout, "已暂存所选文件").await
}

/// 从 index 撤销暂存，但保留工作区内容。
///
/// 有 HEAD 时使用 `restore --staged`；unborn 仓库没有可 restore 的 tree，改用
/// `rm --cached --ignore-unmatch`。两条路径都不暴露 reset，也不删除工作区文件。
pub async fn git_unstage(cwd: &Path, paths: &[String]) -> Result<GitOperationResult, String> {
    validate_paths(paths)?;
    let has_head = git_status(cwd).await?.branch.head.is_some();
    let mut args = if has_head {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "--ignore-unmatch", "--"]
    };
    args.extend(paths.iter().map(String::as_str));
    let (stdout, _) = run_git(cwd, &args).await?;
    operation_result(cwd, &stdout, "已取消暂存所选文件").await
}

/// 提交当前 index。只接受显式非空 message，不打开编辑器。
pub async fn git_commit(cwd: &Path, message: &str) -> Result<GitOperationResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("提交说明不能为空".to_string());
    }
    if message.chars().count() > 10_000 {
        return Err("提交说明不能超过 10000 个字符".to_string());
    }
    let (stdout, _) = run_git(cwd, &["commit", "-m", message]).await?;
    operation_result(cwd, &stdout, "提交成功").await
}

async fn validate_branch_name(cwd: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 255 || name.starts_with('-') {
        return Err("分支名无效".to_string());
    }
    run_git(cwd, &["check-ref-format", "--branch", name])
        .await
        .map_err(|_| "分支名无效".to_string())?;
    Ok(name.to_string())
}

/// 创建并切换到新分支；不提供覆盖已有分支的 `-C` 或强制 checkout。
pub async fn git_create_branch(cwd: &Path, name: &str) -> Result<GitOperationResult, String> {
    let name = validate_branch_name(cwd, name).await?;
    let (stdout, _) = run_git(cwd, &["switch", "-c", &name]).await?;
    operation_result(cwd, &stdout, "已创建并切换分支").await
}

/// 切换到已有本地分支；不提供 `--force`、`--discard-changes` 等破坏性参数。
pub async fn git_switch_branch(cwd: &Path, name: &str) -> Result<GitOperationResult, String> {
    let name = validate_branch_name(cwd, name).await?;
    let (stdout, _) = run_git(cwd, &["switch", "--", &name]).await?;
    operation_result(cwd, &stdout, "已切换分支").await
}

/// 从当前分支配置的 upstream 拉取，仅允许 fast-forward，避免隐式 merge commit。
pub async fn git_pull(cwd: &Path) -> Result<GitOperationResult, String> {
    let (stdout, _) =
        run_git_with_timeout(cwd, &["pull", "--ff-only"], GIT_NETWORK_TIMEOUT).await?;
    operation_result(cwd, &stdout, "已经是最新版本").await
}

/// 推送当前分支到已配置的 upstream。不提供 `--force` / `--force-with-lease`。
pub async fn git_push(cwd: &Path) -> Result<GitOperationResult, String> {
    let (stdout, stderr) = run_git_with_timeout(cwd, &["push"], GIT_NETWORK_TIMEOUT).await?;
    let output = if stdout.trim().is_empty() {
        stderr.as_str()
    } else {
        stdout.as_str()
    };
    operation_result(cwd, output, "推送完成").await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建临时 git 仓库：init + 用户配置 + 初始 commit。
    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@pylon.local"]);
        run(&["config", "user.name", "Pylon Test"]);
    }

    struct TempRepo(std::path::PathBuf);
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_repo(name: &str) -> TempRepo {
        let dir =
            std::env::temp_dir().join(format!("pylon-git-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        init_repo(&dir);
        TempRepo(dir)
    }

    fn run_sync(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git must run");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn write_operations_stage_unstage_and_commit_without_reset() {
        let repo = temp_repo("write-stage-commit");
        std::fs::write(repo.0.join("a file.txt"), "v1").unwrap();

        let staged = git_stage(&repo.0, &["a file.txt".to_string()])
            .await
            .expect("stage must succeed");
        assert!(staged
            .status
            .entries
            .iter()
            .any(|entry| entry.path == "a file.txt" && entry.staged));

        let unstaged = git_unstage(&repo.0, &["a file.txt".to_string()])
            .await
            .expect("unstage in unborn repo must succeed");
        assert!(
            repo.0.join("a file.txt").exists(),
            "unstage 不得删除工作区文件"
        );
        assert!(unstaged
            .status
            .entries
            .iter()
            .any(|entry| entry.path == "a file.txt" && !entry.staged));

        git_stage(&repo.0, &["a file.txt".to_string()])
            .await
            .unwrap();
        let committed = git_commit(&repo.0, "first commit")
            .await
            .expect("commit must succeed");
        assert!(committed.status.entries.is_empty());
        assert_eq!(
            run_sync(&repo.0, &["log", "-1", "--format=%s"]),
            "first commit"
        );

        std::fs::write(repo.0.join("a file.txt"), "v2").unwrap();
        git_stage(&repo.0, &["a file.txt".to_string()])
            .await
            .unwrap();
        let unstaged = git_unstage(&repo.0, &["a file.txt".to_string()])
            .await
            .expect("unstage with HEAD must succeed");
        assert!(unstaged
            .status
            .entries
            .iter()
            .any(|entry| entry.path == "a file.txt" && !entry.staged));
    }

    #[tokio::test]
    async fn write_operations_reject_unsafe_paths_and_empty_commit() {
        let repo = temp_repo("write-validation");
        for path in ["../outside", "C:\\Windows\\x", ""] {
            let error = git_stage(&repo.0, &[path.to_string()])
                .await
                .expect_err("unsafe path must fail before git");
            assert!(error.contains("相对路径"), "unexpected error: {error}");
        }
        assert!(git_stage(&repo.0, &[]).await.is_err());
        assert!(git_commit(&repo.0, "   ").await.is_err());
    }

    #[tokio::test]
    async fn branch_operations_create_and_switch_without_force() {
        let repo = temp_repo("write-branches");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);
        let initial = git_status(&repo.0).await.unwrap().branch.branch.unwrap();

        let created = git_create_branch(&repo.0, "feature/safe")
            .await
            .expect("create branch must succeed");
        assert_eq!(
            created.status.branch.branch.as_deref(),
            Some("feature/safe")
        );
        let switched = git_switch_branch(&repo.0, &initial)
            .await
            .expect("switch branch must succeed");
        assert_eq!(
            switched.status.branch.branch.as_deref(),
            Some(initial.as_str())
        );
        for invalid in ["-force", "bad..name", "bad~name"] {
            assert!(git_create_branch(&repo.0, invalid).await.is_err());
        }
    }

    #[tokio::test]
    async fn pull_and_push_use_configured_upstream_without_force() {
        let seed = temp_repo("network-seed");
        std::fs::write(seed.0.join("shared.txt"), "v1").unwrap();
        run_sync(&seed.0, &["add", "shared.txt"]);
        run_sync(&seed.0, &["commit", "-q", "-m", "init"]);

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let remote_path = std::env::temp_dir().join(format!(
            "pylon-git-test-network-remote-{}-{nonce}",
            std::process::id()
        ));
        let clone_path = std::env::temp_dir().join(format!(
            "pylon-git-test-network-clone-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&remote_path).unwrap();
        run_sync(&remote_path, &["init", "--bare", "-q"]);
        let remote = remote_path.to_string_lossy().into_owned();
        run_sync(&seed.0, &["remote", "add", "origin", &remote]);
        run_sync(&seed.0, &["push", "-q", "-u", "origin", "HEAD"]);

        let clone_parent = clone_path.parent().unwrap();
        let clone_name = clone_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        run_sync(clone_parent, &["clone", "-q", &remote, &clone_name]);
        run_sync(&clone_path, &["config", "user.email", "test@pylon.local"]);
        run_sync(&clone_path, &["config", "user.name", "Pylon Test"]);

        std::fs::write(seed.0.join("shared.txt"), "v2").unwrap();
        run_sync(&seed.0, &["add", "shared.txt"]);
        run_sync(&seed.0, &["commit", "-q", "-m", "seed update"]);
        git_push(&seed.0).await.expect("push must succeed");
        git_pull(&clone_path)
            .await
            .expect("pull --ff-only must succeed");
        assert_eq!(
            std::fs::read_to_string(clone_path.join("shared.txt")).unwrap(),
            "v2"
        );

        std::fs::write(clone_path.join("clone.txt"), "from clone").unwrap();
        run_sync(&clone_path, &["add", "clone.txt"]);
        run_sync(&clone_path, &["commit", "-q", "-m", "clone update"]);
        git_push(&clone_path).await.expect("push must succeed");
        assert_eq!(
            run_sync(&clone_path, &["rev-parse", "HEAD"]),
            run_sync(&remote_path, &["rev-parse", "HEAD"])
        );

        std::fs::remove_dir_all(&clone_path).ok();
        std::fs::remove_dir_all(&remote_path).ok();
    }

    #[tokio::test]
    async fn status_lists_modified_and_untracked() {
        let repo = temp_repo("status");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();
        std::fs::write(repo.0.join("new.txt"), "x").unwrap();

        let result = git_status(&repo.0).await.expect("status must succeed");
        let modified = result
            .entries
            .iter()
            .find(|e| e.path == "a.txt")
            .expect("modified entry");
        assert_eq!(modified.status, " M");
        assert!(!modified.staged);
        let untracked = result
            .entries
            .iter()
            .find(|e| e.path == "new.txt")
            .expect("untracked entry");
        assert_eq!(untracked.status, "??");
    }

    // ── ISSUE-15 W1：porcelain v1 解析协议缺陷的 RED 证据已实现前捕获 ──
    // （v1 解析器已删除；以下集成与合成测试锁定的契约在 v2 -z 下必须保持）

    #[tokio::test]
    async fn status_keeps_unicode_symbol_path_unquoted() {
        // 集成 RED：真实仓库中的 Unicode 符号路径（Windows 可创建），git_status
        // 返回的 path 不得带引号（v1 实测输出 `?? "a → b.txt"`，当前实现失真）。
        let repo = temp_repo("unicode-symbol");
        std::fs::write(repo.0.join("a → b.txt"), "c").unwrap();
        let result = git_status(&repo.0).await.expect("status must succeed");
        let entry = result
            .entries
            .iter()
            .find(|e| e.path == "a → b.txt")
            .expect("unicode symbol entry");
        assert_eq!(entry.status, "??");
        assert!(
            !entry.path.starts_with('"'),
            "路径不得带引号: {}",
            entry.path
        );
    }

    // ── ISSUE-15 W1：porcelain v2 -z 解析 + branch/detached DTO ──

    #[test]
    fn parse_status_v2_handles_all_record_kinds() {
        // 合成 NUL 记录：覆盖 header、空格路径、rename（目标+src 下一条）、
        // unmerged、untracked（含换行/制表符路径——Windows 文件系统不可真实创建）、
        // ignored。路径均无引号。
        let input = "\
# branch.oid 0123456789abcdef0123456789abcdef01234567\0\
# branch.head feature/x\0\
1 .M N... 100644 100644 100644 1111111 2222222 a file with spaces.txt\0\
2 R. N... 100644 100644 100644 1111111 2222222 R100 dst name.txt\0src name.txt\0\
u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflicted file.txt\0\
? a -> b.txt\0\
? new\nline.txt\0\
? tab\tfile.txt\0\
! ignored dir/\0\
";
        let result = parse_status_v2(input);
        assert_eq!(
            result.branch.head.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(result.branch.branch.as_deref(), Some("feature/x"));
        assert!(!result.branch.detached);

        let entries = &result.entries;
        assert_eq!(entries.len(), 7);
        assert_eq!(entries[0].path, "a file with spaces.txt");
        assert_eq!(entries[0].status, " M");
        assert!(!entries[0].staged);
        assert_eq!(entries[1].path, "dst name.txt");
        assert_eq!(entries[1].status, "R ");
        assert!(entries[1].staged);
        assert_eq!(entries[2].path, "conflicted file.txt");
        assert_eq!(entries[2].status, "UU");
        assert!(entries[2].staged);
        // v2 -z 路径永不加引号、不按 " -> " 误切分（v1 缺陷的等价契约）
        assert_eq!(entries[3].path, "a -> b.txt");
        assert_eq!(entries[3].status, "??");
        assert_eq!(entries[4].path, "new\nline.txt");
        assert_eq!(entries[4].status, "??");
        assert_eq!(entries[5].path, "tab\tfile.txt");
        assert_eq!(entries[5].status, "??");
        assert_eq!(entries[6].path, "ignored dir/");
        assert_eq!(entries[6].status, "!!");
    }

    #[test]
    fn parse_status_v2_parses_detached_and_unborn_headers() {
        let detached = parse_status_v2("# branch.oid abcdef\0# branch.head (detached)\0");
        assert!(detached.branch.detached);
        assert!(detached.branch.branch.is_none());
        assert_eq!(detached.branch.head.as_deref(), Some("abcdef"));

        // unborn 分支：oid 为 (initial)，不构成真实 head
        let unborn = parse_status_v2("# branch.oid (initial)\0# branch.head master\0");
        assert!(!unborn.branch.detached);
        assert_eq!(unborn.branch.branch.as_deref(), Some("master"));
        assert!(unborn.branch.head.is_none());
    }

    #[test]
    fn parse_status_v2_keeps_entry_cap_and_consumes_rename_source() {
        // MAX_STATUS_ENTRIES 超限后仍须消费 rename 的 src 记录，不得误解析成条目
        let mut records = String::new();
        for n in 0..(MAX_STATUS_ENTRIES + 2) {
            records.push_str(&format!("1 M. N... 100644 100644 100644 x x file{n}.txt\0"));
        }
        records.push_str("2 R. N... 100644 100644 100644 x x R100 final.txt\0src.txt\0");
        let result = parse_status_v2(&records);
        assert_eq!(result.entries.len(), MAX_STATUS_ENTRIES);
        assert!(
            !result.entries.iter().any(|e| e.path == "src.txt"),
            "rename src 不得被解析成独立条目"
        );
    }

    #[tokio::test]
    async fn status_reports_current_branch_and_head() {
        let repo = temp_repo("branch");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);

        let result = git_status(&repo.0).await.expect("status must succeed");
        assert!(!result.branch.detached);
        assert!(result.branch.branch.is_some(), "非 detached 必须有分支名");
        let head = result.branch.head.expect("有提交必须有 head oid");
        assert_eq!(head.len(), 40, "head 应为完整 40 位 oid: {head}");
    }

    #[tokio::test]
    async fn status_reports_detached_head() {
        let repo = temp_repo("detached");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        run(&["checkout", "-q", "--detach"]);

        let result = git_status(&repo.0).await.expect("status must succeed");
        assert!(result.branch.detached, "detached HEAD 必须标记");
        assert!(result.branch.branch.is_none(), "detached 无分支名");
        assert!(result.branch.head.is_some(), "detached 仍有 head oid");
    }

    #[tokio::test]
    async fn status_reports_unborn_branch_without_head() {
        let repo = temp_repo("unborn");
        let result = git_status(&repo.0).await.expect("status must succeed");
        assert!(!result.branch.detached);
        assert!(result.branch.branch.is_some(), "unborn 分支有默认分支名");
        assert!(result.branch.head.is_none(), "无提交时 head 必须为 None");
    }

    #[tokio::test]
    async fn status_reports_rename_destination() {
        let repo = temp_repo("rename");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        run(&["mv", "a.txt", "new name.txt"]);

        let result = git_status(&repo.0).await.expect("status must succeed");
        let entry = result
            .entries
            .iter()
            .find(|e| e.path == "new name.txt")
            .expect("renamed entry");
        assert_eq!(entry.status, "R ", "rename 状态码须 v1 兼容");
        assert!(entry.staged, "git mv 后的 rename 视为 staged");
    }

    // ── ISSUE-15 W2 RED fixtures：git path 守卫缺 Windows 盘符/冒号检查（修复前必须失败）──
    // 原 is_relative_safe_path 只拒 NUL/空/absolute/../..；`C:\x` 归一化为
    // `C:/x` 不命中任何规则 → 放行（原集成测试 is_err 靠 git 自己拒绝越界
    // pathspec，正违反 ISSUE-15"禁止依赖 git 拒绝越界 pathspec 作为安全边界"）。
    // 修复后守卫为 workspace 共享谓词 is_safe_relative_path（git.rs 与 workspace.rs 同源）。

    #[test]
    fn path_guard_rejects_windows_drive_paths() {
        for bad in ["C:\\Windows\\x", "C:/Windows/x", "C:relative.txt"] {
            assert!(
                !crate::workspace::is_safe_relative_path(bad),
                "守卫必须拒绝 Windows 盘符路径: {bad:?}"
            );
        }
        // 已正确处理的不回归钉：UNC / Windows Prefix / absolute / traversal / NUL / 空
        for bad in [
            "\\\\server\\share\\x",
            "//server/share/x",
            "\\\\?\\C:\\x",
            "//?/C:/x",
            "/absolute/path",
            "../outside",
            "a/../../outside",
            "a\0b.txt",
            "  ",
        ] {
            assert!(
                !crate::workspace::is_safe_relative_path(bad),
                "应拒绝: {bad:?}"
            );
        }
        for good in ["a.txt", "dir/a b.txt", "测试/文件.txt", "a/./b.txt"] {
            assert!(
                crate::workspace::is_safe_relative_path(good),
                "应放行: {good:?}"
            );
        }
    }

    #[tokio::test]
    async fn diff_rejects_drive_paths_at_guard_not_git() {
        // 集成 RED：drive 路径必须在我们的守卫层拒绝（错误消息来自守卫），
        // 而不是依赖 git 报 "outside repository"。
        let repo = temp_repo("path-guard");
        let error = git_diff(&repo.0, Some("C:\\Windows\\x"), false)
            .await
            .expect_err("drive 路径必须在守卫层拒绝");
        assert!(
            error.contains("必须是相对路径"),
            "错误必须来自我们的守卫而非 git: {error}"
        );
    }

    #[tokio::test]
    async fn diff_reports_workspace_changes_and_respects_path_guard() {
        let repo = temp_repo("diff");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();

        let diff = git_diff(&repo.0, None, false)
            .await
            .expect("diff must succeed");
        assert!(diff.contains("-v1"), "diff 应含旧内容");
        assert!(diff.contains("+v2"), "diff 应含新内容");
        // 路径守卫：穿越路径拒绝
        assert!(git_diff(&repo.0, Some("../outside"), false).await.is_err());
        assert!(git_diff(&repo.0, Some("C:\\Windows\\x"), false)
            .await
            .is_err());
        // 限定路径：命中
        let scoped = git_diff(&repo.0, Some("a.txt"), false)
            .await
            .expect("scoped diff");
        assert!(scoped.contains("+v2"));
    }

    #[tokio::test]
    async fn history_returns_commits_newest_first() {
        let repo = temp_repo("history");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "first"]);
        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "second"]);

        let commits = git_history(&repo.0, Some(10))
            .await
            .expect("history must succeed");
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second");
        assert_eq!(commits[1].subject, "first");
        assert_eq!(commits[0].author, "Pylon Test");
        assert!(!commits[0].hash.is_empty());
        assert!(!commits[0].date.is_empty());
    }

    #[tokio::test]
    async fn history_zero_limit_returns_empty() {
        // 审查修复回归：limit=0 返回空，而非 1 条
        let repo = temp_repo("limit-zero");
        let commits = git_history(&repo.0, Some(0))
            .await
            .expect("zero limit must succeed");
        assert!(commits.is_empty(), "limit=0 必须返回空列表");
        // None → 默认 50（空仓库也为空但成功）
        let commits = git_history(&repo.0, None)
            .await
            .expect("default limit must succeed");
        assert!(commits.is_empty());
    }

    #[tokio::test]
    async fn non_git_directory_returns_clear_error() {
        let dir = std::env::temp_dir().join(format!("pylon-git-nonrepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let error = git_status(&dir).await.expect_err("non-repo must fail");
        assert!(
            error.contains("not a git repository"),
            "错误应明确非 git 仓库: {error}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn locale_override_keeps_english_error_detection() {
        // G5-5：宿主 locale 非 C 时 git 文案可能本地化——run_git 固定 LC_ALL/LANG=C
        // （子进程继承覆盖，不 env_clear）。本机 git 构建对 locale 无感知（实测
        // zh_CN 仍英文），故本测试钉住可观测契约：宿主 locale 被设为 zh_CN 时，
        // 非 git 目录错误仍命中 is_git_error 的英文检测（在 locale 感知的 git
        // 构建上该测试修复前必失败、修复后通过；本机为契约钉）。限制记录：
        // run_git 不支持注入命令/环境参数（Command::new("git") 固定），机制级
        // 直测（PATH 前置 fake git）已实测不可行（std 对无扩展名程序按 .exe
        // 解析，.bat 不命中）且会污染并行测试的 PATH——采用方案 G5-5 兜底形态。
        let dir = std::env::temp_dir().join(format!("pylon-git-nonrepo-zh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("LC_ALL", "zh_CN.UTF-8");
        std::env::set_var("LANG", "zh_CN.UTF-8");
        let error = git_status(&dir).await.expect_err("non-repo must fail");
        std::env::remove_var("LC_ALL");
        std::env::remove_var("LANG");
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            error.contains("not a git repository"),
            "宿主 locale 覆盖下错误检测必须仍走英文: {error}"
        );
    }

    #[tokio::test]
    async fn git_diff_large_output_does_not_deadlock() {
        // A1 回归：输出超过 OS 管道缓冲（Windows 4096B）时，读任务必须与 wait
        // 并发——否则 git 阻塞在写管道上永不退出，10s 必超时。全行改写使 diff
        // 输出 ~2MB（远超 MAX_DIFF_BYTES），同时验证截断标记。
        let repo = temp_repo("large-diff");
        let line = "line_aaaaaaaaaa_bbbbbbbbbb_cccccccccc_dddddddddd_eeeeeeeeee\n";
        let old = line.repeat(20_000);
        std::fs::write(repo.0.join("big.txt"), &old).unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "big.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        let new = line.repeat(20_000).replace('a', "x");
        std::fs::write(repo.0.join("big.txt"), &new).unwrap();

        let diff = git_diff(&repo.0, None, false)
            .await
            .expect("large diff must succeed within timeout");
        assert!(
            diff.contains("已截断"),
            "超过 {MAX_DIFF_BYTES} 的输出必须截断"
        );
    }

    #[tokio::test]
    async fn oversized_output_is_bounded_keeps_head_and_marker() {
        // G5-4（E17）：>16MB 输出——run_git 读任务有界化：直接调 run_git 断言
        // 返回 stdout ≤ MAX_READ_BYTES（内存有界）且保留头部（不是尾部）；git_diff
        // 的截断标记文案不变。若回归为 read_to_end 或 take 提前关流：前者返回
        // 18MB+ 全量（断言失败），后者 git EPIPE 误报失败（expect 失败）。
        let repo = temp_repo("oversize-diff");
        let line = "line_aaaaaaaaaa_bbbbbbbbbb_cccccccccc_dddddddddd_eeeeeeeeee\n";
        // 150k 行 ≈ 9MB/侧：diff 输出 ≈ 18MB > MAX_READ_BYTES(16MB)
        let old = line.repeat(150_000);
        std::fs::write(repo.0.join("huge.txt"), &old).unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "huge.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        let new = line.repeat(150_000).replace('a', "x");
        std::fs::write(repo.0.join("huge.txt"), &new).unwrap();

        let (stdout, _) = run_git(&repo.0, &["diff", "--", "huge.txt"])
            .await
            .expect(">16MB 输出不得因 EPIPE/超时误报失败");
        assert!(
            stdout.len() <= MAX_READ_BYTES,
            "run_git 输出必须 ≤ MAX_READ_BYTES（内存有界），实际 {}",
            stdout.len()
        );
        assert!(
            stdout.starts_with("diff --git"),
            "超限输出必须保留头部（E17），实际前缀: {}",
            &stdout[..stdout.len().min(40)]
        );
        let diff = git_diff(&repo.0, None, false)
            .await
            .expect("git_diff 超限场景必须成功");
        assert!(diff.contains("已截断"), "截断标记文案必须仍在（E17）");
    }
}
