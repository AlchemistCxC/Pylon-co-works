//! Pure Windows launch planner (P62 A2).
//!
//! One function turns *catalog recipe + live detection + explicit overrides*
//! into a [`LaunchPlan`]. The ACP engine then consumes that plan instead of
//! assembling `exe`/args/cwd/env inline, so the same plan backs both the
//! settings connection test and a real session — and a new provider needs
//! catalog data and a closed strategy id, never a new branch in the spawn path.
//!
//! Everything here is pure: no process is spawned, no environment is read, no
//! installer, login or cache exists in this path. Runtime values that cannot be
//! computed offline (a managed runtime's PATH, a located Git Bash) are supplied
//! by the caller as explicit plan inputs and stay visible in the plan.

use crate::agent_catalog::{
    CatalogAdapterRelation, CatalogLaunchKind, CatalogLaunchProfile, PylonAgentProfile,
};
use serde::Serialize;
use std::fmt;

/// What detection already proved about this provider. `None` means "not probed",
/// which is distinct from "probed and absent".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchDetection {
    /// Absolute path detection resolved for the declared ACP command.
    pub resolved_executable: Option<String>,
    pub acp_present: bool,
    pub native_present: bool,
}

/// Explicit launch values Pylon already holds (per-agent `agents.yaml`, or the
/// settings candidate under test). `Some(vec![])` means "no arguments", which is
/// different from `None` = "inherit the catalog recipe".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchOverrides {
    pub executable: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    /// Per-agent environment, applied in CLI order before runtime additions.
    pub env: Vec<(String, String)>,
    /// Environment contributed by a runtime adapter (managed runtime, profile
    /// home). Applied after `env` so an adapter wins the same key, matching the
    /// historical "runtimes set last" precedence.
    pub runtime_env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LaunchPlanSource {
    /// The user configured this agent; catalog values are not consulted.
    Explicit,
    /// No explicit executable: the catalog recipe drives the plan.
    CatalogRecipe,
}

/// Redaction-safe launch note. Never carries an environment value, a credential
/// or a resolved token — only the fact that something was applied.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlanDiagnostic {
    pub code: String,
    pub stage: String,
    pub message: String,
}

/// The single thing the ACP engine needs in order to start a provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub provider: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// Deterministic, sorted-by-name environment. Values are plan data, never
    /// diagnostics; see `diagnostics` for what may be logged.
    pub env: Vec<(String, String)>,
    /// Stable identity of the launched process for logs and ownership
    /// diagnostics. Not a security token and not a secret.
    pub owner_key: String,
    pub source: LaunchPlanSource,
    pub diagnostics: Vec<LaunchPlanDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchPlanError {
    /// No catalog profile and no explicit executable: nothing to launch.
    UnknownProvider(String),
    /// The catalog declares a strategy the Windows planner does not implement.
    /// Fail closed rather than guess a package runner's argv.
    UnsupportedLaunchKind {
        provider: String,
        kind: CatalogLaunchKind,
    },
    /// The recipe cannot be launched as a plain Windows child process.
    UnsafeWindowsArgument { provider: String, detail: String },
}

impl fmt::Display for LaunchPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownProvider(provider) => {
                write!(
                    formatter,
                    "provider {provider} 既无 catalog profile 也无显式 exe"
                )
            }
            Self::UnsupportedLaunchKind { provider, kind } => write!(
                formatter,
                "provider {provider} 的 launch.kind={kind:?} 尚无 Windows 启动实现"
            ),
            Self::UnsafeWindowsArgument { provider, detail } => {
                write!(
                    formatter,
                    "provider {provider} 的启动参数不适用于 Windows: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for LaunchPlanError {}

fn env_name_is_secret(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "API_KEY",
        "APIKEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "AUTH",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

/// Insert with "last write wins" while keeping one entry per name. Windows
/// environment names are case-insensitive, so the comparison folds case.
fn put_env(env: &mut Vec<(String, String)>, name: &str, value: &str) {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Some(existing) = env
        .iter_mut()
        .find(|(key, _)| key.eq_ignore_ascii_case(trimmed))
    {
        existing.1 = value.to_string();
        return;
    }
    env.push((trimmed.to_string(), value.to_string()));
}

fn adapter_relation_diagnostic(
    relation: Option<&CatalogAdapterRelation>,
    detection: &LaunchDetection,
) -> Option<LaunchPlanDiagnostic> {
    let relation = relation?;
    if detection.native_present {
        return None;
    }
    Some(LaunchPlanDiagnostic {
        code: "native-cli-not-found".into(),
        stage: "detect".into(),
        message: format!(
            "未找到 {} 的 vendor CLI（{}）；Pylon 仍按其 ACP 入口启动，不代为安装",
            relation.native_label, relation.native_cmd
        ),
    })
}

/// Plan a Windows launch for one provider.
///
/// Precedence: explicit override > detection-resolved path > catalog recipe.
/// Only `kind: path` is implemented; `uvx`/`npm` fail closed here rather than
/// producing an argv nobody validated.
pub fn plan_launch(
    provider: &str,
    profile: Option<&PylonAgentProfile>,
    detection: &LaunchDetection,
    overrides: &LaunchOverrides,
) -> Result<LaunchPlan, LaunchPlanError> {
    let explicit_executable = overrides
        .executable
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let (executable, args, source, recipe_kind, relation) = match explicit_executable {
        Some(executable) => {
            let args = match &overrides.args {
                Some(args) => args.clone(),
                // An explicit executable with no explicit args inherits the
                // catalog recipe's arguments when one exists.
                None => profile
                    .map(|profile| profile.launch.args.clone())
                    .unwrap_or_default(),
            };
            let relation = profile.and_then(|profile| profile.adapter_relation.clone());
            (
                executable.to_string(),
                args,
                LaunchPlanSource::Explicit,
                None,
                relation,
            )
        }
        None => {
            let profile =
                profile.ok_or_else(|| LaunchPlanError::UnknownProvider(provider.into()))?;
            if profile.launch.kind != CatalogLaunchKind::Path {
                return Err(LaunchPlanError::UnsupportedLaunchKind {
                    provider: provider.to_string(),
                    kind: profile.launch.kind,
                });
            }
            let executable = detection
                .resolved_executable
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&profile.launch.command)
                .to_string();
            (
                executable,
                profile.launch.args.clone(),
                LaunchPlanSource::CatalogRecipe,
                Some(profile.launch.kind),
                profile.adapter_relation.clone(),
            )
        }
    };

    // Reuse the catalog's own Windows-only validation on the FINAL argv, so an
    // override cannot smuggle in a shell invocation or a POSIX path either.
    let mut validated = CatalogLaunchProfile {
        kind: recipe_kind.unwrap_or(CatalogLaunchKind::Path),
        command: executable.clone(),
        args: args.clone(),
        env: Vec::new(),
        cwd_policy: None,
    };
    // `command` may be an absolute path here (explicit or detection-resolved),
    // which the catalog-level check rejects by design; validate the argument
    // shape against the executable's file stem instead.
    if executable.contains('/') || executable.contains('\\') {
        if let Some(stem) = std::path::Path::new(&executable)
            .file_stem()
            .and_then(|stem| stem.to_str())
        {
            validated.command = stem.to_string();
        }
    }
    validated
        .validate(provider)
        .map_err(|detail| LaunchPlanError::UnsafeWindowsArgument {
            provider: provider.to_string(),
            detail,
        })?;

    let mut env: Vec<(String, String)> = Vec::new();
    for (name, value) in overrides.env.iter().chain(overrides.runtime_env.iter()) {
        put_env(&mut env, name, value);
    }
    env.sort_by(|left, right| {
        left.0
            .to_ascii_uppercase()
            .cmp(&right.0.to_ascii_uppercase())
    });

    let mut diagnostics = Vec::new();
    diagnostics.push(match source {
        LaunchPlanSource::Explicit => LaunchPlanDiagnostic {
            code: "explicit-override".into(),
            stage: "launch".into(),
            message: "启动参数来自显式配置，未使用 catalog recipe".into(),
        },
        LaunchPlanSource::CatalogRecipe => LaunchPlanDiagnostic {
            code: "catalog-recipe".into(),
            stage: "launch".into(),
            message: "启动参数来自 catalog launch recipe".into(),
        },
    });
    if overrides
        .cwd
        .as_deref()
        .is_some_and(|cwd| !cwd.trim().is_empty())
    {
        diagnostics.push(LaunchPlanDiagnostic {
            code: "cwd-applied".into(),
            stage: "launch".into(),
            message: "已应用显式工作目录".into(),
        });
    }
    for (name, _) in &env {
        diagnostics.push(LaunchPlanDiagnostic {
            code: "env-applied".into(),
            stage: "launch".into(),
            message: format!(
                "env {name} applied ({})",
                if env_name_is_secret(name) {
                    "secret value withheld"
                } else {
                    "value withheld"
                }
            ),
        });
    }
    if let Some(diagnostic) = adapter_relation_diagnostic(relation.as_ref(), detection) {
        diagnostics.push(diagnostic);
    }

    let owner_key = format!("{provider}:{executable}:{}", args.join(" "));
    Ok(LaunchPlan {
        provider: provider.to_string(),
        executable,
        args,
        cwd: overrides
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        env,
        owner_key,
        source,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_catalog;

    fn overrides_for_agent(exe: &str, args: &[&str]) -> LaunchOverrides {
        LaunchOverrides {
            executable: Some(exe.into()),
            args: Some(args.iter().map(|arg| arg.to_string()).collect()),
            ..Default::default()
        }
    }

    /// A2 验收（行为不变）：既有三 provider 的 argv 顺序/cwd/env 与旧启动路径一致。
    #[test]
    fn explicit_agents_keep_their_argv_cwd_and_env_order() {
        let peri = plan_launch(
            "peri",
            agent_catalog::provider_profile("peri").unwrap().as_ref(),
            &LaunchDetection::default(),
            &LaunchOverrides {
                executable: Some("peri".into()),
                args: Some(vec!["acp".into(), "--model".into(), "gpt".into()]),
                cwd: Some("G:/ws".into()),
                env: vec![("PORT".into(), "8080".into())],
                runtime_env: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(peri.source, LaunchPlanSource::Explicit);
        // 顺序 = 原样保留，不排序、不重排（`command_args()` 的语义）。
        assert_eq!(peri.args, vec!["acp", "--model", "gpt"]);
        assert_eq!(peri.executable, "peri");
        assert_eq!(peri.cwd.as_deref(), Some("G:/ws"));
        assert_eq!(peri.env, vec![("PORT".to_string(), "8080".to_string())]);

        let hermes = plan_launch(
            "hermes",
            agent_catalog::provider_profile("hermes").unwrap().as_ref(),
            &LaunchDetection::default(),
            &LaunchOverrides {
                executable: Some("hermes".into()),
                args: Some(vec!["acp".into()]),
                env: vec![("HERMES_HOME".into(), "F:/H/profiles/a".into())],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hermes.args, vec!["acp"]);
        assert_eq!(
            hermes.env,
            vec![("HERMES_HOME".to_string(), "F:/H/profiles/a".to_string())]
        );

        let claude = plan_launch(
            "claude-code",
            agent_catalog::provider_profile("claude-code")
                .unwrap()
                .as_ref(),
            &LaunchDetection::default(),
            &overrides_for_agent("ccb", &["--acp"]),
        )
        .unwrap();
        assert_eq!(claude.args, vec!["--acp"]);
    }

    fn plan_from_catalog(provider: &str, detection: &LaunchDetection) -> LaunchPlan {
        plan_launch(
            provider,
            agent_catalog::provider_profile(provider).unwrap().as_ref(),
            detection,
            &LaunchOverrides::default(),
        )
        .unwrap()
    }

    #[test]
    fn catalog_recipe_drives_the_plan_when_nothing_is_configured() {
        let peri = plan_from_catalog("peri", &LaunchDetection::default());
        assert_eq!(peri.source, LaunchPlanSource::CatalogRecipe);
        assert_eq!(peri.executable, "peri");
        assert_eq!(peri.args, vec!["acp"]);
        assert!(peri.env.is_empty());
        assert!(peri.diagnostics.iter().any(|d| d.code == "catalog-recipe"));

        // 检测到绝对路径时优先使用检测结果（onboarding 路径）。
        let resolved = plan_from_catalog(
            "peri",
            &LaunchDetection {
                resolved_executable: Some("C:/tools/peri.exe".into()),
                acp_present: true,
                native_present: false,
            },
        );
        assert_eq!(resolved.executable, "C:/tools/peri.exe");
        assert_eq!(resolved.args, vec!["acp"]);
    }

    #[test]
    fn owner_key_is_stable_and_identifies_the_argv() {
        let first = plan_from_catalog("peri", &LaunchDetection::default());
        let second = plan_from_catalog("peri", &LaunchDetection::default());
        assert_eq!(first.owner_key, second.owner_key);
        assert_eq!(first.owner_key, "peri:peri:acp");
        let other = plan_launch(
            "peri",
            agent_catalog::provider_profile("peri").unwrap().as_ref(),
            &LaunchDetection::default(),
            &overrides_for_agent("peri", &["serve"]),
        )
        .unwrap();
        assert_ne!(first.owner_key, other.owner_key);
    }

    /// A2 验收：敏感值脱敏——诊断里只有名称与「已应用」，没有任何值。
    #[test]
    fn diagnostics_never_carry_environment_values() {
        let plan = plan_launch(
            "hermes",
            agent_catalog::provider_profile("hermes").unwrap().as_ref(),
            &LaunchDetection::default(),
            &LaunchOverrides {
                executable: Some("hermes".into()),
                args: Some(vec!["acp".into()]),
                cwd: Some("G:/ws".into()),
                env: vec![
                    ("ANTHROPIC_API_KEY".into(), "sk-live-secret".into()),
                    ("PYLON_HOME".into(), "G:/private".into()),
                ],
                runtime_env: vec![("HERMES_TIMEOUT".into(), "300".into())],
            },
        )
        .unwrap();
        let rendered = serde_json::to_string(&plan.diagnostics).unwrap();
        assert!(!rendered.contains("sk-live-secret"));
        assert!(!rendered.contains("G:/private"));
        assert!(!rendered.contains("300"));
        assert!(rendered.contains("ANTHROPIC_API_KEY"));
        assert!(rendered.contains("secret value withheld"));
        let applied = plan
            .diagnostics
            .iter()
            .filter(|d| d.code == "env-applied")
            .count();
        assert_eq!(applied, 3);
        // env 仍按名称确定性排序（大小写折叠）。
        assert_eq!(
            plan.env
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            vec!["ANTHROPIC_API_KEY", "HERMES_TIMEOUT", "PYLON_HOME"]
        );
    }

    #[test]
    fn runtime_env_wins_the_same_key_but_keeps_one_entry() {
        let plan = plan_launch(
            "hermes",
            agent_catalog::provider_profile("hermes").unwrap().as_ref(),
            &LaunchDetection::default(),
            &LaunchOverrides {
                executable: Some("hermes".into()),
                args: Some(vec!["acp".into()]),
                env: vec![("PATH".into(), "agent-path".into())],
                runtime_env: vec![("path".into(), "runtime-path".into())],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(plan.env.len(), 1);
        assert_eq!(plan.env[0].1, "runtime-path");
    }

    #[test]
    fn unsupported_catalog_strategy_and_missing_executable_fail_closed() {
        // 没有 profile 也没有显式 exe → 无从启动。
        assert_eq!(
            plan_launch(
                "unknown",
                None,
                &LaunchDetection::default(),
                &LaunchOverrides::default()
            )
            .unwrap_err(),
            LaunchPlanError::UnknownProvider("unknown".into())
        );
        // 未实现的策略（uvx/npm）不得猜 argv。
        let mut profile = agent_catalog::provider_profile("peri").unwrap().unwrap();
        profile.launch.kind = CatalogLaunchKind::Uvx;
        assert_eq!(
            plan_launch(
                "peri",
                Some(&profile),
                &LaunchDetection::default(),
                &LaunchOverrides::default()
            )
            .unwrap_err(),
            LaunchPlanError::UnsupportedLaunchKind {
                provider: "peri".into(),
                kind: CatalogLaunchKind::Uvx,
            }
        );
    }

    #[test]
    fn windows_only_argv_is_enforced_on_the_final_command_line() {
        let profile = agent_catalog::provider_profile("peri").unwrap();
        for args in [vec!["/bin/sh", "-c", "peri"], vec!["--signal", "SIGTERM"]] {
            let error = plan_launch(
                "peri",
                profile.as_ref(),
                &LaunchDetection::default(),
                &LaunchOverrides {
                    executable: Some("peri".into()),
                    args: Some(args.iter().map(|arg| arg.to_string()).collect()),
                    ..Default::default()
                },
            )
            .unwrap_err();
            assert!(matches!(
                error,
                LaunchPlanError::UnsafeWindowsArgument { .. }
            ));
        }
    }

    /// A1/A2 衔接：wrapper 缺 vendor CLI 只产生诊断，不阻塞启动——本机 claude-code
    /// 正是这个状态，若在此 fail-closed 会把今天可用的配置打坏。
    #[test]
    fn missing_native_cli_is_reported_but_never_blocks_launch() {
        let missing = plan_from_catalog(
            "claude-code",
            &LaunchDetection {
                resolved_executable: None,
                acp_present: true,
                native_present: false,
            },
        );
        assert!(missing
            .diagnostics
            .iter()
            .any(|d| d.code == "native-cli-not-found"));
        let present = plan_from_catalog(
            "claude-code",
            &LaunchDetection {
                resolved_executable: None,
                acp_present: true,
                native_present: true,
            },
        );
        assert!(!present
            .diagnostics
            .iter()
            .any(|d| d.code == "native-cli-not-found"));
        // 非 wrapper provider 永不产生该诊断。
        assert!(!plan_from_catalog("peri", &LaunchDetection::default())
            .diagnostics
            .iter()
            .any(|d| d.code == "native-cli-not-found"));
    }
}
