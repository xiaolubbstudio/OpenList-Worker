import assert from 'node:assert/strict'
import test from 'node:test'
import { revokeToken, isTokenRevoked } from './middlewares'

function binding(rows: Map<string, number>) {
  return {
    prepare(sql: string) {
      let args: any[] = []
      const statement = {
        bind(...values: any[]) { args = values; return statement },
        async run() {
          if (sql.startsWith('INSERT')) rows.set(args[0], args[1])
          if (sql.startsWith('DELETE')) for (const [key, exp] of rows) if (exp <= args[0]) rows.delete(key)
          return {success:true}
        },
        async first() { return (rows.get(args[0]) || 0) > args[1] ? {jti:args[0]} : null },
      }
      return statement
    },
    async batch(statements: any[]) { return Promise.all(statements.map(s=>s.run())) },
  }
}

test('D1 logout is visible to another instance without invalidating other sessions', async () => {
  const rows = new Map<string, number>()
  const first = {DB_DRIVER:'d1',DB:binding(rows)}
  const second = {DB_DRIVER:'d1',DB:binding(rows)}
  assert.equal(await isTokenRevoked('session-a', second), false)
  await revokeToken('session-a', Math.floor(Date.now()/1000)+600, first)
  assert.equal(await isTokenRevoked('session-a', second), true)
  assert.equal(await isTokenRevoked('session-b', second), false)
  const third = {DB_DRIVER:'d1',DB:binding(rows)}
  assert.equal(await isTokenRevoked('session-a', third), true)
})

test('D1 revocation does not silently fall back to memory during a database outage', async () => {
  const env = {DB_DRIVER:'d1',DB:{prepare(){return{async run(){throw Error('Database unavailable')}}}}}
  await assert.rejects(isTokenRevoked('session-c', env), /Database unavailable/)
  await assert.rejects(revokeToken('session-c', Math.floor(Date.now()/1000)+600, env), /Database unavailable/)
})
