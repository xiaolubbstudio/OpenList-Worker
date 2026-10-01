import test from "node:test"
import assert from "node:assert/strict"
import { validUploadPath, seal, open, studioUploadRouter } from "./studio-upload"
import { saveDb } from "../internal/model/db"

test("upload paths cannot escape the assigned member directory", () => {
  for (const path of ["/../", "/@s/other", "/%2e%2e/", "/%252e%252e/", "/.../", "/a\\b", "/a\n", "relative"]) assert.equal(validUploadPath(path), false)
  for (const path of ["/", "/动画", "/动画/背景"]) assert.equal(validUploadPath(path), true)
})
test("encrypted upload tickets survive instances and reject tampering and another key", async () => {
  const secret = "test-only-strong-key-never-used-in-production"
  const ticket = await seal({ env: { JWT_SECRET: secret } }, { user: 3, state: { name: "sample.mov" } })
  assert.equal(ticket.includes("sample.mov"), false)
  assert.equal((await open({ env: { JWT_SECRET: secret } }, ticket)).user, 3)
  await assert.rejects(open({ env: { JWT_SECRET: secret + "other" } }, ticket))
  await assert.rejects(open({ env: { JWT_SECRET: secret } }, "A" + ticket.slice(1)))
  await assert.rejects(seal({ env: {} }, {}))
})
test("all upload stages reject unauthenticated requests before reading file bytes", async () => {
  await saveDb({ users: [{ id: 1, username: "admin", role: 2, password: "test-only", permission: 0 }], settings: [], storages: [] }, {})
  for (const [route, method] of [["start", "POST"], ["part_link", "POST"], ["finish", "POST"]]) {
    const response = await studioUploadRouter.request("http://localhost/" + route, { method, body: "invalid" })
    assert.equal(response.status, 403)
  }
})
