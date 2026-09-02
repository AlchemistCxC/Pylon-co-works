/**
 * agent.commandSet 扩展点契约（施工方案书 v3 §4.1）。
 *
 * 命令集双消费者同源：
 * - agent 面：会话发送前经 buildAgentCommandPrompt 注入 prompt（token 预算）；
 * - 人机面：InputBar/Solid 输入建议与 filter 消费同一 resolver。
 */
export declare const CORE_COMMAND_SET_PLUGIN_ID = "core.commandSet.builtin";
/** 命令权限档（与既有 permission 模式语义对齐，仅声明用）。 */
export type CommandPermission = 'read' | 'edit' | 'execute' | 'gate';
export interface CommandSetDescriptor {
    /** 命令名（不含斜杠），小写唯一键。 */
    name: string;
    aliases?: readonly string[];
    description: string;
    /** 输入提示（人机侧 args 展示）。 */
    inputHint?: string;
    /** 注入 agent 的片段；缺省由宿主按 name/description 生成。 */
    agentPromptSnippet?: string;
    permission?: CommandPermission;
    /** 注入与建议排序：越小越先。 */
    priority: number;
}
/** 扩展点实现：返回本贡献提供的命令集合。 */
export interface CommandSetProvider {
    resolve(): readonly CommandSetDescriptor[];
}
/** 注入 prompt 的默认字符预算；超出按 priority 截断。 */
export declare const COMMAND_PROMPT_BUDGET = 1200;
