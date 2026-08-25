import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SUFFIXES = ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']

async function exists(url) {
  try {
    await stat(fileURLToPath(url))
    return true
  } catch {
    return false
  }
}

/**
 * The legacy scripts execute source modules directly under Node, while the
 * product is compiled with bundler-style extensionless relative imports.
 * Resolve only those local imports; packages and explicitly suffixed imports
 * remain under Node's normal resolver.
 */
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier)
  if (isRelative && !hasExtension) {
    for (const suffix of SUFFIXES) {
      const candidate = new URL(`${specifier}${suffix}`, context.parentURL)
      if (await exists(candidate)) return nextResolve(candidate.href, context)
    }
  }
  return nextResolve(specifier, context)
}
