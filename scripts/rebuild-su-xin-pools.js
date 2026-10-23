/* 重新统计苏轼/辛弃疾词字频 → 输出 1-200 / 201-400 / 401-600 三档字串（替换 pools.js 用）
   口径：只统计正文 paragraphs（词牌 rhythmic、词序 prologue、作者均为独立字段，天然不参与）；
   语料：chinese-poetry/宋词/ci.song.*.json；内容已为简体，无需 opencc。
   用法：node scripts/rebuild-su-xin-pools.js */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = 'chinese-poetry/宋词'
const NON_HAN = /[^\u4E00-\u9FA5]+/g

function count(author) {
  const freq = new Map()
  for (const f of readdirSync(DIR)) {
    if (!/^ci\.song\.\d+\.json$/.test(f)) continue
    for (const e of JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))) {
      if (e.author !== author || !Array.isArray(e.paragraphs)) continue
      const text = e.paragraphs.join('')
      for (const ch of text.replace(NON_HAN, '')) freq.set(ch, (freq.get(ch) || 0) + 1)
    }
  }
  /* 频次降序；同频按 Unicode 码点升序保证可复现 */
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].charCodeAt(0) - b[0].charCodeAt(0))
}

for (const [label, author] of [['SU', '苏轼'], ['XIN', '辛弃疾']]) {
  const list = count(author)
  console.log(`${author}：去重后 ${list.length} 个字`)
  for (let t = 0; t < 3; t++) {
    const s = list.slice(t * 200, (t + 1) * 200).map(([c]) => c).join('')
    console.log(`POOL_${label}${t === 0 ? '' : t + 1}_STR = "${s}"`)
  }
}
