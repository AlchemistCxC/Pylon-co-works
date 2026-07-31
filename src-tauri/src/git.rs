//! Git 只读接口（B5）：固定 runner → status → diff → history。
//!
//! 安全面：
//! - 命令以参数数组执行（无 shell 拼接，防注入）
//! - 固定 cwd（调用方传入已校验的工作区 root）
//! - diff 的 path 参数做相对路径 + containment 校验（复用 workspace 语义）
//! - 输出截断（diff 256KB / status 2000 条 / history 200 条）
//! - tokio process + 超时（大仓库防挂起）
//! - 非 git 仓库 / git 不可用 → 明确错误（code=git_error）
//!
//! 只读保证：仅使用 status/diff/log 命令，无任何写操作。

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    /// porcelain 状态码（如 "M"/"A"/"??"；staged 状态带 X=Y 两字符码）。
    pub status: String,
    /// 是否已暂存（索引区变更）。
    pub staged: bool,
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

fn is_git_error(stderr: &str) -> bool {
    stderr.contains("not a git repository") || stderr.contains("Not a git repository")
}

fn is_relative_safe_path(path: &str) -> bool {
    if path.trim().is_empty() || path.contains('\0') {
        return false;
    }
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        return false;
    }
    if normalized.split('/').any(|part| part == "..") {
        return false;
    }
    true
}

async fn run_git(cwd: &Path, args: &[&str]) -> Result<(String, String), String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(GIT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "git 命令超时".to_string())?
        .map_err(|error| format!("git 不可用: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let detail = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        let detail = detail.chars().take(512).collect::<String>();
        return Err(if is_git_error(&stderr) {
            format!("not a git repository: {detail}")
        } else {
            format!("git 命令失败 ({detail})")
        });
    }
    Ok((stdout, stderr))
}

/// 工作区变更列表：`git status --porcelain=v1`（行格式 `XY path`，重命名 `-> new`）。
pub async fn git_status(cwd: &Path) -> Result<Vec<GitStatusEntry>, String> {
    let (stdout, _) = run_git(cwd, &["status", "--porcelain=v1"]).await?;
    let mut entries = Vec::new();
    for line in stdout.lines() {
        if entries.len() >= MAX_STATUS_ENTRIES {
            break;
        }
        let bytes = line.as_bytes();
        if bytes.len() < 4 {
            continue;
        }
        let status = line[..2].to_string();
        let staged = !status.starts_with("??") && !status.starts_with("!!") && status.as_bytes()[0] != b' ';
        let path = line[3..].split(" -> ").last().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }
        entries.push(GitStatusEntry { path, status, staged });
    }
    Ok(entries)
}

/// 工作区/暂存区 diff：staged=true → `git diff --cached`；否则 `git diff`。
/// path 可选（必须相对且不穿越）。输出截断 MAX_DIFF_BYTES。
pub async fn git_diff(cwd: &Path, path: Option<&str>, staged: bool) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path {
        if !is_relative_safe_path(path) {
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
    Ok(format!("{}...（diff 超过 {MAX_DIFF_BYTES} 字节已截断）", &stdout[..end]))
}

/// 提交历史：`git log --format=%H%x00%an%x00%at%x00%s`（NUL 分隔字段，行分隔 commit）。
pub async fn git_history(cwd: &Path, limit: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let limit = limit.unwrap_or(50).min(MAX_HISTORY).max(1);
    let format = "%H%x00%an%x00%at%x00%s";
    let (stdout, _) = run_git(cwd, &["log", &format!("-n{limit}"), &format!("--format={format}")]).await?;
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
        commits.push(GitCommit { hash, author, date, subject });
        if commits.len() >= limit {
            break;
        }
    }
    Ok(commits)
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
        let dir = std::env::temp_dir().join(format!("pylon-git-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        init_repo(&dir);
        TempRepo(dir)
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

        let entries = git_status(&repo.0).await.expect("status must succeed");
        let modified = entries.iter().find(|e| e.path == "a.txt").expect("modified entry");
        assert_eq!(modified.status, " M");
        assert!(!modified.staged);
        let untracked = entries.iter().find(|e| e.path == "new.txt").expect("untracked entry");
        assert_eq!(untracked.status, "??");
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

        let diff = git_diff(&repo.0, None, false).await.expect("diff must succeed");
        assert!(diff.contains("-v1"), "diff 应含旧内容");
        assert!(diff.contains("+v2"), "diff 应含新内容");
        // 路径守卫：穿越路径拒绝
        assert!(git_diff(&repo.0, Some("../outside"), false).await.is_err());
        assert!(git_diff(&repo.0, Some("C:\\Windows\\x"), false).await.is_err());
        // 限定路径：命中
        let scoped = git_diff(&repo.0, Some("a.txt"), false).await.expect("scoped diff");
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

        let commits = git_history(&repo.0, Some(10)).await.expect("history must succeed");
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second");
        assert_eq!(commits[1].subject, "first");
        assert_eq!(commits[0].author, "Pylon Test");
        assert!(!commits[0].hash.is_empty());
        assert!(!commits[0].date.is_empty());
    }

    #[tokio::test]
    async fn non_git_directory_returns_clear_error() {
        let dir = std::env::temp_dir().join(format!("pylon-git-nonrepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let error = git_status(&dir).await.expect_err("non-repo must fail");
        assert!(error.contains("not a git repository"), "错误应明确非 git 仓库: {error}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
