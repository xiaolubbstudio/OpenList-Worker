const ready = new WeakMap<object, Promise<unknown>>()

async function table(db: any) {
  let pending = ready.get(db)
  if (!pending) {
    pending = db.prepare('CREATE TABLE IF NOT EXISTS studio_revoked_tokens (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)').run()
    ready.set(db, pending)
    pending.catch(() => ready.delete(db))
  }
  await pending
}

export async function revokeD1Token(db: any, jti: string, exp: number) {
  await table(db)
  await db.batch([
    db.prepare('INSERT OR REPLACE INTO studio_revoked_tokens (jti, expires_at) VALUES (?, ?)').bind(jti, exp),
    db.prepare('DELETE FROM studio_revoked_tokens WHERE expires_at <= ?').bind(Math.floor(Date.now() / 1000)),
  ])
}

export async function isD1TokenRevoked(db: any, jti: string) {
  await table(db)
  // Read D1 on every verification; other Worker instances may have logged out this session.
  const row = await db.prepare('SELECT jti FROM studio_revoked_tokens WHERE jti = ? AND expires_at > ?')
    .bind(jti, Math.floor(Date.now() / 1000)).first()
  return !!row
}
