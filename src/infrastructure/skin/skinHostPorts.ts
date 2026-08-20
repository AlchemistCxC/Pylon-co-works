import { invoke } from '@tauri-apps/api/core'
import { join, tempDir } from '@tauri-apps/api/path'
import type { SkinCommandPorts } from '../../plugin-runtime/skin/skinCommandApi.ts'
import type { CaptureOptions, CaptureResult, ComputedSkinInspection } from '../../plugin-runtime/skin/skinTypes.ts'
import type { SkinRuntime } from '../../plugin-runtime/skin/skinRuntime.ts'

function activePreview(runtime: SkinRuntime, previewId: string) {
  const preview = runtime.getSnapshot().activePreview
  return preview?.previewId === previewId ? preview : null
}

function inspectedElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-pylon-surface="app"]')
    ?? document.getElementById('root')
    ?? document.body
}

function inspectComputed(runtime: SkinRuntime, previewId: string): ComputedSkinInspection {
  const preview = activePreview(runtime, previewId)
  if (!preview) return { supported: false, previewId, error: 'preview 不存在或不是 active' }
  const element = inspectedElement()
  if (!element) return { supported: false, previewId, error: 'Application surface 不存在' }
  const style = getComputedStyle(element)
  return {
    supported: true,
    previewId,
    target: preview.target,
    computedStyle: Object.fromEntries(
      Object.values(runtime.schemaSnapshot().fields)
        .map(field => field.cssVar)
        .filter((name): name is string => Boolean(name))
        .map(name => [name, style.getPropertyValue(name).trim()]),
    ),
    dataAttributes: Object.fromEntries(
      [...element.attributes]
        .filter(attribute => attribute.name.startsWith('data-'))
        .map(attribute => [attribute.name, attribute.value]),
    ),
  }
}

interface NativeCaptureResult {
  artifactRef: string
  mime: string
  width: number
  height: number
}

async function capture(runtime: SkinRuntime, previewId: string, options: CaptureOptions = {}): Promise<CaptureResult> {
  if (!activePreview(runtime, previewId)) {
    return { supported: false, status: 'error', previewId, error: 'preview 不存在或不是 active' }
  }
  const format = options.format ?? 'png'
  try {
    const artifactPath = options.artifactPath
      ?? await join(await tempDir(), `pylon-skin-${previewId.replace(/[^A-Za-z0-9._-]/g, '_')}.${format}`)
    const result = await invoke<NativeCaptureResult>('pylon_window_capture', { artifactPath, format })
    return {
      supported: true,
      status: 'captured',
      previewId,
      artifactRef: result.artifactRef,
      mime: result.mime,
    }
  } catch (error) {
    return {
      supported: true,
      status: 'error',
      previewId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function createSkinHostPorts(runtime: SkinRuntime): SkinCommandPorts {
  return {
    inspectionPort: { inspectComputed: previewId => inspectComputed(runtime, previewId) },
    capturePort: { capture: (previewId, options) => capture(runtime, previewId, options) },
  }
}
