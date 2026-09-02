import type { JsonValue } from '../events/workbenchEventSchema.js';
export interface UsageSnapshot {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly totalTokens?: number;
    readonly contextUsed?: number;
    readonly contextLimit?: number;
    readonly contextPercent?: number;
    readonly calls?: number;
    readonly costUsd?: number;
    readonly currency?: string;
    readonly budget?: BudgetSnapshot;
    readonly raw?: Readonly<Record<string, JsonValue>>;
}
export interface BudgetSnapshot {
    readonly used?: number;
    readonly limit?: number;
    readonly remaining?: number;
    readonly type?: string;
    readonly resetAt?: string;
    readonly threshold?: string;
    readonly percent?: number;
    readonly exhausted?: boolean;
}
export interface SessionCommand {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly inputHint?: string;
    readonly availability?: boolean | string;
    readonly capability?: string;
    readonly raw?: Readonly<Record<string, JsonValue>>;
}
export interface SessionConfigOption {
    readonly id: string;
    readonly label: string;
    readonly value?: JsonValue;
    readonly valueType?: string;
    readonly editable?: boolean;
    readonly schema?: JsonValue;
    readonly version?: number;
    readonly capability?: string;
    readonly raw?: Readonly<Record<string, JsonValue>>;
}
export interface AssistSnapshot {
    readonly prediction?: {
        readonly placeholder?: string;
        readonly actions: readonly JsonValue[];
    };
    readonly files: readonly string[];
    readonly queuedCommand?: string;
}
export declare const EMPTY_ASSIST_SNAPSHOT: AssistSnapshot;
export declare function normalizeUsageSnapshot(value: unknown, previous?: UsageSnapshot): {
    readonly value: UsageSnapshot;
    readonly invalidFields: readonly string[];
};
export declare function normalizeBudgetSnapshot(input: {
    readonly used?: number;
    readonly limit?: number;
    readonly remaining?: number;
    readonly budgetType?: string;
    readonly resetAt?: string;
    readonly threshold?: string;
    readonly percent?: number;
    readonly exhausted?: boolean;
}, previous?: BudgetSnapshot): BudgetSnapshot;
export declare function normalizeSessionCommands(values: readonly JsonValue[]): readonly SessionCommand[];
export declare function normalizeSessionConfigOptions(values: readonly JsonValue[]): readonly SessionConfigOption[];
