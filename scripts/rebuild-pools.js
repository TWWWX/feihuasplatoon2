/* 重建九库 + 额外字库（统一口径，替代逐库手工维护）：
   语料：御定全唐詩/json（唐诗）· 宋词 ci.song.*.json（宋词/苏轼/辛弃疾）· chinese-poetry 全库（额外库）
   文本层：词级繁转简（opencc t2s，词级保护「乾坤」等词）+ 变体映射 馀→余、锺→钟、敧→欹（於→由 t2s 完成）。
   BAN（不进入九库，自然落入额外库）：拼迁屦沈谦圃佐瓦剧匀愠哲髻；
     全库频次不足 top2000 门槛的 BAN 字按真实频次强制插入额外库对应位置。
   九库规则（与既有口径一致，苏辛六库已验证可完全复现）：
     TANG = 唐诗 top300；SONG = 宋词 top300；SONGX = 宋词 top300 中非 TANG 字；
     SU/XIN 各三档 = 作者词频 1-200 / 201-400 / 401-600；
     EXTRA = 全库 top2000 − 九库并集（+ 强制追加的 BAN 字），频次降序，同频按码点。
   用法：node scripts/rebuild-pools.js [--write]   （默认 dry-run：只打印 diff，不写文件） */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import OpenCC from 'opencc-js'

const DATA_DIR = 'chinese-poetry'
const POOLS_FILE = 'src/game/pools.js'
const WRITE = process.argv.includes('--write')
const TOP_N = 2000
const SKIP_DIRS = new Set(['strains', 'rank', 'loader', '.github', 'images'])
const NON_HAN = /[^\u4E00-\u9FA5]+/g
const t2s = OpenCC.Converter({ from: 't', to: 'cn' })
/* opencc t2s 的简体码位盲区变体（词级转换不覆盖），在文本层显式合并 */
const MAP = { 馀: '余', 锺: '钟', 敧: '欹' }
/* 用户指定排除出九库的字（保留统计，落入额外库） */
const BAN = new Set('拼迁屦沈谦圃佐瓦剧匀愠哲髻'.split(''))

const clean = (text) => t2s(text).replace(/馀|锺|敧/g, (m) => MAP[m])

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

function countIn(files, filterAuthor) {
  const freq = new Map()
  for (const f of files) {
    let data
    try {
      data = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      continue
    }
    if (!Array.isArray(data)) continue
    for (const e of data) {
      if (!e || !Array.isArray(e.paragraphs)) continue
      if (filterAuthor && e.author !== filterAuthor) continue
      for (const ch of clean(e.paragraphs.join('')).replace(NON_HAN, '')) {
        freq.set(ch, (freq.get(ch) || 0) + 1)
      }
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].charCodeAt(0) - b[0].charCodeAt(0))
}

const allFiles = listJsonFiles(DATA_DIR)
const tangFiles = readdirSync('chinese-poetry/御定全唐詩/json').map((f) => `chinese-poetry/御定全唐詩/json/${f}`)
const ciFiles = allFiles.filter((f) => /[/\\]宋词[/\\]ci\.song\.\d+\.json$/.test(f))

console.log('统计中：全库 / 唐诗 / 宋词 / 苏轼 / 辛弃疾 …')
const allFreq = countIn(allFiles)
const tangFreq = countIn(tangFiles)
const ciFreq = countIn(ciFiles)
const suFreq = countIn(ciFiles, '苏轼')
const xinFreq = countIn(ciFiles, '辛弃疾')

/* ---- 九库选择（BAN 字排除） ---- */
const notBan = (list) => list.filter(([c]) => !BAN.has(c))
const TANG = notBan(tangFreq).slice(0, 300)
const SONG = notBan(ciFreq).slice(0, 300)
const tangSet = new Set(TANG.map(([c]) => c))
const SONGX = notBan(ciFreq).filter(([c]) => !tangSet.has(c)).slice(0, 300)
const tier = (list) => notBan(list).slice(0, 600).map(([c]) => c)
const SU = tier(suFreq)
const XIN = tier(xinFreq)

const unionSet = new Set([...TANG, ...SONG, ...SONGX, ...SU, ...XIN].map(([c]) => c))

/* ---- 额外库：全库 top2000 − 九库并集；BAN 字强制保底 ---- */
const extraClean = allFreq.slice(0, TOP_N).filter(([c]) => !unionSet.has(c))
/* BAN 字若因频次不足 top2000 而缺失 → 按真实频次强制插入 */
const forced = []
const extraWithBan = [...extraClean]
for (const ch of BAN) {
  if (extraWithBan.some(([c]) => c === ch)) continue
  const hit = allFreq.find(([c]) => c === ch)
  if (!hit) {
    console.log(`警告：BAN 字「${ch}」在全库中未出现，跳过`)
    continue
  }
  forced.push(ch)
  let i = extraWithBan.findIndex(([c, w]) => w < hit[1])
  if (i < 0) i = extraWithBan.length
  extraWithBan.splice(i, 0, hit)
}
const extraSorted = extraWithBan.sort((a, b) => b[1] - a[1] || a[0].charCodeAt(0) - b[0].charCodeAt(0))

/* ---- 与现库 diff ---- */
const src = readFileSync(POOLS_FILE, 'utf8')
const old = {}
for (const m of src.matchAll(/export const (POOL_(?:TANG|SONG|SU|XIN|SONGX|SU2|XIN2|SU3|XIN3)_STR) = "([^"]*)"/g)) {
  old[m[1]] = m[2]
}
const names = [
  ['POOL_TANG_STR', TANG.map(([c]) => c).join('')],
  ['POOL_SONG_STR', SONG.map(([c]) => c).join('')],
  ['POOL_SONGX_STR', SONGX.map(([c]) => c).join('')],
  ['POOL_SU_STR', SU.slice(0, 200).join('')],
  ['POOL_XIN_STR', XIN.slice(0, 200).join('')],
  ['POOL_SU2_STR', SU.slice(200, 400).join('')],
  ['POOL_XIN2_STR', XIN.slice(200, 400).join('')],
  ['POOL_SU3_STR', SU.slice(400, 600).join('')],
  ['POOL_XIN3_STR', XIN.slice(400, 600).join('')],
]
console.log('\n===== 九库 diff（新增 = 新库有旧库无；移除 = 旧库有新库无） =====')
for (const [k, s] of names) {
  const o = old[k] || ''
  const added = [...s].filter((c) => !o.includes(c))
  const removed = [...o].filter((c) => !s.includes(c))
  console.log(`${k}  +${added.length} -${removed.length}`)
  if (added.length) console.log(`  新增: ${added.join('')}`)
  if (removed.length) console.log(`  移除: ${removed.join('')}`)
}

/* ---- BAN 字去向 ---- */
console.log('\n===== 13 个排除字去向 =====')
const extraIndex = new Map(extraSorted.map(([c], i) => [c, i]))
for (const ch of BAN) {
  if (extraIndex.has(ch)) {
    const i = extraIndex.get(ch)
    console.log(`${ch}: 额外库第 ${i + 1} 位（全库频次 ${extraSorted[i][1]}${forced.includes(ch) ? '，top2000 外强制插入' : ''}）`)
  } else {
    console.log(`${ch}: 未出现在任何库（全库频次不足或字不存在）`)
  }
}

/* ---- 写文件 ---- */
const chunk = (arr, n) => arr.slice(0, Math.ceil(arr.length / n)).map((_, i) => arr.slice(i * n, (i + 1) * n))
const strLines = chunk(extraSorted.map(([c]) => c), 180).map((s, i) => `  ${i ? '+ ' : ''}"${s.join('')}"`).join('\n')
const wtSegs = []
for (let i = 0; i < extraSorted.length; i += 24) wtSegs.push(extraSorted.slice(i, i + 24).map(([, w]) => w).join(' ') + ' ')
wtSegs[wtSegs.length - 1] = wtSegs[wtSegs.length - 1].trimEnd()
const wtLines = wtSegs.map((s, i) => `  ${i ? '+ ' : ''}"${s}"`).join('\n')

if (!WRITE) {
  console.log(`\n[dry-run] 额外库 ${extraSorted.length} 字（频次 ${extraSorted[0][1]} ~ ${extraSorted[extraSorted.length - 1][1]}）。加 --write 执行写入。`)
} else {
  let out = src
  for (const [k, s] of names) {
    const re = new RegExp(`export const ${k} = "[^"]*"`)
    if (!re.test(out)) throw new Error(`pools.js 中找不到 ${k}`)
    out = out.replace(re, `export const ${k} = "${s}"`)
  }
  const start = out.indexOf('export const EXTRA_STR')
  const end = out.indexOf('/* 额外字池')
  if (start < 0 || end < 0 || end < start) throw new Error('pools.js 中找不到 EXTRA 区块标记')
  out = out.slice(0, start) + `export const EXTRA_STR =\n${strLines}\nexport const EXTRA_WT_STR =\n${wtLines}\n` + out.slice(end)
  writeFileSync(POOLS_FILE, out, 'utf8')
  console.log(`已重写 ${POOLS_FILE}（九库 9 行 + 额外库 ${extraSorted.length} 字）`)
}
