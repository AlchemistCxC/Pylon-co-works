import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// W2-12 右栏修复（2026-08-06，用户报选 agent 后 Maximum update depth）：
// zustand v5 useStore 的 selector 返回值即 useSyncExternalStore 快照——selector 返回
// 新引用（`?? []` 每次新数组）→ Object.is 不等 → forceStoreRerender 死循环。
// 守卫：touchedFiles 必须选整个 record（引用稳定），派生留组件体。

for (const path of ['src/components/right-panel/AgentContextPanel.tsx', 'src/components/right-panel/FileContextPanel.tsx']) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  assert.match(source, /useWorkspaceStore\(s => s\.touchedFiles\)/, `${path} 必须选整个 touchedFiles record（稳定引用）`)
  assert.equal(
    /useWorkspaceStore\([^)]*touchedFiles\[source\] \?\? \[\]/.test(source),
    false,
    `${path} selector 不得含 \`?? []\`（新引用死循环）`,
  )
  assert.equal(
    /useWorkspaceStore\([^)]*touchedFiles\[source\][^)]*\]/.test(source),
    false,
    `${path} 不得在 selector 内做数组派生`,
  )
  assert.match(source, /const touchedFiles = source \? touchedFilesRecord\[source\] \?\? \[\] : \[\]/, `${path} 派生必须留组件体`)
}

console.log('context panel selector 守卫通过')
