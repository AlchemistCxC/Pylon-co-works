//! 会话过期域：过期判定与后台 expiry watcher。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;

pub(crate) fn session_expired(
    updated_at: Option<Timestamp>,
    now: Timestamp,
    reset: &str,
    idle_minutes: u64,
) -> Option<String> {
    match reset {
        "off" => None,
        "daily" => match updated_at.map(Timestamp::day_number) {
            Some(updated_day) if updated_day != now.day_number() => Some("每日重置".to_string()),
            _ => None,
        },
        _ => {
            let idle_ms = idle_minutes.saturating_mul(60_000);
            let updated = updated_at?;
            if now.elapsed_since(updated) > idle_ms {
                Some(format!("超过 {idle_minutes} 分钟无活动"))
            } else {
                None
            }
        }
    }
}
pub(crate) async fn check_session_expiry(state: &AppState) {
    let now = Timestamp::now();
    // 核验修复：平台 source 判定（适配器前缀或静态绑定命中）。GUI local 会话
    // 由前端/用户管理，不参与后台过期重置（watcher 是 B10.3b 为平台会话设计）。
    // G4 §3-9（C1）：统一入口 is_platform_source（注册适配器前缀命中 OR 绑定命中，
    // E14 语义与 deliver_all 出站白名单前置条件等价——原 adapter_keys 前缀闭包删除）。
    for runtime in state.runtimes.all() {
        let sessions: Vec<(String, String, Option<Timestamp>)> = runtime
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .map(|(source, info)| (source.clone(), info.peri_id.clone(), info.updated_at))
                    .collect()
            })
            .unwrap_or_default();
        for (source, peri_id, updated_at) in sessions {
            if !state.gateway.is_platform_source(&source) {
                continue;
            }
            // 活跃豁免：生成中（prompt 锁被占用）永不视为过期
            let generating = runtime
                .prompt_locks
                .lock()
                .ok()
                .and_then(|locks| locks.get(&source).cloned())
                .map(|lock| lock.try_lock().is_err())
                .unwrap_or(false);
            if generating {
                continue;
            }
            let binding = state.gateway.binding(&source);
            let reset = binding
                .as_ref()
                .and_then(|b| b.reset.as_deref())
                .unwrap_or("idle");
            let idle_minutes = binding
                .as_ref()
                .and_then(|b| b.idle_minutes)
                .unwrap_or(1440);
            let Some(reason) = session_expired(updated_at, now, reset, idle_minutes) else {
                continue;
            };
            tracing::info!("会话过期 ({source}): {reason}");
            // 审查修复：删除前按 (peri_id, generation) 复核映射——close RPC 期间若
            // 同 source 新建了会话，不得把新映射误删（旧映射已被 new_session 替换）。
            // generation 提到循环体（close_session_rpc 复用；块内删除复核同值）。
            let generation = runtime.client_generation.load(Ordering::Acquire);
            let removed = {
                let mut sessions = match runtime.sessions.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let current = sessions.get(&source);
                if current.map(|session| {
                    session_mapping_matches(
                        &session.peri_id,
                        session.generation,
                        &peri_id,
                        generation,
                    )
                }) != Some(true)
                {
                    false
                } else {
                    let current = current.expect("已确认存在");
                    // 锁内用最新 updated_at 复核——快照值与删除时点之间新消息到达会刷新
                    // updated_at，不得误杀刚活跃的会话。
                    if session_expired(current.updated_at, now, reset, idle_minutes).is_some() {
                        sessions.remove(&source).is_some()
                    } else {
                        false
                    }
                }
            };
            if removed {
                // O1：映射删除 = 该 source 生命周期结束 → 锁表同步收敛
                runtime.remove_prompt_lock(&source);
            }
            if !removed {
                // 映射已变更（新会话已接管 source）——不 close、不通知
                continue;
            }
            // close ACP session（失败不阻断本地清理；旧 peri_id 独立于映射）。
            // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
            let _ = close_session_rpc(&state, &runtime, &peri_id, generation, false).await;
            // 审查修复：应答该 session 挂起的权限请求为 Cancelled（协议要求）
            crate::permission::respond_pending_permissions_cancelled(&runtime, &peri_id).await;
            // 平台通知（用户可见重置原因）：投递给 source 归属的适配器。
            // G4 §3-9（C2）：统一入口 adapter_for_source（None 跳过——空 key 与
            // 未注册适配器同语义，替代 split(':') + adapter(key) 样板）。
            if let Some(adapter) = state.gateway.adapter_for_source(&source) {
                let _ = adapter.deliver_text(&source, &format!("[会话已重置] {reason}"));
            }
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source),
                &format!("Session expired ({reason})"),
                serde_json::Map::new(),
            );
        }
    }
}
