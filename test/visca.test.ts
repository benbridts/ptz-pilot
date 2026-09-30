import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import net from 'node:net'
import { once } from 'node:events'
import * as cmd from '../src/main/visca/commands.js'
import { parseReply, ViscaStreamSplitter } from '../src/main/visca/replies.js'
import { sonyHeader } from '../src/main/visca/transports.js'
import { Camera, PROFILES, type CameraConfig } from '../src/main/visca/camera.js'

const hex = (b: Buffer) => b.toString('hex').replace(/(..)(?!$)/g, '$1 ')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('pan-tilt encodes direction and speed', () => {
	assert.equal(hex(cmd.panTilt(1, 5, -3, 0x18, 0x14)), '81 01 06 01 05 03 02 02 ff')
	assert.equal(hex(cmd.panTilt(1, -24, 0, 0x18, 0x14)), '81 01 06 01 18 01 01 03 ff')
	// Clamped to the camera's range
	assert.equal(hex(cmd.panTilt(1, 99, 99, 0x18, 0x14)), '81 01 06 01 18 14 02 01 ff')
	assert.equal(hex(cmd.panTiltStop(3)), '83 01 06 01 01 01 03 03 ff')
})

test('zoom and focus use 1-based speeds onto 0-7', () => {
	assert.equal(hex(cmd.zoom(1, 1)), '81 01 04 07 20 ff')
	assert.equal(hex(cmd.zoom(1, 8)), '81 01 04 07 27 ff')
	assert.equal(hex(cmd.zoom(1, -4)), '81 01 04 07 33 ff')
	assert.equal(hex(cmd.zoom(1, 0)), '81 01 04 07 00 ff')
	assert.equal(hex(cmd.focus(1, -1)), '81 01 04 08 30 ff')
})

test('presets and misc', () => {
	assert.equal(hex(cmd.presetRecall(1, 5)), '81 01 04 3f 02 05 ff')
	assert.equal(hex(cmd.presetSet(2, 0)), '82 01 04 3f 01 00 ff')
	assert.equal(hex(cmd.home(1)), '81 01 06 04 ff')
	assert.throws(() => cmd.home(8))
	assert.throws(() => cmd.presetRecall(1, 256))
})

test('replies parse', () => {
	assert.deepEqual(parseReply(Buffer.from('9041ff', 'hex')), { kind: 'ack', address: 1, socket: 1 })
	const err = parseReply(Buffer.from('906103ff', 'hex'))
	assert.equal(err.kind, 'error')
	assert.equal(err.kind === 'error' && err.message, 'Command buffer full')
	const completion = parseReply(Buffer.from('a051ff', 'hex'))
	assert.equal(completion.kind === 'completion' && completion.address, 2)
})

test('stream splitter handles split and merged replies', () => {
	const s = new ViscaStreamSplitter()
	assert.deepEqual(s.push(Buffer.from('9041', 'hex')), [])
	assert.deepEqual(s.push(Buffer.from('ff9051ff', 'hex')).map(hex), ['90 41 ff', '90 51 ff'])
})

test('sony header', () => {
	assert.equal(hex(sonyHeader(0x0100, cmd.home(1), 0x01020304)), '01 00 00 05 01 02 03 04 81 01 06 04 ff')
})

function cameraConfig(partial: Partial<CameraConfig>): CameraConfig {
	return {
		id: 'test',
		name: 'Test',
		kind: 'sony-udp',
		host: '127.0.0.1',
		port: 0,
		serialPath: '',
		baudRate: 9600,
		address: 1,
		sendInterval: 10,
		profile: 'sony',
		...PROFILES.sony,
		...partial,
	}
}

test('sony udp: resets sequence, sends latest motion, repeats stops, refreshes', async () => {
	const server = dgram.createSocket('udp4')
	server.bind(0, '127.0.0.1')
	await once(server, 'listening')
	const received: { at: number; data: Buffer }[] = []
	server.on('message', (data, rinfo) => {
		received.push({ at: Date.now(), data })
		// Answer commands with an ack, like a camera would
		if (data.readUInt16BE(0) === 0x0100)
			server.send(sonyHeader(0x0111, Buffer.from('9041ff', 'hex'), data.readUInt32BE(4)), rinfo.port, rinfo.address)
	})

	const camera = new Camera(cameraConfig({ port: server.address().port }))
	camera.open()
	await sleep(30)

	// A burst of changes within one interval: only the last should go out
	camera.setMotion({ pan: 3, tilt: 0, zoom: 0, focus: 0 })
	camera.setMotion({ pan: 5, tilt: 2, zoom: 0, focus: 0 })
	await sleep(600)
	camera.stop()
	await sleep(60)

	assert.ok(camera.status.lastReplyAt, 'camera saw a reply')
	await camera.close()
	server.close()

	const packets = received.map((r) => hex(r.data))
	assert.equal(packets[0], '02 00 00 01 00 00 00 00 01', 'first packet resets the sequence number')

	const moves = received.filter((r) => r.data.readUInt16BE(0) === 0x0100).map((r) => hex(r.data.subarray(8)))
	assert.equal(moves[0], '81 01 06 01 05 02 02 01 ff', 'coalesced to the latest motion')
	assert.ok(moves.filter((m) => m === '81 01 06 01 05 02 02 01 ff').length >= 2, 'refreshed while held')
	const stops = moves.filter((m) => m === '81 01 06 01 01 01 03 03 ff')
	assert.ok(stops.length >= 2, `stop sent at least twice (got ${stops.length})`)

	// Sequence numbers increase by one
	const seqs = received.filter((r) => r.data.readUInt16BE(0) === 0x0100).map((r) => r.data.readUInt32BE(4))
	seqs.forEach((s, i) => i && assert.equal(s, seqs[i - 1] + 1))
})

test('tcp: bare VISCA, no header', async () => {
	const chunks: Buffer[] = []
	const server = net.createServer((socket) => socket.on('data', (d) => chunks.push(d)))
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const port = (server.address() as net.AddressInfo).port

	const camera = new Camera(cameraConfig({ kind: 'tcp', port }))
	camera.open()
	await sleep(50)
	camera.setMotion({ pan: 0, tilt: 0, zoom: 3, focus: 0 })
	await sleep(50)
	await camera.close()
	server.close()

	const stream = hex(Buffer.concat(chunks))
	// An idle check-in may go first; the zoom must follow, bare, with no header
	assert.match(stream, /^(81 09 04 00 ff )?81 01 04 07 22 ff/)
})

test('sony udp: replies sent to port 52381 rather than the source port are received', async (t) => {
	// Needs 52381 free on this machine, which a running copy of the app would hold
	const probe = dgram.createSocket('udp4')
	const free = await new Promise<boolean>((resolve) => {
		probe.once('error', () => resolve(false))
		probe.bind(52381, () => resolve(true))
	})
	probe.close()
	if (!free) return t.skip('port 52381 is in use')

	const server = dgram.createSocket('udp4')
	server.bind(0, '127.0.0.1')
	await once(server, 'listening')
	server.on('message', (data) => {
		// Like the real camera: always answer to 52381, whatever port the command came from
		server.send(sonyHeader(0x0111, Buffer.from('9041ff', 'hex'), data.readUInt32BE(4)), 52381, '127.0.0.1')
	})

	const camera = new Camera(cameraConfig({ port: server.address().port }))
	camera.open()
	await sleep(100)
	const replied = camera.status.lastReplyAt !== undefined
	await camera.close()
	server.close()
	assert.ok(replied, 'reply to 52381 reached the camera')
})
