//! 共享测试基建（R5c）：fake ACP 子进程 agent 构造。
//!
//! 消除 acp.rs 测试（14 块 AgentDef 字面量）与 lib.rs 集成测试（auto_reconnect /
//! b11 inject / gateway 平台测试）之间的重复构造。仅 cfg(test) 编译。

use crate::agent_config::AgentDef;
use std::collections::HashMap;

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
        exe: "python".to_string(),
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
