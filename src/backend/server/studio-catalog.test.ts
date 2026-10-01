import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { studioCatalogRouter } from './studio-catalog'
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
  proto.list = async (_v: string, physical: string) => structuredClone(cloud.get(physical) || [])
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
  async function request(route: string, body: any = {}, auth: string | null = token) {
    const r = await app.request('/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ path: '/', ...body }) }, env)
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
  } finally { Object.assign(proto, original); sql.close(); __resetDbCacheForTest() }
})
