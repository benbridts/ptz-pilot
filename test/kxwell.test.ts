import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import * as kx from '../src/main/kxwell/link.js'
import { Camera, PROFILES, type CameraConfig } from '../src/main/visca/camera.js'
import { newCamera, sanitiseCamera } from '../src/main/settings.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('kxwell: the address is two upper-case hex digits', () => {
	assert.equal(kx.addressDigits(1), '01')
	assert.equal(kx.addressDigits(10), '0A')
	assert.equal(kx.addressDigits(255), 'FF')
	assert.equal(kx.message(171, 'O1'), '#ABO1')
})

test('kxwell: pan and tilt are separate, centred on 50', () => {
	assert.equal(kx.pan(1, 49, 49), '#01P99')
	assert.equal(kx.pan(1, -49, 49), '#01P01')
	assert.equal(kx.pan(1, 0, 49), '#01P50')
	// Tilt down is below 50
	assert.equal(kx.tilt(2, -3, 49), '#02T47')
	assert.equal(kx.tilt(2, 7, 49), '#02T57')
	// Never past the configured limit
	assert.equal(kx.pan(1, 40, 10), '#01P60')
})

test('kxwell: zoom and focus speeds are 1-based onto the 49 steps', () => {
	assert.equal(kx.zoom(1, 1, 48), '#01Z51')
	assert.equal(kx.zoom(1, -49, 48), '#01Z01')
	assert.equal(kx.zoom(1, 0, 48), '#01Z50')
	assert.equal(kx.focus(1, 9, 1), '#01F52')
})

test('kxwell: presets from 0, and what the heads can not do', () => {
	assert.equal(kx.commandMessage(1, { type: 'presetRecall', preset: 0 }), '#01R00')
	assert.equal(kx.commandMessage(3, { type: 'presetSet', preset: 99 }), '#03M99')
	assert.equal(typeof kx.commandMessage(1, { type: 'presetRecall', preset: 100 }), 'object')
	assert.equal(typeof kx.commandMessage(1, { type: 'home' }), 'object')
	assert.equal(typeof kx.commandMessage(1, { type: 'autoFocus', enabled: true }), 'object')
	assert.equal(typeof kx.commandMessage(1, { type: 'onePushFocus' }), 'object')
	assert.deepEqual(kx.commandMessage(1, { type: 'autoFocusToggle' }), { error: 'KXWell heads only focus by hand' })
})

test('kxwell: addresses up to 255 on both kinds, and the IP kind gets a port', () => {
	assert.equal(sanitiseCamera({ kind: 'kxwell-tcp', address: 200 }).address, 200)
	assert.equal(sanitiseCamera({ kind: 'kxwell-serial', address: 300 }).address, 255)
	// VISCA keeps its own limits
	assert.equal(sanitiseCamera({ kind: 'serial', address: 9 }).address, 7)
	assert.equal(sanitiseCamera({ kind: 'sony-udp', address: 5 }).address, 1)
	assert.equal(newCamera({ kind: 'kxwell-tcp' }).port, 23)
	assert.equal(newCamera({ kind: 'kxwell-serial' }).port, 0)
	assert.equal(newCamera({ kind: 'kxwell-tcp' }).profile, 'kxwell')
})

function cameraConfig(partial: Partial<CameraConfig>): CameraConfig {
	return {
		id: 'test',
		name: 'Test',
		kind: 'kxwell-tcp',
		host: '127.0.0.1',
		port: 0,
		serialPath: '',
		baudRate: 9600,
		address: 2,
		username: '',
		password: '',
		sendInterval: 10,
		profile: 'kxwell',
		...PROFILES.kxwell!,
		...partial,
	}
}

test('kxwell tcp: sets up the panel, moves, and stops everything on close', async () => {
	const chunks: Buffer[] = []
	let ended!: Promise<unknown>
	const server = net.createServer((socket) => {
		socket.on('data', (d) => chunks.push(d))
		ended = once(socket, 'end')
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const port = (server.address() as net.AddressInfo).port

	const camera = new Camera(cameraConfig({ port }))
	camera.open()
	await sleep(50)
	camera.setMotion({ pan: 49, tilt: -1, zoom: 0, focus: 0 })
	await sleep(50)
	camera.command({ type: 'home' })
	await sleep(30)
	assert.match(camera.status.error ?? '', /no home/)
	camera.command({ type: 'presetRecall', preset: 4 })
	await sleep(30)
	assert.equal(camera.status.error, undefined, 'the next send clears the refusal')
	await camera.close()
	await ended
	server.close()

	const lines = Buffer.concat(chunks).toString('ascii').split('\r')
	assert.deepEqual(lines.slice(0, 2), ['#01D61', '#02O1'])
	// Idle check-ins repeat the IP setup; pan and tilt still go together
	const moves = lines.slice(2).filter((l) => l !== kx.IP_MODE)
	assert.deepEqual(moves.slice(0, 2), ['#02P99', '#02T49'])
	assert.ok(lines.includes('#02R04'))
	// The close stops every axis, last
	assert.deepEqual(lines.slice(-5), ['#02P50', '#02T50', '#02Z50', '#02F50', ''])
})

test('kxwell: autoFocusToggle is refused, sends no wire message, and AF stays unknown', async () => {
	const chunks: Buffer[] = []
	let ended!: Promise<unknown>
	const server = net.createServer((socket) => {
		socket.on('data', (d) => chunks.push(d))
		ended = once(socket, 'end')
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const port = (server.address() as net.AddressInfo).port

	const camera = new Camera(cameraConfig({ port }))
	camera.open()
	await sleep(50)
	const before = Buffer.concat(chunks).toString('ascii')
	camera.command({ type: 'autoFocusToggle' })
	await sleep(30)
	assert.match(camera.status.error ?? '', /only focus by hand/)
	assert.equal(camera.status.autoFocus, 'unknown', 'AF never leaves unknown on KXWell')
	// No focus/AF command reached the wire
	const after = Buffer.concat(chunks).toString('ascii')
	assert.equal(after, before, 'the refusal put nothing on the wire')
	await camera.close()
	await ended
	server.close()
})
