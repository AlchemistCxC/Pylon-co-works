//! 启动诊断快照（R5/P1-3）。
//!
//! run() 启动时构建一次只读快照，供 `startup_diagnostics` command 结构化读取。
//! 前端只判断配置来源类型与分域状态；完整路径、错误细节只在本地 runtime log 记录，
//! 不广播到平台。

use serde::Serialize;

/// 组件状态码。
/// `Degraded`/`Unavailable` 为拍板保留的未来状态（Degraded=部分可用、
/// Unavailable=运行期服务不可达），当前启动快照只构造 Ready/ConfigurationError。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ComponentStatusCode {
    Ready,
    Degraded,
    ConfigurationError,
    Unavailable,
}

/// ConfigSource → ConfigSourceKind（diagnostics 序列化用）。
fn config_source_kind(source: &crate::agent_config::ConfigSource) -> ConfigSourceKind {
    match source.kind() {
        "environment" => ConfigSourceKind::Environment,
        "executable_directory" => ConfigSourceKind::ExecutableDirectory,
        _ => ConfigSourceKind::Embedded,
    }
}

/// 诊断消息脱敏（P1-3 拍板：不暴露完整路径）：把配置绝对路径替换为文件名。
/// 读取失败错误含完整路径（read_config_document 的 `读取 {path} 失败`），本地
/// eprintln/日志保留完整路径（排障用），仅 DTO 出口脱敏。解析类错误本就不含
/// 路径，原样透传。
fn sanitize_message(message: &str, source: &crate::agent_config::ConfigSource) -> String {
    let full = match source {
        crate::agent_config::ConfigSource::Environment(path)
        | crate::agent_config::ConfigSource::ExecutableDirectory(path) => {
            path.display().to_string()
        }
        // Embedded 不读文件，错误不含路径。
        crate::agent_config::ConfigSource::Embedded => return message.to_string(),
    };
    let file = source
        .file_name()
        .unwrap_or_else(|| "agents.yaml".to_string());
    message.replacen(&full, &file, 1)
}

/// 单一组件状态（message 仅配置错误展示，不含 secret/完整路径）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    pub status: ComponentStatusCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 配置来源视图：只暴露类型 + 文件名，不暴露完整绝对路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSourceView {
    pub kind: ConfigSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigSourceKind {
    Environment,
    ExecutableDirectory,
    Embedded,
}

/// Hermes profile 探测结果（release-issues #1 方案 G 演进）：只暴露 profile 名
/// 列表与配置的 profile 名称，不暴露 Hermes 根目录绝对路径（本地日志另记）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesProfileView {
    /// 探测到的可用 profile 名（`<hermes_home>/profiles/*`）。
    pub profiles: Vec<String>,
    /// agents.yaml `hermes_profile` 配置值（未配置为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured: Option<String>,
    /// 是否已解析出应注入的 HERMES_HOME（配置了 profile 且能定位）。
    pub resolved: bool,
}

/// 存储诊断（施工文档 §7.4）：只暴露模式与脱敏原因，完整路径只进本地日志。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDiagnostics {
    pub mode: crate::paths::StorageMode,
    pub portable_requested: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    /// AppData → portable 迁移可用性（Phase 5 接线；当前固定 false）。
    pub migration_available: bool,
}

impl StorageDiagnostics {
    pub(crate) fn from_dirs(dirs: &crate::paths::DataDirs) -> Self {
        Self {
            mode: dirs.mode,
            portable_requested: dirs.portable_requested,
            fallback_reason: dirs.fallback_reason.clone(),
            migration_available: false,
        }
    }

    pub(crate) fn with_migration_available(mut self, available: bool) -> Self {
        self.migration_available = available;
        self
    }
}

/// 启动诊断快照（只读；AppState.startup 持有，setup 解析 DataDirs 后补写 storage）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupDiagnostics {
    pub agent_config: ComponentStatus,
    pub gateway_config: ComponentStatus,
    pub prism: ComponentStatus,
    pub default_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_source: Option<ConfigSourceView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hermes_profile: Option<HermesProfileView>,
    /// 存储模式诊断（setup 最前面解析 DataDirs 后写入）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<StorageDiagnostics>,
}

/// run() 构建：配置来源 + 分域错误 + prism 构造状态 + 默认 agent。
pub(crate) fn build_startup_diagnostics(
    source: crate::agent_config::ConfigSource,
    agents_error: Option<String>,
    gateway_error: Option<String>,
    prism_ready: bool,
    default_agent_id: Option<String>,
    hermes_profile: Option<HermesProfileView>,
) -> StartupDiagnostics {
    let source_view = ConfigSourceView {
        kind: config_source_kind(&source),
        file_name: source.file_name(),
    };
    StartupDiagnostics {
        agent_config: ComponentStatus {
            status: if agents_error.is_some() {
                ComponentStatusCode::ConfigurationError
            } else {
                ComponentStatusCode::Ready
            },
            message: agents_error.map(|message| sanitize_message(&message, &source)),
        },
        gateway_config: ComponentStatus {
            status: if gateway_error.is_some() {
                ComponentStatusCode::ConfigurationError
            } else {
                ComponentStatusCode::Ready
            },
            message: gateway_error.map(|message| sanitize_message(&message, &source)),
        },
        // Prism 只报构造期配置状态（Ready/ConfigurationError）；运行期可达性由
        // prism_status() 的 /health 探测表达。错误详情留在本地 runtime log，不外泄。
        prism: ComponentStatus {
            status: if prism_ready {
                ComponentStatusCode::Ready
            } else {
                ComponentStatusCode::ConfigurationError
            },
            message: None,
        },
        default_agent_id,
        config_source: Some(source_view),
        hermes_profile,
        storage: None,
    }
}

impl StartupDiagnostics {
    /// 测试默认快照（全 Ready + embedded 来源）。
    #[cfg(test)]
    pub(crate) fn test_default() -> Self {
        Self {
            agent_config: ComponentStatus {
                status: ComponentStatusCode::Ready,
                message: None,
            },
            gateway_config: ComponentStatus {
                status: ComponentStatusCode::Ready,
                message: None,
            },
            prism: ComponentStatus {
                status: ComponentStatusCode::Ready,
                message: None,
            },
            default_agent_id: None,
            config_source: Some(ConfigSourceView {
                kind: ConfigSourceKind::Embedded,
                file_name: Some("agents.yaml".to_string()),
            }),
            hermes_profile: None,
            storage: None,
        }
    }
}

/// startup_diagnostics command：读取启动快照（R5/P1-3）。
#[tauri::command]
pub(crate) async fn startup_diagnostics(
    state: tauri::State<'_, crate::AppState>,
) -> Result<StartupDiagnostics, crate::error::PylonError> {
    state
        .startup
        .read()
        .map(|snapshot| snapshot.clone())
        .map_err(|error| {
            crate::error::PylonError::Protocol(format!(
                "startup diagnostics lock poisoned: {error}"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_source() -> crate::agent_config::ConfigSource {
        crate::agent_config::ConfigSource::Environment(std::path::PathBuf::from(
            "C:\\config\\agents.yaml",
        ))
    }

    #[test]
    fn diagnostics_never_expose_full_config_path() {
        // D1 回归（验证 agent 发现）：读取失败错误含完整绝对路径，DTO 出口必须
        // 脱敏为文件名（本地日志保留完整路径，仅快照不泄露）。
        let source = crate::agent_config::ConfigSource::Environment(std::path::PathBuf::from(
            "C:\\Users\\secret-user\\agents.yaml",
        ));
        let diagnostics = build_startup_diagnostics(
            source,
            Some(
                "配置读取失败: 读取 C:\\Users\\secret-user\\agents.yaml 失败: 权限不足".to_string(),
            ),
            None,
            false,
            None,
            None,
        );
        let serialized = serde_json::to_string(&diagnostics).unwrap();
        assert!(
            !serialized.contains("C:\\Users"),
            "诊断快照不得泄露完整路径: {serialized}"
        );
        assert!(
            serialized.contains("agents.yaml"),
            "保留文件名供排障提示: {serialized}"
        );
    }

    #[test]
    fn diagnostics_serializes_domain_statuses_and_source_view() {
        let diagnostics = build_startup_diagnostics(
            sample_source(),
            Some("agent 配置非法".to_string()),
            None,
            true,
            Some("peri".to_string()),
            None,
        );
        let value = serde_json::to_value(&diagnostics).expect("serialize");
        assert_eq!(value["agentConfig"]["status"], "configuration_error");
        assert_eq!(value["gatewayConfig"]["status"], "ready");
        assert_eq!(value["prism"]["status"], "ready");
        assert_eq!(value["defaultAgentId"], "peri");
        assert_eq!(value["configSource"]["kind"], "environment");
        assert_eq!(value["configSource"]["fileName"], "agents.yaml");
        // 完整绝对路径不得出现在 diagnostics 中
        let serialized = serde_json::to_string(&diagnostics).unwrap();
        assert!(!serialized.contains("C:\\config"), "不得泄露完整路径");
    }

    #[test]
    fn embedded_source_file_name_is_agents_yaml() {
        let source = crate::agent_config::ConfigSource::Embedded;
        assert_eq!(source.kind(), "embedded");
        assert_eq!(source.file_name().as_deref(), Some("agents.yaml"));
    }

    #[test]
    fn test_default_diagnostics_are_ready() {
        let diagnostics = StartupDiagnostics::test_default();
        assert_eq!(diagnostics.agent_config.status, ComponentStatusCode::Ready);
        assert_eq!(
            diagnostics.gateway_config.status,
            ComponentStatusCode::Ready
        );
        assert_eq!(
            diagnostics.config_source.as_ref().unwrap().kind,
            ConfigSourceKind::Embedded
        );
    }

    #[test]
    fn hermes_profile_view_serializes_without_home_path() {
        let diagnostics = build_startup_diagnostics(
            crate::agent_config::ConfigSource::Embedded,
            None,
            None,
            false,
            None,
            Some(HermesProfileView {
                profiles: vec!["profile-x".to_string(), "profile-a".to_string()],
                configured: Some("profile-a".to_string()),
                resolved: true,
            }),
        );
        let serialized = serde_json::to_string(&diagnostics).unwrap();
        assert!(
            serialized.contains("profile-a"),
            "profile 名必须可见: {serialized}"
        );
        assert!(
            !serialized.contains("HERMES_HOME") && !serialized.contains("F:\\Hermes"),
            "不得泄露 Hermes 根目录路径: {serialized}"
        );
        assert!(serialized.contains("\"resolved\":true"));
    }

    #[test]
    fn startup_diagnostics_command_returns_snapshot() {
        // command 依赖 Tauri State，无法在此构造；仅钉住 DTO 形状（序列化契约）。
        let diagnostics = build_startup_diagnostics(
            crate::agent_config::ConfigSource::Embedded,
            None,
            None,
            false,
            None,
            None,
        );
        let value = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(value["prism"]["status"], "configuration_error");
        assert!(value["configSource"]["fileName"].is_string());
    }

    #[test]
    fn storage_diagnostics_serializes_portable_mode_without_paths() {
        let dirs = crate::paths::DataDirs {
            data_root: std::path::PathBuf::from("D:/secret-portable/data"),
            config_root: std::path::PathBuf::from("D:/secret-portable/data"),
            mode: crate::paths::StorageMode::Portable,
            portable_requested: true,
            fallback_reason: None,
        };
        let storage = StorageDiagnostics::from_dirs(&dirs);
        let value = serde_json::to_value(&storage).unwrap();
        assert_eq!(value["mode"], "portable");
        assert_eq!(value["portableRequested"], true);
        assert_eq!(value["migrationAvailable"], false);
        let serialized = serde_json::to_string(&storage).unwrap();
        assert!(
            !serialized.contains("secret-portable"),
            "storage 诊断不得泄露完整路径: {serialized}"
        );
    }

    #[test]
    fn storage_diagnostics_reports_fallback_with_sanitized_reason() {
        let dirs = crate::paths::DataDirs {
            data_root: std::path::PathBuf::from("C:/Users/u/AppData/Roaming"),
            config_root: std::path::PathBuf::from("C:/Users/u/AppData/Roaming"),
            mode: crate::paths::StorageMode::AppData,
            portable_requested: true,
            fallback_reason: Some("portable data root not writable: 权限不足".to_string()),
        };
        let storage = StorageDiagnostics::from_dirs(&dirs);
        let value = serde_json::to_value(&storage).unwrap();
        assert_eq!(value["mode"], "app_data");
        assert_eq!(value["portableRequested"], true);
        assert!(value["fallbackReason"]
            .as_str()
            .unwrap()
            .contains("not writable"));
    }
}
