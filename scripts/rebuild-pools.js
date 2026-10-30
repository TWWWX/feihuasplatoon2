/* 重建九库 + 补充库 + 额外字库（统一口径，替代逐库手工维护）：
   语料：御定全唐詩/json（唐诗）· 宋词 ci.song.*.json（宋词/苏轼/辛弃疾）· chinese-poetry 全库（额外库）
   文本层：词级繁转简（opencc t2s，词级保护「乾坤」等词）+ 变体映射 馀→余、锺→钟、敧→欹（於→由 t2s 完成）。
   移字：pools.js 的 REMOVED_FROM_POOLS 为唯一配置源——chars 剔除出九库（pools 含 'qianzi' 者除外，
     千字文由手工维护）并归入额外库（全库频次不足 top2000 者按真实频次强制插入额外库对应位置）；
     其中 pools 含 songx 且 fill=false 表示
     「宋词 300·不含唐诗字」只删不补（该库容量减 1），其余库剔除后自动顺延补位。
   九库规则（与既有口径一致，苏辛六库已验证可完全复现）：
     TANG = 唐诗 top300；SONG = 宋词 top300；SONGX = 宋词 top300 中非 TANG 字；
     SU/XIN 各三档 = 作者词频 1-200 / 201-400 / 401-600；
     补充库 SU4/XIN4 = 作者词频 601-700（补位缓冲，不参与抽字、不在界面显示）；
     EXTRA = 全库 top2000 全量（+ 强制追加的排除字），频次降序，同频按码点；运行时按勾选的基础库集合剔除。
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

const src = readFileSync(POOLS_FILE, 'utf8')
/* 移字配置：解析 pools.js 的 REMOVED_FROM_POOLS（唯一配置源，避免两处维护） */
const removed = [...src.matchAll(/\{ date: '([^']*)', chars: '([^']+)', pools: '([^']+)', fill: (true|false)/g)]
  .map(([, date, chars, pools, fill]) => ({ date, chars: [...chars], pools, fill: fill === 'true' }))
const BAN = new Set(removed.flatMap((r) => r.chars))
/* 九库剔除范围：pools 含 'qianzi' 的条目只做额外库保底，不影响九库 */
const NINE_BAN = new Set(removed.filter((r) => !/qianzi/.test(r.pools)).flatMap((r) => r.chars))
/* 只删不补的库：仅 SONGX 支持（其余库按词频顺延补位） */
const SONGX_NO_FILL = new Set(removed.filter((r) => /songx/.test(r.pools) && !r.fill).flatMap((r) => r.chars))

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

/* ---- 九库选择（排除字剔除；SONGX 的 no-fill 字在切片后移除，不补位） ---- */
const banFill = new Set([...NINE_BAN].filter((c) => !SONGX_NO_FILL.has(c)))
const notBan = (list) => list.filter(([c]) => !banFill.has(c))
const TANG = notBan(tangFreq).slice(0, 300)
const SONG = notBan(ciFreq).slice(0, 300)
const tangSet = new Set(TANG.map(([c]) => c))
const SONGX = notBan(ciFreq).filter(([c]) => !tangSet.has(c)).slice(0, 300).filter(([c]) => !SONGX_NO_FILL.has(c))
const tier = (list) => notBan(list).slice(0, 700).map(([c]) => c)
const SU = tier(suFreq)
const XIN = tier(xinFreq)
const SU4 = SU.slice(600, 700)
const XIN4 = XIN.slice(600, 700)

/* ---- 额外库：全库 top2000 全量（运行时按勾选的基础库并集剔除）；排除字强制保底 ---- */
const extraClean = allFreq.slice(0, TOP_N)
/* 排除字若因频次不足 top2000 而缺失 → 按真实频次强制插入 */
const forced = []
const extraWithBan = [...extraClean]
for (const ch of BAN) {
  if (extraWithBan.some(([c]) => c === ch)) continue
  const hit = allFreq.find(([c]) => c === ch)
  if (!hit) {
    console.log(`警告：排除字「${ch}」在全库中未出现，跳过`)
    continue
  }
  forced.push(ch)
  let i = extraWithBan.findIndex(([c, w]) => w < hit[1])
  if (i < 0) i = extraWithBan.length
  extraWithBan.splice(i, 0, hit)
}
const extraSorted = extraWithBan.sort((a, b) => b[1] - a[1] || a[0].charCodeAt(0) - b[0].charCodeAt(0))

/* ---- 与现库 diff ---- */
const old = {}
for (const m of src.matchAll(/export const (POOL_(?:TANG|SONG|SU|XIN|SONGX|SU2|XIN2|SU3|XIN3|SU4|XIN4)_STR) = "([^"]*)"/g)) {
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
  const dropped = [...o].filter((c) => !s.includes(c))
  console.log(`${k}  ${s.length} 字  +${added.length} -${dropped.length}`)
  if (added.length) console.log(`  新增: ${added.join('')}`)
  if (dropped.length) console.log(`  移除: ${dropped.join('')}`)
}

/* ---- 补充库（苏辛词 601-700，仅补位缓冲） ---- */
console.log('\n===== 补充库 SU4 / XIN4（不显示在界面） =====')
for (const [k, s] of [['POOL_SU4_STR', SU4.join('')], ['POOL_XIN4_STR', XIN4.join('')]]) {
  const state = old[k] ? (old[k] === s ? '与现值一致' : '有变化') : '新建'
  console.log(`${k}  ${s.length} 字（${state}）: ${s}`)
}

/* ---- 排除字去向 ---- */
console.log(`\n===== 排除字去向（共 ${BAN.size} 字） =====`)
const extraIndex = new Map(extraSorted.map(([c], i) => [c, i]))
for (const r of removed) {
  console.log(`[${r.date}] ${r.chars.join('')} ← ${r.pools}（${r.fill ? '剔除并补位' : '仅移除不补位'}）`)
  for (const ch of r.chars) {
    if (extraIndex.has(ch)) {
      const i = extraIndex.get(ch)
      console.log(`  ${ch}: 额外库第 ${i + 1} 位（全库频次 ${extraSorted[i][1]}${forced.includes(ch) ? '，top2000 外强制插入' : ''}）`)
    } else {
      console.log(`  ${ch}: 未出现在任何库（全库频次不足或字不存在）`)
    }
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
  /* 补充库：已存在则替换，不存在则插在 POOL_XIN3_STR 之后 */
  const supp = [['POOL_SU4_STR', SU4.join('')], ['POOL_XIN4_STR', XIN4.join('')]]
  for (const [k, s] of supp) {
    const re = new RegExp(`export const ${k} = "[^"]*"`)
    if (re.test(out)) out = out.replace(re, `export const ${k} = "${s}"`)
  }
  if (!out.includes('export const POOL_SU4_STR')) {
    const block = '\n/* 补充库：苏辛词 601-700，仅供九库移字后读取补位（不参与勾选、不在界面显示） */\n'
      + `export const POOL_SU4_STR = "${SU4.join('')}"\n`
      + `export const POOL_XIN4_STR = "${XIN4.join('')}"`
    const anchor = /export const POOL_XIN3_STR = "[^"]*"/.exec(out)
    if (!anchor) throw new Error('pools.js 中找不到 POOL_XIN3_STR 插入点')
    const pos = anchor.index + anchor[0].length
    out = out.slice(0, pos) + block + out.slice(pos)
  }
  const start = out.indexOf('export const EXTRA_STR')
  const end = out.indexOf('/* 额外字池')
  if (start < 0 || end < 0 || end < start) throw new Error('pools.js 中找不到 EXTRA 区块标记')
  out = out.slice(0, start) + `export const EXTRA_STR =\n${strLines}\nexport const EXTRA_WT_STR =\n${wtLines}\n` + out.slice(end)
  writeFileSync(POOLS_FILE, out, 'utf8')
  console.log(`已重写 ${POOLS_FILE}（九库 9 行 + 补充库 2 行 + 额外库 ${extraSorted.length} 字）`)
}
