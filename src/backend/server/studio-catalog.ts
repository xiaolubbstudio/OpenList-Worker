import { Hono } from "hono"
import { getUserFromContext } from "./middlewares"
import { canWrite, getActualPath, canSeeHides } from "../pkg/permission"
import { getNearestMeta, canAccess, canWrite as metaWrite, isHidden } from "../pkg/meta"
import { resolvePath } from "../internal/model/db"
import { listItems, getDriver, flushPendingDriverState } from "../internal/op/storage"
import { Yun139Driver } from "../drivers/139/driver"

export const studioCatalogRouter = new Hono()
export const TRASH = "被移除的文件"
// New originals live flat in one cloud folder; the website's folders exist only in D1.
export const WAREHOUSE = "仓库"
export function warehouseName(name: string) {
  const dot = name.lastIndexOf("."), unsafe = /[:*?"<>|]/g
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(unsafe, "_").slice(0, 80) || "file"
  const ext = dot > 0 ? name.slice(dot).replace(unsafe, "_").slice(0, 16) : ""
  // The original name stays readable in the cloud app; the short id keeps files from overwriting each other.
  return `${base}__${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}${ext}`
}
export function validName(v: unknown): v is string {
  return typeof v === "string" && v.trim() === v && !!v && v.length <= 255 && !/[\\/\u0000-\u001f]/.test(v) && ![".", ".."].includes(v)
}
export function validFolder(v: unknown): v is string {
  return typeof v === "string" && v.length <= 1024 && (v === "" || v.split("/").every(validName)) && v.split("/")[0] !== TRASH
}
const join = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name
const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/"
const inside = (root: string, path: string) => path === root || path.startsWith((root === "/" ? "" : root) + "/")
const ready = new WeakMap<object, Promise<unknown>>()
export async function catalogTables(db: any) {
  let p = ready.get(db)
  if (!p) {
    p = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS studio_assets (scope TEXT NOT NULL, id TEXT NOT NULL, uid TEXT NOT NULL, source_path TEXT NOT NULL, original_path TEXT NOT NULL, name TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL, modified TEXT NOT NULL, thumb TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, pending_path TEXT NOT NULL DEFAULT '', pending_deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,id), UNIQUE(scope,uid))`),
      db.prepare(`CREATE TABLE IF NOT EXISTS studio_folders (scope TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, source_uid TEXT, PRIMARY KEY(scope,id), UNIQUE(scope,path), UNIQUE(scope,source_uid))`),
      db.prepare(`CREATE TABLE IF NOT EXISTS studio_catalog_locks (scope TEXT PRIMARY KEY, owner TEXT NOT NULL, until_ms INTEGER NOT NULL)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS studio_catalog_state (scope TEXT PRIMARY KEY, synced_ms INTEGER NOT NULL)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS studio_favorites (scope TEXT NOT NULL, username TEXT NOT NULL, asset_id TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(scope,username,asset_id))`),
    ]).then(async () => {
      // missing marks files the last cloud inventory did not see, so a list can be served from D1 alone.
      const columns = async () => ((await db.prepare("PRAGMA table_info(studio_assets)").all()).results || []).map((c: any) => c.name)
      for (const [name, sql] of [["missing", "missing INTEGER NOT NULL DEFAULT 0"], ["uploader", "uploader TEXT NOT NULL DEFAULT ''"], ["sort_order", "sort_order INTEGER"]]) {
        if ((await columns()).includes(name)) continue
        // Another instance may add the column first; only a column that is still absent is an error.
        try { await db.prepare(`ALTER TABLE studio_assets ADD COLUMN ${sql}`).run() } catch (e) { if (!(await columns()).includes(name)) throw e }
      }
    })
    ready.set(db, p!)
    p!.catch(() => ready.delete(db))
  }
  await p
}
function failure(c: any, code: number, message: string) { return c.json({ code, message, data: null }, code as any) }
class CatalogError extends Error { constructor(public code: number, message: string) { super(message) } }
async function context(c: any, body: any, write = false) {
  const user = await getUserFromContext(c)
  if (!user || user.disabled || ![0, 2].includes(user.role) || !c.req.header("Authorization")) throw new CatalogError(401, "请重新登录素材库。")
  const path = body.path ?? "/"
  if (typeof path !== "string" || !path.startsWith("/") || /[\\%\u0000-\u001f]/.test(path) || path.split("/").some((p: string) => p === "." || p === "..") || path.startsWith("/@")) throw new CatalogError(400, "目录路径无效。")
  const scope = getActualPath(user, path.replace(/\/+$/, "") || "/")
  const meta = await getNearestMeta(scope)
  if (!canAccess(user, meta, scope, "") || (write && (!canWrite(user) || !metaWrite(user, meta, scope)))) throw new CatalogError(403, "此账号没有整理素材的权限。")
  const resolved = await resolvePath(scope, c.env)
  if (resolved.isVirtual || resolved.storage?.driver !== "139Yun") throw new CatalogError(400, "此素材管理器只支持已接入的移动云盘。")
  if (!c.env?.DB) throw new Error("Catalog database unavailable")
  await catalogTables(c.env.DB)
  const requestContext = { env: c.env }
  return { c, db: c.env.DB, user, scope, resolved, requestContext }
}
async function authorizePath(ctx: any, path: string, write = false) {
  if (!inside(ctx.scope, path)) throw new CatalogError(403, "文件不在获准目录中。")
  const meta = await getNearestMeta(path)
  if (!canAccess(ctx.user, meta, path, "") || (!canSeeHides(ctx.user) && isHidden(meta, path, path.split('/').at(-1)!)) || (write && !metaWrite(ctx.user, meta, path))) throw new CatalogError(403, "此账号没有该素材的权限。")
}
async function rows(ctx: any) { return (await ctx.db.prepare("SELECT * FROM studio_assets WHERE scope=?").bind(ctx.scope).all()).results || [] }
async function folders(ctx: any) { return (await ctx.db.prepare("SELECT * FROM studio_folders WHERE scope=? ORDER BY path").bind(ctx.scope).all()).results || [] }
async function lock(ctx: any) {
  const owner = crypto.randomUUID(), now = Date.now()
  await ctx.db.prepare("INSERT OR IGNORE INTO studio_catalog_locks(scope,owner,until_ms) VALUES (?,'',0)").bind(ctx.scope).run()
  const r = await ctx.db.prepare("UPDATE studio_catalog_locks SET owner=?,until_ms=? WHERE scope=? AND until_ms<?").bind(owner, now + 120000, ctx.scope, now).run()
  if (r.meta?.changes !== 1) throw new CatalogError(409, "其他成员正在整理，请稍后刷新重试。")
  return async () => { await ctx.db.prepare("UPDATE studio_catalog_locks SET until_ms=0 WHERE scope=? AND owner=?").bind(ctx.scope, owner).run() }
}
async function folderExists(ctx: any, folder: string) {
  if (folder && !await ctx.db.prepare("SELECT id FROM studio_folders WHERE scope=? AND path=?").bind(ctx.scope, folder).first()) throw new CatalogError(409, "文件夹已变化，请刷新后重试。")
}
export async function ensureVirtualFolders(db: any, scope: string, folder: string) {
  if (!validFolder(folder)) throw new CatalogError(400, "文件夹名称无效。")
  const parts = folder.split("/").filter(Boolean), entries = []
  if (parts.length > 20) throw new CatalogError(400, "文件夹层级过深。")
  for (let i = 1; i <= parts.length; i++) entries.push({ id: crypto.randomUUID(), path: parts.slice(0, i).join("/") })
  if (entries.length) await db.prepare("INSERT OR IGNORE INTO studio_folders(scope,id,path) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.path') FROM json_each(?)").bind(scope, JSON.stringify(entries)).run()
}
// sourceDir is the real cloud folder (the warehouse); path is the library the member uploaded into.
export async function registerStudioUpload(c: any, user: any, path: string, file: any, folder: string, displayName: string, sourceDir?: string) {
  const scope = getActualPath(user, path), dir = sourceDir || scope
  if (!inside(scope, dir)) throw new CatalogError(403, "文件不在获准目录中。")
  const relative = dir.slice(scope === "/" ? 0 : scope.length) || "/"
  await catalogTables(c.env.DB)
  await ensureVirtualFolders(c.env.DB, scope, folder)
  await c.env.DB.prepare(`INSERT OR IGNORE INTO studio_assets(scope,id,uid,source_path,original_path,name,folder,size,modified,thumb,uploader) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(scope, "ol-" + join(relative, file.name), file.sign, join(dir, file.name), join(dir, file.name), displayName, folder, file.size, file.modified || "", file.thumb || "", String(user.username || "")).run()
}
async function sync(ctx: any) {
  // One inventory request per refresh. Import only new files; never overwrite user organization.
  const saved = await rows(ctx), known = new Map(saved.map((r: any) => [r.uid, r])), dirs = await folders(ctx)
  const knownDirs = new Map(dirs.filter((r: any) => r.source_uid).map((r: any) => [r.source_uid, r.path]))
  const queue = [{ path: ctx.scope, folder: "" }], live = new Set<string>(), newFolders: any[] = [], inventory: any[] = []
  let count = 0, fileCount = 0
  while (queue.length) {
    const dir = queue.shift()!
    if (++count > 100) throw new CatalogError(400, "子目录超过上限，请缩小素材库范围。")
    await authorizePath(ctx, dir.path)
    const listing = await listItems(dir.path, ctx.requestContext)
    if (listing.storage?.id !== ctx.resolved.storage.id) throw new CatalogError(403, "不允许跨存储读取。")
    for (const item of listing.content) {
      if (!validName(item.name)) continue
      const source = join(dir.path, item.name)
      try { await authorizePath(ctx, source) } catch { continue }
      if (item.is_dir) {
        if (dir.path === ctx.scope && item.name === TRASH) continue
        // The warehouse is storage, not organization: files dropped there directly appear at the library root.
        if (dir.path === ctx.scope && item.name === WAREHOUSE) { queue.push({ path: source, folder: "" }); continue }
        let folder = knownDirs.get(item.sign) as string | undefined
        if (folder === undefined) {
          folder = (dir.folder ? dir.folder + "/" : "") + item.name
          newFolders.push({ id: crypto.randomUUID(), path: folder, uid: item.sign })
          knownDirs.set(item.sign, folder)
        }
        queue.push({ path: source, folder })
      } else {
        if (++fileCount > 5000) throw new CatalogError(400, "素材超过 5000 份，请缩小素材库范围。")
        const row: any = known.get(item.sign)
        if (row) {
          live.add(row.id)
          if (!row.deleted && !row.pending_path && (row.source_path !== source || row.size !== item.size || row.thumb !== (item.thumb || "") || row.modified !== (item.modified || ""))) {
            inventory.push({ ...row, source_path: source, size: item.size, modified: item.modified || "", thumb: item.thumb || "" })
          }
        } else {
          const relative = source.slice(ctx.scope === "/" ? 0 : ctx.scope.length), id = "ol-" + relative
          live.add(id)
          // A website upload found again (for example after restoring D1) gets its readable name back.
          const name = item.name.replace(/^(.+)__[0-9a-f]{8}(\.[^.]*)?$/, "$1$2")
          inventory.push({ id, uid: item.sign, source_path: source, original_path: source, name, folder: dir.folder, size: item.size, modified: item.modified || "", thumb: item.thumb || "" })
        }
      }
    }
  }
  // JSON batches keep import under D1's free per-invocation query limit even with many files.
  if (newFolders.length) await ctx.db.prepare("INSERT OR IGNORE INTO studio_folders(scope,id,path,source_uid) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.path'),json_extract(value,'$.uid') FROM json_each(?)").bind(ctx.scope, JSON.stringify(newFolders)).run()
  if (inventory.length) await ctx.db.prepare(`INSERT INTO studio_assets(scope,id,uid,source_path,original_path,name,folder,size,modified,thumb)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.uid'),json_extract(value,'$.source_path'),json_extract(value,'$.original_path'),json_extract(value,'$.name'),json_extract(value,'$.folder'),json_extract(value,'$.size'),json_extract(value,'$.modified'),json_extract(value,'$.thumb') FROM json_each(?) WHERE true
    ON CONFLICT(scope,uid) DO UPDATE SET source_path=excluded.source_path,size=excluded.size,modified=excluded.modified,thumb=excluded.thumb WHERE studio_assets.deleted=0 AND studio_assets.pending_path=''`).bind(ctx.scope, JSON.stringify(inventory)).run()
  // Trashed and in-flight rows are not in the inventory by design; only settled files can go missing.
  await ctx.db.batch([
    ctx.db.prepare("UPDATE studio_assets SET missing = CASE WHEN id IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END WHERE scope=? AND deleted=0 AND pending_path=''").bind(JSON.stringify([...live]), ctx.scope),
    ctx.db.prepare("INSERT INTO studio_catalog_state(scope,synced_ms) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET synced_ms=excluded.synced_ms").bind(ctx.scope, Date.now()),
  ])
  return snapshot(ctx)
}
// The catalog as last inventoried plus every edit since; reads D1 only, never the cloud.
async function snapshot(ctx: any) {
  const assets = []
  for (const row of await rows(ctx)) {
    if (!row.deleted && !row.pending_path && row.missing) continue
    try { await authorizePath(ctx, row.original_path); await authorizePath(ctx, row.source_path) } catch { continue }
    const { source_path, original_path, pending_path, scope, uid, missing, ...safe } = row
    assets.push({ ...safe, pending: !!pending_path })
  }
  const favorites = ((await ctx.db.prepare("SELECT asset_id FROM studio_favorites WHERE scope=? AND username=?").bind(ctx.scope, ctx.user.username).all()).results || []).map((r: any) => r.asset_id)
  return { assets, folders: (await folders(ctx)).map((r: any) => r.path), favorites, canManage: canWrite(ctx.user) && metaWrite(ctx.user, await getNearestMeta(ctx.scope), ctx.scope) }
}
const ids = (value: unknown, max = 500) => {
  if (!Array.isArray(value) || !value.length || value.length > max || value.some(v => typeof v !== "string" || !v || v.length > 1100)) throw new CatalogError(400, "素材选择无效。")
  return [...new Set(value as string[])]
}
async function syncLocked(ctx: any) {
  const release = await lock(ctx)
  try { return await sync(ctx) } finally { await release().catch(() => {}) }
}
async function asset(ctx: any, body: any) {
  const row = await ctx.db.prepare("SELECT * FROM studio_assets WHERE scope=? AND id=?").bind(ctx.scope, String(body.id || "")).first()
  if (!row) throw new CatalogError(404, "素材已不存在，请刷新目录。")
  await authorizePath(ctx, row.original_path, true); await authorizePath(ctx, row.source_path, true)
  if (body.revision !== undefined && row.revision !== body.revision) throw new CatalogError(409, "素材刚被其他成员修改，请刷新后重试。")
  return row
}
async function driverFor(ctx: any, path: string) {
  const resolved = await resolvePath(path, ctx.c.env)
  if (resolved.storage?.id !== ctx.resolved.storage.id || resolved.isVirtual) throw new CatalogError(403, "不允许跨存储操作。")
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  if (!(driver instanceof Yun139Driver)) throw new Error("Unsupported driver")
  return { resolved, driver }
}
async function ensurePhysical(ctx: any, dir: string) {
  const suffix = dir.slice(ctx.scope.length).split("/").filter(Boolean)
  let current = ctx.scope
  for (const name of suffix) {
    current = join(current, name)
    await authorizePath(ctx, current, true)
    const { driver, resolved } = await driverFor(ctx, current)
    await driver.studioEnsureDirectory(resolved.physical!)
    await flushPendingDriverState(resolved.storage!.driver, resolved.storage, driver, ctx.requestContext)
  }
}
async function relocate(ctx: any, row: any, deleted: boolean) {
  // Persist the intent first. A cloud timeout can be retried without losing or duplicating the file.
  const trashRoot = join(ctx.scope, TRASH)
  const trashSlot = join(trashRoot, row.uid.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200))
  const destination = deleted ? join(trashSlot, row.original_path.split("/").at(-1)) : row.original_path
  if (row.pending_path && (row.pending_deleted !== Number(deleted) || row.pending_path !== destination)) throw new CatalogError(409, "上次移动尚未确认，请先重试该操作。")
  await authorizePath(ctx, destination, true)
  await ensurePhysical(ctx, parent(destination))
  await ctx.db.prepare("UPDATE studio_assets SET pending_path=?,pending_deleted=? WHERE scope=? AND id=?").bind(destination, Number(deleted), ctx.scope, row.id).run()
  const source = await driverFor(ctx, row.source_path), target = await driverFor(ctx, destination)
  await source.driver.studioRelocate(source.resolved.physical!, target.resolved.physical!, row.uid)
  await flushPendingDriverState(source.resolved.storage!.driver, source.resolved.storage, source.driver, ctx.requestContext)
  await ctx.db.prepare("UPDATE studio_assets SET source_path=?,deleted=?,pending_path='',missing=0,revision=revision+1 WHERE scope=? AND id=?").bind(destination, Number(deleted), ctx.scope, row.id).run()
}
async function run(c: any, handler: (ctx: any, body: any) => Promise<any>, write = false) {
  let release: (() => Promise<void>) | undefined
  try {
    const body = await c.req.json(), ctx = await context(c, body, write)
    // Cloud moves and catalog edits serialize in D1 across Worker instances, not in process memory.
    release = await lock(ctx)
    const data = await handler(ctx, body)
    return c.json({ code: 200, message: "success", data })
  } catch (e: any) { return failure(c, e instanceof CatalogError ? e.code : 503, e instanceof CatalogError ? e.message : "操作未确认，请刷新后重试；原文件不会被永久删除。") }
  finally { if (release) await release().catch(() => {}) }
}
// Opening the site reads D1 only. The cloud is inventoried when a member presses refresh, on the very
// first list, or in the background after the last inventory is older than ten minutes.
const FRESH_MS = 10 * 60 * 1000
studioCatalogRouter.post("/list", async c => {
  try {
    const body = await c.req.json(), ctx = await context(c, body)
    const state: any = await ctx.db.prepare("SELECT synced_ms FROM studio_catalog_state WHERE scope=?").bind(ctx.scope).first()
    if (body.refresh === true || !state) {
      try { return c.json({ code: 200, message: "success", data: await syncLocked(ctx) }) }
      catch (e) { if (!state || !(e instanceof CatalogError && e.code === 409)) throw e } // Someone else is inventorying: serve the saved catalog.
    } else if (Date.now() - Number(state.synced_ms) > FRESH_MS) {
      const pending = syncLocked(ctx).catch(() => {})
      let background = false
      try { c.executionCtx.waitUntil(pending); background = true } catch { await pending }
      return c.json({ code: 200, message: "success", data: { ...await snapshot(ctx), syncing: background } })
    }
    return c.json({ code: 200, message: "success", data: await snapshot(ctx) })
  } catch (e: any) { return failure(c, e instanceof CatalogError ? e.code : 503, e instanceof CatalogError ? e.message : "目录暂时无法读取，请稍后刷新。") }
})
studioCatalogRouter.post("/edit", c => run(c, async (ctx, body) => {
  const row = await asset(ctx, body)
  if (row.deleted || row.pending_path) throw new CatalogError(409, "请先恢复素材或重试未完成的移动。")
  const name = body.name ?? row.name, folder = body.folder ?? row.folder
  if (!validName(name) || !validFolder(folder)) throw new CatalogError(400, "名称或文件夹路径无效。")
  // Preserve the real format; a display rename must not turn a PNG into a GIF.
  const extension = (n: string) => n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.')).toLowerCase() : ''
  if (extension(name) !== extension(row.name)) throw new CatalogError(400, "请保留原文件扩展名。")
  await folderExists(ctx, folder)
  await ctx.db.prepare("UPDATE studio_assets SET name=?1,folder=?2,sort_order=CASE WHEN folder=?2 THEN sort_order END,revision=revision+1 WHERE scope=?3 AND id=?4").bind(name, folder, ctx.scope, row.id).run()
  return { id: row.id }
}, true))
studioCatalogRouter.post("/trash", c => run(c, async (ctx, body) => {
  const row = await asset(ctx, body)
  if (!row.deleted || row.pending_path) await relocate(ctx, row, true)
  return { id: row.id }
}, true))
studioCatalogRouter.post("/restore", c => run(c, async (ctx, body) => {
  const row = await asset(ctx, body)
  if (row.deleted || row.pending_path) await relocate(ctx, row, false)
  await ensureVirtualFolders(ctx.db, ctx.scope, row.folder)
  return { id: row.id }
}, true))
studioCatalogRouter.post("/folder", c => run(c, async (ctx, body) => {
  const path = body.folder, next = body.next
  if (!validFolder(path) || !path) throw new CatalogError(400, "文件夹路径无效。")
  const existing = await folders(ctx)
  if (body.action === "create") {
    if (existing.some((r: any) => r.path === path)) throw new CatalogError(409, "同名文件夹已存在。")
    await ensureVirtualFolders(ctx.db, ctx.scope, path)
  } else {
    const row = existing.find((r: any) => r.path === path)
    if (!row) throw new CatalogError(409, "文件夹已变化，请刷新后重试。")
    const affected = (await rows(ctx)).filter((r: any) => r.folder === path || r.folder.startsWith(path + "/"))
    for (const file of affected) { await authorizePath(ctx, file.original_path, true); await authorizePath(ctx, file.source_path, true) }
    const descendants = existing.filter((r: any) => r.path === path || r.path.startsWith(path + "/"))
    if (body.action === "delete") {
      if (affected.length || descendants.length > 1 || row.source_uid) throw new CatalogError(409, "只能删除没有素材和子文件夹的网站文件夹。")
      await ctx.db.prepare("DELETE FROM studio_folders WHERE scope=? AND id=?").bind(ctx.scope, row.id).run()
    } else if (body.action === "move") {
      if (!validFolder(next) || !next || next === path || next.startsWith(path + "/")) throw new CatalogError(400, "目标文件夹无效，不能移动到自身内部。")
      const targetParent = next.includes("/") ? next.slice(0, next.lastIndexOf("/")) : ""
      await folderExists(ctx, targetParent)
      if (existing.some((r: any) => r.path === next || r.path.startsWith(next + "/"))) throw new CatalogError(409, "目标文件夹已存在。")
      // Atomic transaction: readers never see only half of a folder rename. Prefix comparison avoids LIKE escaping bugs.
      await ctx.db.batch([
        ctx.db.prepare("UPDATE studio_folders SET path=? || substr(path,?) WHERE scope=? AND (path=? OR substr(path,1,?)=?)").bind(next, path.length + 1, ctx.scope, path, path.length + 1, path + "/"),
        ctx.db.prepare("UPDATE studio_assets SET folder=? || substr(folder,?),revision=revision+1 WHERE scope=? AND (folder=? OR substr(folder,1,?)=?)").bind(next, path.length + 1, ctx.scope, path, path.length + 1, path + "/"),
      ])
    } else throw new CatalogError(400, "文件夹操作无效。")
  }
  return { success: true }
}, true))
// Moving many files only rewrites D1: one request, one transaction, no cloud calls.
studioCatalogRouter.post("/move", c => run(c, async (ctx, body) => {
  const selected = ids(body.ids), folder = body.folder
  if (!validFolder(folder)) throw new CatalogError(400, "文件夹路径无效。")
  await folderExists(ctx, folder)
  const found = ((await ctx.db.prepare("SELECT * FROM studio_assets WHERE scope=? AND id IN (SELECT value FROM json_each(?))").bind(ctx.scope, JSON.stringify(selected)).all()).results || []) as any[]
  if (found.length !== selected.length) throw new CatalogError(409, "部分素材已变化，请刷新后重试。")
  for (const row of found) {
    if (row.deleted || row.pending_path) throw new CatalogError(409, "请先恢复素材或重试未完成的移动。")
    await authorizePath(ctx, row.original_path, true); await authorizePath(ctx, row.source_path, true)
  }
  await ctx.db.prepare("UPDATE studio_assets SET folder=?1,sort_order=CASE WHEN folder=?1 THEN sort_order END,revision=revision+1 WHERE scope=?2 AND id IN (SELECT value FROM json_each(?3))").bind(folder, ctx.scope, JSON.stringify(selected)).run()
  return { moved: found.length }
}, true))
// Manual order is shared by all members and kept per folder; the website sends one group's whole sequence.
studioCatalogRouter.post("/order", c => run(c, async (ctx, body) => {
  const selected = ids(body.ids, 5000), folder = body.folder
  if (!validFolder(folder)) throw new CatalogError(400, "文件夹路径无效。")
  const found = ((await ctx.db.prepare("SELECT id,folder,deleted,pending_path FROM studio_assets WHERE scope=? AND id IN (SELECT value FROM json_each(?))").bind(ctx.scope, JSON.stringify(selected)).all()).results || []) as any[]
  if (found.length !== selected.length || found.some(row => row.folder !== folder || row.deleted || row.pending_path)) throw new CatalogError(409, "部分素材已变化，请刷新后重试。")
  await ctx.db.prepare("UPDATE studio_assets SET sort_order=(SELECT key FROM json_each(?2) WHERE value=studio_assets.id) WHERE scope=?1 AND id IN (SELECT value FROM json_each(?2))").bind(ctx.scope, JSON.stringify(selected)).run()
  return { ordered: selected.length }
}, true))
// Favorites belong to the member account, so phone and computer show the same hearts.
studioCatalogRouter.post("/favorite", async c => {
  try {
    const body = await c.req.json(), ctx = await context(c, body), selected = ids(body.ids)
    if (!canWrite(ctx.user)) throw new CatalogError(403, "只看账号不能收藏。")
    if (body.on === true) await ctx.db.prepare("INSERT OR IGNORE INTO studio_favorites(scope,username,asset_id,created_ms) SELECT ?,?,id,? FROM studio_assets WHERE scope=? AND id IN (SELECT value FROM json_each(?))").bind(ctx.scope, ctx.user.username, Date.now(), ctx.scope, JSON.stringify(selected)).run()
    else await ctx.db.prepare("DELETE FROM studio_favorites WHERE scope=? AND username=? AND asset_id IN (SELECT value FROM json_each(?))").bind(ctx.scope, ctx.user.username, JSON.stringify(selected)).run()
    return c.json({ code: 200, message: "success", data: { success: true } })
  } catch (e: any) { return failure(c, e instanceof CatalogError ? e.code : 503, e instanceof CatalogError ? e.message : "收藏未保存，请稍后重试。") }
})
// The website's organization is the only map of the warehouse; members who manage it can keep a copy.
studioCatalogRouter.post("/backup", async c => {
  try {
    const body = await c.req.json(), ctx = await context(c, body, true), relative = (p: string) => p.slice(ctx.scope === "/" ? 0 : ctx.scope.length) || "/"
    const assets = (await rows(ctx)).map((r: any) => ({ id: r.id, name: r.name, folder: r.folder, cloud_path: relative(r.source_path), original_path: relative(r.original_path), size: r.size, modified: r.modified, uploader: r.uploader, deleted: !!r.deleted, missing: !!r.missing }))
    return c.json({ code: 200, message: "success", data: { version: 1, exported_at: new Date().toISOString(), folders: (await folders(ctx)).map((r: any) => r.path), assets } })
  } catch (e: any) { return failure(c, e instanceof CatalogError ? e.code : 503, e instanceof CatalogError ? e.message : "目录备份失败，请稍后重试。") }
})
studioCatalogRouter.post("/resolve", async c => {
  try {
    const body = await c.req.json(), ctx = await context(c, body), row = await ctx.db.prepare("SELECT * FROM studio_assets WHERE scope=? AND id=?").bind(ctx.scope, String(body.id || "")).first()
    if (!row || row.deleted || row.pending_path) throw new CatalogError(404, "素材已移除或移动尚未确认，请刷新目录。")
    await authorizePath(ctx, row.original_path); await authorizePath(ctx, row.source_path)
    const { driver, resolved } = await driverFor(ctx, row.source_path)
    const item = await driver.get(row.source_path, resolved.physical!)
    if (item.sign !== row.uid || !item.raw_url) throw new CatalogError(409, "原文件已变化，请刷新目录。")
    await flushPendingDriverState(resolved.storage!.driver, resolved.storage, driver, ctx.requestContext)
    return c.json({ code: 200, message: "success", data: { raw_url: item.raw_url } })
  } catch (e: any) { return failure(c, e instanceof CatalogError ? e.code : 503, e instanceof CatalogError ? e.message : "无法获取原文件，请稍后重试。") }
})
