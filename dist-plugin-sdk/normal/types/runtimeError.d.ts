export type RecoveryKind = 'open-agent-settings' | 'select-agent-executable' | 'open-runtime-log';
export interface RuntimeErrorDetail {
    action: string;
    message: string;
    /** 后端稳定错误码（施工文档 §5.2）；缺失时保留 undefined。 */
    code?: string;
    /** 可行动恢复入口（ErrorCenter 据此渲染恢复按钮）。 */
    recovery?: {
        kind: RecoveryKind;
        agentId?: string;
    };
}
/** 从部署错误码推导恢复入口（施工文档 §5.3 按钮映射）。 */
export declare function recoveryForCode(code: string | undefined, agentId?: string): RuntimeErrorDetail['recovery'];
export declare function formatRuntimeError(action: string, error: unknown, agentId?: string): RuntimeErrorDetail;
export declare function reportRuntimeError(action: string, error: unknown, agentId?: string): RuntimeErrorDetail;
