import { presenceState, summarize } from '../server/studio-presence'

/**
 * One room for the whole material library. Uses the WebSocket Hibernation API: the object sleeps
 * between messages and is billed only while handling one; member state lives in each socket's
 * attachment, so nothing is written to storage.
 */
export class StudioPresence {
  state: any
  constructor(state: any) {
    this.state = state
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }
  async fetch(request: Request) {
    const name = decodeURIComponent(request.headers.get('X-Studio-Member') || '')
    if (!name || request.headers.get('Upgrade') !== 'websocket') return new Response('Bad request', { status: 400 })
    if (this.state.getWebSockets().length >= 40) return new Response('Busy', { status: 503 })
    const pair = new WebSocketPair()
    const now = Date.now()
    this.state.acceptWebSocket(pair[1])
    pair[1].serializeAttachment({ name, visible: true, folder: '', action: '', detail: '', at: 0, since: now, count: 0, window: now })
    this.broadcast()
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'studio-presence' } })
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 600) return
    const now = Date.now(), current = (ws as any).deserializeAttachment()
    if (!current) return
    // A page only reports changes; anything chattier than once a second on average is cut off.
    if (now - current.window > 60000) { current.window = now; current.count = 0 }
    if (++current.count > 60) { ws.close(1008, 'too many messages'); return }
    let data: any
    try { data = JSON.parse(message) } catch { (ws as any).serializeAttachment(current); return }
    if (data?.t !== 'state') { (ws as any).serializeAttachment(current); return }
    ;(ws as any).serializeAttachment(presenceState(current, data, now))
    this.broadcast()
  }
  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye') } catch {}
    this.broadcast(ws)
  }
  async webSocketError(ws: WebSocket) { this.broadcast(ws) }
  broadcast(gone?: WebSocket) {
    const sockets = this.state.getWebSockets().filter((ws: WebSocket) => ws !== gone && ws.readyState !== 2 && ws.readyState !== 3)
    const text = JSON.stringify(summarize(sockets.map((ws: any) => ws.deserializeAttachment()), Date.now()))
    for (const ws of sockets) { try { ws.send(text) } catch {} }
  }
}
