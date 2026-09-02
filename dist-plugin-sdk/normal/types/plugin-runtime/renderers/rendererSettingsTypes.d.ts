/**
 * Serializable settings contract owned by the renderer catalog.
 *
 * This module deliberately contains no React/Solid/store imports.  A plugin
 * contributes data; the host validates it once and every settings surface
 * consumes the same frozen representation.
 */
export type ChoicePresentation = 'select' | 'radio' | 'segmented';
export type MultiChoicePresentation = 'checklist' | 'listbox';
export type ColorPresentation = 'palette' | 'picker' | 'palette+picker';
export type NumberPresentation = 'slider' | 'input' | 'slider+input';
export type RendererSettingValue = null | boolean | number | string | readonly RendererSettingValue[] | {
    readonly [key: string]: RendererSettingValue;
};
/**
 * Owner-provided placement metadata consumed by the Settings compositor.
 * It describes where a schema is presented, never the value/default/consumer.
 */
export interface RendererSettingsPlacement {
    readonly categoryId: string;
    readonly categoryLabel: string;
    readonly categoryOrder?: number;
    readonly objectOrder?: number;
    readonly disclosure?: 'essential' | 'detail' | 'technical';
}
export declare function normalizeRendererSettingsPlacement(placement: RendererSettingsPlacement): RendererSettingsPlacement;
export interface RendererSettingOption {
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
    readonly disabled?: boolean;
    readonly order?: number;
}
export type RenderSettingCondition = {
    readonly equals: {
        readonly field: string;
        readonly value: RendererSettingValue;
    };
} | {
    readonly oneOf: {
        readonly field: string;
        readonly values: readonly RendererSettingValue[];
    };
} | {
    readonly not: RenderSettingCondition;
} | {
    readonly all: readonly RenderSettingCondition[];
} | {
    readonly any: readonly RenderSettingCondition[];
};
interface RenderSettingFieldBase {
    /** `key` is the canonical name; `id` is accepted as a migration alias. */
    readonly key?: string;
    readonly id?: string;
    readonly label?: string;
    readonly description?: string;
    readonly advanced?: boolean;
    readonly default?: RendererSettingValue;
    readonly showIf?: RenderSettingCondition;
    readonly resetLabel?: string;
}
export interface RenderChoiceSettingField extends RenderSettingFieldBase {
    readonly type: 'choice';
    readonly presentation?: ChoicePresentation;
    readonly options: readonly RendererSettingOption[];
    readonly optionTarget?: string;
}
export interface RenderMultiChoiceSettingField extends RenderSettingFieldBase {
    readonly type: 'multi-choice';
    readonly presentation?: MultiChoicePresentation;
    readonly options: readonly RendererSettingOption[];
    readonly minSelected?: number;
    readonly maxSelected?: number;
    readonly optionTarget?: string;
}
export interface RenderColorSettingField extends RenderSettingFieldBase {
    readonly type: 'color';
    readonly presentation?: ColorPresentation;
    readonly alpha?: boolean;
    readonly paletteTarget?: string;
}
export interface RenderNumberSettingField extends RenderSettingFieldBase {
    readonly type: 'number';
    readonly presentation?: NumberPresentation;
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
    readonly unit?: string;
}
export interface RenderBooleanSettingField extends RenderSettingFieldBase {
    readonly type: 'boolean';
    readonly presentation?: 'toggle' | 'checkbox';
}
export interface RenderTextSettingField extends RenderSettingFieldBase {
    readonly type: 'text';
    readonly presentation?: 'input' | 'textarea';
    readonly pattern?: string;
    readonly placeholder?: string;
    readonly maxLength?: number;
}
export type RenderSettingField = RenderChoiceSettingField | RenderMultiChoiceSettingField | RenderColorSettingField | RenderNumberSettingField | RenderBooleanSettingField | RenderTextSettingField;
export interface RenderSettingGroup {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly layout?: 'stack' | 'grid' | 'inline' | 'tabs';
    readonly collapsedByDefault?: boolean;
    readonly fields: readonly RenderSettingField[];
}
export interface RendererSettingsSchema {
    readonly schemaVersion: number;
    readonly groups: readonly RenderSettingGroup[];
}
export declare function validateRendererSettingsSchema(schema: RendererSettingsSchema): void;
export declare function normalizeRendererSettingsSchema(schema: RendererSettingsSchema): RendererSettingsSchema;
export declare function settingFieldKey(field: Pick<RenderSettingField, 'key' | 'id'>): string;
export declare function settingOptionTarget(fieldNamespace: 'kind' | 'suite' | 'slot', ownerId: string, fieldKeyValue: string): string;
/** 类型 → 默认显示形态（设置页侧的惯例真值；组件 schema 的显式 presentation 优先）。 */
export declare const DISPLAY_DEFAULTS: Readonly<Record<RenderSettingField["type"], RendererPresentation>>;
export type RendererPresentation = ChoicePresentation | MultiChoicePresentation | ColorPresentation | NumberPresentation | 'toggle' | 'checkbox' | 'input' | 'textarea';
/** 显示方式单点解析：schema 显式声明优先，未声明走类型默认（设计书 §3.6/§3.7）。 */
export declare function resolvePresentation(field: RenderSettingField): RendererPresentation;
export {};
