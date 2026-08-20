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
            // I17 W3（LR2-WI07）：锁中毒 fail-closed——prompt_locks 无法读取时保守视为
            // 「生成中」跳过过期判定（不得清理可能仍在生成的会话），并输出显式诊断。
            let generating = match runtime.prompt_locks.lock() {
                Ok(locks) => locks
                    .get(&source)
                    .map(|lock| lock.try_lock().is_err())
                    .unwrap_or(false),
                Err(_) => {
                    tracing::error!(
                        "session expiry: prompt_locks 锁中毒，保守跳过过期判定 ({source})"
                    );
                    true
                }
            };
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
            // 方案 8 步骤 4：删除委托 SessionStore（generation 匹配 + 锁内 updated_at
            // 复核防误杀刚活跃会话 + 锁外 prompt 锁收敛）。
            let generation = runtime.client_generation.load(Ordering::Acquire);
            let removed = crate::session_store::remove_if_current_expired(
                &runtime,
                &source,
                &peri_id,
                generation,
                |current| {
                    // 锁内用最新 updated_at 复核——快照值与删除时点之间新消息到达
                    // 会刷新 updated_at，不得误杀刚活跃的会话。
                    session_expired(current.updated_at, now, reset, idle_minutes).is_some()
                },
            )
            .map_err(|e| {
                tracing::warn!("会话过期删除失败 ({source}): {e}");
                e
            })
            .unwrap_or(false);
            if !removed {
                // 映射已变更（新会话已接管 source）——不 close、不通知
                continue;
            }
            // close ACP session（失败不阻断本地清理；旧 peri_id 独立于映射）。
            // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
            let _ = close_session_rpc(state, &runtime, &peri_id, generation, false).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::route::parse_config;
    use crate::gateway::GatewayCore;
    use crate::runtime::AgentRuntime;
    use crate::session::SessionInfo;
    use crate::test_utils::TestStateBuilder;
    use crate::time::Timestamp;

    #[tokio::test]
    async fn expiry_prompt_lock_poison_skips_session_conservatively() {
        // I17 W3（LR2-WI07）：prompt_locks 锁中毒 → fail-closed——保守视为「生成中」跳过
        // 过期判定，不得清理可能仍在生成的会话（旧实现 unwrap_or(false) → generating=false
        // → 会误清理过期判定的会话，RED 证据）。
        let gateway = GatewayCore::from_config(
            parse_config(
                "gateway:
  routes:
    - source: qq:user:x
      agent: peri
      profile: p
      session: s
",
            )
            .expect("config"),
        );
        let runtime = AgentRuntime::new_disconnected();
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            let mut info = SessionInfo::new("peri-1".into(), String::new(), ".".into(), true, 0);
            // 构造过期会话：updated_at 远古（idle 阈值 1440 分钟必超）
            info.updated_at = Some(Timestamp::new(0));
            sessions.insert("qq:user:x".into(), info);
        }
        // 毒化 prompt_locks（guard 持有期间 panic）
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = runtime.prompt_locks.lock().unwrap();
            panic!("intentional poison");
        }));
        let state = TestStateBuilder::bare()
            .with_runtime("peri", runtime)
            .with_gateway(std::sync::Arc::new(gateway))
            .build();
        check_session_expiry(&state).await;
        let runtimes = state.runtimes.all_with_ids();
        let (_, runtime_ref) = runtimes
            .iter()
            .find(|(id, _)| id == "peri")
            .expect("runtime 存在");
        let sessions = runtime_ref.sessions.lock().unwrap();
        assert!(
            sessions.contains_key("qq:user:x"),
            "prompt_locks 锁中毒必须保守跳过过期判定（不清理会话）"
        );
    }
}
