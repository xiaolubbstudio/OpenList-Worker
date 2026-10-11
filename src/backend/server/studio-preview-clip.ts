// Only derived, five-second clips leave this service. Originals remain in the cloud.
// No R2 subscription, public upload endpoint, or local conversion is required.
export const CLIP_PROFILE = "360p-5s-v1"
export const CLIP_DIRECTORY = "素材预览缓存"
export const CLIP_SECONDS = 5
const MAX_INPUT = 100_000_000, MAX_OUTPUT = 8 * 1024 * 1024
const MONTHLY_SECONDS = 4000 // Reserve space below the shared 5,000 transformation allowance.
export class ClipError extends Error { constructor(public code: number, message: string) { super(message) } }
const setup = new WeakMap<object, Promise<unknown>>()
async function tables(db: any) {
  let pending = setup.get(db)
  if (!pending) {
    pending = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS studio_preview_clips (scope TEXT NOT NULL, asset_id TEXT NOT NULL, cache_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', file_path TEXT NOT NULL DEFAULT '', file_uid TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, updated_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,asset_id))`),
      db.prepare(`CREATE TABLE IF NOT EXISTS studio_preview_budget (month TEXT PRIMARY KEY, seconds INTEGER NOT NULL DEFAULT 0)`),
    ])
    setup.set(db, pending!); pending!.catch(() => setup.delete(db))
  }
  await pending
}
export async function clipKey(scope: string, row: any) {
  // Rename, virtual moves, and favorites do not change the source version.
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([scope, row.uid, row.size, row.modified, CLIP_PROFILE])))
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("")
}
function cloudURL(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || !["139.com", "10086.cn", "cmecloud.cn"].some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) throw new ClipError(503, "预览暂时不可用，请下载原文件。")
  return url.href
}
export async function limitedBytes(response: Response, max = MAX_OUTPUT) {
  if (!response.ok || !response.body) throw new ClipError(503, "预览生成失败，请稍后重试或下载。")
  if (Number(response.headers.get("Content-Length")) > max) { await response.body.cancel(); throw new ClipError(413, "预览文件过大，请下载原文件。") }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      size += part.value.byteLength
      if (size > max) { await reader.cancel(); throw new ClipError(413, "预览文件过大，请下载原文件。") }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  if (!size) throw new ClipError(503, "预览生成失败，请稍后重试或下载。")
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
export async function resolveClip(ctx: any, row: any, driverFor: (ctx: any, path: string) => Promise<any>, flush: (target: any) => Promise<any>) {
  if (!/\.(mp4|mov|m4v|webm|gif)$/i.test(row.name)) throw new ClipError(415, "此格式暂无短预览，请下载原文件。")
  if (!Number.isSafeInteger(row.size) || row.size <= 0 || row.size >= MAX_INPUT) throw new ClipError(413, "此文件超过短预览支持的大小，请下载原文件。")
  if (!ctx.c.env.MEDIA) throw new ClipError(503, "短预览服务暂不可用，请下载原文件。")
  await tables(ctx.db)
  const key = await clipKey(ctx.scope, row), now = Date.now(), db = ctx.db
  const saved: any = await db.prepare("SELECT * FROM studio_preview_clips WHERE scope=? AND asset_id=?").bind(ctx.scope, row.id).first()
  async function ready(filePath: string, uid: string) {
    const target = await driverFor(ctx, filePath), item = await target.driver.get(filePath, target.resolved.physical!)
    if (item.sign !== uid || !item.raw_url || item.size > MAX_OUTPUT) throw new ClipError(503, "预览缓存暂时不可用，请下载原文件。")
    await flush(target)
    return { preview_url: cloudURL(item.raw_url), duration: CLIP_SECONDS, profile: CLIP_PROFILE }
  }
  if (saved?.cache_key === key && saved.status === "ready") return ready(saved.file_path, saved.file_uid)
  if (saved?.cache_key === key && (saved.lease_until > now || saved.retry_after > now || saved.attempts >= 3)) throw new ClipError(saved.status === "working" ? 409 : 415, saved.status === "working" ? "预览正在生成，请稍后打开。" : "此文件暂无法生成预览，请下载原文件。")
  await db.prepare(`INSERT INTO studio_preview_clips(scope,asset_id,cache_key) VALUES (?,?,?) ON CONFLICT(scope,asset_id) DO NOTHING`).bind(ctx.scope, row.id, key).run()
  const claim = await db.prepare(`UPDATE studio_preview_clips SET cache_key=?,status='working',file_path='',file_uid='',lease_until=?,retry_after=0,attempts=CASE WHEN cache_key=? THEN attempts+1 ELSE 1 END,updated_ms=? WHERE scope=? AND asset_id=? AND lease_until<=? AND (cache_key<>? OR (retry_after<=? AND attempts<3 AND status<>'ready'))`).bind(key, now + 180000, key, now, ctx.scope, row.id, now, key, now).run()
  if (claim.meta?.changes !== 1) throw new ClipError(409, "预览正在生成，请稍后打开。")
  try {
    const source = await driverFor(ctx, row.source_path), item = await source.driver.get(row.source_path, source.resolved.physical!)
    if (item.sign !== row.uid || item.size !== row.size || !item.raw_url) throw new ClipError(409, "原文件已变化，请刷新目录。")
    await flush(source)
    const month = new Date(now).toISOString().slice(0, 7)
    await db.prepare("INSERT OR IGNORE INTO studio_preview_budget(month) VALUES (?)").bind(month).run()
    const budget = await db.prepare("UPDATE studio_preview_budget SET seconds=seconds+? WHERE month=? AND seconds+?<=?").bind(CLIP_SECONDS, month, CLIP_SECONDS, MONTHLY_SECONDS).run()
    if (budget.meta?.changes !== 1) throw new ClipError(429, "本月短预览生成额度已用完，请下载原文件。")
    const response = await fetch(cloudURL(item.raw_url), { signal: AbortSignal.timeout(45000) })
    if (!response.ok || !response.body || Number(response.headers.get("Content-Length")) > MAX_INPUT) { await response.body?.cancel(); throw new ClipError(503, "原文件暂时无法读取，请稍后重试。") }
    const transformed = await ctx.c.env.MEDIA.input(response.body).transform({ width: 640, height: 360, fit: "scale-down" }).output({ mode: "video", time: "0s", duration: "5s", audio: true }).response()
    const bytes = await limitedBytes(transformed)
    // A deterministic file name also reuses an upload completed before a lost D1 response.
    const folder = (ctx.scope === "/" ? "" : ctx.scope) + "/" + CLIP_DIRECTORY, target = await driverFor(ctx, folder)
    await target.driver.studioEnsureDirectory(target.resolved.physical!)
    const digest = await crypto.subtle.digest("SHA-256", bytes), hash = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("")
    const state = await target.driver.beginStudioUpload(target.resolved.physical!, `${key}.mp4`, bytes.length, hash)
    if (!state.ready) {
      const uploadURL = await target.driver.studioPartLink(state, 1)
      const upload = await fetch(cloudURL(uploadURL), { method: "PUT", body: bytes, signal: AbortSignal.timeout(30000) })
      if (!upload.ok) throw new ClipError(503, "预览保存失败，请稍后重试。")
    }
    const file = await target.driver.finishStudioUpload(state), filePath = folder + "/" + file.name
    await flush(target)
    // Never mark unconfirmed cloud uploads as reusable.
    const clip = await ready(filePath, state.fileId)
    await db.prepare("UPDATE studio_preview_clips SET status='ready',file_path=?,file_uid=?,lease_until=0,updated_ms=? WHERE scope=? AND asset_id=? AND cache_key=?").bind(filePath, state.fileId, Date.now(), ctx.scope, row.id, key).run()
    return clip
  } catch (error: any) {
    const unsupported = error?.code === 415 || (error?.name === "MediaError" && [9401, 9402, 9412].includes(error.code))
    await db.prepare("UPDATE studio_preview_clips SET status='failed',lease_until=0,retry_after=?,updated_ms=? WHERE scope=? AND asset_id=? AND cache_key=?").bind(Date.now() + (unsupported ? 86400000 : 300000), Date.now(), ctx.scope, row.id, key).run().catch(() => {})
    if (error instanceof ClipError) throw error
    // Media/cloud errors can contain signed URLs. Do not return or log them.
    throw new ClipError(unsupported ? 415 : 503, unsupported ? "此视频暂不支持短预览，请下载原文件。" : "预览暂时无法生成，请稍后重试或下载。")
  }
}
