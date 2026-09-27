//! Prompt 域 · Prism 回合钩子 port（#416 W2 wave2 步骤 4，§4.1.3/R2.1-8）。
//! B11.1 发送前置注入与 B11.2 回合持久化经 [`PromptTurnHooks`] 注入，prompt
//! 管线主体（wait.rs/settle.rs）不再点名 PrismClient；宿主装配实现
//! [`PrismTurnHooks`] 把 prism 客户端 + gateway 注入配置 + 运行日志包在一处。
//!
//! async trait 形态（R2.1-8 唯一允许形态）：`persist_round` 是 async HTTP，
//! 现路径 await 至完成才返回命令结果——本 port 取 dyn 兼容的手工装箱 Future
//! 形态（仓库无 async-trait 依赖且本批 Cargo.toml 冻结，RPITIT 在 dyn 分发下
//! 不可用）。**禁止 spawn-off**：两方法必须在调用点 `.await` 至完成，保持
//! 「命令返回晚于 persist 完成」与失败 warn 的现有可观察时序。

use std::future::Future;
use std::pin::Pin;

use super::*;
use crate::prism::PrismClient;
use crate::runtime_log::RuntimeLogHub;

/// B11.1 注入结果：最终出站 prompt 文本 + 激活来源列表（user echo 透传）。
pub(crate) struct InjectedPrompt {
    pub(crate) prompt_text: String,
    pub(crate) activated: Vec<String>,
}

/// Prism 回合钩子 port（宿主装配，`&dyn` 随 [`PromptFlow`] 传递）。
/// 调用纪律：实现禁 spawn-off——调用点必须 await 至完成；HTTP 失败只告警
/// 不阻断（fail-open 语义在实现内承担，与拆分前逐位一致）。
pub(crate) trait PromptTurnHooks: Send + Sync {
    /// B11.1 发送前置注入：输入原始 content（命令判定/请求体用）、persona
    /// 拼接后的 prompt_content（注入前缀的拼接基底）与回合序号；prism/gateway
    /// 判断与 inject 三分支日志都在实现内。输出最终 prompt 文本与激活列表。
    fn before_send<'a>(
        &'a self,
        source: &'a str,
        content: &'a str,
        prompt_content: &'a str,
        message_round: u64,
    ) -> Pin<Box<dyn Future<Output = InjectedPrompt> + Send + 'a>>;

    /// B11.2 回合完成持久化：POST /persist 并记录 ok/失败日志。调用位点在
    /// pet on_done 之后、收尾日志之前（cancelled 臂不调用）。
    fn on_turn_committed<'a>(
        &'a self,
        source: &'a str,
        user_text: &'a str,
        response_text: &'a str,
        message_round: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

/// 宿主装配实现：包 prism 客户端 + gateway 注入配置 + 运行日志 hub。
/// 全部 owned clone（自 AppState 现地装配），不新增全局态。
pub(crate) struct PrismTurnHooks {
    prism: PrismClient,
    gateway: Arc<GatewayCore>,
    runtime_logs: Arc<RuntimeLogHub>,
}

impl PrismTurnHooks {
    pub(crate) fn new(state: &AppState) -> Self {
        Self {
            prism: state.prism.clone(),
            gateway: state.gateway.clone(),
            runtime_logs: state.runtime_logs.clone(),
        }
    }

    /// 与 AppState::log_runtime_summary 同一落点（runtime_logs.push 原样复刻，
    /// session 字段恒为当前 source）。
    fn log(
        &self,
        level: &str,
        source: &str,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        self.runtime_logs.push(
            crate::time::Timestamp::now(),
            level,
            source,
            Some(source.to_string()),
            message,
            fields,
        );
    }
}

impl PromptTurnHooks for PrismTurnHooks {
    fn before_send<'a>(
        &'a self,
        source: &'a str,
        content: &'a str,
        prompt_content: &'a str,
        message_round: u64,
    ) -> Pin<Box<dyn Future<Output = InjectedPrompt> + Send + 'a>> {
        Box::pin(async move {
            // B11.1：gateway 配置开启 + 非命令消息才注入；Prism 不可用/请求失败
            // → 降级为不注入（消息照发，fail-open）。
            if !(self.gateway.inject_enabled() && inject_applies_to(content)) {
                return InjectedPrompt {
                    prompt_text: prompt_content.to_string(),
                    activated: Vec::new(),
                };
            }
            match self
                .prism
                .inject(
                    &self.gateway.inject_scenario().unwrap_or_default(),
                    &self.gateway.inject_sources(),
                    content,
                    message_round,
                )
                .await
            {
                Ok(result) => {
                    if result.activated.is_empty() {
                        self.log(
                            "info",
                            source,
                            "Prism inject returned empty context",
                            serde_json::Map::from_iter([(
                                "contextLength".to_string(),
                                serde_json::Value::from(result.context.len()),
                            )]),
                        );
                    } else {
                        self.log(
                            "info",
                            source,
                            "Prism inject activated",
                            serde_json::Map::from_iter([
                                (
                                    "activatedCount".to_string(),
                                    serde_json::Value::from(result.activated.len()),
                                ),
                                (
                                    "contextLength".to_string(),
                                    serde_json::Value::from(result.context.len()),
                                ),
                            ]),
                        );
                    }
                    InjectedPrompt {
                        prompt_text: compose_inject_prompt(&result.context, prompt_content),
                        activated: result.activated,
                    }
                }
                Err(error) => {
                    tracing::warn!("Prism inject failed: {error}");
                    self.log(
                        "warn",
                        source,
                        "Prism inject failed; sent without injection",
                        serde_json::Map::new(),
                    );
                    InjectedPrompt {
                        prompt_text: prompt_content.to_string(),
                        activated: Vec::new(),
                    }
                }
            }
        })
    }

    fn on_turn_committed<'a>(
        &'a self,
        source: &'a str,
        user_text: &'a str,
        response_text: &'a str,
        message_round: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            match self
                .prism
                .persist_round(
                    &self.gateway.inject_scenario().unwrap_or_default(),
                    &self.gateway.inject_sources(),
                    user_text,
                    response_text,
                    message_round,
                )
                .await
            {
                Ok(value) => {
                    let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                    if !ok {
                        tracing::warn!("Prism persist 返回失败: {value}");
                    }
                    self.log(
                        "info",
                        source,
                        if ok {
                            "Prism round persisted"
                        } else {
                            "Prism persist returned failure"
                        },
                        serde_json::Map::new(),
                    );
                }
                Err(error) => {
                    tracing::warn!("Prism persist failed: {error}");
                    self.log(
                        "warn",
                        source,
                        "Prism persist failed",
                        serde_json::Map::new(),
                    );
                }
            }
        })
    }
}
