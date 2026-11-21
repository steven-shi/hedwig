import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import PuppetNeo from 'wechaty-puppet-neo'
import { types } from 'wechaty-puppet'
import type { Session } from '../src/native.js'

test('group text keeps room, actual sender and native mentions; room send passes mention IDs', async () => {
  const sends: unknown[] = []
  let synced = false
  const puppet = new class extends PuppetNeo {
    protected override scanCode() { return 'fixture-qr' }
    protected override createSession(): Session {
      return {
        async startLogin() { return { png: 'fixture' } },
        async pollLogin() { return { status: 'completed', username: 'bot' } },
        async heartbeat() { return { sync: false, intervalMs: 5000 } },
        async pollIncoming() { await delay(10); return false },
        async sync() {
          if (synced) return { messages: [], continuation: false }
          synced = true
          return { continuation: false, messages: [{
            id: 'group-msg', from: 'alice', to: 'bot', text: '@Bot hi', timestamp: 1700000000,
            roomId: 'room@chatroom', mentions: ['bot'], senderName: 'Alice',
          }, {
            id: 'group-image', from: 'alice', to: 'bot', text: '', timestamp: 1700000000,
            roomId: 'room@chatroom', mentions: [], senderName: 'Alice', image: true,
          }] }
        },
        async sendText(destination, text, mentions) { sends.push([destination, text, mentions]); return { status: 'accepted' } },
        async downloadImage(id) {
          assert.equal(id, 'group-image')
          return { mimeType: 'image/png', base64: 'fixture-bytes' }
        },
        async lookupSelf() { return { nickname: 'Bot', alias: null, avatar: null } },
        async logout() { return { accepted: true } },
        async close() {},
      }
    }
  }()
  const ids: string[] = []
  puppet.on('error', () => {})
  puppet.on('message', payload => { ids.push(payload.messageId) })
  await puppet.start()
  try {
    const deadline = Date.now() + 5000
    while (ids.length < 2 && Date.now() < deadline) await delay(10)
    assert.deepEqual(ids, ['group-msg', 'group-image'])
    const message = await puppet.messagePayload(ids[0]!)
    assert.equal(message.type, types.Message.Text)
    assert.equal(message.talkerId, 'alice'); assert.equal(message.roomId, 'room@chatroom')
    assert.deepEqual('mentionIdList' in message ? message.mentionIdList : undefined, ['bot'])
    const image = await puppet.messagePayload(ids[1]!)
    assert.equal(image.type, types.Message.Image)
    assert.equal(image.roomId, 'room@chatroom')
    assert.deepEqual(await puppet.downloadImage(ids[1]!), { mimeType: 'image/png', base64: 'fixture-bytes' })
    await assert.rejects(puppet.downloadImage(ids[0]!), /unavailable/)
    await puppet.messageSendText('room@chatroom', '@Alice\u2005hello', ['alice'])
    assert.deepEqual(sends, [['room@chatroom', '@Alice\u2005hello', ['alice']]])
    await assert.rejects(puppet.messageSendText('unknown@chatroom', 'x', ['alice']), /observed/)
    await assert.rejects(puppet.messageSendText('alice', 'x', ['alice']), /direct/)
  } finally { await puppet.stop() }
})
