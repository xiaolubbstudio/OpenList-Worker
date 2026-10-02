import test from 'node:test'
import assert from 'node:assert/strict'
import { presenceState, summarize, handleStudioPresence, PRESENCE_PATH } from './studio-presence'

test('presence keeps only what the page may report and merges each member across devices', () => {
  const base = { name: 'angel_ni', since: 1 }
  const clean = presenceState(base, { t: 'state', visible: true, folder: 'x'.repeat(300), action: 'delete-everything', detail: 'nope' }, 50)
  assert.equal(clean.folder.length, 200)
  assert.equal(clean.action, '', 'unknown actions are dropped')
  assert.equal(clean.detail, '')
  assert.equal(clean.at, 0)
  const uploading = presenceState(base, { visible: false, folder: '表情包', action: 'upload', detail: '3/10 and a very long tail text' }, 80)
  assert.deepEqual([uploading.visible, uploading.action, uploading.detail.length, uploading.at], [false, 'upload', 24, 80])

  const room = summarize([
    { name: 'Afica', since: 30, visible: false, folder: '开场', action: '', detail: '', at: 0 },
    { name: 'angel_ni', since: 20, visible: false, folder: '旧', action: 'organize', detail: '', at: 100 },
    { name: 'angel_ni', since: 10, visible: true, folder: '表情包', action: 'upload', detail: '1/2', at: 200 },
  ], 300)
  assert.equal(room.t, 'presence')
  assert.deepEqual(room.members.map((m: any) => m.name), ['angel_ni', 'Afica'], 'one row per member, earliest first')
  assert.deepEqual([room.members[0].visible, room.members[0].action, room.members[0].detail, room.members[0].folder], [true, 'upload', '1/2', '表情包'])
  assert.deepEqual([room.members[1].visible, room.members[1].folder], [false, '开场'])
})

test('presence handshake refuses plain requests, foreign sites and other protocols before touching the room', async () => {
  const env = { ALLOW_URLS: 'https://xiaolubbstudio.github.io' }
  const url = 'https://library.example' + PRESENCE_PATH
  assert.equal((await handleStudioPresence(new Request(url), env)).status, 426)
  const ws = (headers: Record<string, string>) => new Request(url, { headers: { Upgrade: 'websocket', ...headers } })
  assert.equal((await handleStudioPresence(ws({ Origin: 'https://evil.example', 'Sec-WebSocket-Protocol': 'studio-presence, t' }), env)).status, 403)
  assert.equal((await handleStudioPresence(ws({ Origin: 'https://xiaolubbstudio.github.io', 'Sec-WebSocket-Protocol': 'chat' }), env)).status, 400)
})
