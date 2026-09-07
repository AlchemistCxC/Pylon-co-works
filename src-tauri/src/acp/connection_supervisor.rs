//! ACP connection ownership and generation fencing.
//!
//! A single supervisor owns the active connection for one durable owner.  A
//! replacement is serialized: the previous instance is closed before the new
//! one becomes visible.  This keeps late notifications from an old process
//! from reaching the dispatcher and gives callers one place to observe why a
//! connection changed.

use std::sync::Arc;
use std::future::Future;
use std::pin::Pin;
use tokio::sync::Mutex;

use super::AcpError;

pub type ConnectionGeneration = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Empty,
    Starting,
    Ready,
    Closing,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionSnapshot {
    pub generation: ConnectionGeneration,
    pub status: ConnectionStatus,
}

pub trait ConnectionInstance: Send + Sync {
    fn close(&self) -> Pin<Box<dyn Future<Output = Result<(), AcpError>> + Send + '_>>;
}

struct State {
    snapshot: ConnectionSnapshot,
    active: Option<Arc<dyn ConnectionInstance>>,
}

pub struct ConnectionSupervisor {
    state: Mutex<State>,
}

impl Default for ConnectionSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionSupervisor {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                snapshot: ConnectionSnapshot {
                    generation: 0,
                    status: ConnectionStatus::Empty,
                },
                active: None,
            }),
        }
    }

    pub async fn snapshot(&self) -> ConnectionSnapshot {
        self.state.lock().await.snapshot.clone()
    }

    /// Install a new instance. The old instance is closed while the state is
    /// fenced in `Closing`; only then is the new generation published.
    pub async fn replace(
        &self,
        instance: Arc<dyn ConnectionInstance>,
    ) -> Result<ConnectionGeneration, AcpError> {
        let (old, generation) = {
            let mut state = self.state.lock().await;
            state.snapshot.status = ConnectionStatus::Closing;
            let old = state.active.take();
            let generation = state.snapshot.generation.saturating_add(1);
            (old, generation)
        };

        if let Some(old) = old {
            if let Err(error) = old.close().await {
                let mut state = self.state.lock().await;
                state.snapshot.status = ConnectionStatus::Failed;
                return Err(error);
            }
        }

        let mut state = self.state.lock().await;
        state.snapshot = ConnectionSnapshot {
            generation,
            status: ConnectionStatus::Ready,
        };
        state.active = Some(instance);
        Ok(generation)
    }

    pub async fn close(&self) -> Result<(), AcpError> {
        let old = {
            let mut state = self.state.lock().await;
            state.snapshot.status = ConnectionStatus::Closing;
            state.active.take()
        };
        if let Some(old) = old {
            old.close().await?;
        }
        let mut state = self.state.lock().await;
        state.snapshot.status = ConnectionStatus::Empty;
        Ok(())
    }

    pub async fn accepts(&self, generation: ConnectionGeneration) -> bool {
        let state = self.state.lock().await;
        state.snapshot.generation == generation && state.snapshot.status == ConnectionStatus::Ready
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct Fake {
        closes: Arc<AtomicUsize>,
    }

    impl ConnectionInstance for Fake {
        fn close(&self) -> Pin<Box<dyn Future<Output = Result<(), AcpError>> + Send + '_>> {
            Box::pin(async move {
                self.closes.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn replacement_closes_old_before_new_generation_is_ready() {
        let supervisor = ConnectionSupervisor::new();
        let closes = Arc::new(AtomicUsize::new(0));
        let first = Arc::new(Fake { closes: closes.clone() });
        let second = Arc::new(Fake { closes: closes.clone() });

        let first_generation = supervisor.replace(first).await.unwrap();
        assert_eq!(first_generation, 1);
        assert!(supervisor.accepts(1).await);
        let second_generation = supervisor.replace(second).await.unwrap();
        assert_eq!(second_generation, 2);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(!supervisor.accepts(1).await);
        assert!(supervisor.accepts(2).await);
    }

    #[tokio::test]
    async fn close_removes_active_instance() {
        let supervisor = ConnectionSupervisor::new();
        let closes = Arc::new(AtomicUsize::new(0));
        supervisor
            .replace(Arc::new(Fake { closes: closes.clone() }))
            .await
            .unwrap();
        supervisor.close().await.unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert_eq!(supervisor.snapshot().await.status, ConnectionStatus::Empty);
    }
}
