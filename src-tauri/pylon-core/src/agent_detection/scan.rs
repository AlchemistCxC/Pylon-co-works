//! 扫描管线：总预算贯穿 / spawn_blocking 根扫描 / 并发探测 / 身份合并 / 版本下限 gate。
use super::evidence::find_rule;
use super::evidence::{
    config_evidence, dedup_roots, merge_candidates_by_identity, probe_tool_version,
    provider_evidence,
};
use super::locate::{controlled_roots, path_key, stable_candidate_id};
use super::probe::scan_diagnostic;
use super::probe_cache::{
    needs_npm_version_fallback, npm_global_package_version, requires_tool, version_probe,
    ConfiguredRuntimes,
};
use super::types::{
    AgentDetectionEvidence, AgentDetectionOptions, AgentDetectionReport, AgentRuntimeCandidate,
    IdentityConfidence, ProtocolAvailability,
};
use crate::agent_preflight::ToolVersion;
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

pub async fn detect_agent_runtime_candidates_inner(
    options: AgentDetectionOptions,
    configured: &ConfiguredRuntimes,
) -> Result<AgentDetectionReport, String> {
    let started = Instant::now();
    let limits = options.limits.clone();
    let deadline = started + limits.total_budget;
    let rules = crate::agent_catalog::detection_profiles()
        .map_err(|error| format!("Agent Catalog: {error}"))?;
    let available = rules
        .iter()
        .map(|rule| rule.detector_id.as_str())
        .collect::<HashSet<_>>();
    let mut diagnostics = Vec::new();
    if let Some(requested) = options.detector_ids.as_ref() {
        let mut seen = HashSet::new();
        for detector_id in requested.iter().filter(|id| seen.insert(id.as_str())) {
            if !available.contains(detector_id.as_str()) {
                diagnostics.push(scan_diagnostic(
                    "selection",
                    Some(detector_id.clone()),
                    "unknown_detector_id",
                    format!("未知 Agent detector: {detector_id}"),
                    false,
                ));
            }
        }
    }
    let enabled: Option<HashSet<String>> =
        options.detector_ids.map(|ids| ids.into_iter().collect());
    let selected_rules = rules
        .iter()
        .filter(|rule| {
            enabled
                .as_ref()
                .map(|ids| ids.contains(&rule.detector_id))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    let search_roots = options.search_roots.clone();
    // The runtime-tool probe runs after the scan, so it needs its own handle on
    // the roots (the scan closure takes ownership of the original).
    let tool_roots = search_roots.clone();
    let home_dir = options.home_dir.clone();
    let scan_budget = deadline.saturating_duration_since(Instant::now());
    let discovered = tokio::time::timeout(
        scan_budget,
        tokio::task::spawn_blocking(move || {
            let mut discovered = Vec::new();
            let mut providers = Vec::new();
            for rule in selected_rules {
                let located = find_rule(&rule, search_roots.as_deref());
                let config = config_evidence(&rule, home_dir.as_deref());
                providers.push(provider_evidence(
                    &rule,
                    search_roots.as_deref(),
                    home_dir.as_deref(),
                ));
                discovered.extend(
                    located
                        .into_iter()
                        .map(|located| (rule.clone(), located, config.clone())),
                );
            }
            (discovered, providers)
        }),
    )
    .await;
    let (mut discovered, providers) = match discovered {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => return Err(format!("Agent detection scan task failed: {error}")),
        Err(_) => {
            diagnostics.push(scan_diagnostic(
                "scan",
                None,
                "detection_budget_exhausted",
                "Agent discovery 扫描超过总预算".into(),
                true,
            ));
            return Ok(AgentDetectionReport {
                candidates: Vec::new(),
                providers: Vec::new(),
                diagnostics,
                elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                truncated: true,
            });
        }
    };
    discovered.sort_by(|left, right| {
        let left_config = left
            .2
            .iter()
            .any(|evidence| evidence.kind == "config-fields");
        let right_config = right
            .2
            .iter()
            .any(|evidence| evidence.kind == "config-fields");
        right
            .0
            .priority
            .cmp(&left.0.priority)
            .then(right_config.cmp(&left_config))
            .then(left.1.alias_index.cmp(&right.1.alias_index))
            .then((left.1.source != "path").cmp(&(right.1.source != "path")))
            .then(path_key(&left.1.executable).cmp(&path_key(&right.1.executable)))
            .then(left.1.args.cmp(&right.1.args))
    });
    let discovered_truncated = discovered.len() > limits.max_candidates;
    if discovered_truncated {
        diagnostics.push(scan_diagnostic(
            "selection",
            None,
            "candidate_limit_reached",
            format!(
                "Agent 候选超过上限 {}，已在 version probe 前按稳定优先级截断",
                limits.max_candidates
            ),
            false,
        ));
        discovered.truncate(limits.max_candidates);
    }

    // Version commands are independent but bounded. Each probe receives only
    // the remaining total budget, so queued work cannot extend discovery
    // indefinitely after the deadline.
    let probed = futures_util::stream::iter(discovered)
        .map(|(rule, located, config)| {
            let path = located.executable.clone();
            let detector_id = rule.detector_id.clone();
            let probe_budget = limits
                .version_probe_budget
                .min(deadline.saturating_duration_since(Instant::now()));
            async move {
                let probe =
                    version_probe(&detector_id, path, &rule.version_args, probe_budget).await;
                (rule, located, config, probe)
            }
        })
        .buffer_unordered(limits.max_concurrent_probes.max(1))
        .collect::<Vec<_>>()
        .await;

    let mut ranked_candidates = Vec::new();
    for (rule, located, config, probe) in probed {
        // 候选 id 先算：探测失败的诊断要带上它（#325）——前端据此把失败原因挂到对应
        // Agent 卡。缓存命中的失败诊断也走这里补归因，故两条路径口径一致。
        let path = located.executable;
        let key = path_key(&path);
        let candidate_args = located.args;
        let candidate_id = stable_candidate_id(&rule.detector_id, &key, &candidate_args);
        if let Some(mut diagnostic) = probe.diagnostic {
            diagnostic.candidate_id = Some(candidate_id.clone());
            diagnostics.push(diagnostic);
        }
        let version = probe.version;
        let startability = probe.startability;
        let alias_index = located.alias_index;
        let source = located.source;
        // issue #67B：导入侧同口径——“已导入”按 **provider 身份** 判定，不再要求 exe/args
        // 逐字相等。否则同一 agent 换一种启动形式（不同 invocation / 不同安装路径）会被显示
        // 成"未导入"，前端随后把 id 追加 -2 后缀，重复导入由此发生（探测侧的去重必须与
        // 导入侧的判定同一口径，issue #67B 明确要求两侧都做）。
        // 多命中时取 id 字典序最小者，保证候选字段与提示文本稳定。
        let imported_exact = configured
            .iter()
            .find(|(_, (provider, executable, args))| {
                provider == &rule.provider && executable == &key && args == &candidate_args
            })
            .map(|(id, _)| id.clone());
        let imported_provider = imported_exact.clone().or_else(|| {
            let mut same_provider: Vec<&String> = configured
                .iter()
                .filter(|(_, (provider, _, _))| provider == &rule.provider)
                .map(|(id, _)| id)
                .collect();
            same_provider.sort();
            same_provider.first().map(|id| (*id).clone())
        });
        let imported_form_hint = match (&imported_exact, &imported_provider) {
            (None, Some(id)) => Some(format!(
                "已存在同 provider 的 agent 配置 {}；当前候选使用不同可执行形式（{} {}）",
                id,
                path.to_string_lossy(),
                candidate_args.join(" ")
            )),
            _ => None,
        };
        let mut evidence = located.evidence;
        evidence.extend(config);
        let structured_config_match = evidence.iter().any(|item| item.kind == "config-fields");
        if let Some(version) = &version {
            evidence.push(AgentDetectionEvidence {
                kind: "version".into(),
                detail: version.clone(),
            })
        }
        let identity_confidence = if version.is_some() || structured_config_match {
            IdentityConfidence::High
        } else {
            IdentityConfidence::Medium
        };
        let candidate = AgentRuntimeCandidate {
            candidate_id,
            detector_id: rule.detector_id.clone(),
            provider: rule.provider.clone(),
            suggested_agent_id: rule.provider.clone(),
            name: rule.display_name.clone(),
            executable: path.to_string_lossy().to_string(),
            args: candidate_args,
            evidence,
            identity_confidence,
            startability,
            protocol_availability: ProtocolAvailability::NotTested,
            already_imported_agent_id: imported_provider,
            warnings: {
                let mut warnings = located.warnings;
                if source != "path" {
                    warnings.push("可执行文件不在当前 PATH；导入将保存本机绝对路径".into())
                }
                if version.is_none() && structured_config_match {
                    warnings.push(
                        "未能读取版本；已由结构化配置佐证，仍建议执行 ACP initialize 验证".into(),
                    )
                } else if version.is_none() {
                    warnings.push("未能读取版本；导入前建议执行 ACP initialize 验证".into())
                }
                if let Some(hint) = imported_form_hint {
                    warnings.push(hint)
                }
                warnings
            },
        };
        ranked_candidates.push((
            candidate,
            rule.priority,
            identity_confidence,
            alias_index,
            source != "path",
            key,
            source,
        ));
    }
    // issue #67B：身份级合并必须在排序与截断**之前**——否则同一 agent 的多条证据会各自
    // 占用 max_candidates 预算，并各自展开一条导入流（重复导入的直接诱因）。
    let mut ranked_candidates = merge_candidates_by_identity(ranked_candidates);
    fn confidence_rank(confidence: IdentityConfidence) -> u8 {
        match confidence {
            IdentityConfidence::Exact => 0,
            IdentityConfidence::High => 1,
            IdentityConfidence::Medium => 2,
            IdentityConfidence::Low => 3,
        }
    }
    ranked_candidates.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then(confidence_rank(left.2).cmp(&confidence_rank(right.2)))
            .then(left.3.cmp(&right.3))
            .then(left.4.cmp(&right.4))
            .then(left.5.cmp(&right.5))
            .then(left.0.args.cmp(&right.0.args))
    });
    let candidates_truncated = ranked_candidates.len() > limits.max_candidates;
    if candidates_truncated && !discovered_truncated {
        diagnostics.push(scan_diagnostic(
            "selection",
            None,
            "candidate_limit_reached",
            format!(
                "Agent 候选超过上限 {}，已按稳定优先级截断",
                limits.max_candidates
            ),
            false,
        ));
        ranked_candidates.truncate(limits.max_candidates);
    }
    let candidates: Vec<AgentRuntimeCandidate> = ranked_candidates
        .into_iter()
        .map(|(candidate, ..)| candidate)
        .collect();
    // A version-gated provider whose declared minimum cannot be proven from the
    // discovered evidence is reported here rather than silently accepted.
    let mut providers = providers;
    // Node.js / uv are machine facts, not per-provider ones: probe each at most
    // once per scan, and only when a detected provider actually declares a
    // requirement for it. A scan limited to providers needing neither spawns
    // nothing extra.
    let mut needs_node = false;
    let mut needs_uv = false;
    for provider in &providers {
        let Some(rule) = rules.iter().find(|rule| rule.provider == provider.provider) else {
            continue;
        };
        needs_node |= requires_tool(&rule.requires.node);
        needs_uv |= requires_tool(&rule.requires.uv);
    }
    let tool_budget = limits
        .version_probe_budget
        .min(deadline.saturating_duration_since(Instant::now()));
    let tool_roots = match tool_roots.as_deref() {
        Some(roots) => dedup_roots(controlled_roots(Some(roots))),
        None => controlled_roots(None),
    };
    let node = if needs_node {
        probe_tool_version("node", &[], &tool_roots, tool_budget).await
    } else {
        ToolVersion::default()
    };
    let uv = if needs_uv {
        probe_tool_version("uv", &[], &tool_roots, tool_budget).await
    } else {
        ToolVersion::default()
    };
    // Read once per scan, like the runtime tools above: the PATH a new process
    // would see is a property of the machine and of when this process started,
    // not of any one provider. The reading itself lives in
    // `agent_diagnostics` — the module that already owns environment evidence —
    // rather than a second implementation here.
    let path_gap = crate::agent_diagnostics::persisted_path_gap();
    for provider in &mut providers {
        provider.node = node.clone();
        provider.uv = uv.clone();
        // Machine fact: read once and attach to every provider, for the same
        // reason Node is. Only a diagnosis reads it, and it answers the question
        // a status name cannot — whether a located executable is somewhere this
        // process can actually reach.
        provider.path_gap = path_gap.clone();
    }
    for provider in &mut providers {
        let Some(rule) = rules.iter().find(|r| r.provider == provider.provider) else {
            continue;
        };
        let Some(minimum) = rule
            .version_gates
            .iter()
            .find(|gate| gate.min_version.is_some())
            .and_then(|gate| gate.min_version.as_deref())
        else {
            continue;
        };
        let candidate_version: Option<String> = candidates
            .iter()
            .filter(|candidate| candidate.provider == provider.provider)
            .find_map(|candidate| {
                candidate
                    .evidence
                    .iter()
                    .find(|item| item.kind == "version")
                    .map(|item| item.detail.clone())
            });
        // The direct executable probe is authoritative; npm global metadata is the
        // one source it cannot supply, and is consulted only when a gate actually
        // consumes the value.
        if needs_npm_version_fallback(rule, candidate_version.as_deref()) {
            provider.adapter_version = npm_global_package_version(rule).await;
        }
        let observed = candidate_version.or_else(|| provider.adapter_version.clone());
        if let Some(version) = observed {
            if !crate::agent_preflight::version_at_least(Some(&version), Some(minimum)) {
                diagnostics.push(scan_diagnostic(
                    "version",
                    Some(provider.detector_id.clone()),
                    "adapter_version_below_declared_minimum",
                    format!(
                        "{} 的版本 {version} 低于 catalog 声明的下限 {minimum}",
                        provider.provider
                    ),
                    true,
                ));
            }
        }
    }
    Ok(AgentDetectionReport {
        candidates,
        providers,
        diagnostics,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        truncated: discovered_truncated || candidates_truncated,
    })
}

/// Shared library entry used by the standalone detector. GUI-specific
/// imported-agent matching stays in the Tauri adapter below.
pub async fn detect_agent_runtime_candidates(
    options: AgentDetectionOptions,
) -> Result<AgentDetectionReport, String> {
    detect_agent_runtime_candidates_inner(options, &HashMap::new()).await
}
