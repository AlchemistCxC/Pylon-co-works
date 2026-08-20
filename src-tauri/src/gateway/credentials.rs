//! I12-W3：Gateway 实例凭据存储（AES-256-GCM versioned envelope）。
//!
//! - 凭据以 AES-256-GCM 加密落盘：versioned envelope JSON `{v, platform, instanceId, nonce, ct}`，
//!   AAD 绑定 `pylon|credential|v1|{platform}|{instanceId}`——跨实例/跨平台复用或篡改元数据即解密失败。
//! - 主密钥：随机 32B。Windows 下经 DPAPI（CryptProtectData）绑定当前 Windows 用户后落盘
//!   （OS 级访问保护，等同 ACL 语义），密钥文件与密文分目录存放；非 Windows 为明文受限模式
//!   （本应用以 Windows 为目标平台，见保护函数文档）。
//! - 原子写：临时文件 + flush/sync + rename。
//! - 损坏状态：文件存在但解析/解密失败 → `credential_corrupt`，绝不自动覆盖原文件。
//! - 脱敏：明文 secret 仅以 `Zeroizing` 存在于内存，不进入 Debug/wire；本模块不 Serialize 明文。
//! - 轮换基础：`rotate_master_key` 以新主密钥重加密全部凭据并原子替换密钥文件。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use aes_gcm::aead::consts::U12;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key};
use base64::Engine as _;
use rand::Rng;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const ENVELOPE_VERSION: u32 = 1;
const CREDENTIALS_DIR: &str = "pylon-credentials";
const MASTER_KEY_FILE: &str = "pylon-master.key";
const MASTER_KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// 凭据存储错误。wire code：`credential_corrupt` / `credential_key_unavailable` / `credential_io`。
/// Debug 不含任何凭据明文。
#[derive(Debug, thiserror::Error)]
pub(crate) enum CredentialError {
    #[error("凭据存储 IO 失败: {0}")]
    Io(#[from] io::Error),
    #[error("主密钥不可用: {0}")]
    KeyUnavailable(String),
    #[error("凭据损坏: {0}")]
    Corrupt(String),
    #[error("凭据数据格式错误: {0}")]
    Json(#[from] serde_json::Error),
}

impl CredentialError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "credential_io",
            Self::KeyUnavailable(_) => "credential_key_unavailable",
            Self::Corrupt(_) | Self::Json(_) => "credential_corrupt",
        }
    }
}

/// 磁盘 envelope（versioned；platform/instanceId 参与 AAD，篡改即解密失败）。
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    v: u32,
    platform: String,
    instance_id: String,
    nonce: String, // base64(12B)
    ct: String,    // base64(ciphertext)
}

/// 凭据存储。持有内存主密钥（Drop 时经 Zeroizing 归零）；Debug 脱敏。
///
/// I12 W7（LR2-WI03）双 key 恢复窗口：`staged_key` 是轮换中断时已落盘但尚未生效的
/// 新主密钥（`pylon-master.key.staged`）。轮换顺序为「先完成全部密文替换（rename），
/// 再原子切换 active key」——任一点崩溃都不会让凭据永久不可解密：active key 解密失败的
/// 文件回退试 staged key（get_credentials 双 key fallback）。
pub(crate) struct CredentialStore {
    credentials_dir: PathBuf,
    master_key_path: PathBuf,
    master_key: Zeroizing<[u8; MASTER_KEY_LEN]>,
    /// 轮换中断时保留的 pending 新密钥（存在性即恢复窗口）；None = 无进行中轮换。
    staged_key: Option<Zeroizing<[u8; MASTER_KEY_LEN]>>,
}

impl std::fmt::Debug for CredentialStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialStore")
            .field("credentials_dir", &self.credentials_dir)
            .field("master_key_path", &self.master_key_path)
            .field("master_key", &"[REDACTED]")
            .field("staged_key", &"[REDACTED]")
            .finish()
    }
}

impl CredentialStore {
    /// 打开（或初始化）凭据存储。`app_data` 为应用数据目录；密文在
    /// `<app_data>/pylon-credentials/`，主密钥文件在 `<app_data>/pylon-master.key`（分目录）。
    /// 主密钥缺失时生成新密钥并原子落盘；已存在则加载（损坏 → 报错，不覆盖）。
    pub(crate) fn open(app_data: &Path) -> Result<Self, CredentialError> {
        let credentials_dir = app_data.join(CREDENTIALS_DIR);
        let master_key_path = app_data.join(MASTER_KEY_FILE);
        fs::create_dir_all(&credentials_dir)?;
        let master_key = match load_master_key(&master_key_path)? {
            Some(key) => key,
            None => {
                let key = generate_master_key();
                write_master_key(&master_key_path, &key)?;
                key
            }
        };
        // I12 W7：加载进行中轮换的 staged 新密钥（存在性即双 key 恢复窗口；缺省 None）。
        let staged_key = load_master_key(&staged_key_path(&master_key_path))?;
        Ok(Self {
            credentials_dir,
            master_key_path,
            master_key,
            staged_key,
        })
    }

    /// 写入/更新实例凭据（AES-256-GCM 加密 + 原子写）。
    pub(crate) fn set_credentials(
        &self,
        platform: &str,
        instance_id: &str,
        secret: &str,
    ) -> Result<(), CredentialError> {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.master_key[..]));
        let nonce = random_nonce();
        let ct = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: secret.as_bytes(),
                    aad: aad_for(platform, instance_id).as_bytes(),
                },
            )
            .map_err(|_| CredentialError::Corrupt("加密失败".into()))?;
        let envelope = Envelope {
            v: ENVELOPE_VERSION,
            platform: platform.to_string(),
            instance_id: instance_id.to_string(),
            nonce: b64(nonce.as_slice()),
            ct: b64(&ct),
        };
        atomic_write(
            &self.credential_file(platform, instance_id),
            &serde_json::to_vec_pretty(&envelope)?,
        )
    }

    /// 读取实例凭据明文。文件不存在 → `Ok(None)`（未配置）；损坏/密钥不符 → Err。
    pub(crate) fn get_credentials(
        &self,
        platform: &str,
        instance_id: &str,
    ) -> Result<Option<Zeroizing<String>>, CredentialError> {
        let path = self.credential_file(platform, instance_id);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read(&path)?;
        let envelope: Envelope = serde_json::from_slice(&raw)
            .map_err(|e| CredentialError::Corrupt(format!("凭据文件无法解析: {e}")))?;
        if envelope.v != ENVELOPE_VERSION {
            return Err(CredentialError::Corrupt(format!(
                "不支持的 envelope 版本: {}",
                envelope.v
            )));
        }
        Ok(Some(self.decrypt_envelope(&envelope)?))
    }

    /// 是否存在凭据文件（配置状态探测）。
    pub(crate) fn has_credentials(
        &self,
        platform: &str,
        instance_id: &str,
    ) -> Result<bool, CredentialError> {
        Ok(self.credential_file(platform, instance_id).exists())
    }

    /// 删除实例凭据文件（不存在则无操作）。
    pub(crate) fn remove_credentials(
        &self,
        platform: &str,
        instance_id: &str,
    ) -> Result<(), CredentialError> {
        let path = self.credential_file(platform, instance_id);
        if path.exists() {
            fs::remove_file(&path)?;
        }
        Ok(())
    }

    /// 轮换主密钥（I12 W7 事务化，LR2-WI03）。
    ///
    /// 顺序：阶段 1 双 key 解密全部凭据（任一失败中止，无副作用）→ 阶段 2 新密文写
    /// 临时文件并 fsync → 阶段 3 新密钥 staged 落盘（先于任何密文替换，开启双 key
    /// 恢复窗口）→ 阶段 4 全部临时文件 rename 到正式位置（**密文替换全部完成**）→
    /// 阶段 5 原子切换 active key（staged → 正式）并更新内存。
    ///
    /// 与旧实现（先替换主密钥、后 rename）的关键差异：key switch 必须**最后**发生——
    /// 阶段 4 任一 rename 失败时 active key 仍是旧密钥且 staged 新密钥存在，旧密文文件
    /// 用旧 key、新密文文件用 staged key 均可解密（双 key 恢复窗口），凭据不会永久不可解密；
    /// 成功轮换后 staged 被消费，无残留。失败不自动覆盖 corrupt 文件（ISSUE-12 禁止事项）。
    #[allow(dead_code)] // 密钥轮换为 ISUUE-12 预留入口（当前未接线）
    pub(crate) fn rotate_master_key(&mut self) -> Result<usize, CredentialError> {
        let new_key = generate_master_key();
        let new_cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&new_key[..]));
        // 阶段 1：双 key 解密全部凭据（active → staged 回退；任一失败 → 中止，无副作用）
        let mut reencrypted: Vec<(PathBuf, Vec<u8>)> = Vec::new();
        for entry in fs::read_dir(&self.credentials_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            let raw = fs::read(&path)?;
            let env: Envelope = serde_json::from_slice(&raw)
                .map_err(|e| CredentialError::Corrupt(format!("轮换前解析失败: {e}")))?;
            if env.v != ENVELOPE_VERSION {
                return Err(CredentialError::Corrupt(format!(
                    "轮换前版本非法: {}",
                    env.v
                )));
            }
            let pt = self.decrypt_envelope(&env)?;
            let new_nonce = random_nonce();
            let new_ct = new_cipher
                .encrypt(
                    &new_nonce,
                    Payload {
                        msg: pt.as_bytes(),
                        aad: aad_for(&env.platform, &env.instance_id).as_bytes(),
                    },
                )
                .map_err(|_| CredentialError::Corrupt("轮换重加密失败".into()))?;
            let new_env = Envelope {
                v: ENVELOPE_VERSION,
                platform: env.platform,
                instance_id: env.instance_id,
                nonce: b64(new_nonce.as_slice()),
                ct: b64(&new_ct),
            };
            reencrypted.push((path, serde_json::to_vec_pretty(&new_env)?));
        }
        // 阶段 2：新密文写临时文件并 fsync
        let mut staged_files: Vec<(PathBuf, PathBuf)> = Vec::new();
        for (final_path, bytes) in &reencrypted {
            let tmp = final_path.with_extension("rtmp");
            {
                let mut f = fs::File::create(&tmp)?;
                f.write_all(bytes)?;
                f.sync_all()?;
            }
            staged_files.push((final_path.clone(), tmp));
        }
        // 阶段 3：新密钥 staged 落盘 + 同步内存（先于密文替换——轮换中断时
        // get_credentials 可经 decrypt_envelope 回退 staged 恢复；任一后续失败均保留该窗口）
        let staged_key_path = staged_key_path(&self.master_key_path);
        write_master_key(&staged_key_path, &new_key)?;
        self.staged_key = Some(new_key.clone());
        // 阶段 4：全部临时文件 rename 到正式位置（密文替换全部完成；任一失败 → Err，
        // 但 active key 未切换 + staged 存在 → 双 key 恢复窗口，凭据仍可解密）
        for (final_path, tmp) in &staged_files {
            fs::rename(tmp, final_path)?;
        }
        // 阶段 5：原子切换 active key（staged → 正式）后更新内存；staged 被消费
        fs::rename(&staged_key_path, &self.master_key_path)?;
        self.master_key = new_key;
        self.staged_key = None;
        Ok(reencrypted.len())
    }

    fn credential_file(&self, platform: &str, instance_id: &str) -> PathBuf {
        let digest = fnv1a64(&format!("{platform}\u{1f}{instance_id}"));
        self.credentials_dir
            .join(format!("cred_{digest:016x}.json"))
    }

    /// 双 key 解密（I12 W7）：先用 active key；失败时若存在 staged 新密钥（轮换中断的
    /// 恢复窗口）则回退试 staged。二者都失败 → Corrupt（不自动覆盖任何文件）。
    fn decrypt_envelope(&self, env: &Envelope) -> Result<Zeroizing<String>, CredentialError> {
        let nonce_bytes = decode_b64(&env.nonce, "nonce")?;
        if nonce_bytes.len() != NONCE_LEN {
            return Err(CredentialError::Corrupt(format!(
                "nonce 长度非法: {}",
                nonce_bytes.len()
            )));
        }
        let ct = decode_b64(&env.ct, "ct")?;
        let aad = aad_for(&env.platform, &env.instance_id);
        let nonce = aes_gcm::Nonce::<U12>::from_slice(&nonce_bytes);
        let active = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.master_key[..]));
        let payload = || Payload {
            msg: &ct,
            aad: aad.as_bytes(),
        };
        let pt = match active.decrypt(nonce, payload()) {
            Ok(pt) => pt,
            Err(_) => {
                let Some(staged) = &self.staged_key else {
                    return Err(CredentialError::Corrupt(
                        "解密失败（密钥不符或数据损坏）".into(),
                    ));
                };
                let staged_cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&staged[..]));
                staged_cipher.decrypt(nonce, payload()).map_err(|_| {
                    CredentialError::Corrupt("解密失败（密钥不符或数据损坏）".into())
                })?
            }
        };
        let s =
            String::from_utf8(pt).map_err(|_| CredentialError::Corrupt("凭据非 UTF-8".into()))?;
        Ok(Zeroizing::new(s))
    }
}

/// 轮换 staged 新密钥路径：`<master_key_file>.staged`（I12 W7 双 key 恢复窗口）。
fn staged_key_path(master_key_path: &Path) -> PathBuf {
    master_key_path.with_file_name(format!("{MASTER_KEY_FILE}.staged"))
}

fn aad_for(platform: &str, instance_id: &str) -> String {
    format!("pylon|credential|v{ENVELOPE_VERSION}|{platform}|{instance_id}")
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode_b64(s: &str, what: &str) -> Result<Vec<u8>, CredentialError> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| CredentialError::Corrupt(format!("{what} 非法: {e}")))
}

fn random_nonce() -> aes_gcm::Nonce<U12> {
    let mut buf = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut buf);
    *aes_gcm::Nonce::<U12>::from_slice(&buf)
}

fn generate_master_key() -> Zeroizing<[u8; MASTER_KEY_LEN]> {
    let mut buf = [0u8; MASTER_KEY_LEN];
    rand::rng().fill_bytes(&mut buf);
    Zeroizing::new(buf)
}

fn load_master_key(
    path: &Path,
) -> Result<Option<Zeroizing<[u8; MASTER_KEY_LEN]>>, CredentialError> {
    if !path.exists() {
        return Ok(None);
    }
    let blob = fs::read(path)?;
    let raw = unprotect_master_key(&blob)?;
    if raw.len() != MASTER_KEY_LEN {
        return Err(CredentialError::Corrupt(format!(
            "主密钥长度异常: {}",
            raw.len()
        )));
    }
    let mut bytes = [0u8; MASTER_KEY_LEN];
    bytes.copy_from_slice(&raw);
    Ok(Some(Zeroizing::new(bytes)))
}

fn write_master_key(
    path: &Path,
    key: &Zeroizing<[u8; MASTER_KEY_LEN]>,
) -> Result<(), CredentialError> {
    let protected = protect_master_key(&key[..])?;
    atomic_write(path, &protected)
}

/// 原子写：临时文件 + flush/sync + rename（同目录保证原子性）。
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), CredentialError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// 主密钥落盘保护：Windows 目标用 DPAPI（CryptProtectData）绑定当前用户加密——即使文件被复制，
/// 无当前用户会话上下文无法还原（OS 级访问保护，等同 ACL 语义）。
#[cfg(windows)]
fn protect_master_key(raw: &[u8]) -> Result<Vec<u8>, CredentialError> {
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: raw.len() as u32,
            pbData: raw.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptProtectData(
            &in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 {
            return Err(CredentialError::KeyUnavailable(format!(
                "CryptProtectData 失败: {}",
                io::Error::last_os_error()
            )));
        }
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as HLOCAL);
        Ok(out)
    }
}

#[cfg(windows)]
fn unprotect_master_key(blob: &[u8]) -> Result<Vec<u8>, CredentialError> {
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 {
            return Err(CredentialError::KeyUnavailable(format!(
                "CryptUnprotectData 失败（主密钥不可用）: {}",
                io::Error::last_os_error()
            )));
        }
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData as HLOCAL);
        Ok(out)
    }
}

/// 非 Windows 受限模式：主密钥文件明文（与密文分目录存放）。本应用以 Windows 为目标平台，
/// DPAPI 为真实保护路径；此处仅保证非 Windows 构建可编译，文档标注强度低于 Windows。
#[cfg(not(windows))]
fn protect_master_key(raw: &[u8]) -> Result<Vec<u8>, CredentialError> {
    Ok(raw.to_vec())
}

#[cfg(not(windows))]
fn unprotect_master_key(blob: &[u8]) -> Result<Vec<u8>, CredentialError> {
    Ok(blob.to_vec())
}

/// FNV-1a 64-bit（确定性；仅用于凭据文件名寻址，非安全用途）。
fn fnv1a64(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_app() -> PathBuf {
        // 每个测试独立子目录：cargo 并行执行时避免共享目录互删导致 NotFound
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pylon-cred-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn read_envelope(path: &Path) -> Envelope {
        let raw = fs::read(path).expect("read envelope");
        serde_json::from_slice(&raw).expect("parse envelope")
    }

    #[test]
    fn open_creates_master_key_and_persists_across_reopen() {
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        assert!(
            app.join(MASTER_KEY_FILE).exists(),
            "首次打开必须创建主密钥文件"
        );
        store
            .set_credentials("qq", "inst-1", "secret-1")
            .expect("set");
        // 重开：主密钥复用，凭据可解密
        let reopened = CredentialStore::open(&app).expect("reopen");
        let got = reopened
            .get_credentials("qq", "inst-1")
            .expect("get")
            .expect("value");
        assert_eq!(
            got.as_str(),
            "secret-1",
            "重开后必须能解密同一主密钥加密的凭据"
        );
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn set_get_remove_roundtrip() {
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        assert!(!store.has_credentials("qq", "inst-1").expect("has"));
        assert!(
            store
                .get_credentials("qq", "inst-1")
                .expect("get")
                .is_none(),
            "未配置 → None"
        );
        store
            .set_credentials("qq", "inst-1", "s3cret")
            .expect("set");
        assert!(store.has_credentials("qq", "inst-1").expect("has"));
        assert_eq!(
            store
                .get_credentials("qq", "inst-1")
                .expect("get")
                .expect("value")
                .as_str(),
            "s3cret"
        );
        // 不同实例互不干扰
        assert!(store
            .get_credentials("qq", "inst-2")
            .expect("get")
            .is_none());
        assert!(store
            .get_credentials("qqbot", "inst-1")
            .expect("get")
            .is_none());
        store.remove_credentials("qq", "inst-1").expect("remove");
        assert!(!store.has_credentials("qq", "inst-1").expect("has"));
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn redaction_secret_never_in_debug_or_file() {
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        store
            .set_credentials("qq", "inst-1", "TOP-SECRET-VALUE")
            .expect("set");
        let debug = format!("{store:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("TOP-SECRET-VALUE"), "Debug 不得泄漏 secret");
        // 磁盘文件（密文 + envelope 元数据）不含明文
        let dir_entries = fs::read_dir(app.join(CREDENTIALS_DIR)).expect("read dir");
        for entry in dir_entries {
            let raw = fs::read(entry.expect("entry").path()).expect("read file");
            let text = String::from_utf8_lossy(&raw);
            assert!(
                !text.contains("TOP-SECRET-VALUE"),
                "磁盘文件不得含明文 secret"
            );
        }
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn nonce_is_unique_across_writes() {
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        store
            .set_credentials("qq", "inst-1", "same-secret")
            .expect("set 1");
        let file1 = store.credential_file("qq", "inst-1");
        let env1 = read_envelope(&file1);
        store
            .set_credentials("qq", "inst-1", "same-secret")
            .expect("set 2");
        let env2 = read_envelope(&file1);
        assert_ne!(
            env1.nonce, env2.nonce,
            "每次写入必须使用新 nonce（GCM nonce 复用是灾难）"
        );
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn corrupt_garbage_file_is_detected_and_preserved() {
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        store.set_credentials("qq", "inst-1", "s").expect("set");
        let path = store.credential_file("qq", "inst-1");
        // 覆写垃圾字节模拟损坏
        fs::write(&path, b"{broken-json").expect("corrupt");
        let err = store.get_credentials("qq", "inst-1").expect_err("必须报错");
        assert_eq!(
            err.code(),
            "credential_corrupt",
            "损坏必须映射为 credential_corrupt"
        );
        let after = fs::read(&path).expect("read");
        assert_eq!(after, b"{broken-json", "损坏文件不得被自动覆盖");
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn tampered_envelope_metadata_is_corrupt() {
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        store.set_credentials("qq", "inst-1", "s").expect("set");
        let path = store.credential_file("qq", "inst-1");
        // 篡改 instanceId → AAD 不匹配 → 解密失败
        let mut env = read_envelope(&path);
        env.instance_id = "inst-999".into();
        fs::write(&path, serde_json::to_vec_pretty(&env).expect("json")).expect("write");
        let err = store
            .get_credentials("qq", "inst-1")
            .expect_err("AAD 篡改必须报错");
        assert_eq!(err.code(), "credential_corrupt");
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn tampered_ciphertext_is_corrupt() {
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        store.set_credentials("qq", "inst-1", "s").expect("set");
        let path = store.credential_file("qq", "inst-1");
        let mut env = read_envelope(&path);
        let mut ct = decode_b64(&env.ct, "ct").expect("decode");
        ct[0] ^= 0xff;
        env.ct = b64(&ct);
        fs::write(&path, serde_json::to_vec_pretty(&env).expect("json")).expect("write");
        let err = store
            .get_credentials("qq", "inst-1")
            .expect_err("密文篡改必须报错");
        assert_eq!(err.code(), "credential_corrupt");
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn atomic_write_leaves_no_stray_temp() {
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        store.set_credentials("qq", "inst-1", "s").expect("set");
        let entries: Vec<String> = fs::read_dir(app.join(CREDENTIALS_DIR))
            .expect("dir")
            .map(|e| e.expect("e").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 1, "只应有正式凭据文件，无残留临时文件");
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn corrupt_master_key_is_error_and_not_overwritten() {
        let app = temp_app();
        let _store = CredentialStore::open(&app).expect("open");
        let key_path = app.join(MASTER_KEY_FILE);
        // 写入长度/格式非法的密钥文件模拟损坏
        fs::write(&key_path, b"xx").expect("write bad key");
        let before = fs::read(&key_path).expect("read");
        let err = CredentialStore::open(&app).expect_err("损坏主密钥必须报错");
        assert!(
            matches!(
                err,
                CredentialError::Corrupt(_) | CredentialError::KeyUnavailable(_)
            ),
            "损坏主密钥 → Corrupt 或 KeyUnavailable，code={}",
            err.code()
        );
        let after = fs::read(&key_path).expect("read");
        assert_eq!(before, after, "损坏主密钥文件不得被自动覆盖");
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn rotate_master_key_reencrypts_all_and_new_key_works() {
        let app = temp_app();
        let mut store = CredentialStore::open(&app).expect("open");
        store.set_credentials("qq", "a", "sec-a").expect("set a");
        store.set_credentials("qq", "b", "sec-b").expect("set b");
        store.set_credentials("wx", "c", "sec-c").expect("set c");
        let key_before = fs::read(app.join(MASTER_KEY_FILE)).expect("read key");
        let rotated = store.rotate_master_key().expect("rotate");
        assert_eq!(rotated, 3, "三份凭据全部重加密");
        let key_after = fs::read(app.join(MASTER_KEY_FILE)).expect("read key");
        assert_ne!(key_before, key_after, "主密钥文件必须已替换");
        assert_eq!(
            store
                .get_credentials("qq", "a")
                .expect("get a")
                .expect("v")
                .as_str(),
            "sec-a"
        );
        assert_eq!(
            store
                .get_credentials("qq", "b")
                .expect("get b")
                .expect("v")
                .as_str(),
            "sec-b"
        );
        assert_eq!(
            store
                .get_credentials("wx", "c")
                .expect("get c")
                .expect("v")
                .as_str(),
            "sec-c"
        );
        // 重开后新密钥仍可解密（轮换持久）
        let reopened = CredentialStore::open(&app).expect("reopen");
        assert_eq!(
            reopened
                .get_credentials("qq", "a")
                .expect("get a")
                .expect("v")
                .as_str(),
            "sec-a"
        );
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn interrupted_rotation_recovers_via_staged_key() {
        // I12 W7（LR2-WI03）恢复窗口：确定性构造「全部密文已替换（阶段 4 完成）、
        // active key 未切换（阶段 5 未执行）」的中断状态——等价于轮换在 rename 与
        // key 切换之间崩溃。旧实现（先换 key 后 rename）在该窗口会把全部凭据变成
        // 新密钥不可解密的死数据 → 本测试即 RED 证据。
        let app = temp_app();
        let store = CredentialStore::open(&app).expect("open");
        store.set_credentials("qq", "a", "sec-a").expect("set a");
        store.set_credentials("qq", "b", "sec-b").expect("set b");
        // 1) 新密钥 staged 落盘（阶段 3 产物）
        let new_key = generate_master_key();
        let staged_path = staged_key_path(&app.join(MASTER_KEY_FILE));
        write_master_key(&staged_path, &new_key).expect("write staged");
        // 2) 用新密钥重加密全部凭据并写回正式位置（阶段 4 产物）；active key 仍是旧密钥
        let new_cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&new_key[..]));
        for (platform, id) in [("qq", "a"), ("qq", "b")] {
            let path = store.credential_file(platform, id);
            let raw = fs::read(&path).expect("read");
            let env: Envelope = serde_json::from_slice(&raw).expect("parse");
            let pt = store.decrypt_envelope(&env).expect("decrypt with active");
            let nonce = random_nonce();
            let ct = new_cipher
                .encrypt(
                    &nonce,
                    Payload {
                        msg: pt.as_bytes(),
                        aad: aad_for(platform, id).as_bytes(),
                    },
                )
                .expect("encrypt with new");
            let new_env = Envelope {
                v: ENVELOPE_VERSION,
                platform: platform.into(),
                instance_id: id.into(),
                nonce: b64(nonce.as_slice()),
                ct: b64(&ct),
            };
            fs::write(&path, serde_json::to_vec_pretty(&new_env).expect("json")).expect("write");
        }
        // 3) 重开 store：active key 仍为旧密钥，staged 从磁盘加载
        let mut reopened = CredentialStore::open(&app).expect("reopen");
        assert!(
            reopened.staged_key.is_some(),
            "中断轮换必须加载 staged 新密钥"
        );
        // 4) 双 key 恢复：active（旧）解不了新密文 → 回退 staged（新）解密成功，无永久丢失
        assert_eq!(
            reopened
                .get_credentials("qq", "a")
                .expect("get a")
                .expect("v")
                .as_str(),
            "sec-a"
        );
        assert_eq!(
            reopened
                .get_credentials("qq", "b")
                .expect("get b")
                .expect("v")
                .as_str(),
            "sec-b"
        );
        // 5) 后续轮换正常完成并消费 staged（恢复后存储仍可继续使用）
        reopened.rotate_master_key().expect("rotate again");
        assert!(!staged_path.exists(), "成功轮换后 staged 文件被消费");
        assert_eq!(
            reopened
                .get_credentials("qq", "a")
                .expect("get a")
                .expect("v")
                .as_str(),
            "sec-a"
        );
        assert_eq!(
            reopened
                .get_credentials("qq", "b")
                .expect("get b")
                .expect("v")
                .as_str(),
            "sec-b"
        );
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn successful_rotation_leaves_no_staged_residue() {
        // 成功轮换必须消费 staged（无残留文件，无内存 staged_key）
        let app = temp_app();
        let mut store = CredentialStore::open(&app).expect("open");
        store.set_credentials("qq", "a", "sec-a").expect("set a");
        store.rotate_master_key().expect("rotate");
        let staged_path = staged_key_path(&app.join(MASTER_KEY_FILE));
        assert!(!staged_path.exists(), "成功轮换后 staged 文件必须被消费");
        assert!(
            store.staged_key.is_none(),
            "成功轮换后内存 staged_key 必须清空"
        );
        assert_eq!(
            store
                .get_credentials("qq", "a")
                .expect("get a")
                .expect("v")
                .as_str(),
            "sec-a"
        );
        let _ = fs::remove_dir_all(&app);
    }

    #[test]
    fn master_key_file_does_not_reveal_key_bytes_on_windows() {
        #[cfg(windows)]
        {
            let app = temp_app();
            let store = CredentialStore::open(&app).expect("open");
            let key_blob = fs::read(app.join(MASTER_KEY_FILE)).expect("read");
            let key = store.master_key;
            // DPAPI 密文长度通常大于 32B 且不直接等于明文；至少保证不与明文逐字节相同
            assert_ne!(
                key_blob.as_slice(),
                key.as_slice(),
                "密钥文件不得为明文密钥"
            );
            let _ = fs::remove_dir_all(&app);
        }
    }
}
