//! Hermes profile 探测与解析（release-issues #1 方案 G 的演进替代）。
//!
//! 目标：让 agents.yaml 的 `hermes_profile` 字段以「profile 名称或路径」表达
//! 要固定的 Hermes profile，而不是把本机绝对路径硬编码进仓库配置。
//!
//! 背景（查证结论）：Pylon 用 `exe: hermes` 启动 Hermes ACP 子进程时，Windows
//! 会命中 PATH 里的 `hermes.bat` 包装脚本——它设置了 `HERMES_HOME` 但**不带
//! `-p` 参数**，因此 Hermes 走 active_profile 机制（当前机器为 `l-m`，其
//! provider=root config 的 `nous`），而可用 profile `riccati`（deepseek +
//! opencode.ai）未被使用，表现为「有余额但 401/无回应」。
//!
//! 本模块提供：
//! - [`detect_hermes_home`]：探测 Hermes 根目录（环境变量 / PATH 脚本内容 /
//!   平台默认），供 `hermes_profile: <名称>` 解析。
//! - [`list_profiles`]：列出 `<home>/profiles/*` 下的可用 profile 名（诊断/UI）。
//! - [`resolve_profile_dir`]：把 `hermes_profile` 字段解析为绝对 profile 目录
//!   （名称 → `<home>/profiles/<name>`；路径原样/相对 base_dir 解析）。
//! - [`hermes_home_override`]：由 AgentDef 计算应注入子进程的 `HERMES_HOME`。

use crate::agent_config::AgentDef;
use std::path::{Path, PathBuf};

/// 解析后的 profile 目录（存在性校验在调用方做；本函数只做路径拼接/规范化）。
fn join_profile_dir(home: &Path, profile: &str) -> PathBuf {
    home.join("profiles").join(profile)
}

/// 探测 Hermes 根目录：优先 `HERMES_HOME` 环境变量，其次解析 PATH 中
/// `hermes` 启动脚本（Windows 为 `hermes.bat`，含 `set HERMES_HOME=...`），
/// 最后回退平台默认（Windows `%LOCALAPPDATA%\hermes` / Unix `~/.hermes`）。
/// 全部不可用时返回 None——调用方按「不注入」处理（现状行为）。
pub fn detect_hermes_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HERMES_HOME") {
        let home = PathBuf::from(home);
        if home.is_dir() {
            return Some(home);
        }
    }
    if let Some(home) = hermes_home_from_path_script() {
        if home.is_dir() {
            return Some(home);
        }
    }
    platform_default_home().filter(|home| home.is_dir())
}

/// 从 PATH 中的 `hermes` 启动脚本提取 `HERMES_HOME`。
/// 兼容三种形态：`set HERMES_HOME=...`（Windows bat）、
/// `HERMES_HOME="..."` / `HERMES_HOME=...`（bash 包装）。
fn hermes_home_from_path_script() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in ["hermes.bat", "hermes.cmd", "hermes"] {
            let script = dir.join(candidate);
            if !script.is_file() {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&script) {
                if let Some(home) = parse_hermes_home(&content) {
                    return Some(PathBuf::from(home));
                }
            }
        }
    }
    None
}

/// 从脚本文本解析 `HERMES_HOME`（纯函数，便于单测）。
fn parse_hermes_home(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        let rest = trimmed
            .strip_prefix("set HERMES_HOME=")
            .or_else(|| trimmed.strip_prefix("HERMES_HOME="))
            .or_else(|| {
                // bash 形态：export HERMES_HOME="..."（= 后即值）
                trimmed.strip_prefix("export HERMES_HOME=")
            });
        if let Some(value) = rest {
            let value = value.trim();
            // bash 形态 `HERMES_HOME="F:/Hermes" exec ...`：取第一个引号对内的
            // 内容或第一个空白前的 token（Windows 路径可含空格，引号对优先）。
            let parsed = if value.starts_with('"') {
                value
                    .split('"')
                    .nth(1)
                    .map(|token| token.to_string())
            } else if value.starts_with('\'') {
                value
                    .split('\'')
                    .nth(1)
                    .map(|token| token.to_string())
            } else {
                value
                    .split_whitespace()
                    .next()
                    .map(|token| token.to_string())
            };
            if let Some(parsed) = parsed {
                if !parsed.is_empty() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

/// 平台默认 Hermes 根目录（Windows `%LOCALAPPDATA%\hermes` / Unix `~/.hermes`，
/// 与 Hermes 自身 `get_hermes_home()` 的平台默认一致）。
fn platform_default_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let home = PathBuf::from(local_appdata).join("hermes");
            if home.is_dir() {
                return Some(home);
            }
        }
        std::env::var_os("USERPROFILE").map(|profile| PathBuf::from(profile).join(".hermes"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".hermes"))
    }
}

/// 列出 `<home>/profiles/*` 下的可用 profile 名（目录，不含隐藏项），排序输出。
/// 不存在/不可读时返回空列表。
pub fn list_profiles(home: &Path) -> Vec<String> {
    let profiles_dir = home.join("profiles");
    let Ok(entries) = std::fs::read_dir(&profiles_dir) else {
        return Vec::new();
    };
    let mut profiles: Vec<String> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry
                .file_type()
                .map(|ty| ty.is_dir())
                .unwrap_or(false);
            if is_dir && !name.starts_with('.') {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    profiles.sort();
    profiles
}

/// 把 `hermes_profile` 字段解析为绝对 profile 目录路径：
/// - 未设置 → None（调用方不注入）。
/// - 值含路径分隔符 → 视为路径：绝对路径原样；相对路径按配置目录(base_dir)解析。
/// - 纯名称 → `<detect_hermes_home()>/profiles/<name>`；探测不到 home 时返回
///   None（调用方回退不注入，并记录诊断）。
pub fn resolve_profile_dir(
    agent: &AgentDef,
    base_dir: Option<&Path>,
) -> Option<PathBuf> {
    let profile = agent.hermes_profile.as_deref()?;
    let candidate = Path::new(profile);
    let is_path_like = candidate.components().count() > 1 || candidate.is_absolute();
    if is_path_like {
        let resolved = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            base_dir
                .map(|dir| dir.join(candidate))
                .unwrap_or_else(|| candidate.to_path_buf())
        };
        return Some(resolved);
    }
    let home = detect_hermes_home()?;
    Some(join_profile_dir(&home, profile))
}

/// 计算应注入 ACP 子进程的 `HERMES_HOME` 值（AgentDef + 配置基准目录）。
/// 返回 Some 时调用方 `cmd.env("HERMES_HOME", value)`；None 不注入。
/// 结果目录存在性校验：`hermes_profile` 显式指定但目录不存在时仍返回
/// Some（让子进程启动/报错自然暴露），避免静默吞掉配置意图——校验交给
/// 上层（spawn 失败会给出明确错误）。
pub fn hermes_home_override(agent: &AgentDef, base_dir: Option<&Path>) -> Option<String> {
    resolve_profile_dir(agent, base_dir).map(|dir| dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn agent_with_profile(profile: Option<&str>) -> AgentDef {
        AgentDef {
            name: "hermes".to_string(),
            transport: "subprocess".to_string(),
            exe: "hermes".to_string(),
            args: vec!["acp".to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: true,
            model: None,
            hermes_profile: profile.map(str::to_string),
            acp_args: Vec::new(),
            acp: None,
        }
    }

    #[test]
    fn parses_hermes_home_from_bat_script() {
        let content = "@echo off\r\nset HERMES_HOME=F:\\Hermes\r\npython hermes %*\r\n";
        assert_eq!(parse_hermes_home(content).as_deref(), Some("F:\\Hermes"));
    }

    #[test]
    fn parses_hermes_home_from_bash_script() {
        let content = "#!/usr/bin/env bash\nHERMES_HOME=\"F:/Hermes\" exec python hermes \"$@\"\n";
        assert_eq!(parse_hermes_home(content).as_deref(), Some("F:/Hermes"));
    }

    #[test]
    fn parses_hermes_home_with_export_and_quotes() {
        let content = "#!/usr/bin/env bash\nexport HERMES_HOME='/opt/hermes'\n";
        assert_eq!(parse_hermes_home(content).as_deref(), Some("/opt/hermes"));
    }

    #[test]
    fn parse_hermes_home_absent_returns_none() {
        assert_eq!(parse_hermes_home("echo hi\n"), None);
        assert_eq!(parse_hermes_home(""), None);
    }

    #[test]
    fn profile_name_resolves_under_detected_home() {
        // HERMES_HOME env 指向临时目录 → 名称解析为 <home>/profiles/riccati
        let dir = std::env::temp_dir().join(format!("pylon-hermes-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("profiles")).unwrap();
        // env 在测试进程内短暂设置（Rust 1.97 仍无 thread-local set_var；串行测试安全）
        std::env::set_var("HERMES_HOME", &dir);
        let agent = agent_with_profile(Some("riccati"));
        let resolved = resolve_profile_dir(&agent, None).expect("must resolve via env home");
        assert_eq!(
            resolved,
            dir.join("profiles").join("riccati"),
            "名称形态必须解析为 <home>/profiles/<name>"
        );
        std::env::remove_var("HERMES_HOME");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn absolute_profile_path_is_used_verbatim() {
        let agent = agent_with_profile(Some("F:/Hermes/profiles/riccati"));
        let resolved = resolve_profile_dir(&agent, None).expect("absolute path");
        assert_eq!(resolved, PathBuf::from("F:/Hermes/profiles/riccati"));
    }

    #[test]
    fn relative_profile_path_resolves_against_base_dir() {
        let agent = agent_with_profile(Some("profiles/riccati"));
        let resolved = resolve_profile_dir(&agent, Some(Path::new("C:/apps/pylon")))
            .expect("relative path");
        assert_eq!(resolved, PathBuf::from("C:/apps/pylon/profiles/riccati"));
    }

    #[test]
    fn unset_profile_yields_none() {
        let agent = agent_with_profile(None);
        assert!(resolve_profile_dir(&agent, None).is_none());
    }

    #[test]
    fn list_profiles_returns_sorted_dirs_only() {
        let dir = std::env::temp_dir().join(format!("pylon-hermes-list-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("profiles")).unwrap();
        for name in ["riccati", "l-m", "shared"] {
            std::fs::create_dir_all(dir.join("profiles").join(name)).unwrap();
        }
        std::fs::create_dir_all(dir.join("profiles").join(".hidden")).unwrap();
        std::fs::write(dir.join("profiles").join("file.txt"), "x").unwrap();
        let profiles = list_profiles(&dir);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(profiles, vec!["l-m", "riccati", "shared"]);
    }
}
