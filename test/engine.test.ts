import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Engine } from '../src/main/engine.js'
import { SettingsStore, newCamera } from '../src/main/settings.js'
import { GAMEPAD_AXES, GAMEPAD_BUTTONS } from '../src/main/controllers/gamepad.js'
import type { ControllerInfo, ControllerSource, ControllerSourceEvents } from '../src/main/controllers/types.js'

const hex = (b: Buffer) => b.toString('hex').replace(/(..)(?!$)/g, '$1 ')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeSource extends EventEmitter<ControllerSourceEvents> implements ControllerSource {
	start(): void {}
	async stop(): Promise<void> {}
}

const pad = (id: string): ControllerInfo => ({
	id,
	kind: 'gamepad',
	name: id,
	axes: GAMEPAD_AXES,
	buttons: GAMEPAD_BUTTONS,
})

/** A bare-VISCA UDP camera that records the pan-tilt commands it gets */
async function fakeCamera() {
	const socket = dgram.createSocket('udp4')
	socket.bind(0, '127.0.0.1')
	await once(socket, 'listening')
	const panTilts: string[] = []
	socket.on('message', (data) => {
		if (data[1] === 0x01 && data[2] === 0x06 && data[3] === 0x01) panTilts.push(hex(data))
	})
	return { port: socket.address().port, panTilts, close: () => socket.close() }
}

test('engine: two controllers share a camera; a button moves one to the next camera', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'ptz-pilot-test-'))
	const camA = await fakeCamera()
	const camB = await fakeCamera()
	const store = new SettingsStore(dir)
	const a = newCamera({ name: 'A', kind: 'udp', host: '127.0.0.1', port: camA.port, sendInterval: 5 })
	const b = newCamera({ name: 'B', kind: 'udp', host: '127.0.0.1', port: camB.port, sendInterval: 5 })
	store.update((s) => {
		s.cameras = [a, b]
		s.activeCameraId = a.id
	})

	const source = new FakeSource()
	const engine = new Engine(store, [source])
	engine.start()

	// Both pads start on the camera the window shows: A
	source.emit('connected', pad('pad-1'))
	source.emit('connected', pad('pad-2'))
	assert.deepEqual(
		engine.settings.controllers.map((c) => c.cameraId),
		[a.id, a.id],
	)

	// One pans gently right, the other hard left: the harder push wins
	source.emit('input', 'pad-1', { axes: { leftX: 0.3 }, buttons: {} })
	source.emit('input', 'pad-2', { axes: { leftX: -1 }, buttons: {} })
	await sleep(40)
	assert.equal(camA.panTilts.at(-1), '81 01 06 01 18 01 01 03 ff', 'A pans left at full speed')

	// pad-2 presses the right bumper (next camera) while still holding left
	source.emit('input', 'pad-2', { axes: { leftX: -1 }, buttons: { rb: true } })
	await sleep(40)
	assert.equal(engine.settings.controllers.find((c) => c.id === 'pad-2')?.cameraId, b.id)
	assert.equal(camB.panTilts.at(-1), '81 01 06 01 18 01 01 03 ff', 'B now pans left')
	assert.match(camA.panTilts.at(-1)!, /^81 01 06 01 .. 01 02 03 ff$/, 'A is back to pad-1 alone: gently right')

	// pad-1 goes quiet: A must stop, without waiting for a disconnect
	source.emit('lost', 'pad-1')
	await sleep(40)
	assert.equal(camA.panTilts.at(-1), '81 01 06 01 01 01 03 03 ff', 'A stopped')

	await engine.stop()
	camA.close()
	camB.close()
	rmSync(dir, { recursive: true, force: true })
})

test('engine: a preset fired from a controller button is announced for the window to show', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'ptz-pilot-test-'))
	const cam = await fakeCamera()
	const store = new SettingsStore(dir)
	const a = newCamera({ name: 'A', kind: 'udp', host: '127.0.0.1', port: cam.port, sendInterval: 5 })
	store.update((s) => {
		s.cameras = [a]
		s.activeCameraId = a.id
	})

	const source = new FakeSource()
	const engine = new Engine(store, [source])
	const actions: unknown[] = []
	engine.on('action', (cameraId, action) => actions.push([cameraId, action]))
	engine.start()

	source.emit('connected', pad('pad-1'))
	source.emit('input', 'pad-1', { axes: {}, buttons: { south: true } })
	// Held down is still one press
	source.emit('input', 'pad-1', { axes: {}, buttons: { south: true } })
	assert.deepEqual(actions, [[a.id, { type: 'presetRecall', preset: 0 }]])

	// Camera switches are not camera actions
	source.emit('input', 'pad-1', { axes: {}, buttons: { rb: true } })
	assert.equal(actions.length, 1)

	await engine.stop()
	cam.close()
	rmSync(dir, { recursive: true, force: true })
})

test('engine: a button held to zoom keeps easing up to speed, and stops when let go', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'ptz-pilot-test-'))
	const cam = await fakeCamera()
	const store = new SettingsStore(dir)
	const a = newCamera({ name: 'A', kind: 'udp', host: '127.0.0.1', port: cam.port, sendInterval: 5 })
	store.update((s) => {
		s.cameras = [a]
		s.activeCameraId = a.id
	})

	const source = new FakeSource()
	const engine = new Engine(store, [source])
	engine.start()
	source.emit('connected', pad('pad-1'))
	engine.updateSettings((s) => {
		s.controllers[0].buttons.rb = { type: 'hold', channel: 'zoom', direction: 1 }
	})

	// One report on press; the engine eases in on its own from there
	source.emit('input', 'pad-1', { axes: {}, buttons: { rb: true } })
	assert.equal(engine.state.motion[a.id].zoom, 1, 'slowest at first')
	await sleep(600)
	const later = engine.state.motion[a.id].zoom
	assert.ok(later > 1, `faster after a while (${later})`)
	assert.equal(engine.settings.controllers[0].cameraId, a.id, 'no longer switches camera')

	source.emit('input', 'pad-1', { axes: {}, buttons: {} })
	assert.equal(engine.state.motion[a.id].zoom, 0, 'stopped on release')

	await engine.stop()
	cam.close()
	rmSync(dir, { recursive: true, force: true })
})
