<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { connectWs, closeWs, sendRaw, sendKick, wsStatus, wsError } from './useWebSocket'
import { POOL_SET, EXTRA, EXTRA_WT, EXTRA_FREQ, POOL_GROUPS } from './game/pools'
import { exportShotPng, exportShotGif } from './game/exporter'

/* ================= 连接状态（WebSocket → GameRoom；变量名沿用旧模板绑定） =================
   身份：localStorage 持久化的 clientId 替代 Firebase uid。建房者=赤营、加入者=青营，
   席位/房主/阵营名随 state 一起走 WS 全量同步（方案 B：纯转发器，DO 不解析业务）。 */
const fbStatus = wsStatus
const fbError = wsError
const CLIENT_KEY = 'fh_client_id'
const uid = (() => {
  let v = localStorage.getItem(CLIENT_KEY)
  if (!v) {
    v = (crypto.randomUUID && crypto.randomUUID()) || 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    localStorage.setItem(CLIENT_KEY, v)
  }
  return v
})()
const connText = computed(
  () =>
    ({
      idle: '',
      connecting: '连接中…',
      ok: '已连接服务器',
      lost: '连接断开，重连中…',
      error: fbError.value || '连接失败',
    }[fbStatus.value])
)
const lobbyStatusText = computed(
  () =>
    ({
      connecting: '正在连接服务器…',
      ok: '已连接服务器，等待创建房间',
      lost: '连接断开，正在重连…',
      error: '连接失败：' + fbError.value,
    }[fbStatus.value] || '')
)

/* ================= 房间联机（WS 全量快照，方案 B） =================
   WS 消息即云端 state（原 rooms/{roomId}/state 字段）+ 附加 meta/players：
     { seed, side, poolMask, board, currentTurn, round, redScore, blueScore,
       history, status, endReason,
       meta:    { hostId },                                   // 原 hostUid → clientId
       players: { red: { clientId, name } | null, blue: … } } // 原 uid → clientId
   本地仍用 A/B 表示赤/青，与线上 red/blue 在同步边界互转。 */
const roomState = ref('lobby') // lobby | playing
const joinCode = ref('')
const roomCode = ref('')
const roomBusy = ref(false)
const lobbyMsg = ref(null)
const players = ref({})
const roomMeta = ref(null)
const myTeam = computed(() => {
  const p = players.value || {}
  if (p.red?.clientId === uid) return 'A'
  if (p.blue?.clientId === uid) return 'B'
  return null
})
/* 在线状态：100% 事件驱动（无轮询）。
   - peers 快照：连接建立后由 DO 发一次（在线者 + 离线者及其离线时间）
   - peer_online / peer_offline：DO 在 __hello / webSocketClose 时推送
   对方离线只做「标记」，不暂停对战：对方离线时仍可正常提交（同步不依赖对方在线）。 */
const redOnline = ref(true)
const blueOnline = ref(true)
const peerKickable = ref(false) /* 对方离线满 1 分钟：徽标变踢出按钮（离线满 1 分钟时由一次性定时器点亮） */
const gotRoomSnapshot = ref(false)
/* 对方席位离线：显示横幅与徽标；离线满 1 分钟徽标变踢出按钮（手动踢），也可被新成员顶替 */
const peerOffline = computed(
  () =>
    roomState.value === 'playing' &&
    myTeam.value &&
    gotRoomSnapshot.value &&
    !(myTeam.value === 'A' ? blueOnline.value : redOnline.value)
)
function kickPeer() {
  if (!roomCode.value || !myTeam.value) return
  const seat = myTeam.value === 'A' ? 'blue' : 'red'
  const p = players.value || {}
  const target = p[seat] && p[seat].clientId
  if (!confirm(`将「${teamNames.value[myTeam.value === 'A' ? 'B' : 'A']}」移出房间？对方会立刻回到大厅，席位空出。`)) return
  if (target) sendKick(target) /* 瞬时踢人：DO 直接 close 对方 ws（若仍连着） */
  /* 被踢者是房主 → 房主转让给另一席（我） */
  if (target && roomMeta.value && roomMeta.value.hostId === target) {
    roomMeta.value = { ...roomMeta.value, hostId: uid }
  }
  players.value = { ...p, [seat]: null }
  syncState()
  flashTip('对方席位已空出。', 'ok')
}
/* 回合锁：只有轮到自己阵营时才能出牌（观战身份不能出牌） */
const myTurn = computed(() => myTeam.value !== null && currentTeam.value === myTeam.value)

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return s
}

/* ---- 可复现随机：mulberry32 + 种子洗牌，双方由同一 seed 生成同一副棋盘 ---- */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seededShuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
/* 额外字：按唐诗+宋词合计频次加权、不放回地抽 k 个（棋盘上同字只能一格，且避开基础字库） */
function seededPickExtras(k, rng, excludeSet) {
  const idx = []
  const w = []
  for (let i = 0; i < EXTRA.length; i++) {
    if (excludeSet && excludeSet.has(EXTRA[i])) continue
    idx.push(i)
    w.push(EXTRA_WT[i])
  }
  const out = []
  for (let n = 0; n < k && idx.length; n++) {
    let total = 0
    for (const x of w) total += x
    const r = rng() * total
    let acc = 0
    let pick = w.length - 1
    for (let i = 0; i < w.length; i++) {
      acc += w[i]
      if (r < acc) {
        pick = i
        break
      }
    }
    out.push(EXTRA[idx[pick]])
    idx.splice(pick, 1)
    w.splice(pick, 1)
  }
  return out
}
function buildBoard(seed, side, extraN, poolChars) {
  const rng = mulberry32(seed)
  const total = side * side
  const poolSet = new Set(poolChars)
  const picked = seededShuffle(poolChars.slice(), rng)
    .slice(0, total - extraN)
    .concat(seededPickExtras(extraN, rng, poolSet))
  seededShuffle(picked, rng) /* 额外字与基础字混在一起铺，位置不带规律 */
  return picked.map((ch) => ({ ch, owner: null }))
}

/* ---- 本地 A/B ↔ 云端 red/blue ---- */
function localToCloudState() {
  return {
    seed: gameState.seed,
    side: gameState.side,
    totalRounds: 0,
    endless: true,
    poolMask: (poolSel.value.tang ? 1 : 0) | (poolSel.value.song ? 2 : 0) | (poolSel.value.su ? 4 : 0) | (poolSel.value.xin ? 8 : 0) | (poolSel.value.songx ? 16 : 0) | (poolSel.value.su2 ? 32 : 0) | (poolSel.value.xin2 ? 64 : 0) | (poolSel.value.su3 ? 128 : 0) | (poolSel.value.xin3 ? 256 : 0),
    board: gameState.board.map((c) => ({
      ch: c.ch,
      owner: c.owner === 'A' ? 'red' : c.owner === 'B' ? 'blue' : null,
    })),
    currentTurn: currentTeam.value === 'A' ? 'red' : 'blue',
    round: currentRound.value,
    redScore: score.value.a,
    blueScore: score.value.b,
    history: gameState.log.map((e) => ({ ...e, team: e.team === 'A' ? 'red' : 'blue' })),
    status: gameState.phase,
    endReason: finishReason.value || null,
    /* 方案 B：房间管理信息（房主/席位/阵营名）随 state 一起全量同步 */
    meta: { hostId: (roomMeta.value && roomMeta.value.hostId) || '' },
    players: {
      red: players.value.red ? { clientId: players.value.red.clientId, name: players.value.red.name } : null,
      blue: players.value.blue ? { clientId: players.value.blue.clientId, name: players.value.blue.name } : null,
    },
  }
}
function cloudToLocalState(st) {
  return {
    seed: st.seed || 0,
    side: st.side || Math.round(Math.sqrt((st.board || []).length)) || 10,
    totalRounds: 0,
    endless: true,
    poolMask: typeof st.poolMask === 'number' ? st.poolMask : 511,
    board: (st.board || []).map((c) => ({
      ch: c.ch,
      owner: c.owner === 'red' ? 'A' : c.owner === 'blue' ? 'B' : null,
    })),
    /* 由 currentTurn + round 还原 turnNo（本地回合奇偶逻辑依赖它） */
    turnNo: (Math.max(1, st.round || 1) - 1) * 2 + (st.currentTurn === 'blue' ? 2 : 1),
    log: (st.history || []).map((e) => ({ ...e, team: e.team === 'red' ? 'A' : e.team === 'blue' ? 'B' : e.team })),
    phase: st.status || 'ready',
  }
}

/* ---- 旧 3s 轮询 / 心跳 / JSON 比对层已整体删除：连接、推送、断线重连由 src/useWebSocket.js 负责 ---- */
/* ---- 应用对端/服务端快照：消息即 state（顶层含 meta/players），直接覆盖本地 ---- */
let iHadSeat = false /* 我曾占席：快照中席位丢失 → 判定被移出（瞬时踢人兜底） */
function applyRoomSnapshot(st) {
  if (!st || typeof st !== 'object') return
  if (st.meta) roomMeta.value = st.meta
  if (st.players) players.value = st.players
  gotRoomSnapshot.value = true
  /* 被移出判定：我曾占席，且当前两个席位都没有我的 clientId */
  if (iHadSeat && !seatOf(uid)) {
    exitRoom('kicked')
    return
  }
  if (seatOf(uid)) iHadSeat = true
  const local = cloudToLocalState(st)
  finishReason.value = st.endReason || ''
  gameState.seed = local.seed
  gameState.side = local.side
  gameState.totalRounds = local.totalRounds
  gameState.endless = local.endless
  applyPoolMask(local.poolMask)
  gameState.board = local.board
  gameState.turnNo = local.turnNo
  gameState.log = local.log
  gameState.phase = local.phase
  ensureSeat()
}

/* ---- 把本地最新状态整体推给 DO（提交/放弃/撤销/结算/开局/重抽/改名/占席共用） ----
   方案 B：消息即整份 state，DO 原样广播给对方并异步持久化（storage + D1） */
function syncState() {
  if (!roomCode.value) return
  sendRaw(JSON.stringify(localToCloudState()))
}

/* ---- 在线状态（事件驱动：peers 快照 + peer_online/peer_offline 推送） ----
   席位规则：对方离线只做标记，不自动移除；手动踢出、被新人顶替均即时生效。
   踢出按钮：对方离线满 1 分钟出现（离线时刻由 DO 事件提供）。 */
let peersInfo = {} /* { [clientId]: { online, offlineAt } }：事件驱动的成员在线状态 */
let peersSeen = false /* 已收到过 peers 快照：ensureSeat 的前置条件（防状态未同步时误判顶替） */
let kickTimer = null /* 「离线满 1 分钟」点亮踢出按钮的一次性定时器 */
function seatOf(cid) {
  const p = players.value || {}
  if (p.red && p.red.clientId === cid) return 'red'
  if (p.blue && p.blue.clientId === cid) return 'blue'
  return null
}
/* peers 快照（连接建立后 DO 发一次，重连也会重发）：整体覆盖成员在线状态 */
function onPeers(list) {
  const next = {}
  for (const it of list || []) {
    if (!it || !it.clientId) continue
    next[it.clientId] = { online: !!it.online, offlineAt: it.offlineAt || 0 }
  }
  peersInfo = next
  peersSeen = true
  refreshOnline()
  ensureSeat() /* 无席兜底：快照到齐即补坐 */
}
function onPeerOnline(clientId) {
  if (!clientId || clientId === uid) return
  peersInfo = { ...peersInfo, [clientId]: { online: true, offlineAt: 0 } }
  refreshOnline()
  /* 对方回来了：清掉离线类提示并告知已恢复 */
  if (msg.value && /对方(连接已断开|已被移出房间)/.test(msg.value.text)) {
    clearMsg()
    flashTip('对方已重新连接。', 'ok')
  }
}
function onPeerOffline(clientId, code) {
  if (!clientId || clientId === uid) return /* 同设备重连的旧连接广播（理论已过滤），防自误离线 */
  peersInfo = { ...peersInfo, [clientId]: { online: false, offlineAt: Date.now() } }
  refreshOnline()
  if (code === 4001) flashTip('对方已被移出房间。', 'warn')
  else flashTip('对方连接已断开。', 'warn')
}
/* 由 peersInfo 推导红青两营在线徽标 + 安排「离线满 1 分钟」的踢出按钮 */
function refreshOnline() {
  const now = Date.now()
  const p = players.value || {}
  const isOnline = (cid) => !cid || cid === uid || !!(peersInfo[cid] && peersInfo[cid].online)
  redOnline.value = isOnline(p.red && p.red.clientId)
  blueOnline.value = isOnline(p.blue && p.blue.clientId)
  if (kickTimer) {
    clearTimeout(kickTimer)
    kickTimer = null
  }
  peerKickable.value = false
  const otherSeat = myTeam.value === 'A' ? 'blue' : myTeam.value === 'B' ? 'red' : null
  const target = otherSeat && p[otherSeat] && p[otherSeat].clientId
  const info = target && peersInfo[target]
  if (!target || !info || info.online) return
  const wait = 60000 - (now - info.offlineAt) /* 离线满 1 分钟 → 出现踢出按钮 */
  if (wait <= 0) {
    peerKickable.value = true
    return
  }
  kickTimer = setTimeout(() => {
    kickTimer = null
    peerKickable.value = true
  }, wait)
}
/* 席位人员变化（坐席/换营/踢出/云端同步）→ 重算在线徽标与踢出按钮 */
watch(() => players.value, refreshOnline)

/* ---- 坐席兜底（替代原 joinPending 单次选席）：房内但无席时随时补坐 ----
   空席优先（全空进青营）；占席仅当占席者已离线（不在线上名单，由 peers 快照/事件给出），
   双席均离线时顶离线更久者；被顶者是房主 → 房主随之转让。
   两席均有人且在线：新加入者退出回大厅；曾占席者等待顶替者的踢出广播。 */
function ensureSeat() {
  if (!roomCode.value || seatOf(uid)) return
  if (!peersSeen || !gotRoomSnapshot.value) return
  const p = players.value || {}
  const isOnline = (cid) => !!(peersInfo[cid] && peersInfo[cid].online)
  const offlineAt = (cid) => (peersInfo[cid] && peersInfo[cid].offlineAt) || 0 /* 无记录视为最早已离线 */
  const empty = (s) => !p[s] || !p[s].clientId
  const away = (s) => !empty(s) && !isOnline(p[s].clientId)
  let target = null
  if (empty('blue') && empty('red')) target = 'blue'
  else if (empty('blue')) target = 'blue'
  else if (empty('red')) target = 'red'
  else if (away('blue') && away('red')) target = offlineAt(p.red.clientId) <= offlineAt(p.blue.clientId) ? 'red' : 'blue'
  else if (away('blue')) target = 'blue'
  else if (away('red')) target = 'red'
  if (!target) {
    if (joinPending && !joinPending.decided) {
      joinPending.decided = true
      exitRoom()
      lobbyMsg.value = { text: '房间已满（赤青两营均有玩家且都在线）。', kind: 'err' }
    }
    return
  }
  if (joinPending) joinPending.decided = true
  const replacing = !empty(target)
  const oldCid = replacing ? p[target].clientId : null
  const other = target === 'red' ? 'blue' : 'red'
  /* 坐席 + 脏数据自愈：若另一席残留着我的 clientId（异常历史 state），一并清掉 */
  players.value = {
    ...p,
    [target]: { clientId: uid, name: target === 'red' ? '赤营' : '青营' },
    [other]: p[other] && p[other].clientId === uid ? null : p[other],
  }
  /* 被顶者是房主 → 房主转让给坐席者 */
  if (replacing && roomMeta.value && roomMeta.value.hostId === oldCid) {
    roomMeta.value = { ...roomMeta.value, hostId: uid }
  }
  syncState()
  if (replacing) {
    sendKick(oldCid) /* 瞬时踢人：DO 直接关掉对方残留的 ws（若有） */
    flashTip(`原${target === 'red' ? '赤营' : '青营'}已离线，你已加入其席位。`, 'ok')
  }
}

/* ---- 切换阵营（点击棋盘上方的阵营标签触发）：目标席为空时，先占目标席再释放原席 ---- */
function pickTeam(t) {
  if (!roomCode.value) return
  if (!myTeam.value || myTeam.value === t) return
  if (!canSwitchSide.value) {
    flashTip('对方在座时不能切换阵营。', 'warn')
    return
  }
  const toSeat = t === 'A' ? 'red' : 'blue'
  const fromSeat = t === 'A' ? 'blue' : 'red'
  players.value = {
    ...players.value,
    [toSeat]: { clientId: uid, name: toSeat === 'red' ? '赤营' : '青营' },
    [fromSeat]: null,
  }
  syncState()
  flashTip(`已切换到${t === 'A' ? '赤营' : '青营'}席位。`, 'ok')
}
const canSwitchSide = computed(() => {
  const p = players.value || {}
  if (!myTeam.value || !uid) return false
  const other = myTeam.value === 'A' ? p.blue : p.red
  return !other || !other.clientId /* 对方席为空：房间只有我一个 */
})

let pendingCreate = false /* 建房者标记：WS 连接建立后立即推送初始 state */
let joinPending = null /* 加入中：{ code, decided }，快照 + peers 到齐后选席 */
function enterRoom(code, asHost) {
  roomCode.value = code
  sessionStorage.setItem('fh_room', code)
  rememberRoom(code, asHost)
  roomState.value = 'playing'
  connectWs(code, {
    clientId: uid,
    onOpen: onWsOpen,
    onMessage: (st) => applyRoomSnapshot(st),
    onPeers: onPeers,
    onPeerOnline: onPeerOnline,
    onPeerOffline: onPeerOffline,
    onRejected: onWsRejected,
  })
}
/* 连接建立：DO 会把已保存的 state 回放给新连接（applyRoomSnapshot 处理），
   并在 __hello 后回发 peers 成员快照（onPeers 处理）；建房者在此立即推送初始 state */
function onWsOpen() {
  if (pendingCreate) {
    pendingCreate = false
    syncState()
  }
}
/* DO 拒绝连接（4001 连接数超限 / 被踢出，4000 席位被顶替）→ 回大厅 */
function onWsRejected(code, reason) {
  if (/踢出/.test(reason || '')) exitRoom('kicked')
  else if (/顶替/.test(reason || '')) exitRoom('replaced')
  else exitRoom()
  lobbyMsg.value = { text: reason || '无法进入房间。', kind: 'err' }
}
/* 退出房间：主动退出时若我是房主且另一席有人 → 先转让房主再断开（房主仅是创建者标记，无权限差异）
   reason: 'kicked' 被移出 | 'replaced' 席位被顶替 | 其余为主动退出 */
function exitRoom(reason) {
  if (!reason && roomCode.value && myTeam.value) {
    const host = roomMeta.value && roomMeta.value.hostId
    const otherSeat = myTeam.value === 'A' ? 'blue' : 'red'
    const other = (players.value || {})[otherSeat]
    if (host === uid && other && other.clientId) {
      roomMeta.value = { ...roomMeta.value, hostId: other.clientId }
      syncState() /* 推送转让后再断开，DO 异步持久化不丢 */
    }
  }
  closeWs()
  sessionStorage.removeItem('fh_room')
  roomCode.value = ''
  players.value = {}
  roomMeta.value = null
  redOnline.value = true
  blueOnline.value = true
  peerKickable.value = false
  gotRoomSnapshot.value = false
  iHadSeat = false
  peersSeen = false
  peersInfo = {}
  if (kickTimer) {
    clearTimeout(kickTimer)
    kickTimer = null
  }
  pendingCreate = false
  joinPending = null
  roomState.value = 'lobby'
  if (reason === 'kicked') lobbyMsg.value = { text: '你已被移出房间。', kind: 'warn' }
  if (reason === 'replaced') lobbyMsg.value = { text: '你的席位被新玩家顶替。', kind: 'warn' }
}

/* ---- 最近加入的房间（localStorage 持久化，最多 5 条） ---- */
const RECENT_KEY = 'fh_recent_rooms'
const recentRooms = ref(loadRecentRooms())
function loadRecentRooms() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(list) ? list.filter((r) => r && r.code) : []
  } catch {
    return []
  }
}
function rememberRoom(code, asHost) {
  /* host 是「我是创建者」的事实标记：刷新/回连（joinRoom 路径）不覆盖已有 host=true */
  const prev = loadRecentRooms().find((r) => r.code === code)
  const host = !!asHost || !!(prev && prev.host)
  const list = loadRecentRooms().filter((r) => r.code !== code)
  list.unshift({ code, at: Date.now(), host })
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)))
  recentRooms.value = loadRecentRooms()
}
function relTime(ts) {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24)
  if (d < 7) return d + ' 天前'
  return new Date(ts).toLocaleDateString('zh-CN')
}
function rejoin(r) {
  if (roomBusy.value) return
  joinCode.value = r.code
  joinRoom()
}

async function createRoom() {
  if (roomBusy.value) return
  roomBusy.value = true
  try {
    const code = genCode() /* DO 按 code 路由，无需向服务器探重名（32^6 碰撞概率可忽略） */
    /* 用当前顶栏设置初始化一局：seed → 棋盘 → 连接建立后推送初始 state */
    gameState.side = clampSizeInput()
    redrawBoard()
    gameState.phase = 'ready'
    gameState.turnNo = 1
    gameState.log = []
    gameState.undoStack = []
    finishReason.value = ''
    players.value = { red: { clientId: uid, name: '赤营' }, blue: null }
    roomMeta.value = { hostId: uid, createdAt: Date.now() }
    lobbyMsg.value = null
    pendingCreate = true
    enterRoom(code, true)
  } catch (e) {
    lobbyMsg.value = { text: '创建房间失败：' + e.message, kind: 'err' }
  } finally {
    roomBusy.value = false
  }
}

function forgetRoom(code) {
  const list = loadRecentRooms().filter((r) => r.code !== code)
  localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  recentRooms.value = loadRecentRooms()
}

async function joinRoom() {
  if (roomBusy.value) return
  const code = joinCode.value.trim().toUpperCase()
  if (!code) {
    lobbyMsg.value = { text: '请先输入房间码。', kind: 'err' }
    return
  }
  roomBusy.value = true
  try {
    lobbyMsg.value = null
    joinPending = { code, decided: false }
    enterRoom(code, false)
    /* 坐席由 ensureSeat 兜底（快照/peers 到齐即补坐）；3 秒内无快照 → 房间不存在 */
    setTimeout(() => {
      if (!joinPending) return
      if (!gotRoomSnapshot.value) {
        forgetRoom(code)
        exitRoom()
        lobbyMsg.value = { text: '房间不存在（可能已解散）。', kind: 'err' }
        joinPending = null
      } else if (peersSeen) {
        ensureSeat() /* 兜底：peers 快照已到但竞速错过 onPeers 的 ensureSeat */
        joinPending = null /* 房间存在性已判定；后续选席由 ensureSeat 常驻兜底 */
      }
      /* 快照已到、peers 未到：保留 joinPending，等 onPeers → ensureSeat 完成选席 */
    }, 3000)
  } finally {
    roomBusy.value = false
  }
}
/* ================= 常量 ================= */
const TEAM_NAME = { A: '赤营', B: '青营' }
/* 阵营名：默认赤营/青营，双方可各自改名；状态条、提示、记录与导出图统一用它 */
const teamNames = computed(() => ({
  A: (players.value.red && players.value.red.name) || TEAM_NAME.A,
  B: (players.value.blue && players.value.blue.name) || TEAM_NAME.B,
}))
/* 改阵营名：输入框回显自定义名（默认名留空提示），回车或点按钮提交 */
const teamNameInput = ref('')
watch([myTeam, roomState], () => {
  const p = players.value || {}
  const mine = myTeam.value === 'A' ? p.red : myTeam.value === 'B' ? p.blue : null
  teamNameInput.value = mine && mine.name && mine.name !== TEAM_NAME[myTeam.value] ? mine.name : ''
})
function saveTeamName() {
  if (!myTeam.value || !roomCode.value) return
  const name = teamNameInput.value.trim()
  if (!name) { flashTip('阵营名不能为空。', 'warn'); return }
  if (name.length > 12) { flashTip('阵营名最多 12 个字。', 'err'); return }
  const seat = myTeam.value === 'A' ? 'red' : 'blue'
  const p = players.value || {}
  players.value = { ...p, [seat]: { ...(p[seat] || { clientId: uid }), name } }
  syncState()
  flashTip('✓ 阵营名已更新，双方界面与战报图都会显示新名字。', 'ok')
}
const TEAM_MARK = { A: '赤', B: '青' }

/* ================= 全局游戏状态 ================= */
const gameState = reactive({
  seed: 0, // 随机种子：双方由同一 seed 生成同一副棋盘
  side: 10,
  board: [], // [{ ch, owner: null | 'A' | 'B' }]
  phase: 'ready', // ready | playing | over
  totalRounds: 0, // 固定 0（保留字段兼容旧存档同步协议，不再使用）
  endless: true,
  turnNo: 1, // 1-based 总出手次数
  log: [], // 飞花 / 放弃记录
  undoStack: [],
})

/* ---------- 顶栏设置 ---------- */
const sizeInput = ref(10)
const extraInput = ref(0)
const fixMode = ref(false)
const allowDup = ref(false)
const keepPunct = ref(false)

/* ---------- 字库集合选择（开局前，房主设置，随 state.poolMask 同步双方） ---------- */
const POOL_OPTIONS = [
  { key: 'tang', label: '全唐诗 300' },
  { key: 'song', label: '全宋词 300' },
  { key: 'songx', label: '宋词 300（不含唐诗字）' },
  { key: 'su', label: '苏轼词 1–200' },
  { key: 'su2', label: '苏轼词 201–400' },
  { key: 'su3', label: '苏轼词 401–600' },
  { key: 'xin', label: '辛弃疾词 1–200' },
  { key: 'xin2', label: '辛弃疾词 201–400' },
  { key: 'xin3', label: '辛弃疾词 401–600' },
]
const poolSel = ref({ tang: true, song: true, songx: true, su: true, su2: true, su3: true, xin: true, xin2: true, xin3: true }) // 默认全选
const activePool = computed(() => {
  const out = []
  const seen = new Set()
  for (const opt of POOL_OPTIONS) {
    if (!poolSel.value[opt.key]) continue
    for (const ch of POOL_GROUPS[opt.key]) {
      if (!seen.has(ch)) {
        seen.add(ch)
        out.push(ch)
      }
    }
  }
  return out
})
const activePoolSet = computed(() => new Set(activePool.value))
const extraAvail = computed(() => EXTRA.reduce((n, ch) => (activePoolSet.value.has(ch) ? n : n + 1), 0))
function togglePool(key) {
  if (gameState.phase !== 'ready') return
  const remaining = POOL_OPTIONS.filter((o) => o.key !== key && poolSel.value[o.key]).length
  if (poolSel.value[key] && remaining === 0) return // 至少保留一个字库
  poolSel.value[key] = !poolSel.value[key]
  redrawBoard()
  syncState()
}
function selectAllPools() {
  if (gameState.phase !== 'ready') return
  poolSel.value = { tang: true, song: true, songx: true, su: true, su2: true, su3: true, xin: true, xin2: true, xin3: true }
  redrawBoard()
  syncState()
}
function applyPoolMask(mask) {
  /* 按位解析：tang=1 song=2 su=4 xin=8 songx=16 su2=32 xin2=64 su3=128 xin3=256；
     旧对局(0-127)无 su3/xin3 位，解析为未勾，可手动补选 */
  const m = typeof mask === 'number' && mask >= 0 && mask <= 511 ? mask : 511
  poolSel.value = {
    tang: !!(m & 1),
    song: !!(m & 2),
    su: !!(m & 4),
    xin: !!(m & 8),
    songx: !!(m & 16),
    su2: !!(m & 32),
    xin2: !!(m & 64),
    su3: !!(m & 128),
    xin3: !!(m & 256),
  }
}

/* ---------- 派生状态 ---------- */
const cellTotal = computed(() => gameState.side * gameState.side)
const currentTeam = computed(() => (gameState.turnNo % 2 === 1 ? 'A' : 'B'))
const score = computed(() => {
  let a = 0, b = 0, n = 0
  for (const c of gameState.board) {
    if (c.owner === 'A') a++
    else if (c.owner === 'B') b++
    else n++
  }
  return { a, b, n }
})
const currentRound = computed(() => {
  /* 结算后按实际出手数回算，避免无尽局末多数出 1 轮 */
  if (gameState.phase === 'over') {
    const moved = gameState.log.filter((e) => e.type === 'fly' || e.type === 'pass').length
    return Math.max(1, Math.ceil(moved / 2))
  }
  const r = Math.ceil(gameState.turnNo / 2)
  return r
})
const phaseText = computed(() => {
  if (gameState.phase === 'ready') return '待开局'
  if (gameState.phase === 'playing') return `进行中 · 轮到 ${teamNames.value[currentTeam.value]}`
  return '对战结束'
})
const flyTurns = computed(() => gameState.log.filter((e) => e.type === 'fly').length)
const flyLogs = computed(() => gameState.log.filter((e) => e.type === 'fly' || e.type === 'pass').slice().reverse())
const resultFlies = computed(() => gameState.log.filter((e) => e.type === 'fly'))

/* ---------- 字库面板 ---------- */
const poolOn = computed(() => {
  const m = {}
  for (const c of gameState.board) m[c.ch] = true
  return m
})
const extraOnBoard = computed(() => {
  const sel = activePoolSet.value
  const ex = gameState.board.filter((c) => !sel.has(c.ch)).map((c) => c.ch)
  ex.sort((x, y) => (EXTRA_FREQ[y] || 0) - (EXTRA_FREQ[x] || 0))
  return ex
})

/* ---------- 消息条 ---------- */
const msg = ref(null) // { text, kind: ok|warn|err }
let msgTimer = null /* 提示自动消失：5 秒后清除，新提示会重置计时 */
function flashTip(text, kind = 'ok') {
  msg.value = { text, kind }
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(clearMsg, 5000)
}
function clearMsg() {
  msg.value = null
  if (msgTimer) {
    clearTimeout(msgTimer)
    msgTimer = null
  }
}

/* ================= 工具函数 ================= */
function cjkOnly(s) {
  return (s || '').replace(/[^\u4e00-\u9fa5]/g, '')
}
/* 飞花记录里的诗句文本：默认把标点等非文字符号折成空格；勾选后原样保留（换行折空格）。
   涂色判定始终只看汉字（cjkOnly），显示口径不影响规则。 */
function fmtPoem(raw, fallback) {
  const s = (raw || '').replace(/\r\n?/g, '\n').trim()
  if (!s) return fallback || ''
  if (keepPunct.value) return s.replace(/\s*\n+\s*/g, ' ')
  return s.replace(/[^\u3400-\u4DBF\u4E00-\u9FA5\u3007A-Za-z0-9]+/g, ' ').trim() || (fallback || '')
}

/* 输入归一化：繁体转简体（棋盘与历史记录都是简体口径）；opencc-js 懒加载，首次提交才加载词典 */
let t2s = null
async function toSimplified(s) {
  if (!t2s) {
    const OpenCC = (await import('opencc-js')).default
    t2s = OpenCC.Converter({ from: 't', to: 'cn' })
  }
  return t2s(s)
}

/* ================= 棋盘 ================= */
/* 由 seed 确定性生成：host 重抽时产生新 seed 并随 state 同步，双方棋盘一致 */
function redrawBoard(seed = Math.floor(Math.random() * 2 ** 31)) {
  const cap = Math.min(cellTotal.value, EXTRA.length)
  const extraN = Math.max(0, Math.min(cap, parseInt(extraInput.value, 10) || 0))
  extraInput.value = extraN
  gameState.seed = seed
  gameState.board = buildBoard(seed, gameState.side, extraN, activePool.value)
  previewSet.value = new Set()
  changedNow.value = {}
}

/* ================= 导出（战报截图 / 逐手回放 GIF） ================= */
function exportGameCtx() {
  return {
    side: gameState.side,
    cells: gameState.side * gameState.side,
    board: gameState.board,
    log: gameState.log,
    phase: gameState.phase,
    totalRounds: 0,
    endless: true,
    round: currentRound.value,
    names: teamNames.value,
    hitKinds,
  }
}
const onExportPng = () => exportShotPng(exportGameCtx(), flashTip)
const onExportGif = () => exportShotGif(exportGameCtx(), flashTip)

/* 出手前预览：输入句命中的格子刷成己方阵营的半透明色（对方回合也可作草稿预览） */
const poemInput = ref('')
const previewSet = ref(new Set())
/* 输入锁定：仅未开局 / 已结束时锁（对局中对方回合也可打草稿，但提交按钮仍锁定） */
const poemLocked = computed(() => gameState.phase !== 'playing')
const poemPlaceholder = computed(() => {
  if (gameState.phase !== 'playing') return '点击上方「开始对战」后解锁'
  if (!myTurn.value) return '可先打草稿，轮到你时提交'
  return '在此输入诗句，如：床前明月光，疑是地上霜（回车提交）'
})
function updatePreview() {
  previewSet.value = new Set(cjkOnly(poemInput.value).split(''))
}

/* 本手刚变化的格子：白描边 1.05 秒后褪掉 */
const changedNow = ref({})
let changedTimer = null
function markChanged(map) {
  changedNow.value = map || {}
  if (changedTimer) {
    clearTimeout(changedTimer)
    changedTimer = null
  }
  if (!Object.keys(changedNow.value).length) return
  changedTimer = setTimeout(() => {
    changedTimer = null
    changedNow.value = {}
  }, 1080)
}

/* 每格当前的"视觉颜色令牌"：相邻格令牌相同且非空白 → 格线隐藏，墨块连成整片 */
function colorToken(i) {
  const cell = gameState.board[i]
  if (!cell) return 'blank'
  const o = cell.owner
  if (gameState.phase === 'playing' && previewSet.value.has(cell.ch)) {
    const t = myTeam.value
    if (o === t) return 'own' + t
    return 'pv' + t + (o || 'N')
  }
  return o ? 'own' + o : 'blank'
}
/* 唯一的格子渲染入口：所有者配色 + 预览配色 + 邻接格线合并 */
function cellClass(i) {
  const cell = gameState.board[i]
  if (!cell) return ['cell']
  const side = gameState.side
  const col = i % side
  const row = (i - col) / side
  const token = colorToken(i)
  const cls = ['cell']
  if (cell.owner) cls.push('own-' + cell.owner)
  if (gameState.phase === 'playing' && previewSet.value.has(cell.ch)) {
    cls.push('pv-' + myTeam.value)
    if (!cell.owner) cls.push('pv-new')
    else if (cell.owner !== myTeam.value) cls.push('pv-cap')
    else cls.push('pv-hold')
  }
  if (fixMode.value) cls.push('fixable')
  if (changedNow.value[i]) cls.push('flash')
  const hideR = col === side - 1 || (token !== 'blank' && colorToken(i + 1) === token)
  const hideB = row === side - 1 || (token !== 'blank' && colorToken(i + side) === token)
  if (hideR) cls.push('nb-r')
  if (hideB) cls.push('nb-b')
  return cls
}

/* 修正模式：点击格子循环切换 无主 → 赤 → 青 → 无主 */
function onCellClick(idx) {
  if (!fixMode.value) return
  const order = [null, 'A', 'B']
  const cur = gameState.board[idx].owner
  const next = order[(order.indexOf(cur) + 1) % 3]
  gameState.board[idx].owner = next
  syncState()
  flashTip(`修正：${gameState.board[idx].ch} → ${next ? teamNames.value[next] : '无主'}`, 'ok')
}

/* 字号随格子实际宽度走：5×5 不至于小字淹没，20×20 不至于挤成一团 */
const boardEl = ref(null)
const cellFs = ref(27)
const boardStyle = computed(() => ({
  gridTemplateColumns: `repeat(${gameState.side}, 1fr)`,
  '--cell-fs': cellFs.value + 'px',
}))
function sizeCellFont() {
  const w = boardEl.value?.clientWidth || 0
  if (!w) return
  cellFs.value = Math.max(9, Math.min(36, Math.round((w / gameState.side) * 0.54)))
}
watch([roomState, () => gameState.side], async () => {
  await nextTick()
  sizeCellFont()
})

/* ================= 诗句命中标记（记录 / 结算面板共用） ================= */
function cellsOf(e) {
  if (e.cells) return e.cells
  const set = {}
  for (const ch of e.line || '') set[ch] = true
  const out = []
  gameState.board.forEach((c, k) => {
    if (set[c.ch]) out.push(k)
  })
  return out
}
/* 返回 {字: "new"|"cap"|"hold"}：从历史记录重放得到"这一手落子前"每格归谁 */
function hitKinds(e) {
  const owners = gameState.board.map(() => null)
  let out = null
  for (const x of gameState.log) {
    if (x.type !== 'fly' && x.type !== 'pass') continue
    const map = {}
    if (x.type === 'fly') {
      for (const idx of cellsOf(x)) {
        if (idx == null || idx < 0 || idx >= owners.length) continue
        const before = owners[idx]
        map[gameState.board[idx].ch] = before == null ? 'new' : before === x.team ? 'hold' : 'cap'
        owners[idx] = x.team
      }
    }
    if (x === e) out = map
  }
  return out || {}
}
/* 诗句 → 分段数组（命中的字带 new/cap/hold 标记），模板里用 v-for 渲染 */
function poemSegs(e) {
  const s = fmtPoem(e.raw, e.line)
  const map = hitKinds(e)
  const segs = []
  let run = ''
  const seen = {}
  for (const ch of s) {
    const k = map[ch]
    if (!k || seen[ch]) {
      run += ch
      continue
    }
    seen[ch] = 1
    if (run) {
      segs.push({ text: run })
      run = ''
    }
    segs.push({ text: ch, kind: k })
  }
  if (run) segs.push({ text: run })
  return segs
}

/* ================= 核心判定：飞花 ================= */
let submitting = false /* 防重入：await 换繁转简期间连点/连按回车会双提交（第二次校验时格子已涂色 → 误报违反规则 3） */
async function submitLine() {
  if (gameState.phase !== 'playing') return
  if (submitting) return
  if (!myTurn.value) {
    flashTip(myTeam.value === null ? '观战身份不能出牌。' : '还没轮到你出牌，请等待对方。', 'err')
    return
  }
  /* 房主离线不阻断：state 写云端不依赖房主客户端在线 */
  const raw = poemInput.value
  const chars = cjkOnly(raw)
  if (!chars) {
    flashTip('请先输入诗句（仅中文汉字会被识别）。', 'err')
    return
  }
  submitting = true
  try {
    /* 转简体：棋盘与历史记录都是简体口径，匹配/查重统一用它 */
    const norm = await toSimplified(chars)
    const set = {}
    for (const ch of norm) set[ch] = true

    const hits = [], blanks = [], captures = [], holds = []
    const me = currentTeam.value
    const other = me === 'A' ? 'B' : 'A'
    gameState.board.forEach((cell, idx) => {
      if (set[cell.ch]) {
        hits.push(idx)
        if (!cell.owner) blanks.push(idx)
        else if (cell.owner === other) captures.push(idx)
        else holds.push(idx)
      }
    })

    if (!hits.length) {
      flashTip('✕ 无命中：这句里没有出现棋盘上的任何字，本句无效，请换一句。', 'err')
      return
    }
    if (!blanks.length) {
      flashTip(`✕ 违反规则 3：本句命中的 ${hits.length} 个格子全部已有颜色，没有使用任何一个未填色格，本句无效。`, 'err')
      return
    }
    if (!allowDup.value) {
      const dup = gameState.log.some((e) => e.type === 'fly' && e.norm === norm)
      if (dup) {
        flashTip('✕ 重复句：这句已经飞过了。如需放行，请勾选「允许重复句」。', 'err')
        return
      }
    }

    /* 记录快照，供撤销 */
    gameState.undoStack.push({
      board: gameState.board.map((c) => ({ ch: c.ch, owner: c.owner })),
      logLen: gameState.log.length,
      turnNo: gameState.turnNo,
    })

    /* 涂色：只改响应式数据，视图自动更新；同时记下本手变化的格子供白描边 */
    const changed = {}
    hits.forEach((idx) => {
      if (gameState.board[idx].owner !== me) {
        gameState.board[idx].owner = me
        changed[idx] = 1
      }
    })

    gameState.log.push({
      type: 'fly', team: me, round: currentRound.value, line: norm, norm,
      hits: hits.length, blank: blanks.length, capture: captures.length, hold: holds.length,
      raw: (raw || '').trim(), cells: hits.slice(),
    })

    previewSet.value = new Set()
    markChanged(changed)
    flashTip(
      `✓ ${teamNames.value[me]} 飞花成功：命中 ${hits.length} 格 → 新占 ${blanks.length} · 抢夺 ${captures.length} · 己方 ${holds.length}。` +
        (captures.length ? `（从对方手中抢下 ${captures.length} 格 🔥）` : ''),
      'ok'
    )
    advance()
    syncState()
  } finally {
    submitting = false
  }
}

function advance() {
  poemInput.value = ''
  updatePreview()
  gameState.turnNo++
  focusPoem()
}

function passTurn() {
  if (gameState.phase !== 'playing') return
  if (!myTurn.value) {
    flashTip(myTeam.value === null ? '观战身份不能出牌。' : '还没轮到你出牌，请等待对方。', 'err')
    return
  }
  const me = currentTeam.value
  gameState.undoStack.push({
    board: gameState.board.map((c) => ({ ch: c.ch, owner: c.owner })),
    logLen: gameState.log.length,
    turnNo: gameState.turnNo,
  })
  gameState.log.push({ type: 'pass', team: me, round: currentRound.value })
  flashTip(`已记录：${teamNames.value[me]} 放弃本回合，未涂色。`, 'warn')
  advance()
  syncState()
}

function undo() {
  if (!gameState.undoStack.length) return
  const snap = gameState.undoStack.pop()
  gameState.board = snap.board.map((c) => ({ ...c }))
  gameState.log = gameState.log.slice(0, snap.logLen)
  gameState.turnNo = snap.turnNo
  gameState.phase = 'playing'
  previewSet.value = new Set()
  if (changedTimer) {
    clearTimeout(changedTimer)
    changedTimer = null
  }
  changedNow.value = {}
  clearMsg()
  flashTip('已撤销上一步。', 'warn')
  focusPoem()
  syncState()
}

/* ================= 结算 ================= */
const showResult = ref(false)
const finishReason = ref('')
/* 结算弹窗跟随 phase：本机结算或云端同步为 over 都会触发 */
watch(
  () => gameState.phase,
  (p) => {
    showResult.value = p === 'over'
  }
)
function finish(reason) {
  gameState.phase = 'over'
  finishReason.value = reason || ''
}
const resultInfo = computed(() => {
  const c = score.value
  let win, name, color
  if (c.a > c.b) {
    win = teamNames.value.A + '获胜'; name = `${teamNames.value.A} ${c.a} : ${c.b} ${teamNames.value.B}`; color = 'var(--ink-a)'
  } else if (c.b > c.a) {
    win = teamNames.value.B + '获胜'; name = `${teamNames.value.B} ${c.b} : ${c.a} ${teamNames.value.A}`; color = 'var(--ink-b)'
  } else {
    win = '平局'; name = `${teamNames.value.A} ${c.a} : ${c.b} ${teamNames.value.B}`; color = '#5B6B84'
  }
  const label = `对战结束 · ${finishReason.value || '手动结算'}`
  return { win, name, color, label }
})
function flyCount(team) {
  return gameState.log.filter((e) => e.type === 'fly' && e.team === team).length
}
function capTotal() {
  return gameState.log.reduce((s, e) => s + (e.type === 'fly' ? e.capture : 0), 0)
}
function again() {
  gameState.phase = 'ready'
  gameState.turnNo = 1
  gameState.log = []
  gameState.undoStack = []
  redrawBoard()
  clearMsg()
  flashTip('已重新铺好棋盘，点击「开始对战」即可开局。', 'ok')
  syncState()
}

/* ================= 设置项变更 ================= */
function clampSizeInput() {
  let n = parseInt(sizeInput.value, 10)
  if (!isFinite(n)) n = gameState.side
  n = Math.max(5, Math.min(20, n))
  sizeInput.value = n
  return n
}
function applySize() {
  gameState.side = clampSizeInput()
}
function redrawForSetup() {
  applySize()
  gameState.phase = 'ready'
  gameState.turnNo = 1
  gameState.log = []
  gameState.undoStack = []
  previewSet.value = new Set()
  changedNow.value = {}
  redrawBoard()
  clearMsg()
}
function onRedraw() {
  if (gameState.phase === 'playing') return
  redrawForSetup()
  const k = extraOnBoard.value.length
  syncState()
  flashTip(`已重新抽取 ${cellTotal.value} 字棋盘（${gameState.side}×${gameState.side}${k ? `，含额外字 ${k}` : ''}），随时可以开局。`, 'ok')
}
/* 顶栏按钮：对局结束后 = 再来一局（重抽并回到开局态）；其余 = 重抽棋盘 */
function redrawOrAgain() {
  if (gameState.phase === 'over') again()
  else onRedraw()
}
const redrawLabel = computed(() => (gameState.phase === 'over' ? '再来一局' : '重抽棋盘'))
function startGame() {
  if (gameState.phase === 'playing') return
  /* 改了尺寸但没触发 change：先按新尺寸重铺，否则会拿旧棋盘开局 */
  const n = clampSizeInput()
  if (n !== gameState.side) {
    gameState.side = n
    redrawBoard()
  }
  gameState.phase = 'playing'
  gameState.turnNo = 1
  gameState.log = []
  gameState.undoStack = []
  previewSet.value = new Set()
  flashTip(
    '开局！由 ' + teamNames.value.A + ' 先飞。点「结算」随时结束本局并计算胜负。',
    'ok'
  )
  focusPoem()
  syncState()
}
function onSizeChange() {
  const n = clampSizeInput()
  if (gameState.phase === 'playing') return /* 对局中改尺寸不生效，只影响下一局 */
  if (n === gameState.side) return
  redrawForSetup()
  const k = extraOnBoard.value.length
  flashTip(
    `棋盘已改为 ${gameState.side}×${gameState.side}（${cellTotal.value} 格${k ? `，含额外字 ${k}` : ''}），已重铺。`,
    'ok'
  )
  syncState()
}
function onExtraChange() {
  if (gameState.phase === 'playing') {
    /* 对局中不生效，仅夹紧输入 */
    const cap = Math.min(cellTotal.value, EXTRA.length)
    extraInput.value = Math.max(0, Math.min(cap, parseInt(extraInput.value, 10) || 0))
    return
  }
  const k = parseInt(extraInput.value, 10) || 0
  redrawForSetup()
  syncState()
  flashTip(k ? `已重铺棋盘：其中 ${k} 个额外字（按唐诗+宋词合计频次加权抽取）。` : '已重铺棋盘：只用基础字库（当前勾选集合）。', 'ok')
}
function onFinish() {
  if (confirm('确认结算？')) {
    finish()
    syncState()
  }
}

/* ================= 输入框交互 ================= */
const poemEl = ref(null)
function focusPoem() {
  nextTick(() => poemEl.value && poemEl.value.focus())
}
function onPoemInput() {
  updatePreview()
  clearMsg()
}
function onPoemKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing || e.keyCode === 229) return /* 中文输入法选字回车：不提交，仅上屏候选词 */
    e.preventDefault()
    submitLine()
  }
}
function onPoemMousedown(e) {
  if (gameState.phase !== 'playing') {
    e.preventDefault() /* 不给焦点，只弹指引 */
    lockHint()
  }
}
function lockHint() {
  if (gameState.phase === 'over') {
    flashTip('本局已结束。点顶栏「再来一局」或结算面板里的「再来一局」开新的一局。', 'warn')
  } else {
    flashTip('输入框还没解锁——请先点上方「开始对战」，之后即可输入诗句。', 'warn')
  }
}

/* ================= 启动 ================= */
onMounted(() => {
  /* 断线重连：sessionStorage 记住了房间码就直接回连（clientId 在席位内则自动恢复原席位） */
  const saved = sessionStorage.getItem('fh_room')
  if (saved) {
    joinCode.value = saved
    joinRoom()
  }
  redrawBoard()
})
onBeforeUnmount(() => {
  if (changedTimer) clearTimeout(changedTimer)
  window.removeEventListener('resize', sizeCellFont)
  closeWs()
})
onMounted(() => window.addEventListener('resize', sizeCellFont))
</script>

<template>
  <div class="wrap">
    <header class="top">
      <h1>飞花斯普拉遁</h1>
      <div class="head-tools">
        <span class="conn" :class="fbStatus" :title="fbError || connText"><i></i>{{ connText }}</span>
        <span style="color:#98a4b3;font-size:12px;margin-left:6px;font-weight:600">v2.4</span>
        <span v-if="roomState === 'playing'" class="conn room">房间 {{ roomCode }}</span>
        <span v-if="roomState === 'playing'" class="conn room">你是{{ myTeam ? teamNames[myTeam] : '入席中…' }}</span>
        <template v-if="roomState === 'playing'">
          <label class="chk" title="开启后，点击棋盘格子可循环切换：无主 → 赤 → 青 → 无主">
            <input type="checkbox" v-model="fixMode" /> 修正模式
          </label>
          <label class="sizefield" :class="{ off: gameState.phase === 'playing' }"
                 title="棋盘 N×N（5–20，改完自动重抽棋盘）">
            <input type="number" v-model.number="sizeInput" min="5" max="20" step="1" inputmode="numeric"
                   :disabled="gameState.phase === 'playing'" @change="onSizeChange" />
            <span>× <b>{{ gameState.side }}</b> 格</span>
          </label>
          <label class="sizefield" :class="{ off: gameState.phase === 'playing' }"
                 title="额外字：从额外字池（自动避开已选基础字库）按唐诗+宋词合计频次加权抽取 K 个放进棋盘（0 = 只用基础字库）">
            <input type="number" v-model.number="extraInput" min="0" step="1" inputmode="numeric"
                   :disabled="gameState.phase === 'playing'" @change="onExtraChange" />
            <span>个额外字</span>
          </label>
          <button v-if="gameState.phase !== 'playing'" @click="redrawOrAgain">{{ redrawLabel }}</button>
          <button v-if="gameState.phase === 'ready'" class="primary" @click="startGame">开始对战</button>
          <button v-if="gameState.phase === 'playing'" :disabled="!gameState.undoStack.length" @click="undo">撤销一步</button>
          <button v-if="gameState.phase === 'playing'" @click="onFinish">结算</button>
          <button @click="exitRoom">退出房间</button>
        </template>
      </div>
    </header>

    <!-- ========== 房间大厅 ========== -->
    <div v-if="roomState === 'lobby'" class="lobby">
      <div class="card">
        <div class="pad">
          <p class="sec-title">联机对战</p>
          <div v-if="lobbyStatusText" class="lobby-status" :class="fbStatus">{{ lobbyStatusText }}</div>
          <div v-if="lobbyMsg" class="msg" :class="lobbyMsg.kind">{{ lobbyMsg.text }}</div>
          <button class="primary big" :disabled="roomBusy || !uid" @click="createRoom">创建房间</button>
          <div class="row joinrow">
            <input type="text" v-model="joinCode" placeholder="输入 6 位房间码" maxlength="6" @keyup.enter="joinRoom" />
            <button :disabled="roomBusy || !uid" @click="joinRoom">加入房间</button>
          </div>
          <div v-if="recentRooms.length" class="recent">
            <p class="recent-title">最近加入的房间</p>
            <div v-for="r in recentRooms" :key="r.code" class="recent-row">
              <span class="rcode">{{ r.code }}</span>
              <span class="rmeta">{{ r.host ? '我是房主' : '青营席位' }} · {{ relTime(r.at) }}</span>
              <button :disabled="roomBusy || !uid" title="房主重连或以青营加入；房间已被解散时会有提示" @click="rejoin(r)">进入</button>
            </div>
          </div>
          <p v-if="uid" class="uidline">设备 ID：{{ uid }}</p>
        </div>
      </div>
    </div>

    <!-- ========== 游戏主界面 ========== -->
    <div v-else class="layout">
      <!-- 左：棋盘 -->
      <div class="side">
        <div class="card">
          <div class="pad turnbar">
            <div class="roundinfo">
              第 <b>{{ currentRound }}</b> 轮 · <span>{{ phaseText }}</span>
            </div>
            <div class="teams">
              <div class="team tA" :class="{ active: gameState.phase === 'playing' && currentTeam === 'A', mine: myTeam === 'A', selectable: canSwitchSide }"
                   :title="canSwitchSide ? '点击切换到赤营席位' : (myTeam === 'A' ? '你所在的阵营' : '')"
                   @click="canSwitchSide && pickTeam('A')">
                <span class="swatch"></span>{{ teamNames.A }} <span class="num">{{ score.a }}</span>
                <button v-if="myTeam === 'B' && !redOnline && peerKickable" class="offbadge kickbadge" title="对方离线满 1 分钟，点击移出；对方会被带回大厅" @click.stop="kickPeer">踢出</button>
                <span v-else-if="myTeam === 'B' && !redOnline" class="offbadge" title="对方连接已断开">离线</span>
              </div>
              <div class="team tB" :class="{ active: gameState.phase === 'playing' && currentTeam === 'B', mine: myTeam === 'B', selectable: canSwitchSide }"
                   :title="canSwitchSide ? '点击切换到青营席位' : (myTeam === 'B' ? '你所在的阵营' : '')"
                   @click="canSwitchSide && pickTeam('B')">
                <span class="swatch"></span>{{ teamNames.B }} <span class="num">{{ score.b }}</span>
                <button v-if="myTeam === 'A' && !blueOnline && peerKickable" class="offbadge kickbadge" title="对方离线满 1 分钟，点击移出；对方会被带回大厅" @click.stop="kickPeer">踢出</button>
                <span v-else-if="myTeam === 'A' && !blueOnline" class="offbadge" title="对方连接已断开">离线</span>
              </div>
            </div>
          </div>
          <div class="pad" style="padding-top:0">
            <div class="scorebar">
              <span class="seg-a" :style="{ width: ((score.a / cellTotal) * 100).toFixed(2) + '%' }"></span>
              <span class="seg-b" :style="{ width: ((score.b / cellTotal) * 100).toFixed(2) + '%' }"></span>
            </div>
            <div class="scorelegend">
              <span><i class="k-a"></i>{{ teamNames.A }} <b>{{ score.a }}</b> 格</span>
              <span><i class="k-b"></i>{{ teamNames.B }} <b>{{ score.b }}</b> 格</span>
              <span><i class="k-n"></i>空白 <b>{{ score.n }}</b> 格</span>
              <span>已出手 <b>{{ flyTurns }}</b> 句</span>
            </div>
          </div>
          <div class="boardwrap">
            <div ref="boardEl" class="board" :style="boardStyle">
              <div v-for="(cell, idx) in gameState.board" :key="idx" :class="cellClass(idx)" @click="onCellClick(idx)">
                {{ cell.ch }}
              </div>
            </div>
          </div>

          <details>
            <summary>基础字库（{{ activePool.length }} 字 · 七库并集）</summary>
            <div class="detbody">
              <div class="poolpick" :title="gameState.phase === 'ready' ? '勾选参与抽样的字库集合（并集去重）；随房间同步双方' : '仅待开局时可调整'">
                <button v-for="opt in POOL_OPTIONS" :key="opt.key" :class="{ on: poolSel[opt.key] }"
                        :disabled="gameState.phase !== 'ready'" @click="togglePool(opt.key)">{{ opt.label }}</button>
                <button class="primary" :disabled="gameState.phase !== 'ready'"
                        @click="selectAllPools" title="七个字库全部参与（默认）">全选</button>
              </div>
              <div class="poolgrid">
                <span v-for="ch in activePool" :key="ch" :class="{ on: poolOn[ch] }">{{ ch }}</span>
              </div>
              <p class="poolnote">勾选的字库集合取并集去重后构成基础字库；对局中不可调整，开局前双方均可切换并自动重抽。</p>
            </div>
          </details>
          <details>
            <summary>{{ extraOnBoard.length ? `额外字（本局 ${extraOnBoard.length} 个）` : `额外字（本局未启用 · 共 ${extraAvail} 字可选）` }}</summary>
            <div class="detbody">
              <div class="poolgrid">
                <span v-for="ch in extraOnBoard" :key="ch" class="on" :title="`唐诗+宋词出现 ${EXTRA_FREQ[ch] || 0} 次`">{{ ch }}</span>
              </div>
              <p v-if="!extraOnBoard.length" class="poolnote">
                本局未启用额外字。在顶栏「额外字」填一个数字，就能让其中若干格改从<b>额外字池</b>里抽（按唐诗+宋词合计频次加权，自动避开已选基础字库）。
              </p>
            </div>
          </details>
          <details>
            <summary>规则与判定逻辑</summary>
            <div class="detbody">
              <ol class="rules">
                <li>棋盘：从<b>基础字库</b>（默认为「全唐诗 300 + 全宋词 300 + 宋词 300·不含唐诗字 + 苏轼词 1–200 / 201–400 / 401–600 + 辛弃疾词 1–200 / 201–400 / 401–600」九库并集去重，可在「基础字库」面板勾选参与集合）中<b>随机抽 N×N 个不重复的字</b>铺成方阵（N 可在顶栏设 5–20）。顶栏「<b>额外字</b>」可指定其中 K 格改从<b>额外字池</b>（自动避开已选基础字库）里抽 —— 抽取<b>按唐诗与宋词合计频次加权</b>，越常见的字越容易被抽中。</li>
                <li>涂色：某人飞出一句后，<b>诗句中所有出现在棋盘上的字</b>，对应格子全部涂成该方颜色。</li>
                <li>合法性：本句命中棋盘的字中，<b>至少要有 1 个格子当前未填色</b>；命中已涂色格可以抢夺。若命中格全都是已有颜色，本句无效。</li>
                <li>胜负：不限轮数，点「<b>结算</b>」随时结束本局，<b>己方颜色格子多者胜</b>；等同则平局。</li>
                <li>离线：对方<b>断开连接</b>（关闭页面、断网等）即在队名处显示「离线」，对战<b>不会暂停</b>，可直接继续提交；离线满 <b>1 分钟</b>，队名处出现「<b>踢出</b>」按钮，可手动将其移出房间（不自动踢出）。踢出或被新人<b>顶替</b>后席位空出；若被移出者是房主，房主随之转让。新成员加入时自动顶替离线者（双方离线时优先顶替离线更久者）；赤青两席<b>都有人且在线</b>时不允许第三人加入。双方都不在线满 24 小时的房间会被清理。</li>
              </ol>
            </div>
          </details>
        </div>
      </div>

      <!-- 右：主持操作台 -->
      <div class="side">
        <div class="card">
          <div class="pad">
            <p class="sec-title">当前出手方</p>
            <div class="teams" style="margin-bottom:12px">
              <div class="team tA" :class="{ active: gameState.phase === 'playing' && currentTeam === 'A' }">
                <span class="swatch"></span>{{ teamNames.A }}
              </div>
              <div class="team tB" :class="{ active: gameState.phase === 'playing' && currentTeam === 'B' }">
                <span class="swatch"></span>{{ teamNames.B }}
              </div>
            </div>
            <p class="sec-title">录入诗句</p>
            <textarea ref="poemEl" v-model="poemInput" :readonly="poemLocked"
                      :class="{ locked: poemLocked }"
                      :placeholder="poemPlaceholder"
                      @input="onPoemInput" @mousedown="onPoemMousedown" @keydown="onPoemKeydown"></textarea>
            <div class="row" style="margin-top:12px">
              <button class="primary submit" :class="currentTeam === 'A' ? 'team-a' : 'team-b'"
                      :disabled="gameState.phase !== 'playing' || !myTurn" @click="submitLine">
                {{ myTurn ? '提交飞花（回车）' : '等待对方出牌...' }}
              </button>
              <button :disabled="gameState.phase !== 'playing' || !myTurn" @click="passTurn">放弃本回合</button>
            </div>
            <div class="row" style="margin-top:10px">
              <button @click="onExportPng" title="生成当前局面战报图（含棋盘与飞花记录）并下载 PNG 文件，与旧版「导出战报」一致">导出战报</button>
              <button @click="onExportGif" title="生成逐手回放 GIF（从空盘到当前局面）并下载，记录越多耗时越久">导出 GIF</button>
            </div>
            <div class="row" style="margin-top:10px" v-if="myTeam">
              <input type="text" v-model="teamNameInput" maxlength="12" style="flex:1;min-width:0"
                     :placeholder="myTeam ? '当前：' + teamNames[myTeam] : ''" @keyup.enter="saveTeamName" />
              <button @click="saveTeamName" title="自定义本方阵营名（最多 12 字），双方界面与战报图统一显示">改阵营名</button>
            </div>
            <label class="chk" style="margin-top:10px;display:flex">
              <input type="checkbox" v-model="allowDup" /> 允许重复句（默认拦截已出现过的句子）
            </label>
            <label class="chk" style="margin-top:8px;display:flex"
                   title="记录里如何显示诗句：默认把标点等非文字符号折成一个空格；勾选后原样保留你输入的标点">
              <input type="checkbox" v-model="keepPunct" /> 保留输入标点（默认把标点折成空格）
            </label>
            <div v-if="msg" class="msg" :class="msg.kind">{{ msg.text }}</div>
          </div>
        </div>

        <div class="card">
          <div class="pad" style="padding-bottom:4px">
            <p class="sec-title" style="margin-bottom:2px">飞花记录</p>
          </div>
          <div class="pad" style="padding-top:6px">
            <ul class="loglist">
              <li v-for="e in flyLogs" :key="e.round + '-' + e.team" :class="e.team === 'A' ? 'tA' : 'tB'">
                <span class="badge" :class="e.team === 'A' ? 'bA' : 'bB'" :title="teamNames[e.team]">{{ TEAM_MARK[e.team] }}</span>
                <div class="body">
                  <template v-if="e.type === 'pass'">
                    <div class="line" style="color:#5B6B84">—— 放弃本回合 ——</div>
                    <div class="meta">第 {{ e.round }} 轮 · 未涂色</div>
                  </template>
                  <template v-else>
                    <div class="line">
                      <template v-for="(seg, si) in poemSegs(e)" :key="si">
                        <u v-if="seg.kind" class="mk" :class="'mk-' + seg.kind">{{ seg.text }}</u>
                        <template v-else>{{ seg.text }}</template>
                      </template>
                    </div>
                    <div class="meta">
                      第 {{ e.round }} 轮 · 命中 <b>{{ e.hits }}</b> 格 ｜
                      <em :class="e.team === 'A' ? 'em-a' : 'em-b'">新占 {{ e.blank }}</em> ·
                      <em :class="e.team === 'A' ? 'em-a' : 'em-b'">抢夺 {{ e.capture }}</em> ·
                      己方 {{ e.hold }}
                    </div>
                  </template>
                </div>
              </li>
            </ul>
            <div v-if="!flyLogs.length" class="empty">尚未开始，记录会显示在这里。</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 结算弹窗 ========== -->
    <div v-if="showResult" class="overlay" @click.self="showResult = false">
      <div class="modal">
        <div class="winner">{{ resultInfo.label }}</div>
        <div class="winname" :style="{ color: resultInfo.color }">{{ resultInfo.win }} ｜ {{ resultInfo.name }}</div>
        <div class="final">
          <div class="fbox"><div class="fv" style="color:var(--ink-a)">{{ score.a }}</div><div class="fk">{{ teamNames.A }}格子</div></div>
          <div class="fbox"><div class="fv" style="color:var(--ink-b)">{{ score.b }}</div><div class="fk">{{ teamNames.B }}格子</div></div>
          <div class="fbox"><div class="fv" style="color:#5B6B84">{{ score.n }}</div><div class="fk">未被涂色</div></div>
        </div>
        <div class="statgrid">
          <div>{{ teamNames.A }}出手 <b>{{ flyCount('A') }} 句</b></div>
          <div>{{ teamNames.B }}出手 <b>{{ flyCount('B') }} 句</b></div>
          <div>双方抢夺合计 <b>{{ capTotal() }} 格</b></div>
        </div>
        <h3>飞句全记录</h3>
        <div class="poembox">
          <p v-if="!resultFlies.length" style="color:#5B6B84">本局没有有效飞句。</p>
          <p v-for="(e, i) in resultFlies" :key="i" :class="e.team === 'A' ? 'tA' : 'tB'">
            <span class="tagt" :style="{ color: e.team === 'A' ? 'var(--ink-a)' : 'var(--ink-b)' }">{{ teamNames[e.team] }}</span><template v-for="(seg, si) in poemSegs(e)" :key="si"><u v-if="seg.kind" class="mk" :class="'mk-' + seg.kind">{{ seg.text }}</u><template v-else>{{ seg.text }}</template></template><span style="color:#5B6B84">　（命中{{ e.hits }}／新占{{ e.blank }}／抢{{ e.capture }}）</span>
          </p>
        </div>
        <div class="row" style="margin-top:16px;justify-content:flex-end">
          <button @click="showResult = false">返回棋盘</button>
          <button class="primary" title="开新局；房间保留、双方无需重新加入，直接重开一盘（双方都可操作）" @click="again">再来一局</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap{max-width:1240px;margin:0 auto;padding:20px 20px 56px;}

/* ---------- header ---------- */
header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:nowrap;margin-bottom:16px;}
h1{font-size:22px;margin:0;letter-spacing:.5px;white-space:nowrap;flex:0 0 auto;}
h1 .tag{font-size:12px;font-weight:600;vertical-align:middle;margin-left:8px;background:#E8EEF8;color:#2C4A78;border-radius:999px;padding:3px 9px;letter-spacing:0;}
.head-tools{display:flex;gap:4px;align-items:center;flex-wrap:nowrap;justify-content:flex-end;min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:thin;padding-bottom:4px;}
.head-tools>*{flex:0 0 auto;}
.head-tools::-webkit-scrollbar{height:6px;}
.head-tools::-webkit-scrollbar-thumb{background:#C9D4E4;border-radius:3px;}
.head-tools::-webkit-scrollbar-track{background:transparent;}
header.top button{padding:7px 9px;white-space:nowrap;}
@media (max-width:1159px){ header.top{flex-wrap:wrap;} .head-tools{justify-content:flex-start;width:100%;} }

/* 连接状态 chip */
.conn{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:4px 10px;border:1px solid var(--line);background:#fff;color:var(--muted);}
.conn i{width:8px;height:8px;border-radius:50%;background:#9AA7BA;}
.conn.ok{color:#1B6B36;background:#E9F6ED;border-color:#9BD3AC;}
.conn.ok i{background:#2E9E5B;}
.conn.error{color:var(--danger);background:#FDEDEB;border-color:#F6CFCA;}
.conn.error i{background:var(--danger);}
.conn.lost{color:#8A5A0B;background:#FFF6E6;border-color:#F4DEB2;}
.conn.lost i{background:#C98A1B;}
.conn.room{background:#E8EEF8;color:#2C4A78;font-weight:700;border-color:#C7D7EE;}

/* ---------- generic controls ---------- */
button{font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--text);padding:8px 14px;transition:.15s;line-height:1.2;}
button:hover:not(:disabled){border-color:#B9C6DA;background:#FAFBFE;}
button:disabled{opacity:.45;cursor:not-allowed;}
button.primary{background:var(--ink-b);border-color:var(--ink-b);color:#fff;}
button.primary:hover:not(:disabled){background:#175E9E;}
button.danger{background:var(--ink-a);border-color:var(--ink-a);color:#fff;}
button.danger:hover:not(:disabled){background:#A72C22;}
button.big{width:100%;padding:12px;font-size:15px;}
/* 提交按钮跟随当前回合方墨色 */
.submit.team-a{background:var(--ink-a);border-color:var(--ink-a);color:#fff;}
.submit.team-a:hover:not(:disabled){background:#A72C22;}
.submit.team-b{background:var(--ink-b);border-color:var(--ink-b);color:#fff;}
.submit.team-b:hover:not(:disabled){background:#175E9E;}
select,input[type=text],input[type=number]{font-family:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--text);}
.sizefield{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);}
.sizefield input{width:50px;padding:7px 4px;text-align:center;font-variant-numeric:tabular-nums;}
.sizefield b{color:var(--text);font-variant-numeric:tabular-nums;}
.poolpick{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;}
.poolpick button{font-size:12px;padding:6px 10px;border-radius:9px;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;}
.poolpick button.on{background:var(--ink-a);border-color:var(--ink-a);color:#fff;font-weight:600;}
.poolpick button.primary.on{background:var(--ink-b);border-color:var(--ink-b);}
.poolpick button:disabled{opacity:.45;cursor:not-allowed;}
input[type=number]:disabled,select:disabled{background:#F2F5FA;border-color:#E1E7F0;color:#7A8698;cursor:not-allowed;-webkit-text-fill-color:#7A8698;opacity:1;}
.sizefield.off,.sizefield.off b,.chk.off{color:#7A8698;}
.chk input:disabled{cursor:not-allowed;}
.chk{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;user-select:none;}
.chk input{accent-color:var(--ink-b);width:14px;height:14px;}

/* ---------- 大厅 ---------- */
.lobby{max-width:430px;margin:40px auto 0;}
.lobby-status{border-radius:10px;padding:12px 14px;margin:4px 0 16px;font-size:14px;border:1px solid var(--line);background:var(--blank);color:var(--muted);}
.lobby-status.ok{background:#E9F6ED;border-color:#9BD3AC;color:#1B6B36;}
.lobby-status.error{background:#FDEDEB;border-color:#F6CFCA;color:var(--danger);}
.lobby-status.lost{background:#FFF6E6;border-color:#F4DEB2;color:#8A5A0B;}
.joinrow{margin-top:10px;}
.joinrow input{flex:1 1 auto;}
.uidline{margin:14px 0 0;font-size:12px;font-family:ui-monospace,Consolas,monospace;color:var(--muted);word-break:break-all;}

/* ---------- 大厅：最近加入的房间 ---------- */
.recent{margin-top:16px;border-top:1px dashed var(--line);padding-top:12px;}
.recent-title{margin:0 0 8px;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.5px;}
.recent-row{display:flex;align-items:center;gap:10px;padding:6px 0;}
.recent-row .rcode{font-family:ui-monospace,Consolas,monospace;font-weight:700;font-size:15px;letter-spacing:2px;}
.recent-row .rmeta{flex:1;min-width:0;font-size:12px;color:var(--muted);}
.recent-row button{padding:5px 12px;}

/* ---------- 对局在线状态徽标 ---------- */
.offbadge{display:inline-block;margin-left:6px;font-size:11px;font-weight:600;color:#B4433A;background:#FBEDEC;border:1px solid #F0C7C4;border-radius:999px;padding:1px 8px;vertical-align:1px;}
button.offbadge{cursor:pointer;font-family:inherit;line-height:1.5;}
button.offbadge:hover{background:#F6D9D6;}

/* ---------- layout ---------- */
.layout{display:grid;grid-template-columns:minmax(0,1fr) 396px;gap:18px;align-items:start;}
@media (max-width:1080px){.layout{grid-template-columns:1fr;}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);}
.card .pad{padding:14px 16px;}

/* ---------- turn / score ---------- */
.turnbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.roundinfo{font-size:13px;color:var(--muted);}
.roundinfo b{color:var(--text);font-size:15px;}
.teams{display:flex;gap:8px;}
.team{display:flex;align-items:center;gap:8px;padding:7px 13px;border-radius:999px;border:2px solid var(--line);background:#fff;font-size:13px;font-weight:700;color:var(--muted);transition:.18s;}
.team .swatch{width:12px;height:12px;border-radius:4px;}
.team.tA .swatch{background:var(--ink-a);}
.team.tB .swatch{background:var(--ink-b);}
.team.tA.active{border-color:var(--ink-a);color:var(--ink-a);background:#FCF0EE;box-shadow:0 0 0 4px rgba(194,53,42,.08);}
.team.tB.active{border-color:var(--ink-b);color:var(--ink-b);background:#EDF4FB;box-shadow:0 0 0 4px rgba(30,111,184,.08);}
/* 我所在阵营：全底色选中；房间只有自己时（selectable）可点击切换阵营 */
.team.selectable{cursor:pointer;}
.team.mine .swatch{box-shadow:0 0 0 2px rgba(255,255,255,.85);}
.team.tA.mine{background:var(--ink-a);border-color:var(--ink-a);color:#fff;box-shadow:0 0 0 4px rgba(194,53,42,.10);}
.team.tB.mine{background:var(--ink-b);border-color:var(--ink-b);color:#fff;box-shadow:0 0 0 4px rgba(30,111,184,.10);}
.team .num{font-variant-numeric:tabular-nums;font-size:15px;}
.scorebar{height:12px;border-radius:999px;overflow:hidden;display:flex;background:var(--blank);margin-top:12px;border:1px solid var(--line);}
.scorebar span{display:block;height:100%;transition:width .35s cubic-bezier(.4,0,.2,1);}
.seg-a{background:var(--ink-a);}
.seg-b{background:var(--ink-b);}
.scorelegend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px;}
.scorelegend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;}
.k-a{background:var(--ink-a);}.k-b{background:var(--ink-b);}.k-n{background:var(--blank);border:1px solid var(--line);}
.scorelegend b{color:var(--text);font-variant-numeric:tabular-nums;}

/* ---------- board ---------- */
.boardwrap{padding:14px;}
/* 无缝网格：gap=0，靠每格 1px 边框画格线；同色相邻格的边框设为透明，墨块连成整片 */
.board{display:grid;gap:0;background:#fff;padding:0;border:1px solid var(--grid);border-radius:12px;overflow:hidden;}
.cell{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;background:var(--blank);color:var(--blank-text);border-right:1px solid var(--grid);border-bottom:1px solid var(--grid);font-size:var(--cell-fs,27px);font-weight:600;line-height:1;position:relative;user-select:none;border-radius:0;transition:background .18s,color .18s,box-shadow .18s;}
.cell.nb-r{border-right-color:transparent;}
.cell.nb-b{border-bottom-color:transparent;}
.cell.own-A{background:var(--ink-a);color:#fff;}
.cell.own-B{background:var(--ink-b);color:#fff;}
/* 出手前预览：命中且未填色 → 半透明填充+实线内框；敌格 → 半透明墨色+虚线框；己方格 → 白内框 */
.cell.pv-A.pv-new{background:var(--pv-a);color:var(--blank-text);box-shadow:inset 0 0 0 3px var(--ink-a);}
.cell.pv-B.pv-new{background:var(--pv-b);color:var(--blank-text);box-shadow:inset 0 0 0 3px var(--ink-b);}
.cell.pv-A.pv-cap{background:var(--pv-ab);color:#fff;outline:2px dashed var(--ink-a);outline-offset:-3px;}
.cell.pv-B.pv-cap{background:var(--pv-ba);color:#fff;outline:2px dashed var(--ink-b);outline-offset:-3px;}
.cell.pv-A.pv-hold,.cell.pv-B.pv-hold{box-shadow:inset 0 0 0 3px rgba(255,255,255,.62);}
/* 本手刚变化的格子：白色内描边 */
.cell.flash::after{content:"";position:absolute;inset:0;box-sizing:border-box;border:3px solid rgba(255,255,255,.95);pointer-events:none;animation:flashRing 1.05s ease-out forwards;}
@keyframes flashRing{0%{opacity:0;}10%{opacity:1;}72%{opacity:1;}100%{opacity:0;}}
.cell.fixable{cursor:pointer;}
.cell.fixable:hover{filter:brightness(.9);}

/* ---------- side ---------- */
.side{display:flex;flex-direction:column;gap:14px;}
.sec-title{font-size:12px;font-weight:700;letter-spacing:1.2px;color:var(--muted);text-transform:uppercase;margin:0 0 10px;}
textarea{width:100%;min-height:64px;resize:vertical;font-family:inherit;font-size:17px;letter-spacing:1px;line-height:1.5;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#FBFCFE;color:var(--text);}
textarea:focus{outline:none;border-color:var(--ink-b);box-shadow:0 0 0 3px rgba(30,111,184,.12);background:#fff;}
textarea.locked{background:#F1F4F9;border-color:#E4EAF3;cursor:pointer;}
textarea.locked:focus{border-color:var(--line);box-shadow:none;background:#F1F4F9;}
textarea.locked::placeholder{color:#6B7889;}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.msg{font-size:12.5px;margin-top:9px;padding:8px 10px;border-radius:9px;line-height:1.5;}
.msg.ok{background:#EAF6EF;color:#1E6B45;border:1px solid #C6E7D4;}
.msg.warn{background:#FFF6E6;color:#8A5A0B;border:1px solid #F4DEB2;}
.msg.err{background:#FDEDEB;color:#98271D;border:1px solid #F6CFCA;}

/* timer */
.timer{display:flex;align-items:center;gap:10px;margin-top:10px;}
.clock{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.5px;min-width:64px;text-align:center;padding:2px 10px;border-radius:9px;background:#F1F4F9;color:var(--text);}
.clock.run{background:#EDF4FB;color:var(--ink-b);}
.clock.low{background:#FDEDEB;color:var(--ink-a);}

/* log */
.loglist{list-style:none;margin:0;padding:0;max-height:340px;overflow:auto;}
.loglist li{display:flex;gap:9px;padding:8px 4px;border-bottom:1px dashed #EAEFF7;font-size:13px;align-items:flex-start;}
.loglist li:last-child{border-bottom:0;}
.loglist .badge{flex:0 0 auto;width:22px;height:22px;border-radius:7px;color:#fff;font-size:12.5px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px;}
.bA{background:var(--ink-a);}.bB{background:var(--ink-b);}
.loglist .body{flex:1 1 auto;min-width:0;}
.loglist .line{font-size:14.5px;letter-spacing:.5px;word-break:break-all;}
/* 诗句里命中的字：新占＝墨黑实线 / 抢夺＝己方笔色实线 / 己方＝中性灰点状线 */
.mk{text-decoration-line:underline;text-decoration-thickness:2px;text-underline-offset:4px;text-decoration-skip-ink:none;-webkit-text-decoration-skip-ink:none;}
.mk-new{text-decoration-color:var(--text);}
.mk-cap{text-decoration-color:var(--ink-a);}
.tB .mk-cap{text-decoration-color:var(--ink-b);}
.mk-hold{text-decoration-style:dotted;text-decoration-color:var(--hit-hold);}
.loglist .meta{font-size:11.5px;color:var(--muted);margin-top:2px;}
.loglist .meta em{font-style:normal;font-weight:700;}
.em-a{color:var(--ink-a);}.em-b{color:var(--ink-b);}
.empty{font-size:12.5px;color:var(--muted);text-align:center;padding:18px 0;}

details{border-top:1px solid var(--line);}
details summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--muted);padding:10px 16px;list-style:none;}
details summary::-webkit-details-marker{display:none;}
details summary:before{content:"▸ ";color:var(--muted);}
details[open] summary:before{content:"▾ ";}
details .detbody{padding:0 16px 14px;font-size:12.5px;color:var(--muted);}
.poolnote{margin:8px 0 0;font-size:12px;line-height:1.7;color:var(--muted);}
.poolgrid{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.poolgrid span{width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:#F4F7FB;font-size:13px;color:var(--muted);}
.poolgrid span.on{background:#E4EDF9;color:#1E4E86;font-weight:700;box-shadow:0 0 0 1px #B9D2EC inset;}
ol.rules{margin:6px 0 0 18px;padding:0;}
ol.rules li{margin-bottom:5px;line-height:1.6;}

/* ---------- result ---------- */
.overlay{position:fixed;inset:0;background:rgba(23,35,54,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50;}
.modal{background:#fff;border-radius:18px;max-width:720px;width:100%;max-height:88vh;overflow:auto;padding:26px 26px 20px;box-shadow:0 24px 60px rgba(12,24,44,.28);}
.winner{font-size:13px;font-weight:700;letter-spacing:2px;color:var(--muted);}
.winname{font-size:30px;font-weight:800;margin:4px 0 16px;letter-spacing:2px;}
.final{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:18px;}
.final .fbox{border:1px solid var(--line);border-radius:12px;padding:12px;text-align:center;background:#FBFCFE;}
.fbox .fv{font-size:28px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.15;}
.fbox .fk{font-size:12px;color:var(--muted);margin-top:2px;}
.statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12.5px;margin-bottom:16px;}
.statgrid div{background:#F5F8FC;border-radius:9px;padding:8px 10px;}
.statgrid b{display:block;font-size:15px;font-variant-numeric:tabular-nums;}
.modal h3{font-size:13px;letter-spacing:1px;color:var(--muted);margin:0 0 8px;text-transform:uppercase;}
.poembox{max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#FBFCFE;font-size:13px;}
.poembox p{margin:0 0 7px;line-height:1.6;}
.poembox .tagt{font-weight:700;margin-right:6px;}
</style>
