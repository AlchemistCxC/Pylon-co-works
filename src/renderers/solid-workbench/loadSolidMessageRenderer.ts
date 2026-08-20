type SolidMessageRendererModule = {
  SolidMessageRendererRow: unknown
}

const rendererModules = typeof import.meta.glob === 'function'
  ? import.meta.glob<SolidMessageRendererModule>('./chat/MessageRendererRow.solid.tsx')
  : {}

/** Keep the React TypeScript project from compiling Solid JSX with React's JSX types. */
export async function loadSolidMessageRendererComponent(): Promise<unknown> {
  const load = rendererModules['./chat/MessageRendererRow.solid.tsx']
  if (!load) throw new Error('Solid message renderer module 未进入构建图')
  const module = await load()
  if (!module.SolidMessageRendererRow) throw new Error('SolidMessageRendererRow 导出缺失')
  return module.SolidMessageRendererRow
}
