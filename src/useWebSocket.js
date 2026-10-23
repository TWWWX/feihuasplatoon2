/* WebSocket 实时层（方案 B 纯转发，配合 worker/index.js 的 GameRoom DO，100% 事件驱动）
   - 前端始终连 same-origin `/ws?roomId=xxx`：
       dev：vite 代理 → ws://127.0.0.1:8787（npx wrangler dev）
       生产：Pages/网关的同域 /ws 反代（或改 wsUrl 直连线上 wss 地址）
   - 控制协议（与 worker 约定，均不转发、不落库）：
       上行：{"__hello":clientId} / {type:'kick',targetClientId}
       下行：{type:'peers',list} 成员快照（连接建立后唯一一次） /
             {type:'peer_online',clientId} / {type:'peer_offline',clientId,code} / gameState JSON
   - 无轮询：在线状态由 DO 的 close/hello 事件推送；断网假死由 visibilitychange / online 事件兜底重连
   - 断线重连：指数退避（1s→15s）；重连成功后 DO 回放最近保存的 state 并重发 peers 快照，
     前端 applyRoomSnapshot / onPeers 直接覆盖，无需增量协议。 */
import { ref } from 'vue'

export const wsStatus = ref('idle') // idle(未发起连接) | connecting | ok | lost | error
export const wsError = ref('')

let ws = null
let roomId = ''
let handlers = {}
let retryCount = 0
let retryTimer = null
let manualClose = false
let fallbackBound = false /* 页面可见性/网络恢复兜底只绑定一次 */

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

/* 兜底重连（事件驱动，无轮询）：页面切回前台或网络恢复时，
   若连接不在 OPEN 态则立即重连（清掉退避定时器先连） */
function reconnectNow() {
  if (manualClose || open()) return
  if (retryTimer) clearTimeout(retryTimer)
  doConnect()
}
function bindFallback() {
  if (fallbackBound) return
  fallbackBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectNow()
  })
  window.addEventListener('online', reconnectNow)
}

/* connectWs(code, { clientId, onOpen, onMessage, onPeers, onPeerOnline, onPeerOffline, onRejected }) */
export function connectWs(code, h) {
  roomId = code
  handlers = h || {}
  manualClose = false
  retryCount = 0
  if (retryTimer) clearTimeout(retryTimer)
  bindFallback()
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
    /* __hello：DO 登记身份 → 回发 peers 成员快照 + 向老成员广播 peer_online */
    sendRaw(JSON.stringify({ __hello: handlers.clientId || '' }))
    if (handlers.onOpen) handlers.onOpen()
  }
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string' || !ev.data) return
    if (ev.data[0] !== '{' && ev.data[0] !== '[') return
    let data = null
    try {
      data = JSON.parse(ev.data)
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return
    if (data.type === 'peers') {
      if (handlers.onPeers) handlers.onPeers(data.list || [])
      return
    }
    if (data.type === 'peer_online') {
      if (handlers.onPeerOnline) handlers.onPeerOnline(data.clientId)
      return
    }
    if (data.type === 'peer_offline') {
      if (handlers.onPeerOffline) handlers.onPeerOffline(data.clientId, data.code)
      return
    }
    /* 其余一律视为 gameState 快照 */
    if (handlers.onMessage) handlers.onMessage(data)
  }
  ws.onclose = (ev) => {
    /* 4001：被踢出 / 连接数超限；4000：席位被顶替 → 交由上层决定，不自动重连 */
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
  if (ws) {
    try {
      ws.close()
    } catch {}
    ws = null
  }
  wsStatus.value = 'idle'
}
