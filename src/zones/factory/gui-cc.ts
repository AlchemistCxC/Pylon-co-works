/**
 * 区域层 · 出厂区域预设数据 —— gui 桶 / cc 区域（刀2 / #223）。
 *
 * ★ **本文件是出厂区域预设的落盘数据（刀2 / #223 产出）；生成脚本已于刀3 删除，请勿手改。**
 *   它是**唯一真值**：10 套出厂预设的有效值由它算出（`effectivePresetTheme`）——
 *   改这里的任何一个值，等于改掉所有引用它的预设。历史来源见 `.agents/records/issue-223-factory-zone-presets-as-data.md`。
 * 值 = 生成时刻的 `pickZoneFields(GLOBAL_PRESETS[来源].theme, 'cc')`，逐字段照抄
 * （含终端补全烘入的默认值；cc 区含 ccLayout/ccHidden 两个元件名单字段）。
 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_GUI_CC: readonly ZonePresetEntry[] = [
  {
    id: 'glass',
    mode: 'gui',
    zone: 'cc',
    label: 'Glass Light',
    origin: 'factory',
    source: { presetName: 'glass' },
    values: {
      ccHeight: 96,
      ccBg: "rgba(255,255,255,0.20)",
      ccHidden: [
        "cc-send-button"
      ],
      inputBg: "rgba(0,0,0,0.03)",
      inputTextColor: "rgba(0,0,0,0.80)",
      inputPlaceholder: "rgba(0,0,0,0.22)",
      inputFocusBorder: "rgba(99,102,241,0.35)",
      inputFontSize: 15,
      inputMinHeight: 52,
      cliLineWidth: 2,
      cliLineColor: "#9a9a9a",
      cliTextColor: "rgba(0,0,0,0.80)",
      cliPromptColor: "#6b7280",
      cliLinePadding: 3,
      pillText: "rgba(0,0,0,0.50)",
      prismOnColor: "#22c55e",
      modelSwitchMode: "cycle",
      modeAutoColor: "#f59e0b",
      modeEditColor: "#6366f1",
    },
  },
  {
    id: 'solarized',
    mode: 'gui',
    zone: 'cc',
    label: 'Solarized Light',
    origin: 'factory',
    source: { presetName: 'solarized' },
    values: {
      ccHeight: 96,
      ccMarginX: 15,
      ccMarginBottom: 15,
      ccRadius: 25,
      ccBg: "#fdf6e3",
      ccSurfaceOpacity: 1,
      ccBgImage: "",
      ccLayout: {
        "version": 9,
        "placements": {
          "input": {
            "slot": "input",
            "order": 1,
            "offsetX": 0,
            "offsetY": 0
          },
          "model": {
            "slot": "status-secondary",
            "order": 2,
            "offsetX": 0,
            "offsetY": 0
          },
          "reasoning": {
            "slot": "status-secondary",
            "order": 3,
            "offsetX": 0,
            "offsetY": 0
          },
          "mode": {
            "slot": "status-secondary",
            "order": 4,
            "offsetX": 0,
            "offsetY": 0
          },
          "tokens": {
            "slot": "status-secondary",
            "order": 5,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-command-hint": {
            "order": 6,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-send-button": {
            "slot": "actions",
            "order": 0,
            "offsetX": 0,
            "offsetY": 0
          }
        }
      },
      ccHidden: [
        "cc-send-button"
      ],
      inputOffsetTop: 10,
      inputHeight: 40,
      inputMarginX: 10,
      inputSurfaceBg: "#FFFFFF",
      inputSurfaceOpacity: 1,
      inputFocusRingEnabled: "shown",
      inputFocusRingColor: "var(--accent)",
      inputHighlightOpacity: 0,
      inputShadowEnabled: "shown",
      inputBg: "transparent",
      inputBgImage: "",
      inputTextColor: "#657b83",
      inputPlaceholder: "#93a1a1",
      sendButtonColor: "#000000",
      sendButtonRadius: "0.5",
      sendButtonBorderColor: "rgba(255,255,255,.5)",
      sendButtonIcon: "arrow",
      sendButtonIconGenerating: "square",
      sendButtonIconRound: "on",
      sendButtonIconColor: "#ffffff",
      inputBorderColor: "",
      inputFocusBorder: "#268bd2",
      inputBorder: "transparent",
      inputBorderWidth: 1,
      inputBorderOpacity: 0,
      inputRadius: 20,
      inputFontSize: 15,
      inputLineHeight: "1",
      inputMinHeight: 56,
      inputMode: "cli",
      inputVariant: "cli",
      inputShowPlaceholder: true,
      inputShowHistoryHint: true,
      inputSubmitButtonMode: "inline",
      cliLineWidth: 2,
      cliLineColor: "#93a1a1",
      cliTextColor: "#657b83",
      cliPromptColor: "#657b83",
      cliLinePadding: 3,
      cliContentOffsetY: 0,
      cliHintMode: "full",
      ccHintFontSize: 16,
      footerLayout: "free",
      cliOverflowMode: "fixed-scroll",
      pillText: "#586e75",
      prismOnColor: "#859900",
      modelSwitchMode: "cycle",
      modelBgColor: "#ffffff",
      modelWidth: 120,
      modelHeight: 28,
      modelRadius: 0,
      modelFontSize: 12,
      modelTextColor: "#000000",
      reasoningSwitchMode: "menu",
      reasoningBgColor: "#ffffff",
      reasoningWidth: 120,
      reasoningHeight: 28,
      reasoningRadius: 0,
      reasoningFontSize: 12,
      reasoningTextColor: "#000000",
      permissionSwitchMode: "cycle",
      permissionBgColor: "#ffffff",
      permissionWidth: 120,
      permissionHeight: 28,
      permissionRadius: 0,
      permissionFontSize: 12,
      permissionTextColor: "",
      sendVariant: "minimal",
      modeAutoColor: "#b58900",
      modeEditColor: "#268bd2",
    },
  },
  {
    id: 'agent-command',
    mode: 'gui',
    zone: 'cc',
    label: 'Agent 指挥台',
    origin: 'factory',
    source: { presetName: 'agent-command' },
    values: {
      ccHeight: 96,
      ccBg: "#0d192b",
      inputBg: "rgba(148,163,184,0.09)",
      inputTextColor: "#e0f2fe",
      inputPlaceholder: "#647d99",
      inputFocusBorder: "rgba(56,189,248,0.72)",
    },
  },
  {
    id: 'agent-map',
    mode: 'gui',
    zone: 'cc',
    label: 'Agent 关系图',
    origin: 'factory',
    source: { presetName: 'agent-map' },
    values: {
      ccHeight: 96,
      ccBg: "#1a172b",
      inputBg: "rgba(167,139,250,0.08)",
      inputTextColor: "#f5f3ff",
      inputPlaceholder: "#766c91",
      inputFocusBorder: "rgba(167,139,250,0.72)",
    },
  },
  {
    id: 'focus-flow',
    mode: 'gui',
    zone: 'cc',
    label: '专注流程',
    origin: 'factory',
    source: { presetName: 'focus-flow' },
    values: {
      ccHeight: 88,
      ccBg: "#201e19",
      inputBg: "rgba(214,168,95,0.05)",
      inputTextColor: "#eee8dc",
      inputPlaceholder: "#81796d",
      inputFocusBorder: "rgba(214,168,95,0.55)",
    },
  },
]

// 本文件 5 条 / 122 个字段值
