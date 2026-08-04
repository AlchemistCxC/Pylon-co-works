import { convertFileSrc } from '@tauri-apps/api/core'
import { hasTauriRuntime, type TauriWindow } from './infrastructure/tauri/env.ts'

export interface BackgroundImageResult {
  source: string | null
  cssValue: string
  error: string | null
}

type LocalPathConverter = (path: string) => string
const PASSTHROUGH_SCHEME = /^(?:https?:|data:|blob:|asset:|file:)/i
const WINDOWS_LOCAL_PATH = /^(?:[a-z]:[\\/]|\\\\)/i
const POSIX_LOCAL_PATH = /^\//

function defaultLocalPathConverter(path: string): string {
  if (typeof window === 'undefined' || !hasTauriRuntime(window as Window & TauriWindow)) {
    throw new Error('本地文件路径只能在 Tauri 窗口中加载')
  }
  return convertFileSrc(path)
}

function asCssUrl(source: string): string {
  return `url(${JSON.stringify(source)})`
}

/**
 * 将主题中保存的背景图值解析为 WebView 可加载资源。
 * Store 始终保留原始路径；仅渲染时转换，确保重启后仍可重新生成 asset URL。
 */
export function resolveBackgroundImage(
  value: string | null | undefined,
  convertLocalPath: LocalPathConverter = defaultLocalPathConverter,
): BackgroundImageResult {
  const raw = value?.trim() || ''
  if (!raw) return { source: null, cssValue: 'none', error: null }

  try {
    const source = PASSTHROUGH_SCHEME.test(raw)
      ? raw
      : WINDOWS_LOCAL_PATH.test(raw) || POSIX_LOCAL_PATH.test(raw)
        ? convertLocalPath(raw)
        : raw

    if (!source) throw new Error('资源地址为空')
    return { source, cssValue: asCssUrl(source), error: null }
  } catch (error) {
    return {
      source: null,
      cssValue: 'none',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function toCssBackgroundImage(value: string | null | undefined): string {
  return resolveBackgroundImage(value).cssValue
}
