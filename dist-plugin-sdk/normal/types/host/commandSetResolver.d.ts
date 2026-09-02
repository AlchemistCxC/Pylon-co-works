/**
 * commandSetResolver —— v2 Command Registry 的宿主消费面。
 *
 * - 内置/插件命令统一由响应式 CommandRegistry 提供；
 * - 人机侧 suggestions 与 agent 侧 prompt 片段同源；
 * - agent 上报的 available_commands 只覆盖人机侧展示，不污染 prompt 注入；
 * - prompt 注入按 COMMAND_PROMPT_BUDGET 截断。
 */
import { type CommandSetDescriptor } from '../contracts/agentCommandSet.js';
export interface AgentReportedCommand {
    name: string;
    input_hint?: string;
    description?: string;
}
export interface CommandSetPromptContext {
    agentId?: string;
    profileId?: string;
    /** 会话启用插件 id；缺省 = 全部已激活 command 插件。 */
    enabledPluginIds?: readonly string[];
}
export interface CommandSetSuggestion {
    cmd: string;
    args: string;
    info: string;
}
export declare function subscribePluginCommands(listener: () => void): () => void;
/** 全部插件命令（Registry 顺序 → command priority/name）。 */
export declare function resolvePluginCommands(enabledPluginIds?: readonly string[]): CommandSetDescriptor[];
export declare function resolveCommandSetDescriptors(agentCommands?: readonly AgentReportedCommand[], enabledPluginIds?: readonly string[]): CommandSetDescriptor[];
export declare function resolveCommandSetSuggestions(agentCommands?: readonly AgentReportedCommand[], enabledPluginIds?: readonly string[]): CommandSetSuggestion[];
export declare function buildAgentCommandPrompt(context?: CommandSetPromptContext): string;
export declare function injectAgentCommandPrompt(session: {
    sessionPrompt?: string;
    agentId?: string;
    profileId?: string;
    commandSetPlugins?: readonly string[];
}): string;
