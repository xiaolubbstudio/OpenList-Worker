import { getUserFromContext } from './middlewares'
import { consumeStudioRequest } from './studio-traffic'
import { setEnvCtx } from '../internal/model/db'

// Who is online: every open page keeps one WebSocket to a single Durable Object. Nothing is stored;
// messages flow only when a member arrives, leaves, changes folder or starts/stops an operation.
// Keepalive "ping" is answered by the runtime without waking the object.
export const PRESENCE_PATH = '/api/studio_presence'
const PROTOCOL = 'studio-presence'
const ACTIONS = ['upload', 'organize', 'move']

export function presenceState(state: any, data: any, now: number) {
  const action = ACTIONS.includes(data?.action) ? data.action : ''
  return {
    ...state,
    visible: data?.visible !== false,
    folder: typeof data?.folder === 'string' ? data.folder.slice(0, 200) : '',
    action,
    detail: action && typeof data?.detail === 'string' ? data.detail.slice(0, 24) : '',
    at: action ? now : 0,
  }
}
// One row per member, however many tabs and devices they have open.
export function summarize(states: any[], now: number) {
  const members = new Map<string, any>()
  for (const s of states) {
    if (!s?.name) continue
    const m = members.get(s.name) || { name: s.name, visible: false, folder: '', action: '', detail: '', at: 0, since: s.since }
    m.since = Math.min(m.since, s.since)
    if (s.visible && !m.visible) { m.visible = true; m.folder = s.folder }
    else if (!m.visible && !m.folder) m.folder = s.folder
    if (s.action && s.at > m.at) { m.action = s.action; m.detail = s.detail; m.at = s.at; if (s.folder) m.folder = s.folder }
    members.set(s.name, m)
  }
  return { t: 'presence', now, members: [...members.values()].sort((a, b) => a.since - b.since) }
}
// Browsers cannot read an HTTP status from a failed handshake, so refusals close with a code the page understands.
function refuse(code: number, reason: string) {
  const pair = new WebSocketPair()
  pair[1].accept()
  pair[1].close(code, reason)
  return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': PROTOCOL } })
}
export async function handleStudioPresence(request: Request, env: any) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
  const origin = request.headers.get('Origin')
  const allowed = String(env.ALLOW_URLS || '').split(',').map(v => v.trim()).filter(Boolean)
  let sameHost = false
  try { sameHost = !!origin && new URL(origin).host === new URL(request.url).host } catch {}
  if (origin && !allowed.includes(origin) && !sameHost) return new Response('Forbidden', { status: 403 })
  // The member token rides in the subprotocol list, not the URL, so it never lands in request logs.
  const offered = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(v => v.trim())
  if (offered[0] !== PROTOCOL) return new Response('Unsupported protocol', { status: 400 })
  const token = offered[1] || ''
  if (!token || !env.STUDIO_PRESENCE) return refuse(4401, 'login required')
  setEnvCtx(env)
  const context: any = { env, req: { url: request.url, header: (name: string) => name.toLowerCase() === 'authorization' ? token : request.headers.get(name) ?? undefined, query: () => undefined } }
  const user = await getUserFromContext(context).catch(() => null)
  if (!user?.id || user.disabled || ![0, 2].includes(user.role) || !user.username || user.username === 'api-token') return refuse(4401, 'login required')
  const limit = await consumeStudioRequest(env, user.id).catch(() => ({ allowed: true }))
  if (!limit.allowed) return refuse(4429, 'too many requests')
  const stub = env.STUDIO_PRESENCE.get(env.STUDIO_PRESENCE.idFromName('library'))
  return stub.fetch('https://presence/connect', { headers: { Upgrade: 'websocket', 'X-Studio-Member': encodeURIComponent(user.username) } })
}
