# ADR-0004 模型选择器切换收敛与兼容发送规则

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0004-model-selector-convergence.md`

- **日期**：2026-09-15
- **状态**：已采用
- **issue**：[#97 通用 ACP 模型选择器与切换闭环](https://github.com/AlchemistCxC/Pylon-co-works/issues/97)

## 背景与约束

Pylon 是通用 ACP 客户端：模型切换面由各 Agent 自行宣告，通道有二——ACP 标准
`session/set_config_option`（configOptions 中 category=="model" 的选项，广告 id 可为
任意字符串，例如 `model-selection`）与 Agent 声明的 `session/set_model` 扩展。实现
#97 时遗留一个未决问题（issue 正文「未决问题」第 2 条）：

> 对「显式 ConfigOption 无 config id 但 key 不是 `model`」是否允许兼容发送，需要在
> ADR 中明确；默认建议拒绝并提示 Agent 广告不完整。

约束：

1. Pylon 不得写死任何 provider（禁止按 Agent 名称特判通道或 config id）。
2. 仓库一贯的「现状行为，兼容优先」原则（P56/D1、G2-03 等先例均如此裁决）。
3. 禁区 §4：不猜——广告缺失时的行为必须显式裁决，不得静默猜测。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| A. 广告缺失一律拒绝发送（fail-closed） | 会破坏「Agent 接受 set_config_option("model", …) 但未宣告 configOptions 模型条目」的现有可用会话（set_model_api=ConfigOption 声明的官方路径依赖语义键直发）；与「兼容优先」原则冲突 |
| B. 一律乐观发送且无诊断 | 保留现状但不可观测：广告缺失被静默吞掉，客户端无从发现 Agent 广告不完整 |
| C. 显式兼容规则 + 稳定 code 诊断 + 权威收敛兜底 | 兼顾可用性与可观测性：能发的照发，发过之后以 Agent 回显为权威（钳制/确认/待定三态收敛），诊断留痕 |

## 决定

采用方案 C，具体规则：

1. **model 键 + ConfigOption 通道 + 会话宣告了真实 config id**：必须原样发送广告 id
   （`model-selection` 等），禁止降级成语义键 `model`（`resolve_model_switch_target` 返回
   宣告 id，控制层不得覆盖）。
2. **model 键 + ConfigOption 通道 + 未宣告 config id**：允许兼容发送语义键
   `model`（现状行为），但必须发出 `code=model_config_id_missing` 的 warn 诊断。
3. **非 model 语义键（mode/reasoning 等）**：语义键即 config id，按现状直发；
   若会话为该语义选项宣告了非空 choices，则发送前校验目标值 ∈ choices（code=
   `reasoning_not_advertised`），choices 为空（未宣告）时放行。模型切换刷新宣告后，
   失效的依赖 option 值据此在发送前被拒。
4. **收敛契约**：任何切换响应，非空且可解析的 adopted 列表 / models.current 是权威
   （requested ≠ 实际值即钳制收敛，`model_switch_clamped` 诊断）；空回声保留本地
   catalog 并把 requested 标记为可辨识的未确认（pending）态，后续权威回显或
   `session_info_update` 覆盖。

## 后果

- 正面：现有可用 Agent 不因广告缺失而被硬断；广告不完整可从诊断日志发现；
  requested/confirmed 语义可判定，杜绝乐观值永久滞留。
- 负面：广告缺失时发出语义键的请求可能被 Agent 静默忽略（与现状一致，但现在有
  诊断可查）。
- 风险：若未来 ACP 官方化规定「未宣告即必须拒绝」，本 ADR 需重新裁决；届时方案 A
  的开关应加为显式协议配置而非硬编码。

## 证据

- 路由与宣告 id 保留：`src-tauri/src/session/model.rs`（`resolve_model_switch_target`）。
- 兼容发送诊断：`src-tauri/src/session/control.rs`（`model_config_id_missing` warn）。
- 发送前校验与钳制/pending 收敛：`src-tauri/src/session/model.rs`
  （`validate_advertised_choice`、`ModelSwitchSettlement`、`apply_config_option_response`）。
- wire 级断言：`src-tauri/src/session/model_switch_wire_tests.rs`。
