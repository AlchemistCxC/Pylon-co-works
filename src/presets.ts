/**
 * presets.ts — 全局/局部预设定义 + 区域字段映射
 *
 * 分区（zone）：
 *   global  — 全局玻璃效果、字体、用户信息
 *   sidebar — 左侧栏
 *   chat    — 聊天区 + 工具调用
 *   cc      — 中控区（输入栏、状态栏、EKG）
 *   right   — 右侧栏
 */

import type { ThemeSettings } from './store'

// ── 区域字段映射 ────────────────────────────────────────────────

export const ZONE_FIELDS: Record<string, (keyof ThemeSettings)[]> = {
  global: [
    'transparency', 'bgBlur', 'globalFont', 'globalFontSize', 'globalBgImage',
    'globalBgColor', 'uiScheme',
    'userName', 'userPrefix', 'userColor',
  ],
  sidebar: [
    'sidebarBg', 'sidebarBgImage', 'sidebarWidth',
    'sidebarTransparency', 'sidebarBlur',
    'sidebarTextColor', 'sidebarNameSize', 'sidebarGroupSize',
  ],
  chat: [
    'chatBg', 'chatBgImage', 'chatTransparency', 'chatBlur',
    'chatFont', 'chatFontSize', 'chatLineHeight',
    'chatTextColor', 'chatCodeColor', 'chatCodeBg',
    'toolOk', 'toolRun', 'toolErr',
    'toolNameColor', 'toolSummaryColor',
    'userTagBg', 'userTagText',
    'toolIndicator', 'toolIndicatorGlow', 'toolIndicatorGlowColor',
    'toolConnectorMode', 'toolConnectorColor',
    'sparkles', 'spinnerColor', 'spinnerSize',
    'msgStyle', 'msgFont', 'msgTextColor', 'msgLineHeight',
  ],
  cc: [
    'ccHeight', 'ccBgHeight', 'ccBg', 'ccBgImage',
    'ccStyle', 'ccVariant', 'ccPositions', 'ccHidden',
    'inputBg', 'inputBgImage', 'inputTextColor', 'inputPlaceholder',
    'inputSendBg', 'inputFocusBorder', 'inputFontSize', 'inputMinHeight',
    'inputMode', 'cliLineWidth', 'cliLineColor', 'cliTextColor',
    'statusBg', 'statusBgImage',
    'ekgWidth', 'ekgFontSize',
    'ekgGreen', 'ekgYellow', 'ekgRed',
    'ekgLineWidth', 'ekgAmplitudeMax', 'ekgSpeedBase', 'ekgSpeedMax',
    'ekgLeftColor', 'ekgMovingColor', 'ekgConsumedColor',
    'tokenDisplay',
    'pillBg', 'pillText', 'prismOnColor',
    'modelVariant', 'modeVariant', 'sendVariant', 'attachVariant',
  ],
  right: [
    'rightBg', 'rightBgImage', 'rightWidth',
    'rightTransparency', 'rightBlur',
  ],
}

// ── 预设定义 ─────────────────────────────────────────────────────

export type PresetName = 'claude' | 'glass' | 'nord'

export interface GlobalPreset {
  name: PresetName
  label: string
  theme: Partial<ThemeSettings>
}

export const GLOBAL_PRESETS: GlobalPreset[] = [
  // ── Claude Code ──────────────────────────────────────────────
  {
    name: 'claude',
    label: 'Claude Code',
    theme: {
      // global
      transparency: 0.97, bgBlur: 4, globalFont: 'mono', globalFontSize: 15,
      globalBgImage: '', globalBgColor: '#121111', uiScheme: 'dark',
      userName: '', userPrefix: '❯', userColor: '#60a5fa',

      // sidebar
      sidebarBg: '#161622', sidebarBgImage: '', sidebarWidth: 240,
      sidebarTransparency: 1, sidebarBlur: 0,
      sidebarTextColor: '#a0a8c0', sidebarNameSize: 13, sidebarGroupSize: 11,

      // chat
      chatBg: 'transparent', chatBgImage: '', chatTransparency: 1, chatBlur: 0,
      chatFont: 'mono', chatFontSize: 16.5, chatLineHeight: 1.7,
      chatTextColor: '#cdd6f4', chatCodeColor: '#f9c74f', chatCodeBg: 'rgba(255,255,255,0.04)',
      toolOk: '#4ade80', toolRun: '#60a5fa', toolErr: '#f87171',
      toolNameColor: '#94a3b8', toolSummaryColor: 'rgba(148,163,184,0.5)',
      userTagBg: 'rgba(96,165,250,0.10)', userTagText: '#93c5fd',
      toolIndicator: '●', toolIndicatorGlow: 4, toolIndicatorGlowColor: '',
      toolConnectorMode: 'follow', toolConnectorColor: '#334155',
      sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊', spinnerColor: '#f4b915', spinnerSize: 13,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.7,

      // cc
      ccHeight: 130, ccBgHeight: 130, ccBg: 'rgba(13,13,20,0.92)', ccBgImage: '',
      ccStyle: 'bar', ccVariant: 'terminal',
      barTrackColor: '#353117', barFillColor: '#4EBA65', barFillFollow: true, barHeight: 10,
      ccPositions: {
        input:   { x: 0,  y: 0,  w: 100, h: 52 },
        ekg:     { x: 0,  y: 65, w: 30, h: 28 },
        pct:     { x: 32, y: 69, w: 8,  h: 20 },
        tokens:  { x: 41, y: 69, w: 16, h: 20 },
        model:   { x: 58, y: 69, w: 18, h: 20 },
        mode:    { x: 77, y: 69, w: 10, h: 20 },
        send:    { x: 89, y: 69, w: 5,  h: 20 },
        attach:  { x: 95, y: 69, w: 4,  h: 20 },
      },
      inputBg: 'rgba(255,255,255,0.03)', inputBgImage: '',
      inputTextColor: '#cdd6f4', inputPlaceholder: 'rgba(205,214,244,0.2)',
      inputSendBg: 'rgba(96,165,250,0.12)', inputFocusBorder: 'rgba(96,165,250,0.3)',
      inputFontSize: 14, inputMinHeight: 52,
      inputMode: 'cli', cliLineWidth: 2, cliLineColor: '#d0880b', cliTextColor: '#cdd6f4', cliLinePadding: 2,
      ccHidden: ['send', 'attach'],
      statusBg: 'transparent', statusBgImage: '',
      ekgWidth: 140, ekgFontSize: 13,
      ekgGreen: '#4ade80', ekgYellow: '#fbbf24', ekgRed: '#f87171',
      ekgLineWidth: 2, ekgAmplitudeMax: 14, ekgSpeedBase: 0.6, ekgSpeedMax: 3.5,
      ekgLeftColor: 'rgba(205,214,244,0.25)', ekgMovingColor: '', ekgConsumedColor: 'rgba(205,214,244,0.06)',
      tokenDisplay: 'ekg',
      pillBg: 'rgba(255,255,255,0.05)', pillText: 'rgba(205,214,244,0.6)', prismOnColor: '#4ade80',
      modelVariant: 'minimal', modeVariant: 'badge', sendVariant: 'minimal', attachVariant: 'minimal',

      // right
      rightBg: '#161622', rightBgImage: '', rightWidth: 260,
      rightTransparency: 1, rightBlur: 0,
    },
  },

  // ── Glass Light ──────────────────────────────────────────────
  {
    name: 'glass',
    label: 'Glass Light',
    theme: {
      transparency: 0.85, bgBlur: 16, globalFont: 'system', globalFontSize: 18,
      globalBgImage: '', globalBgColor: '#e8e8ec', uiScheme: 'light',
      userName: '', userPrefix: '❯', userColor: '',

      sidebarBg: 'rgba(0,0,0,0.02)', sidebarBgImage: '', sidebarWidth: 250,
      sidebarTransparency: 1, sidebarBlur: 0,
      sidebarTextColor: 'rgba(0,0,0,0.85)', sidebarNameSize: 14, sidebarGroupSize: 12,

      chatBg: '', chatBgImage: '', chatTransparency: 1, chatBlur: 0,
      chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.4,
      chatTextColor: 'rgba(0,0,0,0.85)', chatCodeColor: '#b47814', chatCodeBg: 'rgba(0,0,0,0.03)',
      toolOk: '#1e9646', toolRun: '#3b82f6', toolErr: '#be2828',
      toolNameColor: 'rgba(0,0,0,0.85)', toolSummaryColor: 'rgba(0,0,0,0.4)',
      userTagBg: 'rgba(168,85,247,0.08)', userTagText: '#a855f7',
      toolIndicator: '●', toolIndicatorGlow: 0, toolIndicatorGlowColor: '',
      toolConnectorMode: 'follow', toolConnectorColor: 'rgba(0,0,0,0.25)',
      sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊', spinnerColor: '', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.8,

      ccHeight: 120, ccBgHeight: 120, ccBg: 'transparent', ccBgImage: '',
      ccStyle: 'wave', ccVariant: 'glass',
      ccPositions: {
        input:   { x: 3,  y: 3,  w: 94, h: 55 },
        ekg:     { x: 3,  y: 67, w: 30, h: 14 },
        pct:     { x: 35, y: 70, w: 8,  h: 12 },
        tokens:  { x: 44, y: 70, w: 16, h: 12 },
        model:   { x: 62, y: 70, w: 20, h: 12 },
        mode:    { x: 83, y: 70, w: 10, h: 12 },
        send:    { x: 87, y: 24, w: 6,  h: 12 },
        attach:  { x: 94, y: 24, w: 5,  h: 12 },
      },
      inputBg: 'rgba(0,0,0,0.02)', inputBgImage: '',
      inputTextColor: 'rgba(0,0,0,0.85)', inputPlaceholder: 'rgba(0,0,0,0.28)',
      inputSendBg: 'rgba(0,0,0,0.10)', inputFocusBorder: 'rgba(0,0,0,0.22)',
      inputFontSize: 17, inputMinHeight: 56,
      inputMode: 'default', cliLineWidth: 2, cliLineColor: '', cliTextColor: '',
      statusBg: 'transparent', statusBgImage: '',
      ekgWidth: 150, ekgFontSize: 16,
      ekgGreen: '#1e9646', ekgYellow: '#b47814', ekgRed: '#be2828',
      ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2.0,
      ekgLeftColor: 'rgba(0,0,0,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(0,0,0,0.08)',
      tokenDisplay: 'ekg',
      pillBg: 'rgba(0,0,0,0.04)', pillText: 'rgba(0,0,0,0.65)', prismOnColor: '#1e9646',
      modelVariant: 'dropdown', modeVariant: 'pill', sendVariant: 'icon', attachVariant: 'icon',

      rightBg: 'rgba(0,0,0,0.02)', rightBgImage: '', rightWidth: 260,
      rightTransparency: 1, rightBlur: 0,
    },
  },

  // ── Nord Frost ───────────────────────────────────────────────
  {
    name: 'nord',
    label: 'Nord Frost',
    theme: {
      transparency: 0.95, bgBlur: 8, globalFont: 'system', globalFontSize: 17,
      globalBgImage: '', globalBgColor: '#242933', uiScheme: 'dark',
      userName: '', userPrefix: '❯', userColor: '',

      sidebarBg: '#2e3440', sidebarBgImage: '', sidebarWidth: 250,
      sidebarTransparency: 1, sidebarBlur: 0,
      sidebarTextColor: '#d8dee9', sidebarNameSize: 14, sidebarGroupSize: 12,

      chatBg: '#242933', chatBgImage: '', chatTransparency: 1, chatBlur: 0,
      chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.6,
      chatTextColor: '#d8dee9', chatCodeColor: '#ebcb8b', chatCodeBg: 'rgba(255,255,255,0.04)',
      toolOk: '#a3be8c', toolRun: '#81a1c1', toolErr: '#bf616a',
      toolNameColor: '#d8dee9', toolSummaryColor: 'rgba(216,222,233,0.4)',
      userTagBg: 'rgba(180,142,173,0.15)', userTagText: '#b48ead',
      toolIndicator: '●', toolIndicatorGlow: 2, toolIndicatorGlowColor: '',
      toolConnectorMode: 'fixed', toolConnectorColor: '#3b4252',
      sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊', spinnerColor: '', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.8,

      ccHeight: 120, ccBgHeight: 120, ccBg: '#2e3440', ccBgImage: '',
      ccStyle: 'wave', ccVariant: 'terminal',
      ccPositions: {
        input:   { x: 3,  y: 3,  w: 94, h: 55 },
        ekg:     { x: 3,  y: 67, w: 30, h: 14 },
        pct:     { x: 35, y: 70, w: 8,  h: 12 },
        tokens:  { x: 44, y: 70, w: 16, h: 12 },
        model:   { x: 62, y: 70, w: 20, h: 12 },
        mode:    { x: 83, y: 70, w: 10, h: 12 },
        send:    { x: 87, y: 24, w: 6,  h: 12 },
        attach:  { x: 94, y: 24, w: 5,  h: 12 },
      },
      inputBg: 'rgba(255,255,255,0.04)', inputBgImage: '',
      inputTextColor: '#d8dee9', inputPlaceholder: 'rgba(216,222,233,0.28)',
      inputSendBg: 'rgba(216,222,233,0.1)', inputFocusBorder: 'rgba(136,192,208,0.4)',
      inputFontSize: 17, inputMinHeight: 56,
      inputMode: 'default', cliLineWidth: 2, cliLineColor: '#88c0d0', cliTextColor: '#d8dee9',
      statusBg: '#2e3440', statusBgImage: '',
      ekgWidth: 150, ekgFontSize: 16,
      ekgGreen: '#a3be8c', ekgYellow: '#ebcb8b', ekgRed: '#bf616a',
      ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2.0,
      ekgLeftColor: 'rgba(216,222,233,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(216,222,233,0.08)',
      tokenDisplay: 'ekg',
      pillBg: 'rgba(255,255,255,0.04)', pillText: 'rgba(216,222,233,0.65)', prismOnColor: '#a3be8c',
      modelVariant: 'dropdown', modeVariant: 'pill', sendVariant: 'icon', attachVariant: 'icon',

      rightBg: '#2e3440', rightBgImage: '', rightWidth: 260,
      rightTransparency: 1, rightBlur: 0,
    },
  },
]

/** 从预设里提取指定 zone 的字段子集 */
export function pickZoneFields(
  theme: Partial<ThemeSettings>,
  zone: string,
): Partial<ThemeSettings> {
  const fields = ZONE_FIELDS[zone] ?? []
  const out: any = {}
  for (const f of fields) {
    if (f in theme) out[f] = (theme as any)[f]
  }
  return out
}
