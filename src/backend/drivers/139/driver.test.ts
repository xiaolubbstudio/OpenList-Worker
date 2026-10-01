import test from "node:test"
import assert from "node:assert/strict"
import { Yun139Driver } from "./driver"
import { Yun139Addition } from "./types"
import { calSign } from "./util"

test('139 real relocation verifies destination, refuses overwrite, and retries without a second move', async () => {
  const driver = new Yun139Driver({ type: 'personal_new', authorization: 'fixture' } as any)
  const cloud: any = { '/': { folders: [{ catalogID: 'trash', catalogName: '被移除的文件' }], files: [{ contentID: 'one', contentName: 'one.png' }] }, trash: { folders: [], files: [] } }
  const client = (driver as any).client; let calls = 0
  client.listFiles = async (id: string) => structuredClone(cloud[id])
  client.request = async (route: string, body: any) => { assert.equal(route, '/file/batchMove'); assert.deepEqual(body, { fileIds: ['one'], toParentFileId: 'trash' }); calls++; cloud.trash.files.push(cloud['/'].files.pop()); return { success: true } }
  await driver.studioRelocate('/one.png', '/被移除的文件/one.png', 'one')
  await driver.studioRelocate('/one.png', '/被移除的文件/one.png', 'one')
  assert.equal(calls, 1)
  cloud.trash.files[0].contentID = 'other'
  await assert.rejects(driver.studioRelocate('/one.png', '/被移除的文件/one.png', 'one'), /conflict/)
  assert.equal(calls, 1)
})

test("Yun139 calculation and signing", () => {
  const sign = calSign("{}", "2026-08-24 16:00:00", "1234567890abcdef")
  assert.ok(sign)
  assert.equal(typeof sign, "string")
  assert.equal(sign.length, 32)
})

test("Yun139Driver instantiation and methods", async () => {
  const addition: Yun139Addition = {
    authorization: Buffer.from(
      "Basic:13800138000:token123|1|1|1780000000000",
    ).toString("base64"),
    type: "personal_new",
  }

  const driver = new Yun139Driver(addition)
  assert.ok(driver)

  // Mock listFiles
  ;(driver as any).client.listFiles = async (catalogId: string) => {
    return {
      folders: [
        {
          catalogID: "cat_101",
          catalogName: "photos",
          updateTime: "2026-08-24T12:00:00Z",
        },
      ],
      files: [
        {
          contentID: "cnt_201",
          contentName: "photo.jpg",
          contentSize: 500000,
          updateTime: "2026-08-24T12:00:00Z",
        },
      ],
    }
  }

  const items = await driver.list("/", "/")
  assert.equal(items.length, 2)
  assert.equal(items[0].name, "photos")
  assert.equal(items[0].is_dir, true)
  assert.equal(items[1].name, "photo.jpg")
  assert.equal(items[1].is_dir, false)
  assert.equal(items[1].size, 500000)

  // Mock getDownloadUrl
  ;(driver as any).client.getDownloadUrl = async (contentId: string) =>
    "https://download.yun.139.com/photo.jpg"

  const link = await driver.link("/photo.jpg", "/photo.jpg")
  assert.equal(link.url, "https://download.yun.139.com/photo.jpg")
})
