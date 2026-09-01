use std::collections::HashMap;
use std::path::Path;
use super::*;


    fn agent(default: bool) -> AgentDef {
        AgentDef {
            name: "test".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: "missing-agent".to_string(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            default,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        }
    }

    #[test]
    fn empty_registry_has_no_default_agent() {
        assert_eq!(default_agent_id(&HashMap::new()).unwrap(), None);
    }

    #[test]
    fn explicit_default_agent_wins() {
        let mut agents = HashMap::new();
        agents.insert("fallback".to_string(), agent(false));
        agents.insert("primary".to_string(), agent(true));
        assert_eq!(
            default_agent_id(&agents).unwrap(),
            Some("primary".to_string())
        );
    }

    #[test]
    fn multiple_default_agents_are_rejected() {
        let mut agents = HashMap::new();
        agents.insert("a".to_string(), agent(true));
        agents.insert("b".to_string(), agent(true));
        let error = default_agent_id(&agents).expect_err("multiple defaults must fail");
        assert!(error.to_string().contains("a, b"));
    }

    #[test]
    fn fallback_agent_id_is_deterministic() {
        let mut agents = HashMap::new();
        agents.insert("zeta".to_string(), agent(false));
        agents.insert("alpha".to_string(), agent(false));
        assert_eq!(
            default_agent_id(&agents).unwrap(),
            Some("alpha".to_string())
        );
    }

    #[test]
    fn load_from_path_reads_runtime_changes() {
        let path = std::env::temp_dir().join(format!("pylon-agents-{}.yaml", std::process::id()));
        std::fs::write(&path, "agents:\n  runtime:\n    name: Runtime\n    transport: subprocess\n    exe: runtime-agent\n")
            .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(agents.contains_key("runtime"));
    }

    #[test]
    fn rejects_agent_env_with_empty_key() {
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    env:\n      \"\": \"value\"\n",
        )
        .expect_err("empty env key must be rejected");
        assert!(error
            .to_string()
            .contains("agent bad has invalid env entry"));
    }

    #[test]
    fn rejects_agent_env_key_containing_equals() {
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    env:\n      \"a=b\": \"value\"\n",
        )
        .expect_err("env key containing '=' must be rejected");
        assert!(error
            .to_string()
            .contains("agent bad has invalid env entry"));
    }

    #[test]
    fn parses_numeric_env_values_as_strings() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-envnum-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  runtime:\n    name: Runtime\n    transport: subprocess\n    exe: runtime-agent\n    env:\n      PORT: 8080\n      DEBUG: true\n      NODE_ENV: prod\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("numeric env values must coerce to strings");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["runtime"].env.get("PORT"), Some(&"8080".to_string()));
        assert_eq!(
            agents["runtime"].env.get("DEBUG"),
            Some(&"true".to_string())
        );
        assert_eq!(
            agents["runtime"].env.get("NODE_ENV"),
            Some(&"prod".to_string())
        );
    }

    #[test]
    fn parses_scalar_args_as_strings() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-argsnum-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  runtime:\n    name: Runtime\n    transport: subprocess\n    exe: runtime-agent\n    args: [acp, 8080, true]\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("scalar args must coerce to strings");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["runtime"].args, vec!["acp", "8080", "true"]);
    }

    #[test]
    fn resolves_relative_paths_against_config_directory() {
        let mut relative = agent(false);
        relative.exe = "bin/agent.exe".to_string();
        relative.cwd = Some("workspace".to_string());
        let resolved = relative.resolve_paths(Path::new("C:/portable/pylon"));
        assert!(resolved.exe.contains("portable"));
        assert!(
            resolved.exe.ends_with("bin/agent.exe") || resolved.exe.ends_with("bin\\agent.exe")
        );
        assert!(resolved.cwd.unwrap().contains("portable"));
    }

    #[test]
    fn parses_set_model_api_flag_with_default_false() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-setmodel-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: hermes\n    set_model_api: true\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: peri\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(
            agents["hermes"].set_model_api,
            "配置了 set_model_api: true 必须生效"
        );
        assert!(
            !agents["peri"].set_model_api,
            "缺省必须为 false（官方 set_config_option 路径）"
        );
    }

    #[test]
    fn parses_hermes_profile_field() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-profile-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: hermes\n    hermes_profile: profile-a\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: peri\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(
            agents["hermes"].hermes_profile.as_deref(),
            Some("profile-a"),
            "hermes_profile 字段必须解析"
        );
        assert!(
            agents["peri"].hermes_profile.is_none(),
            "未配置的 agent 缺省为 None"
        );
    }

    /// P0-1：旧配置缺 provider 时按协议依据推断——hermes_profile 存在（Hermes 专属字段）→ hermes。
    #[test]
    fn infers_provider_from_hermes_profile_when_missing() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-hermes-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  hermes-work:\n    name: Hermes Work\n    transport: subprocess\n    exe: hermes\n    hermes_profile: profile-a\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(
            agents["hermes-work"].provider.as_deref(),
            Some("hermes"),
            "hermes_profile 存在 → 推断 provider=hermes"
        );
    }

    /// P0-1：旧配置缺 provider 时按可执行程序类型推断——exe 文件名去扩展名小写命中已知 provider。
    #[test]
    fn infers_provider_from_known_exe_stem_when_missing() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-exe-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri-copy:\n    name: Peri Copy\n    transport: subprocess\n    exe: F:\\Agent\\peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(
            agents["peri-copy"].provider.as_deref(),
            Some("peri"),
            "exe 文件名命中已知 provider → 推断 provider=peri"
        );
    }

    #[test]
    fn shared_catalog_infers_claude_alias_and_supplies_protocol_baseline() {
        let yaml = "agents:\n  claude:\n    name: Claude\n    transport: subprocess\n    exe: ccb.cmd\n  hermes:\n    name: Hermes\n    provider: hermes\n    transport: subprocess\n    exe: custom-hermes-launcher\n";
        let agents = parse_agents(yaml, None).expect("catalog-backed agents must parse");
        assert_eq!(agents["claude"].provider.as_deref(), Some("claude-code"));
        assert_eq!(
            agents["hermes"].protocol().set_model_api(),
            SetModelApi::SetModel,
            "Hermes baseline must come from Shared Agent Catalog"
        );
    }

    #[test]
    fn explicit_instance_protocol_override_wins_over_catalog_baseline() {
        let yaml = "agents:\n  hermes:\n    name: Hermes\n    provider: hermes\n    transport: subprocess\n    exe: hermes\n    set_model_api: false\n  hermes-explicit:\n    name: Hermes Explicit\n    provider: hermes\n    transport: subprocess\n    exe: hermes\n    acp:\n      set_model_api: none\n";
        let agents = parse_agents(yaml, None).expect("explicit overrides must parse");
        assert_eq!(
            agents["hermes"].protocol().set_model_api(),
            SetModelApi::ConfigOption
        );
        assert_eq!(
            agents["hermes-explicit"].protocol().set_model_api(),
            SetModelApi::None
        );
    }

    /// P0-1：无协议信号必须保持 None（显式降级，绝不按 agentId 名称猜）。
    #[test]
    fn no_provider_signal_leaves_none() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-none-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  custom:\n    name: Custom\n    transport: subprocess\n    exe: my-agent.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(
            agents["custom"].provider.is_none(),
            "无协议信号必须保持 None（显式降级，不猜）"
        );
    }

    /// P0-1：声明值 trim+lowercase 归一（与前端 normalizeProvider 一致，防 wire 大小写漂移）。
    #[test]
    fn declared_provider_is_normalized_lowercase() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-norm-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    provider: PERI\n    transport: subprocess\n    exe: peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["peri"].provider.as_deref(), Some("peri"));
    }

    /// P0-1：声明为空串视为缺省 → 走协议依据推断。
    #[test]
    fn empty_declared_provider_falls_back_to_inference() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-empty-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    provider: \"\"\n    transport: subprocess\n    exe: peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["peri"].provider.as_deref(), Some("peri"));
    }

    /// P0-1：显式声明优先于推断信号（exe 命中 peri 但声明 custom → custom）。
    #[test]
    fn declared_provider_wins_over_exe_signal() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-wins-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    provider: custom\n    transport: subprocess\n    exe: peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["peri"].provider.as_deref(), Some("custom"));
    }

    /// WI-01 CR-001（NOTE 吸收）：误导性 agentId（id=peri）+ 通用 exe 不得推断为 peri——
    /// "不按 agentId 名称猜"由 resolve_provider 签名结构保证，固化为回归守护。
    #[test]
    fn misleading_agent_id_never_drives_provider() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-idguard-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: my-agent.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(
            agents["peri"].provider.is_none(),
            "agentId 名称绝不作 provider 推断依据（结构保证固化）"
        );
    }

    /// WI-01 CR-002（NOTE 吸收）：声明 provider 优先于 hermes_profile 推断信号。
    #[test]
    fn declared_provider_wins_over_hermes_profile_signal() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-profile-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  custom:\n    name: Custom\n    provider: custom\n    transport: subprocess\n    exe: hermes\n    hermes_profile: profile-a\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(
            agents["custom"].provider.as_deref(),
            Some("custom"),
            "声明优先于 hermes_profile 推断"
        );
    }

    #[test]
    fn parses_structured_acp_fields() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-acp-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: peri\n    args: [\"acp\"]\n    model: deepseek-v4-flash\n    acp_args: [\"--verbose\"]\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let peri = &agents["peri"];
        assert_eq!(peri.model.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(peri.acp_args, vec!["--verbose".to_string()]);
    }

    #[test]
    fn command_args_merge_structured_fields_after_args() {
        let mut def = agent(false);
        def.args = vec!["acp".into(), "--config".into(), "a.yaml".into()];
        def.model = Some("deepseek-v4-flash".into());
        def.acp_args = vec!["--verbose".into(), "--timeout".into(), "120".into()];
        assert_eq!(
            def.command_args(),
            vec![
                "acp",
                "--config",
                "a.yaml",
                "--model",
                "deepseek-v4-flash",
                "--verbose",
                "--timeout",
                "120"
            ]
        );
        // 纯 args（无结构化字段）：原样返回（向后兼容）
        let mut plain = agent(false);
        plain.args = vec!["acp".into()];
        assert_eq!(plain.command_args(), vec!["acp"]);
        // model 后出现 → 覆盖 args 里手工写的 --model
        let mut overridden = agent(false);
        overridden.args = vec!["acp".into(), "--model".into(), "old".into()];
        overridden.model = Some("new".into());
        let merged = overridden.command_args();
        assert_eq!(merged[merged.len() - 2], "--model");
        assert_eq!(merged[merged.len() - 1], "new");
    }

    #[test]
    fn runtime_fingerprint_ignores_display_fields_and_tracks_runtime_fields() {
        let mut baseline = agent(false);
        baseline.name = "Display A".into();
        baseline.default = false;
        baseline.env = HashMap::from([("B".into(), "2".into()), ("A".into(), "1".into())]);
        let expected = baseline.runtime_fingerprint();

        let mut display_only = baseline.clone();
        display_only.name = "Display B".into();
        display_only.default = true;
        display_only.env = HashMap::from([("A".into(), "1".into()), ("B".into(), "2".into())]);
        assert_eq!(expected, display_only.runtime_fingerprint());

        for changed in [
            {
                let mut value = baseline.clone();
                value.exe = "other-agent".into();
                value
            },
            {
                let mut value = baseline.clone();
                value.args.push("--verbose".into());
                value
            },
            {
                let mut value = baseline.clone();
                value.env.insert("A".into(), "changed".into());
                value
            },
            {
                let mut value = baseline.clone();
                value.acp = Some(AcpProtocolConfig {
                    rpc_timeout_secs: Some(31),
                    ..Default::default()
                });
                value
            },
        ] {
            assert_ne!(expected, changed.runtime_fingerprint());
        }
    }

    #[test]
    fn parses_acp_protocol_config_section() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-acpcfg-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  custom:\n    name: Custom\n    transport: subprocess\n    exe: agent\n    acp:\n      initialize_caps:\n        fs: {}\n        auth: {}\n        _meta:\n          \"peri.skillNames\": true\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let caps = agents["custom"]
            .acp
            .as_ref()
            .expect("acp 段必须解析")
            .initialize_caps
            .as_ref()
            .expect("initialize_caps 必须解析");
        assert_eq!(caps["fs"], serde_json::json!({}));
        assert_eq!(caps["_meta"]["peri.skillNames"], serde_json::json!(true));
        // 缺省：无 acp 段
        let plain = agent(false);
        assert!(plain.acp.is_none());
    }

    /// G1-06：close_via_rpc 缺省 true（现状 wire：总是尝试 RPC + -32601 降级）。
    #[test]
    fn close_via_rpc_default_true() {
        assert!(DEFAULT_ACCPROTOCOL.close_via_rpc());
        assert!(AcpProtocolConfig::default().close_via_rpc());
        assert!(
            crate::agent_config::AttachmentLimits::default().max_attachments > 0,
            "附件默认限制与常量同源"
        );
        let mut config = AcpProtocolConfig {
            session_close: Some(false),
            ..AcpProtocolConfig::default()
        };
        assert!(!config.close_via_rpc(), "session_close: false 必须跳过 RPC");
        config.session_close = Some(true);
        assert!(config.close_via_rpc(), "session_close: true 必须尝试 RPC");
    }

    /// G1-01：D2 双格式反序列化——acp 段内 bool|string 五形态 + 顶层 legacy bool
    /// 合并语义（顶层 `set_model_api: true` 无 acp 段 → SetModel；acp 段显式声明优先）。
    #[test]
    fn parses_set_model_api_dual_format() {
        let yaml = "agents:\n  bool-true:\n    name: A\n    transport: subprocess\n    exe: a\n    acp:\n      set_model_api: true\n  bool-false:\n    name: B\n    transport: subprocess\n    exe: b\n    acp:\n      set_model_api: false\n  str-set-model:\n    name: C\n    transport: subprocess\n    exe: c\n    acp:\n      set_model_api: set_model\n  str-config-option:\n    name: D\n    transport: subprocess\n    exe: d\n    acp:\n      set_model_api: config_option\n  str-none:\n    name: E\n    transport: subprocess\n    exe: e\n    acp:\n      set_model_api: none\n  legacy-true:\n    name: F\n    transport: subprocess\n    exe: f\n    set_model_api: true\n  legacy-false:\n    name: G\n    transport: subprocess\n    exe: g\n  legacy-true-overridden:\n    name: H\n    transport: subprocess\n    exe: h\n    set_model_api: true\n    acp:\n      set_model_api: config_option\n";
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-setmodel-dual-{}.yaml",
            std::process::id()
        ));
        std::fs::write(&path, yaml).expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let resolved = |id: &str| agents[id].protocol().set_model_api();
        assert_eq!(resolved("bool-true"), SetModelApi::SetModel);
        assert_eq!(resolved("bool-false"), SetModelApi::ConfigOption);
        assert_eq!(resolved("str-set-model"), SetModelApi::SetModel);
        assert_eq!(resolved("str-config-option"), SetModelApi::ConfigOption);
        assert_eq!(resolved("str-none"), SetModelApi::None);
        assert_eq!(resolved("legacy-true"), SetModelApi::SetModel);
        assert_eq!(resolved("legacy-false"), SetModelApi::ConfigOption);
        assert_eq!(
            resolved("legacy-true-overridden"),
            SetModelApi::ConfigOption,
            "acp 段显式声明必须优先于顶层 legacy bool"
        );
    }

    /// G1-01：空 acp 段/无 acp 段 → 全部访问器 = 重构前硬编码现值（wire 零变化）。
    #[test]
    fn protocol_defaults_match_current_behavior() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-protodef-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  plain:\n    name: Plain\n    transport: subprocess\n    exe: plain\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let protocol = agents["plain"].protocol();
        // G1-01 自检：D2 兼容合并——顶层 legacy bool 与 acp 段缺省等价
        assert_eq!(protocol.set_model_api(), SetModelApi::ConfigOption);
        assert_eq!(
            protocol.prompt_timeout(),
            crate::acp::DEFAULT_PROMPT_TIMEOUT_SECS
        );
        assert_eq!(
            protocol.cancel_settle_timeout(),
            crate::acp::DEFAULT_CANCEL_SETTLE_TIMEOUT_SECS
        );
        // R-t5 缺省：idle/first_token 回退到 prompt_timeout（300）
        assert_eq!(protocol.idle_timeout(), protocol.prompt_timeout());
        assert_eq!(protocol.first_token_timeout(), protocol.idle_timeout());
        assert_eq!(protocol.rpc_timeout(), DEFAULT_RPC_TIMEOUT_SECS);
        assert_eq!(protocol.replay_max(), DEFAULT_REPLAY_MAX_EVENTS);
        assert_eq!(protocol.protocol_version(), DEFAULT_PROTOCOL_VERSION);
        assert!(protocol.close_via_rpc(), "session_close 缺省必须尝试 RPC");
        assert_eq!(protocol.mcp_servers, McpServersMode::Always);
        let limits = protocol.attachment_limits();
        assert_eq!(limits.max_attachments, crate::acp::DEFAULT_MAX_ATTACHMENTS);
        assert_eq!(
            limits.max_attachment_bytes,
            crate::acp::DEFAULT_MAX_ATTACHMENT_BYTES
        );
        assert_eq!(
            protocol.initialize_caps(),
            serde_json::json!({
                "tokenStats": true,
                "_meta": {
                    "peri.tokenStats": true,
                    "peri.skillNames": true,
                    "peri.replay": true
                }
            }),
            "默认 caps = 现值（tokenStats + _meta.peri.*）"
        );
        assert_eq!(
            protocol.client_info(),
            serde_json::json!({"name": "Pylon", "version": "1.0.0"})
        );
        // DEFAULT_ACCPROTOCOL 静态与解析结果一致（AgentDef::protocol 缺省回退）
        assert_eq!(
            DEFAULT_ACCPROTOCOL.set_model_api(),
            SetModelApi::ConfigOption
        );
        assert_eq!(DEFAULT_ACCPROTOCOL.prompt_timeout(), 300);
    }

    /// G1-01：acp 段全字段声明 → 访问器全部返回声明值。
    #[test]
    fn parses_full_acp_section() {
        // 注意：serde_yml 对"空 flow mapping {} 为块内唯一尾部键"解析失败
        // （多键则正常）——测试用两键形态，生产配置同规避。
        let path =
            std::env::temp_dir().join(format!("pylon-agents-acpfull-{}.yaml", std::process::id()));
        let yaml = "agents:\n  future:\n    name: Future\n    transport: subprocess\n    exe: future\n    acp:\n      set_model_api: none\n      session_close: false\n      mcp_servers: omit_if_empty\n      initialize_caps:\n        fs: {}\n        auth: {}\n      protocol_version: 2\n      client_info:\n        name: Pylon\n        version: \"0.2.0\"\n      prompt_timeout_secs: 600\n      cancel_settle_timeout_secs: 45\n      rpc_timeout_secs: 60\n      max_attachments: 4\n      max_attachment_bytes: 5242880\n      replay_max_events: 5000\n";
        std::fs::write(&path, yaml).expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let protocol = agents["future"].protocol();
        assert_eq!(protocol.set_model_api(), SetModelApi::None);
        assert!(
            !protocol.close_via_rpc(),
            "session_close: false 必须跳过 RPC"
        );
        assert_eq!(protocol.mcp_servers, McpServersMode::OmitIfEmpty);
        assert_eq!(
            protocol.initialize_caps(),
            serde_json::json!({"fs": {}, "auth": {}})
        );
        assert_eq!(protocol.protocol_version(), 2);
        assert_eq!(
            protocol.client_info(),
            serde_json::json!({"name": "Pylon", "version": "0.2.0"})
        );
        assert_eq!(protocol.prompt_timeout(), 600);
        assert_eq!(protocol.cancel_settle_timeout(), 45);
        assert_eq!(protocol.rpc_timeout(), 60);
        let limits = protocol.attachment_limits();
        assert_eq!(limits.max_attachments, 4);
        assert_eq!(limits.max_attachment_bytes, 5_242_880);
        assert_eq!(protocol.replay_max(), 5000);
        // D2 路由纯函数：None + model 键 → Disabled；其余键 → ConfigOption
        assert_eq!(
            protocol.set_model_api().route("model"),
            ModelSwitchTarget::Disabled
        );
        assert_eq!(
            protocol.set_model_api().route("mode"),
            ModelSwitchTarget::ConfigOption
        );
        assert_eq!(
            SetModelApi::SetModel.route("model"),
            ModelSwitchTarget::SetModel
        );
        assert_eq!(
            SetModelApi::SetModel.route("mode"),
            ModelSwitchTarget::ConfigOption
        );
        assert_eq!(
            SetModelApi::ConfigOption.route("model"),
            ModelSwitchTarget::ConfigOption
        );
    }

    /// E1 封闭：非法 acp 取值必须拒绝且报错指明 agent id——
    /// 负数值（serde 层拒绝，逐 agent 包装带 id）、0（parse 校验）、未知枚举。
    #[test]
    fn rejects_invalid_acp_values_with_agent_context() {
        // 负数值：serde u64 层拒绝，报错带 agent id（逐 agent 反序列化包装）
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: -5\n",
        )
        .expect_err("负数值必须拒绝");
        assert!(
            error.to_string().contains("agent bad"),
            "报错必须指明 agent id: {error}"
        );
        // 0：parse 校验层拒绝（u64 可解析，语义非法）
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: 0\n",
        )
        .expect_err("0 必须拒绝");
        assert!(
            error.to_string().contains("agent bad"),
            "报错必须指明 agent id: {error}"
        );
        assert!(
            error.to_string().contains("prompt_timeout_secs"),
            "报错必须指明字段: {error}"
        );
        // 全部数值字段 0 均拒绝
        for field in [
            "cancel_settle_timeout_secs",
            "idle_timeout_secs",
            "first_token_timeout_secs",
            "rpc_timeout_secs",
            "max_attachments",
            "max_attachment_bytes",
            "replay_max_events",
        ] {
            let error = parse(&format!(
                "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      {field}: 0\n"
            ))
            .expect_err("{field} 为 0 必须拒绝");
            assert!(error.to_string().contains("agent bad"), "{field}: {error}");
            assert!(error.to_string().contains(field), "{field}: {error}");
        }
        // 未知枚举值：反序列化层拒绝，报错带 agent id
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      set_model_api: unknown\n",
        )
        .expect_err("未知 set_model_api 必须拒绝");
        assert!(
            error.to_string().contains("agent bad"),
            "报错必须指明 agent id: {error}"
        );
        assert!(
            error.to_string().contains("set_model_api"),
            "报错必须指明字段: {error}"
        );
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      mcp_servers: sometimes\n",
        )
        .expect_err("未知 mcp_servers 必须拒绝");
        assert!(
            error.to_string().contains("agent bad"),
            "报错必须指明 agent id: {error}"
        );
        assert!(
            error.to_string().contains("mcp_servers"),
            "报错必须指明字段: {error}"
        );
        // 合法值不受影响（正对照）
        assert!(
            parse(
                "agents:\n  good:\n    name: Good\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: 1\n      max_attachments: 1\n      max_attachment_bytes: 1\n      replay_max_events: 1\n"
            )
            .is_ok(),
            "合法 >0 值必须通过"
        );
        for (field, maximum) in [
            ("prompt_timeout_secs", 3600u64),
            ("cancel_settle_timeout_secs", 300),
            ("idle_timeout_secs", 3600),
            ("first_token_timeout_secs", 3600),
            ("rpc_timeout_secs", 300),
            ("max_attachments", 64),
            ("max_attachment_bytes", 256 * 1024 * 1024),
            ("replay_max_events", 100_000),
        ] {
            assert!(
                parse(&format!(
                    "agents:\n  good:\n    name: Good\n    transport: subprocess\n    exe: agent\n    acp:\n      {field}: {maximum}\n"
                ))
                .is_ok(),
                "{field}: hard max 本身必须允许"
            );
            let error = parse(&format!(
                "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      {field}: {}\n",
                maximum + 1,
            ))
            .expect_err("超过 hard max 必须拒绝");
            assert!(error.to_string().contains("agent bad"), "{field}: {error}");
            assert!(error.to_string().contains("hard max"), "{field}: {error}");
        }

        let oversized_json = "x".repeat(MAX_INITIALIZE_VALUE_BYTES + 1);
        let error = parse(&format!(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      client_info:\n        blob: {oversized_json}\n"
        ))
        .expect_err("oversized client_info must be rejected");
        assert!(error.to_string().contains("client_info"));
        assert!(error.to_string().contains("hard max"));
    }

    #[test]
    fn high_but_valid_config_limits_are_snapshot_diagnostics_not_errors() {
        let agents = parse(
            "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: 901\n      max_attachment_bytes: 67108865\n      replay_max_events: 50001\n",
        )
        .expect("warning thresholds must not reject the config");
        let diagnostics = config_diagnostics(&agents);
        assert_eq!(diagnostics.len(), 3);
        assert!(diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code == "config_high_resource_limit"));
    }

    // ── R6（P1-4）：分域部分成功与统一装载 ──

    #[test]
    fn config_error_codes_are_stable_and_machine_readable() {
        assert_eq!(ConfigError::Read("x".into()).code(), "config_read_error");
        assert_eq!(ConfigError::Parse("x".into()).code(), "config_parse_error");
        assert_eq!(
            ConfigError::InvalidAgent("x".into()).code(),
            "config_invalid_agent"
        );
        assert_eq!(ConfigError::Invalid("x".into()).code(), "config_error");
        assert_eq!(
            ConfigError::Conflict {
                expected: "a".into(),
                actual: "b".into(),
            }
            .code(),
            "config_revision_conflict"
        );
        assert_eq!(
            ConfigError::RevisionRequired.code(),
            "config_revision_required"
        );
        assert_eq!(
            ConfigError::Backup("x".into()).code(),
            "config_backup_error"
        );
        assert_eq!(ConfigError::LockBusy("x".into()).code(), "config_lock_busy");
    }

    #[test]
    fn config_error_display_preserves_original_message() {
        // R7：Display 透传原文案（前端/日志文案不变），code 独立细分。
        let error = ConfigError::InvalidAgent("agent bad has an empty name".into());
        assert_eq!(error.to_string(), "agent bad has an empty name");
        assert_eq!(error.code(), "config_invalid_agent");
    }

    #[test]
    fn parse_domains_both_domains_ok() {
        let content = r#"
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: peri
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let (agents, gateway) = parse_domains(content, None);
        assert_eq!(agents.expect("agents 必须可解析").len(), 1);
        assert_eq!(
            gateway.expect("gateway 必须可解析").routes.iter().count(),
            1
        );
    }

    #[test]
    fn parse_domains_agent_error_does_not_block_gateway() {
        let content = r#"
agents:
  bad:
    name: ""
    transport: subprocess
    exe: peri
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let (agents, gateway) = parse_domains(content, None);
        assert!(agents.is_err(), "空 name 必须使 agents 失败");
        assert!(
            gateway.is_ok(),
            "agents 失败不得拖垮 gateway（P1-1 部分成功）"
        );
    }

    #[test]
    fn parse_domains_gateway_error_does_not_block_agents() {
        let content = r#"
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: peri
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
      reset: banana
"#;
        let (agents, gateway) = parse_domains(content, None);
        assert!(
            agents.is_ok(),
            "gateway 失败不得拖垮 agents（P1-1 部分成功）"
        );
        let error = gateway.expect_err("非法 reset 必须使 gateway 失败");
        assert!(
            error.to_string().contains("reset"),
            "报错必须指明 reset: {error}"
        );
    }

    #[test]
    fn parse_domains_broken_yaml_fails_both_domains() {
        let (agents, gateway) = parse_domains("{{{ not yaml", None);
        assert!(agents.is_err(), "语法损坏必须使 agents 失败");
        assert!(gateway.is_err(), "语法损坏必须使 gateway 失败");
    }

    #[test]
    fn load_app_config_is_structured_and_source_identifiable() {
        // 环境无关的结构断言：来源三选一、两个域结果都存在（成败由测试环境决定，
        // 不在此断言）。同一份文本分域解析由 parse_domains 测试覆盖。
        let loaded = load_app_config();
        assert!(matches!(
            loaded.source,
            ConfigSource::Environment(_)
                | ConfigSource::ExecutableDirectory(_)
                | ConfigSource::Embedded
        ));
        let _ = loaded.agents.is_ok();
        let _ = loaded.gateway.is_ok();
    }

    #[test]
    fn load_and_load_gateway_config_share_read_entry() {
        // R1：load() 与 load_gateway_config() 都经 read_config_document 单次读文本——
        // 同一来源下两域读取的是同一份内容（P1-1 不变量）。
        let doc = read_config_document();
        let agents = load();
        let gateway_text = load_gateway_config();
        match doc {
            Ok(doc) => {
                // 有来源 → load 解析成功则 gateway 文本即该内容
                if let Ok(agents) = agents {
                    assert!(!agents.is_empty());
                }
                assert_eq!(
                    gateway_text.as_ref().map(|text| text.as_str()),
                    Ok(doc.content.as_str())
                );
            }
            Err(_) => {
                // 无来源（embedded 恒可用，正常不可达）——防回归
                assert!(gateway_text.is_err());
            }
        }
    }

    // ── Phase 3 配置写入纯函数层（§5.5）──

    const SAMPLE: &str = "agents:\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: python\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: python\n    default: true\ngateway:\n  qq:\n    group_allow_from: [g1]\n  routes:\n    - source: qq:user:demo-user\n      agent: peri\n      profile: p\n      session: s\n";

    #[test]
    fn agent_patch_replaces_target_and_preserves_others() {
        let patched = apply_agent_patch(
            SAMPLE,
            "peri",
            "name: Peri2\ntransport: subprocess\nexe: python3\n",
        )
        .unwrap();
        assert!(patched.contains("name: Peri2"), "目标 agent 必须替换");
        assert!(patched.contains("name: Hermes"), "其余 agent 必须保留");
        // round-trip：重解析后 peri 更新、hermes 不变
        let agents = parse(&patched).unwrap();
        assert_eq!(agents["peri"].name, "Peri2");
        assert_eq!(agents["hermes"].name, "Hermes");
        assert_eq!(agents["hermes"].default, true);
    }

    #[test]
    fn agent_patch_rejects_missing_agent_and_bad_patch() {
        assert!(
            apply_agent_patch(SAMPLE, "ghost", "name: X\nexe: y\ntransport: subprocess\n").is_err(),
            "不存在 agent 默认禁止创建"
        );
        assert!(
            apply_agent_patch(SAMPLE, "peri", "name: [unclosed").is_err(),
            "非法 YAML 补丁必须报错"
        );
    }

    #[test]
    fn gateway_patch_replaces_routes_keeps_qq() {
        let patch = serde_json::json!({ "gateway": { "routes": [{ "source": "qq:user:new", "agent": "hermes", "profile": "p", "session": "s" }] } });
        let patched = apply_gateway_patch(SAMPLE, &patch).unwrap();
        assert!(patched.contains("qq:user:new"), "routes 必须整段替换");
        assert!(!patched.contains("qq:user:demo-user"), "旧 routes 必须移除");
        assert!(
            patched.contains("group_allow_from"),
            "qq 段必须保留（显式 patch 不做深 merge）"
        );
        // round-trip：gateway 域重解析校验通过
        validate_candidate(&patched, None).unwrap();
    }

    #[test]
    fn gateway_patch_rejects_unknown_keys() {
        let patch = serde_json::json!({ "gateway": { "routes": [], "inject": {} } });
        assert!(
            apply_gateway_patch(SAMPLE, &patch).is_err(),
            "只允许 routes 键"
        );
        let no_routes = serde_json::json!({ "gateway": { "qq": {} } });
        assert!(
            apply_gateway_patch(SAMPLE, &no_routes).is_err(),
            "缺少 routes 必须报错"
        );
    }

    #[test]
    fn validate_candidate_rejects_bad_agent_and_bad_gateway() {
        let bad_env = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n    env:\n      \"k=v\": x\n";
        assert!(
            validate_candidate(bad_env, None).is_err(),
            "env 键含 = 必须拒绝"
        );
        let bad_route = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\ngateway:\n  routes:\n    - source: x\n";
        assert!(
            validate_candidate(bad_route, None).is_err(),
            "route 缺 agent/profile/session 必须拒绝"
        );
    }

    #[test]
    fn write_config_atomically_creates_replaces_and_cleans_temp() {
        let dir = std::env::temp_dir().join(format!("pylon-cfg-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        // 新建
        write_config_atomically(
            &path,
            "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap().trim(),
            "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n".trim()
        );
        // 覆盖（替换语义）
        write_config_atomically(
            &path,
            "agents:\n  b:\n    name: B\n    transport: subprocess\n    exe: python\n",
        )
        .unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("name: B"));
        // 无临时残留
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "失败/成功后不得残留临时文件");
        // 写后重解析等价（§5.5 round-trip）
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(parse(&content).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_config_atomically_fails_on_missing_dir() {
        let dir = std::env::temp_dir().join(format!("pylon-cfg-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("agents.yaml");
        let result = write_config_atomically(&path, "x");
        assert!(
            matches!(result, Err(ConfigError::Write(_))),
            "目标目录缺失必须 config_write_error"
        );
    }

    #[test]
    fn config_lease_uses_os_lock_and_recovers_stale_lock_file() {
        let dir = std::env::temp_dir().join(format!(
            "pylon-config-lease-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        let lock_path = dir.join(".agents.yaml.pylon.lock");
        std::fs::write(&lock_path, b"stale after crash").unwrap();

        let first = ConfigLease::acquire(&path).expect("stale lock file must not block OS lease");
        assert!(
            lock_path.exists(),
            "lease path must be .agents.yaml.pylon.lock"
        );
        assert!(
            !dir.join("agents.yaml.pylon.lock").exists(),
            "legacy non-hidden lease path must not be used"
        );
        assert!(
            matches!(ConfigLease::acquire(&path), Err(ConfigError::LockBusy(_))),
            "a live lease must reject a concurrent writer"
        );
        drop(first);
        ConfigLease::acquire(&path).expect("dropping the OS lease must make it reusable");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_transaction_is_cas_and_backup_is_previous_exact_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "pylon-config-cas-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        let first = b"agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: a\n";
        let second = b"agents:\n  b:\n    name: B\n    transport: subprocess\n    exe: b\n";
        let third = b"agents:\n  c:\n    name: C\n    transport: subprocess\n    exe: c\n";
        std::fs::write(&path, first).unwrap();
        let stale = dir.join(".agents.yaml.tmp-old-process-1");
        let unrelated = dir.join(".agents.yaml.user-copy");
        std::fs::write(&stale, b"partial").unwrap();
        std::fs::write(&unrelated, b"keep").unwrap();
        let baseline = config_revision_for_bytes(first);

        let second_revision =
            write_config_transaction(&path, &baseline, second).expect("first writer wins");
        assert_eq!(std::fs::read(&path).unwrap(), second);
        assert_eq!(
            std::fs::read(path.with_extension("yaml.bak")).unwrap(),
            first
        );
        assert!(!stale.exists(), "own stale temp naming rule must self-heal");
        assert!(unrelated.exists(), "cleanup must not touch unrelated files");

        let error = write_config_transaction(&path, &baseline, third)
            .expect_err("stale writer must conflict");
        assert!(matches!(error, ConfigError::Conflict { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), second);
        assert_eq!(second_revision, config_revision_for_bytes(second));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_transaction_backup_failure_preserves_current_file() {
        let dir = std::env::temp_dir().join(format!(
            "pylon-config-backup-failure-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        let current = b"agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: a\n";
        std::fs::write(&path, current).unwrap();
        std::fs::create_dir(path.with_extension("yaml.bak")).unwrap();

        let error = write_config_transaction(
            &path,
            &config_revision_for_bytes(current),
            b"agents:\n  b:\n    name: B\n    transport: subprocess\n    exe: b\n",
        )
        .expect_err("backup replacement must fail");
        assert!(matches!(error, ConfigError::Backup(_)));
        assert_eq!(std::fs::read(&path).unwrap(), current);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 施工文档 Phase 2：agent_fields / agent_create 纯函数 ──

    #[test]
    fn agent_field_patch_updates_whitelisted_fields_and_preserves_advanced_fields() {
        let content = "agents:\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: python\n    model: deepseek\n    acp:\n      rpc_timeout_secs: 60\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: python\n    default: true\n";
        let patched = apply_agent_field_patch(
            content,
            "peri",
            &serde_json::json!({ "exe": "F:/Agent/peri.exe", "name": "Peri2", "provider": "PERI" }),
        )
        .unwrap();
        let agents = parse(&patched).unwrap();
        assert_eq!(agents["peri"].exe, "F:/Agent/peri.exe");
        assert_eq!(agents["peri"].name, "Peri2");
        assert_eq!(agents["peri"].provider.as_deref(), Some("peri"));
        assert_eq!(agents["peri"].model.as_deref(), Some("deepseek"));
        assert_eq!(agents["peri"].protocol().rpc_timeout(), 60);
        assert!(agents["hermes"].default, "非目标 default 不受 patch 影响");
    }

    #[test]
    fn agent_field_patch_default_true_mutual_exclusion() {
        let content = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n    default: true\n  b:\n    name: B\n    transport: subprocess\n    exe: python\n";
        let patched =
            apply_agent_field_patch(content, "b", &serde_json::json!({ "default": true })).unwrap();
        let agents = parse(&patched).unwrap();
        assert!(agents["b"].default, "目标必须置 default");
        assert!(
            !agents["a"].default,
            "其他 agent 必须在同一事务内取消 default"
        );
        assert_eq!(default_agent_id(&agents).unwrap(), Some("b".to_string()));
    }

    #[test]
    fn embedded_repository_config_can_materialize_default_switch() {
        let content = include_str!("../../../agents.example.yaml");
        let patched =
            apply_agent_field_patch(content, "hermes", &serde_json::json!({ "default": true }))
                .expect("repository config field patch must succeed");
        let agents = validate_candidate(&patched, None)
            .expect("repository config candidate must remain valid");
        assert_eq!(
            default_agent_id(&agents).unwrap(),
            Some("hermes".to_string())
        );
    }

    #[test]
    fn agent_field_patch_rejects_unknown_and_bad_types() {
        let content = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n";
        assert!(apply_agent_field_patch(content, "a", &serde_json::json!({ "env": {} })).is_err());
        assert!(apply_agent_field_patch(content, "a", &serde_json::json!({ "exe": 1 })).is_err());
        assert!(
            apply_agent_field_patch(content, "a", &serde_json::json!({ "transport": "http" }))
                .is_err()
        );
        assert!(
            apply_agent_field_patch(content, "ghost", &serde_json::json!({ "name": "X" })).is_err()
        );
    }

    #[test]
    fn agent_create_inserts_new_agent_and_rejects_duplicate() {
        let content = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n";
        let agent = serde_json::json!({
            "name": "B: #1",
            "provider": "custom",
            "transport": "subprocess",
            "exe": "C:\\Program Files\\Agent\\agent.exe",
            "args": ["acp", "--profile", "work space"]
        });
        let created = apply_agent_create(content, "b.v2", &agent).unwrap();
        let agents = parse(&created).unwrap();
        assert!(agents.contains_key("b.v2"));
        let created_document = parse_config_document(&created).unwrap();
        let created_agent = created_document["agents"]["b.v2"]
            .as_mapping()
            .expect("created agent node");
        assert_eq!(
            created_agent.get("name").and_then(serde_yml::Value::as_str),
            Some("B: #1")
        );
        assert!(
            created_agent.get("agents").is_none(),
            "不得嵌套完整 agents 文档"
        );
        assert!(apply_agent_create(
            content,
            "a",
            &serde_json::json!({ "name": "X", "transport": "subprocess", "exe": "python" })
        )
        .is_err());
        assert!(apply_agent_create(
            content,
            "nested",
            &serde_json::json!({ "agents": { "nested": agent } })
        )
        .is_err());
    }

    #[test]
    fn structured_agents_document_round_trips_special_characters() {
        let document = serde_json::json!({
            "agents": {
                "custom-agent": {
                    "name": "Agent: #1",
                    "provider": "custom",
                    "transport": "subprocess",
                    "exe": "C:\\Program Files\\Agent\\agent.exe",
                    "args": ["acp", "--profile", "work space"],
                    "default": true
                }
            }
        });
        let serialized = serialize_agents_document(&document).unwrap();
        let agents = parse(&serialized).unwrap();
        let custom = agents.get("custom-agent").expect("custom agent");
        assert_eq!(custom.name, "Agent: #1");
        assert_eq!(custom.exe, "C:\\Program Files\\Agent\\agent.exe");
        assert_eq!(custom.args, vec!["acp", "--profile", "work space"]);
        assert!(serialize_agents_document(&serde_json::json!({ "agents": {} })).is_err());
    }

    #[test]
    fn agent_id_validation_matches_contract() {
        assert!(validate_agent_id("peri").is_ok());
        assert!(validate_agent_id("agent.v2-beta_x").is_ok());
        assert!(validate_agent_id("_bad").is_err());
        assert!(validate_agent_id("bad id").is_err());
        assert!(validate_agent_id("").is_err());
    }
