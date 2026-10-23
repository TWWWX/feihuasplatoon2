/* 重建额外字库：全部诗文正文前 2000 高频字 → 剔除九库并集（POOL_SET）→ 重写 pools.js 的 EXTRA_STR / EXTRA_WT_STR。
   语料口径：chinese-poetry 递归全部 .json（排除 strains 词牌格律 / rank 排行副本 / loader 工具 / .github / images），
   与 import-poetry.js 相同：只取 Array + paragraphs 结构、opencc 繁转简、剔除非汉字。
   运行时机制不变：seededPickExtras 按 activePoolSet（已勾选基础字库）动态再过滤。
   用法：node scripts/rebuild-extra-pool.js */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import OpenCC from 'opencc-js'
import { POOL_SET } from '../src/game/pools.js'

const DATA_DIR = 'chinese-poetry'
const POOLS_FILE = 'src/game/pools.js'
const TOP_N = 2000
const SKIP_DIRS = new Set(['strains', 'rank', 'loader', '.github', 'images'])
const NON_HAN = /[^\u4E00-\u9FA5]+/g
const t2s = OpenCC.Converter({ from: 't', to: 'cn' })

function listJsonFiles(dir) {
  const out = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(name.name)) continue
    const p = path.join(dir, name.name)
    if (name.isDirectory()) out.push(...listJsonFiles(p))
    else if (name.isFile() && name.name.toLowerCase().endsWith('.json')) out.push(p)
  }
  return out
}

const freq = new Map()
let files = 0
for (const f of listJsonFiles(DATA_DIR)) {
  let data
  try {
    data = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    continue
  }
  if (!Array.isArray(data)) continue
  files++
  for (const entry of data) {
    if (!entry || !Array.isArray(entry.paragraphs)) continue
    for (const ch of t2s(entry.paragraphs.join('')).replace(NON_HAN, '')) {
      freq.set(ch, (freq.get(ch) || 0) + 1)
    }
  }
}
const all = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].charCodeAt(0) - b[0].charCodeAt(0))
const top = all.slice(0, TOP_N)
const extra = top.filter(([ch]) => !POOL_SET[ch])
console.log(`语料文件 ${files} 个 · 去重汉字 ${all.length} 个`)
console.log(`top ${TOP_N} 中属九库并集 ${top.length - extra.length} 个 → 额外字库 ${extra.length} 字（频次 ${extra[0][1]} ~ ${extra[extra.length - 1][1]}）`)

/* 生成 pools.js 片段：字符串 180 字/段、权重 24 个数/段，段间 + 拼接（整串无前导/尾随空格，
   保证消费端 EXTRA_WT_STR.split(' ').map(Number) 索引与 EXTRA_STR 对齐） */
const chunk = (arr, n) => arr.slice(0, Math.ceil(arr.length / n)).map((_, i) => arr.slice(i * n, (i + 1) * n))
const strLines = chunk(extra.map(([c]) => c), 180).map((s, i) => `  ${i ? '+ ' : ''}"${s.join('')}"`).join('\n')
const wtSegs = []
for (let i = 0; i < extra.length; i += 24) wtSegs.push(extra.slice(i, i + 24).map(([, w]) => w).join(' ') + ' ')
wtSegs[wtSegs.length - 1] = wtSegs[wtSegs.length - 1].trimEnd() /* 末段不留尾空格 */
const wtLines = wtSegs.map((s, i) => `  ${i ? '+ ' : ''}"${s}"`).join('\n')
const block = `export const EXTRA_STR =\n${strLines}\nexport const EXTRA_WT_STR =\n${wtLines}\n`

const src = readFileSync(POOLS_FILE, 'utf8')
const start = src.indexOf('export const EXTRA_STR')
const end = src.indexOf('/* 额外字池')
if (start < 0 || end < 0 || end < start) throw new Error('pools.js 中找不到 EXTRA 区块标记')
writeFileSync(POOLS_FILE, src.slice(0, start) + block + '\n' + src.slice(end), 'utf8')
console.log(`已重写 ${POOLS_FILE}`)
