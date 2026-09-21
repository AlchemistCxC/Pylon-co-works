#!/usr/bin/env node
/**
 * 打包态 CSP 必须放行 `'self'`——issue #220 实机验收抓到的 P0 的回归门。
 *
 * 事故：`tauri.conf.json` 的 `csp.connect-src` 是唯一**没有** `'self'` 的取值指令
 * （`default-src`/`img-src`/`style-src`/`script-src`/`font-src` 都有）。而
 * `connect-src` 恰好是管 `fetch()` 的那条，于是**打包后**前端 `fetch('assets/*.wasm')`
 * 被拒：
 *
 *   Connecting to 'http://tauri.localhost/assets/pylon_compute_bg-*.wasm' violates the
 *   following Content Security Policy directive: "connect-src ipc: ... "
 *
 * 后果：wasm 计算核在打包应用里**从未加载成功过**，投影核构造函数随即抛
 * `TypeError: Cannot read properties of undefined (reading '__wbindgen_export')`。
 * 而 **dev 态看不见**：`devCsp.connect-src` 显式列了 `http://localhost:5173`，页面
 * 源正好是它，同源 fetch 恰好放行。轮子全绿、打包即碎——这正是「只有真机能看见」的那类缺陷。
 *
 * 门禁口径（只判这一件事，不做通用 CSP 求解）：
 * 1. 凡「管取资源」的指令（connect-src 一定有；其余存在即查）都必须含 `'self'`；
 * 2. `csp` 与 `devCsp` 两套都要过——dev 靠显式列源碰巧能跑，不该继续依赖巧合。
 *
 * 为什么不是「前端不许 fetch 同源资产」：本仓是本地优先的 Tauri 应用，同源资产
 * （wasm、字体、图片）本来就是它要取的东西；缺 `'self'` 是配置笔误，不是设计意图。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const configPath = path.join(root, 'src-tauri', 'tauri.conf.json')

/** 管取资源、因而必须放行同源的指令。`connect-src` 是硬要求（fetch/XHR/WebSocket）。 */
const SELF_REQUIRED = ['connect-src', 'default-src', 'script-src', 'style-src', 'img-src', 'font-src']

let config
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (error) {
  console.error(`[check-csp-self] 读不到或解析不了 ${path.relative(root, configPath)}：${error.message}`)
  process.exit(1)
}

const security = config?.app?.security
if (!security || typeof security !== 'object') {
  console.error('[check-csp-self] tauri.conf.json 里找不到 app.security')
  process.exit(1)
}

const failures = []
for (const variant of ['csp', 'devCsp']) {
  const directives = security[variant]
  if (!directives || typeof directives !== 'object') {
    failures.push(`${variant} 缺失或不是对象`)
    continue
  }
  if (!('connect-src' in directives)) {
    failures.push(`${variant}.connect-src 缺失：前端 fetch 同源资产（wasm）会静默失败`)
  }
  for (const directive of SELF_REQUIRED) {
    const value = directives[directive]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      failures.push(`${variant}.${directive} 不是字符串（收到 ${typeof value}）`)
      continue
    }
    const tokens = value.split(/\s+/).filter(Boolean)
    if (!tokens.includes("'self'")) {
      failures.push(`${variant}.${directive} 没有 'self'：${value}`)
    }
  }
}

if (failures.length > 0) {
  console.error('[check-csp-self] 打包态 CSP 会挡住前端自己的同源资产：')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  console.error('  修法：把 \'self\' 加进该指令（本地优先应用不取第三方源，不需要放宽别的）。')
  process.exit(1)
}

console.log(`[check-csp-self] 通过：csp / devCsp 的取资源指令都放行 'self'（${SELF_REQUIRED.length} 条口径）`)
