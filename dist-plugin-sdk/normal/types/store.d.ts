import type { CcLayoutV3, CcWidgetPlacement } from './ccLayoutState.js';
import type { CustomPreset } from './customPresets.js';
import { type PresetApplyResult } from './domains/theme/presetBundle.js';
import { type SettingWriteSource } from './domains/theme/settingProvenance.js';
export type { Profile, Session, UserMapping, AgentEntry } from './identityStore';
export type { SessionConfig } from './runtimeStore';
export interface ThemeSettings {
    /** 全局强调色（--accent）：链接/前缀/焦点/选中态统一取色，此前硬编码 #3b82f6 无法主题化 */
    accent: string;
    /** 布局骨架显隐（CC 单流模式入口）：tab 条 / 侧栏 / 宠物 */
    showTabBar: boolean;
    showSidebar: boolean;
    showPet: boolean;
    transparency: number;
    bgBlur: number;
    globalFont: string;
    codeFont: string;
    globalFontSize: number;
    globalBgImage: string;
    globalBgColor: string;
    uiScheme: string;
    titlebarBg: string;
    titlebarTextColor: string;
    sidebarBg: string;
    sidebarBgImage: string;
    sidebarWidth: number;
    sidebarTextColor: string;
    sidebarNameSize: number;
    sidebarGroupSize: number;
    chatBg: string;
    chatBgImage: string;
    chatFont: string;
    chatFontSize: number;
    chatLineHeight: number;
    chatTextColor: string;
    chatCodeColor: string;
    chatCodeBg: string;
    synKeyword: string;
    synString: string;
    synComment: string;
    synLiteral: string;
    synEntity: string;
    synFunction: string;
    synVariable: string;
    synProperty: string;
    synRegex: string;
    synMarkupHeading: string;
    synCoReference: string;
    synSupport: string;
    toolOk: string;
    toolRun: string;
    toolErr: string;
    userTagBg: string;
    userTagText: string;
    /** diff 块级色（此前复用 toolOk/toolErr，CC 系为独立柔和色） */
    diffAdded: string;
    diffRemoved: string;
    /** diff 词级高亮色（CC 双层：整行背景 + 变更词背景） */
    diffAddedWord: string;
    diffRemovedWord: string;
    /** W2-01（F3-D）：FileSheet 编辑器 8 字段（defs 先行，W2-04 消费） */
    editorFontSize: number;
    editorLineHeight: number;
    editorGutterColor: string;
    editorGutterBg: string;
    editorSelection: string;
    editorActiveLine: string;
    editorTabActive: string;
    editorModifiedMark: string;
    toolIndicatorGlow: number;
    toolIndicatorGlowColor: string;
    toolConnectorMode: string;
    toolConnectorColor: string;
    toolConnectorStyle: 'solid' | 'dotted' | 'pulse';
    toolConnectorWidth: number;
    toolConnectorOpacity: number;
    inputBg: string;
    inputBgImage: string;
    inputTextColor: string;
    inputPlaceholder: string;
    inputSendBg: string;
    inputBorderColor: string;
    inputFocusBorder: string;
    inputRadius: number;
    inputFocusRingWidth: number;
    inputFontSize: number;
    inputMinHeight: number;
    inputMode: string;
    inputVariant: 'cli' | 'composer' | 'compact' | 'command';
    inputShowPlaceholder: boolean;
    inputShowHistoryHint: boolean;
    inputSubmitButtonMode: 'inline' | 'external' | 'hidden';
    cliLineWidth: number;
    cliLineColor: string;
    cliTextColor: string;
    cliPromptColor: string;
    cliLinePadding: number;
    cliContentOffsetY: number;
    cliHintMode: 'hidden' | 'compact' | 'full';
    statusBg: string;
    statusBgImage: string;
    ekgWidth: number;
    ekgGreen: string;
    ekgYellow: string;
    ekgRed: string;
    pillBg: string;
    pillText: string;
    prismOnColor: string;
    barTrackColor: string;
    barFillColor: string;
    barFillFollow: boolean;
    barHeight: number;
    rightBg: string;
    rightBgImage: string;
    rightWidth: number;
    sidebarTransparency: number;
    sidebarBlur: number;
    chatTransparency: number;
    chatBlur: number;
    rightTransparency: number;
    rightBlur: number;
    userName: string;
    userPrefix: string;
    userColor: string;
    toolIndicator: string;
    /** Terminal tool glyphs by semantic state; toolIndicator remains legacy fallback. */
    toolIndicatorRun: string;
    toolIndicatorOk: string;
    toolIndicatorErr: string;
    spinnerFramePreset: 'sparkles' | 'ascii-line' | 'braille' | 'dots' | 'orbit' | 'clock' | 'wave' | 'blocks' | 'scan' | 'cc' | 'custom';
    spinnerCustomFrames: string;
    spinnerVerbSet: 'zh' | 'en' | 'analysis' | 'engineering' | 'cc' | 'custom';
    spinnerCustomVerbs: string;
    spinnerDoneMarker: string;
    spinnerCancelledMarker: string;
    spinnerErrorMarker: string;
    spinnerDoneMarkerMode: 'frame' | 'custom';
    spinnerCancelledMarkerMode: 'frame' | 'custom';
    spinnerErrorMarkerMode: 'frame' | 'custom';
    spinnerIntervalMs: number;
    spinnerColor: string;
    spinnerSize: number;
    /** CC stalled 渐变红（3s 无响应后帧/文案趋向此色） */
    spinnerStalledColor: string;
    msgStyle: string;
    msgFont: string;
    msgTextColor: string;
    msgLineHeight: number;
    messageUserBg: string;
    messageAssistantBg: string;
    messageReasoningBg: string;
    messageBorderColor: string;
    messageRadius: number;
    messageLayout: 'classic' | 'claude' | 'bubble';
    /** CC 视觉还原：助手消息 ● 圆点 */
    assistantDot: boolean;
    assistantDotGlyph: string;
    assistantDotColor: string;
    /** 自定义头像/图标路径（非空时替代圆点字形，列宽随图） */
    assistantDotImage: string;
    footerLayout: 'free' | 'peri';
    cliOverflowMode: 'fixed-scroll' | 'grow' | 'overlay';
    ccHeight: number;
    ccBgHeight: number;
    ccBg: string;
    ccBgImage: string;
    ccStatusFontSize: number;
    ccStyle: string;
    ccVariant: string;
    modelVariant: string;
    modeVariant: string;
    sendVariant: string;
    attachVariant: string;
    /** 权限模式徽标色（此前硬编码 #FFC107/#A2A9E4） */
    modeAutoColor: string;
    modeEditColor: string;
    ccHidden: string[];
    ccLayout: CcLayoutV3;
    ccEditMode: boolean;
    ccScale: Record<string, number>;
    appliedPreset: Record<string, string>;
    custom: Record<string, boolean>;
}
/**
 * themeStore — 主题状态域（阶段 1：store 按域拆分后收敛）。
 *
 * 唯一持久化域（pylon-theme）。身份/运行时/Workspace 状态已迁出到
 * identityStore / runtimeStore / workspaceStore（组合出口见文件尾）。
 */
type ThemeState = ThemeSettings & {
    customPresets: CustomPreset[];
    setCcEditMode: (enabled: boolean) => void;
    setCcHeight: (height: number) => void;
    updateCcPlacement: (id: string, partial: Partial<CcWidgetPlacement>) => void;
    resetCcLayout: () => void;
    setCcHidden: (id: string, hidden: boolean) => void;
    setCcScale: (id: string, scale: number) => void;
    resetTheme: () => void;
    /** 重置单个 zone 的字段到默认值（不清其他 zone），并清该 zone 的 custom/appliedPreset */
    resetZone: (zone: string) => void;
    applyZonePreset: (zone: string, presetName: string, presetTheme: Partial<ThemeSettings>) => void;
    setZoneField: (zone: string, partial: Partial<ThemeSettings>, source?: SettingWriteSource) => void;
    setGlobalPreset: (name: string, theme: Partial<ThemeSettings>) => void;
    saveCustomPreset: (name: string, id?: string) => string;
    applyCustomPreset: (id: string) => Promise<PresetApplyResult>;
    removeCustomPreset: (id: string) => void;
};
export declare const useStore: import("zustand").UseBoundStore<Omit<import("zustand").StoreApi<ThemeState>, "setState" | "persist"> & {
    setState(partial: ThemeState | Partial<ThemeState> | ((state: ThemeState) => ThemeState | Partial<ThemeState>), replace?: false): unknown;
    setState(state: ThemeState | ((state: ThemeState) => ThemeState), replace: true): unknown;
    persist: {
        setOptions: (options: Partial<import("zustand/middleware").PersistOptions<ThemeState, unknown, unknown>>) => void;
        clearStorage: () => void;
        rehydrate: () => Promise<void> | void;
        hasHydrated: () => boolean;
        onHydrate: (fn: (state: ThemeState) => void) => () => void;
        onFinishHydration: (fn: (state: ThemeState) => void) => () => void;
        getOptions: () => Partial<import("zustand/middleware").PersistOptions<ThemeState, unknown, unknown>>;
    };
}>;
export { useIdentityStore } from './identityStore';
export { useRuntimeStore } from './runtimeStore';
export { useWorkspaceStore } from './workspaceStore';
