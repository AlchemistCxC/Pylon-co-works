//! SessionStore 薄 façade（方案 8）：把 session 映射的 destructive mutation
//! 收拢为带 generation 纪律的 API 边界。内部仍为 `runtime.sessions` 的
//! `Mutex<HashMap<String, SessionInfo>>`（不引入 actor/DB/新容器）。
//!
//! 首批方法对应现有 helper（replace_session_slot / with_session_if_matches /
//! remove_session_if_matches），现有函数委托本模块——行为封闭，逐步切换。
//! 锁序纪律：sessions → prompt_locks 单向；mapping_ready 通知在 insert 成功后。

use crate::agent_runtime::session_mapping_matches;
use crate::runtime::AgentRuntime;
use crate::session::SessionInfo;

/// 会话映射操作错误（方案 8；与 PylonError::Protocol 文案兼容）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionStoreError {
    /// 映射不存在或 (peri_id, generation) 与当前映射不符（客户端已替换/会话已迁移）。
    Stale(String),
    /// 会话数达到上限。
    MaxSessions,
    /// 锁中毒。
    LockPoisoned(String),
}

/// 插入会话映射（方案 8，对应 replace_session_slot）：满额策略 +
/// 同 source 替换 + mapping_ready 通知。返回被替换的旧映射（如有）。
pub(crate) fn insert(
    runtime: &AgentRuntime,
    source: &str,
    session: SessionInfo,
    allow_same_source_replace: bool,
    max_sessions: usize,
) -> Result<Option<SessionInfo>, SessionStoreError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
    if sessions.len() >= max_sessions
        && !(allow_same_source_replace && sessions.contains_key(source))
    {
        return Err(SessionStoreError::MaxSessions);
    }
    let replaced = sessions.insert(source.to_string(), session);
    drop(sessions);
    runtime.mapping_ready.notify_waiters();
    Ok(replaced)
}

/// 条件更新（方案 8，对应 with_session_if_matches）：generation 复核 +
/// (peri_id, generation) 匹配才更新。
pub(crate) fn update_if_current<T>(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    update: impl FnOnce(&mut SessionInfo) -> T,
) -> Result<T, SessionStoreError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
    let session = sessions.get_mut(source).ok_or_else(|| {
        SessionStoreError::Stale(format!("stale session mapping for source: {source}"))
    })?;
    if !session_mapping_matches(&session.peri_id, session.generation, peri_id, generation) {
        return Err(SessionStoreError::Stale(format!(
            "stale session mapping for source: {source}"
        )));
    }
    Ok(update(session))
}

/// 条件删除（方案 8，对应 remove_session_if_matches）：(peri_id, generation)
/// 匹配才删除，且锁外收敛 prompt 锁（锁序单向）。返回是否删除。
pub(crate) fn remove_if_current(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
) -> Result<bool, SessionStoreError> {
    let removed = {
        let mut sessions = runtime
            .sessions
            .lock()
            .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
        if sessions.get(source).map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true)
        {
            sessions.remove(source).is_some()
        } else {
            false
        }
    };
    if removed {
        runtime.remove_prompt_lock(source);
    }
    Ok(removed)
}

/// 条件删除（方案 8 步骤 4，expiry 场景）：(peri_id, generation) 匹配 + 锁内
/// updated_at 复核——快照值与删除时点之间新消息到达会刷新 updated_at，不得
/// 误杀刚活跃的会话。复核函数由调用方传入（expiry 域的 session_expired 纯函数），
/// store 保持无域依赖；锁外收敛 prompt 锁（锁序单向）。
pub(crate) fn remove_if_current_expired<F>(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    still_expired: F,
) -> Result<bool, SessionStoreError>
where
    F: FnOnce(&SessionInfo) -> bool,
{
    let removed = {
        let mut sessions = runtime
            .sessions
            .lock()
            .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
        let current = sessions.get(source);
        let matches = current.map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true);
        if matches && current.is_some_and(still_expired) {
            sessions.remove(source).is_some()
        } else {
            false
        }
    };
    if removed {
        runtime.remove_prompt_lock(source);
    }
    Ok(removed)
}

/// migrate epoch（方案 8，对应 apply_client_replacement_sessions 的 keep=true 语义）：
/// 全部映射的 generation 迁移到 new_generation；keep=false 时清空。返回被清空的旧 source 键。
pub(crate) fn migrate_or_clear(
    runtime: &AgentRuntime,
    keep_sessions: bool,
    new_generation: u64,
) -> Result<Vec<String>, SessionStoreError> {
    let mut stale_sources: Vec<String> = Vec::new();
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
    if !keep_sessions {
        stale_sources = sessions.keys().cloned().collect();
        sessions.clear();
    } else {
        for session in sessions.values_mut() {
            session.generation = new_generation;
        }
    }
    Ok(stale_sources)
}

pub(crate) fn snapshot(
    runtime: &AgentRuntime,
) -> Result<Vec<(String, SessionInfo)>, SessionStoreError> {
    let sessions = runtime
        .sessions
        .lock()
        .map_err(|e| SessionStoreError::LockPoisoned(e.to_string()))?;
    Ok(sessions
        .iter()
        .map(|(source, info)| (source.clone(), info.clone()))
        .collect())
}

/// 供 lib.rs（replace_agent_client）用：生成状态消息文案。
impl std::fmt::Display for SessionStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stale(msg) => write!(f, "{msg}"),
            Self::MaxSessions => write!(f, "max sessions reached"),
            Self::LockPoisoned(msg) => write!(f, "{msg}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn runtime() -> Arc<AgentRuntime> {
        AgentRuntime::new_disconnected()
    }

    fn session(id: &str, generation: u64) -> SessionInfo {
        SessionInfo::new(
            id.to_string(),
            "persona".to_string(),
            ".".to_string(),
            true,
            generation,
        )
    }

    #[test]
    fn insert_replaces_same_source_and_notifies_mapping_ready() {
        let rt = runtime();
        let replaced =
            insert(rt.as_ref(), "src", session("peri-1", 0), true, 100).expect("first insert");
        assert!(replaced.is_none(), "首次插入无旧映射");
        let replaced = insert(rt.as_ref(), "src", session("peri-2", 0), true, 100)
            .expect("same source replace");
        assert_eq!(
            replaced.unwrap().peri_id,
            "peri-1",
            "同 source 替换返回旧映射"
        );
        assert_eq!(
            snapshot(rt.as_ref()).unwrap().len(),
            1,
            "同 source 替换不增加条目"
        );
    }

    #[test]
    fn insert_enforces_max_sessions_without_same_source_override() {
        let rt = runtime();
        insert(rt.as_ref(), "a", session("p-a", 0), false, 1).expect("first");
        let err = insert(rt.as_ref(), "b", session("p-b", 0), false, 1)
            .err()
            .expect("满额必须拒绝");
        assert_eq!(err, SessionStoreError::MaxSessions);
        // 同 source 覆盖在满额时允许
        insert(rt.as_ref(), "a", session("p-a2", 0), true, 1).expect("同 source 覆盖允许");
    }

    #[test]
    fn update_if_current_rejects_stale_key() {
        let rt = runtime();
        insert(rt.as_ref(), "src", session("peri-1", 1), true, 100).unwrap();
        // 旧 peri_id + 旧 generation：stale
        let err = update_if_current(rt.as_ref(), "src", "peri-old", 0, |_| ())
            .err()
            .expect("stale 必须拒绝");
        assert!(matches!(err, SessionStoreError::Stale(_)));
        // 匹配则更新
        update_if_current(rt.as_ref(), "src", "peri-1", 1, |s| s.model = "m".into()).unwrap();
        let snap = snapshot(rt.as_ref()).unwrap();
        assert_eq!(snap[0].1.model, "m");
    }

    #[test]
    fn remove_if_current_does_not_remove_newer_key() {
        let rt = runtime();
        insert(rt.as_ref(), "src", session("peri-1", 1), true, 100).unwrap();
        // 旧 generation 的 remove 不得删除新映射
        let removed = remove_if_current(rt.as_ref(), "src", "peri-1", 0).unwrap();
        assert!(!removed, "旧 generation 不得删除");
        assert_eq!(snapshot(rt.as_ref()).unwrap().len(), 1, "映射必须保留");
        // 匹配则删除
        let removed = remove_if_current(rt.as_ref(), "src", "peri-1", 1).unwrap();
        assert!(removed);
        assert!(snapshot(rt.as_ref()).unwrap().is_empty());
    }

    #[test]
    fn migrate_or_clear_keeps_fields_and_clears_on_false() {
        let rt = runtime();
        insert(rt.as_ref(), "a", session("p-a", 1), true, 100).unwrap();
        insert(rt.as_ref(), "b", session("p-b", 1), true, 100).unwrap();
        // keep=true：迁移 generation，字段保留
        let stale = migrate_or_clear(rt.as_ref(), true, 9).unwrap();
        assert!(stale.is_empty(), "keep=true 不清空");
        let snap = snapshot(rt.as_ref()).unwrap();
        assert_eq!(snap.len(), 2);
        assert!(
            snap.iter().all(|(_, s)| s.generation == 9),
            "generation 必须迁移"
        );
        // keep=false：清空并返回旧 source 键
        let stale = migrate_or_clear(rt.as_ref(), false, 10).unwrap();
        let mut keys: Vec<&str> = stale.iter().map(|s| s.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["a", "b"]);
        assert!(snapshot(rt.as_ref()).unwrap().is_empty());
    }
}
