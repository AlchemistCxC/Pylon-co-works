//! Phase 7 transactional binary plugin package store.
//!
//! `packages/`, `data/`, `runtime/`, `transactions/` and `state.json` are the
//! native source of truth. V2 commands exchange descriptors only; package
//! bytes are copied on disk and served by the `pylon-plugin` URI protocol.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::PylonError;
use crate::AppState;

const PACKAGES: &str = "packages";
const DATA: &str = "data";
const RUNTIME: &str = "runtime";
const TRANSACTIONS: &str = "transactions";
const STATE: &str = "state.json";
const MANIFEST: &str = "pylon-plugin.json";
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_INVOKE_TEXT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub(crate) enum PluginError {
    #[error("plugin not found: {0}")]
    NotFound(String),
    #[error("invalid plugin id: {0}")]
    InvalidId(String),
    #[error("plugin io error: {0}")]
    Io(String),
    #[error("plugin manifest invalid: {0}")]
    ManifestInvalid(String),
    #[error("plugin source invalid: {0}")]
    SourceInvalid(String),
    #[error("plugin state conflict: {0}")]
    StateConflict(String),
    #[error("plugin resource invalid: {0}")]
    ResourceInvalid(String),
    #[error("plugin transaction failed: {0}")]
    Transaction(String),
}

impl PluginError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "plugin_not_found",
            Self::InvalidId(_) => "plugin_invalid_id",
            Self::Io(_) => "plugin_io",
            Self::ManifestInvalid(_) => "plugin_manifest_invalid",
            Self::SourceInvalid(_) => "plugin_source_invalid",
            Self::StateConflict(_) => "plugin_state_conflict",
            Self::ResourceInvalid(_) => "plugin_resource_invalid",
            Self::Transaction(_) => "plugin_transaction_failed",
        }
    }
}

fn plugin_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$").unwrap())
}

fn version_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[0-9A-Za-z]+(?:[.+-][0-9A-Za-z]+)*$").unwrap())
}

fn version_range_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:\*|\^?[0-9]+\.[0-9]+\.[0-9]+)$").unwrap())
}

async fn write_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

fn validate_plugin_id(id: &str) -> Result<(), PluginError> {
    plugin_id_regex()
        .is_match(id)
        .then_some(())
        .ok_or_else(|| PluginError::InvalidId(id.into()))
}

fn validate_relative_path(value: &str) -> Result<(), PluginError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || value.contains('\0')
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        Err(PluginError::SourceInvalid(format!(
            "invalid package path: {value}"
        )))
    } else {
        Ok(())
    }
}

fn validate_runtime_id(id: &str) -> Result<(), PluginError> {
    if id.is_empty()
        || id.len() > 240
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
    {
        Err(PluginError::ResourceInvalid(format!(
            "invalid runtime id: {id}"
        )))
    } else {
        Ok(())
    }
}

fn root<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, PluginError> {
    let dirs = app
        .state::<AppState>()
        .data_dirs_cloned()
        .map_err(PluginError::Io)?;
    Ok(crate::paths::plugin_root(&dirs))
}

/// Phase 8 process supervisor path resolution. All returned paths are
/// canonical and confined to the active package or the plugin-owned data /
/// runtime roots. Keeping this beside the package store prevents a second,
/// subtly different traversal policy from growing in the process layer.
pub(crate) fn resolve_executable<R: tauri::Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    package_instance_id: Option<&str>,
    executable_id: &str,
) -> Result<PathBuf, PluginError> {
    validate_plugin_id(plugin_id)?;
    if executable_id.is_empty()
        || executable_id.len() > 128
        || !executable_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(PluginError::ManifestInvalid(format!(
            "invalid executable id: {executable_id}"
        )));
    }
    let store = root(app)?;
    ensure_layout_at(&store)?;
    let state = read_state(&store)?;
    let package_id = match package_instance_id {
        Some(package_id) => {
            let owner = split_package_id(package_id)?;
            if owner != plugin_id {
                return Err(PluginError::ResourceInvalid(format!(
                    "package owner mismatch: {package_id}"
                )));
            }
            package_id
        }
        None => state
            .active_versions
            .get(plugin_id)
            .ok_or_else(|| PluginError::NotFound(format!("active package for {plugin_id}")))?,
    };
    let package_root = packages(&store).join(plugin_id).join(package_id);
    let manifest = read_manifest(&package_root)?;
    let platform = platform_key()?;
    let relative = manifest
        .get("executables")
        .and_then(|value| value.get(executable_id))
        .and_then(|value| value.get(&platform))
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            PluginError::ManifestInvalid(format!(
                "executable {executable_id} has no {platform} target"
            ))
        })?
        .trim_start_matches("./");
    validate_relative_path(relative)?;
    canonical_confined_file(&package_root, relative)
}

pub(crate) fn resolve_plugin_owned_path<R: tauri::Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    runtime_instance_id: &str,
    package_instance_id: Option<&str>,
    namespace: &str,
    relative: &str,
) -> Result<PathBuf, PluginError> {
    validate_plugin_id(plugin_id)?;
    validate_runtime_id(runtime_instance_id)?;
    let relative = if relative.is_empty() { "." } else { relative };
    if relative != "." {
        validate_relative_path(relative)?;
    }
    let store = root(app)?;
    ensure_layout_at(&store)?;
    let base = match namespace {
        "package" => {
            let state = read_state(&store)?;
            let package_id = match package_instance_id {
                Some(package_id) => package_id,
                None => state.active_versions.get(plugin_id).ok_or_else(|| {
                    PluginError::NotFound(format!("active package for {plugin_id}"))
                })?,
            };
            packages(&store).join(plugin_id).join(package_id)
        }
        "data" => data(&store).join(plugin_id),
        "runtime" => runtime(&store).join(runtime_instance_id),
        _ => {
            return Err(PluginError::ResourceInvalid(format!(
                "unknown plugin path namespace: {namespace}"
            )))
        }
    };
    fs::create_dir_all(&base).map_err(|error| PluginError::Io(error.to_string()))?;
    let canonical_base = base
        .canonicalize()
        .map_err(|error| PluginError::Io(error.to_string()))?;
    let candidate = if relative == "." {
        canonical_base.clone()
    } else {
        base.join(relative)
    };
    if !candidate.exists() {
        fs::create_dir_all(&candidate).map_err(|error| PluginError::Io(error.to_string()))?;
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| PluginError::Io(error.to_string()))?;
    if !canonical.starts_with(&canonical_base) || !canonical.is_dir() {
        return Err(PluginError::ResourceInvalid(
            "plugin cwd escaped owner root".into(),
        ));
    }
    Ok(canonical)
}

fn canonical_confined_file(base: &Path, relative: &str) -> Result<PathBuf, PluginError> {
    let canonical_base = base
        .canonicalize()
        .map_err(|_| PluginError::NotFound(base.display().to_string()))?;
    let candidate = base.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| PluginError::NotFound(candidate.display().to_string()))?;
    if !canonical.starts_with(&canonical_base) || !canonical.is_file() {
        return Err(PluginError::ResourceInvalid(
            "executable escaped package root".into(),
        ));
    }
    Ok(canonical)
}

fn platform_key() -> Result<String, PluginError> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "macos",
        value => {
            return Err(PluginError::ManifestInvalid(format!(
                "unsupported executable OS: {value}"
            )))
        }
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        value => {
            return Err(PluginError::ManifestInvalid(format!(
                "unsupported executable architecture: {value}"
            )))
        }
    };
    Ok(format!("{os}-{arch}"))
}

fn packages(root: &Path) -> PathBuf {
    root.join(PACKAGES)
}
fn data(root: &Path) -> PathBuf {
    root.join(DATA)
}
fn runtime(root: &Path) -> PathBuf {
    root.join(RUNTIME)
}
fn transactions(root: &Path) -> PathBuf {
    root.join(TRANSACTIONS)
}
fn state_path(root: &Path) -> PathBuf {
    root.join(STATE)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginStateFile {
    pub schema_version: u32,
    #[serde(default)]
    pub disabled: Vec<String>,
    #[serde(default)]
    pub active_versions: BTreeMap<String, String>,
    #[serde(default)]
    pub package_history: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub skin_bindings: BTreeMap<String, serde_json::Value>,
}

impl Default for PluginStateFile {
    fn default() -> Self {
        Self {
            schema_version: 2,
            disabled: Vec::new(),
            active_versions: BTreeMap::new(),
            package_history: BTreeMap::new(),
            skin_bindings: BTreeMap::new(),
        }
    }
}

fn read_state(root: &Path) -> Result<PluginStateFile, PluginError> {
    let path = state_path(root);
    if !path.exists() {
        return Ok(PluginStateFile::default());
    }
    let value: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|e| PluginError::Io(format!("read {}: {e}", path.display())))?,
    )
    .map_err(|e| PluginError::StateConflict(format!("invalid state.json: {e}")))?;
    let schema = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(1);
    if schema > 2 {
        return Err(PluginError::StateConflict(format!(
            "unsupported schemaVersion: {schema}"
        )));
    }
    let mut state: PluginStateFile = serde_json::from_value(value)
        .map_err(|e| PluginError::StateConflict(format!("invalid state.json: {e}")))?;
    state.schema_version = 2;
    state.disabled.sort();
    state.disabled.dedup();
    Ok(state)
}

fn write_state(root: &Path, state: &PluginStateFile) -> Result<(), PluginError> {
    let mut state = state.clone();
    state.schema_version = 2;
    state.disabled.sort();
    state.disabled.dedup();
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| PluginError::Io(format!("serialize state: {e}")))?;
    crate::agent_config::write_config_atomically(&state_path(root), &json)
        .map_err(|e| PluginError::Io(format!("write state: {e}")))
}

fn sorted_paths(dir: &Path) -> Result<Vec<PathBuf>, PluginError> {
    let mut paths = fs::read_dir(dir)
        .map_err(|e| PluginError::Io(format!("read {}: {e}", dir.display())))?
        .map(|entry| {
            entry
                .map(|e| e.path())
                .map_err(|e| PluginError::Io(e.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    Ok(paths)
}

fn read_manifest(dir: &Path) -> Result<serde_json::Value, PluginError> {
    let path = dir.join(MANIFEST);
    serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|e| PluginError::ManifestInvalid(format!("read {}: {e}", path.display())))?,
    )
    .map_err(|e| PluginError::ManifestInvalid(format!("invalid JSON: {e}")))
}

fn manifest_string<'a>(value: &'a serde_json::Value, field: &str) -> Result<&'a str, PluginError> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| PluginError::ManifestInvalid(format!("missing string {field}")))
}

fn manifest_details(
    dir: &Path,
) -> Result<(serde_json::Value, String, String, String), PluginError> {
    let manifest = read_manifest(dir)?;
    for removed in ["trust", "capabilities", "contributes", "signature", "entry"] {
        if manifest.get(removed).is_some() {
            return Err(PluginError::ManifestInvalid(format!(
                "field {removed} was removed from api 1.0"
            )));
        }
    }
    if manifest.get("schema").and_then(|value| value.as_u64()) != Some(1) {
        return Err(PluginError::ManifestInvalid("schema must be 1".into()));
    }
    if manifest.get("api").and_then(|value| value.as_str()) != Some("1.0") {
        return Err(PluginError::ManifestInvalid("api must be 1.0".into()));
    }
    let id = manifest_string(&manifest, "id")?.to_string();
    validate_plugin_id(&id)?;
    validate_manifest_contract_shape(&manifest, &id)?;
    if manifest_string(&manifest, "name")?.trim().is_empty() {
        return Err(PluginError::ManifestInvalid(
            "name must not be empty".into(),
        ));
    }
    let version = manifest_string(&manifest, "version")?.to_string();
    if !version_regex().is_match(&version) {
        return Err(PluginError::ManifestInvalid(format!(
            "invalid version: {version}"
        )));
    }
    let kind = manifest_string(&manifest, "kind")?;
    if !matches!(
        kind,
        "shell"
            | "workspace"
            | "feature"
            | "hook"
            | "renderer"
            | "skin"
            | "agent-adapter"
            | "tool-provider"
            | "service"
            | "automation"
    ) {
        return Err(PluginError::ManifestInvalid(format!(
            "invalid kind: {kind}"
        )));
    }
    let entry = manifest
        .get("web")
        .and_then(|value| value.get("entry"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| PluginError::ManifestInvalid("missing web.entry".into()))?
        .trim_start_matches("./")
        .to_string();
    validate_relative_path(&entry)?;
    if !dir.join(&entry).is_file() {
        return Err(PluginError::ManifestInvalid(format!(
            "entry does not exist: {entry}"
        )));
    }
    Ok((manifest, id, version, entry))
}

fn validate_manifest_contract_shape(
    manifest: &serde_json::Value,
    plugin_id: &str,
) -> Result<(), PluginError> {
    for field in ["dependencies", "optionalDependencies"] {
        let Some(value) = manifest.get(field) else {
            continue;
        };
        let entries = value
            .as_object()
            .ok_or_else(|| PluginError::ManifestInvalid(format!("{field} must be an object")))?;
        for (dependency_id, range) in entries {
            if !plugin_id_regex().is_match(dependency_id) {
                return Err(PluginError::ManifestInvalid(format!(
                    "{field}.{dependency_id} has an invalid plugin id"
                )));
            }
            let range = range.as_str().ok_or_else(|| {
                PluginError::ManifestInvalid(format!("{field}.{dependency_id} must be a string"))
            })?;
            if !version_range_regex().is_match(range) {
                return Err(PluginError::ManifestInvalid(format!(
                    "{field}.{dependency_id} only supports exact, caret or * ranges"
                )));
            }
        }
    }

    if let Some(value) = manifest.get("conflicts") {
        let conflicts = value
            .as_array()
            .ok_or_else(|| PluginError::ManifestInvalid("conflicts must be an array".into()))?;
        for (index, conflict) in conflicts.iter().enumerate() {
            let conflict = conflict.as_str().ok_or_else(|| {
                PluginError::ManifestInvalid(format!("conflicts.{index} must be a string"))
            })?;
            if !plugin_id_regex().is_match(conflict) || conflict == plugin_id {
                return Err(PluginError::ManifestInvalid(format!(
                    "conflicts.{index} must be a valid non-self plugin id"
                )));
            }
        }
    }

    if let Some(value) = manifest.get("activation") {
        let events = value
            .as_object()
            .and_then(|activation| activation.get("events"))
            .and_then(|events| events.as_array())
            .ok_or_else(|| {
                PluginError::ManifestInvalid("activation.events must be an array".into())
            })?;
        let mut unique = BTreeSet::new();
        if events.is_empty()
            || events.iter().any(|value| match value.as_str() {
                Some(event) if !event.trim().is_empty() => !unique.insert(event),
                _ => true,
            })
        {
            return Err(PluginError::ManifestInvalid(
                "activation.events must contain unique non-empty strings".into(),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginFileMetadata {
    path: String,
    size: u64,
    mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginPackageDescriptor {
    plugin_id: String,
    version: String,
    package_instance_id: String,
    manifest: serde_json::Value,
    files: Vec<PluginFileMetadata>,
    total_bytes: u64,
    active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPluginPackage {
    package: PluginPackageDescriptor,
    enabled: bool,
}

fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn scan(dir: &Path) -> Result<(Vec<PluginFileMetadata>, u64, u64), PluginError> {
    if !dir.is_dir() {
        return Err(PluginError::SourceInvalid(format!(
            "not a directory: {}",
            dir.display()
        )));
    }
    let mut files = Vec::new();
    let mut total = 0_u64;
    let mut fingerprint = 0xcbf29ce484222325_u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for path in sorted_paths(&current)? {
            let meta = fs::symlink_metadata(&path)
                .map_err(|e| PluginError::Io(format!("metadata {}: {e}", path.display())))?;
            if meta.file_type().is_symlink() {
                return Err(PluginError::SourceInvalid(format!(
                    "symlink rejected: {}",
                    path.display()
                )));
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !meta.is_file() {
                return Err(PluginError::SourceInvalid(format!(
                    "non-file rejected: {}",
                    path.display()
                )));
            }
            total = total
                .checked_add(meta.len())
                .ok_or_else(|| PluginError::SourceInvalid("size overflow".into()))?;
            if total > MAX_PACKAGE_BYTES {
                return Err(PluginError::SourceInvalid(format!(
                    "package exceeds {MAX_PACKAGE_BYTES} bytes"
                )));
            }
            let relative = path
                .strip_prefix(dir)
                .map_err(|e| PluginError::Io(e.to_string()))?
                .to_str()
                .ok_or_else(|| PluginError::SourceInvalid("non-UTF-8 path".into()))?
                .replace('\\', "/");
            validate_relative_path(&relative)?;
            hash_bytes(&mut fingerprint, relative.as_bytes());
            let mut input = File::open(&path).map_err(|e| PluginError::Io(e.to_string()))?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = input
                    .read(&mut buffer)
                    .map_err(|e| PluginError::Io(e.to_string()))?;
                if read == 0 {
                    break;
                }
                hash_bytes(&mut fingerprint, &buffer[..read]);
            }
            files.push(PluginFileMetadata {
                path: relative.clone(),
                size: meta.len(),
                mime: mime(Path::new(&relative)).into(),
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((files, total, fingerprint))
}

fn describe_source(dir: &Path) -> Result<PluginPackageDescriptor, PluginError> {
    let (manifest, id, version, _) = manifest_details(dir)?;
    let (files, total_bytes, fingerprint) = scan(dir)?;
    Ok(PluginPackageDescriptor {
        package_instance_id: format!("{id}@{version}-{fingerprint:016x}"),
        plugin_id: id,
        version,
        manifest,
        files,
        total_bytes,
        active: false,
    })
}

fn copy_binary(source: &Path, target: &Path) -> Result<(), PluginError> {
    fs::create_dir_all(target).map_err(|e| PluginError::Io(e.to_string()))?;
    let mut stack = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((from_dir, to_dir)) = stack.pop() {
        for from in sorted_paths(&from_dir)? {
            let meta = fs::symlink_metadata(&from).map_err(|e| PluginError::Io(e.to_string()))?;
            if meta.file_type().is_symlink() {
                return Err(PluginError::SourceInvalid(format!(
                    "symlink rejected: {}",
                    from.display()
                )));
            }
            let to = to_dir.join(
                from.file_name()
                    .ok_or_else(|| PluginError::SourceInvalid("missing filename".into()))?,
            );
            if meta.is_dir() {
                fs::create_dir_all(&to).map_err(|e| PluginError::Io(e.to_string()))?;
                stack.push((from, to));
            } else if meta.is_file() {
                let mut input = File::open(&from).map_err(|e| PluginError::Io(e.to_string()))?;
                let mut output = File::create(&to).map_err(|e| PluginError::Io(e.to_string()))?;
                std::io::copy(&mut input, &mut output)
                    .map_err(|e| PluginError::Io(e.to_string()))?;
                output
                    .sync_all()
                    .map_err(|e| PluginError::Io(e.to_string()))?;
            } else {
                return Err(PluginError::SourceInvalid(format!(
                    "non-file rejected: {}",
                    from.display()
                )));
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    operation_id: String,
    plugin_id: String,
    package_instance_id: String,
    previous_active: Option<String>,
    #[serde(default = "default_created_package")]
    created_package: bool,
}

fn default_created_package() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginPackageOperationResult {
    operation_id: String,
    package: PluginPackageDescriptor,
    previous_active: Option<String>,
}

fn operation_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{}-{nanos}", std::process::id())
}

fn journal_path(root: &Path, id: &str) -> PathBuf {
    transactions(root).join(format!("{id}.json"))
}

fn write_journal(root: &Path, journal: &Journal) -> Result<(), PluginError> {
    let json = serde_json::to_string_pretty(journal)
        .map_err(|e| PluginError::Transaction(e.to_string()))?;
    crate::agent_config::write_config_atomically(&journal_path(root, &journal.operation_id), &json)
        .map_err(|e| PluginError::Transaction(e.to_string()))
}

fn recover(root: &Path) -> Result<(), PluginError> {
    if !transactions(root).is_dir() {
        return Ok(());
    }
    let state = read_state(root)?;
    for path in sorted_paths(&transactions(root))? {
        if path.extension().and_then(|v| v.to_str()) == Some("staging") {
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|e| PluginError::Transaction(e.to_string()))?;
            }
            continue;
        }
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let journal: Journal = serde_json::from_str(
            &fs::read_to_string(&path).map_err(|e| PluginError::Transaction(e.to_string()))?,
        )
        .map_err(|e| PluginError::Transaction(e.to_string()))?;
        if journal.created_package
            && state.active_versions.get(&journal.plugin_id) != Some(&journal.package_instance_id)
        {
            let target = packages(root)
                .join(&journal.plugin_id)
                .join(&journal.package_instance_id);
            if target.exists() {
                fs::remove_dir_all(target).map_err(|e| PluginError::Transaction(e.to_string()))?;
            }
        }
        fs::remove_file(path).map_err(|e| PluginError::Transaction(e.to_string()))?;
    }
    Ok(())
}

fn ensure_layout_at(root: &Path) -> Result<(), PluginError> {
    fs::create_dir_all(root).map_err(|e| PluginError::Io(e.to_string()))?;
    for dir in [
        packages(root),
        data(root),
        runtime(root),
        transactions(root),
    ] {
        fs::create_dir_all(dir).map_err(|e| PluginError::Io(e.to_string()))?;
    }
    if !state_path(root).exists() {
        write_state(root, &PluginStateFile::default())?;
    }
    Ok(())
}

fn ensure_at(root: &Path) -> Result<(), PluginError> {
    ensure_layout_at(root)?;
    recover(root)?;
    Ok(())
}

pub(crate) fn ensure_plugin_dirs(app: &AppHandle) -> Result<(), PluginError> {
    let dirs = app
        .state::<AppState>()
        .data_dirs_cloned()
        .map_err(PluginError::Io)?;
    ensure_at(&crate::paths::plugin_root(&dirs))?;
    // Keep all consumers pinned to the paths module's package/data/runtime/transaction truth.
    for path in [
        crate::paths::plugin_packages_dir(&dirs),
        crate::paths::plugin_data_dir(&dirs),
        crate::paths::plugin_runtime_dir(&dirs),
        crate::paths::plugin_transactions_dir(&dirs),
    ] {
        if !path.is_dir() {
            return Err(PluginError::Io(format!(
                "plugin directory was not created: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn describe_installed(
    root: &Path,
    plugin_id: &str,
    package_id: &str,
    active: bool,
) -> Result<PluginPackageDescriptor, PluginError> {
    let dir = packages(root).join(plugin_id).join(package_id);
    if !dir.is_dir() {
        return Err(PluginError::NotFound(package_id.into()));
    }
    let mut descriptor = describe_source(&dir)?;
    if descriptor.plugin_id != plugin_id {
        return Err(PluginError::ManifestInvalid(
            "directory/manifest id mismatch".into(),
        ));
    }
    descriptor.package_instance_id = package_id.into();
    descriptor.active = active;
    Ok(descriptor)
}

fn install_at(
    root: &Path,
    source: &Path,
    expected_id: &str,
) -> Result<PluginPackageOperationResult, PluginError> {
    let staged = stage_at(root, source, expected_id)?;
    match commit_stage_at(root, &staged.operation_id) {
        Ok(result) => Ok(result),
        Err(error) => {
            let _ = abort_stage_at(root, &staged.operation_id);
            Err(error)
        }
    }
}

fn stage_at(
    root: &Path,
    source: &Path,
    expected_id: &str,
) -> Result<PluginPackageOperationResult, PluginError> {
    let mut descriptor = describe_source(source)?;
    if descriptor.plugin_id != expected_id {
        return Err(PluginError::ManifestInvalid(format!(
            "manifest.id={} != expectedId={expected_id}",
            descriptor.plugin_id
        )));
    }
    let state = read_state(root)?;
    let previous_active = state.active_versions.get(expected_id).cloned();
    let target = packages(root)
        .join(expected_id)
        .join(&descriptor.package_instance_id);
    let created_package = !target.exists();
    if !created_package {
        descriptor = describe_installed(root, expected_id, &descriptor.package_instance_id, false)?;
    }
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| PluginError::Io(e.to_string()))?;
    fs::create_dir_all(data(root).join(expected_id)).map_err(|e| PluginError::Io(e.to_string()))?;
    let op = operation_id("stage");
    let staging = transactions(root).join(format!("{op}.staging"));
    write_journal(
        root,
        &Journal {
            operation_id: op.clone(),
            plugin_id: expected_id.into(),
            package_instance_id: descriptor.package_instance_id.clone(),
            previous_active: previous_active.clone(),
            created_package,
        },
    )?;
    if created_package {
        let result = (|| {
            copy_binary(source, &staging)?;
            if describe_source(&staging)?.package_instance_id != descriptor.package_instance_id {
                return Err(PluginError::Transaction(
                    "source changed during copy".into(),
                ));
            }
            fs::rename(&staging, &target).map_err(|e| PluginError::Transaction(e.to_string()))
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&staging);
            let _ = fs::remove_dir_all(&target);
            let _ = fs::remove_file(journal_path(root, &op));
            return Err(error);
        }
    }
    descriptor.active = previous_active.as_deref() == Some(&descriptor.package_instance_id);
    Ok(PluginPackageOperationResult {
        operation_id: op,
        package: descriptor,
        previous_active,
    })
}

fn read_journal(root: &Path, operation_id: &str) -> Result<Journal, PluginError> {
    let path = journal_path(root, operation_id);
    let source =
        fs::read_to_string(&path).map_err(|_| PluginError::NotFound(operation_id.into()))?;
    serde_json::from_str(&source).map_err(|e| PluginError::Transaction(e.to_string()))
}

fn commit_stage_at(
    root: &Path,
    operation_id: &str,
) -> Result<PluginPackageOperationResult, PluginError> {
    let journal = read_journal(root, operation_id)?;
    let mut state = read_state(root)?;
    if state.active_versions.get(&journal.plugin_id) != journal.previous_active.as_ref() {
        return Err(PluginError::StateConflict(format!(
            "active pointer changed during transaction: {}",
            journal.plugin_id
        )));
    }
    let mut descriptor = describe_installed(
        root,
        &journal.plugin_id,
        &journal.package_instance_id,
        false,
    )?;
    state.active_versions.insert(
        journal.plugin_id.clone(),
        journal.package_instance_id.clone(),
    );
    let history = state
        .package_history
        .entry(journal.plugin_id.clone())
        .or_default();
    history.retain(|id| id != &journal.package_instance_id);
    history.push(journal.package_instance_id.clone());
    write_state(root, &state)?;
    fs::remove_file(journal_path(root, operation_id))
        .map_err(|e| PluginError::Transaction(e.to_string()))?;
    descriptor.active = true;
    Ok(PluginPackageOperationResult {
        operation_id: operation_id.into(),
        package: descriptor,
        previous_active: journal.previous_active,
    })
}

fn abort_stage_at(root: &Path, operation_id: &str) -> Result<(), PluginError> {
    let journal = read_journal(root, operation_id)?;
    let state = read_state(root)?;
    if state.active_versions.get(&journal.plugin_id) == Some(&journal.package_instance_id) {
        return Err(PluginError::StateConflict(format!(
            "cannot abort committed package: {}",
            journal.package_instance_id
        )));
    }
    let staging = transactions(root).join(format!("{operation_id}.staging"));
    if staging.exists() {
        fs::remove_dir_all(staging).map_err(|e| PluginError::Transaction(e.to_string()))?;
    }
    if journal.created_package {
        let target = packages(root)
            .join(&journal.plugin_id)
            .join(&journal.package_instance_id);
        if target.exists() {
            fs::remove_dir_all(target).map_err(|e| PluginError::Transaction(e.to_string()))?;
        }
    }
    fs::remove_file(journal_path(root, operation_id))
        .map_err(|e| PluginError::Transaction(e.to_string()))
}

#[tauri::command]
pub(crate) async fn plugin_package_inspect(
    source_path: String,
) -> Result<PluginPackageDescriptor, PylonError> {
    let source = PathBuf::from(source_path);
    if !source.is_absolute() || !source.is_dir() {
        return Err(PluginError::SourceInvalid(
            "sourcePath must be an existing absolute directory".into(),
        )
        .into());
    }
    Ok(describe_source(&source)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_install(
    app: AppHandle,
    source_path: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    validate_plugin_id(&expected_id)?;
    let source = PathBuf::from(source_path);
    if !source.is_absolute() || !source.is_dir() {
        return Err(PluginError::SourceInvalid(
            "sourcePath must be an existing absolute directory".into(),
        )
        .into());
    }
    let _guard = write_lock().await;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    Ok(install_at(&root, &source, &expected_id)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_update(
    app: AppHandle,
    source_path: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    plugin_package_install(app, source_path, expected_id).await
}

#[tauri::command]
pub(crate) async fn plugin_package_stage(
    app: AppHandle,
    source_path: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    validate_plugin_id(&expected_id)?;
    let source = PathBuf::from(source_path);
    if !source.is_absolute() || !source.is_dir() {
        return Err(PluginError::SourceInvalid(
            "sourcePath must be an existing absolute directory".into(),
        )
        .into());
    }
    let _guard = write_lock().await;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    Ok(stage_at(&root, &source, &expected_id)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_stage_commit(
    app: AppHandle,
    operation_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    let _guard = write_lock().await;
    Ok(commit_stage_at(&root(&app)?, &operation_id)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_stage_abort(
    app: AppHandle,
    operation_id: String,
) -> Result<(), PylonError> {
    let _guard = write_lock().await;
    Ok(abort_stage_at(&root(&app)?, &operation_id)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_versions(
    app: AppHandle,
    plugin_id: String,
) -> Result<Vec<PluginPackageDescriptor>, PylonError> {
    validate_plugin_id(&plugin_id)?;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    let state = read_state(&root)?;
    let dir = packages(&root).join(&plugin_id);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for path in sorted_paths(&dir)? {
        if !path.is_dir() {
            continue;
        }
        let package_id = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| PluginError::SourceInvalid("non-UTF-8 package id".into()))?;
        result.push(describe_installed(
            &root,
            &plugin_id,
            package_id,
            state.active_versions.get(&plugin_id).map(String::as_str) == Some(package_id),
        )?);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn plugin_package_list(
    app: AppHandle,
) -> Result<Vec<InstalledPluginPackage>, PylonError> {
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    Ok(list_installed_at(&root)?)
}

fn list_installed_at(root: &Path) -> Result<Vec<InstalledPluginPackage>, PluginError> {
    let state = read_state(root)?;
    let mut result = Vec::new();
    for (plugin_id, package_instance_id) in &state.active_versions {
        result.push(InstalledPluginPackage {
            package: describe_installed(root, plugin_id, package_instance_id, true)?,
            enabled: !state.disabled.contains(plugin_id),
        });
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn plugin_package_set_enabled(
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<(), PylonError> {
    validate_plugin_id(&plugin_id)?;
    let _guard = write_lock().await;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    set_enabled_at(&root, &plugin_id, enabled)?;
    Ok(())
}

fn set_enabled_at(root: &Path, plugin_id: &str, enabled: bool) -> Result<(), PluginError> {
    validate_plugin_id(plugin_id)?;
    let mut state = read_state(root)?;
    if !state.active_versions.contains_key(plugin_id) {
        return Err(PluginError::NotFound(plugin_id.into()));
    }
    if enabled {
        state.disabled.retain(|id| id != plugin_id);
    } else if !state.disabled.iter().any(|id| id == plugin_id) {
        state.disabled.push(plugin_id.into());
    }
    write_state(root, &state)?;
    Ok(())
}

fn rollback_at(
    root: &Path,
    plugin_id: String,
    package_instance_id: Option<String>,
) -> Result<PluginPackageOperationResult, PluginError> {
    validate_plugin_id(&plugin_id)?;
    let mut state = read_state(root)?;
    let previous_active = state
        .active_versions
        .get(&plugin_id)
        .cloned()
        .ok_or_else(|| PluginError::NotFound(plugin_id.clone()))?;
    let target = package_instance_id.unwrap_or_else(|| {
        state
            .package_history
            .get(&plugin_id)
            .and_then(|history| history.iter().rev().find(|id| *id != &previous_active))
            .cloned()
            .unwrap_or_default()
    });
    if target.is_empty() {
        return Err(PluginError::StateConflict(
            "no previous package to roll back to".into(),
        ));
    }
    let mut descriptor = describe_installed(root, &plugin_id, &target, false)?;
    let op = operation_id("rollback");
    state
        .active_versions
        .insert(plugin_id.clone(), target.clone());
    let history = state.package_history.entry(plugin_id).or_default();
    history.retain(|id| id != &target);
    history.push(target);
    write_state(root, &state)?;
    descriptor.active = true;
    Ok(PluginPackageOperationResult {
        operation_id: op,
        package: descriptor,
        previous_active: Some(previous_active),
    })
}

#[tauri::command]
pub(crate) async fn plugin_package_rollback(
    app: AppHandle,
    plugin_id: String,
    package_instance_id: Option<String>,
) -> Result<PluginPackageOperationResult, PylonError> {
    let _guard = write_lock().await;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    Ok(rollback_at(&root, plugin_id, package_instance_id)?)
}

fn uninstall_at(root: &Path, plugin_id: &str, purge_data: bool) -> Result<(), PluginError> {
    let package_dir = packages(root).join(plugin_id);
    if !package_dir.exists() {
        return Err(PluginError::NotFound(plugin_id.into()));
    }
    fs::remove_dir_all(&package_dir).map_err(|e| PluginError::Io(e.to_string()))?;
    if purge_data {
        let data_dir = data(root).join(plugin_id);
        if data_dir.exists() {
            fs::remove_dir_all(data_dir).map_err(|e| PluginError::Io(e.to_string()))?;
        }
    }
    let mut state = read_state(root)?;
    state.active_versions.remove(plugin_id);
    state.package_history.remove(plugin_id);
    state.disabled.retain(|id| id != plugin_id);
    write_state(root, &state)
}

#[tauri::command]
pub(crate) async fn plugin_package_uninstall(
    app: AppHandle,
    plugin_id: String,
    purge_data: bool,
) -> Result<(), PylonError> {
    validate_plugin_id(&plugin_id)?;
    let _guard = write_lock().await;
    uninstall_at(&root(&app)?, &plugin_id, purge_data)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn plugin_runtime_create(
    app: AppHandle,
    runtime_instance_id: String,
) -> Result<(), PylonError> {
    validate_runtime_id(&runtime_instance_id)?;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    create_runtime_at(&root, &runtime_instance_id)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn plugin_runtime_cleanup(
    app: AppHandle,
    runtime_instance_id: String,
) -> Result<(), PylonError> {
    validate_runtime_id(&runtime_instance_id)?;
    cleanup_runtime_at(&root(&app)?, &runtime_instance_id)?;
    Ok(())
}

fn create_runtime_at(root: &Path, runtime_instance_id: &str) -> Result<(), PluginError> {
    validate_runtime_id(runtime_instance_id)?;
    fs::create_dir(runtime(root).join(runtime_instance_id))
        .map_err(|e| PluginError::Io(e.to_string()))
}

fn cleanup_runtime_at(root: &Path, runtime_instance_id: &str) -> Result<(), PluginError> {
    validate_runtime_id(runtime_instance_id)?;
    let path = runtime(root).join(runtime_instance_id);
    if path.exists() {
        fs::remove_dir_all(path).map_err(|e| PluginError::Io(e.to_string()))?;
    }
    Ok(())
}

fn split_package_id(id: &str) -> Result<&str, PluginError> {
    let (plugin_id, suffix) = id
        .split_once('@')
        .ok_or_else(|| PluginError::ResourceInvalid(format!("invalid package id: {id}")))?;
    validate_plugin_id(plugin_id)?;
    if suffix.is_empty()
        || suffix.contains('/')
        || suffix.contains('\\')
        || suffix.contains("..")
        || suffix.contains('\0')
    {
        return Err(PluginError::ResourceInvalid(format!(
            "invalid package id: {id}"
        )));
    }
    Ok(plugin_id)
}

fn decode_component(value: &str) -> Result<String, PluginError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(PluginError::ResourceInvalid("bad percent encoding".into()));
            }
            let pair = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| PluginError::ResourceInvalid("bad percent encoding".into()))?;
            let byte = u8::from_str_radix(pair, 16)
                .map_err(|_| PluginError::ResourceInvalid("bad percent encoding".into()))?;
            if matches!(byte, b'/' | b'\\' | 0) {
                return Err(PluginError::ResourceInvalid(
                    "encoded separator rejected".into(),
                ));
            }
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| PluginError::ResourceInvalid("non-UTF-8 path".into()))
}

fn resolve_resource(root: &Path, package_id: &str, relative: &str) -> Result<PathBuf, PluginError> {
    let plugin_id = split_package_id(package_id)?;
    let relative = decode_component(relative)?;
    validate_relative_path(&relative).map_err(|e| PluginError::ResourceInvalid(e.to_string()))?;
    let package_root = packages(root).join(plugin_id).join(package_id);
    let canonical_root = package_root
        .canonicalize()
        .map_err(|_| PluginError::NotFound(package_id.into()))?;
    let candidate = package_root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| PluginError::NotFound(candidate.display().to_string()))?;
    if !canonical.starts_with(canonical_root) || !canonical.is_file() {
        return Err(PluginError::ResourceInvalid(
            "resource escaped package root".into(),
        ));
    }
    Ok(canonical)
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn error_response(status: StatusCode, value: impl ToString) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(value.to_string().into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn parse_range(value: &str, length: u64) -> Result<(u64, u64), PluginError> {
    let value = value
        .strip_prefix("bytes=")
        .ok_or_else(|| PluginError::ResourceInvalid("unsupported range unit".into()))?;
    if value.contains(',') || length == 0 {
        return Err(PluginError::ResourceInvalid("unsupported range".into()));
    }
    let (start, end) = value
        .split_once('-')
        .ok_or_else(|| PluginError::ResourceInvalid("invalid range".into()))?;
    let (start, end) = if start.is_empty() {
        let count = end
            .parse::<u64>()
            .map_err(|_| PluginError::ResourceInvalid("invalid range".into()))?
            .min(length);
        (length - count, length - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| PluginError::ResourceInvalid("invalid range".into()))?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| PluginError::ResourceInvalid("invalid range".into()))?
                .min(length - 1)
        };
        (start, end)
    };
    if start >= length || start > end {
        Err(PluginError::ResourceInvalid("range not satisfiable".into()))
    } else {
        Ok((start, end))
    }
}

fn resource_response_at(root: &Path, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');
    let Some((package_id, relative)) = path.split_once('/') else {
        return error_response(StatusCode::BAD_REQUEST, "missing package/path");
    };
    let resource = match resolve_resource(root, package_id, relative) {
        Ok(path) => path,
        Err(PluginError::NotFound(e)) => return error_response(StatusCode::NOT_FOUND, e),
        Err(e) => return error_response(StatusCode::BAD_REQUEST, e),
    };
    let length = match resource.metadata() {
        Ok(v) => v.len(),
        Err(e) => return error_response(StatusCode::NOT_FOUND, e),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| parse_range(v, length));
    let (start, end, status) = match range {
        Some(Ok((start, end))) => (start, end, StatusCode::PARTIAL_CONTENT),
        Some(Err(e)) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(e.to_string().into_bytes())
                .unwrap_or_else(|_| Response::new(Vec::new()))
        }
        None => (0, length.saturating_sub(1), StatusCode::OK),
    };
    let amount = if length == 0 { 0 } else { end - start + 1 };
    let mut file = match File::open(&resource) {
        Ok(v) => v,
        Err(e) => return error_response(StatusCode::NOT_FOUND, e),
    };
    if let Err(e) = file.seek(SeekFrom::Start(start)) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    let mut body = Vec::with_capacity(amount.min(16 * 1024 * 1024) as usize);
    if let Err(e) = file.take(amount).read_to_end(&mut body) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime(&resource))
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub(crate) fn plugin_resource_response(
    app: &AppHandle,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    root(app)
        .map(|root| resource_response_at(&root, request))
        .unwrap_or_else(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[tauri::command]
pub(crate) async fn plugin_package_read_text(
    app: AppHandle,
    package_instance_id: String,
    path: String,
) -> Result<String, PylonError> {
    let resource = resolve_resource(&root(&app)?, &package_instance_id, &path)?;
    let size = resource
        .metadata()
        .map_err(|e| PluginError::Io(e.to_string()))?
        .len();
    if size > MAX_INVOKE_TEXT_BYTES {
        return Err(PluginError::ResourceInvalid(format!(
            "resource is {size} bytes; use resourceUrl/stream"
        ))
        .into());
    }
    fs::read_to_string(resource)
        .map_err(|e| PluginError::ResourceInvalid(format!("not UTF-8: {e}")))
        .map_err(Into::into)
}

fn encode_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'@') {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

#[tauri::command]
pub(crate) async fn plugin_package_resource_url(
    package_instance_id: String,
    path: String,
    runtime_instance_id: Option<String>,
) -> Result<String, PylonError> {
    split_package_id(&package_instance_id)?;
    validate_relative_path(&path)?;
    if let Some(id) = runtime_instance_id.as_deref() {
        validate_runtime_id(id)?;
    }
    let encoded = path
        .split('/')
        .map(encode_component)
        .collect::<Vec<_>>()
        .join("/");
    let mut url = format!("pylon-plugin://localhost/{package_instance_id}/{encoded}");
    if let Some(runtime) = runtime_instance_id {
        url.push_str("?runtime=");
        url.push_str(&encode_component(&runtime));
    }
    Ok(url)
}

// ── P53 D6：zip / URL 安装源（复用既有 stage/commit 事务与回滚）──

/// 本机 zip 安装包大小上限。
pub(crate) const MAX_INSTALL_ZIP_BYTES: u64 = 64 * 1024 * 1024;
/// 解压后的总字节上限（zip bomb 防护）。
pub(crate) const MAX_INSTALL_EXTRACT_BYTES: u64 = 256 * 1024 * 1024;
/// URL 安装重定向上限（每次重定向后仍须 https）。
pub(crate) const INSTALL_MAX_REDIRECTS: usize = 5;
/// URL 下载总超时。
pub(crate) const INSTALL_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// URL 下载连接超时。
pub(crate) const INSTALL_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 进度事件节流粒度。
const INSTALL_PROGRESS_CHUNK: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginInstallProgress {
    pub plugin_id: String,
    pub stage: String,
    pub bytes_total: Option<u64>,
    pub bytes_done: u64,
}

/// 校验安装源 URL：仅 https（fail-closed）。
pub(crate) fn validate_install_url(raw: &str) -> Result<url::Url, PluginError> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| PluginError::SourceInvalid(format!("invalid install url: {raw}")))?;
    if parsed.scheme() != "https" {
        return Err(PluginError::SourceInvalid(format!(
            "install url must use https, got '{}'",
            parsed.scheme()
        )));
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(PluginError::SourceInvalid("install url missing host".into()));
    }
    Ok(parsed)
}

/// URL 重定向决策（纯函数，可单测）：限次且每次重定向后仍须 https。
/// reqwest 在每次 redirect 前把当前 URL push 进 previous，故 hops 实为
/// "已完成跳数 + 1"；`hops > INSTALL_MAX_REDIRECTS` 允许恰好 5 跳。
pub(crate) fn install_redirect_decision(hops: usize, scheme: &str) -> Result<(), &'static str> {
    if hops > INSTALL_MAX_REDIRECTS {
        return Err("too many redirects");
    }
    if scheme != "https" {
        return Err("redirect to non-https url");
    }
    Ok(())
}

/// URL 下载重定向策略：限次且每次重定向后仍须 https。
pub(crate) fn install_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        match install_redirect_decision(attempt.previous().len(), attempt.url().scheme()) {
            Ok(()) => attempt.follow(),
            Err(message) => attempt.error(message),
        }
    })
}

/// 解压插件 zip 到 dest：拒绝 zip-slip（路径穿越/绝对路径）、symlink entry 与
/// 超限（zip 体积 / 解压总量）。返回解压的文件数。
pub(crate) fn extract_zip_archive(
    zip_path: &Path,
    dest: &Path,
    max_zip_bytes: u64,
    max_extract_bytes: u64,
) -> Result<usize, PluginError> {
    let zip_meta = fs::metadata(zip_path)
        .map_err(|e| PluginError::SourceInvalid(format!("zip unreadable: {e}")))?;
    if zip_meta.len() > max_zip_bytes {
        return Err(PluginError::SourceInvalid(format!(
            "zip exceeds size limit: {} > {max_zip_bytes}",
            zip_meta.len()
        )));
    }
    let file = File::open(zip_path).map_err(|e| PluginError::Io(e.to_string()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| PluginError::SourceInvalid(format!("invalid zip: {e}")))?;
    fs::create_dir_all(dest).map_err(|e| PluginError::Io(e.to_string()))?;
    let mut extracted_bytes: u64 = 0;
    let mut extracted_files = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| PluginError::SourceInvalid(format!("invalid zip entry: {e}")))?;
        if entry.is_symlink() {
            return Err(PluginError::SourceInvalid(
                "symlink rejected in plugin zip".into(),
            ));
        }
        let relative = entry.enclosed_name().ok_or_else(|| {
            PluginError::SourceInvalid(format!("unsafe zip entry path: {}", entry.name()))
        })?;
        let target = dest.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| PluginError::Io(e.to_string()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| PluginError::Io(e.to_string()))?;
        }
        // zip bomb 防护（review P0-1）：中央目录的 uncompressed_size 可谎报，
        // 上限必须按 std::io::copy 的实际写入量计费——take(remaining+1) 硬限幅，
        // 超限即拒绝；并校验实际字节数与声明一致（CRC 之外的长度自洽）。
        let remaining = max_extract_bytes.saturating_sub(extracted_bytes);
        let mut limited = (&mut entry).take(remaining.saturating_add(1));
        let mut out = File::create(&target).map_err(|e| PluginError::Io(e.to_string()))?;
        let written = std::io::copy(&mut limited, &mut out)
            .map_err(|e| PluginError::Io(e.to_string()))?;
        if written > remaining {
            return Err(PluginError::SourceInvalid(format!(
                "zip extraction exceeds limit: > {max_extract_bytes}"
            )));
        }
        if written != entry.size() {
            return Err(PluginError::SourceInvalid(
                "zip entry size mismatch (declared uncompressed_size is untrustworthy)".into(),
            ));
        }
        extracted_bytes = extracted_bytes.saturating_add(written);
        extracted_files += 1;
    }
    if extracted_files == 0 {
        return Err(PluginError::SourceInvalid("zip contains no files".into()));
    }
    if !dest.join(MANIFEST).is_file() {
        return Err(PluginError::SourceInvalid(format!(
            "zip missing {MANIFEST} at archive root"
        )));
    }
    Ok(extracted_files)
}

fn unique_install_temp(prefix: &str) -> PathBuf {
    let unique = format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let dir = std::env::temp_dir().join(unique);
    // review P1-1：下载落盘（File::create）要求父目录存在，构造即创建
    fs::create_dir_all(&dir).ok();
    dir
}

fn emit_install_progress(
    app: &AppHandle,
    plugin_id: &str,
    stage: &str,
    bytes_total: Option<u64>,
    bytes_done: u64,
) {
    let _ = app.emit(
        "pylon:plugin-install-progress",
        PluginInstallProgress {
            plugin_id: plugin_id.to_string(),
            stage: stage.to_string(),
            bytes_total,
            bytes_done,
        },
    );
}

/// 下载 zip 到 dest：仅 https、限重定向、总超时/连接超时受限、
/// Content-Length 与流式累计双重大小上限；进度经 Tauri event。
pub(crate) async fn download_install_zip(
    app: &AppHandle,
    raw_url: &str,
    dest: &Path,
    plugin_id: &str,
) -> Result<(), PluginError> {
    let parsed = validate_install_url(raw_url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(INSTALL_CONNECT_TIMEOUT)
        .timeout(INSTALL_DOWNLOAD_TIMEOUT)
        .redirect(install_redirect_policy())
        .build()
        .map_err(|e| PluginError::Io(e.to_string()))?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| PluginError::Io(format!("download failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(PluginError::Io(format!("download failed: HTTP {status}")));
    }
    let bytes_total = response.content_length();
    if let Some(total) = bytes_total {
        if total > MAX_INSTALL_ZIP_BYTES {
            return Err(PluginError::SourceInvalid(format!(
                "download exceeds size limit: {total} > {MAX_INSTALL_ZIP_BYTES}"
            )));
        }
    }
    let mut file = File::create(dest).map_err(|e| PluginError::Io(e.to_string()))?;
    let mut stream = response;
    let mut bytes_done: u64 = 0;
    let mut next_progress = INSTALL_PROGRESS_CHUNK;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| PluginError::Io(format!("download failed: {e}")))?
    {
        bytes_done = bytes_done.saturating_add(chunk.len() as u64);
        if bytes_done > MAX_INSTALL_ZIP_BYTES {
            return Err(PluginError::SourceInvalid(format!(
                "download exceeds size limit: > {MAX_INSTALL_ZIP_BYTES}"
            )));
        }
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| PluginError::Io(e.to_string()))?;
        if bytes_done >= next_progress {
            next_progress += INSTALL_PROGRESS_CHUNK;
            emit_install_progress(app, plugin_id, "downloading", bytes_total, bytes_done);
        }
    }
    file.sync_all().map_err(|e| PluginError::Io(e.to_string()))?;
    emit_install_progress(app, plugin_id, "downloaded", Some(bytes_done), bytes_done);
    Ok(())
}

fn cleanup_install_temp(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

async fn install_from_zip_source(
    app: AppHandle,
    zip_source: InstallZipSource<'_>,
    expected_id: &str,
) -> Result<PluginPackageOperationResult, PylonError> {
    validate_plugin_id(expected_id)?;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    // review P2-3：下载/解压在临时区完成（可达 120s），不持有全局写锁——
    // 锁只覆盖 install_at 事务本体，避免阻塞其它包事务命令。
    let work = unique_install_temp("pylon-plugin-install");
    let extract_dir = work.join("extracted");
    let result = async {
        match zip_source {
            InstallZipSource::LocalZip(zip_path) => {
                let zip_path = PathBuf::from(zip_path);
                if !zip_path.is_absolute() || !zip_path.is_file() {
                    return Err(PluginError::SourceInvalid(
                        "zipPath must be an existing absolute file".into(),
                    )
                    .into());
                }
                emit_install_progress(&app, expected_id, "extracting", None, 0);
                extract_zip_archive(
                    &zip_path,
                    &extract_dir,
                    MAX_INSTALL_ZIP_BYTES,
                    MAX_INSTALL_EXTRACT_BYTES,
                )?;
                Ok(())
            }
            InstallZipSource::Url(url) => {
                let zip_download = work.join("package.zip");
                download_install_zip(&app, url, &zip_download, expected_id).await?;
                emit_install_progress(&app, expected_id, "extracting", None, 0);
                extract_zip_archive(
                    &zip_download,
                    &extract_dir,
                    MAX_INSTALL_ZIP_BYTES,
                    MAX_INSTALL_EXTRACT_BYTES,
                )?;
                Ok(())
            }
        }
    }
    .await;
    if let Err(error) = result {
        cleanup_install_temp(&work);
        return Err(error);
    }
    emit_install_progress(&app, expected_id, "staging", None, 0);
    // 复用既有事务：install_at = stage_at + commit（失败 abort 回滚）
    let _guard = write_lock().await;
    let outcome = install_at(&root, &extract_dir, expected_id);
    cleanup_install_temp(&work);
    // review P2-1：committed 只在成功时发布；失败以命令错误返回
    if outcome.is_ok() {
        emit_install_progress(&app, expected_id, "committed", None, 0);
    }
    Ok(outcome?)
}

enum InstallZipSource<'a> {
    LocalZip(&'a str),
    Url(&'a str),
}

#[tauri::command]
pub(crate) async fn plugin_install_from_zip(
    app: AppHandle,
    zip_path: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    install_from_zip_source(app, InstallZipSource::LocalZip(&zip_path), &expected_id).await
}

#[tauri::command]
pub(crate) async fn plugin_install_from_url(
    app: AppHandle,
    url: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    install_from_zip_source(app, InstallZipSource::Url(&url), &expected_id).await
}

/// 只读：解析 zip 安装包的 descriptor（解压临时区 + describe_source，不落库）。
#[tauri::command]
pub(crate) async fn plugin_package_inspect_zip(
    zip_path: String,
) -> Result<PluginPackageDescriptor, PylonError> {
    let zip_path = PathBuf::from(&zip_path);
    if !zip_path.is_absolute() || !zip_path.is_file() {
        return Err(PluginError::SourceInvalid(
            "zipPath must be an existing absolute file".into(),
        )
        .into());
    }
    let work = unique_install_temp("pylon-plugin-inspect");
    let extract_dir = work.join("extracted");
    let result = async {
        extract_zip_archive(
            &zip_path,
            &extract_dir,
            MAX_INSTALL_ZIP_BYTES,
            MAX_INSTALL_EXTRACT_BYTES,
        )?;
        describe_source(&extract_dir)
    }
    .await;
    cleanup_install_temp(&work);
    Ok(result?)
}

/// 只读：下载 https zip 并解析 descriptor（不落库；限流/超时/重定向同安装）。
#[tauri::command]
pub(crate) async fn plugin_package_inspect_url(
    app: AppHandle,
    url: String,
) -> Result<PluginPackageDescriptor, PylonError> {
    let parsed = validate_install_url(&url)?;
    let work = unique_install_temp("pylon-plugin-inspect");
    let zip_download = work.join("package.zip");
    let extract_dir = work.join("extracted");
    let result = async {
        let plugin_hint = format!("inspect:{}", parsed.host_str().unwrap_or("remote"));
        download_install_zip(&app, &url, &zip_download, &plugin_hint).await?;
        extract_zip_archive(
            &zip_download,
            &extract_dir,
            MAX_INSTALL_ZIP_BYTES,
            MAX_INSTALL_EXTRACT_BYTES,
        )?;
        describe_source(&extract_dir)
    }
    .await;
    cleanup_install_temp(&work);
    Ok(result?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pylon-phase7-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn fixture(dir: &Path, version: &str, bytes: &[u8]) {
        fs::create_dir_all(dir.join("dist")).unwrap();
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(
            dir.join(MANIFEST),
            format!(r#"{{"schema":1,"id":"p.demo","name":"Demo","version":"{version}","api":"1.0","kind":"feature","web":{{"entry":"dist/entry.js"}}}}"#),
        )
        .unwrap();
        fs::write(dir.join("dist/entry.js"), b"export default {};").unwrap();
        fs::write(dir.join("assets/pixel.bin"), bytes).unwrap();
    }

    #[test]
    fn first_list_self_heals_a_missing_plugin_directory() {
        let store = temp("first-list");
        assert!(!store.exists());
        ensure_layout_at(&store).expect("first list must create its layout");
        assert!(list_installed_at(&store)
            .expect("empty first list")
            .is_empty());
        assert!(packages(&store).is_dir());
        assert!(data(&store).is_dir());
        assert!(runtime(&store).is_dir());
        assert!(transactions(&store).is_dir());
        assert!(state_path(&store).is_file());
        fs::remove_dir_all(store).ok();
    }

    #[test]
    fn rejects_path_escape() {
        assert!(validate_plugin_id("p.demo").is_ok());
        assert!(validate_plugin_id("../evil").is_err());
        assert!(validate_relative_path("assets/a.bin").is_ok());
        assert!(validate_relative_path("../evil").is_err());
        assert!(decode_component("..%2Fevil").is_err());
    }

    #[test]
    fn rejects_removed_v01_manifest_fields() {
        let dir = temp("removed-manifest-fields");
        fixture(&dir, "1.0.0", &[]);
        let mut manifest = read_manifest(&dir).unwrap();
        manifest["signature"] = serde_json::json!("legacy-signature");
        fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(matches!(
            manifest_details(&dir),
            Err(PluginError::ManifestInvalid(message)) if message.contains("signature")
        ));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_invalid_dependency_range_in_manifest_shape_validation() {
        let dir = temp("invalid-dependency-range");
        fixture(&dir, "1.0.0", &[]);
        let mut manifest = read_manifest(&dir).unwrap();
        manifest["dependencies"] = serde_json::json!({ "service.clock": ">=1.0.0" });
        fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();

        assert!(matches!(
            manifest_details(&dir),
            Err(PluginError::ManifestInvalid(message))
                if message.contains("dependencies.service.clock")
        ));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn binary_versions_pointer_and_data_retention() {
        let base = temp("install");
        let store = base.join("store");
        let one = base.join("one");
        let two = base.join("two");
        fixture(&one, "1.0.0", &[0, 159, 146, 150, 255]);
        fixture(&two, "2.0.0", &[1, 2, 3]);
        ensure_at(&store).unwrap();
        let v1 = install_at(&store, &one, "p.demo").unwrap();
        fs::write(data(&store).join("p.demo/user.db"), b"keep").unwrap();
        let v2 = install_at(&store, &two, "p.demo").unwrap();
        assert_ne!(
            v1.package.package_instance_id,
            v2.package.package_instance_id
        );
        assert_eq!(
            read_state(&store).unwrap().active_versions.get("p.demo"),
            Some(&v2.package.package_instance_id)
        );
        assert!(packages(&store)
            .join("p.demo")
            .join(&v1.package.package_instance_id)
            .is_dir());
        let rolled_back = rollback_at(&store, "p.demo".into(), None).unwrap();
        assert_eq!(
            rolled_back.package.package_instance_id,
            v1.package.package_instance_id
        );
        assert_eq!(
            read_state(&store).unwrap().active_versions.get("p.demo"),
            Some(&v1.package.package_instance_id)
        );
        uninstall_at(&store, "p.demo", false).unwrap();
        assert!(data(&store).join("p.demo/user.db").is_file());
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn v2_list_and_enablement_share_the_active_package_state() {
        let base = temp("list-enabled");
        let store = base.join("store");
        let source = base.join("source");
        fixture(&source, "1.0.0", &[1]);
        ensure_at(&store).unwrap();
        install_at(&store, &source, "p.demo").unwrap();

        let initial = list_installed_at(&store).unwrap();
        assert_eq!(initial.len(), 1);
        assert!(initial[0].enabled);
        set_enabled_at(&store, "p.demo", false).unwrap();
        assert!(!list_installed_at(&store).unwrap()[0].enabled);
        set_enabled_at(&store, "p.demo", true).unwrap();
        assert!(list_installed_at(&store).unwrap()[0].enabled);
        assert!(set_enabled_at(&store, "missing.plugin", false).is_err());
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn range_resource_and_traversal_guard() {
        let base = temp("resource");
        let store = base.join("store");
        let source = base.join("source");
        fixture(&source, "1.0.0", &[0, 1, 2, 3, 4, 5]);
        ensure_at(&store).unwrap();
        let package = install_at(&store, &source, "p.demo").unwrap().package;
        let request = Request::builder()
            .uri(format!(
                "pylon-plugin://localhost/{}/assets/pixel.bin",
                package.package_instance_id
            ))
            .header(header::RANGE, "bytes=2-4")
            .body(Vec::new())
            .unwrap();
        let response = resource_response_at(&store, request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &[2, 3, 4]);
        let escape = Request::builder()
            .uri(format!(
                "pylon-plugin://localhost/{}/..%2Fstate.json",
                package.package_instance_id
            ))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            resource_response_at(&store, escape).status(),
            StatusCode::BAD_REQUEST
        );
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn interrupted_transaction_recovery_keeps_pointer() {
        let base = temp("recovery");
        let store = base.join("store");
        let source = base.join("source");
        fixture(&source, "1.0.0", &[9]);
        ensure_at(&store).unwrap();
        let active = install_at(&store, &source, "p.demo")
            .unwrap()
            .package
            .package_instance_id;
        let orphan_id = "p.demo@2.0.0-deadbeef";
        let orphan = packages(&store).join("p.demo").join(orphan_id);
        fs::create_dir_all(&orphan).unwrap();
        write_journal(
            &store,
            &Journal {
                operation_id: "interrupted".into(),
                plugin_id: "p.demo".into(),
                package_instance_id: orphan_id.into(),
                previous_active: Some(active.clone()),
                created_package: true,
            },
        )
        .unwrap();
        recover(&store).unwrap();
        assert!(!orphan.exists());
        assert_eq!(
            read_state(&store).unwrap().active_versions.get("p.demo"),
            Some(&active)
        );
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn staged_package_keeps_pointer_until_commit() {
        let base = temp("shadow-stage-commit");
        let store = base.join("store");
        let one = base.join("one");
        let two = base.join("two");
        fixture(&one, "1.0.0", &[1]);
        fixture(&two, "2.0.0", &[2]);
        ensure_at(&store).unwrap();
        let old = install_at(&store, &one, "p.demo").unwrap();

        let staged = stage_at(&store, &two, "p.demo").unwrap();
        assert!(!staged.package.active);
        assert_eq!(
            read_state(&store).unwrap().active_versions.get("p.demo"),
            Some(&old.package.package_instance_id)
        );
        assert!(packages(&store)
            .join("p.demo")
            .join(&staged.package.package_instance_id)
            .is_dir());

        let committed = commit_stage_at(&store, &staged.operation_id).unwrap();
        assert!(committed.package.active);
        assert_eq!(
            read_state(&store).unwrap().active_versions.get("p.demo"),
            Some(&staged.package.package_instance_id)
        );
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn abort_and_recovery_preserve_old_pointer_and_remove_only_new_package() {
        let base = temp("shadow-stage-abort");
        let store = base.join("store");
        let one = base.join("one");
        let two = base.join("two");
        fixture(&one, "1.0.0", &[1]);
        fixture(&two, "2.0.0", &[2]);
        ensure_at(&store).unwrap();
        let old = install_at(&store, &one, "p.demo").unwrap();

        let aborted = stage_at(&store, &two, "p.demo").unwrap();
        let aborted_path = packages(&store)
            .join("p.demo")
            .join(&aborted.package.package_instance_id);
        abort_stage_at(&store, &aborted.operation_id).unwrap();
        assert!(!aborted_path.exists());
        assert_eq!(
            read_state(&store).unwrap().active_versions.get("p.demo"),
            Some(&old.package.package_instance_id)
        );

        let interrupted = stage_at(&store, &two, "p.demo").unwrap();
        let interrupted_path = packages(&store)
            .join("p.demo")
            .join(&interrupted.package.package_instance_id);
        recover(&store).unwrap();
        assert!(!interrupted_path.exists());
        assert_eq!(
            read_state(&store).unwrap().active_versions.get("p.demo"),
            Some(&old.package.package_instance_id)
        );
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn runtime_directory_cleanup_is_scoped_and_idempotent() {
        let root = temp("runtime");
        fs::create_dir_all(runtime(&root)).unwrap();
        create_runtime_at(&root, "p.demo@1.0.0#run-1").unwrap();
        fs::write(
            runtime(&root).join("p.demo@1.0.0#run-1/temp.bin"),
            b"temporary",
        )
        .unwrap();
        cleanup_runtime_at(&root, "p.demo@1.0.0#run-1").unwrap();
        cleanup_runtime_at(&root, "p.demo@1.0.0#run-1").unwrap();
        assert!(!runtime(&root).join("p.demo@1.0.0#run-1").exists());
        assert!(create_runtime_at(&root, "../escape").is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn binary_larger_than_legacy_invoke_limit_installs_on_disk() {
        let base = temp("large-binary");
        let store = base.join("store");
        let source = base.join("source");
        fixture(&source, "1.0.0", &[]);
        let large = source.join("resources/model.bin");
        fs::create_dir_all(large.parent().unwrap()).unwrap();
        File::create(&large)
            .unwrap()
            .set_len(33 * 1024 * 1024)
            .unwrap();
        ensure_at(&store).unwrap();
        let installed = install_at(&store, &source, "p.demo").unwrap();
        let copied = packages(&store)
            .join("p.demo")
            .join(installed.package.package_instance_id)
            .join("resources/model.bin");
        assert_eq!(copied.metadata().unwrap().len(), 33 * 1024 * 1024);
        fs::remove_dir_all(base).ok();
    }

    // ── P53 D6：zip / URL 安装源 ──

    fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = Default::default();
        for (name, bytes) in entries {
            zip.start_file(*name, options).unwrap();
            std::io::Write::write_all(&mut zip, bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn install_zip_rejects_path_traversal_entries() {
        let base = temp("zip-slip");
        let zip_path = base.join("evil.zip");
        let dest = base.join("dest");
        fs::create_dir_all(&base).unwrap();
        write_test_zip(&zip_path, &[("../evil.txt", b"escape")]);
        assert!(matches!(
            extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES),
            Err(PluginError::SourceInvalid(message)) if message.contains("unsafe zip entry")
        ));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn install_zip_rejects_oversized_extraction() {
        let base = temp("zip-oversize");
        let zip_path = base.join("big.zip");
        let dest = base.join("dest");
        fs::create_dir_all(&base).unwrap();
        let payload = vec![0u8; 4096];
        write_test_zip(
            &zip_path,
            &[("pylon-plugin.json", b"{\"schema\":1}"), ("blob.bin", &payload)],
        );
        // 实际写入计费（review P0-1）：take 限幅截断后触发 size mismatch 或超限拒绝，
        // 两条路径都是 fail-closed（不信任中央目录声明值）
        assert!(matches!(
            extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, 1024),
            Err(PluginError::SourceInvalid(message))
                if message.contains("exceeds limit") || message.contains("size mismatch")
        ));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn install_zip_requires_manifest_at_root() {
        let base = temp("zip-manifest");
        let zip_path = base.join("no-manifest.zip");
        let dest = base.join("dest");
        fs::create_dir_all(&base).unwrap();
        write_test_zip(&zip_path, &[("dist/entry.js", b"export default {};")]);
        assert!(matches!(
            extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES),
            Err(PluginError::SourceInvalid(message)) if message.contains("pylon-plugin.json")
        ));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn install_from_zip_rolls_back_store_on_invalid_manifest() {
        let base = temp("zip-rollback");
        let store = base.join("store");
        let zip_path = base.join("broken.zip");
        fs::create_dir_all(&base).unwrap();
        // 合法 zip 结构，但 manifest 缺 id → stage/commit 失败必须回滚
        write_test_zip(
            &zip_path,
            &[
                ("pylon-plugin.json", b"{\"schema\":1,\"name\":\"broken\"}"),
                ("dist/entry.js", b"export default {};"),
            ],
        );
        ensure_layout_at(&store).unwrap();
        let state_before = fs::read_to_string(state_path(&store)).unwrap_or_default();
        let extracted = base.join("extracted");
        extract_zip_archive(&zip_path, &extracted, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES).unwrap();
        assert!(install_at(&store, &extracted, "p.demo").is_err());
        assert_eq!(
            fs::read_to_string(state_path(&store)).unwrap_or_default(),
            state_before
        );
        assert!(packages(&store).join("p.demo").read_dir().map(|mut d| d.next().is_none()).unwrap_or(true));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn install_from_zip_installs_valid_package() {
        let base = temp("zip-happy");
        let store = base.join("store");
        let zip_path = base.join("demo.zip");
        fs::create_dir_all(&base).unwrap();
        write_test_zip(
            &zip_path,
            &[
                ("pylon-plugin.json", b"{\"schema\":1,\"id\":\"p.demo\",\"name\":\"Demo\",\"version\":\"1.0.0\",\"api\":\"1.0\",\"kind\":\"feature\",\"web\":{\"entry\":\"dist/entry.js\"}}"),
                ("dist/entry.js", b"export default {};"),
            ],
        );
        ensure_layout_at(&store).unwrap();
        let extracted = base.join("extracted");
        extract_zip_archive(&zip_path, &extracted, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES).unwrap();
        let installed = install_at(&store, &extracted, "p.demo").unwrap();
        assert_eq!(installed.package.plugin_id, "p.demo");
        let state = read_state(&store).unwrap();
        assert_eq!(
            state.active_versions.get("p.demo").map(String::as_str),
            Some(installed.package.package_instance_id.as_str())
        );
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn install_zip_rejects_symlink_entries() {
        let base = temp("zip-symlink");
        let zip_path = base.join("link.zip");
        let dest = base.join("dest");
        fs::create_dir_all(&base).unwrap();
        let file = File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = Default::default();
        zip.add_symlink("evil-link", "../target", options).unwrap();
        zip.finish().unwrap();
        assert!(matches!(
            extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES),
            Err(PluginError::SourceInvalid(message)) if message.contains("symlink")
        ));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn install_url_validation_rejects_non_https() {
        assert!(validate_install_url("https://example.com/demo.zip").is_ok());
        assert!(validate_install_url("http://example.com/demo.zip").is_err());
        assert!(validate_install_url("ftp://example.com/demo.zip").is_err());
        assert!(validate_install_url("file:///C:/demo.zip").is_err());
        assert!(validate_install_url("not a url").is_err());
    }

    #[test]
    fn install_redirect_decision_rejects_non_https_and_excess_hops() {
        assert!(install_redirect_decision(1, "https").is_ok());
        // hops（previous().len()）= 已完成跳数 + 1：len == MAX 即第 5 跳仍放行，
        // len == MAX+1 即第 6 跳拒绝（实际允许 INSTALL_MAX_REDIRECTS 跳）
        assert!(install_redirect_decision(INSTALL_MAX_REDIRECTS, "https").is_ok());
        assert!(install_redirect_decision(INSTALL_MAX_REDIRECTS + 1, "https")
            .eq(&Err("too many redirects")));
        assert!(install_redirect_decision(0, "http").eq(&Err("redirect to non-https url")));
        assert!(install_redirect_decision(0, "ftp").eq(&Err("redirect to non-https url")));
    }
}
