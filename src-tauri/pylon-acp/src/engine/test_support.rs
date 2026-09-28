//! engine 各子模块测试共用的 fake agent 构造（原 engine.rs 内联 `mod test_support`，
//! 拆分时独立成文件；行为零变化）。
//!
//! #247：fake agent 构造就地自持（原依赖宿主 test_utils——跨 crate 后不可见）。
//! 定位逻辑与宿主 test_utils::fake_agent_bin 保持一致。

use pylon_core::agent_config::AgentDef;
use std::collections::HashMap;

pub fn fake_agent_bin() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("PYLON_FAKE_AGENT_BIN") {
        if !path.trim().is_empty() {
            return std::path::PathBuf::from(path);
        }
    }
    let exe = std::env::current_exe().expect("current_exe must resolve");
    let bin_names: &[&str] = if cfg!(windows) {
        &["pylon-fake-agent.exe"]
    } else {
        &["pylon-fake-agent"]
    };
    for ancestor in exe.ancestors() {
        for name in bin_names {
            let candidate = ancestor.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    panic!(
        "pylon-fake-agent bin not found（先构建：cargo build -p pylon-fake-agent              --features test-agent；或设 PYLON_FAKE_AGENT_BIN 指向已有 bin）"
    )
}

pub fn fake_acp_agent_stub(name: &str) -> AgentDef {
    AgentDef {
        name: name.to_string(),
        provider: None,
        transport: "subprocess".to_string(),
        exe: fake_agent_bin().to_string_lossy().into_owned(),
        args: vec!["--scenario".to_string(), "alive".to_string()],
        cwd: None,
        env: HashMap::new(),
        default: false,
        set_model_api: false,
        model: None,
        hermes_profile: None,
        acp_args: Vec::new(),
        acp: None,
    }
}
