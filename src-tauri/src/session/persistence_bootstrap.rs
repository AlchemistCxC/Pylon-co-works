//! Kernel persistence readiness barrier.
//!
//! All SQLite-backed services share one database file but keep independent
//! connections. They must become visible to commands and dispatchers as one
//! startup unit: a partially initialized set creates split readiness where one
//! authority is available and another permanently reports unavailable.

use std::path::Path;
use std::sync::Arc;

use super::{EventService, MessageService, UserDataService};

pub(crate) struct PersistenceServices {
    pub(crate) message: Arc<MessageService>,
    pub(crate) user_data: Arc<UserDataService>,
    pub(crate) event: Arc<EventService>,
}

impl PersistenceServices {
    /// Open/migrate every persistence service before the application accepts
    /// commands. There is deliberately no localStorage or alternate-history
    /// fallback: startup either establishes the one durable authority or fails.
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create persistence directory failed: {error}"))?;
        }
        let message = MessageService::open_db(path)
            .map_err(|error| format!("message persistence bootstrap failed: {error}"))?;
        let user_data = UserDataService::open_db(path)
            .map_err(|error| format!("user-data persistence bootstrap failed: {error}"))?;
        let event = EventService::open_db(path)
            .map_err(|error| format!("canonical-event persistence bootstrap failed: {error}"))?;
        Ok(Self {
            message: Arc::new(message),
            user_data: Arc::new(user_data),
            event: Arc::new(event),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDb {
        dir: std::path::PathBuf,
        path: std::path::PathBuf,
    }

    impl TempDb {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "pylon-persistence-bootstrap-{}-{nonce}",
                std::process::id()
            ));
            Self {
                path: dir.join("pylon-data-v1.sqlite3"),
                dir,
            }
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn opens_all_services_as_one_ready_unit() {
        let db = TempDb::new();
        let services = PersistenceServices::open(&db.path).expect("bootstrap services");

        let connection = rusqlite::Connection::open(&db.path).expect("inspect database");
        for table in ["sessions", "user_data", "canonical_events"] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("query schema");
            assert_eq!(exists, 1, "{table} must be ready before setup returns");
        }

        drop(connection);
        drop(services);
    }

    #[test]
    fn reports_directory_creation_failure_without_fallback() {
        let db = TempDb::new();
        std::fs::create_dir_all(&db.dir).unwrap();
        let blocking_file = db.dir.join("not-a-directory");
        std::fs::write(&blocking_file, b"x").unwrap();

        let error = PersistenceServices::open(&blocking_file.join("data.sqlite3"))
            .err()
            .expect("must fail");

        assert!(error.contains("create persistence directory failed"));
    }
}
