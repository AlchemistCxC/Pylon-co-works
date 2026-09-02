/**
 * permissionTypes — 权限请求 wire 收窄模型（P0-01）。
 *
 * pylon:permission-request 事件（契约 §2.3/§3）的前端收窄：保留 requestId 原值、
 * options 顺序与 optionId 原值（D15——不硬编码 Peri/Hermes 按钮集），其余字段宽容
 * （未知键保留，供 P0-03 弹窗与 diff 特化读取，不做任何解释）。
 */
/** wire option 项的前端收窄：optionId 是唯一必需键，其余字段宽容保留（ACP-02 §5.5 契约） */
export interface PermissionOption {
    /** 协议值：response 必须回写原值，禁止正规化/小写化 */
    optionId: string;
    /** Hermes/Peri 可发送 name 作展示文案（label 缺省时回退显示） */
    name?: string;
    /** 语义类别（Hermes 兼容：kind=reject_once 是拒绝类别，只参与选择不参与应答） */
    kind?: string;
    /** 原文透传（前端宽容读取，不做解释） */
    raw?: unknown;
    /** 兼容旧 UI 的 label 别名 */
    label?: string;
    [key: string]: unknown;
}
/** 权限请求（前端收窄形态） */
export interface PermissionRequest {
    /** ACP-01：requestId 原值（wire 为字符串回显——number/string 统一以字符串传输，不转数） */
    requestId: string;
    provider: string;
    agentId: string;
    sessionId: string;
    toolCallId?: string;
    clientGeneration: number;
    title?: string;
    /** 已脱敏（后端保证 ≤500） */
    prompt?: string;
    options: PermissionOption[];
    /** P1-2：Rust Timestamp wire 为字符串、本地 Date.now() 为 number——两类都接受 */
    requestedAt?: string | number;
    /** ACP-03：后端单一来源的超时 deadline（Unix ms）——前端只用于倒计时展示，不自行判定 */
    deadlineMs?: number;
}
