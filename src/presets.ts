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
import { ZONE_FIELDS } from './themeFields.ts'

// ── 区域字段映射 ────────────────────────────────────────────────
// 单一真值表在 themeFields.ts；本文件仅 re-export，保证旧导入路径不变。

export { ZONE_FIELDS }

// ── 预设定义 ─────────────────────────────────────────────────────

export type PresetName = 'claude' | 'glass' | 'nord' | 'tokyo' | 'solarized' | 'amber'

export interface GlobalPreset {
  name: PresetName
  label: string
  theme: Partial<ThemeSettings>
}

export const GLOBAL_PRESETS: GlobalPreset[] = [
  // ── Claude 风格 ──────────────────────────────────────────────
  {
    name: 'claude',
    label: 'Claude 风格',
    theme: {
      // global
      accent: '#D77757',
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
      // 语法高亮：CC 终端式暖色系（黑底可读，品牌橙打底）
      synKeyword: '#e5a75b', synString: '#d4c05a', synComment: '#8a9199', synLiteral: '#e0964e',
      synEntity: '#d7ba7d', synFunction: '#8fa1b3', synVariable: '#c9d1d9', synProperty: '#c9d1d9',
      synRegex: '#e0964e', synMarkupHeading: '#61afef', synCoReference: '#8a9199', synSupport: '#8fa1b3',
      toolOk: '#4EBA65', toolRun: '#93A5FF', toolErr: '#FF6B80',
      toolNameColor: '#4EBA65', toolSummaryColor: '#999999',
      userTagBg: 'transparent', userTagText: '#FFFFFF',
      toolIndicator: '●', toolIndicatorGlow: 0, toolIndicatorGlowColor: '',
      toolConnectorMode: 'none', toolConnectorColor: '#505050',
      spinnerFramePreset: 'sparkles', spinnerColor: '#D77757', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '#FFFFFF', msgLineHeight: 1.5,
      messageLayout: 'claude', footerLayout: 'peri', cliOverflowMode: 'fixed-scroll',
      // CC 视觉还原：助手 ● 圆点、Bash 灰底
      assistantDot: true, assistantDotGlyph: '●', assistantDotColor: '',
      bashBg: '#41414a',

      // cc
      ccHeight: 76, ccBgHeight: 76, ccBg: '#000000', ccBgImage: '', ccStatusFontSize: 14,
      ccStyle: 'numeric', ccVariant: 'terminal',
      barTrackColor: '#353117', barFillColor: '#4EBA65', barFillFollow: true, barHeight: 10,
      inputBg: 'transparent', inputBgImage: '',
      inputTextColor: '#FFFFFF', inputPlaceholder: '#999999',
      inputSendBg: 'transparent', inputFocusBorder: '#505050',
      inputFontSize: 15, inputMinHeight: 56,
      inputMode: 'cli', cliLineWidth: 1, cliLineColor: '#888888', cliTextColor: '#FFFFFF', cliPromptColor: '#999999', cliLinePadding: 3, cliContentOffsetY: 0, cliHintMode: 'full',
      ccHidden: ['send', 'attach'],
      ccScale: { ekg: 90, pct: 90, tokens: 90, model: 90, mode: 90 },
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
      accent: '#6366f1',
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
      spinnerFramePreset: 'clock', spinnerColor: '#f59e0b', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'system', msgTextColor: '', msgLineHeight: 1.75,
      messageLayout: 'classic', footerLayout: 'free', cliOverflowMode: 'fixed-scroll',

      // cc — 亮色玻璃工作台
      ccHeight: 96, ccBgHeight: 96, ccBg: 'rgba(255,255,255,0.20)', ccBgImage: '', ccStatusFontSize: 14,
      ccStyle: 'bar', ccVariant: 'pill',
      barTrackColor: 'rgba(0,0,0,0.06)', barFillColor: '#22c55e', barFillFollow: true, barHeight: 10,
      inputBg: 'rgba(0,0,0,0.03)', inputBgImage: '',
      inputTextColor: 'rgba(0,0,0,0.80)', inputPlaceholder: 'rgba(0,0,0,0.22)',
      inputSendBg: 'rgba(99,102,241,0.12)', inputFocusBorder: 'rgba(99,102,241,0.35)',
      inputFontSize: 15, inputMinHeight: 52,
      inputMode: 'cli', cliLineWidth: 1, cliLineColor: '#9a9a9a', cliTextColor: 'rgba(0,0,0,0.80)', cliPromptColor: '#6b7280', cliLinePadding: 3, cliContentOffsetY: 0, cliHintMode: 'full',
      ccHidden: ['send', 'attach'],
      ccScale: { ekg: 105, pct: 105, tokens: 100, model: 100, mode: 100 },
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
      accent: '#88c0d0',
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
      spinnerFramePreset: 'sparkles', spinnerColor: '#88c0d0', spinnerSize: 13,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.7,
      messageLayout: 'classic', footerLayout: 'free', cliOverflowMode: 'fixed-scroll',

      // cc — 冰蓝开发终端
      ccHeight: 96, ccBgHeight: 96, ccBg: '#252838', ccBgImage: '', ccStatusFontSize: 14,
      ccStyle: 'bar', ccVariant: 'terminal',
      barTrackColor: 'rgba(136,192,208,0.10)', barFillColor: '#88c0d0', barFillFollow: true, barHeight: 10,
      inputBg: 'rgba(255,255,255,0.03)', inputBgImage: '',
      inputTextColor: '#e5e9f0', inputPlaceholder: 'rgba(229,233,240,0.20)',
      inputSendBg: 'rgba(136,192,208,0.15)', inputFocusBorder: 'rgba(136,192,208,0.45)',
      inputFontSize: 15, inputMinHeight: 52,
      inputMode: 'cli', cliLineWidth: 1, cliLineColor: '#7f8ea3', cliTextColor: '#e5e9f0', cliPromptColor: '#9aa7bd', cliLinePadding: 3, cliContentOffsetY: 0, cliHintMode: 'full',
      ccHidden: ['send', 'attach'],
      ccScale: { ekg: 100, pct: 95, tokens: 95, model: 95, mode: 95 },
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
  {
    name: 'tokyo', label: 'Tokyo Night', theme: {
      accent: '#7aa2f7',
      transparency: 1, bgBlur: 0, globalFont: 'mono', globalFontSize: 15, globalBgImage: '', globalBgColor: '#1a1b26', uiScheme: 'dark', userName: '', userPrefix: '❯', userColor: '#bb9af7',
      sidebarBg: '#16161e', sidebarBgImage: '', sidebarWidth: 240, sidebarTransparency: 1, sidebarBlur: 0, sidebarTextColor: '#a9b1d6', sidebarNameSize: 13, sidebarGroupSize: 11,
      chatBg: '#1a1b26', chatBgImage: '', chatTransparency: 1, chatBlur: 0, chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.6, chatTextColor: '#c0caf5', chatCodeColor: '#e0af68', chatCodeBg: 'rgba(122,162,247,0.06)',
      toolOk: '#9ece6a', toolRun: '#7aa2f7', toolErr: '#f7768e', toolNameColor: '#7dcfff', toolSummaryColor: '#565f89', userTagBg: '#24283b', userTagText: '#bb9af7', toolIndicator: '●', toolIndicatorGlow: 0, toolIndicatorGlowColor: '', toolConnectorMode: 'none', toolConnectorColor: '#414868', spinnerFramePreset: 'clock', spinnerColor: '#bb9af7', spinnerSize: 14, msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '#c0caf5', msgLineHeight: 1.6, messageLayout:'classic',footerLayout:'free',cliOverflowMode:'fixed-scroll',
      ccHeight: 96, ccBgHeight: 96, ccBg: '#1a1b26', ccBgImage: '', ccStatusFontSize: 14, ccStyle: 'numeric', ccVariant: 'terminal', ccHidden: ['send','attach'], ccScale: { pct:95,tokens:95,model:95,mode:95 },
      inputBg:'transparent',inputBgImage:'',inputTextColor:'#c0caf5',inputPlaceholder:'#565f89',inputSendBg:'transparent',inputFocusBorder:'#7aa2f7',inputFontSize:15,inputMinHeight:56,inputMode:'cli',cliLineWidth:1,cliLineColor:'#565f89',cliTextColor:'#c0caf5',cliPromptColor:'#7f89b0',cliLinePadding:3,cliContentOffsetY:0,cliHintMode:'full',
      statusBg:'transparent',statusBgImage:'',ekgWidth:140,ekgFontSize:13,ekgGreen:'#9ece6a',ekgYellow:'#e0af68',ekgRed:'#f7768e',ekgLineWidth:2,ekgAmplitudeMax:10,ekgSpeedBase:.5,ekgSpeedMax:2.5,ekgLeftColor:'#414868',ekgMovingColor:'',ekgConsumedColor:'#24283b',barTrackColor:'#24283b',barFillColor:'#7aa2f7',barFillFollow:true,barHeight:8,tokenDisplay:'ekg',pillBg:'#24283b',pillText:'#a9b1d6',prismOnColor:'#9ece6a',modelVariant:'minimal',modeVariant:'minimal',sendVariant:'minimal',attachVariant:'minimal',
      rightBg:'#16161e',rightBgImage:'',rightWidth:260,rightTransparency:1,rightBlur:0,
    }
  },
  {
    name: 'solarized', label: 'Solarized Light', theme: {
      accent:'#268bd2',
      transparency:1,bgBlur:0,globalFont:'mono',globalFontSize:15,globalBgImage:'',globalBgColor:'#fdf6e3',uiScheme:'light',userName:'',userPrefix:'❯',userColor:'#268bd2',
      sidebarBg:'#eee8d5',sidebarBgImage:'',sidebarWidth:240,sidebarTransparency:1,sidebarBlur:0,sidebarTextColor:'#586e75',sidebarNameSize:13,sidebarGroupSize:11,
      chatBg:'#fdf6e3',chatBgImage:'',chatTransparency:1,chatBlur:0,chatFont:'mono',chatFontSize:15,chatLineHeight:1.6,chatTextColor:'#657b83',chatCodeColor:'#b58900',chatCodeBg:'rgba(38,139,210,.06)',toolOk:'#859900',toolRun:'#268bd2',toolErr:'#dc322f',toolNameColor:'#268bd2',toolSummaryColor:'#93a1a1',userTagBg:'#eee8d5',userTagText:'#268bd2',toolIndicator:'●',toolIndicatorGlow:0,toolIndicatorGlowColor:'',toolConnectorMode:'none',toolConnectorColor:'#93a1a1',spinnerFramePreset:'wave',spinnerColor:'#b58900',spinnerSize:14,msgStyle:'terminal',msgFont:'mono',msgTextColor:'#657b83',msgLineHeight:1.6,messageLayout:'classic',footerLayout:'free',cliOverflowMode:'fixed-scroll',
      ccHeight:96,ccBgHeight:96,ccBg:'#fdf6e3',ccBgImage:'',ccStatusFontSize:14,ccStyle:'numeric',ccVariant:'terminal',ccHidden:['send','attach'],ccScale:{pct:95,tokens:95,model:95,mode:95},inputBg:'transparent',inputBgImage:'',inputTextColor:'#657b83',inputPlaceholder:'#93a1a1',inputSendBg:'transparent',inputFocusBorder:'#268bd2',inputFontSize:15,inputMinHeight:56,inputMode:'cli',cliLineWidth:1,cliLineColor:'#93a1a1',cliTextColor:'#657b83',cliPromptColor:'#657b83',cliLinePadding:3,cliContentOffsetY:0,cliHintMode:'full',statusBg:'transparent',statusBgImage:'',ekgWidth:140,ekgFontSize:13,ekgGreen:'#859900',ekgYellow:'#b58900',ekgRed:'#dc322f',ekgLineWidth:2,ekgAmplitudeMax:10,ekgSpeedBase:.5,ekgSpeedMax:2.5,ekgLeftColor:'#93a1a1',ekgMovingColor:'',ekgConsumedColor:'#eee8d5',barTrackColor:'#eee8d5',barFillColor:'#268bd2',barFillFollow:true,barHeight:8,tokenDisplay:'ekg',pillBg:'#eee8d5',pillText:'#586e75',prismOnColor:'#859900',modelVariant:'minimal',modeVariant:'minimal',sendVariant:'minimal',attachVariant:'minimal',rightBg:'#eee8d5',rightBgImage:'',rightWidth:260,rightTransparency:1,rightBlur:0,
    }
  },
  {
    name:'amber',label:'Amber CRT',theme:{
      accent:'#ffb000',
      transparency:1,bgBlur:0,globalFont:'mono',globalFontSize:15,globalBgImage:'',globalBgColor:'#120b00',uiScheme:'dark',userName:'',userPrefix:'>',userColor:'#ffb000',sidebarBg:'#120b00',sidebarBgImage:'',sidebarWidth:240,sidebarTransparency:1,sidebarBlur:0,sidebarTextColor:'#cc8c00',sidebarNameSize:13,sidebarGroupSize:11,      chatBg:'#120b00',chatBgImage:'',chatTransparency:1,chatBlur:0,chatFont:'mono',chatFontSize:15,chatLineHeight:1.55,chatTextColor:'#ffcc55',chatCodeColor:'#ffe0a3',chatCodeBg:'transparent',toolOk:'#ffc24b',toolRun:'#ffb000',toolErr:'#ff6b35',toolNameColor:'#ffb000',toolSummaryColor:'#9b6b00',userTagBg:'#2b1900',userTagText:'#ffcc55',toolIndicator:'■',toolIndicatorGlow:3,toolIndicatorGlowColor:'#ffb000',toolConnectorMode:'none',toolConnectorColor:'#5c3900',spinnerFramePreset:'orbit',spinnerColor:'#ffb000',spinnerSize:14,msgStyle:'terminal',msgFont:'mono',msgTextColor:'#ffcc55',msgLineHeight:1.55,messageLayout:'classic',footerLayout:'free',cliOverflowMode:'fixed-scroll',
      ccHeight:96,ccBgHeight:96,ccBg:'#120b00',ccBgImage:'',ccStatusFontSize:14,ccStyle:'numeric',ccVariant:'terminal',ccHidden:['send','attach'],ccScale:{pct:95,tokens:95,model:95,mode:95},inputBg:'transparent',inputBgImage:'',inputTextColor:'#ffcc55',inputPlaceholder:'#7a5200',inputSendBg:'transparent',inputFocusBorder:'#ffb000',inputFontSize:15,inputMinHeight:56,inputMode:'cli',cliLineWidth:1,cliLineColor:'#9b6b00',cliTextColor:'#ffcc55',cliPromptColor:'#cc8c00',cliLinePadding:3,cliContentOffsetY:0,cliHintMode:'full',statusBg:'transparent',statusBgImage:'',ekgWidth:140,ekgFontSize:13,ekgGreen:'#ffc24b',ekgYellow:'#ffb000',ekgRed:'#ff6b35',ekgLineWidth:2,ekgAmplitudeMax:10,ekgSpeedBase:.5,ekgSpeedMax:2.5,ekgLeftColor:'#9b6b00',ekgMovingColor:'',ekgConsumedColor:'#2b1900',barTrackColor:'#2b1900',barFillColor:'#ffb000',barFillFollow:true,barHeight:8,tokenDisplay:'ekg',pillBg:'#2b1900',pillText:'#cc8c00',prismOnColor:'#ffc24b',modelVariant:'minimal',modeVariant:'minimal',sendVariant:'minimal',attachVariant:'minimal',rightBg:'#120b00',rightBgImage:'',rightWidth:260,rightTransparency:1,rightBlur:0,
    }
  },
]

/** 从预设里提取指定 zone 的字段子集 */
export function pickZoneFields(
  theme: Partial<ThemeSettings>,
  zone: string,
): Partial<ThemeSettings> {
  const fields = ZONE_FIELDS[zone] ?? []
  return Object.fromEntries(
    fields.filter((f): f is keyof ThemeSettings => f in theme).map(f => [f, theme[f]]),
  ) as Partial<ThemeSettings>
}
