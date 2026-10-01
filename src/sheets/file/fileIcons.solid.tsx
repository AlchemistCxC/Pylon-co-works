import {
  Braces,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileCode2,
  FileJson,
  FileText,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Hash,
  MessageSquare,
  Minus,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Upload,
  type IconNode,
} from 'lucide'

/**
 * fileIcons — FileSheet 域内 Solid 图标（#515 全量 Solid 化）。
 *
 * 与 `src/components/LucideIcon.solid.tsx` 同一机制：取 lucide 核心包的 IconNode 数据
 * 自绘 SVG，类名与 lucide-react 逐类一致（`.lucide-{kebab}` 是样式的消费契约），路径
 * 数据同源。不直接复用 LucideIcon 的原因：其映射表在他人迁移域（src/components/**）
 * 且缺少本域图标；新图标按需在此登记（具名静态导入，防 tree-shaking 击穿）。
 *
 * #515 期 `FileTypeIcon.tsx` 仍是 React 文件，`fileTypeOf` 纯函数无法跨编译面共享——
 * 在此按同表重写；真源仍以 FileTypeIcon.tsx 的扩展名映射为准（两表漂移由 FileSheet
 * 样式契约测试兜住），插件面 Solid 化后合并到单一实体。
 */
const ICON_NODES: Readonly<Record<string, IconNode>> = {
  Braces,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileCode2,
  FileJson,
  FileText,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Hash,
  MessageSquare,
  Minus,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Upload,
}

const kebabOf = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

/** 按 lucide-react 的默认 SVG 属性装配图标路径（描边/线帽逐项一致；类名与尺寸由调用点的 svg 元素承载）。 */
function buildSvg(host: SVGSVGElement, iconNode: IconNode, strokeWidth: number): void {
  const svgNamespace = 'http://www.w3.org/2000/svg'
  host.setAttribute('xmlns', svgNamespace)
  host.setAttribute('viewBox', '0 0 24 24')
  host.setAttribute('fill', 'none')
  host.setAttribute('stroke', 'currentColor')
  host.setAttribute('stroke-width', String(strokeWidth))
  host.setAttribute('stroke-linecap', 'round')
  host.setAttribute('stroke-linejoin', 'round')
  for (const [tag, attributes] of iconNode) {
    const child = document.createElementNS(svgNamespace, tag)
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'key') continue
      child.setAttribute(name, String(value))
    }
    host.appendChild(child)
  }
}

/** lucide 图标的 Solid 自绘。不加 aria-hidden——lucide-react 默认也不加，DOM 面保持逐项一致。 */
export function WorkbenchIcon(props: { name: string; size?: number; strokeWidth?: number; class?: string }) {
  const kebab = kebabOf(props.name)

  return (
    <svg
      ref={element => { buildSvg(element, ICON_NODES[props.name] ?? RefreshCw, props.strokeWidth ?? 2) }}
      class={`lucide lucide-${kebab} ${props.class ?? ''}`}
      width={props.size ?? 24}
      height={props.size ?? 24}
    />
  )
}

const EXTENSION_ICON: Readonly<Record<string, { icon: string; type: string }>> = {
  ts: { icon: 'Braces', type: 'ts' },
  tsx: { icon: 'Braces', type: 'ts' },
  js: { icon: 'Braces', type: 'js' },
  jsx: { icon: 'Braces', type: 'js' },
  mjs: { icon: 'Braces', type: 'js' },
  cjs: { icon: 'Braces', type: 'js' },
  rs: { icon: 'Hash', type: 'rust' },
  c: { icon: 'Hash', type: 'c' },
  h: { icon: 'Hash', type: 'c' },
  cpp: { icon: 'Hash', type: 'c' },
  hpp: { icon: 'Hash', type: 'c' },
  cc: { icon: 'Hash', type: 'c' },
  json: { icon: 'FileJson', type: 'json' },
  jsonc: { icon: 'FileJson', type: 'json' },
  css: { icon: 'Palette', type: 'style' },
  scss: { icon: 'Palette', type: 'style' },
  less: { icon: 'Palette', type: 'style' },
  md: { icon: 'FileText', type: 'text' },
  mdx: { icon: 'FileText', type: 'text' },
  txt: { icon: 'FileText', type: 'text' },
}

/** FileTypeIcon 的 Solid 实体（extension → 图标/type 与 FileTypeIcon.tsx 同表；React 版带 aria-hidden）。 */
export function FileTypeIconSolid(props: { path: string; size?: number }) {
  const extension = props.path.split('.').pop()?.toLowerCase() ?? ''
  const mapped = EXTENSION_ICON[extension] ?? { icon: 'FileCode2', type: 'code' }
  const kebab = kebabOf(mapped.icon)

  return (
    <svg
      ref={element => { buildSvg(element, ICON_NODES[mapped.icon] ?? FileCode2, 2) }}
      class={`lucide lucide-${kebab} file-type-icon type-${mapped.type}`}
      width={props.size ?? 14}
      height={props.size ?? 14}
      aria-hidden="true"
    />
  )
}
