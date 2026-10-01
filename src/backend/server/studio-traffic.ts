import { verify } from 'hono/jwt'
import { getJwtSecret } from './middlewares'

const ready = new WeakMap<object, Promise<void>>()
async function database(env: any) {
  if (!env.DB?.prepare) throw Error('Rate limit storage unavailable')
  if (!ready.has(env.DB)) {
    const promise = env.DB.prepare(`CREATE TABLE IF NOT EXISTS studio_request_limits (
      key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0
    )`).run().catch((error: any) => { ready.delete(env.DB); throw error })
    ready.set(env.DB, promise)
  }
  await ready.get(env.DB)
  return env.DB
}
async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function consumeStudioRequest(env: any, userId: number, now = Date.now()) {
  const db = await database(env), limit = Number(env.STUDIO_API_PER_MINUTE || 300)
  const row = await db.prepare(`INSERT INTO studio_request_limits(key,window_start,count,blocked_until) VALUES(?,?,1,0)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN studio_request_limits.window_start <= ? THEN 1 ELSE studio_request_limits.count+1 END,
      window_start=CASE WHEN studio_request_limits.window_start <= ? THEN excluded.window_start ELSE studio_request_limits.window_start END
    RETURNING count,window_start`).bind('user:' + userId, now, now - 60000, now - 60000).first()
  return { allowed: row.count <= limit, retryAfter: Math.max(1, Math.ceil((row.window_start + 60000 - now) / 1000)) }
}
export async function studioLoginLock(env: any, username: string, now = Date.now()) {
  const db = await database(env), key = 'login:' + await digest(username.trim().toLowerCase().slice(0, 256))
  const row = await db.prepare('SELECT blocked_until FROM studio_request_limits WHERE key=?').bind(key).first()
  return { key, retryAfter: row?.blocked_until > now ? Math.ceil((row.blocked_until - now) / 1000) : 0 }
}
export async function recordStudioLogin(env: any, key: string, successful: boolean, now = Date.now()) {
  const db = await database(env)
  if (successful) { await db.prepare('DELETE FROM studio_request_limits WHERE key=?').bind(key).run(); return }
  const lockMs = Number(env.STUDIO_LOGIN_LOCK_SECONDS || 900) * 1000
  const failures = Number(env.STUDIO_LOGIN_FAILURES || 5)
  await db.prepare(`INSERT INTO studio_request_limits(key,window_start,count,blocked_until) VALUES(?,?,1,0)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN studio_request_limits.window_start <= ? THEN 1 ELSE studio_request_limits.count+1 END,
      window_start=CASE WHEN studio_request_limits.window_start <= ? THEN excluded.window_start ELSE studio_request_limits.window_start END,
      blocked_until=CASE WHEN (CASE WHEN studio_request_limits.window_start <= ? THEN 1 ELSE studio_request_limits.count+1 END) >= ? THEN ? ELSE 0 END
  `).bind(key, now, now - lockMs, now - lockMs, now - lockMs, failures, now + lockMs).run()
}
function throttled(c: any, retryAfter: number, login = false) {
  return c.json({ code:429, message:login ? '登录失败次数过多，请 15 分钟后重试。' : '请求过于频繁，请稍后重试。', data:null },429,{'Retry-After':String(retryAfter),'Cache-Control':'no-store'})
}
export async function studioTrafficMiddleware(c: any, next: () => Promise<void>) {
  if (!c.env?.STUDIO_API_PER_MINUTE || c.req.method === 'OPTIONS') { await next(); return }
  try {
    const isLogin = c.req.method === 'POST' && /^\/api\/auth\/login(?:\/hash)?$/.test(c.req.path)
    let login: {key: string; retryAfter: number} | undefined
    if (isLogin) {
      const body = await c.req.raw.clone().json().catch(() => ({})) as any
      login = await studioLoginLock(c.env, typeof body.username === 'string' ? body.username : '')
      if (login.retryAfter) return throttled(c, login.retryAfter, true)
    }
    const token = (c.req.header('Authorization') || '').replace(/^Bearer /i,'')
    if (token) {
      let payload: any
      try { payload = await verify(token, await getJwtSecret(c), 'HS256') } catch {}
      if (payload && Number.isSafeInteger(payload.id) && payload.id > 0) {
        const result = await consumeStudioRequest(c.env, payload.id)
        if (!result.allowed) return throttled(c, result.retryAfter)
      }
    }
    await next()
    if (login) {
      const result = await c.res.clone().json().catch(() => null) as any
      if (result?.code === 200 && result.data?.token) await recordStudioLogin(c.env, login.key, true)
      else if (result?.code === 401) await recordStudioLogin(c.env, login.key, false)
    }
  } catch {
    return c.json({code:503,message:'安全计数暂时不可用，请稍后重试。',data:null},503,{'Retry-After':'60','Cache-Control':'no-store'})
  }
}
