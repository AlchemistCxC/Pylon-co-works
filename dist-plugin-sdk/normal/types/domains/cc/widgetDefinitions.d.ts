/**
 * widgetDefinitions — 中控 widget 单一真值（C1/C4）。
 *
 * widget id 列表/状态 widget 集合/属性表单 schema 派生自此处；ccLayoutState（CcWidgetId）、
 * widgetRegistry（渲染注册表）、ccHeightState（高度约束）、ControlCenter PropertyPanel
 * （属性表单）全部消费同一来源。
 * 新增 widget：此处加 id + widgetRenderers 补 renderer + propertyFields 补表单。
 */
import type { ThemeSettings } from '../../store.js';
/** 全部中控 widget id（含输入栏、上下文、会话身份、运行态与动作按钮）。 */
export declare const CC_WIDGET_IDS: readonly ["input", "session", "workspace", "activity", "ekg", "pct", "tokens", "model", "mode", "send", "attach", "tasks"];
export type CcWidgetId = (typeof CC_WIDGET_IDS)[number];
/** 状态区 widget（除 input 外全部计入中控最小高度约束）——由 id 列表派生，不平行维护 */
export declare const STATUS_WIDGET_IDS: readonly CcWidgetId[];
export type CcColorPropertyKey = 'inputBg' | 'inputTextColor' | 'cliLineColor' | 'ekgGreen' | 'ekgYellow' | 'ekgRed' | 'barTrackColor' | 'barFillColor';
export type CcNumberPropertyKey = 'inputFontSize' | 'inputMinHeight' | 'cliLineWidth' | 'cliLinePadding' | 'ekgWidth' | 'barHeight';
export type CcStringPropertyKey = 'inputMode' | 'inputVariant' | 'ccStyle' | 'modelVariant' | 'modeVariant' | 'sendVariant' | 'attachVariant';
export type CcBooleanPropertyKey = 'barFillFollow';
export type CcEditablePropertyKey = CcColorPropertyKey | CcNumberPropertyKey | CcStringPropertyKey | CcBooleanPropertyKey;
export type WidgetPropertyField = {
    kind: 'section';
    title: string;
} | {
    kind: 'color';
    key: CcColorPropertyKey;
    label: string;
} | {
    kind: 'number';
    key: CcNumberPropertyKey;
    label: string;
    min: number;
    max: number;
    step?: number;
    suffix?: string;
} | {
    kind: 'chips';
    key: CcStringPropertyKey;
    label: string;
    options: {
        value: string;
        label: string;
        sync?: {
            key: CcStringPropertyKey;
            value: string;
        };
    }[];
} | {
    kind: 'chipsBool';
    key: CcBooleanPropertyKey;
    label: string;
    trueLabel: string;
    falseLabel: string;
};
export type CcPropertyCommand = {
    readonly type: 'set-cc-property';
    readonly key: CcColorPropertyKey | CcStringPropertyKey;
    readonly value: string;
} | {
    readonly type: 'set-cc-property';
    readonly key: CcNumberPropertyKey;
    readonly value: number;
} | {
    readonly type: 'set-cc-property';
    readonly key: CcBooleanPropertyKey;
    readonly value: boolean;
};
export type WidgetPropertyVisibilityContext = Pick<ThemeSettings, 'inputMode' | 'ccStyle' | 'barFillFollow'>;
export interface WidgetPropertyDef {
    /** 条件显示（cli 字段只在 inputMode==='cli'、ekg 三色只在 wave 等） */
    showIf?: (theme: WidgetPropertyVisibilityContext) => boolean;
}
/**
 * 每 widget 的属性表单（纯数据）。inputMode↔inputVariant 双写经 chips 的 sync 表达
 * （主键写 value 时同步写 sync.key），保持与 Settings 双写一致。
 */
export declare const WIDGET_PROPERTY_FIELDS: Record<CcWidgetId, readonly (WidgetPropertyField & WidgetPropertyDef)[]>;
export interface WidgetVisibilityCtx {
    hidden: readonly string[];
    inputMode: string;
    submitButtonMode: string;
    ccStyle: string;
    /** 编辑模式：全显（隐藏/模式互斥规则不生效） */
    editMode?: boolean;
    /** 经典终端冻结：新增图形控件在正常态不进入其布局。 */
    presentationProfileId?: string;
}
/**
 * widget 可见性单一真值（C2）：渲染（ControlCenter.renderWidget）与高度计数
 * （resolveVisibleStatusWidgetCount）消费同一谓词，杜绝"计数多算不渲染的 widget"。
 */
export declare function isWidgetVisible(id: string, ctx: WidgetVisibilityCtx): boolean;
/**
 * 外部按钮模式（send/attach 独立 widget 渲染的前提）：非 CLI + submitButtonMode=external。
 * 单一真值：isWidgetVisible 与 ControlCenter 的 InputBar externalSend/externalAttach 传参
 * 共同消费，改判定一处即可。
 */
export declare function isExternalSubmitMode(ctx: Pick<WidgetVisibilityCtx, 'inputMode' | 'submitButtonMode'>): boolean;
