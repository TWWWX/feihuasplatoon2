/* 飞花实时转发 Worker：GameRoom Durable Object（方案 B 纯转发器，100% 事件驱动）
   - /ws?roomId=xxx → env.ROOMS.idFromName(roomId) 路由到对应 GameRoom
   - 游戏消息（前端 gameState JSON 字符串）原样广播给房间内其他连接，异步持久化到 DO storage + D1
   - 控制消息（不广播、不落库，绝不阻塞游戏消息转发）：
       {"__hello": "<clientId>"}         → 登记身份到连接附件；给新连接发 {type:'peers'} 成员快照，
                                           并向老成员广播 {type:'peer_online', clientId}
       {"type":"kick","targetClientId"}  → 找到目标 ws 立即 close(4001,'被踢出房间')；找不到（已离线）则忽略
   - 在线/离线事件（替代旧 __ping/__who 轮询）：
       上线：__hello 登记 → 广播 peer_online
       离线：webSocketClose → 记录离线时间（offlineLog）→ 广播 {type:'peer_offline', clientId, code}
       初次同步：新连接在 __hello 时收到 peers 快照（在线者 + 离线者及其离线时间）
   - 满员策略：无硬性满员拒绝（连接数上限 3 防滥用），「房间满/顶替离线者」由前端业务层按
     peers 快照判定（ensureSeat），被顶替者由前端 sendKick 精确关闭（DO 不解析席位归属）
   - 房间回收：state 超 24 小时未更新（双方均离线超过 24h）→ 清空 storage + D1，房间视为不存在
   持久化说明：storage.put 为权威副本（hibernate 唤醒用）；D1 rooms 表为备份/审计，恢复时仅作回退。 */
const MAX_CONNECTIONS = 6 /* 防滥用上限（正常 2 名玩家 + 刷新/重连窗口的残留连接）；同 clientId 顶替在 __hello 时清理 */
const RECONNECT_CODE = 4002 /* 同设备重新连接：关闭旧连接用，不广播 peer_offline（人还在线） */
const ROOM_TTL = 24 * 60 * 60 * 1000 /* state 超过 24h 未更新 → 房间回收 */

export class GameRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.roomId = null
    this.offlineLog = new Map() /* clientId → offlineAt（内存缓存，storage 持久化；hibernate 唤醒后惰性恢复） */
    this.offlineLoaded = false
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
    const now = Date.now()

    /* 连接数硬上限：正常业务最多 2 个玩家连接，留 1 个余量给顶替场景 */
    if (this.state.getWebSockets().length >= MAX_CONNECTIONS) {
      server.accept()
      server.close(4001, '连接数已达上限')
      return
    }

    /* roomId 兜底 + offlineLog 恢复：hibernate 唤醒后构造器重跑、内存丢失 */
    if (this.roomId) await this.state.storage.put('room_id', this.roomId)
    await this.ensureOfflineLog()

    /* Hibernation 模式：只允许 state.acceptWebSocket()，不能再手动 accept()（二者互斥） */
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ joinedAt: now, clientId: null })

    /* 状态恢复：最近一次保存的 gameState 直接发给新连接的玩家；
       state 超 24h 未更新（双方均离线超 24h）→ 清掉旧局，房间视为不存在 */
    const savedAt = await this.state.storage.get('room_saved_at')
    let saved = null
    if (savedAt && now - savedAt > ROOM_TTL) {
      await this.state.storage.delete('room_state')
      await this.state.storage.delete('room_saved_at')
      try {
        await this.env.DB.prepare('DELETE FROM rooms WHERE room_id = ?1').bind(this.roomId).run()
      } catch (e) {
        console.error('d1 delete failed', e)
      }
    } else {
      saved = await this.state.storage.get('room_state')
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
    }
    if (saved) server.send(saved)
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || !message) return

    let ctrl = null /* 控制与游戏消息共用：声明必须在块外（此前在 if 块内，游戏消息分支引用即抛 ReferenceError，广播与持久化全失效） */
    /* ---- 控制消息：同步处理，无持久化，不阻塞游戏消息 ---- */
    if (message[0] === '{') {
      try {
        ctrl = JSON.parse(message)
      } catch {
        ctrl = null
      }
      if (ctrl && ctrl.__hello) {
        const meta = readMeta(ws) || {}
        meta.clientId = String(ctrl.__hello)
        ws.serializeAttachment(meta)
        await this.ensureOfflineLog()
        this.offlineLog.delete(meta.clientId) /* 回归者清掉离线记录 */
        await persistOfflineLog(this)
        /* 同 clientId 顶替：页面刷新/断线重连时旧连接可能仍留在池里（close 处理滞后），
           直接关闭旧连接（不广播离线——人还在线），防止死连接堵住连接数上限 */
        for (const s of this.state.getWebSockets()) {
          if (s !== ws && (readMeta(s) || {}).clientId === meta.clientId) {
            try {
              s.close(RECONNECT_CODE, '同一设备已重新连接')
            } catch {}
          }
        }
        /* 初始成员快照（替代旧 __who 轮询）：在线者 = 池内其他连接（排除同 clientId 残留）；
           离线者 = offlineLog */
        const onlineIds = new Set()
        const list = []
        for (const s of this.state.getWebSockets()) {
          if (s === ws) continue
          const m = readMeta(s) || {}
          if (m.clientId && m.clientId !== meta.clientId) {
            onlineIds.add(m.clientId)
            list.push({ clientId: m.clientId, online: true })
          }
        }
        for (const [cid, at] of this.offlineLog) {
          if (!onlineIds.has(cid)) list.push({ clientId: cid, online: false, offlineAt: at })
        }
        try {
          ws.send(JSON.stringify({ type: 'peers', list, at: Date.now() }))
        } catch {}
        /* 向老成员广播新人上线 */
        const note = JSON.stringify({ type: 'peer_online', clientId: meta.clientId })
        for (const other of this.state.getWebSockets()) {
          if (other !== ws) {
            try {
              other.send(note)
            } catch {}
          }
        }
        return
      }
      if (ctrl && ctrl.type === 'kick') {
        /* 瞬时踢人：连接池里找到目标 ws 立即关闭；目标离线（无 ws）则忽略，
           close 事件随后触发 webSocketClose → 广播 peer_offline（含 4001 code） */
        const target = this.state
          .getWebSockets()
          .find((s) => (readMeta(s) || {}).clientId === ctrl.targetClientId)
        if (target) target.close(4001, '被踢出房间')
        return
      }
    }

    /* ---- 游戏消息：先广播（低延迟），持久化在处理器内 await 完成后返回 ----
       注意：DO 事件处理器返回后，未被 await 的异步 IO 会被运行时放弃——
       此前 persist 走 fire-and-forget，落盘间歇性丢失（重连/加入无 state 可回放，
       表现为「房间不存在/连接失败」误报）。DurableObjectState 没有 waitUntil，必须显式 await。
       full_state：全量快照（建房/加入/撤销/重开/设置等）→ 原样落盘
       patch_state：增量（提交/放弃/修正）→ 广播给对方 + 合并进最近全量后落盘
       其余 JSON（裸 state，兼容旧消息 / DO 回放形态）：原样广播 + 原样落盘 */
    if (ctrl && ctrl.type === 'full_state') {
      this.broadcast(ws, message)
      await this.persist(JSON.stringify(ctrl.state))
      return
    }
    if (ctrl && ctrl.type === 'patch_state') {
      this.broadcast(ws, message)
      await this.mergePersist(ctrl.patch)
      return
    }
    this.broadcast(ws, message)
    await this.persist(message)
  }

  broadcast(from, message) {
    for (const other of this.state.getWebSockets()) {
      if (other !== from) {
        try {
          other.send(message)
        } catch {}
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    /* 同设备重连关闭（RECONNECT_CODE）：人还在线，不记离线、不广播 */
    if (code === RECONNECT_CODE) return
    /* 记录离线时间（双离线顶替时比较「谁离线更久」用）并广播对端离线 */
    const meta = readMeta(ws) || {}
    if (meta.clientId) {
      this.offlineLog.set(meta.clientId, Date.now())
      await persistOfflineLog(this)
    }
    const note = JSON.stringify({ type: 'peer_offline', clientId: meta.clientId || null, code })
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

  async ensureOfflineLog() {
    if (this.offlineLoaded) return
    this.offlineLoaded = true
    try {
      const saved = await this.state.storage.get('offline_log')
      if (saved) for (const [cid, at] of saved) if (!this.offlineLog.has(cid)) this.offlineLog.set(cid, at)
    } catch {}
  }

  async persist(message) {
    const now = Date.now()
    try {
      await this.state.storage.put({ room_state: message, room_saved_at: now })
    } catch (e) {
      console.error('storage put failed', e)
    }
    await this.saveD1(message, now)
  }

  /* 增量落盘：把 patch 合并进最近的全量快照——storage 始终保有完整 state，
     hibernation 回放直接给全量，无需补丁链。无基础快照（新房间还没发过 full_state）时跳过，等下一条 full_state。 */
  async mergePersist(patch) {
    try {
      const raw = await this.state.storage.get('room_state')
      const last = raw ? JSON.parse(raw) : null
      if (!last || typeof last !== 'object') return
      if (Array.isArray(patch.board)) last.board = patch.board
      if (typeof patch.round === 'number') last.round = patch.round
      if (patch.currentTurn) last.currentTurn = patch.currentTurn
      if (typeof patch.redScore === 'number') last.redScore = patch.redScore
      if (typeof patch.blueScore === 'number') last.blueScore = patch.blueScore
      if (Array.isArray(patch.historyAppend) && patch.historyAppend.length) {
        last.history = (last.history || []).concat(patch.historyAppend)
      }
      const now = Date.now()
      const merged = JSON.stringify(last)
      try {
        await this.state.storage.put({ room_state: merged, room_saved_at: now })
      } catch (e) {
        console.error('storage put failed', e)
      }
      await this.saveD1(merged, now)
    } catch (e) {
      console.error('merge persist failed', e)
    }
  }

  async saveD1(stateStr, now) {
    try {
      const rid = this.roomId || (await this.state.storage.get('room_id'))
      if (!rid) return
      await this.env.DB.prepare(
        `INSERT INTO rooms (room_id, state, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(room_id) DO UPDATE SET state = ?2, updated_at = ?3`
      )
        .bind(rid, stateStr, now)
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
function persistOfflineLog(room) {
  room.state.storage.put('offline_log', [...room.offlineLog.entries()]).catch(() => {})
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
