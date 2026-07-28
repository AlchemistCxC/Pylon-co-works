import { strict as assert } from 'node:assert'
import { resolveBackgroundImage } from '../src/backgroundImage.ts'

const empty = resolveBackgroundImage('')
assert.deepEqual(empty, { source: null, cssValue: 'none', error: null })

for (const source of [
  'https://example.com/background image.png',
  'data:image/png;base64,AAAA',
  'blob:https://example.com/asset-id',
]) {
  const result = resolveBackgroundImage(source, () => { throw new Error('不应转换 Web URL') })
  assert.equal(result.source, source)
  assert.equal(result.cssValue, `url(${JSON.stringify(source)})`)
  assert.equal(result.error, null)
}

let convertedPath = ''
const local = resolveBackgroundImage('C:\\Users\\Alice\\Pictures\\background image.png', path => {
  convertedPath = path
  return 'http://asset.localhost/C%3A%5CUsers%5CAlice%5CPictures%5Cbackground%20image.png'
})
assert.equal(convertedPath, 'C:\\Users\\Alice\\Pictures\\background image.png')
assert.equal(local.source, 'http://asset.localhost/C%3A%5CUsers%5CAlice%5CPictures%5Cbackground%20image.png')
assert.equal(local.cssValue, 'url("http://asset.localhost/C%3A%5CUsers%5CAlice%5CPictures%5Cbackground%20image.png")')
assert.equal(local.error, null)

const failed = resolveBackgroundImage('C:\\missing image.png', () => { throw new Error('转换失败') })
assert.equal(failed.source, null)
assert.equal(failed.cssValue, 'none')
assert.equal(failed.error, '转换失败')

console.log('backgroundImage 回归测试通过')
