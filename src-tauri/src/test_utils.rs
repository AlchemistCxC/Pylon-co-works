//! 共享测试基建（R5c）：fake ACP 子进程 agent 构造。
//!
//! 消除 acp.rs 测试（14 块 AgentDef 字面量）与 lib.rs 集成测试（auto_reconnect /
//! b11 inject / gateway 平台测试）之间的重复构造。仅 cfg(test) 编译。

use crate::agent_config::AgentDef;
use std::collections::HashMap;
use std::sync::OnceLock;

/// 探测结果进程级缓存：`py -3 --version` 探测本身有子进程启动开销，单测多次
/// 构造 agent 时只探测一次（once 惰性求值，无副作用）。
static TEST_PYTHON_EXE: OnceLock<String> = OnceLock::new();

/// 探测测试用 python 解释器：`PYLON_TEST_PYTHON`（显式覆盖，命中即用）→
/// `python` → `py -3` → `python3`（Windows 下 `py -3` 比裸 `python` 更可靠；
/// 链式兜底保证跨平台可用）。全部不可用时回落 `python`（保持原有报错行为，
/// 由子进程启动失败显式暴露）。
pub(crate) fn test_python_exe() -> &'static str {
    TEST_PYTHON_EXE.get_or_init(probe_test_python).as_str()
}

fn probe_test_python() -> String {
    if let Ok(custom) = std::env::var("PYLON_TEST_PYTHON") {
        if !custom.trim().is_empty() {
            return custom;
        }
    }
    ["python", "py -3", "python3"]
        .into_iter()
        .find(|candidate| python_available(candidate))
        .unwrap_or("python")
        .to_string()
}

/// 探测 candidate（`py -3` 形式按空白拆 program + args）能否成功执行 --version。
fn python_available(candidate: &str) -> bool {
    let mut parts = candidate.split_whitespace();
    let Some(program) = parts.next() else {
        return false;
    };
    let mut command = std::process::Command::new(program);
    command.args(parts).arg("--version");
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// 构造 fake ACP 子进程 agent：`python -u -c <script>`，无额外参数与环境。
pub(crate) fn fake_acp_agent(name: &str, script: &str) -> AgentDef {
    fake_acp_agent_with(name, script, Vec::new(), HashMap::new())
}

/// 构造 fake ACP 子进程 agent：`python -u -c <script> [extra_args...]` + 自定义环境。
/// extra_args 通常携带 trace 文件路径（fake 脚本把收到的请求逐行写入，测试回读断言）。
pub(crate) fn fake_acp_agent_with(
    name: &str,
    script: &str,
    extra_args: Vec<String>,
    env: HashMap<String, String>,
) -> AgentDef {
    let mut args = vec!["-u".to_string(), "-c".to_string(), script.to_string()];
    args.extend(extra_args);
    AgentDef {
        name: name.to_string(),
        transport: "subprocess".to_string(),
        exe: test_python_exe().to_string(),
        args,
        cwd: None,
        env,
        default: false,
        set_model_api: false,
        model: None,
        acp_args: Vec::new(),
        acp: None,
    }
}
