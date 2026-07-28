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
    'ccStyle', 'ccVariant', 'ccLayout', 'ccPositions', 'ccHidden', 'ccScale', 'ccCliCustomized', 'ccLayoutVersion',
    'inputBg', 'inputBgImage', 'inputTextColor', 'inputPlaceholder',
    'inputSendBg', 'inputFocusBorder', 'inputFontSize', 'inputMinHeight',
    'inputMode', 'cliLineWidth', 'cliLineColor', 'cliTextColor', 'cliLinePadding',
    'statusBg', 'statusBgImage',
    'ekgWidth', 'ekgFontSize',
    'ekgGreen', 'ekgYellow', 'ekgRed',
    'ekgLineWidth', 'ekgAmplitudeMax', 'ekgSpeedBase', 'ekgSpeedMax',
    'ekgLeftColor', 'ekgMovingColor', 'ekgConsumedColor',
    'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight',
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
  // ── Claude 风格 ──────────────────────────────────────────────
  {
    name: 'claude',
    label: 'Claude Code',
    theme: {
      // global
      transparency: 1, bgBlur: 0, globalFont: 'mono', globalFontSize: 15,
      globalBgImage: '', globalBgColor: '#000000', uiScheme: 'dark',
      userName: '', userPrefix: '❯', userColor: '#D77757',

      // sidebar
      sidebarBg: '#000000', sidebarBgImage: '', sidebarWidth: 240,
      sidebarTransparency: 1, sidebarBlur: 0,
      sidebarTextColor: '#999999', sidebarNameSize: 13, sidebarGroupSize: 11,

      // chat
      chatBg: '#000000', chatBgImage: '', chatTransparency: 1, chatBlur: 0,
      chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.5,
      chatTextColor: '#FFFFFF', chatCodeColor: '#FFC107', chatCodeBg: 'transparent',
      toolOk: '#4EBA65', toolRun: '#93A5FF', toolErr: '#FF6B80',
      toolNameColor: '#4EBA65', toolSummaryColor: '#999999',
      userTagBg: '#373737', userTagText: '#FFFFFF',
      toolIndicator: '●', toolIndicatorGlow: 0, toolIndicatorGlowColor: '',
      toolConnectorMode: 'none', toolConnectorColor: '#505050',
      sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊✼✻✺✸', spinnerColor: '#D77757', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '#FFFFFF', msgLineHeight: 1.5,

      // cc
      ccHeight: 150, ccBgHeight: 150, ccBg: '#000000', ccBgImage: '',
      ccStyle: 'numeric', ccVariant: 'terminal',
      barTrackColor: '#353117', barFillColor: '#4EBA65', barFillFollow: true, barHeight: 10,
      ccPositions: {
        input:   { x: 0,  y: 0,  w: 100, h: 52 },
        ekg:     { x: 0,  y: 59 },
        pct:     { x: 14, y: 55 },
        tokens:  { x: 9,  y: 55 },
        model:   { x: 17, y: 55 },
        mode:    { x: 29, y: 54 },
        send:    { x: 89, y: 69 },
        attach:  { x: 95, y: 69 },
      },
      inputBg: 'transparent', inputBgImage: '',
      inputTextColor: '#FFFFFF', inputPlaceholder: '#999999',
      inputSendBg: 'transparent', inputFocusBorder: '#505050',
      inputFontSize: 17, inputMinHeight: 56,
      inputMode: 'cli', cliLineWidth: 1, cliLineColor: '#999999', cliTextColor: '#FFFFFF', cliLinePadding: 4,
      ccHidden: ['send', 'attach'],
      ccScale: { ekg: 90, pct: 90, tokens: 90, model: 90, mode: 90 }, ccCliCustomized: false,
      statusBg: 'transparent', statusBgImage: '',
      ekgWidth: 140, ekgFontSize: 13,
      ekgGreen: '#4ade80', ekgYellow: '#fbbf24', ekgRed: '#f87171',
      ekgLineWidth: 2, ekgAmplitudeMax: 14, ekgSpeedBase: 0.6, ekgSpeedMax: 3.5,
      ekgLeftColor: 'rgba(205,214,244,0.25)', ekgMovingColor: '', ekgConsumedColor: 'rgba(205,214,244,0.06)',
      tokenDisplay: 'ekg',
      pillBg: 'rgba(255,255,255,0.05)', pillText: 'rgba(205,214,244,0.6)', prismOnColor: '#4ade80',
      modelVariant: 'minimal', modeVariant: 'minimal', sendVariant: 'minimal', attachVariant: 'minimal',

      // right
      rightBg: '#000000', rightBgImage: '', rightWidth: 260,
      rightTransparency: 1, rightBlur: 0,
    },
  },

  // ── Glass Light ──────────────────────────────────────────────
  {
    name: 'glass',
    label: 'Glass Light',
    theme: {
      // global — 高透毛玻璃
      transparency: 0.90, bgBlur: 24, globalFont: 'system', globalFontSize: 17,
      globalBgImage: '', globalBgColor: '#f0f0f5', uiScheme: 'light',
      userName: '', userPrefix: '❯', userColor: '#6366f1',

      // sidebar — 半透轻灰
      sidebarBg: 'rgba(245,245,250,0.55)', sidebarBgImage: '', sidebarWidth: 240,
      sidebarTransparency: 1, sidebarBlur: 0,
      sidebarTextColor: 'rgba(0,0,0,0.75)', sidebarNameSize: 13, sidebarGroupSize: 11,

      // chat — 毛玻璃聊天区
      chatBg: 'rgba(255,255,255,0.28)', chatBgImage: '', chatTransparency: 1, chatBlur: 0,
      chatFont: 'system', chatFontSize: 15, chatLineHeight: 1.65,
      chatTextColor: 'rgba(0,0,0,0.82)', chatCodeColor: '#7c3aed', chatCodeBg: 'rgba(124,58,237,0.06)',
      // 工具：柔和现代色
      toolOk: '#22c55e', toolRun: '#6366f1', toolErr: '#f43f5e',
      toolNameColor: 'rgba(0,0,0,0.75)', toolSummaryColor: 'rgba(0,0,0,0.38)',
      userTagBg: 'rgba(99,102,241,0.08)', userTagText: '#6366f1',
      toolIndicator: '●', toolIndicatorGlow: 2, toolIndicatorGlowColor: '',
      toolConnectorMode: 'follow', toolConnectorColor: 'rgba(0,0,0,0.12)',
      sparkles: '◴◷◶◵', spinnerColor: '#f59e0b', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'system', msgTextColor: '', msgLineHeight: 1.75,

      // cc — 亮色玻璃工作台
      ccHeight: 150, ccBgHeight: 150, ccBg: 'rgba(255,255,255,0.20)', ccBgImage: '',
      ccStyle: 'numeric', ccVariant: 'pill',
      barTrackColor: 'rgba(0,0,0,0.06)', barFillColor: '#22c55e', barFillFollow: true, barHeight: 10,
      ccPositions: {
        input:   { x: 0,  y: 0,  w: 100, h: 52 },
        ekg:     { x: 0,  y: 59 },
        pct:     { x: 14, y: 55 },
        tokens:  { x: 9,  y: 55 },
        model:   { x: 17, y: 55 },
        mode:    { x: 29, y: 54 },
        send:    { x: 89, y: 69 },
        attach:  { x: 95, y: 69 },
      },
      inputBg: 'rgba(0,0,0,0.03)', inputBgImage: '',
      inputTextColor: 'rgba(0,0,0,0.80)', inputPlaceholder: 'rgba(0,0,0,0.22)',
      inputSendBg: 'rgba(99,102,241,0.12)', inputFocusBorder: 'rgba(99,102,241,0.35)',
      inputFontSize: 16, inputMinHeight: 52,
      inputMode: 'cli', cliLineWidth: 2, cliLineColor: '#6366f1', cliTextColor: 'rgba(0,0,0,0.80)',
      ccHidden: ['send', 'attach'],
      ccScale: { ekg: 105, pct: 105, tokens: 100, model: 100, mode: 100 }, ccCliCustomized: false,
      statusBg: 'transparent', statusBgImage: '',
      ekgWidth: 130, ekgFontSize: 13,
      ekgGreen: '#22c55e', ekgYellow: '#f59e0b', ekgRed: '#ef4444',
      ekgLineWidth: 2, ekgAmplitudeMax: 8, ekgSpeedBase: 0.4, ekgSpeedMax: 1.8,
      ekgLeftColor: 'rgba(0,0,0,0.25)', ekgMovingColor: '', ekgConsumedColor: 'rgba(0,0,0,0.05)',
      tokenDisplay: 'ekg',
      pillBg: 'rgba(0,0,0,0.04)', pillText: 'rgba(0,0,0,0.50)', prismOnColor: '#22c55e',
      modelVariant: 'badge', modeVariant: 'pill', sendVariant: 'icon', attachVariant: 'icon',

      // right
      rightBg: 'rgba(245,245,250,0.55)', rightBgImage: '', rightWidth: 250,
      rightTransparency: 1, rightBlur: 0,
    },
  },

  // ── Nord Frost ───────────────────────────────────────────────
  {
    name: 'nord',
    label: 'Nord Frost',
    theme: {
      // global — 极光冷夜
      transparency: 0.96, bgBlur: 12, globalFont: 'mono', globalFontSize: 15,
      globalBgImage: '', globalBgColor: '#1e2130', uiScheme: 'dark',
      userName: '', userPrefix: '❯', userColor: '#88c0d0',

      // sidebar — 深空蓝灰
      sidebarBg: '#252838', sidebarBgImage: '', sidebarWidth: 240,
      sidebarTransparency: 1, sidebarBlur: 0,
      sidebarTextColor: '#c8d0e0', sidebarNameSize: 13, sidebarGroupSize: 11,

      // chat — 极夜终端
      chatBg: '#1e2130', chatBgImage: '', chatTransparency: 1, chatBlur: 0,
      chatFont: 'mono', chatFontSize: 14.5, chatLineHeight: 1.7,
      chatTextColor: '#e5e9f0', chatCodeColor: '#ebcb8b', chatCodeBg: 'rgba(136,192,208,0.06)',
      // 工具：Nord 极光色
      toolOk: '#a3be8c', toolRun: '#88c0d0', toolErr: '#bf616a',
      toolNameColor: '#e5e9f0', toolSummaryColor: 'rgba(229,233,240,0.40)',
      userTagBg: 'rgba(136,192,208,0.12)', userTagText: '#88c0d0',
      toolIndicator: '◆', toolIndicatorGlow: 3, toolIndicatorGlowColor: '',
      toolConnectorMode: 'follow', toolConnectorColor: '#4c566a',
      sparkles: '←↖↑↗→↘↓↙', spinnerColor: '#88c0d0', spinnerSize: 13,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.7,

      // cc — 冰蓝开发终端
      ccHeight: 150, ccBgHeight: 150, ccBg: '#252838', ccBgImage: '',
      ccStyle: 'bar', ccVariant: 'terminal',
      barTrackColor: 'rgba(136,192,208,0.10)', barFillColor: '#88c0d0', barFillFollow: true, barHeight: 10,
      ccPositions: {
        input:   { x: 0,  y: 0,  w: 100, h: 52 },
        ekg:     { x: 0,  y: 59 },
        pct:     { x: 14, y: 55 },
        tokens:  { x: 9,  y: 55 },
        model:   { x: 17, y: 55 },
        mode:    { x: 29, y: 54 },
        send:    { x: 89, y: 69 },
        attach:  { x: 95, y: 69 },
      },
      inputBg: 'rgba(255,255,255,0.03)', inputBgImage: '',
      inputTextColor: '#e5e9f0', inputPlaceholder: 'rgba(229,233,240,0.20)',
      inputSendBg: 'rgba(136,192,208,0.15)', inputFocusBorder: 'rgba(136,192,208,0.45)',
      inputFontSize: 16, inputMinHeight: 52,
      inputMode: 'cli', cliLineWidth: 2, cliLineColor: '#88c0d0', cliTextColor: '#e5e9f0',
      ccHidden: ['send', 'attach'],
      ccScale: { ekg: 100, pct: 95, tokens: 95, model: 95, mode: 95 }, ccCliCustomized: false,
      statusBg: 'transparent', statusBgImage: '',
      ekgWidth: 140, ekgFontSize: 13,
      ekgGreen: '#a3be8c', ekgYellow: '#ebcb8b', ekgRed: '#bf616a',
      ekgLineWidth: 2, ekgAmplitudeMax: 8, ekgSpeedBase: 0.5, ekgSpeedMax: 2.5,
      ekgLeftColor: 'rgba(136,192,208,0.20)', ekgMovingColor: '', ekgConsumedColor: 'rgba(136,192,208,0.05)',
      tokenDisplay: 'ekg',
      pillBg: 'rgba(136,192,208,0.08)', pillText: 'rgba(136,192,208,0.75)', prismOnColor: '#a3be8c',
      modelVariant: 'minimal', modeVariant: 'pill', sendVariant: 'icon', attachVariant: 'icon',

      // right
      rightBg: '#252838', rightBgImage: '', rightWidth: 250,
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
