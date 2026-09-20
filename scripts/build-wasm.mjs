#!/usr/bin/env node
// build-wasm — 前端计算核的 wasm 构建入口（issue #220）。
//
// 把 `src-tauri/pylon-compute` 打成 ESM glue + `_bg.wasm`，落到 `src/wasm/pylon-compute/`。
// 该目录是**构建产物**（wasm-pack 会在里面写一个内容为 `*` 的 .gitignore），不入库；
// 因此从干净检出起，测试与构建都必须先经过本脚本。
//
// 为什么是脚本而不是 package.json 里一行 wasm-pack：
//   1. **工具链前置要报成人话**。开发机原本没有 wasm32 target 与 wasm-pack，缺了就是
//      一句 `command not found`；这里显式探测并给出补齐命令。
//   2. **未变则跳过**。wasm-pack 每次都要跑 wasm-bindgen + wasm-opt（实测 20-35s），
//      挂在 vitest globalSetup 上会让每条测试命令都付这个成本。以「crate 源码 +
//      Cargo.toml + 工具链声明」的内容哈希做戳，未变直接返回（<100ms）。
//
// 用法：
//   node scripts/build-wasm.mjs            # 未变则跳过
//   node scripts/build-wasm.mjs --force    # 强制重建

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 计算核 crate 与其依赖（单源类型 crate）——任一变化都要重打。 */
const CRATE_DIRS = [
  join(root, 'src-tauri', 'pylon-compute'),
  join(root, 'src-tauri', 'pylon-canonical-types'),
]
/** 工具链与 workspace 声明也会改变产物。 */
const CRATE_FILES = [
  join(root, 'src-tauri', 'Cargo.toml'),
  join(root, 'src-tauri', 'Cargo.lock'),
  join(root, 'rust-toolchain.toml'),
]
const OUT_DIR = join(root, 'src', 'wasm', 'pylon-compute')
const STAMP_FILE = join(OUT_DIR, '.wasm-build-stamp.json')
const ARTIFACTS = ['pylon_compute.js', 'pylon_compute_bg.wasm', 'pylon_compute.d.ts']

function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

/** crate 源码 + 声明文件的联合内容哈希（相对路径参与，避免重命名漏检）。 */
function computeSourceHash() {
  const hash = createHash('sha256')
  const files = [...CRATE_DIRS.flatMap(listFiles), ...CRATE_FILES.filter(existsSync)]
  for (const file of files) {
    hash.update(file.slice(root.length).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function isUpToDate(hash) {
  if (!existsSync(STAMP_FILE)) return false
  if (!ARTIFACTS.every(name => existsSync(join(OUT_DIR, name)))) return false
  try {
    return JSON.parse(readFileSync(STAMP_FILE, 'utf8')).sourceHash === hash
  } catch {
    return false
  }
}

/** wasm-pack 不在 PATH 时，退到 CARGO_HOME/bin 与 ~/.cargo/bin（Windows 上常见）。 */
function resolveWasmPack() {
  const candidates = [
    'wasm-pack',
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin', 'wasm-pack') : undefined,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.cargo', 'bin', 'wasm-pack.exe') : undefined,
    process.env.HOME ? join(process.env.HOME, '.cargo', 'bin', 'wasm-pack') : undefined,
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate === 'wasm-pack') {
      const probe = spawnSync('wasm-pack', ['--version'], { encoding: 'utf8', shell: false })
      if (!probe.error && probe.status === 0) return candidate
      continue
    }
    if (existsSync(candidate) || existsSync(`${candidate}.exe`)) return candidate
  }
  return undefined
}

/** 缺少工具链时给出可直接粘贴的补齐命令，而不是让调用方去猜。 */
function toolchainMissing(message, fix) {
  console.error(`[build-wasm] ${message}`)
  console.error(`[build-wasm] 补齐：\n  ${fix}`)
  console.error('[build-wasm] 说明：前端计算核（issue #220）需要 wasm 工具链；不用 wasm 的分支不会走到这里。')
  process.exit(1)
}

export function ensureWasmBuilt({ force = false } = {}) {
  const sourceHash = computeSourceHash()
  if (!force && isUpToDate(sourceHash)) return { skipped: true, outDir: OUT_DIR }

  const wasmPack = resolveWasmPack()
  if (!wasmPack) {
    toolchainMissing(
      '未找到 wasm-pack。',
      'cargo install wasm-pack        # 或从 https://rustwasm.github.io/wasm-pack/installer/ 取预编译二进制',
    )
  }

  const targets = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8', shell: false })
  if (!targets.error && targets.status === 0 && !/wasm32-unknown-unknown/.test(targets.stdout ?? '')) {
    toolchainMissing('rustup 未安装 wasm32-unknown-unknown target。', 'rustup target add wasm32-unknown-unknown')
  }

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const args = [
    'build',
    join('src-tauri', 'pylon-compute'),
    '--target', 'web',
    '--out-dir', OUT_DIR,
    '--out-name', 'pylon_compute',
  ]
  const result = spawnSync(wasmPack, args, { cwd: root, encoding: 'utf8', shell: false, stdio: 'inherit' })
  if (result.error) {
    console.error(`[build-wasm] wasm-pack 启动失败: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[build-wasm] wasm-pack 退出码 ${result.status}`)
    process.exit(result.status ?? 1)
  }

  writeFileSync(STAMP_FILE, `${JSON.stringify({ sourceHash, builtAt: new Date().toISOString() }, null, 2)}\n`)
  return { skipped: false, outDir: OUT_DIR }
}

/** 产物字节数（`check:bundle` 的 wasm 记账与开发记录都读它）。 */
export function wasmArtifactSizes() {
  return ARTIFACTS.map(name => {
    const path = join(OUT_DIR, name)
    return { name, bytes: existsSync(path) ? statSync(path).size : 0 }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const force = process.argv.includes('--force')
  const started = Date.now()
  const outcome = ensureWasmBuilt({ force })
  if (outcome.skipped) {
    console.log(`[build-wasm] 源码未变，跳过（${Date.now() - started}ms）`)
  } else {
    for (const artifact of wasmArtifactSizes()) {
      console.log(`[build-wasm] ${artifact.name}: ${artifact.bytes} B`)
    }
    console.log(`[build-wasm] 完成（${Date.now() - started}ms）`)
  }
}
