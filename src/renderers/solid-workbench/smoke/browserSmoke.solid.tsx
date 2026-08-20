import { mountSolidWorkbenchSmoke } from './mountSolidWorkbenchSmoke.solid.tsx'
import './solidWorkbenchSmoke.css'

const host = document.getElementById('solid-smoke-root')
if (!host) throw new Error('缺少 #solid-smoke-root')

const lifecycle = mountSolidWorkbenchSmoke(host, {
  label: 'Solid Workbench browser smoke',
  value: 1,
})

let value = 1
const timer = window.setInterval(() => {
  value += 1
  lifecycle.update({ label: 'Solid Workbench browser smoke', value })
}, 1000)

window.addEventListener('pagehide', () => {
  window.clearInterval(timer)
  lifecycle.destroy()
}, { once: true })
