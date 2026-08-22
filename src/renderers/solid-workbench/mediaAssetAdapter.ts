import { resolveBackgroundImage } from '../../backgroundImage.ts'
import type { MediaSourceResolverOptions } from '../../domains/rendererContent/mediaSourceResolver.ts'

/**
 * Built-in Suite adapter for canonical local media paths. Platform conversion
 * stays outside the pure resolver and uses the same guarded Tauri boundary as
 * background images.
 */
export function convertLocalMediaPath(path: string): string {
  const result = resolveBackgroundImage(path)
  if (!result.source || result.error) {
    throw new Error(result.error ?? '本地媒体路径无法转换')
  }
  return result.source
}

export const BUILTIN_MEDIA_RESOLVER_OPTIONS: MediaSourceResolverOptions = Object.freeze({
  convertLocalPath: convertLocalMediaPath,
})
