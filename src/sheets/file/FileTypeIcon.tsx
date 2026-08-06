import { Braces, FileCode2, FileJson, FileText, Hash, Palette } from 'lucide-react'

const extensionOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? ''

export function fileTypeOf(path: string): string {
  const extension = extensionOf(path)
  if (['ts', 'tsx'].includes(extension)) return 'ts'
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'js'
  if (['rs'].includes(extension)) return 'rust'
  if (['c', 'h', 'cpp', 'hpp', 'cc'].includes(extension)) return 'c'
  if (['json', 'jsonc'].includes(extension)) return 'json'
  if (['css', 'scss', 'less'].includes(extension)) return 'style'
  if (['md', 'mdx', 'txt'].includes(extension)) return 'text'
  return 'code'
}

export default function FileTypeIcon({ path, size = 14 }: { path: string; size?: number }) {
  const type = fileTypeOf(path)
  const props = { size, 'aria-hidden': true as const }
  if (type === 'ts' || type === 'js') return <Braces {...props} className={`file-type-icon type-${type}`} />
  if (type === 'rust' || type === 'c') return <Hash {...props} className={`file-type-icon type-${type}`} />
  if (type === 'json') return <FileJson {...props} className="file-type-icon type-json" />
  if (type === 'style') return <Palette {...props} className="file-type-icon type-style" />
  if (type === 'text') return <FileText {...props} className="file-type-icon type-text" />
  return <FileCode2 {...props} className="file-type-icon type-code" />
}
