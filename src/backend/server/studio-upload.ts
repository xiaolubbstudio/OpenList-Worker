import { Hono } from "hono"
import { getUserFromContext } from "./middlewares"
import { canWrite, getActualPath } from "../pkg/permission"
import { resolvePath } from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import { Yun139Driver } from "../drivers/139/driver"
import { getNearestMeta, canAccess, canWrite as canWriteMeta } from "../pkg/meta"
import { validFolder, validName, registerStudioUpload } from "./studio-catalog"

// Stateless encrypted tickets survive Worker restarts. Tickets carry no cloud credentials.
export const studioUploadRouter = new Hono()
const maxFile = 512 * 1024 * 1024
export function validUploadPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("/@") &&
    !/[\\%\u0000-\u001f]/.test(value) && !value.split("/").some(p => /^\.+$/.test(p))
}
async function key(c: any) {
  const secret = c.env?.JWT_SECRET
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Upload encryption unavailable")
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("studio-upload-v1:" + secret))
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"])
}
export async function seal(c: any, data: any) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(c), new TextEncoder().encode(JSON.stringify(data))))
  return btoa(String.fromCharCode(...iv, ...bytes))
}
export async function open(c: any, ticket: unknown) {
  if (typeof ticket !== "string" || ticket.length > 8192) throw new Error("Invalid ticket")
  const bytes = Uint8Array.from(atob(ticket), s => s.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await key(c), bytes.slice(12))))
}
async function target(user: any, path: string) {
  const actual = getActualPath(user, path)
  const meta = await getNearestMeta(actual)
  if (!canAccess(user, meta, actual, "") || !canWriteMeta(user, meta, actual)) throw new Error("Directory permission denied")
  const resolved = await resolvePath(actual)
  if (resolved.isVirtual || resolved.storage?.driver !== "139Yun") throw new Error("Unsupported storage")
  const driver = await getDriver(resolved.storage.driver, resolved.storage)
  if (!(driver instanceof Yun139Driver)) throw new Error("Unsupported driver")
  return { actual, resolved, driver }
}
const denied = (c: any) => c.json({ code: 403, message: "Upload permission required", data: null }, 403)
const failed = (c: any) => c.json({ code: 400, message: "Upload failed; check permissions, folder and file", data: null }, 400)
studioUploadRouter.post("/start", async c => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return denied(c)
  try {
    const { path, name, size, sha256, virtual_folder } = await c.req.json()
    if (!validUploadPath(path) || typeof name !== "string" || !name || name.length > 255 || /[\\/\u0000-\u001f]/.test(name) || [".", ".."].includes(name) ||
        !Number.isSafeInteger(size) || size < 1 || size > maxFile || !/^[a-f0-9]{64}$/i.test(sha256)) return failed(c)
    const { actual, resolved, driver } = await target(user, path)
    if (virtual_folder !== undefined && (!validFolder(virtual_folder) || !validName(name))) return failed(c)
    // Check the encryption key before creating anything upstream.
    await key(c)
    const storedName = virtual_folder === undefined ? name : crypto.randomUUID() + (name.includes('.') ? '.' + name.split('.').at(-1) : '')
    const state = await driver.beginStudioUpload(resolved.physical!, storedName, size, sha256)
    const ticket = await seal(c, { state, path, actual, storage: resolved.storage!.id,
      user: user.id, username: user.username, virtualFolder: virtual_folder, displayName: name, expires: Date.now() + 4 * 3600000 })
    return c.json({ code: 200, message: "success", data: { ticket, chunkSize: state.chunkSize, name: state.name, ready: state.ready } })
  } catch { return failed(c) }
})
async function validate(c: any, user: any, ticket: unknown) {
  const data = await open(c, ticket)
  if (data.user !== user.id || data.username !== user.username || data.expires < Date.now() || !validUploadPath(data.path)) throw new Error("Invalid ticket owner")
  const resolved = await target(user, data.path)
  if (resolved.actual !== data.actual || resolved.resolved.storage!.id !== data.storage) throw new Error("Upload destination changed")
  await resolved.driver.checkStudioDestination(resolved.resolved.physical!, data.state)
  return { ...resolved, state: data.state, data }
}
studioUploadRouter.post("/part_link", async c => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return denied(c)
  try {
    const { ticket, part } = await c.req.json()
    const { driver, state } = await validate(c, user, ticket)
    if (state.ready || !Number.isInteger(part) || part < 1 || part > Math.ceil(state.size / state.chunkSize)) return failed(c)
    // This URL authorizes one file part only; never send the cloud account credential.
    return c.json({ code: 200, message: "success", data: { url: await driver.studioPartLink(state, part) } })
  } catch { return failed(c) }
})
studioUploadRouter.post("/finish", async c => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return denied(c)
  try {
    const { ticket } = await c.req.json()
    const { driver, state, data } = await validate(c, user, ticket)
    const file = await driver.finishStudioUpload(state)
    if (data.virtualFolder !== undefined) {
      const item = await driver.get(data.actual + '/' + file.name, (await target(user, data.path)).resolved.physical!.replace(/\/$/, '') + '/' + file.name)
      await registerStudioUpload(c, user, data.path, item, data.virtualFolder, data.displayName)
      return c.json({ code: 200, message: "success", data: { name: data.displayName, size: file.size } })
    }
    return c.json({ code: 200, message: "success", data: file })
  } catch { return failed(c) }
})
