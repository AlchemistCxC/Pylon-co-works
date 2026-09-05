/**
 * chatContracts — ACP wire 类型与 extract 收边界（P1-09，归一化层归属 infrastructure/acp）。
 *
 * 从 components/chat/acpTypes 迁入（§5.2/§7 收拢）：wire 类型 + 宽容提取函数只在此处
 * 真实定义；components/chat/acpTypes 保留兼容 re-export。归一化只搬运不翻译。
 */
export interface ConfigOptionChoice {
    id?: string;
    value?: string;
    valueId?: string | {
        value?: string;
        valueId?: string;
        id?: string;
        key?: string;
    };
    value_id?: string | {
        value?: string;
        valueId?: string;
        id?: string;
        key?: string;
    };
    modelId?: string;
    model_id?: string;
    modeId?: string;
    mode_id?: string;
    name?: string;
    label?: string;
    title?: string;
    displayName?: string;
    [key: string]: unknown;
}
export interface ConfigOption {
    id?: string;
    key?: string;
    configId?: string;
    config_id?: string;
    optionId?: string;
    option_id?: string;
    name?: string;
    label?: string;
    title?: string;
    description?: string;
    category?: string;
    type?: string;
    valueType?: string;
    value_type?: string;
    currentValue?: unknown;
    current_value?: unknown;
    value?: unknown;
    current?: unknown;
    selected?: unknown;
    selectedValue?: unknown;
    selected_value?: unknown;
    defaultValue?: unknown;
    default_value?: unknown;
    options?: ConfigOptionChoice[];
    choices?: ConfigOptionChoice[];
    values?: ConfigOptionChoice[];
    available?: ConfigOptionChoice[];
    items?: ConfigOptionChoice[];
    schema?: unknown;
    editable?: boolean;
    readOnly?: boolean;
    readonly?: boolean;
    read_only?: boolean;
    [key: string]: unknown;
}
export interface AvailableCommand {
    name: string;
    input_hint?: string;
    description?: string;
}
export interface SessionModes {
    currentModeId?: unknown;
    current_mode_id?: unknown;
    currentMode?: unknown;
    current_mode?: unknown;
    current?: unknown;
    availableModes?: unknown;
    available_modes?: unknown;
    modes?: unknown;
}
export interface SessionModels {
    currentModelId?: unknown;
    current_model_id?: unknown;
    currentModel?: unknown;
    current_model?: unknown;
    current?: unknown;
    availableModels?: unknown;
    available_models?: unknown;
    models?: unknown;
}
export interface SessionResponseObject {
    sessionId?: string;
    session_id?: string;
    periId?: string;
    modes?: SessionModes;
    models?: SessionModels;
    configOptions?: ConfigOption[];
    config_options?: ConfigOption[];
    modelId?: unknown;
    model_id?: unknown;
    modeId?: unknown;
    mode_id?: unknown;
    availableModels?: unknown;
    available_models?: unknown;
    availableModes?: unknown;
    available_modes?: unknown;
    usage?: {
        used?: number;
        value?: number;
        size?: number;
        tokensUsed?: number;
        tokensMax?: number;
        cacheReadTokens?: number;
    };
    sessionInfo?: {
        usage?: SessionResponseObject['usage'];
        mode?: unknown;
        currentMode?: unknown;
    };
}
export type SessionResponse = string | SessionResponseObject;
interface UpdateBase extends OptionalChatEventIdentity {
    _meta?: {
        periReplay?: boolean;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
    };
}
/** plan wire entry（原始形态，宽容；收窄到 domains/tasks 的 PlanEntry） */
export interface WirePlanEntry {
    content?: string;
    priority?: number;
    status?: string;
}
/** 内容 chunk：ACP messageId 随 chunk 透传；其他 identity 字段仅兼容可选 envelope。 */
export interface ContentChunk {
    text?: string;
    messageId?: string;
    eventId?: string;
    turnId?: string;
}
/** 工具内容块：text/图片/diff 等；未知 content type 保留通用对象不抛错（D13） */
export interface ContentBlock {
    type?: string;
    text?: string;
    [key: string]: unknown;
}
export type SessionUpdate = (UpdateBase & {
    sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
    content?: ContentChunk;
}) | (UpdateBase & {
    sessionUpdate: 'tool_call';
    toolCallId?: string;
    title?: string;
    kind?: string;
    content?: ContentBlock[];
    rawInput?: unknown;
    locations?: unknown;
}) | (UpdateBase & {
    sessionUpdate: 'tool_call_update';
    toolCallId?: string;
    title?: string;
    kind?: string;
    content?: ContentBlock[];
    rawOutput?: unknown;
    status?: string;
}) | (UpdateBase & {
    sessionUpdate: 'usage_update';
    used?: number;
    value?: number;
    size?: number;
}) | (UpdateBase & {
    sessionUpdate: 'session_info_update';
    mode?: unknown;
    currentMode?: unknown;
    usage?: {
        used?: number;
        value?: number;
        size?: number;
        tokensUsed?: number;
        tokensMax?: number;
        cacheReadTokens?: number;
    };
    sessionInfo?: SessionResponseObject['sessionInfo'];
}) | (UpdateBase & {
    sessionUpdate: 'available_commands_update';
    commands?: AvailableCommand[];
}) | (UpdateBase & {
    sessionUpdate: 'config_option_update';
    configOptions?: ConfigOption[];
    id?: string;
    key?: string;
    currentValue?: unknown;
    value?: unknown;
}) | (UpdateBase & {
    sessionUpdate: 'plan';
    entries?: WirePlanEntry[];
});
export interface PeriUpdatePayload {
    source: string;
    update: SessionUpdate;
    /** Rust Kernel 已写入 canonical_events 后附带的 committed flat row。 */
    canonicalEvent?: unknown;
}
export interface PeriDonePayload {
    source: string;
    replay?: boolean;
    canonicalEvent?: unknown;
}
/** Additive prompt failure provenance.  The legacy `error` string remains the
 * compatibility display field; renderers may use this metadata for a precise
 * diagnostic without guessing from provider prose. */
export type PromptFailureSource = 'provider' | 'rpc' | 'prompt-timeout' | 'write-timeout' | 'connection' | 'cancelled' | 'internal';
export type PromptTimeoutKind = 'first-token' | 'idle' | 'rpc' | 'write';
export interface PromptFailureMetadata {
    readonly source: PromptFailureSource;
    readonly timeoutKind?: PromptTimeoutKind;
    readonly configuredTimeoutSecs?: number;
    readonly triggeredTimeoutSecs?: number;
    readonly actualElapsedMs?: number;
    readonly providerMessage?: string;
}
export interface PeriErrorPayload {
    source: string;
    error: string;
    cancelled?: boolean;
    replay?: boolean;
    canonicalEvent?: unknown;
    failure?: PromptFailureMetadata;
}
/** 可选内部 envelope 身份；不改变 ACP wire 的必需字段。 */
export interface OptionalChatEventIdentity {
    messageId?: string;
    eventId?: string;
    turnId?: string;
    toolCallId?: string;
}
/**
 * Extract a machine-facing string from ACP scalar/nested value shapes.
 * Display labels are deliberately last; stable ids always win when both are
 * advertised (for example `{modelId, name}`).
 */
export declare function extractWireString(value: unknown, preferredKeys?: readonly string[], depth?: number): string | undefined;
/** Return the provider's config option id, including ACP v1.4 aliases. */
export declare function extractConfigOptionId(option: unknown): string | undefined;
/** Return the selected config value, unwrapping value/valueId envelopes. */
export declare function extractConfigOptionValue(option: unknown): unknown;
/** Return all advertised choices from options/choices/schema/enum variants. */
export declare function extractConfigOptionChoices(option: unknown): readonly unknown[];
/** Extract a choice's machine id; modelId/modeId precede display names. */
export declare function extractChoiceId(value: unknown, kind?: 'model' | 'mode'): string | undefined;
/** Presentation label helper that never changes the machine id sent on wire. */
export declare function extractChoiceLabel(value: unknown, fallback?: string): string | undefined;
export type ConfigOptionSemantic = 'model' | 'mode' | 'reasoning';
/** Find an option by semantic id while tolerating provider naming drift. */
export declare function findConfigOption(options: readonly unknown[] | undefined, semantic: ConfigOptionSemantic): unknown | undefined;
export declare function sessionResponseObject(response: unknown): SessionResponseObject;
export declare function extractModelConfig(configOptions: ConfigOption[] | undefined, response?: SessionResponseObject): {
    model?: string;
    models?: string[];
};
/** Extract ACP mode ids while preserving the provider's raw ids for writes. */
export declare function extractModeConfig(response: SessionResponseObject): {
    mode?: string;
    modes?: string[];
};
/** Extract the currently selected reasoning/thinking effort and its choices. */
export declare function extractReasoningConfig(configOptions: ConfigOption[] | undefined, response?: SessionResponseObject): {
    thinkingEffort?: string;
    reasoning?: string[];
};
export declare function extractMode(response: SessionResponseObject): string | undefined;
export declare function extractSessionUsage(response: SessionResponseObject): {
    tokensUsed: number;
    tokensMax: number;
    cacheReadTokens: number;
} | undefined;
export declare function extractUsage(update: Extract<SessionUpdate, {
    sessionUpdate: 'usage_update';
}>): {
    tokensUsed: number;
    tokensMax: number;
    cacheReadTokens: number;
};
/** tool kind 提取：仅接受非空字符串（Peri/Hermes/第三方字段漂移时宽容返回 undefined） */
export declare function extractToolKind(update: unknown): string | undefined;
/** content 提取：非数组返回 undefined；未知 content type 保留通用对象不抛错 */
export declare function extractContentBlocks(update: unknown): ContentBlock[] | undefined;
/** plan entries 提取：非数组返回 undefined（空快照 [] 与缺失 undefined 区分） */
export declare function extractPlanEntries(update: unknown): WirePlanEntry[] | undefined;
export {};
