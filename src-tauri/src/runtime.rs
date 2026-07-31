//! AgentRuntimeManager：多 agent 运行时（B7a）。
//!
//! 单 active runtime 的机械抽取：每个 agent 拥有独立的
//! acp / client_generation / dispatcher / sessions / 状态 / 自动重连，
//! 事件永不跨 agent 串扰。gateway 平台适配器层（B10）依赖本模块做会话路由。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, RwLock};

use crate::acp::AcpClient;
use crate::agent_runtime::AgentRuntimeState;
use crate::SessionInfo;

/// 单个 agent 的运行时状态（per-agent 隔离）。
pub struct AgentRuntime {
    pub acp: Arc<tokio::sync::Mutex<AcpClient>>,
    pub notification_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub agent_lifecycle: Arc<tokio::sync::Mutex<()>>,
    pub client_generation: Arc<AtomicU64>,
    pub prompt_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    pub sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
    pub agent_runtime: Arc<Mutex<AgentRuntimeState>>,
    pub auto_reconnect_active: Arc<AtomicBool>,
}

impl AgentRuntime {
    /// 以 disconnected 状态新建一个空 runtime（启动/降级路径用）。
    pub fn new_disconnected() -> Arc<Self> {
        Arc::new(Self {
            acp: Arc::new(tokio::sync::Mutex::new(AcpClient::disconnected())),
            notification_task: Arc::new(Mutex::new(None)),
            agent_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            client_generation: Arc::new(AtomicU64::new(0)),
            prompt_locks: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            agent_runtime: Arc::new(Mutex::new(AgentRuntimeState::default())),
            auto_reconnect_active: Arc::new(AtomicBool::new(false)),
        })
    }
}

/// 多 agent 运行时注册表：agent_id → AgentRuntime。
pub struct AgentRuntimeManager {
    runtimes: RwLock<HashMap<String, Arc<AgentRuntime>>>,
}

impl AgentRuntimeManager {
    pub fn new() -> Self {
        Self { runtimes: RwLock::new(HashMap::new()) }
    }

    pub fn insert(&self, agent_id: String, runtime: Arc<AgentRuntime>) {
        if let Ok(mut map) = self.runtimes.write() {
            map.insert(agent_id, runtime);
        }
    }

    pub fn get(&self, agent_id: &str) -> Option<Arc<AgentRuntime>> {
        self.runtimes.read().ok()?.get(agent_id).cloned()
    }

    pub fn len(&self) -> usize {
        self.runtimes.read().map(|m| m.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn ids(&self) -> Vec<String> {
        self.runtimes.read().map(|m| m.keys().cloned().collect()).unwrap_or_default()
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
        assert!(manager.is_empty());
        let a = AgentRuntime::new_disconnected();
        let b = AgentRuntime::new_disconnected();
        manager.insert("peri".into(), a.clone());
        manager.insert("hermes".into(), b.clone());
        assert_eq!(manager.len(), 2);
        assert!(Arc::ptr_eq(&manager.get("peri").unwrap(), &a));
        assert!(Arc::ptr_eq(&manager.get("hermes").unwrap(), &b));
        assert!(manager.get("unknown").is_none());
    }

    #[test]
    fn runtime_fields_are_independent_per_agent() {
        let a = AgentRuntime::new_disconnected();
        let b = AgentRuntime::new_disconnected();
        a.client_generation.store(7, std::sync::atomic::Ordering::Release);
        assert_eq!(a.client_generation.load(std::sync::atomic::Ordering::Acquire), 7);
        assert_eq!(b.client_generation.load(std::sync::atomic::Ordering::Acquire), 0);
    }
}
