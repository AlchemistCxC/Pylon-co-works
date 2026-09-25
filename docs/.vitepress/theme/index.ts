import DefaultTheme from 'vitepress/theme'

// 西文 Source Serif 4（与思源宋体同源配对）+ 斜体；中文 Noto Serif SC 思源宋体，
// fontsource 按 unicode-range 分块自托管，浏览器只拉取页面用到的分块。
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/400-italic.css'
import '@fontsource/source-serif-4/600.css'
import '@fontsource/source-serif-4/700.css'
import '@fontsource/noto-serif-sc/400.css'
import '@fontsource/noto-serif-sc/600.css'
import '@fontsource/noto-serif-sc/700.css'
import './custom.css'

export default DefaultTheme
