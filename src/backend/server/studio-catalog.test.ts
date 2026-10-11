import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { studioCatalogRouter, registerStudioUpload, warehouseName } from './studio-catalog'
import { setEnvCtx, __resetDbCacheForTest, __setStoreBackendLoaderForTest } from '../internal/model/db'
import { Yun139Driver } from '../drivers/139/driver'

function binding(sql: DatabaseSync) {
  return {
    prepare(query: string) {
      let args: any[] = []
      const statement = {
        bind(...values: any[]) { args = values; return statement },
        async run() { const result = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } } },
        async all() { return { results: sql.prepare(query).all(...args) } },
        async first() { return sql.prepare(query).get(...args) || null },
      }
      return statement
    },
    async batch(statements: any[]) {
      sql.exec('BEGIN')
      try { const result = []; for (const s of statements) result.push(await s.run()); sql.exec('COMMIT'); return result }
      catch (e) { sql.exec('ROLLBACK'); throw e }
    },
  }
}

test('shared catalog preserves originals, denies unauthorized writes, rejects stale revisions and moves to real trash before hiding', async () => {
  __resetDbCacheForTest()
  const sql = new DatabaseSync(':memory:'), env: any = { DB: binding(sql), JWT_SECRET: 'studio-catalog-fixture-secret-at-least-32', DB_DRIVER: 'fixture', DB_CIPHER: 'none' }
  let config: any = { settings: [], storages: [{ id: 1, driver: '139Yun', mount_path: '/素材', status: 'work', addition: JSON.stringify({ type: 'personal_new', root_folder_id: '/', authorization: 'fixture' }) }], metas: [], users: [
    { id: 1, username: 'admin', role: 2, permission: 0, base_path: '/素材' },
    { id: 2, username: 'member', role: 0, permission: 8, base_path: '/素材' },
    { id: 3, username: 'reader', role: 0, permission: 0, base_path: '/素材' },
  ], shares: [], plugins: [] }
  __setStoreBackendLoaderForTest(async () => ({ name: 'fixture', isConfigured: async () => true, load: async () => structuredClone(config), save: async (next: any) => { config = structuredClone(next); return true } }))
  setEnvCtx(env)
  const cloud = new Map<string, any[]>([['/', [{ name: '旧文件夹', sign: 'dir-1', is_dir: true, size: 0, modified: '' }, { name: '素材预览缓存', sign: 'cache-dir', is_dir: true, size: 0, modified: '' }]], ['/旧文件夹', [{ name: '原图.png', sign: 'file-1', is_dir: false, size: 600, modified: '2026-10-02', thumb: '' }]], ['/素材预览缓存', [{ name: 'generated.mp4', sign: 'cache-file', is_dir: false, size: 24000, modified: '' }]]])
  const proto: any = Yun139Driver.prototype, original = Object.fromEntries(['init', 'list', 'get', 'getDetails', 'studioEnsureDirectory', 'studioRelocate'].map(k => [k, proto[k]]))
  proto.init = async () => {}
  let cloudLists = 0, cloudGets = 0
  let quotaGets = 0
  proto.getDetails = async () => { quotaGets++; return { total_space: 20 * 1024 ** 3, used_space: 4 * 1024 ** 3 } }
  proto.list = async (_v: string, physical: string) => { cloudLists++; return structuredClone(cloud.get(physical) || []) }
  proto.get = async (_v: string, physical: string) => { cloudGets++; return { ...cloud.get(physical.slice(0, physical.lastIndexOf('/')) || '/')?.find(f => f.name === physical.split('/').at(-1)), raw_url: 'https://download.yun.139.com/fixture.png' } }
  proto.studioEnsureDirectory = async (path: string) => { if (!cloud.has(path)) cloud.set(path, []) }
  let moveFails = false
  proto.studioRelocate = async (source: string, destination: string, uid: string) => {
    if (moveFails) throw Error('unconfirmed cloud move')
    const src = cloud.get(source.slice(0, source.lastIndexOf('/')) || '/')!, dst = cloud.get(destination.slice(0, destination.lastIndexOf('/')) || '/')!
    const file = src.find(f => f.sign === uid); if (!file) throw Error('missing source')
    dst.push(file); src.splice(src.indexOf(file), 1)
  }
  const app = new Hono(); app.route('/', studioCatalogRouter)
  const token = await sign({ id: 2, username: 'member', exp: Math.floor(Date.now()/1000) + 600 }, env.JWT_SECRET)
  const reader = await sign({ id: 3, username: 'reader', exp: Math.floor(Date.now()/1000) + 600 }, env.JWT_SECRET)
  async function request(route: string, body: any = {}, auth: string | null = token, executionCtx?: any) {
    const r = await app.request('/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ path: '/', ...body }) }, env, executionCtx)
    return { status: r.status, json: await r.json() as any }
  }
  try {
    assert.equal((await request('list', {}, null)).status, 401)
    assert.equal((await request('clip', { id: 'anything' }, null)).status, 401)
    assert.equal((await request('folder', { action: 'create', folder: '素材预览缓存' })).status, 400)
    assert.equal((await request('folder', { action: 'create', folder: '禁止' }, reader)).status, 403)
    assert.equal((await request('list', { path: '/../' })).status, 400)
    const initial = await request('list'); assert.equal(initial.status, 200, initial.json.message)
    assert.equal(initial.json.data.space.source, 'cloud')
    assert.equal(initial.json.data.space.total, 20 * 1024 ** 3)
    assert.equal(initial.json.data.space.used, 4 * 1024 ** 3)
    const file = initial.json.data.assets[0]; assert.equal(file.name, '原图.png')
    assert.equal(initial.json.data.assets.length, 1, 'derived cloud cache files never appear as duplicate library assets')
    assert.ok(!initial.json.data.folders.includes('素材预览缓存'))
    assert.equal((await request('clip', { id: file.id }, reader)).status, 415, 'read-only users can request derivatives, but images are never converted by this video endpoint')
    assert.ok(file.added_ms > Date.parse('2026-10-02'), 'import records when the asset enters the library')
    assert.equal((await request('resolve', { id: file.id, preview: true }, null)).status, 401)
    const source = cloud.get('/旧文件夹')![0]
    source.thumb = 'https://download.yun.139.com/fresh-thumb.jpg'
    const thumb = await request('resolve', { id: file.id, preview: true }, reader)
    assert.equal(thumb.status, 200); assert.deepEqual(thumb.json.data, { preview_url: source.thumb })
    assert.equal(cloudGets, 0, 'thumbnail recovery never asks for an original download when a fresh thumb exists')
    source.thumb = ''
    assert.equal((await request('resolve', { id: file.id, preview: true }, reader)).json.data.preview_url, 'https://download.yun.139.com/fixture.png', 'small image without a thumbnail is viewable')
    assert.equal(cloudGets, 1)
    source.size = 8 * 1048576
    assert.equal((await request('resolve', { id: file.id, preview: true })).json.data.preview_url, '')
    assert.equal(cloudGets, 1, 'large image originals are never downloaded automatically')
    source.size = 600; source.sign = 'changed-file'
    assert.equal((await request('resolve', { id: file.id, preview: true })).status, 409, 'a file replaced at the same path is not exposed as the old asset')
    source.sign = 'file-1'
    assert.equal((await request('folder', { action: 'move', folder: '旧文件夹', next: '新文件夹' })).status, 200)
    assert.equal((await request('edit', { id: file.id, name: '新图.png', revision: file.revision })).status, 409)
    const refreshed = (await request('list')).json.data.assets[0]
    assert.equal(refreshed.folder, '新文件夹')
    assert.deepEqual((await request('list')).json.data.folders, ['新文件夹'])
    assert.equal((await request('edit', { id: file.id, name: '新图.png', revision: refreshed.revision })).status, 200)
    assert.equal(cloud.get('/旧文件夹')![0].name, '原图.png', 'virtual rename never alters source')
    moveFails = true
    assert.equal((await request('trash', { id: file.id })).status, 503)
    assert.equal(sql.prepare('SELECT deleted,pending_path FROM studio_assets').get()!.deleted, 0, 'cannot report trashed before cloud confirms')
    moveFails = false
    assert.equal((await request('trash', { id: file.id })).status, 200)
    assert.equal(cloud.get('/旧文件夹')!.length, 0)
    assert.equal(cloud.get('/被移除的文件/file-1')![0].sign, 'file-1')
    assert.equal((await request('resolve', { id: file.id })).status, 404)
    assert.equal((await request('resolve', { id: file.id, preview: true }, reader)).status, 404)
    assert.equal((await request('restore', { id: file.id })).status, 200)
    assert.equal(cloud.get('/旧文件夹')![0].sign, 'file-1')
    const final = (await request('list')).json.data.assets[0]
    assert.equal(final.added_ms, file.added_ms, 'rename, folder moves, trash and restore do not turn an old asset into a new arrival')
    assert.equal(final.id, file.id); assert.equal(final.name, '新图.png'); assert.equal(final.folder, '新文件夹'); assert.equal(final.deleted, 0)
    sql.prepare("UPDATE studio_catalog_locks SET until_ms=?").run(Date.now() + 10000)
    assert.equal((await request('edit', { id: file.id, name: '冲突.png' })).status, 409, 'two instances cannot overwrite organization concurrently')
    // Opening the site reads the saved catalog; it neither waits for the cloud nor collides with another member's lock.
    let before = cloudLists
    const busy = await request('list', { refresh: true })
    assert.equal(busy.status, 200, 'a refresh during someone else\'s inventory still shows the saved catalog')
    assert.equal(cloudLists, before)
    sql.prepare("UPDATE studio_catalog_locks SET until_ms=0").run()
    cloud.get('/旧文件夹')!.push({ name: '直接放进云盘.png', sign: 'file-2', is_dir: false, size: 10, modified: '2026-10-02', thumb: '' })
    assert.equal((await request('list')).json.data.assets.length, 1, 'a fresh catalog is served from D1 without listing the cloud')
    assert.equal(cloudLists, before)
    const refreshed2 = await request('list', { refresh: true })
    assert.ok(cloudLists > before, 'refresh inventories the cloud')
    assert.deepEqual(refreshed2.json.data.assets.map((a: any) => a.name).sort(), ['新图.png', '直接放进云盘.png'])
    cloud.get('/旧文件夹')!.splice(1, 1)
    sql.prepare("UPDATE studio_catalog_state SET synced_ms=?").run(Date.now() - 11 * 60 * 1000)
    const background: Promise<unknown>[] = []
    before = cloudLists
    const stale = await request('list', {}, token, { waitUntil: (p: Promise<unknown>) => background.push(p), passThroughOnException() {} })
    assert.equal(stale.json.data.syncing, true)
    assert.equal(stale.json.data.assets.length, 2, 'a stale catalog is answered first and inventoried after the response')
    await Promise.all(background)
    assert.ok(cloudLists > before)
    assert.deepEqual((await request('list')).json.data.assets.map((a: any) => a.name), ['新图.png'], 'files removed from the cloud drop out after the inventory')
    // The warehouse is flat storage: uploads keep their website folder and uploader; the cloud folder never becomes a website folder.
    cloud.set('/', [...cloud.get('/')!, { name: '仓库', sign: 'dir-warehouse', is_dir: true, size: 0, modified: '' }])
    const stored = warehouseName('片头 动画.mp4')
    assert.match(stored, /^片头 动画__[0-9a-f]{8}\.mp4$/)
    cloud.set('/仓库', [{ name: stored, sign: 'file-3', is_dir: false, size: 30, modified: '2026-10-02', thumb: '' }])
    await registerStudioUpload({ env }, { id: 2, username: 'member', base_path: '/素材' }, '/', { name: stored, sign: 'file-3', size: 30, modified: '2026-10-02', thumb: '' }, '项目/片头', '片头 动画.mp4', '/素材/仓库')
    cloud.get('/仓库')!.push({ name: '手机直接放的__0123abcd.png', sign: 'file-4', is_dir: false, size: 5, modified: '2026-10-02', thumb: '' })
    const warehouse = (await request('list', { refresh: true })).json.data
    assert.equal(warehouse.folders.includes('仓库'), false)
    const uploaded = warehouse.assets.find((a: any) => a.name === '片头 动画.mp4')
    assert.ok(uploaded.added_ms > Date.parse('2026-10-02'), 'upload stores library arrival time instead of the original file date')
    assert.equal(uploaded.folder, '项目/片头'); assert.equal(uploaded.uploader, 'member')
    assert.equal(warehouse.assets.find((a: any) => a.name === '手机直接放的.png').folder, '', 'cloud-app drops land at the root with their readable name')
    assert.equal((await request('resolve', { id: uploaded.id })).status, 200)
    const gets = cloudGets
    assert.equal((await request('resolve', { id: uploaded.id, preview: true }, reader)).json.data.preview_url, '')
    assert.equal(cloudGets, gets, 'videos without posters never auto-download their originals')
    // Batch moves are one D1 transaction; favorites follow the account, not the browser.
    const both = [uploaded.id, final.id]
    assert.equal((await request('move', { ids: both, folder: '不存在' })).status, 409)
    assert.equal((await request('move', { ids: both, folder: '项目' })).status, 200)
    assert.equal((await request('move', { ids: both, folder: '项目' }, reader)).status, 403)
    assert.deepEqual((await request('list')).json.data.assets.filter((a: any) => a.folder === '项目').map((a: any) => a.id).sort(), both.sort())
    assert.equal(cloud.get('/仓库')!.length, 2, 'moving between website folders never touches the cloud')
    // Manual order is shared, kept per folder, and dropped when a file changes folder.
    const order = (list: any) => list.json.data.assets.filter((a: any) => a.folder === '项目').sort((a: any, b: any) => a.sort_order - b.sort_order).map((a: any) => a.id)
    assert.equal((await request('order', { ids: [final.id, uploaded.id], folder: '项目' })).status, 200)
    assert.deepEqual(order(await request('list', {}, reader)), [final.id, uploaded.id], 'every member sees the same order')
    assert.equal((await request('order', { ids: [final.id, uploaded.id], folder: '项目' }, reader)).status, 403)
    assert.equal((await request('order', { ids: [final.id, uploaded.id], folder: '' })).status, 409, 'only files inside that folder can be ordered')
    assert.equal((await request('order', { ids: [uploaded.id, final.id], folder: '项目' })).status, 200)
    assert.deepEqual(order(await request('list')), [uploaded.id, final.id])
    assert.equal((await request('move', { ids: [final.id], folder: '项目' })).status, 200)
    assert.equal((await request('list')).json.data.assets.find((a: any) => a.id === final.id).sort_order, 1, 'staying in the same folder keeps the position')
    assert.equal((await request('move', { ids: [final.id], folder: '' })).status, 200)
    assert.equal((await request('list')).json.data.assets.find((a: any) => a.id === final.id).sort_order, null, 'a moved file starts fresh in its new folder')
    assert.equal((await request('move', { ids: [final.id], folder: '项目' })).status, 200)
    assert.equal((await request('favorite', { ids: [uploaded.id, 'ol-/伪造'], on: true })).status, 200)
    assert.deepEqual((await request('list')).json.data.favorites, [uploaded.id], 'only real assets can be favorited')
    assert.deepEqual((await request('list', {}, reader)).json.data.favorites, [], 'favorites are per member')
    assert.equal((await request('favorite', { ids: [uploaded.id], on: true }, reader)).status, 403, 'view-only members cannot favorite')
    assert.equal((await request('favorite', { ids: [uploaded.id], on: false })).status, 200)
    assert.deepEqual((await request('list')).json.data.favorites, [])
    const backup = await request('backup')
    assert.equal(backup.status, 200)
    assert.equal(backup.json.data.assets.find((a: any) => a.id === uploaded.id).cloud_path, '/仓库/' + stored)
    assert.equal((await request('backup', {}, reader)).status, 403)
    assert.equal(quotaGets, 1, 'all members, refreshes and folder edits share the same quota cache')
    // Slow quota reads never hold up a directory response. A competing member
    // serves the cache without starting a second cloud query.
    await request('trash', { id: uploaded.id })
    sql.prepare('UPDATE studio_storage_space SET total=0,used=0,updated_ms=0,next_check_ms=0').run()
    let finishQuota!: () => void
    const quotaGate = new Promise<void>(resolve => { finishQuota = resolve })
    proto.getDetails = async () => { quotaGets++; await quotaGate; return {} }
    const quotaBackground: Promise<unknown>[] = []
    const execution = { waitUntil: (p: Promise<unknown>) => quotaBackground.push(p), passThroughOnException() {} }
    const approximate = await request('list', {}, token, execution)
    assert.equal(approximate.status, 200)
    assert.equal(approximate.json.data.space.source, 'catalog')
    assert.equal(approximate.json.data.space.refreshing, true)
    assert.equal(approximate.json.data.space.used, 635, 'catalog fallback includes the 30-byte trashed original and excludes the missing file')
    await request('list', {}, reader, execution)
    assert.equal(quotaGets, 2, 'a D1 claim shares in-flight readings across members')
    finishQuota(); await Promise.all(quotaBackground)
    await request('list')
    assert.equal(quotaGets, 2, 'a failed quota read backs off rather than retrying on every list')
    const prepare = env.DB.prepare
    env.DB.prepare = (query: string) => {
      if (query.includes('studio_storage_space')) throw Error('quota database unavailable')
      return prepare(query)
    }
    const unaffected = await request('list')
    assert.equal(unaffected.status, 200, 'optional quota failures never hide the directory')
    assert.ok(unaffected.json.data.assets.length > 0)
    assert.equal(unaffected.json.data.space.source, 'catalog')
    env.DB.prepare = prepare
  } finally { Object.assign(proto, original); sql.close(); __resetDbCacheForTest() }
})
