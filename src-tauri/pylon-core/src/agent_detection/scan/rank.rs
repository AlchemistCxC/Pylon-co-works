//! 段5：候选组装（#67B 导入侧同口径判定 + 证据合并 + 警示文案）、身份级合并、
//! 稳定排序与截断（#486 项6 自 scan 长函数拆出，行为不变）。
use super::super::evidence::{merge_candidates_by_identity, RankedCandidate};
use super::super::locate::{path_key, stable_candidate_id};
use super::super::probe::scan_diagnostic;
use super::super::probe_cache::ConfiguredRuntimes;
use super::super::types::{
    AgentDetectionDiagnostic, AgentDetectionEvidence, AgentDetectionLimits, AgentRuntimeCandidate,
    IdentityConfidence, ProtocolAvailability,
};
use super::version_probe::Probed;

/// 逐条把探测结果组装成候选（含已导入判定与警示），产出排序元组。
/// 语句次序与原长函数 :165-264 一致。
pub(crate) fn assemble_candidates(
    probed: Vec<Probed>,
    configured: &ConfiguredRuntimes,
    diagnostics: &mut Vec<AgentDetectionDiagnostic>,
) -> Vec<RankedCandidate> {
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
            alternatives: Vec::new(),
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
    ranked_candidates
}

/// 身份级合并 → 稳定排序 → 截断。返回（候选列表，是否截断）。
/// 语句次序与原长函数 :265-301 一致。
pub(crate) fn merge_rank_and_truncate(
    ranked_candidates: Vec<RankedCandidate>,
    limits: &AgentDetectionLimits,
    discovered_truncated: bool,
    diagnostics: &mut Vec<AgentDetectionDiagnostic>,
) -> (Vec<AgentRuntimeCandidate>, bool) {
    // issue #67B：身份级合并必须在排序与截断**之前**——否则同一 agent 的多条证据会各自
    // 占用 max_candidates 预算，并各自展开一条导入流（重复导入的直接诱因）。
    let mut ranked_candidates = merge_candidates_by_identity(ranked_candidates);
    fn confidence_rank(confidence: IdentityConfidence) -> u8 {
        match confidence {
            IdentityConfidence::High => 0,
            IdentityConfidence::Medium => 1,
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
    (candidates, candidates_truncated)
}
