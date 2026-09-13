//! B5：catalog 驱动的 provider 扩展锁。
//!
//! 「以 catalog 增加 provider」的机制性证据：一个真实 catalog provider
//! （`codex`——P71 A5① 纯数据加入，无任何组件改动）必须不经组件级 switch
//! 地穿过全部四个消费阶段：detection profile、preflight 判定、launch plan、
//! initialize clientCapabilities。任何一处出现 provider 硬编码分支，这条
//! 链就会断——测试即锁。
//!
//! 边界登记（属 P74 施工书 §1 不做/P72 片）：`detection.searchDirs` 与
//! 「MCP 恒空」策略消费者由 P72 的批次扩展片落地；`requires`（node/uv 下限
//! → 可见检查）已由 P72 勘误 2 落地并由 pylon-core 既有测试锁定，本测试
//! 只断言其在 detection profile 中可见。

use pylon_core::agent_catalog;
use pylon_core::agent_launch_plan::{LaunchDetection, LaunchOverrides};

const PROVIDER: &str = "codex";

#[test]
fn catalog_only_provider_flows_through_every_consumption_stage() {
    // 阶段 1：detection profile（候选扫描的声明来源）。
    let profiles = agent_catalog::detection_profiles().unwrap();
    let profile = profiles
        .iter()
        .find(|profile| profile.provider == PROVIDER)
        .unwrap_or_else(|| panic!("{PROVIDER} 必须只凭 catalog 数据出现在 detection profiles"));
    assert!(!profile.invocations.is_empty());

    // 阶段 2：launch plan（显式可执行文件 → plan，无组件级 provider 分支）。
    let plan = pylon_core::agent_launch_plan::plan_launch(
        PROVIDER,
        agent_catalog::provider_profile(PROVIDER).unwrap().as_ref(),
        &LaunchDetection::default(),
        &LaunchOverrides {
            executable: Some("codex-acp".into()),
            args: Some(Vec::new()),
            cwd: None,
            env: Vec::new(),
            runtime_env: Vec::new(),
        },
    )
    .unwrap_or_else(|error| panic!("{PROVIDER} launch plan 必须由 catalog 策略驱动: {error}"));
    assert_eq!(plan.executable, "codex-acp");

    // 阶段 3：initialize clientCapabilities（provider 声明合并；
    // codex 未声明 caps → 与默认逐字节一致，不凭空注入）。
    let config = crate::agent_config::AcpProtocolConfig::default();
    let declared = config.initialize_caps_for_provider(Some(PROVIDER)).unwrap();
    let base = config.initialize_caps_for_provider(None).unwrap();
    assert_eq!(
        serde_json::to_value(&declared).unwrap(),
        serde_json::to_value(&base).unwrap(),
        "未声明 caps 的 provider 不得被注入任何声明"
    );

    // 阶段 4：initialize 计划成形（B2 计划层消费同一配置）。
    let plan = crate::acp::initialize_plan::build_initialize_plan(&config, Some(PROVIDER)).unwrap();
    assert_eq!(plan.client_capabilities, declared);

    // requires 消费者可见性：detection profile 携带 catalog 声明的 checks
    // （codex 声明 requires.node → node-min 检查必须在 profile 中可见）。
    assert!(
        profile
            .checks
            .iter()
            .any(|check| check.id == "node-min" || check.id == "uv-min"),
        "catalog requires 必须合成可见检查（P72 勘误 2 的消费者），实得：{:?}",
        profile
            .checks
            .iter()
            .map(|check| check.id.clone())
            .collect::<Vec<_>>()
    );
}

/// 组件级 provider switch 的结构性禁令：设置面板与适配器注册必须由 catalog
/// 派生（P71 A4 的 grep 证据在此固化为常驻断言——面板提示词经
/// `builtinAgentCatalog` 派生是前端侧对应物，本测试锁 Rust 侧）。
#[test]
fn launch_plan_has_no_provider_string_branches_for_existing_providers() {
    for provider in ["peri", "hermes", "claude-code", "codex"] {
        let profile = agent_catalog::provider_profile(provider)
            .unwrap_or_else(|error| panic!("catalog 必须可解析 {provider}: {error}"))
            .unwrap_or_else(|| panic!("{provider} 必须在 catalog 中"));
        // 同一显式覆盖路径对每个 provider 产出计划——分支若存在，必然体现为
        // 某个 provider 的 argv 与其 catalog recipe 不一致。
        let plan = pylon_core::agent_launch_plan::plan_launch(
            provider,
            Some(&profile),
            &LaunchDetection::default(),
            &LaunchOverrides {
                executable: Some("probe.exe".into()),
                args: None,
                cwd: None,
                env: Vec::new(),
                runtime_env: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(
            plan.executable, "probe.exe",
            "{provider} 的显式可执行文件必须原样进入计划"
        );
        assert_eq!(
            plan.args, profile.launch.args,
            "{provider} 未显式给 args 时必须继承 catalog recipe，而不是组件内拼接"
        );
    }
}
