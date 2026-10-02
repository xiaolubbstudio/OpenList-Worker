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
  const cloud = new Map<string, any[]>([['/', [{ name: '旧文件夹', sign: 'dir-1', is_dir: true, size: 0, modified: '' }]], ['/旧文件夹', [{ name: '原图.png', sign: 'file-1', is_dir: false, size: 600, modified: '2026-10-02', thumb: '' }]]])
  const proto: any = Yun139Driver.prototype, original = Object.fromEntries(['init', 'list', 'get', 'studioEnsureDirectory', 'studioRelocate'].map(k => [k, proto[k]]))
  proto.init = async () => {}
  let cloudLists = 0
  proto.list = async (_v: string, physical: string) => { cloudLists++; return structuredClone(cloud.get(physical) || []) }
  proto.get = async (_v: string, physical: string) => ({ ...cloud.get(physical.slice(0, physical.lastIndexOf('/')) || '/')?.find(f => f.name === physical.split('/').at(-1)), raw_url: 'https://download.yun.139.com/fixture.png' })
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
    assert.equal((await request('folder', { action: 'create', folder: '禁止' }, reader)).status, 403)
    assert.equal((await request('list', { path: '/../' })).status, 400)
    const initial = await request('list'); assert.equal(initial.status, 200, initial.json.message)
    const file = initial.json.data.assets[0]; assert.equal(file.name, '原图.png')
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
    assert.equal((await request('restore', { id: file.id })).status, 200)
    assert.equal(cloud.get('/旧文件夹')![0].sign, 'file-1')
    const final = (await request('list')).json.data.assets[0]
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
    assert.equal(uploaded.folder, '项目/片头'); assert.equal(uploaded.uploader, 'member')
    assert.equal(warehouse.assets.find((a: any) => a.name === '手机直接放的.png').folder, '', 'cloud-app drops land at the root with their readable name')
    assert.equal((await request('resolve', { id: uploaded.id })).status, 200)
    // Batch moves are one D1 transaction; favorites follow the account, not the browser.
    const both = [uploaded.id, final.id]
    assert.equal((await request('move', { ids: both, folder: '不存在' })).status, 409)
    assert.equal((await request('move', { ids: both, folder: '项目' })).status, 200)
    assert.equal((await request('move', { ids: both, folder: '项目' }, reader)).status, 403)
    assert.deepEqual((await request('list')).json.data.assets.filter((a: any) => a.folder === '项目').map((a: any) => a.id).sort(), both.sort())
    assert.equal(cloud.get('/仓库')!.length, 2, 'moving between website folders never touches the cloud')
    assert.equal((await request('favorite', { ids: [uploaded.id, 'ol-/伪造'], on: true })).status, 200)
    assert.deepEqual((await request('list')).json.data.favorites, [uploaded.id], 'only real assets can be favorited')
    assert.deepEqual((await request('list', {}, reader)).json.data.favorites, [], 'favorites are per member')
    assert.equal((await request('favorite', { ids: [uploaded.id], on: false })).status, 200)
    assert.deepEqual((await request('list')).json.data.favorites, [])
    const backup = await request('backup')
    assert.equal(backup.status, 200)
    assert.equal(backup.json.data.assets.find((a: any) => a.id === uploaded.id).cloud_path, '/仓库/' + stored)
    assert.equal((await request('backup', {}, reader)).status, 403)
  } finally { Object.assign(proto, original); sql.close(); __resetDbCacheForTest() }
})
