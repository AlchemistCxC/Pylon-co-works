//! 用户数据仓库：versioned Profile/Session/activeProfileId 后端存储（ISSUE-14 W5）。
//!
//! 与消息仓库共用同一 SQLite 文件（`pylon-data-v1.sqlite3`，schema 由 msg_repo 的
//! 统一迁移链管理）；本模块持独立 Connection（busy_timeout 序列化同文件写）。
//!
//! 契约：
//! - `user_data` KV 表，key ∈ {profiles, sessions}，每行 version + revision + payload。
//! - payload 为前端 envelope 原文（自描述，含 version 字段），保存时做结构校验：
//!   profiles v1（id 非空）、sessions v2（id 非空；agentId 字段若存在必非空——legacy
//!   无 agentId 条目原样接受，不破坏 ISSUE-01 CR-001 的 unresolved 保留）。
//! - 原子写：save 单事务（读 revision → 校验 expected → upsert），expected 不匹配 →
//!   `user_data_revision_conflict`，旧写不覆盖新写。
//! - 损坏报错：payload 非 JSON 对象/未知 version/形状非法/超限 → `user_data_corrupt`，
//!   不静默覆盖现场。
//! - 大小上限 2MB（防超大 payload 写入）。
//!
//! 同步访问（`Mutex<Connection>`，SQLite 单写者）；上层须经 spawn_blocking 调用。

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::ser::SerializeMap;
use serde::Serialize;

/// 单条 user_data payload 序列化后的最大字节数（防超大 envelope 写入/DoS）。
pub(crate) const MAX_USER_DATA_BYTES: usize = 2 * 1024 * 1024;

/// user_data 行的 key。profiles = Profile + activeProfileId envelope；
/// sessions = Session（v2 + legacy unresolved 混合）envelope。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UserDataKey {
    Profiles,
    Sessions,
}

impl UserDataKey {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Profiles => "profiles",
            Self::Sessions => "sessions",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "profiles" => Some(Self::Profiles),
            "sessions" => Some(Self::Sessions),
            _ => None,
        }
    }
}

/// 已存储的 user_data 行：version + revision + 原始 envelope payload（自描述含 version）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserDataEnvelope {
    pub(crate) version: i64,
    pub(crate) revision: i64,
    pub(crate) payload: serde_json::Value,
}

/// save 结果：写入后的新 revision（前端用作后续 expected_revision 基准）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserDataSaveResult {
    pub(crate) revision: i64,
}

/// I14-W7：Profile 原子删除结果——fallback profile id + 两个 envelope 的新 revision
/// （前端用作后续 expected_revision 基准；sessions envelope 不存在时 sessions_revision=None）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileDeleteResult {
    pub(crate) fallback: String,
    pub(crate) profiles_revision: i64,
    pub(crate) sessions_revision: Option<i64>,
}

/// 用户数据仓库结构化错误（B1.2：前端按 code 分支，message 展示用）。
#[derive(Debug, thiserror::Error)]
pub(crate) enum UserDataError {
    /// expected_revision 与仓库当前 revision 不匹配（旧写不覆盖新写）。
    #[error("用户数据 revision 冲突：期望 {expected}，实际 {actual}")]
    RevisionConflict { expected: i64, actual: i64 },
    /// DB 不可用（open/迁移/锁/任务失败）。
    #[error("用户数据仓库不可用：{0}")]
    Unavailable(String),
    /// envelope 损坏/形状非法/超限——不静默覆盖现场（ISSUE-14 W5）。
    #[error("用户数据损坏：{0}")]
    Corrupt(String),
    /// I14-W7：目标不存在（删除不存在的 profile/session）。
    #[error("用户数据不存在：{0}")]
    NotFound(String),
    /// DEL-03（§5.13 步骤 1）：owner_key 格式非法（非 [profileId, agentId, localSessionId]
    /// 三元素 JSON 数组）——删除前校验失败，拒绝污染 tombstone owner。
    #[error("owner_key 校验失败：{0}")]
    InvalidOwnerKey(String),
}

impl UserDataError {
    /// 机器可读错误码（稳定，不改拼写）。
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::RevisionConflict { .. } => "user_data_revision_conflict",
            Self::Unavailable(_) => "user_data_unavailable",
            Self::Corrupt(_) => "user_data_corrupt",
            Self::NotFound(_) => "user_data_not_found",
            Self::InvalidOwnerKey(_) => "invalid_owner_key",
        }
    }
}

/// B1.2：结构化错误 wire `{ code, message }`（typed IPC——Tauri command 直接返回
/// `Result<T, UserDataError>`，前端按 code 分支，message 仅展示）。与 MessageError 同形。
impl Serialize for UserDataError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        map.end()
    }
}

impl From<rusqlite::Error> for UserDataError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Unavailable(format!("user data repo: {error}"))
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock_err<E>(_: E) -> UserDataError {
    UserDataError::Unavailable("user data repo lock poisoned".to_string())
}

fn as_corrupt(key: UserDataKey, reason: impl std::fmt::Display) -> UserDataError {
    UserDataError::Corrupt(format!("{} envelope 非法：{reason}", key.as_str()))
}

fn text_of(value: &serde_json::Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// 校验 profiles envelope（v1）：profiles 数组，每条 id 非空字符串；
/// activeProfileId 若存在必须为字符串。返回 envelope version。
fn validate_profiles(payload: &serde_json::Value) -> Result<i64, UserDataError> {
    let version = payload
        .get("version")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| as_corrupt(UserDataKey::Profiles, "version 必须为整数"))?;
    if version != 1 {
        return Err(as_corrupt(
            UserDataKey::Profiles,
            format!("未知 envelope version {version}"),
        ));
    }
    let profiles = payload
        .get("profiles")
        .ok_or_else(|| as_corrupt(UserDataKey::Profiles, "缺少 profiles 数组"))?
        .as_array()
        .ok_or_else(|| as_corrupt(UserDataKey::Profiles, "profiles 必须为数组"))?;
    for profile in profiles {
        let object = profile
            .as_object()
            .ok_or_else(|| as_corrupt(UserDataKey::Profiles, "profile 必须为对象"))?;
        if text_of(object.get("id").unwrap_or(&serde_json::Value::Null)).is_none() {
            return Err(as_corrupt(UserDataKey::Profiles, "profile 缺少非空 id"));
        }
    }
    if let Some(active) = payload.get("activeProfileId") {
        if !active.is_string() {
            return Err(as_corrupt(
                UserDataKey::Profiles,
                "activeProfileId 必须为字符串",
            ));
        }
    }
    Ok(version)
}

/// 校验 sessions envelope（v2）：sessions 数组，每条 id 非空字符串；
/// agentId 字段若存在必须为非空字符串（legacy 无 agentId 条目原样接受——
/// ISSUE-01 CR-001 unresolved 保留，不得在此丢弃）。返回 envelope version。
fn validate_sessions(payload: &serde_json::Value) -> Result<i64, UserDataError> {
    let version = payload
        .get("version")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| as_corrupt(UserDataKey::Sessions, "version 必须为整数"))?;
    // 2 = 基础会话 envelope；3 = 新增可选 creationSnapshot（2f9119c 前端升版，后端补兼容）
    if !matches!(version, 2 | 3) {
        return Err(as_corrupt(
            UserDataKey::Sessions,
            format!("未知 envelope version {version}"),
        ));
    }
    let sessions = payload
        .get("sessions")
        .ok_or_else(|| as_corrupt(UserDataKey::Sessions, "缺少 sessions 数组"))?
        .as_array()
        .ok_or_else(|| as_corrupt(UserDataKey::Sessions, "sessions 必须为数组"))?;
    for session in sessions {
        let object = session
            .as_object()
            .ok_or_else(|| as_corrupt(UserDataKey::Sessions, "session 必须为对象"))?;
        if text_of(object.get("id").unwrap_or(&serde_json::Value::Null)).is_none() {
            return Err(as_corrupt(UserDataKey::Sessions, "session 缺少非空 id"));
        }
        if let Some(agent_id) = object.get("agentId") {
            if text_of(agent_id).is_none() {
                return Err(as_corrupt(
                    UserDataKey::Sessions,
                    "session 的 agentId 必须为非空字符串",
                ));
            }
        }
    }
    Ok(version)
}

/// 打开（或创建）仓库并迁移到最新 schema（复用 msg_repo 的统一迁移链）。
/// 调用方须先创建 DB 父目录；失败返回 Err——启动路径不得静默回退。
pub(crate) fn open_user_data_db(path: &Path) -> Result<UserDataStore, UserDataError> {
    let mut conn = Connection::open(path).map_err(UserDataError::from)?;
    crate::session::connect(&mut conn)
        .map_err(|error| UserDataError::Unavailable(error.to_string()))?;
    Ok(UserDataStore {
        conn: Mutex::new(conn),
    })
}

/// 用户数据仓库：单一 SQLite 连接 + 互斥（SQLite 单写者；与 MessageService 不同连接、
/// 同文件——connect 内 busy_timeout 序列化同文件写）。
pub(crate) struct UserDataStore {
    conn: Mutex<Connection>,
}

impl UserDataStore {
    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存仓库
    pub(crate) fn open_in_memory() -> Result<UserDataStore, UserDataError> {
        let mut conn = Connection::open_in_memory().map_err(UserDataError::from)?;
        crate::session::connect(&mut conn)
            .map_err(|error| UserDataError::Unavailable(error.to_string()))?;
        Ok(UserDataStore {
            conn: Mutex::new(conn),
        })
    }

    /// 读取 key 对应的 envelope；无数据返回 None。payload 损坏（非 JSON）→ Corrupt
    /// （损坏报错，不静默覆盖现场）。
    pub(crate) fn load(&self, key: UserDataKey) -> Result<Option<UserDataEnvelope>, UserDataError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let row = conn
            .query_row(
                "SELECT version, revision, payload FROM user_data WHERE key = ?1",
                [key.as_str()],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(UserDataError::from)?;
        match row {
            None => Ok(None),
            Some((version, revision, payload)) => {
                let parsed: serde_json::Value =
                    serde_json::from_str(&payload).map_err(|error| {
                        UserDataError::Corrupt(format!(
                            "{} payload 无法解析为 JSON：{error}",
                            key.as_str()
                        ))
                    })?;
                Ok(Some(UserDataEnvelope {
                    version,
                    revision,
                    payload: parsed,
                }))
            }
        }
    }

    /// 原子保存（单事务：读 revision → 校验 expected → upsert）。
    /// - expected Some(e)：e 必须等于当前 revision（无行 = 0），否则 RevisionConflict；
    /// - expected None：无条件 upsert（盲写，import/首写用）；
    /// - 成功返回新 revision（当前 + 1）。
    ///
    /// 结构校验失败 → Corrupt，不写入。
    pub(crate) fn save(
        &self,
        key: UserDataKey,
        payload: serde_json::Value,
        expected_revision: Option<i64>,
    ) -> Result<i64, UserDataError> {
        let version = match key {
            UserDataKey::Profiles => validate_profiles(&payload)?,
            UserDataKey::Sessions => validate_sessions(&payload)?,
        };
        let payload_str = serde_json::to_string(&payload)
            .map_err(|error| UserDataError::Corrupt(format!("payload 序列化失败：{error}")))?;
        if payload_str.len() > MAX_USER_DATA_BYTES {
            return Err(UserDataError::Corrupt(format!(
                "{} payload 超过 {} 字节上限",
                key.as_str(),
                MAX_USER_DATA_BYTES
            )));
        }
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(UserDataError::from)?;
        let current: Option<i64> = tx
            .query_row(
                "SELECT revision FROM user_data WHERE key = ?1",
                [key.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(UserDataError::from)?;
        let current_revision = current.unwrap_or(0);
        if let Some(expected) = expected_revision {
            if expected != current_revision {
                return Err(UserDataError::RevisionConflict {
                    expected,
                    actual: current_revision,
                });
            }
        }
        let new_revision = current_revision + 1;
        tx.execute(
            "INSERT INTO user_data (key, version, revision, payload, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(key) DO UPDATE SET
                 version = excluded.version,
                 revision = excluded.revision,
                 payload = excluded.payload,
                 updated_at = excluded.updated_at",
            params![
                key.as_str(),
                version,
                new_revision,
                payload_str,
                now_millis()
            ],
        )
        .map_err(UserDataError::from)?;
        tx.commit().map_err(UserDataError::from)?;
        Ok(new_revision)
    }

    /// 读取 envelope 行的 helper（单事务内复用；key 恒为合法的两个常量之一）。
    fn load_envelope_row(
        tx: &rusqlite::Transaction<'_>,
        key: UserDataKey,
    ) -> Result<Option<(i64, i64, String)>, UserDataError> {
        tx.query_row(
            "SELECT version, revision, payload FROM user_data WHERE key = ?1",
            [key.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(UserDataError::from)
    }

    /// 在事务内 upsert envelope 行（revision+1；key 恒合法）。
    fn upsert_envelope_row(
        tx: &rusqlite::Transaction<'_>,
        key: UserDataKey,
        version: i64,
        new_revision: i64,
        payload: &serde_json::Value,
    ) -> Result<(), UserDataError> {
        let payload_str = serde_json::to_string(payload)
            .map_err(|error| UserDataError::Corrupt(format!("payload 序列化失败：{error}")))?;
        if payload_str.len() > MAX_USER_DATA_BYTES {
            return Err(UserDataError::Corrupt(format!(
                "{} payload 超过 {} 字节上限",
                key.as_str(),
                MAX_USER_DATA_BYTES
            )));
        }
        tx.execute(
            "INSERT INTO user_data (key, version, revision, payload, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(key) DO UPDATE SET
                 version = excluded.version,
                 revision = excluded.revision,
                 payload = excluded.payload,
                 updated_at = excluded.updated_at",
            params![
                key.as_str(),
                version,
                new_revision,
                payload_str,
                now_millis()
            ],
        )
        .map_err(UserDataError::from)?;
        Ok(())
    }

    /// I14-W7：原子删除 Profile——**单事务**内：从 profiles envelope 移除该 profile、
    /// 计算 fallback（首个剩余 profile id）、把引用它的 sessions 的 profileId 重绑定、
    /// 修正 activeProfileId，并同时落盘 profiles + sessions 两个 envelope。
    /// 任一失败整体回滚（跨 envelope 原子性由同一事务保证）；删除不存在的 profile
    /// → NotFound（不静默）。
    pub(crate) fn delete_profile(
        &self,
        profile_id: &str,
    ) -> Result<ProfileDeleteResult, UserDataError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(UserDataError::from)?;

        // 1. profiles envelope：移除 + fallback + activeProfileId 修正
        let (p_version, p_revision, p_payload) =
            Self::load_envelope_row(&tx, UserDataKey::Profiles)?
                .ok_or_else(|| UserDataError::NotFound("profiles envelope 不存在".into()))?;
        let mut profiles: serde_json::Value = serde_json::from_str(&p_payload)
            .map_err(|error| UserDataError::Corrupt(format!("profiles payload 损坏：{error}")))?;
        validate_profiles(&profiles)?;
        let all: Vec<serde_json::Value> = profiles
            .get("profiles")
            .and_then(|v| v.as_array())
            .cloned()
            .ok_or_else(|| as_corrupt(UserDataKey::Profiles, "缺少 profiles 数组"))?;
        if !all
            .iter()
            .any(|p| p.get("id").and_then(serde_json::Value::as_str) == Some(profile_id))
        {
            return Err(UserDataError::NotFound(format!(
                "profile 不存在: {profile_id}"
            )));
        }
        let remaining: Vec<serde_json::Value> = all
            .into_iter()
            .filter(|p| p.get("id").and_then(serde_json::Value::as_str) != Some(profile_id))
            .collect();
        let fallback = remaining
            .first()
            .and_then(|p| p.get("id"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        profiles["profiles"] = serde_json::Value::Array(remaining);
        if profiles
            .get("activeProfileId")
            .and_then(serde_json::Value::as_str)
            == Some(profile_id)
        {
            profiles["activeProfileId"] = serde_json::Value::String(fallback.clone());
        }
        validate_profiles(&profiles)?;

        // 2. sessions envelope：引用该 profile 的会话重绑定到 fallback（若无剩余 profile
        //    则保留原 profileId——由前端/后续修复；空库 fallback="" 同理不强行改写）。
        let mut sessions_revision: Option<i64> = None;
        if !fallback.is_empty() {
            if let Some((s_version, s_revision, s_payload)) =
                Self::load_envelope_row(&tx, UserDataKey::Sessions)?
            {
                let mut sessions: serde_json::Value =
                    serde_json::from_str(&s_payload).map_err(|error| {
                        UserDataError::Corrupt(format!("sessions payload 损坏：{error}"))
                    })?;
                validate_sessions(&sessions)?;
                if let Some(arr) = sessions.get_mut("sessions").and_then(|v| v.as_array_mut()) {
                    for session in arr.iter_mut() {
                        if session.get("profileId").and_then(serde_json::Value::as_str)
                            == Some(profile_id)
                        {
                            session["profileId"] = serde_json::Value::String(fallback.clone());
                        }
                    }
                }
                validate_sessions(&sessions)?;
                let new_revision = s_revision + 1;
                Self::upsert_envelope_row(
                    &tx,
                    UserDataKey::Sessions,
                    s_version,
                    new_revision,
                    &sessions,
                )?;
                sessions_revision = Some(new_revision);
            }
        }

        // 3. profiles envelope 落盘（revision+1）
        let profiles_new_revision = p_revision + 1;
        Self::upsert_envelope_row(
            &tx,
            UserDataKey::Profiles,
            p_version,
            profiles_new_revision,
            &profiles,
        )?;
        tx.commit().map_err(UserDataError::from)?;
        Ok(ProfileDeleteResult {
            fallback,
            profiles_revision: profiles_new_revision,
            sessions_revision,
        })
    }

    /// I14-W7：从 sessions envelope 移除会话（事务内，revision+1）。会话删除由
    /// 调用方（user_session_delete 命令）经 MessageService 执行；迟到写由
    /// deleted_sessions tombstone 拒绝（touch/evt_append 先查命中即拒——canonical
    /// 事件流无 FK 级联，必须显式 tombstone gate，见 DEL-04/CR-05）。
    pub(crate) fn delete_session(&self, session_id: &str) -> Result<i64, UserDataError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(UserDataError::from)?;
        let (s_version, s_revision, s_payload) =
            Self::load_envelope_row(&tx, UserDataKey::Sessions)?
                .ok_or_else(|| UserDataError::NotFound("sessions envelope 不存在".into()))?;
        let mut sessions: serde_json::Value = serde_json::from_str(&s_payload)
            .map_err(|error| UserDataError::Corrupt(format!("sessions payload 损坏：{error}")))?;
        validate_sessions(&sessions)?;
        let arr = sessions
            .get_mut("sessions")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| as_corrupt(UserDataKey::Sessions, "缺少 sessions 数组"))?;
        let before = arr.len();
        arr.retain(|session| {
            session.get("id").and_then(serde_json::Value::as_str) != Some(session_id)
        });
        if arr.len() == before {
            return Err(UserDataError::NotFound(format!(
                "session 不存在: {session_id}"
            )));
        }
        validate_sessions(&sessions)?;
        let new_revision = s_revision + 1;
        Self::upsert_envelope_row(
            &tx,
            UserDataKey::Sessions,
            s_version,
            new_revision,
            &sessions,
        )?;
        tx.commit().map_err(UserDataError::from)?;
        Ok(new_revision)
    }
}

/// 用户数据 service：spawn_blocking 边界 + 命令层 DTO（与 MessageService 同构）。
pub(crate) struct UserDataService {
    store: Arc<UserDataStore>,
}

impl UserDataService {
    /// 打开（或创建）生产仓库并迁移到最新 schema。调用方须先创建 DB 父目录；
    /// 失败返回 Err——启动路径不得静默回退形成双主（ISSUE-14 W5）。
    pub(crate) fn open_db(path: &Path) -> Result<UserDataService, UserDataError> {
        let store = open_user_data_db(path)?;
        Ok(UserDataService {
            store: Arc::new(store),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存服务
    pub(crate) fn in_memory() -> Result<UserDataService, UserDataError> {
        let store = UserDataStore::open_in_memory()?;
        Ok(UserDataService {
            store: Arc::new(store),
        })
    }

    pub(crate) async fn load(
        &self,
        key: UserDataKey,
    ) -> Result<Option<UserDataEnvelope>, UserDataError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.load(key))
            .await
            .map_err(|error| {
                UserDataError::Unavailable(format!("user data load task failed: {error}"))
            })?
    }

    pub(crate) async fn save(
        &self,
        key: UserDataKey,
        payload: serde_json::Value,
        expected_revision: Option<i64>,
    ) -> Result<i64, UserDataError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.save(key, payload, expected_revision))
            .await
            .map_err(|error| {
                UserDataError::Unavailable(format!("user data save task failed: {error}"))
            })?
    }

    /// I14-W7：原子删除 Profile（跨 profiles/sessions envelope 单事务）。
    pub(crate) async fn delete_profile(
        &self,
        profile_id: String,
    ) -> Result<ProfileDeleteResult, UserDataError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.delete_profile(&profile_id))
            .await
            .map_err(|error| {
                UserDataError::Unavailable(format!("user data delete profile task failed: {error}"))
            })?
    }

    /// I14-W7：从 sessions envelope 移除会话（消息级联由命令层协调）。
    pub(crate) async fn delete_session(&self, session_id: String) -> Result<i64, UserDataError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.delete_session(&session_id))
            .await
            .map_err(|error| {
                UserDataError::Unavailable(format!("user data delete session task failed: {error}"))
            })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_db_path() -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "pylon-user-data-test-{}-{}-{}.db",
            std::process::id(),
            n,
            nanos
        ))
    }

    fn profiles_payload() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "profiles": [
                { "id": "profile-a", "name": "Profile A", "persona": "p", "model": "deepseek-v4-flash" },
                { "id": "profile-b", "name": "Profile B", "persona": "p2", "model": "deepseek-v4-flash" }
            ],
            "activeProfileId": "profile-a"
        })
    }

    fn sessions_payload() -> serde_json::Value {
        serde_json::json!({
            "version": 2,
            "sessions": [
                { "id": "s1", "agentId": "peri", "name": "会话一", "source": "qq:group:1", "profileId": "profile-a" },
                { "id": "s2", "agentId": "vega", "name": "会话二", "source": "local:x", "profileId": "profile-a" }
            ]
        })
    }

    #[test]
    fn profiles_roundtrip_preserves_payload_and_revision() {
        let store = UserDataStore::open_in_memory().expect("open");
        let revision = store
            .save(UserDataKey::Profiles, profiles_payload(), None)
            .expect("save");
        assert_eq!(revision, 1);
        let loaded = store
            .load(UserDataKey::Profiles)
            .expect("load")
            .expect("present");
        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.revision, 1);
        assert_eq!(loaded.payload, profiles_payload());
    }

    #[test]
    fn sessions_roundtrip_with_agent_id() {
        let store = UserDataStore::open_in_memory().expect("open");
        store
            .save(UserDataKey::Sessions, sessions_payload(), None)
            .expect("save");
        let loaded = store
            .load(UserDataKey::Sessions)
            .expect("load")
            .expect("present");
        assert_eq!(loaded.payload, sessions_payload());
        assert_eq!(loaded.revision, 1);
    }

    #[test]
    fn sequential_saves_bump_revision_and_expected_must_match() {
        let store = UserDataStore::open_in_memory().expect("open");
        assert_eq!(
            store
                .save(UserDataKey::Profiles, profiles_payload(), None)
                .expect("w1"),
            1
        );
        assert_eq!(
            store
                .save(UserDataKey::Profiles, profiles_payload(), Some(1))
                .expect("w2"),
            2
        );
        // stale expected（=1，当前 2）→ conflict，不覆盖
        let error = store
            .save(UserDataKey::Profiles, profiles_payload(), Some(1))
            .expect_err("stale write must conflict");
        match error {
            UserDataError::RevisionConflict { expected, actual } => {
                assert_eq!(expected, 1);
                assert_eq!(actual, 2);
            }
            other => panic!("expected revision conflict, got {other:?}"),
        }
        assert_eq!(error.code(), "user_data_revision_conflict");
        // 冲突未写入：仍为上一版本
        let loaded = store
            .load(UserDataKey::Profiles)
            .expect("load")
            .expect("present");
        assert_eq!(loaded.revision, 2);
    }

    #[test]
    fn blind_write_without_expected_succeeds() {
        let store = UserDataStore::open_in_memory().expect("open");
        assert_eq!(
            store
                .save(UserDataKey::Sessions, sessions_payload(), None)
                .expect("w1"),
            1
        );
        assert_eq!(
            store
                .save(UserDataKey::Sessions, sessions_payload(), None)
                .expect("w2"),
            2
        );
        let loaded = store
            .load(UserDataKey::Sessions)
            .expect("load")
            .expect("present");
        assert_eq!(loaded.revision, 2);
    }

    #[test]
    fn expected_zero_on_missing_row_succeeds() {
        let store = UserDataStore::open_in_memory().expect("open");
        assert_eq!(
            store
                .save(UserDataKey::Profiles, profiles_payload(), Some(0))
                .expect("w"),
            1
        );
    }

    #[test]
    fn expected_positive_on_missing_row_conflicts() {
        let store = UserDataStore::open_in_memory().expect("open");
        let error = store
            .save(UserDataKey::Profiles, profiles_payload(), Some(5))
            .expect_err("no row but expected 5");
        match error {
            UserDataError::RevisionConflict { expected, actual } => {
                assert_eq!(expected, 5);
                assert_eq!(actual, 0);
            }
            other => panic!("expected revision conflict, got {other:?}"),
        }
    }

    #[test]
    fn legacy_session_without_agent_id_is_accepted() {
        // ISSUE-01 CR-001：unresolved legacy 会话（无 agentId）必须原样保留，不得拒绝/丢弃
        let payload = serde_json::json!({
            "version": 2,
            "sessions": [
                { "id": "s-legacy", "name": "旧会话", "source": "qq:group:9", "profileId": "profile-a" }
            ]
        });
        let store = UserDataStore::open_in_memory().expect("open");
        let revision = store
            .save(UserDataKey::Sessions, payload.clone(), None)
            .expect("save");
        assert_eq!(revision, 1);
        let loaded = store
            .load(UserDataKey::Sessions)
            .expect("load")
            .expect("present");
        assert_eq!(loaded.payload, payload);
    }

    #[test]
    fn empty_agent_id_is_rejected() {
        let payload = serde_json::json!({
            "version": 2,
            "sessions": [{ "id": "s1", "agentId": "", "name": "n", "source": "s", "profileId": "p" }]
        });
        let store = UserDataStore::open_in_memory().expect("open");
        let error = store
            .save(UserDataKey::Sessions, payload, None)
            .expect_err("must reject");
        assert_eq!(error.code(), "user_data_corrupt");
        assert!(error.to_string().contains("agentId"));
        // 拒绝未写入
        assert!(store.load(UserDataKey::Sessions).expect("load").is_none());
    }

    #[test]
    fn missing_id_is_rejected_for_profiles_and_sessions() {
        let store = UserDataStore::open_in_memory().expect("open");
        let bad_profiles = serde_json::json!({
            "version": 1,
            "profiles": [{ "name": "no-id", "persona": "p", "model": "m" }],
            "activeProfileId": "no-id"
        });
        assert_eq!(
            store
                .save(UserDataKey::Profiles, bad_profiles, None)
                .expect_err("reject")
                .code(),
            "user_data_corrupt"
        );
        let bad_sessions = serde_json::json!({
            "version": 2,
            "sessions": [{ "name": "no-id", "source": "s", "profileId": "p" }]
        });
        assert_eq!(
            store
                .save(UserDataKey::Sessions, bad_sessions, None)
                .expect_err("reject")
                .code(),
            "user_data_corrupt"
        );
    }

    #[test]
    fn unknown_envelope_version_is_rejected() {
        let store = UserDataStore::open_in_memory().expect("open");
        let bad_profiles =
            serde_json::json!({ "version": 99, "profiles": [], "activeProfileId": "" });
        assert_eq!(
            store
                .save(UserDataKey::Profiles, bad_profiles, None)
                .expect_err("reject")
                .code(),
            "user_data_corrupt"
        );
        let bad_sessions = serde_json::json!({ "version": 1, "sessions": [] });
        assert_eq!(
            store
                .save(UserDataKey::Sessions, bad_sessions, None)
                .expect_err("reject")
                .code(),
            "user_data_corrupt"
        );
    }

    #[test]
    fn corrupt_payload_on_load_is_reported_not_overwritten() {
        let store = UserDataStore::open_in_memory().expect("open");
        store
            .save(UserDataKey::Profiles, profiles_payload(), None)
            .expect("save");
        // 直接写坏 payload 模拟外部损坏
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE user_data SET payload = ?1 WHERE key = 'profiles'",
                ["{ not valid json".to_string()],
            )
            .unwrap();
        }
        let error = store
            .load(UserDataKey::Profiles)
            .expect_err("corrupt must error");
        assert_eq!(error.code(), "user_data_corrupt");
        assert!(error.to_string().contains("JSON"));
    }

    #[test]
    fn oversized_payload_is_rejected() {
        let store = UserDataStore::open_in_memory().expect("open");
        let big = serde_json::json!({
            "version": 1,
            "profiles": [],
            "activeProfileId": "x",
            "blob": "x".repeat(MAX_USER_DATA_BYTES + 1)
        });
        let error = store
            .save(UserDataKey::Profiles, big, None)
            .expect_err("must reject");
        assert_eq!(error.code(), "user_data_corrupt");
        assert!(error.to_string().contains("上限"));
    }

    #[test]
    fn file_backed_store_persists_across_reopen() {
        let path = unique_temp_db_path();
        {
            let store = open_user_data_db(&path).expect("open");
            store
                .save(UserDataKey::Sessions, sessions_payload(), None)
                .expect("save");
        }
        {
            let store = open_user_data_db(&path).expect("reopen");
            let loaded = store
                .load(UserDataKey::Sessions)
                .expect("load")
                .expect("present");
            assert_eq!(loaded.revision, 1);
            assert_eq!(loaded.payload, sessions_payload());
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn service_wraps_spawn_blocking_boundary() {
        let service = UserDataService::in_memory().expect("open");
        let runtime = tokio::runtime::Runtime::new().expect("rt");
        let revision = runtime.block_on(async {
            service
                .save(UserDataKey::Profiles, profiles_payload(), None)
                .await
                .expect("save")
        });
        assert_eq!(revision, 1);
        let loaded = runtime.block_on(async {
            service
                .load(UserDataKey::Profiles)
                .await
                .expect("load")
                .expect("present")
        });
        assert_eq!(loaded.revision, 1);
    }

    #[test]
    fn shares_file_with_message_service_and_migrates_idempotently() {
        // 核心设计假设：UserDataStore 与 MessageService 同文件双连接——各自 open 触发
        // 统一迁移链（幂等），user_data 表可写且不影响会话仓库（busy_timeout 序列化写）。
        let path = unique_temp_db_path();
        let msg = crate::session::MessageService::open_db(&path).expect("msg open");
        let user = crate::session::UserDataService::open_db(&path).expect("user open");
        let runtime = tokio::runtime::Runtime::new().expect("rt");
        let revision = runtime.block_on(async {
            user.save(UserDataKey::Profiles, profiles_payload(), None)
                .await
                .expect("user save")
        });
        assert_eq!(revision, 1);
        // 会话仓库在双连接并存下仍可写 session_state（无 SQLITE_BUSY 死锁）
        runtime.block_on(async {
            msg.set_session_state(
                crate::session::DurableSessionOwner::new("p1", "a1", "s1"),
                Some("remote-1".into()),
                serde_json::json!({"usage": {"n": 1}}),
            )
            .await
            .expect("msg state");
        });
        let loaded = runtime.block_on(async {
            user.load(UserDataKey::Profiles)
                .await
                .expect("load")
                .expect("present")
        });
        assert_eq!(loaded.revision, 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn profiles_and_sessions_are_independent_keys() {
        let store = UserDataStore::open_in_memory().expect("open");
        assert!(store.load(UserDataKey::Profiles).expect("load").is_none());
        store
            .save(UserDataKey::Sessions, sessions_payload(), None)
            .expect("save sessions");
        assert!(
            store.load(UserDataKey::Profiles).expect("load").is_none(),
            "sessions 写入不得影响 profiles"
        );
        store
            .save(UserDataKey::Profiles, profiles_payload(), None)
            .expect("save profiles");
        let profiles = store
            .load(UserDataKey::Profiles)
            .expect("load")
            .expect("present");
        let sessions = store
            .load(UserDataKey::Sessions)
            .expect("load")
            .expect("present");
        assert_eq!(profiles.revision, 1);
        assert_eq!(sessions.revision, 1);
    }

    // ── I14-W7：Profile/Session 删除事务 ──

    fn store_with_two_profiles_and_referencing_sessions() -> UserDataStore {
        let store = UserDataStore::open_in_memory().expect("open");
        store
            .save(UserDataKey::Profiles, profiles_payload(), None)
            .expect("save profiles");
        store
            .save(UserDataKey::Sessions, sessions_payload(), None)
            .expect("save sessions");
        store
    }

    #[test]
    fn delete_profile_atomically_falls_back_rebinds_and_fixes_active() {
        let store = store_with_two_profiles_and_referencing_sessions();
        let result = store.delete_profile("profile-a").expect("delete");
        assert_eq!(result.fallback, "profile-b", "fallback = 首个剩余 profile");
        assert_eq!(result.profiles_revision, 2);
        assert_eq!(result.sessions_revision, Some(2));

        let profiles = store
            .load(UserDataKey::Profiles)
            .expect("load")
            .expect("present");
        let profile_ids: Vec<&str> = profiles.payload["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["id"].as_str())
            .collect();
        assert_eq!(profile_ids, vec!["profile-b"], "profile-a 已移除");
        assert_eq!(
            profiles.payload["activeProfileId"], "profile-b",
            "active 已 fallback"
        );

        let sessions = store
            .load(UserDataKey::Sessions)
            .expect("load")
            .expect("present");
        let rebinds: Vec<&str> = sessions.payload["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["profileId"].as_str())
            .collect();
        assert_eq!(
            rebinds,
            vec!["profile-b", "profile-b"],
            "引用会话已重绑定到 fallback"
        );
    }

    #[test]
    fn delete_profile_not_found_returns_not_found_and_preserves_state() {
        let store = store_with_two_profiles_and_referencing_sessions();
        let error = store.delete_profile("ghost").expect_err("must fail");
        assert_eq!(error.code(), "user_data_not_found");
        // 状态未变（revision 未推进）
        let profiles = store
            .load(UserDataKey::Profiles)
            .expect("load")
            .expect("present");
        assert_eq!(profiles.revision, 1);
    }

    #[test]
    fn delete_profile_atomic_rollback_on_corrupt_sessions_envelope() {
        // CR-04：跨 envelope 原子性——sessions envelope 损坏时 delete_profile 失败，
        // profiles envelope 也必须回滚（revision 不推进，无半删除态）
        let store = store_with_two_profiles_and_referencing_sessions();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "UPDATE user_data SET payload = ?1 WHERE key = 'sessions'",
                ["{ not valid json".to_string()],
            )
            .unwrap();
        }
        let error = store
            .delete_profile("profile-a")
            .expect_err("corrupt sessions must abort");
        assert_eq!(error.code(), "user_data_corrupt");
        // profiles envelope 未推进（事务回滚）
        let profiles = store
            .load(UserDataKey::Profiles)
            .expect("load")
            .expect("present");
        assert_eq!(profiles.revision, 1, "profiles 必须随事务回滚，无半删除态");
        let profile_ids: Vec<&str> = profiles.payload["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["id"].as_str())
            .collect();
        assert_eq!(
            profile_ids,
            vec!["profile-a", "profile-b"],
            "profile 未被移除"
        );
    }

    #[test]
    fn delete_session_removes_from_envelope_and_bumps_revision() {
        let store = store_with_two_profiles_and_referencing_sessions();
        let new_revision = store.delete_session("s1").expect("delete");
        assert_eq!(new_revision, 2);
        let sessions = store
            .load(UserDataKey::Sessions)
            .expect("load")
            .expect("present");
        let ids: Vec<&str> = sessions.payload["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["id"].as_str())
            .collect();
        assert_eq!(ids, vec!["s2"], "s1 已从 envelope 移除");
    }

    #[test]
    fn delete_session_not_found_returns_not_found() {
        let store = store_with_two_profiles_and_referencing_sessions();
        let error = store.delete_session("ghost").expect_err("must fail");
        assert_eq!(error.code(), "user_data_not_found");
    }

    #[test]
    fn deleted_session_evt_append_rejected_by_tombstone() {
        // tombstone 语义：会话删除后，迟到 evt_append 被 deleted_sessions tombstone
        // 拒绝（不复活已删会话）——DEL-04 canonical 迟到写 gate。
        let path = unique_temp_db_path();
        let msg = crate::session::MessageService::open_db(&path).expect("msg open");
        let user = crate::session::UserDataService::open_db(&path).expect("user open");
        let evt = crate::session::EventService::open_db(&path).expect("evt open");
        let runtime = tokio::runtime::Runtime::new().expect("rt");
        let owner_key = r#"["p","peri","qq:g:9"]"#.to_string();
        let late_event = || {
            serde_json::json!({
                "eventId": format!("{owner_key}#1"),
                "owner": { "profileId": "p", "agentId": "peri", "localSessionId": "qq:g:9" },
                "clientGeneration": 1,
                "sequence": 1,
                "occurredAt": "2026-01-01T00:00:00.000Z",
                "receivedAt": "2026-01-01T00:00:00.000Z",
                "eventType": "user.message",
                "payloadVersion": 1,
                "rawPayload": {}
            })
        };
        runtime.block_on(async {
            // 用户记录存在（sessions envelope 含 s-del）
            let envelope = serde_json::json!({
                "version": 2,
                "sessions": [
                    { "id": "s-del", "agentId": "peri", "name": "待删", "source": "qq:g:9", "profileId": "p" }
                ]
            });
            user.save(crate::session::user_data::UserDataKey::Sessions, envelope, None)
                .await
                .expect("save sessions");
            // 删除前事件可写
            evt.append_events(vec![late_event()], None).await.expect("append ok");
            // 用户记录删除 + 会话 tombstone（deleting 两阶段入口）
            user.delete_session("s-del".into()).await.expect("user delete");
            msg.begin_delete_session("s-del".into(), Some(owner_key.clone())).await.expect("msg delete");
        });
        // 迟到 append → EventError code=event_session_deleted（tombstone 拒绝，不复活）
        let error = runtime.block_on(async {
            evt.append_events(vec![late_event()], None)
                .await
                .expect_err("must reject")
        });
        assert_eq!(
            error.code(),
            "event_session_deleted",
            "迟到写必须被拒绝（tombstone）：{error}"
        );
        let _ = std::fs::remove_file(&path);
    }
}
