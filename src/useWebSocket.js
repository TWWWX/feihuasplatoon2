/* WebSocket 实时层（方案 B 纯转发，配合 worker/index.js 的 GameRoom DO）
   - 前端始终连 same-origin `/ws?roomId=xxx`：
       dev：vite 代理 → ws://127.0.0.1:8787（npx wrangler dev）
       生产：Pages/网关的同域 /ws 反代（或改 wsUrl 直连线上 wss 地址）
   - 控制协议（与 worker 约定，均不转发、不落库）：
       上行：__ping(60s 保活) / __who(15s 在线查询) / {"__hello":clientId} / {type:'kick',targetClientId}
       下行：__pong / {__who:[{clientId,lastSeen,self}]} / {__peer_closed:{code}} / gameState JSON
   - 断线重连：指数退避（1s→15s）；DO 收到 close 后给对端广播 __peer_closed。
     重连成功后 DO 会回放最近保存的 state，前端 applyRoomSnapshot 直接覆盖，无需增量协议。 */
import { ref } from 'vue'

export const wsStatus = ref('connecting') // connecting | ok | lost | error
export const wsError = ref('')

let ws = null
let roomId = ''
let handlers = {}
let retryCount = 0
let retryTimer = null
let pingTimer = null
let whoTimer = null
let manualClose = false

const PING_MS = 60000 /* 移动端假死保活：DO 据此刷新 lastSeen（顶替/踢出/在线判定的时间基准） */
const WHO_MS = 15000

function wsUrl(code) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws?roomId=${encodeURIComponent(code)}`
}
function open() {
  return !!ws && ws.readyState === WebSocket.OPEN
}

export function sendRaw(str) {
  if (open()) ws.send(str)
}
export function sendKick(targetClientId) {
  sendRaw(JSON.stringify({ type: 'kick', targetClientId }))
}

function startTimers() {
  stopTimers()
  pingTimer = setInterval(() => sendRaw('__ping'), PING_MS)
  whoTimer = setInterval(() => sendRaw('__who'), WHO_MS)
}
function stopTimers() {
  if (pingTimer) clearInterval(pingTimer)
  if (whoTimer) clearInterval(whoTimer)
  pingTimer = whoTimer = null
}

/* connectWs(code, { clientId, onOpen, onMessage, onWho, onPeerClosed, onRejected }) */
export function connectWs(code, h) {
  roomId = code
  handlers = h || {}
  manualClose = false
  retryCount = 0
  if (retryTimer) clearTimeout(retryTimer)
  doConnect()
}
function doConnect() {
  wsStatus.value = 'connecting'
  try {
    ws = new WebSocket(wsUrl(roomId))
  } catch (e) {
    scheduleRetry(String(e && e.message))
    return
  }
  ws.onopen = () => {
    retryCount = 0
    wsError.value = ''
    wsStatus.value = 'ok'
    sendRaw(JSON.stringify({ __hello: handlers.clientId || '' }))
    startTimers()
    sendRaw('__who')
    if (handlers.onOpen) handlers.onOpen()
  }
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string' || !ev.data) return
    if (ev.data === '__pong') return
    if (ev.data[0] !== '{' && ev.data[0] !== '[') return
    let data = null
    try {
      data = JSON.parse(ev.data)
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return
    if (data.__who) {
      if (handlers.onWho) handlers.onWho(data.__who, data.at || Date.now())
      return
    }
    if (data.__peer_closed) {
      if (handlers.onPeerClosed) handlers.onPeerClosed(data.__peer_closed)
      return
    }
    /* 其余一律视为 gameState 快照 */
    if (handlers.onMessage) handlers.onMessage(data)
  }
  ws.onclose = (ev) => {
    stopTimers()
    if (manualClose) return
    /* 4001：被踢出 / 房间已满；4000：席位被顶替 → 交由上层决定，不自动重连 */
    if (ev.code === 4001 || ev.code === 4000) {
      wsStatus.value = 'error'
      wsError.value = ev.reason || '连接被服务器关闭'
      if (handlers.onRejected) handlers.onRejected(ev.code, ev.reason)
      return
    }
    wsStatus.value = 'lost'
    scheduleRetry('连接断开')
  }
  ws.onerror = () => {
    if (!manualClose) wsError.value = '网络错误'
  }
}
function scheduleRetry(reason) {
  if (manualClose) return
  const delay = Math.min(15000, 1000 * 2 ** retryCount)
  retryCount++
  wsError.value = reason
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => doConnect(), delay)
}

export function closeWs() {
  manualClose = true
  if (retryTimer) clearTimeout(retryTimer)
  stopTimers()
  if (ws) {
    try {
      ws.close()
    } catch {}
    ws = null
  }
  wsStatus.value = 'connecting'
}
