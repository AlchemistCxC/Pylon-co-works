//! Desktop-side binding of the pure Windows launch planner (P62 A2).
//!
//! The plan itself is computed by `pylon_core::agent_launch_plan`; this module
//! only maps what the desktop already holds (`AgentDef`, the managed Hermes
//! runtime selection, the resolved profile home) into planner inputs, and then
//! applies the resulting [`LaunchPlan`] to a `Command` in exactly one place.
//!
//! Every provider-specific value is an input here, never a branch in the spawn
//! path: `AgentDef` supplies explicit overrides, the runtime adapter supplies
//! environment it computed from the live machine, and the catalog supplies the
//! recipe used when nothing is configured.

use std::process::Command;

use pylon_core::agent_launch_plan::{
    LaunchDetection, LaunchOverrides, LaunchPlan, LaunchPlanError,
};

/// Build the plan for one configured or candidate agent.
///
/// `detection` carries what the detector proved about this provider (it is
/// empty for the connection-test path, which trusts the explicit `AgentDef`).
/// `runtime_env` is the managed-runtime environment computed by the caller.
pub(crate) fn plan_for_agent(
    agent: &crate::agent_config::AgentDef,
    base_dir: Option<&std::path::Path>,
    detection: &LaunchDetection,
    runtime_env: Vec<(String, String)>,
) -> Result<LaunchPlan, LaunchPlanError> {
    let provider = agent.provider.clone().unwrap_or_default();
    let profile = if provider.is_empty() {
        None
    } else {
        pylon_core::agent_catalog::provider_profile(&provider)
            .ok()
            .flatten()
    };
    // `HERMES_HOME` 与其它 per-agent env 都走同一个 plan 通道：配置文件里的
    // `hermes_profile` 是数据，不是启动分支。
    let mut env: Vec<(String, String)> = agent
        .env
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    if let Some(home) = crate::hermes::hermes_home_override(agent, base_dir) {
        tracing::info!(
            "agent {}: HERMES_HOME set to {} (hermes_profile)",
            agent.name,
            home
        );
        env.push(("HERMES_HOME".to_string(), home));
    }
    let provider_for_plan = if provider.is_empty() {
        // An agent with no `provider` has no catalog recipe: the explicit
        // values are the whole story, so nothing may be inferred from an
        // unknown provider string.
        agent.name.clone()
    } else {
        provider
    };
    pylon_core::agent_launch_plan::plan_launch(
        &provider_for_plan,
        profile.as_ref(),
        detection,
        &LaunchOverrides {
            executable: Some(agent.exe.clone()),
            args: Some(agent.command_args()),
            cwd: agent.cwd.clone(),
            env,
            runtime_env,
        },
    )
}

/// The single place a `LaunchPlan` becomes a process command.
///
/// Everything the plan declares is applied here; no caller adds arguments,
/// environment or a working directory around it.
pub(crate) fn apply_launch_plan(command: &mut Command, plan: &LaunchPlan) {
    command.args(&plan.args);
    if let Some(cwd) = &plan.cwd {
        command.current_dir(cwd);
    }
    for (name, value) in &plan.env {
        command.env(name, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn agent(provider: &str, exe: &str, args: &[&str]) -> crate::agent_config::AgentDef {
        crate::agent_config::AgentDef {
            name: provider.to_string(),
            provider: Some(provider.to_string()),
            transport: "subprocess".to_string(),
            exe: exe.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        }
    }

    /// A2 行为不变证据：三个既有 provider 的计划 argv/cwd/env 与旧启动路径一致。
    #[test]
    fn existing_providers_plan_their_unchanged_argv() {
        let peri = plan_for_agent(
            &agent("peri", "peri", &["acp"]),
            None,
            &LaunchDetection::default(),
            Vec::new(),
        )
        .unwrap();
        assert_eq!(peri.executable, "peri");
        assert_eq!(peri.args, vec!["acp"]);
        assert!(peri.cwd.is_none());
        assert!(peri.env.is_empty());

        let hermes = plan_for_agent(
            &agent("hermes", "hermes", &["acp"]),
            None,
            &LaunchDetection::default(),
            Vec::new(),
        )
        .unwrap();
        assert_eq!(hermes.args, vec!["acp"]);

        let claude = plan_for_agent(
            &agent("claude-code", "ccb", &["--acp"]),
            None,
            &LaunchDetection::default(),
            Vec::new(),
        )
        .unwrap();
        assert_eq!(claude.executable, "ccb");
        assert_eq!(claude.args, vec!["--acp"]);
    }

    /// 结构化 `model`/`acp_args` 的既有展开顺序必须原样穿过 plan。
    #[test]
    fn structured_model_and_acp_args_keep_their_order() {
        let mut def = agent("hermes", "hermes", &["acp"]);
        def.model = Some("gpt-5".to_string());
        def.acp_args = vec!["--verbose".to_string()];
        let plan = plan_for_agent(&def, None, &LaunchDetection::default(), Vec::new()).unwrap();
        assert_eq!(plan.args, vec!["acp", "--model", "gpt-5", "--verbose"]);
    }

    /// 环境变量只从 plan 一处应用，且运行时增补可覆盖同名 per-agent 值。
    #[test]
    fn environment_is_applied_through_the_plan_only() {
        let mut def = agent("hermes", "hermes", &["acp"]);
        def.env
            .insert("HERMES_HOME".to_string(), "F:/old".to_string());
        let plan = plan_for_agent(
            &def,
            None,
            &LaunchDetection::default(),
            vec![("HERMES_HOME".to_string(), "F:/new".to_string())],
        )
        .unwrap();
        assert_eq!(
            plan.env,
            vec![("HERMES_HOME".to_string(), "F:/new".to_string())]
        );
        let mut command = Command::new(&plan.executable);
        apply_launch_plan(&mut command, &plan);
        // `get_envs` 是唯一可离线断言的视图；顺序与名称来自 plan。
        let rendered: Vec<(String, String)> = command
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
        assert!(rendered.contains(&("HERMES_HOME".to_string(), "F:/new".to_string())));
    }

    /// 没有 provider 的 agent 仍可用显式配置启动，且不会去猜 catalog recipe。
    #[test]
    fn agent_without_a_provider_still_launches_from_explicit_values() {
        let mut def = agent("custom", "my-agent", &["serve"]);
        def.provider = None;
        let plan = plan_for_agent(&def, None, &LaunchDetection::default(), Vec::new()).unwrap();
        assert_eq!(plan.executable, "my-agent");
        assert_eq!(plan.args, vec!["serve"]);
        assert!(plan
            .diagnostics
            .iter()
            .any(|d| d.code == "explicit-override"));
    }
}
