/* 飞花实时转发 Worker：GameRoom Durable Object（方案 B 纯转发器）
   - /ws?roomId=xxx → env.ROOMS.idFromName(roomId) 路由到对应 GameRoom
   - 游戏消息（前端 gameState JSON 字符串）原样广播给房间内其他连接，异步持久化到 DO storage + D1
   - 控制消息（不广播、不落库，绝不阻塞游戏消息转发）：
       __ping                              → 回 __pong（移动端假死保活 + lastSeen 刷新）
       {"__hello": "<clientId>"}           → 登记身份到连接附件，回 __pong
       __who                               → 回 {__who:[{clientId,lastSeen,self}]}（仅发给请求者）
       {"type":"kick","targetClientId"}    → 在连接池找到目标 ws 立即 close(4001,'被踢出房间')；找不到（已离线）则忽略
   - webSocketClose：给剩余连接广播 {__peer_closed:{code}}，对端 UI 立即显示离线/被踢
   - 满员策略：已有 2 个连接时，第三人可顶替「静默超 10 分钟」的连接，否则 close(4001,'房间已满')
   持久化说明：storage.put 为权威副本（hibernate 唤醒用）；D1 rooms 表为备份/审计，恢复时仅作回退。 */
const STALE_MS = 10 * 60 * 1000 /* 静默 10 分钟的连接可被第三人顶替 */

export class GameRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.roomId = null
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 })
    this.roomId = (url.searchParams.get('roomId') || '').trim()
    if (!this.roomId) return new Response('bad roomId', { status: 400 })

    const pair = new WebSocketPair()
    await this.handleSession(pair[1])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async handleSession(server) {
    const sockets = this.state.getWebSockets()
    const now = Date.now()

    /* 满员判定：2 个连接时找「静默超 10 分钟」的可顶替对象 */
    if (sockets.length >= 2) {
      let stale = null
      for (const s of sockets) {
        const meta = readMeta(s)
        if (!meta || now - meta.lastSeen > STALE_MS) {
          stale = s
          break
        }
      }
      if (!stale) {
        server.accept()
        server.close(4001, '房间已满（两名玩家都在线）')
        return
      }
      stale.close(4000, '席位被新连接顶替')
    }

    server.accept()
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ joinedAt: now, lastSeen: now, clientId: null })

    /* roomId 兜底：hibernate 唤醒后构造器重跑、this.roomId 为空，从 storage 恢复 */
    if (this.roomId) await this.state.storage.put('room_id', this.roomId)

    /* 状态恢复：最近一次保存的 gameState 直接发给新连接的玩家 */
    let saved = await this.state.storage.get('room_state')
    if (!saved) {
      try {
        const row = await this.env.DB.prepare('SELECT state FROM rooms WHERE room_id = ?1')
          .bind(this.roomId)
          .first()
        if (row && row.state) saved = row.state
      } catch (e) {
        console.error('d1 restore failed', e)
      }
    }
    if (saved) server.send(saved)
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || !message) return
    touchMeta(ws)

    /* ---- 控制消息：同步处理，无持久化，不阻塞游戏消息 ---- */
    if (message === '__ping') {
      ws.send('__pong')
      return
    }
    if (message === '__who') {
      ws.send(JSON.stringify({ __who: this.listPeers(ws), at: Date.now() }))
      return
    }
    if (message[0] === '{') {
      let ctrl = null
      try {
        ctrl = JSON.parse(message)
      } catch {
        ctrl = null
      }
      if (ctrl && ctrl.__hello) {
        const meta = readMeta(ws) || {}
        meta.clientId = String(ctrl.__hello)
        ws.serializeAttachment(meta)
        ws.send('__pong')
        return
      }
      if (ctrl && ctrl.type === 'kick') {
        /* 瞬时踢人：连接池里找到目标 ws 立即关闭；目标离线（无 ws）则忽略，
           席位清理由前端走 state（players 移除该 clientId）完成 */
        const target = this.state
          .getWebSockets()
          .find((s) => (readMeta(s) || {}).clientId === ctrl.targetClientId)
        if (target) target.close(4001, '被踢出房间')
        return
      }
    }

    /* ---- 游戏消息：先广播（低延迟），持久化不阻塞下行 ---- */
    for (const other of this.state.getWebSockets()) {
      if (other !== ws) {
        try {
          other.send(message)
        } catch {}
      }
    }
    const p = this.persist(message)
    if (this.state.waitUntil) this.state.waitUntil(p)
    else p.catch(() => {})
  }

  async webSocketClose(ws, code, reason, wasClean) {
    /* sessions 广播：让对端立刻知道有人掉线（区分被踢 4001 / 顶替 4000 / 普通断开） */
    const note = JSON.stringify({ __peer_closed: { code, at: Date.now() } })
    for (const other of this.state.getWebSockets()) {
      if (other !== ws) {
        try {
          other.send(note)
        } catch {}
      }
    }
  }

  async webSocketError(ws) {
    /* 忽略：close 事件会随后到来 */
  }

  listPeers(self) {
    return this.state.getWebSockets().map((s) => {
      const m = readMeta(s) || {}
      return { clientId: m.clientId || null, lastSeen: m.lastSeen || 0, self: s === self }
    })
  }

  async persist(message) {
    try {
      await this.state.storage.put('room_state', message)
    } catch (e) {
      console.error('storage put failed', e)
    }
    try {
      const rid = this.roomId || (await this.state.storage.get('room_id'))
      if (!rid) return
      await this.env.DB.prepare(
        `INSERT INTO rooms (room_id, state, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(room_id) DO UPDATE SET state = ?2, updated_at = ?3`
      )
        .bind(rid, message, Date.now())
        .run()
    } catch (e) {
      console.error('d1 save failed', e)
    }
  }
}

function readMeta(s) {
  try {
    return s.deserializeAttachment()
  } catch {
    return null
  }
}
function touchMeta(ws) {
  try {
    const m = readMeta(ws) || {}
    m.lastSeen = Date.now()
    ws.serializeAttachment(m)
  } catch {}
}

/* ---- 入口：按 roomId 路由到对应 GameRoom 实例 ---- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 })
    const roomId = (url.searchParams.get('roomId') || '').trim()
    if (!/^[A-Za-z0-9]{4,12}$/.test(roomId)) return new Response('bad roomId', { status: 400 })
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request)
  },
}
