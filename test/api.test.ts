import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { Engine } from '../src/main/engine.js'
import { ApiServer } from '../src/main/api.js'
import { SettingsStore, newCamera } from '../src/main/settings.js'
import { GAMEPAD_AXES, GAMEPAD_BUTTONS } from '../src/main/controllers/gamepad.js'
import type { ControllerSource, ControllerSourceEvents } from '../src/main/controllers/types.js'

const hex = (b: Buffer) => b.toString('hex').replace(/(..)(?!$)/g, '$1 ')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeSource extends EventEmitter<ControllerSourceEvents> implements ControllerSource {
	start(): void {}
	async stop(): Promise<void> {}
}

/** Collects every message, and waits for ones matching a test */
function client(url: string) {
	const ws = new WebSocket(url)
	const messages: Record<string, unknown>[] = []
	const waiters: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] =
		[]
	ws.on('message', (data) => {
		const m = JSON.parse(data.toString())
		messages.push(m)
		for (const w of [...waiters]) {
			if (w.match(m)) {
				waiters.splice(waiters.indexOf(w), 1)
				w.resolve(m)
			}
		}
	})
	const next = (match: (m: Record<string, unknown>) => boolean) =>
		new Promise<Record<string, unknown>>((resolve) => {
			const found = messages.find(match)
			if (found) resolve(found)
			else waiters.push({ match, resolve })
		})
	let id = 0
	const request = async (body: object) => {
		const requestId = ++id
		ws.send(JSON.stringify({ id: requestId, ...body }))
		return next((m) => m.type === 'response' && m.id === requestId)
	}
	return { ws, messages, next, request, opened: once(ws, 'open') }
}

test('api: state, moves that merge and stop on disconnect, presets and errors', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'ptz-pilot-api-'))
	const cam = dgram.createSocket('udp4')
	cam.bind(0, '127.0.0.1')
	await once(cam, 'listening')
	const received: string[] = []
	cam.on('message', (d) => received.push(hex(d)))

	const port = 20000 + Math.floor(Math.random() * 20000)
	const store = new SettingsStore(dir)
	const camera = newCamera({
		name: 'Stage Left',
		kind: 'udp',
		host: '127.0.0.1',
		port: cam.address().port,
		sendInterval: 5,
	})
	store.update((s) => {
		s.cameras = [camera]
		s.activeCameraId = camera.id
		s.api = { enabled: true, port, allowRemote: false }
	})

	const source = new FakeSource()
	const engine = new Engine(store, [source])
	const server = new ApiServer(engine, '0.0.0-test')
	engine.start()
	server.start()
	await sleep(100)
	source.emit('connected', { id: 'pad-1', kind: 'gamepad', name: 'Pad', axes: GAMEPAD_AXES, buttons: GAMEPAD_BUTTONS })

	const c = client(`ws://127.0.0.1:${port}`)
	await c.opened

	const hello = await c.next((m) => m.type === 'hello')
	assert.equal(hello.apiVersion, 1)
	const state = (await c.next((m) => m.type === 'state')) as {
		cameras: { name: string; number: number }[]
		controllers: { id: string; camera: string }[]
	}
	assert.equal(state.cameras[0].name, 'Stage Left')
	assert.equal(state.cameras[0].number, 1)
	assert.equal(state.controllers[0].camera, camera.id)
	// The per-camera AF field is carried in the state message
	assert.ok(['on', 'off', 'unknown'].includes((state.cameras[0] as { autoFocus?: string }).autoFocus ?? ''))

	// Cameras can be named by id, name or number
	assert.equal((await c.request({ type: 'move', camera: 'stage left', pan: -1 })).ok, true)
	await sleep(40)
	assert.equal(
		received.filter((r) => r.startsWith('81 01 06 01')).at(-1),
		'81 01 06 01 18 01 01 03 ff',
		'panning left, full speed',
	)

	// A controller on the same camera pushing harder takes over tilt, while the API keeps pan
	source.emit('input', 'pad-1', { axes: { leftY: 1 }, buttons: {} })
	await sleep(40)
	assert.match(received.filter((r) => r.startsWith('81 01 06 01')).at(-1)!, /^81 01 06 01 18 .. 01 01 ff$/)
	source.emit('input', 'pad-1', { axes: {}, buttons: {} })

	// Telemetry reports the movement
	const telemetry = (await c.next(
		(m) => m.type === 'telemetry' && (m.cameras as Record<string, { pan: number }>)[camera.id]?.pan === -24,
	)) as never
	assert.ok(telemetry)

	assert.equal((await c.request({ type: 'presetRecall', camera: 1, preset: 3 })).ok, true)
	await sleep(40)
	assert.ok(received.includes('81 01 04 3f 02 02 ff'), 'preset 3 is 02 on the wire')

	// The autoFocusToggle request routes through to the camera; the existing autoFocus still works
	assert.equal((await c.request({ type: 'autoFocusToggle', camera: 1 })).ok, true)
	await sleep(40)
	assert.ok(received.includes('81 01 04 38 02 ff'), 'an unknown toggle sends the AF-on fallback')
	assert.equal((await c.request({ type: 'autoFocus', camera: 1, enabled: false })).ok, true)
	await sleep(40)
	assert.ok(received.includes('81 01 04 38 03 ff'), 'autoFocus off still works')

	const bad = await c.request({ type: 'presetRecall', preset: 0 })
	assert.equal(bad.ok, false)
	assert.match(String(bad.error), /preset/)
	assert.equal((await c.request({ type: 'move', camera: 'nope', pan: 1 })).ok, false)

	// Disconnecting stops whatever the client was moving
	c.ws.close()
	await sleep(80)
	assert.equal(received.filter((r) => r.startsWith('81 01 06 01')).at(-1), '81 01 06 01 01 01 03 03 ff', 'stopped')

	await server.stop()
	await engine.stop()
	cam.close()
	rmSync(dir, { recursive: true, force: true })
})
