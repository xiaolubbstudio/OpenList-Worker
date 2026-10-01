import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { userRouter } from "./user"
import { getDb, saveDb } from "../internal/model/db"
import { assertStudioMemberLimit } from "../internal/model/studio-members"

test("only enabled ordinary members consume seats; invalid limits fail closed", () => {
  const users = Array.from({ length: 5 }, (_, i) => ({ id: i + 3, username: `member${i}`, role: 0, disabled: false }))
  const env = { STUDIO_MEMBER_LIMIT: "5" }
  assertStudioMemberLimit([...users, { role: 2 }, { role: 1 }, { role: 0, disabled: true }], env)
  assert.throws(() => assertStudioMemberLimit([...users, { role: 0 }], env), /5/)
  assertStudioMemberLimit(users, {})
  assert.throws(() => assertStudioMemberLimit(users, { STUDIO_MEMBER_LIMIT: "invalid" }))
})

test("sixth member and re-enabling a sixth account are rejected; names are editable without consuming a seat", async () => {
  const env = { STUDIO_MEMBER_LIMIT: "5" }
  const members = Array.from({ length: 5 }, (_, i) => ({ id: i + 3, username: `member${i}`, role: 0, disabled: false }))
  await saveDb({ users: [{ id: 1, username: "admin", role: 2, password: "fixture-only" }, ...members, { id: 8, username: "disabled", role: 0, disabled: true }], settings: [], storages: [], shares: [] }, env, { force: true })
  const app = new Hono().route("/users", userRouter)
  const call = (route: string, body: any) => app.request("https://local.test/users/" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env)
  assert.equal((await call("create", { username: "sixth", password: "fixture-only", role: 0 })).status, 409)
  assert.equal((await call("update", { id: 8, disabled: false })).status, 409)
  assert.equal((await call("update", { id: 3, username: "小橙子" })).status, 200)
  const db = await getDb(env)
  assert.equal(db.users.find((user: any) => user.id === 3).username, "小橙子")
  assert.equal(db.users.filter((user: any) => user.role === 0 && !user.disabled).length, 5)
  await assert.rejects(saveDb({ ...db, users: [...db.users, { role: 0 }] }, env), /5/)
  assert.equal((await getDb(env)).users.length, 7)
})
