use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn fixture_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "pylon-detection-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

/// P91 批 C1（横切 §3）：fixture 根目录 RAII 守卫——断言失败 panic / 提前
/// return 也清理（旧式测试尾部手工 remove_dir_all 在失败路径泄漏目录）。
/// 经 Deref 透明使用：`root.join(..)` / `&root` / `root.clone()` 语义与原
/// PathBuf 一致（clone 走解歧到 PathBuf，不再克隆守卫）。
struct FixtureRoot(PathBuf);

impl FixtureRoot {
    fn new(label: &str) -> Self {
        Self(fixture_root(label))
    }
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl std::ops::Deref for FixtureRoot {
    type Target = PathBuf;

    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

// fs::create_dir_all(&root) 等 AsRef<Path> 泛型边界不走路由解强制转换，需显式实现。
impl AsRef<Path> for FixtureRoot {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

/// 写入一个名为 `command` 的假可执行文件；`version` 为 `None` 时以非零退出，
/// 模拟「存在但读不出」（与 `make_hanging_executable` 同一夹具手法）。
fn plant_version_tool(root: &Path, command: &str, version: Option<&str>) {
    std::fs::create_dir_all(root).unwrap();
    #[cfg(windows)]
    {
        let path = root.join(format!("{command}.cmd"));
        let body = match version {
            Some(version) => format!("@echo off\r\necho {version}\r\nexit /b 0\r\n"),
            None => "@echo off\r\nexit /b 7\r\n".to_string(),
        };
        std::fs::write(&path, body).unwrap();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join(command);
        let body = match version {
            Some(version) => format!("#!/bin/sh\necho '{version}'\n"),
            None => "#!/bin/sh\nexit 7\n".to_string(),
        };
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn make_hanging_executable(root: &Path, command: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let path = root.join(format!("{command}.cmd"));
        std::fs::write(&path, "@echo off\r\nping 127.0.0.1 -n 30 >nul\r\n").unwrap();
        path
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join(command);
        std::fs::write(&path, "#!/bin/sh\nsleep 30\n").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }
}

/// B0/缺口1：npm 全局元数据版本源只有在「声明的 gate 真的消费版本」且直接
/// 探针未给出版本时才被咨询（否则每次扫描都会白跑一次 npm）。
///
/// 这是对**接线判定**的断言，与机器上装了什么无关。
#[test]
fn npm_version_fallback_is_gate_and_probe_conditioned() {
    let rules = crate::agent_catalog::detection_profiles().unwrap();
    let rule = |provider: &str| {
        rules
            .iter()
            .find(|rule| rule.provider == provider)
            .unwrap_or_else(|| panic!("{provider} 必须在 catalog 中"))
            .clone()
    };
    // claude-code 的 gate 以「适配器版本」为证据，因此需要版本值。
    assert!(needs_npm_version_fallback(&rule("claude-code"), None));
    // 直接探针已经给出版本 → 不再花一次 npm 查询。
    assert!(!needs_npm_version_fallback(
        &rule("claude-code"),
        Some("0.75.1")
    ));
    // codex 的 gate 是静态策略（goalControlOutOfBand），不消费版本。
    assert!(!needs_npm_version_fallback(&rule("codex"), None));
    // 完全没有 gate 的 provider。
    assert!(!needs_npm_version_fallback(&rule("peri"), None));
}

/// B0：运行时工具探针（Node/uv）的三态与无副作用。
///
/// 三态是关键：存在→Known、存在但读不出→Unknown（不是违规）、不存在→Absent。
#[tokio::test]
async fn runtime_tool_probe_maps_known_unknown_and_absent() {
    let root = FixtureRoot::new("tool-probe");
    std::fs::create_dir_all(&root).unwrap();

    // 1）存在且可读 → Known
    let readable = root.join("readable");
    plant_version_tool(&readable, "node", Some("22.19.0"));
    assert_eq!(
        probe_tool_version(
            "node",
            &[],
            std::slice::from_ref(&readable),
            Duration::from_secs(2)
        )
        .await,
        ToolVersion::Known("22.19.0".into())
    );

    // 2）存在但不可读 → Unknown
    let unreadable = root.join("unreadable");
    plant_version_tool(&unreadable, "node", None);
    assert_eq!(
        probe_tool_version(
            "node",
            &[],
            std::slice::from_ref(&unreadable),
            Duration::from_secs(2)
        )
        .await,
        ToolVersion::Unknown
    );

    // 3）不存在 → Absent
    assert_eq!(
        probe_tool_version("node", &[], &[root.join("missing")], Duration::from_secs(2)).await,
        ToolVersion::Absent
    );

    // 4）预算耗尽 → Unknown（不启动探针，也不假装读到版本）
    assert_eq!(
        probe_tool_version("node", &[], std::slice::from_ref(&readable), Duration::ZERO).await,
        ToolVersion::Unknown
    );

    // 5）无安装副作用：探针不创建任何文件
    let clean = root.join("clean");
    std::fs::create_dir_all(&clean).unwrap();
    let _ = probe_tool_version(
        "node",
        &[],
        std::slice::from_ref(&clean),
        Duration::from_secs(2),
    )
    .await;
    assert_eq!(
        std::fs::read_dir(&clean).unwrap().count(),
        0,
        "工具探针不得创建任何文件/目录"
    );
}

#[test]
fn windows_key_is_case_insensitive() {
    let key = path_key(Path::new("Peri.EXE"));
    if cfg!(windows) {
        assert_eq!(key, key.to_lowercase())
    }
}
#[test]
fn detector_set_contains_only_verified_native_acp_servers() {
    let rules = crate::agent_catalog::detection_profiles().unwrap();
    assert_eq!(
        rules
            .iter()
            .map(|rule| rule.detector_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "builtin.detector.peri",
            "builtin.detector.hermes",
            "builtin.detector.claude-code",
            "builtin.detector.codex",
        ],
    );
    assert_eq!(
        rules[0].invocations[0].args,
        ["acp"],
        "Peri 的 ACP 入口必须是 peri acp"
    );
    assert_eq!(
        rules[1].invocations[0].args,
        ["acp"],
        "Hermes 的主 ACP 入口必须是 hermes acp"
    );
    assert_eq!(
        rules[2].invocations[0].args,
        ["--acp"],
        "Claude Code 的 ACP 入口必须显式带 --acp"
    );
    // A5①：codex 是第二个 wrapper。ACP 入口是适配器 `codex-acp`，
    // 而 vendor CLI `codex` 只作为 adapterRelation 的探测证据。
    let codex = rules
        .iter()
        .find(|rule| rule.provider == "codex")
        .expect("codex 必须在 catalog 中");
    assert_eq!(codex.invocations[0].command, "codex-acp");
    assert!(codex.invocations[0].args.is_empty());
    let relation = codex
        .adapter_relation
        .as_ref()
        .expect("codex 必须声明 adapter relation");
    assert_eq!(relation.native_cmd, "codex");
    assert_eq!(relation.shared_config_dir, "~/.codex");
    assert_eq!(relation.extra_dirs, vec![".local/bin"]);
    assert!(
        rules.iter().all(|rule| rule.provider != "pi"),
        "pi --mode rpc 是私有 JSONL RPC，不得伪装成 ACP runtime",
    );
}

#[test]
fn detached_windows_launcher_resolves_real_stdio_executable() {
    assert_eq!(
        detached_windows_launcher_target(
            "@echo off\nstart \"Peri\" \"F:\\\\Agent\\\\peri.exe\" %*\n"
        ),
        Ok(Some(r"F:\\Agent\\peri.exe".to_string())),
    );
    assert_eq!(
        detached_windows_launcher_target("@echo off\nnode \"agent.js\" %*\n"),
        Ok(None)
    );
    assert_eq!(
        detached_windows_launcher_target("start \"Peri\" missing-target %*\n"),
        Err(())
    );
}

#[test]
fn structured_config_evidence_reports_field_names_without_values() {
    let root = FixtureRoot::new("config");
    let home = root.join("home");
    let config_dir = home.join(".hermes");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join("config.yaml"),
        "provider: private-provider\nmodel: private-model\napi_key: super-secret\n",
    )
    .unwrap();
    let rule = crate::agent_catalog::detection_profiles()
        .unwrap()
        .into_iter()
        .find(|rule| rule.provider == "hermes")
        .unwrap();

    let evidence = config_evidence(&rule, Some(&home));
    let structured = evidence
        .iter()
        .find(|item| item.kind == "config-fields")
        .expect("structured evidence");
    assert!(structured.detail.contains("provider"));
    assert!(structured.detail.contains("model"));
    assert!(!structured.detail.contains("private-provider"));
    assert!(!structured.detail.contains("private-model"));
    assert!(!structured.detail.contains("super-secret"));
}

#[test]
fn all_installed_invocation_aliases_are_discovered() {
    let root = FixtureRoot::new("aliases");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(&executable_names("hermes")[0]), b"fixture").unwrap();
    std::fs::write(root.join(&executable_names("hermes-acp")[0]), b"fixture").unwrap();
    let rule = crate::agent_catalog::detection_profiles()
        .unwrap()
        .into_iter()
        .find(|rule| rule.provider == "hermes")
        .unwrap();

    let found = find_rule(&rule, Some(std::slice::from_ref(&*root)));

    assert_eq!(found.len(), 2, "首个 alias 不得遮蔽后续已安装 alias");
    assert_eq!(found[0].args, ["acp"]);
    assert!(found[1].args.is_empty());
}

#[tokio::test]
async fn standalone_entry_uses_the_same_structured_evidence_engine() {
    let root = FixtureRoot::new("standalone");
    let home = root.join("home");
    let search = root.join("bin");
    std::fs::create_dir_all(home.join(".hermes")).unwrap();
    std::fs::create_dir_all(&search).unwrap();
    std::fs::write(
        home.join(".hermes/config.yaml"),
        "provider: fixture\nmodel: fixture-model\n",
    )
    .unwrap();
    std::fs::write(
        search.join(&executable_names("hermes")[0]),
        b"not-an-executable",
    )
    .unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.hermes".into()]),
        home_dir: Some(home),
        search_roots: Some(vec![search]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();
    let candidates = report.candidates;
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].provider, "hermes");
    assert_eq!(candidates[0].identity_confidence, IdentityConfidence::High);
    assert!(candidates[0]
        .evidence
        .iter()
        .any(|item| item.kind == "config-fields"));
}

/// A1 验收：wrapper provider 的 ACP 与原生 CLI 证据分开展开，且即使 ACP
/// 候选缺失也会产出 provider 级证据（这是 `adapterMissing` 可观察的前提）。
#[tokio::test]
async fn wrapper_evidence_separates_acp_from_native_cli() {
    let root = FixtureRoot::new("adapter-relation");
    let home = root.join("home");
    let search = root.join("bin");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::create_dir_all(&search).unwrap();
    // 只有原生 CLI，没有 wrapper 可执行文件。
    std::fs::write(
        search.join(&executable_names("claude")[0]),
        b"not-an-executable",
    )
    .unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.claude-code".into()]),
        home_dir: Some(home),
        search_roots: Some(vec![search]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();
    assert!(
        report.candidates.is_empty(),
        "wrapper 命令不存在，不应有候选"
    );
    assert_eq!(report.providers.len(), 1);
    let evidence = &report.providers[0];
    assert_eq!(evidence.provider, "claude-code");
    assert!(evidence.adapter_relation_declared);
    assert!(evidence.acp_commands.is_empty());
    assert_eq!(evidence.native_commands.len(), 1);
    assert_eq!(
        Path::new(&evidence.native_commands[0].path)
            .file_stem()
            .and_then(|stem| stem.to_str()),
        Some("claude")
    );
    assert!(evidence.shared_config_present);
}

/// 非 wrapper provider 不探测第二 CLI，也不报共享配置目录存在。
#[tokio::test]
async fn native_acp_provider_has_no_second_cli_evidence() {
    let root = FixtureRoot::new("native-evidence");
    let home = root.join("home");
    let search = root.join("bin");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&search).unwrap();
    std::fs::write(
        search.join(&executable_names("peri")[0]),
        b"not-an-executable",
    )
    .unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.peri".into()]),
        home_dir: Some(home),
        search_roots: Some(vec![search]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();
    let evidence = &report.providers[0];
    assert!(!evidence.adapter_relation_declared);
    assert!(evidence.native_commands.is_empty());
    assert!(!evidence.shared_config_present);
    assert_eq!(evidence.acp_commands.len(), 1);
    assert_eq!(evidence.acp_commands[0].kind, "acp-command");
}

/// A1 零安装副作用：探测只读，不创建目录。
#[tokio::test]
async fn evidence_scan_has_no_install_side_effects() {
    let root = FixtureRoot::new("no-side-effects");
    let home = root.join("home");
    let search = root.join("bin");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&search).unwrap();
    let before = std::fs::read_dir(&home).unwrap().count();
    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.claude-code".into()]),
        home_dir: Some(home.clone()),
        search_roots: Some(vec![search.clone()]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();
    assert!(report.candidates.is_empty());
    // 既不建 `~/.claude`，也不建任何缓存/安装目录。
    assert!(!home.join(".claude").exists());
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), before);
    assert_eq!(std::fs::read_dir(&search).unwrap().count(), 0);
}

/// A5①：codex 的 wrapper 双证据。本机真实状态是「vendor CLI 在、ACP 适配器
/// 不在」（`codex` 已装、`codex-acp` 未装），必须产出可行动的 `adapterMissing`。
#[tokio::test]
async fn codex_wrapper_reports_adapter_missing_with_native_cli_present() {
    let root = FixtureRoot::new("codex-adapter-missing");
    let home = root.join("home");
    let search = root.join("bin");
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    std::fs::create_dir_all(&search).unwrap();
    // 只有 vendor CLI `codex`，没有适配器 `codex-acp`。
    std::fs::write(
        search.join(&executable_names("codex")[0]),
        b"not-an-executable",
    )
    .unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.codex".into()]),
        home_dir: Some(home),
        search_roots: Some(vec![search]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();
    assert!(
        report.candidates.is_empty(),
        "适配器不存在，不应有 ACP 候选"
    );
    let evidence = &report.providers[0];
    assert_eq!(evidence.provider, "codex");
    assert!(evidence.adapter_relation_declared);
    assert!(evidence.acp_commands.is_empty());
    assert_eq!(evidence.native_commands.len(), 1);
    assert!(evidence.shared_config_present);

    // 同一份证据经共享映射得到可行动状态（与设置页/CLI 一致）。
    let preflight = crate::agent_preflight::from_detection(evidence, &report.candidates).unwrap();
    assert_eq!(
        preflight.status,
        crate::agent_preflight::PreflightStatus::AdapterMissing
    );
    assert!(!preflight.passed);
    assert_eq!(
        crate::agent_preflight::action_code(preflight.status),
        "install-acp-adapter"
    );
    let adapter = preflight.adapter.expect("codex 是 wrapper");
    assert_eq!(adapter.native_cmd, "codex");
    assert_eq!(adapter.native_label, "Codex CLI");
    assert_eq!(adapter.shared_config_dir, "~/.codex");
    // 两侧证据必须分开：vendor CLI 已找到、ACP 适配器未找到。
    assert!(adapter.native_present);
    assert!(!adapter.acp_present);
    assert!(adapter.shared_config_present);
}

#[tokio::test]
async fn unknown_detector_is_a_successful_empty_report_with_a_diagnostic() {
    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["missing.detector".into()]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();

    assert!(report.candidates.is_empty());
    assert_eq!(report.diagnostics.len(), 1);
    assert_eq!(report.diagnostics[0].code, "unknown_detector_id");
    assert_eq!(report.diagnostics[0].stage, "selection");
    assert_eq!(
        report.diagnostics[0].detector_id.as_deref(),
        Some("missing.detector")
    );
    // 选择类诊断没有候选上下文：两个归因字段恒为 None（与探测类诊断区分开）。
    assert_eq!(report.diagnostics[0].candidate_id, None);
    assert_eq!(report.diagnostics[0].executable, None);
}

#[tokio::test]
async fn discovery_reports_identity_separately_from_protocol_availability() {
    let root = FixtureRoot::new("identity-protocol");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(&executable_names("hermes")[0]), b"fixture").unwrap();
    std::fs::write(root.join(&executable_names("hermes-acp")[0]), b"fixture").unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.hermes".into()]),
        home_dir: Some(root.join("home")),
        search_roots: Some(vec![root.clone()]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();

    // issue #67B 契约变更（原断言：两种 invocation → 两条候选、候选 id 互不相同）：
    // 同一 agent 的多种证据（hermes acp / hermes-acp）是**同一身份**的证据面，
    // 必须折叠为一条候选；被折叠形式保留在 evidence + warnings 中，不得静默丢掉。
    assert_eq!(
        report.candidates.len(),
        1,
        "同一 detector 的多重证据必须合并为一条候选"
    );
    let candidate = &report.candidates[0];
    assert_eq!(candidate.provider, "hermes");
    assert_eq!(candidate.args, ["acp"], "代表取既有稳定序的更优形式");
    assert!(
        candidate
            .evidence
            .iter()
            .any(|evidence| evidence.kind == "folded-runtime"
                && evidence.detail.contains("hermes-acp")),
        "被折叠形式必须以 folded-runtime 证据留痕"
    );
    assert!(
        candidate
            .warnings
            .iter()
            .any(|warning| warning.contains("同一 Agent 另有可执行形式")),
        "合并必须显式告警，而不是静默丢弃一条真实安装"
    );
    // 原意图保留：身份可信度 / 启动性 / 协议可用性三个维度仍分别上报。
    assert_eq!(candidate.identity_confidence, IdentityConfidence::Medium);
    assert_eq!(candidate.startability, Startability::Failed);
    assert_eq!(
        candidate.protocol_availability,
        ProtocolAvailability::NotTested
    );
}

/// issue #67B：同一 invocation 在多个安装位置命中（PATH 与 known-path / 多个搜索根）
/// 也是同一 agent 的多重证据，必须折叠；折叠后仍能看出存在第二处安装。
#[tokio::test]
async fn same_agent_found_in_multiple_roots_folds_into_one_candidate() {
    let root = FixtureRoot::new("identity-multi-root");
    let first = root.join("bin-a");
    let second = root.join("bin-b");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    std::fs::write(first.join(&executable_names("hermes")[0]), b"fixture").unwrap();
    std::fs::write(second.join(&executable_names("hermes")[0]), b"fixture").unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.hermes".into()]),
        home_dir: Some(root.join("home")),
        search_roots: Some(vec![first.clone(), second.clone()]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();

    assert_eq!(report.candidates.len(), 1, "同一 agent 的两处安装必须合并");
    let candidate = &report.candidates[0];
    let folded: Vec<&AgentDetectionEvidence> = candidate
        .evidence
        .iter()
        .filter(|evidence| evidence.kind == "folded-runtime")
        .collect();
    assert_eq!(
        folded.len(),
        1,
        "另一处安装必须留下一条 folded-runtime 证据"
    );
    assert!(
        folded[0].detail.contains("bin-b") || folded[0].detail.contains("bin-a"),
        "折叠证据必须写明被折叠的可执行文件路径：{}",
        folded[0].detail
    );
    assert_eq!(candidate.already_imported_agent_id, None);
}

/// issue #67B：身份键包含 provider——不同 agent 的多重证据**永不**互相合并。
#[tokio::test]
async fn different_providers_are_never_merged() {
    let root = FixtureRoot::new("identity-cross-provider");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(&executable_names("hermes")[0]), b"fixture").unwrap();
    std::fs::write(root.join(&executable_names("hermes-acp")[0]), b"fixture").unwrap();
    std::fs::write(root.join(&executable_names("peri")[0]), b"fixture").unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec![
            "builtin.detector.hermes".into(),
            "builtin.detector.peri".into(),
        ]),
        home_dir: Some(root.join("home")),
        search_roots: Some(vec![root.clone()]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();

    let mut providers: Vec<&str> = report
        .candidates
        .iter()
        .map(|candidate| candidate.provider.as_str())
        .collect();
    providers.sort();
    assert_eq!(
        providers,
        vec!["hermes", "peri"],
        "跨 provider 的候选绝不合并"
    );
}

/// issue #67B：导入侧判定改用 provider 身份——已配置的 agent 即使使用另一种启动形式
/// 也必须被认出来（否则界面显示"未导入"并诱导重复导入），且已导入变体优先当代表。
#[tokio::test]
async fn configured_agent_matches_by_provider_identity_across_launch_forms() {
    let root = FixtureRoot::new("identity-imported-form");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(&executable_names("hermes")[0]), b"fixture").unwrap();
    std::fs::write(root.join(&executable_names("hermes-acp")[0]), b"fixture").unwrap();

    // 已配置的 agent 采用 hermes-acp 形式（alias_index 更靠后 → 默认不是代表）。
    let mut configured: ConfiguredRuntimes = HashMap::new();
    configured.insert(
        "hermes-existing".to_string(),
        (
            "hermes".to_string(),
            path_key(&root.join(&executable_names("hermes-acp")[0])),
            Vec::new(),
        ),
    );

    let report = detect_agent_runtime_candidates_inner(
        AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.hermes".into()]),
            home_dir: Some(root.join("home")),
            search_roots: Some(vec![root.clone()]),
            ..AgentDetectionOptions::default()
        },
        &configured,
    )
    .await
    .unwrap();

    assert_eq!(report.candidates.len(), 1);
    let candidate = &report.candidates[0];
    assert_eq!(
        candidate.already_imported_agent_id.as_deref(),
        Some("hermes-existing"),
        "同 provider 的既有配置必须被认出来"
    );
    assert_eq!(
        candidate.args,
        ["acp"],
        "provider 身份回退让同一 provider 的所有变体都属于已导入，代表仍取既有稳定序的更优形式"
    );
    assert!(
        candidate
            .warnings
            .iter()
            .any(|warning| warning.contains("同一 Agent 另有可执行形式")),
        "合并后的代表与折叠形式必须都有留痕"
    );
}

fn synthetic_candidate(
    detector_id: &str,
    provider: &str,
    executable: &str,
    args: &[&str],
    alias_index: usize,
    imported: Option<&str>,
    version: Option<&str>,
) -> RankedCandidate {
    let mut evidence = vec![AgentDetectionEvidence {
        kind: "path".into(),
        detail: executable.into(),
    }];
    if let Some(version) = version {
        evidence.push(AgentDetectionEvidence {
            kind: "version".into(),
            detail: version.into(),
        });
    }
    (
        AgentRuntimeCandidate {
            candidate_id: format!("{provider}:{executable}:{}", args.join("_")),
            detector_id: detector_id.into(),
            provider: provider.into(),
            suggested_agent_id: provider.into(),
            name: provider.into(),
            executable: executable.into(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            alternatives: Vec::new(),
            evidence,
            identity_confidence: IdentityConfidence::Medium,
            startability: Startability::NotTested,
            protocol_availability: ProtocolAvailability::NotTested,
            already_imported_agent_id: imported.map(str::to_string),
            warnings: Vec::new(),
        },
        100,
        IdentityConfidence::Medium,
        alias_index,
        false,
        executable.into(),
        "path".into(),
    )
}

/// 合并规则（纯函数层）：已导入变体优先当代表（否则"已导入"会在合并后丢失）；
/// 版本不一致必须显式告警；被折叠形式逐条写入 evidence 与 warnings。
#[test]
fn merge_prefers_the_imported_variant_and_warns_on_version_conflict() {
    let merged = merge_candidates_by_identity(vec![
        synthetic_candidate(
            "d",
            "hermes",
            "C:/a/hermes",
            &["acp"],
            0,
            None,
            Some("1.0.0"),
        ),
        synthetic_candidate(
            "d",
            "hermes",
            "C:/b/hermes-acp",
            &[],
            1,
            Some("hermes-existing"),
            Some("2.0.0"),
        ),
    ]);
    assert_eq!(merged.len(), 1, "同一 detector 必须合并");
    let candidate = &merged[0];
    assert_eq!(candidate.0.alternatives.len(), 1);
    assert_eq!(candidate.0.alternatives[0].executable, "C:/a/hermes");
    assert_eq!(candidate.0.alternatives[0].args, vec!["acp"]);
    assert_eq!(
        candidate.0.already_imported_agent_id.as_deref(),
        Some("hermes-existing")
    );
    assert_eq!(
        candidate.0.executable, "C:/b/hermes-acp",
        "已导入变体必须成为代表"
    );
    assert!(
        candidate
            .0
            .evidence
            .iter()
            .any(|evidence| evidence.kind == "folded-runtime"
                && evidence.detail.contains("C:/a/hermes")),
        "折叠形式必须留证"
    );
    assert!(
        candidate
            .0
            .warnings
            .iter()
            .any(|warning| warning.contains("版本不一致")
                && warning.contains("1.0.0")
                && warning.contains("2.0.0")),
        "版本冲突必须显式告警"
    );
    assert!(candidate
        .0
        .warnings
        .iter()
        .any(|warning| warning.contains("同一 Agent 另有可执行形式")));
}

/// 身份键含 detector/provider：不同 agent 的候选绝不互相合并（防御路径）。
#[test]
fn merge_never_collapses_different_detectors() {
    let merged = merge_candidates_by_identity(vec![
        synthetic_candidate(
            "builtin.detector.hermes",
            "hermes",
            "C:/a/hermes",
            &["acp"],
            0,
            None,
            None,
        ),
        synthetic_candidate(
            "builtin.detector.peri",
            "peri",
            "C:/a/peri",
            &[],
            0,
            None,
            None,
        ),
    ]);
    assert_eq!(merged.len(), 2, "跨 detector 的候选绝不合并");
}

#[tokio::test]
async fn candidate_limit_is_stable_and_explicitly_truncated() {
    let root = FixtureRoot::new("candidate-limit");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(&executable_names("hermes")[0]), b"fixture").unwrap();
    std::fs::write(root.join(&executable_names("hermes-acp")[0]), b"fixture").unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.hermes".into()]),
        home_dir: Some(root.join("home")),
        search_roots: Some(vec![root.clone()]),
        limits: AgentDetectionLimits {
            max_candidates: 1,
            ..AgentDetectionLimits::default()
        },
    })
    .await
    .unwrap();

    assert_eq!(report.candidates.len(), 1);
    assert!(report.truncated);
    assert!(report
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "candidate_limit_reached"));
    assert_eq!(report.candidates[0].args, ["acp"]);
}

#[tokio::test]
async fn exact_name_lookup_reaches_search_roots_after_the_sixteenth_entry() {
    let root = FixtureRoot::new("root-limit");
    let roots = (0..17)
        .map(|index| root.join(format!("bin-{index}")))
        .collect::<Vec<_>>();
    for path in &roots {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(roots[16].join(&executable_names("peri")[0]), b"fixture").unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.peri".into()]),
        home_dir: Some(root.join("home")),
        search_roots: Some(roots.clone()),
        limits: AgentDetectionLimits {
            version_probe_budget: Duration::from_millis(50),
            ..AgentDetectionLimits::default()
        },
    })
    .await
    .unwrap();

    assert_eq!(
        report.candidates.len(),
        1,
        "PATH 后段的精确命令名也必须被发现"
    );
    assert_eq!(
        Path::new(&report.candidates[0].executable),
        roots[16].join(&executable_names("peri")[0]),
    );
    assert!(!report.truncated, "精确文件名检查不应被搜索目录数量截断");
}

#[tokio::test]
async fn version_probe_uses_catalog_arguments_and_standard_default() {
    let root = FixtureRoot::new("version-args");
    std::fs::create_dir_all(&root).unwrap();
    #[cfg(windows)]
    let (executable, args) = {
        let path = root.join("probe.cmd");
        std::fs::write(&path, "@echo off\r\necho startup notice\r\nif \"%1 %2\"==\"version --numeric\" (\r\n  echo 1.2.3 1>&2\r\n  exit /b 0\r\n)\r\nif \"%1 %2\"==\"--version \" (\r\n  echo 2.3.4 1>&2\r\n  exit /b 0\r\n)\r\nexit /b 7\r\n").unwrap();
        (path, vec!["version".to_string(), "--numeric".to_string()])
    };
    #[cfg(unix)]
    let (executable, args) = {
        let path = root.join("probe.sh");
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, "#!/bin/sh\necho 'startup notice'\ncase \"$*\" in\n'version --numeric') echo '1.2.3' >&2;;\n'--version') echo '2.3.4' >&2;;\n*) exit 7;;\nesac\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (path, vec!["version".into(), "--numeric".into()])
    };
    let result = version_probe("fixture", executable.clone(), &args, Duration::from_secs(2)).await;
    assert_eq!(result.version.as_deref(), Some("1.2.3"));
    assert_eq!(result.startability, Startability::Verified);
    {
        let default =
            version_probe("fixture", executable.clone(), &[], Duration::from_secs(2)).await;
        assert_eq!(default.version.as_deref(), Some("2.3.4"));
        let invalid = version_probe(
            "fixture",
            executable,
            &["acp".into()],
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(invalid.startability, Startability::NotTested);
        assert_eq!(invalid.diagnostic.unwrap().code, "version_probe_non_zero");
    }
}

#[cfg(windows)]
#[tokio::test]
async fn windows_discovery_does_not_select_a_unix_launcher_over_a_batch_entry() {
    let root = FixtureRoot::new("windows-launcher");
    plant_version_tool(&root, "ccb", None);
    std::fs::write(root.join("ccb"), "#!/bin/sh\nexec node cli.js \"$@\"\n").unwrap();
    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.claude-code".into()]),
        search_roots: Some(vec![root.to_path_buf()]),
        home_dir: Some(root.to_path_buf()),
        ..Default::default()
    })
    .await
    .unwrap();
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(
        Path::new(&report.candidates[0].executable)
            .extension()
            .unwrap(),
        "cmd"
    );
    assert!(!report
        .diagnostics
        .iter()
        .any(|d| d.code == "version_probe_spawn_failed"));
}

/// C1：失败也必须进缓存，而且缓存是**按 key** 而不是全局「记住最后一次」。
///
/// 断言方式是「子进程真的只启动了一次」：夹具每次运行都往自身目录的
/// `count.txt` 追加一行。仅断言「两次返回值相同」是抓不到这个缺陷的——旧实现
/// 每次都返回同样的失败，只是白跑一次子进程，因此这个断言必须数进程。
///
/// 计数文件用 `%~dp0` / `dirname "$0"` 定位（而不是把临时路径嵌进脚本），
/// 既避开带空格的路径，也让两个夹具能各自独立计数。
#[tokio::test]
async fn a_failed_version_probe_is_cached_like_a_successful_one() {
    let root = FixtureRoot::new("probe-failure-cache");
    let failing_dir = root.join("failing");
    let working_dir = root.join("working");
    std::fs::create_dir_all(&failing_dir).unwrap();
    std::fs::create_dir_all(&working_dir).unwrap();
    let failing = plant_counting_probe(&failing_dir, "probe", None);
    let working = plant_counting_probe(&working_dir, "probe", Some("9.9.9"));

    // 第一次：真的跑了，失败带诊断。
    let first = version_probe("fixture", failing.clone(), &[], Duration::from_secs(5)).await;
    assert_eq!(first.startability, Startability::NotTested);
    assert_eq!(
        first.diagnostic.as_ref().map(|d| d.code.as_str()),
        Some("version_probe_non_zero")
    );

    // 第二次：命中缓存——不但结果相同，而且**诊断还在**（缓存的失败必须保留
    // 理由，否则第二次刷新只会看到一个没有原因的失败）。
    let second = version_probe("fixture", failing.clone(), &[], Duration::from_secs(5)).await;
    assert_eq!(second.startability, Startability::NotTested);
    assert_eq!(
        second.diagnostic.as_ref().map(|d| d.code.as_str()),
        Some("version_probe_non_zero"),
        "缓存的失败必须带着与首次相同的诊断"
    );

    // 成功路径同样只跑一次。
    let ok = version_probe("fixture", working.clone(), &[], Duration::from_secs(5)).await;
    assert_eq!(ok.version.as_deref(), Some("9.9.9"));
    let ok_again = version_probe("fixture", working.clone(), &[], Duration::from_secs(5)).await;
    assert_eq!(ok_again.version.as_deref(), Some("9.9.9"));

    let runs = |dir: &Path| {
        std::fs::read_to_string(dir.join("count.txt"))
            .unwrap_or_default()
            .lines()
            .count()
    };
    assert_eq!(
        runs(&failing_dir),
        1,
        "失败的探针不得在每次刷新时重回子进程"
    );
    assert_eq!(runs(&working_dir), 1, "成功的探针不得重复启动子进程");
    // 两个夹具各自只跑一次，证明缓存是按 key 存而不是只记住最后一次。
    assert_eq!(
        runs(&failing_dir) + runs(&working_dir),
        2,
        "缓存必须按 (路径, 参数, mtime) 分键，不得互相驱逐"
    );
}

#[tokio::test]
async fn a_timed_out_version_probe_can_recover_without_changing_the_binary() {
    use super::probe_cache::version_probe;
    let root = FixtureRoot::new("version-timeout-retry");
    std::fs::create_dir_all(&root).unwrap();
    let executable = plant_counting_probe(&root.0, "probe", Some("9.9.9"));
    let body = if cfg!(windows) {
        "@echo off\r\nping 127.0.0.1 -n 2 >nul\r\necho 9.9.9\r\n"
    } else {
        "#!/bin/sh\nsleep 1\necho 9.9.9\n"
    };
    std::fs::write(&executable, body).unwrap();
    let first = version_probe(
        "fixture",
        executable.clone(),
        &[],
        Duration::from_millis(50),
    )
    .await;
    assert_eq!(first.startability, Startability::NotTested);
    assert_eq!(
        first
            .diagnostic
            .as_ref()
            .map(|diagnostic| diagnostic.code.as_str()),
        Some("version_probe_timeout")
    );
    let second = version_probe("fixture", executable, &[], Duration::from_secs(5)).await;
    assert_eq!(second.startability, Startability::Verified);
    assert_eq!(second.version.as_deref(), Some("9.9.9"));
}

/// 安置一个每次运行都向自身目录的 `count.txt` 追加一行的探针夹具。
///
/// `version` 为 `None` 时以非零退出，模拟「存在但不认 --version」。
fn plant_counting_probe(dir: &Path, name: &str, version: Option<&str>) -> PathBuf {
    #[cfg(windows)]
    {
        let path = dir.join(format!("{name}.cmd"));
        let body = match version {
            Some(version) => format!(
                "@echo off\r\n>>\"%~dp0count.txt\" echo x\r\necho {version}\r\nexit /b 0\r\n"
            ),
            None => "@echo off\r\n>>\"%~dp0count.txt\" echo x\r\nexit /b 3\r\n".to_string(),
        };
        std::fs::write(&path, body).unwrap();
        path
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        let count = "echo x >> \"$(dirname \"$0\")/count.txt\"\n";
        let body = match version {
            Some(version) => format!("#!/bin/sh\n{count}echo '{version}'\n"),
            None => format!("#!/bin/sh\n{count}exit 3\n"),
        };
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }
}

/// C2：候选扫描与证据扫描必须看到**同一组**可执行文件。
///
/// 两者以前各自算一份 roots、各自走一遭文件系统，所以可以互相矛盾。现在共用
/// `resolve_roots` + `scan_roots`；这条测试把「不再矛盾」钉成断言，并同时钉住两
/// 侧各自**不同**的来源词汇（候选区分 path/known-path，证据只报 known-path）。
#[tokio::test]
async fn candidate_and_evidence_scans_agree_on_what_exists() {
    let root = FixtureRoot::new("scan-agreement");
    let on_path = root.join("on-path");
    let off_path = root.join("off-path");
    std::fs::create_dir_all(&on_path).unwrap();
    std::fs::create_dir_all(&off_path).unwrap();
    // peri 与 hermes 两个 provider 各放一个 ACP 入口，其中一个在 PATH 上。
    std::fs::write(on_path.join(&executable_names("peri")[0]), b"fixture").unwrap();
    std::fs::write(off_path.join(&executable_names("hermes")[0]), b"fixture").unwrap();
    // 只用夹具目录作为搜索根，不引入真实 PATH 条目：本机装了 peri 时会把真实
    // 安装拖进断言，测试就不再确定。`on_path`/`off_path` 都在临时目录下，因此
    // 两者都必然不在进程 PATH 上。
    let roots = vec![on_path.clone(), off_path.clone()];
    let options = AgentDetectionOptions {
        detector_ids: Some(vec![
            "builtin.detector.peri".into(),
            "builtin.detector.hermes".into(),
        ]),
        home_dir: Some(root.join("home")),
        search_roots: Some(roots),
        limits: AgentDetectionLimits {
            version_probe_budget: Duration::from_millis(50),
            ..AgentDetectionLimits::default()
        },
    };
    let report = detect_agent_runtime_candidates(options).await.unwrap();

    for provider in ["peri", "hermes"] {
        let evidence = report
            .providers
            .iter()
            .find(|evidence| evidence.provider == provider)
            .unwrap_or_else(|| panic!("{provider} 必须有 provider 证据"));
        let candidates = report
            .candidates
            .iter()
            .filter(|candidate| candidate.provider == provider)
            .collect::<Vec<_>>();

        let evidence_paths = evidence
            .acp_commands
            .iter()
            .map(|hit| path_key(Path::new(&hit.path)))
            .collect::<HashSet<_>>();
        let candidate_paths = candidates
            .iter()
            .map(|candidate| path_key(Path::new(&candidate.executable)))
            .collect::<HashSet<_>>();
        assert_eq!(
            evidence_paths, candidate_paths,
            "{provider}: 候选与证据必须定位到同一组可执行文件"
        );
        // 证据侧的词汇：根命中一律 known-path。
        for hit in &evidence.acp_commands {
            assert_eq!(
                hit.source, "known-path",
                "{provider}: 证据只报存在性，不区分是否在 PATH 上"
            );
        }
    }
    // 候选侧的词汇：显式根列表里的目录都不是进程 PATH，所以标 known-path 并带
    // 「不在 PATH」警告；这锁住了 C2 不得顺手把两侧标签合并成一种。
    let peri = report
        .candidates
        .iter()
        .find(|candidate| candidate.provider == "peri")
        .unwrap();
    assert_eq!(peri.evidence[0].kind, "known-path");
    assert!(
        peri.warnings.iter().any(|w| w.contains("不在当前 PATH")),
        "候选侧必须保留 off-PATH 警告"
    );
}

#[tokio::test]
async fn version_probe_timeout_is_bounded_and_visible() {
    let root = FixtureRoot::new("probe-timeout");
    std::fs::create_dir_all(&root).unwrap();
    make_hanging_executable(&root, "peri");

    let started = Instant::now();
    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.peri".into()]),
        home_dir: Some(root.join("home")),
        search_roots: Some(vec![root.clone()]),
        limits: AgentDetectionLimits {
            total_budget: Duration::from_millis(500),
            version_probe_budget: Duration::from_millis(100),
            ..AgentDetectionLimits::default()
        },
    })
    .await
    .unwrap();

    assert!(started.elapsed() < Duration::from_secs(2));
    let timeout = report
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "version_probe_timeout")
        .expect("必须报告探针超时");
    assert_eq!(report.candidates[0].startability, Startability::NotTested);
    // A version timeout remains attributable to the entry, without claiming ACP failed.
    assert!(
        timeout
            .executable
            .as_deref()
            .is_some_and(|path| path.contains("peri")),
        "探测诊断必须带被测可执行文件路径：{timeout:?}"
    );
    assert_eq!(
        timeout.candidate_id.as_deref(),
        Some(report.candidates[0].candidate_id.as_str()),
        "探测诊断的 candidateId 必须指向本报告里真实存在的候选"
    );
}

#[test]
fn npm_list_fixture_extracts_scoped_and_unscoped_versions() {
    assert_eq!(
        parse_npm_list_version(br#"{"dependencies":{"foo":{"version":"1.2.3"}}}"#, "foo")
            .as_deref(),
        Some("1.2.3")
    );
    assert_eq!(
        parse_npm_list_version(
            br#"{"dependencies":{"@scope/foo":{"version":"4.5.6"}}}"#,
            "@scope/foo@4.5.6"
        )
        .as_deref(),
        Some("4.5.6")
    );
    assert!(
        parse_npm_list_version(br#"{"dependencies":{"foo":{"version":"bad"}}}"#, "foo").is_none()
    );
}

#[test]
fn uvx_python_pin_is_explicit_and_empty_when_unset() {
    assert_eq!(uvx_python_args(Some("3.12")), vec!["--python", "3.12"]);
    assert!(uvx_python_args(None).is_empty());
}

/// 受控探测要拉起 `powershell.exe` → `ping.exe -t`，再等它把孙进程 pid 落成文件。
///
/// 等待窗口按「争抢」而非「空闲」取值：空闲机器上这段只需 0.3–1s，但
/// `cargo test --workspace` 全并行时 CI runner 会被饥饿，3s 的窗口会被击穿，
/// 表现为 pid 文件没出现（`descendant pid file`），且随机落在不同的进程类测试上
/// （#157 同一型：Rust 全量并行下 flaky）。
///
/// 预算不是被测契约——被测的是「cleanup 杀掉了孙进程」，故只放宽窗口，
/// 下面两处断言一字未改。
const PROBE_READY_WAIT: Duration = Duration::from_secs(30);
const PROBE_EXIT_WAIT: Duration = Duration::from_secs(10);

#[cfg(windows)]
#[tokio::test]
async fn managed_probe_cleanup_kills_descendant_processes() {
    use pylon_foundations::child_command::HideConsoleWindow;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let root = FixtureRoot::new("probe-tree");
    std::fs::create_dir_all(&root).unwrap();
    let pid_file = root.join("child.pid");
    let escaped_pid_file = pid_file.to_string_lossy().replace("'", "''");
    let script = format!(
            "$child = Start-Process ping.exe -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '{escaped_pid_file}' -Value $child.Id; Wait-Process -Id $child.Id"
        );
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command.hide_console_window();
    let mut child = ManagedProbeChild::new(command.spawn().unwrap());
    let deadline = Instant::now() + PROBE_READY_WAIT;
    // Set-Content creates the file before releasing its exclusive write handle.
    // Readiness means a complete readable PID, rather than file existence.
    let pid = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline, "descendant pid file not ready");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };

    child.kill_and_wait().await;
    let deadline = Instant::now() + PROBE_EXIT_WAIT;
    loop {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            break;
        }
        let mut exit_code = 0u32;
        let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
        unsafe { CloseHandle(handle) };
        const STILL_ACTIVE: u32 = 259;
        if queried && exit_code != STILL_ACTIVE {
            break;
        }
        if Instant::now() >= deadline {
            panic!("version probe descendant {pid} survived cleanup");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ── B0：DetectionSnapshot 组装、缓存策略与快照级 fixture ──

#[test]
fn search_roots_fingerprint_tracks_the_controlled_roots() {
    let left = FixtureRoot::new("fingerprint-left");
    let right = FixtureRoot::new("fingerprint-right");
    std::fs::create_dir_all(&left).unwrap();
    std::fs::create_dir_all(&right).unwrap();

    let a = search_roots_fingerprint(Some(std::slice::from_ref(&*left)));
    let b = search_roots_fingerprint(Some(&[left.clone(), right.clone()]));
    let reordered = search_roots_fingerprint(Some(&[right.clone(), left.clone()]));
    assert_eq!(
        a,
        search_roots_fingerprint(Some(std::slice::from_ref(&*left))),
        "同 roots 必须同指纹"
    );
    assert_ne!(a, b, "roots 集合不同必须产生不同指纹");
    assert_ne!(
        b, reordered,
        "顺序影响候选优先级，顺序不同的搜索不是同一搜索"
    );
}

#[test]
fn outcome_classifies_and_orders_ttls() {
    let clean = AgentDetectionReport {
        candidates: Vec::new(),
        providers: Vec::new(),
        diagnostics: Vec::new(),
        elapsed_ms: 0,
        truncated: false,
    };
    assert_eq!(
        DetectionOutcome::classify(&Ok(clean.clone())),
        DetectionOutcome::Success
    );

    let mut truncated = clean.clone();
    truncated.truncated = true;
    assert_eq!(
        DetectionOutcome::classify(&Ok(truncated)),
        DetectionOutcome::Unknown
    );

    let mut retryable = clean;
    retryable.diagnostics.push(scan_diagnostic(
        "version_probe",
        None,
        "version_probe_timeout",
        "探针超时".into(),
        true,
    ));
    assert_eq!(
        DetectionOutcome::classify(&Ok(retryable)),
        DetectionOutcome::Unknown
    );

    assert_eq!(
        DetectionOutcome::classify(&Err("catalog invalid".to_string())),
        DetectionOutcome::Failure
    );

    assert!(
        DetectionOutcome::Failure.ttl() < DetectionOutcome::Unknown.ttl(),
        "失败必须比 degraded 更快重试"
    );
    assert!(
        DetectionOutcome::Unknown.ttl() < DetectionOutcome::Success.ttl(),
        "degraded 必须比干净结果更快重试"
    );
}

async fn snapshot_for(
    detector_ids: Vec<&str>,
    root: &Path,
    home: &Path,
    limits: AgentDetectionLimits,
) -> DetectionSnapshot {
    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(detector_ids.into_iter().map(String::from).collect()),
        home_dir: Some(home.to_path_buf()),
        search_roots: Some(vec![root.to_path_buf()]),
        limits,
    })
    .await
    .unwrap();
    assemble_detection_snapshot(report, 1_700_000_000_000, Some(&[root.to_path_buf()]))
}

/// B0 fixture：未安装——空 roots + 空 home，每个 provider 都有快照证据且
/// preflight 结论为 notInstalled（裸机不会被报成更具体的状态）。
#[tokio::test]
async fn snapshot_fixture_machine_with_nothing_installed() {
    let root = FixtureRoot::new("snapshot-empty");
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();

    let snapshot = snapshot_for(
        vec!["builtin.detector.peri", "builtin.detector.claude-code"],
        &root,
        &home,
        AgentDetectionLimits::default(),
    )
    .await;

    assert_eq!(
        snapshot.catalog_revision,
        crate::agent_catalog::catalog_revision()
    );
    assert!(snapshot.taken_at_ms > 0);
    assert_eq!(snapshot.report.candidates.len(), 0);
    assert!(
        snapshot.report.providers.len() >= 2,
        "未安装也要产出 provider 证据"
    );
    assert!(snapshot
        .preflight
        .iter()
        .all(|verdict| verdict.status == crate::agent_preflight::PreflightStatus::NotInstalled));
    assert_eq!(
        DetectionOutcome::classify(&Ok(snapshot.report)),
        DetectionOutcome::Success
    );
}

/// B0 fixture：版本超时——探针超时是 retryable 诊断，快照 outcome 必须是
/// Unknown（degraded），不是 Success。
#[tokio::test]
async fn snapshot_fixture_version_timeout_is_degraded() {
    let root = FixtureRoot::new("snapshot-timeout");
    std::fs::create_dir_all(&root).unwrap();
    make_hanging_executable(&root, "peri");

    let snapshot = snapshot_for(
        vec!["builtin.detector.peri"],
        &root,
        &root.join("home"),
        AgentDetectionLimits {
            total_budget: Duration::from_millis(500),
            version_probe_budget: Duration::from_millis(100),
            ..AgentDetectionLimits::default()
        },
    )
    .await;

    assert!(snapshot
        .report
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "version_probe_timeout"));
    assert_eq!(
        DetectionOutcome::classify(&Ok(snapshot.report)),
        DetectionOutcome::Unknown
    );
}

/// B0 fixture：PATH 缺口——候选在搜索 roots 内但不在进程 PATH 上，快照必须
/// 保留该警告（导入会保存绝对路径这一事实不可丢失）。
#[tokio::test]
async fn snapshot_fixture_off_path_candidate_keeps_warning() {
    let root = FixtureRoot::new("snapshot-path-gap");
    std::fs::create_dir_all(&root).unwrap();
    plant_version_tool(&root, "peri", Some("1.0.0"));

    let snapshot = snapshot_for(
        vec!["builtin.detector.peri"],
        &root,
        &root.join("home"),
        AgentDetectionLimits::default(),
    )
    .await;

    // fixture roots 不在进程 PATH 上（fixture_root 是独立临时目录）；
    // 若宿主机 PATH 恰好含该临时目录，此断言退化为验证警告存在与否的任一形态，
    // 因此断言「有版本证据的候选存在」并在非 PATH 情况下携带警告。
    let candidate = snapshot
        .report
        .candidates
        .iter()
        .find(|candidate| candidate.provider == "peri")
        .expect("peri 候选必须存在");
    assert!(candidate
        .evidence
        .iter()
        .any(|evidence| evidence.kind == "version"));
    let on_path = candidate
        .evidence
        .iter()
        .any(|evidence| evidence.kind == "path");
    if !on_path {
        assert!(candidate
            .warnings
            .iter()
            .any(|warning| warning.contains("不在当前 PATH")));
    }
}

/// B0 fixture：wrapper/native 双证据 + 版本门槛——`ccb` 与 `claude` 同时在
/// 场，快照必须同时携带两侧证据、宣告 adapter relation，且 preflight 以
/// installed 收尾（版本 0.75.1 高于 0.65.0 门槛）。
#[tokio::test]
async fn snapshot_fixture_wrapper_dual_evidence_installs() {
    let root = FixtureRoot::new("snapshot-dual");
    let home = root.join("home");
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let search = root.join("bin");
    plant_version_tool(&search, "ccb", Some("0.75.1"));
    std::fs::write(
        search.join(&executable_names("claude")[0]),
        b"not-an-executable",
    )
    .unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.claude-code".into()]),
        home_dir: Some(home),
        search_roots: Some(vec![search.clone()]),
        ..AgentDetectionOptions::default()
    })
    .await
    .unwrap();
    // 快照指纹必须描述真实搜索的 roots，而不是进程默认 roots。
    let snapshot = assemble_detection_snapshot(report, 42, Some(std::slice::from_ref(&search)));

    let evidence = snapshot
        .report
        .providers
        .iter()
        .find(|evidence| evidence.provider == "claude-code")
        .expect("claude-code provider 证据");
    assert!(evidence.adapter_relation_declared);
    assert!(!evidence.acp_commands.is_empty(), "ACP 侧（ccb）必须有证据");
    assert!(
        !evidence.native_commands.is_empty(),
        "原生侧（claude）必须有证据"
    );
    assert_eq!(
        snapshot.search_fingerprint,
        search_roots_fingerprint(Some(std::slice::from_ref(&search)))
    );
    let verdict = snapshot
        .preflight
        .iter()
        .find(|verdict| verdict.provider == "claude-code")
        .expect("claude-code preflight 结论");
    assert_eq!(
        verdict.status,
        crate::agent_preflight::PreflightStatus::Installed
    );
    assert!(verdict
        .adapter
        .as_ref()
        .is_some_and(|adapter| adapter.native_present && adapter.acp_present));
}

/// B0 fixture：配置仅存在——共享配置目录在、可执行文件不在，preflight 必须
/// 报 configOnly 而不是 notInstalled。
#[tokio::test]
async fn snapshot_fixture_config_only_without_executables() {
    let root = FixtureRoot::new("snapshot-config-only");
    let home = root.join("home");
    let search = root.join("bin");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::create_dir_all(&search).unwrap();

    let snapshot = snapshot_for(
        vec!["builtin.detector.claude-code"],
        &search,
        &home,
        AgentDetectionLimits::default(),
    )
    .await;

    let verdict = snapshot
        .preflight
        .iter()
        .find(|verdict| verdict.provider == "claude-code")
        .expect("claude-code preflight 结论");
    assert_eq!(
        verdict.status,
        crate::agent_preflight::PreflightStatus::ConfigOnly
    );
}

/// B0 fixture：路径不可访问——搜索 root 指向一个普通文件（无法当目录枚举），
/// 扫描不得 panic、不得整报失败，只是该 root 无候选。
#[tokio::test]
async fn snapshot_fixture_inaccessible_root_is_not_an_error() {
    let root = FixtureRoot::new("snapshot-inaccessible");
    std::fs::create_dir_all(&root).unwrap();
    let not_a_dir = root.join("blocker.txt");
    std::fs::write(&not_a_dir, b"this is a regular file").unwrap();

    let report = detect_agent_runtime_candidates(AgentDetectionOptions {
        detector_ids: Some(vec!["builtin.detector.peri".into()]),
        home_dir: Some(root.join("home")),
        search_roots: Some(vec![not_a_dir.clone()]),
        ..AgentDetectionOptions::default()
    })
    .await;

    let report = report.expect("不可访问的 root 不是错误，只是没有候选");
    assert!(report.candidates.is_empty());
    let snapshot = assemble_detection_snapshot(report, 7, Some(&[not_a_dir]));
    assert_eq!(snapshot.report.candidates.len(), 0);
}

/// L8 FNV 收编保值断言：stable_candidate_id 是长度前缀 FNV-1a，输出
/// `{detector_id}:{hash:016x}` 进入 candidateId wire 契约（#325 前端挂诊断用）。
/// 字面量与收编前手写循环逐位一致（独立参考实现复核；输入含三字段长度前缀流）。
#[test]
fn stable_candidate_id_keeps_the_verbatim_hash_output() {
    assert_eq!(
        stable_candidate_id("d", "/x", &["a".to_string()]),
        "d:bc164e4a3f3cb147"
    );
    // 长度前缀防拼接别名混叠：字段重排/拼接不得产生同一哈希。
    assert_ne!(
        stable_candidate_id("d", "/x", &["a".to_string()]),
        stable_candidate_id("d", "/", &["xa".to_string()])
    );
}
