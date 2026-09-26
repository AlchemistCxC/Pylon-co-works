//! #363-3：node 版本管理器的 PATH 修复。
//!
//! 问题形态：用户的 node 由 nvm / fnm / volta / mise 等**版本管理器**装在自己的目录
//! 里，那个目录通常只在交互式 shell 的 rc 里被前插 PATH。Pylon 从资源管理器/快捷方式
//! 启动时继承的是**登录会话**的 PATH，看不到它——于是 preflight 报「未检测到该 Agent」，
//! 能给的行动只有「重启 Pylon 即可」（`pylon-core/src/agent_preflight.rs` 的
//! `path_gap_restart_required`）。但重启后 PATH 仍由父进程继承，**根因没除**。
//!
//! 本模块在启动最早期补上这一步：只有当 `node` 不在 PATH 上时才去探测各版本管理器的
//! bin 目录，找到就前插 PATH（进程级、不落盘、不改用户环境）。用户自己配好的 PATH
//! 永远优先——guard 在第一步就返回。
//!
//! 参数与搜索顺序对齐 Codeg `process.rs:219-546`（Apache-2.0，出处见
//! `src-tauri/vendor/acp/ORIGIN.md` §6）。两处**有意的偏离**：
//!
//! 1. **候选目录的计算不做平台 cfg 门**。Codeg 按平台只走对应分支；这里把所有管理器
//!    的候选都按固定顺序枚举，由「该目录下真的有 node 二进制」做唯一筛选。好处是纯
//!    函数在任何平台都可单测（Windows 上也能验证 nvm 的 `default` alias 解析），而
//!    无意义的候选（Windows 上的 `/opt/homebrew/...`）只是一次 stat，自过滤。
//! 2. **不迁 `ensure_user_npm_prefix_in_path`**：Pylon 没有对应的 npm-global 目录。
//!
//! 调用纪律：本函数会改**进程级** `PATH`（`std::env::set_var`，非线程安全）。它必须在
//! 任何**读 PATH** 的工作之前调用一次——具体是 agent 探测/preflight（它们按 PATH 找
//! CLI，跑在 Tauri `setup()` 里），否则修好了也没人用得上。当前唯一调用点是
//! `lib.rs::run()` 的启动首段，位于配置装载与 builder 之前。
//!
//! 注意「在任何多线程工作之前」这句在 Pylon 已经不成立（`main()` 的
//! `init_tracing` 会起一个 `tracing-appender` 的 worker 线程）——但那些线程不读
//! PATH，而 Windows 的环境变量访问由 PEB 锁串行化，所以实际风险只存在于未来把本
//! 调用搬到 reader 之后的情形。真要极致干净，可把它移进 `main()` 的
//! `init_tracing` 之前。

use std::path::{Path, PathBuf};

/// 版本管理器的候选目录，按「先命中先用」的顺序。
///
/// `env` 是环境读取端口（生产传进程环境，测试注入表），`home` 是用户主目录。
/// 返回的候选可能不存在——存在性由 [`find_node_bin_dir`] 逐个验证。
pub fn node_bin_dir_candidates(
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // ── nvm（Unix 形态：`versions/node/<ver>/bin`）────────────────────────
    if let Some(nvm_dir) = resolve_dir(&[("NVM_DIR", &[])], env, home, &[".nvm"]) {
        let versions_dir = nvm_dir.join("versions").join("node");
        // `alias/default` 可能是部分版本（"18"、"20.11"）或符号名（"lts/*"、"node"）。
        // 只有数值前缀能我们自己解析——符号别名需要完整 nvm 解析，不猜。
        let alias_matched = numeric_default_alias(&nvm_dir).and_then(|alias| {
            let matched = version_dirs_matching(&versions_dir, &alias);
            (!matched.is_empty()).then(|| {
                candidates.extend(matched.into_iter().map(|dir| dir.join("bin")));
            })
        });
        if alias_matched.is_none() {
            // 回退：所有已装版本，新者在前。
            for entry in sorted_desc(version_dirs(&versions_dir)) {
                candidates.push(entry.join("bin"));
            }
        }
    }

    // ── nvm-windows（`NVM_SYMLINK` 是活动目录；版本目录里 node.exe 直接躺着）──
    if let Some(symlink) = env("NVM_SYMLINK") {
        let path = PathBuf::from(symlink);
        if path.is_dir() {
            candidates.push(path);
        }
    }
    if let Some(nvm_home) = resolve_dir_without_home(&[("NVM_HOME", &[])], env, "APPDATA", &["nvm"])
    {
        for entry in sorted_desc(version_dirs(&nvm_home)) {
            candidates.push(entry);
        }
    }

    // ── fnm ──────────────────────────────────────────────────────────────
    // `FNM_MULTISHELL_PATH` 只在从 `eval "$(fnm env)"` 起的 shell 里存在。
    if let Some(multishell) = env("FNM_MULTISHELL_PATH") {
        let path = PathBuf::from(multishell);
        if path.is_dir() {
            candidates.push(path);
        }
    }
    let fnm_dir = env("FNM_DIR")
        .map(PathBuf::from)
        .or_else(|| env("APPDATA").map(|dir| PathBuf::from(dir).join("fnm")))
        .or_else(|| home.map(|home| home.join(".fnm")))
        .or_else(|| env("XDG_DATA_HOME").map(|dir| PathBuf::from(dir).join("fnm")))
        .or_else(|| home.map(|home| home.join(".local/share/fnm")));
    if let Some(fnm_dir) = fnm_dir {
        let versions_dir = fnm_dir.join("node-versions");
        for entry in sorted_desc(version_dirs(&versions_dir)) {
            let installation = entry.join("installation");
            let bin = installation.join("bin");
            candidates.push(if bin.is_dir() { bin } else { installation });
        }
    }

    // ── volta ────────────────────────────────────────────────────────────
    // volta 的 `bin/` 里是 **shim**：即使一个 node 版本都没装它们也存在
    // （`volta install node` 之后才有镜像）。只有存在至少一个具体 node 镜像时才把
    // shim 目录加进来——否则下游 `node` 调用拿到的是 volta 的晦涩运行时错误，而不是
    // 干净的「找不到 node」。
    if let Some(volta_home) = resolve_dir(&[("VOLTA_HOME", &[])], env, home, &[".volta"]) {
        let images = volta_home.join("tools").join("image").join("node");
        let has_node_image = images
            .is_dir()
            .then(|| std::fs::read_dir(&images).ok())
            .flatten()
            .is_some_and(|mut entries| entries.next().is_some());
        if has_node_image {
            let bin = volta_home.join("bin");
            if bin.is_dir() {
                candidates.push(bin);
            }
        }
    }

    // ── asdf ─────────────────────────────────────────────────────────────
    if let Some(asdf_dir) = resolve_dir(&[("ASDF_DATA_DIR", &[])], env, home, &[".asdf"]) {
        for entry in sorted_desc(version_dirs(&asdf_dir.join("installs").join("nodejs"))) {
            candidates.push(entry.join("bin"));
        }
    }

    // ── mise / rtx ───────────────────────────────────────────────────────
    let mise_dir = env("MISE_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| env("XDG_DATA_HOME").map(|dir| PathBuf::from(dir).join("mise")))
        .or_else(|| env("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("mise")))
        .or_else(|| home.map(|home| home.join(".local/share/mise")));
    if let Some(mise_dir) = mise_dir {
        for entry in sorted_desc(version_dirs(&mise_dir.join("installs").join("node"))) {
            // Windows 上 mise 的 node 直接躺在版本目录里，Unix 在 bin/。
            let bin = entry.join("bin");
            candidates.push(if bin.is_dir() { bin } else { entry });
        }
    }

    // ── n（`N_PREFIX`；默认前缀是 Unix 绝对路径，故整段平台门控）──────────
    #[cfg(unix)]
    {
        let n_prefix = env("N_PREFIX")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/usr/local"));
        for entry in sorted_desc(version_dirs(
            &n_prefix.join("n").join("versions").join("node"),
        )) {
            candidates.push(entry.join("bin"));
        }
    }

    // ── Homebrew（macOS；Apple Silicon 在前）─────────────────────────────
    // 绝对路径默认值同样平台门控：它们在任何非目标平台上都只是噪声，而门控让
    // Windows 上的单测保持封闭（不会被宿主真实装的 node 干扰）。
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/opt/node/bin"));
        candidates.push(PathBuf::from("/usr/local/opt/node/bin"));
    }

    // ── Scoop（Windows；LTS 在前）───────────────────────────────────────
    if let Some(scoop) = env("SCOOP")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join("scoop")))
    {
        candidates.push(scoop.join("apps").join("nodejs-lts").join("current"));
        candidates.push(scoop.join("apps").join("nodejs").join("current"));
    }

    candidates
}

/// 第一个真正含 node 二进制的候选目录。
pub fn find_node_bin_dir(
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    node_bin_dir_candidates(env, home)
        .into_iter()
        .find(|dir| has_node_binary(dir))
}

/// `node` 已经在 PATH 上可解析吗？
///
/// 不走 `which` crate：本仓没有该依赖，而判定本身就是「按 PATH 逐目录找带平台后缀的
/// 可执行文件」，十几行可测逻辑，不值得为此新增依赖。
pub fn node_on_path(env: &dyn Fn(&str) -> Option<String>) -> bool {
    let Some(path) = env("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| has_node_binary(&dir))
}

/// 启动期入口：node 不在 PATH 时探测版本管理器并把 bin 目录前插 PATH。
///
/// **只在缺 node 时动手**——用户自己配好的 PATH 一律不动。找到与否都记一条 info：
/// 「没找到」本身也是诊断信息（说明用户得自己处理）。
pub fn ensure_node_in_path() {
    let env = |key: &str| std::env::var(key).ok();
    if node_on_path(&env) {
        return;
    }
    let home = home_dir();
    let Some(bin_dir) = find_node_bin_dir(&env, home.as_deref()) else {
        tracing::info!(
            "[PATH] node 不在 PATH 上，且未在任何已知版本管理器目录中找到 node；保持 PATH 不变"
        );
        return;
    };
    prepend_to_path(&bin_dir);
    tracing::info!("[PATH] node 不在 PATH 上，已前插 {}", bin_dir.display());
}

/// 用户主目录。Windows 走 `USERPROFILE`（回退 `HOMEDRIVE`+`HOMEPATH`），其余走 `HOME`。
fn home_dir() -> Option<PathBuf> {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return Some(PathBuf::from(profile));
    }
    if let (Some(drive), Some(path)) = (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
    {
        let mut joined = PathBuf::from(drive);
        joined.push(path);
        return Some(joined);
    }
    std::env::var_os("HOME").map(PathBuf::from)
}

/// 把目录前插进进程 PATH（`std::env::set_var` 是进程级副作用，见模块头调用纪律）。
fn prepend_to_path(dir: &Path) {
    let separator = if cfg!(windows) { ";" } else { ":" };
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut updated = std::ffi::OsString::from(dir);
    updated.push(separator);
    updated.push(current);
    std::env::set_var("PATH", updated);
}

/// 目录下有平台对应的 node 可执行文件吗？
fn has_node_binary(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    if cfg!(windows) {
        // npm 装的 node 在各管理器下都是 `node.exe`。
        return dir.join("node.exe").is_file();
    }
    dir.join("node").is_file()
}

/// 读取 `alias/default`，只在它是**数值前缀**时返回（剥掉可选的 `v`）。
///
/// 符号别名（`lts/*`、`node`）需要完整的 nvm 解析（含远端 lts 表），本模块不猜——
/// 返回 `None` 让调用方回退到「所有版本里取最新」。
fn numeric_default_alias(nvm_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(nvm_dir.join("alias").join("default")).ok()?;
    let alias = raw.trim();
    let stripped = alias.strip_prefix('v').unwrap_or(alias);
    stripped
        .starts_with(|character: char| character.is_ascii_digit())
        .then(|| stripped.to_string())
}

/// `<versions_dir>` 下所有子目录。
fn version_dirs(versions_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(versions_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect()
}

/// 版本目录名以 `alias` 为数值前缀的那些（`alias` 已剥 `v`）。
fn version_dirs_matching(versions_dir: &Path, alias: &str) -> Vec<PathBuf> {
    let mut matched: Vec<PathBuf> = version_dirs(versions_dir)
        .into_iter()
        .filter(|path| {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let stripped = name.strip_prefix('v').unwrap_or(&name).to_string();
            stripped.starts_with(alias)
        })
        .collect();
    matched.sort_by_key(|path| semver_key(path));
    matched.reverse();
    matched
}

/// 按 semver 数值降序（新者在前）。不可解析的名字回退 `(0,0,0)`，排到最后。
fn sorted_desc(mut entries: Vec<PathBuf>) -> Vec<PathBuf> {
    entries.sort_by_key(|path| semver_key(path));
    entries.reverse();
    entries
}

/// 从目录名取 `(major, minor, patch)`。字符串排序会把 `v9` 排到 `v10` 之后，
/// 所以必须是数值比较。
fn semver_key(path: &Path) -> (u32, u32, u32) {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let stripped = name.strip_prefix('v').unwrap_or(&name);
    let mut parts = stripped
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// `env_chain` 里第一个设了的键 → 依次拼接 suffixes；都没有则用 `home` 相对默认值。
fn resolve_dir(
    env_chain: &[(&str, &[&str])],
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>,
    home_relative: &[&str],
) -> Option<PathBuf> {
    for (key, suffixes) in env_chain {
        if let Some(value) = env(key) {
            return Some(
                suffixes
                    .iter()
                    .fold(PathBuf::from(value), |path, next| path.join(next)),
            );
        }
    }
    home.map(|home| {
        home_relative
            .iter()
            .fold(home.to_path_buf(), |path, next| path.join(next))
    })
}

/// `env_chain` 命中则用之；否则用 `env(base_key)/base_relative`（NVM_HOME 的
/// `%APPDATA%\nvm` 形态）——**没有** home 回退，与上游一致。
fn resolve_dir_without_home(
    env_chain: &[(&str, &[&str])],
    env: &dyn Fn(&str) -> Option<String>,
    base_key: &str,
    base_relative: &[&str],
) -> Option<PathBuf> {
    for (key, suffixes) in env_chain {
        if let Some(value) = env(key) {
            return Some(
                suffixes
                    .iter()
                    .fold(PathBuf::from(value), |path, next| path.join(next)),
            );
        }
    }
    env(base_key).map(|base| {
        base_relative
            .iter()
            .fold(PathBuf::from(base), |path, next| path.join(next))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的环境表：把版本管理器相关的键从宿主环境里隔离出来。
    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |key: &str| {
            owned
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "pylon-node-path-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).expect("mkdir");
        root
    }

    /// 造一个假的 node 二进制文件（内容无关紧要，判定只看存在性）。
    fn plant_node(dir: &Path) {
        std::fs::create_dir_all(dir).expect("mkdir");
        std::fs::write(
            dir.join(if cfg!(windows) { "node.exe" } else { "node" }),
            b"",
        )
        .expect("plant");
    }

    #[test]
    fn node_on_path_is_false_when_no_entry_holds_the_binary() {
        let root = temp_root("on-path-miss");
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).expect("mkdir");
        let env = env_from(&[("PATH", &empty.to_string_lossy())]);
        assert!(!node_on_path(&env));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn node_on_path_detects_the_binary_in_any_entry() {
        let root = temp_root("on-path-hit");
        let bindir = root.join("bin");
        plant_node(&bindir);
        let joined = format!(
            "{}{}{}",
            root.join("nope").display(),
            if cfg!(windows) { ";" } else { ":" },
            bindir.display()
        );
        let env = env_from(&[("PATH", &joined)]);
        assert!(node_on_path(&env));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nvm_default_alias_numeric_prefix_selects_the_newest_match() {
        let root = temp_root("nvm-alias");
        let nvm = root.join(".nvm");
        let versions = nvm.join("versions").join("node");
        for version in ["v18.0.0", "v18.20.4", "v20.11.1"] {
            plant_node(&versions.join(version).join("bin"));
        }
        std::fs::create_dir_all(nvm.join("alias")).expect("mkdir");
        std::fs::write(nvm.join("alias").join("default"), "18").expect("write alias");

        let env = env_from(&[("NVM_DIR", &nvm.to_string_lossy())]);
        let found = find_node_bin_dir(&env, None).expect("必须命中 alias 匹配的版本");
        assert_eq!(found, versions.join("v18.20.4").join("bin"), "同前缀取最新");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nvm_symbolic_alias_falls_back_to_the_newest_installed_version() {
        let root = temp_root("nvm-symbolic");
        let nvm = root.join(".nvm");
        let versions = nvm.join("versions").join("node");
        for version in ["v18.20.4", "v20.11.1", "v9.11.2"] {
            plant_node(&versions.join(version).join("bin"));
        }
        std::fs::create_dir_all(nvm.join("alias")).expect("mkdir");
        // 符号别名需要完整 nvm 解析，本模块不猜 → 回退「最新」
        std::fs::write(nvm.join("alias").join("default"), "lts/*").expect("write alias");

        let env = env_from(&[("NVM_DIR", &nvm.to_string_lossy())]);
        let found = find_node_bin_dir(&env, None).expect("必须回退到最新版本");
        assert_eq!(found, versions.join("v20.11.1").join("bin"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn semver_sorting_is_numeric_not_lexicographic() {
        let root = temp_root("semver");
        std::fs::create_dir_all(&root).expect("mkdir");
        let names = ["v9.11.2", "v10.0.0", "v10.2.1", "not-a-version"];
        let paths: Vec<PathBuf> = names.iter().map(|name| root.join(name)).collect();
        let sorted = sorted_desc(paths);
        let rendered: Vec<String> = sorted
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        // 字符串排序会把 v9 放到 v10 之后；数值排序不会。
        assert_eq!(
            rendered,
            vec!["v10.2.1", "v10.0.0", "v9.11.2", "not-a-version"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// volta 只有 shim、没有任何 node 镜像时必须**不**前插——否则下游拿到的是
    /// volta 的晦涩错误，而不是干净的「找不到 node」。
    #[test]
    fn volta_shim_without_a_node_image_is_withheld() {
        let root = temp_root("volta-shim-only");
        let volta = root.join(".volta");
        plant_node(&volta.join("bin"));
        std::fs::create_dir_all(volta.join("tools").join("image").join("node")).expect("mkdir");

        let env = env_from(&[("VOLTA_HOME", &volta.to_string_lossy())]);
        let found = find_node_bin_dir(&env, None);
        assert!(
            found.is_none(),
            "只有 shim 没有镜像时不得把 {} 当可用 node",
            volta.join("bin").display()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn volta_shim_is_used_once_a_node_image_exists() {
        let root = temp_root("volta-with-image");
        let volta = root.join(".volta");
        plant_node(&volta.join("bin"));
        std::fs::create_dir_all(
            volta
                .join("tools")
                .join("image")
                .join("node")
                .join("20.11.1"),
        )
        .expect("mkdir");

        let env = env_from(&[("VOLTA_HOME", &volta.to_string_lossy())]);
        let found = find_node_bin_dir(&env, None).expect("有镜像时必须命中 shim 目录");
        assert_eq!(found, volta.join("bin"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// nvm-windows 的活动目录来自 `NVM_SYMLINK`，版本目录里 node 直接躺着（无 bin/）。
    #[test]
    fn nvm_windows_symlink_and_version_dirs_are_probed() {
        let root = temp_root("nvm-windows");
        let symlink = root.join("nodejs");
        plant_node(&symlink);
        let env = env_from(&[
            ("NVM_SYMLINK", &symlink.to_string_lossy()),
            ("NVM_HOME", &root.join("nvm").to_string_lossy()),
        ]);
        assert_eq!(
            find_node_bin_dir(&env, None).as_deref(),
            Some(symlink.as_path())
        );

        // 没有 symlink 时退到 NVM_HOME 下的版本目录（取最新）
        let nvm_home = root.join("nvm");
        plant_node(&nvm_home.join("v18.20.4"));
        plant_node(&nvm_home.join("v20.11.1"));
        let env = env_from(&[("NVM_HOME", &nvm_home.to_string_lossy())]);
        assert_eq!(
            find_node_bin_dir(&env, None).as_deref(),
            Some(nvm_home.join("v20.11.1").as_path())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `NVM_HOME` 缺失时回退 `%APPDATA%\nvm`（Windows 上最省事的默认位置）。
    #[test]
    fn nvm_windows_falls_back_to_appdata_relative_home() {
        let root = temp_root("nvm-appdata");
        let appdata = root.join("AppData");
        plant_node(&appdata.join("nvm").join("v22.1.0"));
        let env = env_from(&[("APPDATA", &appdata.to_string_lossy())]);
        assert_eq!(
            find_node_bin_dir(&env, None).as_deref(),
            Some(appdata.join("nvm").join("v22.1.0").as_path())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fnm_multishell_path_wins_over_the_versions_layout() {
        let root = temp_root("fnm-multishell");
        let multishell = root.join("fnm_multishell");
        plant_node(&multishell);
        let env = env_from(&[("FNM_MULTISHELL_PATH", &multishell.to_string_lossy())]);
        assert_eq!(
            find_node_bin_dir(&env, None).as_deref(),
            Some(multishell.as_path())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fnm_versions_use_the_installation_bin_directory() {
        let root = temp_root("fnm-versions");
        let fnm = root.join("fnm");
        let versions = fnm.join("node-versions");
        plant_node(&versions.join("v20.0.0").join("installation").join("bin"));
        plant_node(&versions.join("v21.0.0").join("installation").join("bin"));
        let env = env_from(&[("FNM_DIR", &fnm.to_string_lossy())]);
        assert_eq!(
            find_node_bin_dir(&env, None).as_deref(),
            Some(
                versions
                    .join("v21.0.0")
                    .join("installation")
                    .join("bin")
                    .as_path()
            )
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn asdf_and_mise_layouts_are_probed() {
        let root = temp_root("other-managers");

        let asdf = root.join("asdf");
        plant_node(
            &asdf
                .join("installs")
                .join("nodejs")
                .join("20.11.1")
                .join("bin"),
        );
        let env = env_from(&[("ASDF_DATA_DIR", &asdf.to_string_lossy())]);
        assert!(find_node_bin_dir(&env, None).is_some(), "asdf 布局");

        let mise = root.join("mise");
        plant_node(
            &mise
                .join("installs")
                .join("node")
                .join("22.0.0")
                .join("bin"),
        );
        let env = env_from(&[("MISE_DATA_DIR", &mise.to_string_lossy())]);
        assert!(find_node_bin_dir(&env, None).is_some(), "mise 布局");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// `n` 的布局 `<prefix>/n/versions/node/<ver>/bin`。默认前缀 `/usr/local` 是 Unix
    /// 绝对路径，所以探测段与这条用例都只在 Unix 上成立。
    #[cfg(unix)]
    #[test]
    fn n_prefix_layout_is_probed() {
        let root = temp_root("n-layout");
        let prefix = root.join("nprefix");
        plant_node(
            &prefix
                .join("n")
                .join("versions")
                .join("node")
                .join("18.0.0")
                .join("bin"),
        );
        let env = env_from(&[("N_PREFIX", &prefix.to_string_lossy())]);
        assert!(find_node_bin_dir(&env, None).is_some(), "n 布局");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scoop_current_directories_are_probed_from_the_env_root() {
        let root = temp_root("scoop");
        let scoop = root.join("scoop");
        plant_node(&scoop.join("apps").join("nodejs").join("current"));
        let env = env_from(&[("SCOOP", &scoop.to_string_lossy())]);
        assert_eq!(
            find_node_bin_dir(&env, None).as_deref(),
            Some(scoop.join("apps").join("nodejs").join("current").as_path())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// home 相对回退：没有任何 env 时用 `~/.nvm`。
    #[test]
    fn home_relative_defaults_are_used_when_no_env_is_set() {
        let root = temp_root("home-relative");
        let home = root.join("home");
        plant_node(
            &home
                .join(".nvm")
                .join("versions")
                .join("node")
                .join("20.11.1")
                .join("bin"),
        );
        let env = env_from(&[]);
        assert_eq!(
            find_node_bin_dir(&env, Some(&home)).as_deref(),
            Some(
                home.join(".nvm")
                    .join("versions")
                    .join("node")
                    .join("20.11.1")
                    .join("bin")
                    .as_path()
            )
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 什么都没装时必须返回 `None`（fast path 之外不得凭空造出候选）。
    ///
    /// 只在 Windows 上封闭：Unix 侧候选表里有 `/usr/local`、Homebrew 这类绝对路径
    /// 默认值，宿主真装了 node 就会命中，这个断言在那里不成立。
    #[cfg(windows)]
    #[test]
    fn nothing_installed_yields_no_candidate_match() {
        let root = temp_root("nothing");
        let env = env_from(&[("NVM_DIR", &root.join("nope").to_string_lossy())]);
        assert!(find_node_bin_dir(&env, Some(&root.join("home"))).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
