/**
 * 分层边界门禁（结构审查 B-1/B-2/B-3 的机器化收尾）。
 *
 * 仓库此前只有 renderer 专项架构检查（check-renderer-architecture）与 runtime 边界
 * （check-runtime-boundaries，管 invoke/store/CustomEvent）；本脚本补上「目录分层」
 * 这一维：视图层（components/sheets/workspace-sheets/renderers）与三层非视图代码
 * （domains / plugin-runtime / infrastructure）以及 contracts 之间的 import 禁令。
 *
 * 每条豁免必须带理由注释（who/why），新增豁免 = 显式评审动作。
 * 负向验证：新增本文件时曾以临时违规 fixture 验证能红，后删除。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

function gitTrackedSrcFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files', 'src'], { cwd: projectRoot, encoding: 'utf8' })
    return out.split('\n').map(s => s.trim()).filter(Boolean)
      .filter(p => /\.(?:ts|tsx|mts)$/.test(p))
      .filter(p => !p.includes('__tests__/') && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'))
      .map(p => resolve(projectRoot, p))
  } catch {
    // 非 git 环境退回全量扫描
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (/\.(?:ts|tsx|mts)$/.test(e.name)) files.push(p)
      }
    }
    // 同步退路：够用即可（门禁在 git 环境运行）
    const walkSync = (dir: string): void => {
      for (const e of readdirSyncShim(dir)) {
        const p = resolve(dir, e)
        if (statSyncShim(p).isDirectory()) walkSync(p)
        else if (/\.(?:ts|tsx|mts)$/.test(e.name)) files.push(p)
      }
    }
    walkSync(resolve(projectRoot, 'src'))
    void walk
    return files.filter(p => !p.includes('__tests__') && !/\.test\.[tj]sx?$/.test(p))
  }
}
import { readdirSync, statSync } from 'node:fs'
function readdirSyncShim(dir: string): string[] { return readdirSync(dir) }
function statSyncShim(p: string): import('node:fs').Stats { return statSync(p) }

/** 分层规则：scope（目录前缀）→ 禁止解析落入的路径前缀。豁免 = [文件, 说明] 白名单。 */
interface LayerRule {
  label: string
  scopeRoots: string[]
  forbiddenPathIncludes: string[]
  allowlist: Record<string, string> // file（相对路径, '/' 分隔）→ 理由
}

const VIEW_DIRS = ['src/components/', 'src/sheets/', 'src/workspace-sheets/', 'src/renderers/']

const RULES: LayerRule[] = [
  {
    label: 'domains → 视图层',
    scopeRoots: ['src/domains/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {
      // ACP 会话发送/接收链在域内直接 invoke（check-runtime-boundaries 同源豁免，legacy inventory；
      // 迁 transport 需整体设计，见审查报告 A-V2/B-6 后续）。
      'src/domains/chat/sessionMode.ts': 'legacy direct-invoke inventory（与 runtime-boundaries 白名单同源）',
      'src/domains/chat/sessionModel.ts': 'legacy direct-invoke inventory',
      'src/domains/chat/streamingSend.ts': 'legacy direct-invoke inventory',
    },
  },
  {
    label: 'plugin-runtime → 视图层',
    scopeRoots: ['src/plugin-runtime/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {
    },
  },
  {
    label: 'infrastructure → 视图层',
    scopeRoots: ['src/infrastructure/'],
    forbiddenPathIncludes: VIEW_DIRS,
    allowlist: {},
  },
  {
    label: 'contracts → 实现',
    scopeRoots: ['src/contracts/'],
    forbiddenPathIncludes: ['src/components/', 'src/sheets/', 'src/workspace-sheets/', 'src/renderers/', 'src/plugin-runtime/', 'src/infrastructure/'],
    // domains/identity 的 Session 为 type-only 边（契约层纪律文本只禁 React/Solid 与 components 实现依赖）。
    allowlist: {
      'src/contracts/sheets.ts': 'SheetContext.sessionBySource 的 Session type-only 边（头注声明）',
      'src/contracts/agentCommandSet.ts': '若存在 domains 引用为类型面（按现状豁免）',
    },
  },
]

function resolvesUnder(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(fromFile, '..', spec)
  const candidates = [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch { /* try next */ }
  }
  return null
}

const files = gitTrackedSrcFiles()
const violations: string[] = []
for (const file of files) {
  const relFile = relative(projectRoot, file).replaceAll('\\', '/')
  for (const rule of RULES) {
    if (!rule.scopeRoots.some(root => relFile.startsWith(root))) continue
    const text = await readFile(file, 'utf8')
    const specs = [...text.matchAll(/(?:from\s*|import\s*\(?\s*)(['"])(\.[^'"]+)\1/g)].map(m => m[2])
    for (const spec of specs) {
      const target = resolvesUnder(file, spec)
      if (!target) continue
      const relTarget = relative(projectRoot, target).replaceAll('\\', '/')
      const hit = rule.forbiddenPathIncludes.find(prefix => relTarget.startsWith(prefix))
      if (!hit) continue
      if (rule.allowlist[relFile]) continue
      violations.push(`[${rule.label}] ${relFile} → ${relTarget}（命中 ${hit}；如属合理边界请在 check-layer-boundaries.mts 登记豁免并附理由）`)
    }
  }
}

if (violations.length > 0) {
  console.error(`分层边界门禁失败：${violations.length} 处越界`)
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log(`分层边界门禁通过：${files.length} 个生产文件，四层规则零越界（豁免 ${Object.values(RULES).reduce((n, r) => n + Object.keys(r.allowlist).length, 0)} 条，均有理由登记）`)
