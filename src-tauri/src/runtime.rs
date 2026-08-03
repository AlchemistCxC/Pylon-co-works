//! AgentRuntimeManager：多 agent 运行时（B7a）。
//!
//! 单 active runtime 的机械抽取：每个 agent 拥有独立的
//! acp / client_generation / dispatcher / sessions / 状态 / 自动重连，
//! 事件永不跨 agent 串扰。gateway 平台适配器层（B10）依赖本模块做会话路由。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;

use crate::acp::AcpClient;
use crate::agent_runtime::AgentRuntimeState;
use crate::permission::PendingPermission;
use crate::session::SessionInfo;

/// 单个 agent 的运行时状态（per-agent 隔离）。
pub struct AgentRuntime {
    pub acp: Arc<tokio::sync::Mutex<AcpClient>>,
    pub notification_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub session_creation: Arc<tokio::sync::Mutex<()>>,
    pub agent_lifecycle: Arc<tokio::sync::Mutex<()>>,
    pub client_generation: Arc<AtomicU64>,
    pub prompt_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    pub sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
    pub agent_runtime: Arc<Mutex<AgentRuntimeState>>,
    pub auto_reconnect_active: Arc<AtomicBool>,
    /// 挂起的权限请求（B9）：JSON-RPC id → 待用户决策（超时默认拒绝）。
    pub pending_permissions: Arc<Mutex<HashMap<u64, PendingPermission>>>,
    /// 会话映射就绪通知（R6，吸收 O5）：new_session / send_prompt_core 自动建会话 /
    /// load_persisted_session 的 sessions 映射插入成功后 notify_waiters，dispatcher
    /// 对未知 periId 的等待由 20×5ms 轮询改为事件驱动（100ms 窗口语义不变）。
    pub mapping_ready: tokio::sync::Notify,
}

impl AgentRuntime {
    /// 以 disconnected 状态新建一个空 runtime（启动/降级路径用）。
    pub fn new_disconnected() -> Arc<Self> {
        Arc::new(Self {
            acp: Arc::new(tokio::sync::Mutex::new(AcpClient::disconnected())),
            notification_task: Arc::new(Mutex::new(None)),
            session_creation: Arc::new(tokio::sync::Mutex::new(())),
            agent_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            client_generation: Arc::new(AtomicU64::new(0)),
            prompt_locks: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            agent_runtime: Arc::new(Mutex::new(AgentRuntimeState::default())),
            auto_reconnect_active: Arc::new(AtomicBool::new(false)),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            mapping_ready: tokio::sync::Notify::new(),
        })
    }

    /// O1：prompt 锁表随会话生命周期收敛（单 key 移除）——映射删除 = 该 source
    /// 生命周期结束；生成中的 prompt 持有 Arc 守卫，条目移除不影响在途等待，
    /// 新会话 prompt_lock_for 按需重建。G2-08：session.rs 私有 drop_prompt_lock
    /// 收敛为本方法（锁序纪律从注释约束升级为容器方法约束）。
    /// 锁序：调用方不得持有 sessions 锁（sessions → prompt_locks 单向）。
    pub fn remove_prompt_lock(&self, source: &str) {
        if let Ok(mut locks) = self.prompt_locks.lock() {
            locks.remove(source);
        }
    }

    /// 优化-1：批量移除（keep=false 客户端替换后 prompt 锁表同步收敛；G2-08：
    /// lib.rs 原 drop_stale_prompt_locks 收敛为本方法，行为零变化）。同锁序纪律。
    pub fn drop_prompt_locks(&self, stale_sources: &[String]) {
        if stale_sources.is_empty() {
            return;
        }
        if let Ok(mut locks) = self.prompt_locks.lock() {
            for source in stale_sources {
                locks.remove(source);
            }
        }
    }
}

/// 多 agent 运行时注册表：agent_id → AgentRuntime。
///
/// DashMap 分片锁：entry 原子单实例创建、get/iter 免整表锁、
/// 无 std RwLock poison 面（W1-R1）。
pub struct AgentRuntimeManager {
    runtimes: DashMap<String, Arc<AgentRuntime>>,
}

impl AgentRuntimeManager {
    pub fn new() -> Self {
        Self {
            runtimes: DashMap::new(),
        }
    }

    pub fn insert(&self, agent_id: String, runtime: Arc<AgentRuntime>) {
        self.runtimes.insert(agent_id, runtime);
    }

    /// 获取或创建 agent 的 runtime（switch/reconnect 懒启动路径）。
    /// 并发重复调用只会创建一个实例（DashMap entry API 保证原子单实例）。
    pub fn get_or_create(&self, agent_id: &str) -> Arc<AgentRuntime> {
        self.runtimes
            .entry(agent_id.to_string())
            .or_insert_with(AgentRuntime::new_disconnected)
            .value()
            .clone()
    }

    pub fn get(&self, agent_id: &str) -> Option<Arc<AgentRuntime>> {
        self.runtimes.get(agent_id).map(|r| r.value().clone())
    }

    /// 移除 agent 的 runtime（C6：reload 删除 agent 时清理幽灵 runtime）。
    /// 返回被移除的 runtime（未注册时返回 None）。
    pub fn remove(&self, agent_id: &str) -> Option<Arc<AgentRuntime>> {
        self.runtimes.remove(agent_id).map(|(_, runtime)| runtime)
    }

    /// 全部 runtime（会话生命周期 watcher / gateway_status 遍历用）。
    pub fn all(&self) -> Vec<Arc<AgentRuntime>> {
        self.runtimes.iter().map(|r| r.value().clone()).collect()
    }

    /// 全部 runtime 带 agent_id（B2 Inspector 完整版 per-agent 聚合用）。
    pub fn all_with_ids(&self) -> Vec<(String, Arc<AgentRuntime>)> {
        self.runtimes
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect()
    }
}

impl Default for AgentRuntimeManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_insert_get_and_isolate_runtimes() {
        let manager = AgentRuntimeManager::new();
        assert!(manager.get("peri").is_none());
        let a = AgentRuntime::new_disconnected();
        let b = AgentRuntime::new_disconnected();
        manager.insert("peri".into(), a.clone());
        manager.insert("hermes".into(), b.clone());
        assert!(Arc::ptr_eq(&manager.get("peri").unwrap(), &a));
        assert!(Arc::ptr_eq(&manager.get("hermes").unwrap(), &b));
        assert!(manager.get("unknown").is_none());
    }

    #[test]
    fn runtime_fields_are_independent_per_agent() {
        let a = AgentRuntime::new_disconnected();
        let b = AgentRuntime::new_disconnected();
        a.client_generation
            .store(7, std::sync::atomic::Ordering::Release);
        assert_eq!(
            a.client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            7
        );
        assert_eq!(
            b.client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            0
        );
    }

    #[test]
    fn session_creation_lock_is_independent_per_agent() {
        let a = AgentRuntime::new_disconnected();
        let b = AgentRuntime::new_disconnected();
        let guard = a.session_creation.try_lock();
        assert!(guard.is_ok(), "a 的 session_creation 应可独立获取");
        let b_guard = b.session_creation.try_lock();
        assert!(b_guard.is_ok(), "b 的 session_creation 不应被 a 的锁阻塞");
        drop(guard);
        drop(b_guard);
    }

    #[test]
    fn remove_drops_registered_runtime() {
        let manager = AgentRuntimeManager::new();
        let runtime = AgentRuntime::new_disconnected();
        manager.insert("peri".into(), runtime.clone());
        assert!(Arc::ptr_eq(&manager.remove("peri").unwrap(), &runtime));
        assert!(manager.get("peri").is_none(), "remove 后 get 必须为 None");
        assert!(
            manager.remove("peri").is_none(),
            "重复 remove 必须返回 None"
        );
    }

    #[test]
    fn get_or_create_returns_single_shared_instance() {
        let manager = AgentRuntimeManager::new();
        let first = manager.get_or_create("peri");
        let second = manager.get_or_create("peri");
        assert!(
            Arc::ptr_eq(&first, &second),
            "同一 agent 必须返回同一 runtime 实例"
        );
        assert!(
            Arc::ptr_eq(&manager.get("peri").unwrap(), &first),
            "注册表必须登记同一实例"
        );
    }
}
