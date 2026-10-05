import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import * as aw from '../src/main/panasonic/aw.js'
import { Camera, PROFILES, type CameraConfig } from '../src/main/visca/camera.js'
import { newCamera, sanitiseCamera } from '../src/main/settings.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const path = (r: ReturnType<typeof aw.commandRequest> | aw.AwRequest) =>
	typeof r === 'string' ? r : 'toggle' in r ? 'toggle' : aw.requestPath(r)
const md5 = (v: string) => createHash('md5').update(v).digest('hex')

test('panasonic: speeds are two digits centred on 50', () => {
	assert.equal(aw.speedDigits(0, 49), '50')
	assert.equal(aw.speedDigits(1, 49), '51')
	assert.equal(aw.speedDigits(-1, 49), '49')
	assert.equal(aw.speedDigits(49, 49), '99')
	assert.equal(aw.speedDigits(-49, 49), '01')
	// Never past the camera's range, nor the configured limit
	assert.equal(aw.speedDigits(500, 99), '99')
	assert.equal(aw.speedDigits(-500, 99), '01')
	assert.equal(aw.speedDigits(30, 10), '60')
	// A fraction still moves
	assert.equal(aw.speedDigits(0.2, 49), '51')
})

test('panasonic: pan right and tilt up are above 50, in one command', () => {
	assert.equal(path(aw.panTilt(49, -49, 49, 49)), '/cgi-bin/aw_ptz?cmd=%23PTS9901&res=1')
	assert.equal(path(aw.panTilt(-3, 7, 49, 49)), '/cgi-bin/aw_ptz?cmd=%23PTS4757&res=1')
	assert.equal(path(aw.STOP_PAN_TILT), '/cgi-bin/aw_ptz?cmd=%23PTS5050&res=1')
})

test('panasonic: zoom and focus speeds are 1-based onto the 49 steps', () => {
	assert.equal(aw.zoom(1, 48).cmd, '#Z51')
	assert.equal(aw.zoom(49, 48).cmd, '#Z99')
	assert.equal(aw.zoom(-49, 48).cmd, '#Z01')
	assert.equal(aw.zoom(0, 48).cmd, '#Z50')
	// maxZoom 0 leaves one speed each way
	assert.equal(aw.zoom(5, 0).cmd, '#Z51')
	assert.equal(aw.focus(-3, 48).cmd, '#F47')
	assert.equal(aw.focus(9, 1).cmd, '#F52')
})

test('panasonic: commands, with presets numbered from 0', () => {
	assert.equal(path(aw.commandRequest({ type: 'presetRecall', preset: 0 })), '/cgi-bin/aw_ptz?cmd=%23R00&res=1')
	assert.equal(path(aw.commandRequest({ type: 'presetSet', preset: 99 })), '/cgi-bin/aw_ptz?cmd=%23M99&res=1')
	assert.equal(typeof aw.commandRequest({ type: 'presetRecall', preset: 100 }), 'string', 'past preset 100')
	assert.equal(path(aw.commandRequest({ type: 'home' })), '/cgi-bin/aw_ptz?cmd=%23APC80008000&res=1')
	assert.equal(path(aw.commandRequest({ type: 'autoFocus', enabled: true })), '/cgi-bin/aw_ptz?cmd=%23D11&res=1')
	assert.equal(path(aw.commandRequest({ type: 'autoFocus', enabled: false })), '/cgi-bin/aw_ptz?cmd=%23D10&res=1')
	assert.equal(path(aw.commandRequest({ type: 'onePushFocus' })), '/cgi-bin/aw_cam?cmd=OSE:69:1&res=1')
	assert.equal(path(aw.PING), '/cgi-bin/aw_ptz?cmd=%23O&res=1')
})

test('panasonic: AF inquiry command and focus-mode parsing', () => {
	assert.equal(aw.AF_INQUIRY.cmd, '#D1')
	assert.equal(aw.parseFocusMode('d11'), 'on')
	assert.equal(aw.parseFocusMode('d10'), 'off')
	assert.equal(aw.parseFocusMode('d1'), 'unknown')
	assert.equal(aw.parseFocusMode('eR3'), 'unknown')
})

test('panasonic: autoFocusToggle reads #D1 then sends the opposite', async () => {
	for (const [start, opposite] of [
		['1', '#D10'],
		['0', '#D11'],
	] as const) {
		// Stateful: a #D1x set changes what the bare #D1 query echoes next, as a real camera would
		let d1 = start
		const { server, hits, port } = await fakeCamera((cmd, _req, res) => {
			if (cmd === '#D1') return res.end(`d1${d1}`)
			const set = cmd.match(/^#D1([01])$/)
			if (set) d1 = set[1] as typeof d1
			res.end(cmd.slice(1).toLowerCase())
		})
		const camera = new Camera(cameraConfig(port))
		camera.open()
		await sleep(30)
		camera.command({ type: 'autoFocusToggle' })
		await sleep(80)
		assert.ok(
			hits.some((h) => h.cmd === opposite),
			`d1${start} toggled to ${opposite} (got ${hits.map((h) => h.cmd).join(' ')})`,
		)
		assert.equal(camera.status.autoFocus, opposite === '#D10' ? 'off' : 'on')
		await camera.close()
		server.close()
	}
})

test('panasonic: a garbled focus mode falls back to #D11 and stays unknown on the read', async () => {
	const { server, hits, port } = await fakeCamera((cmd, _req, res) => {
		if (cmd === '#D1') return res.end('xx')
		res.end(cmd.slice(1).toLowerCase())
	})
	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(30)
	camera.command({ type: 'autoFocusToggle' })
	await sleep(80)
	assert.ok(
		hits.some((h) => h.cmd === '#D11'),
		'fell back to AF on',
	)
	assert.equal(camera.status.autoFocus, 'on')
	await camera.close()
	server.close()
})

test('panasonic: replies become readable errors, and busy is routine', () => {
	const pan = aw.panTilt(1, 0, 49, 49)
	assert.equal(aw.interpretReply(pan, 'pTS5150'), undefined)
	assert.equal(aw.interpretReply(pan, 'eR2:PTS'), 'routine')
	assert.match(aw.interpretReply(pan, 'eR1:PTS') ?? '', /doesn't support the PTS command/)
	assert.match(aw.interpretReply(pan, 'eR3:PTS\r\n') ?? '', /out of range/)
	assert.match(aw.interpretReply(aw.focus(1, 48), 'eR3:F') ?? '', /auto focus off/)
	assert.match(aw.interpretReply(aw.commandRequest({ type: 'onePushFocus' }) as aw.AwRequest, 'ER1:OSE') ?? '', /OSE/)
	assert.equal(aw.interpretReply(aw.PING, 'p1'), undefined)
	assert.match(aw.interpretReply(aw.PING, 'p0') ?? '', /standby/)
})

test('panasonic: settings keep speeds in the Panasonic range', () => {
	const camera = newCamera({ kind: 'panasonic' })
	assert.equal(camera.port, 80)
	assert.equal(camera.profile, 'panasonic')
	assert.equal(camera.maxPan, 49)
	assert.equal(camera.maxZoom, 48)
	assert.equal(camera.sendInterval, 130)
	assert.equal(sanitiseCamera({ ...camera, maxPan: 99, maxZoom: 500 }).maxPan, 49)
	assert.equal(sanitiseCamera({ ...camera, maxZoom: 500 }).maxZoom, 48)
	const visca = sanitiseCamera({ ...camera, kind: 'sony-udp' })
	assert.equal(visca.maxPan, 0x18)
	assert.equal(visca.profile, '')
})

function cameraConfig(port: number, partial: Partial<CameraConfig> = {}): CameraConfig {
	return {
		...newCamera({ kind: 'panasonic', host: '127.0.0.1', port }),
		...PROFILES.panasonic,
		sendInterval: 10,
		...partial,
	}
}

interface Hit {
	cmd: string
	at: number
}

/** A fake AW camera: answers each command with what `reply` says, echoing it by default */
async function fakeCamera(
	reply: (cmd: string, req: http.IncomingMessage, res: http.ServerResponse) => void = (cmd, _req, res) =>
		res.end(cmd.slice(1, 2).toLowerCase() + cmd.slice(2)),
) {
	const hits: Hit[] = []
	const server = http.createServer((req, res) => {
		const cmd = new URL(req.url ?? '', 'http://camera').searchParams.get('cmd') ?? ''
		hits.push({ cmd, at: Date.now() })
		reply(cmd, req, res)
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	return { server, hits, port: (server.address() as AddressInfo).port }
}

test('panasonic: sends the latest movement, and stops everything that moved on close', async () => {
	const { server, hits, port } = await fakeCamera((cmd, _req, res) => {
		// Slow enough that stick changes pile up behind each request
		setTimeout(() => res.end(cmd.slice(1)), 30)
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	for (let pan = 1; pan <= 20; pan++) {
		camera.setMotion({ pan, tilt: 0, zoom: 0, focus: 0 })
		await sleep(5)
	}
	await sleep(100)
	camera.setMotion({ pan: 20, tilt: 0, zoom: -4, focus: 0 })
	await sleep(100)
	assert.ok(camera.status.connected, 'connected')
	assert.equal(camera.status.error, undefined)
	await camera.close()
	server.close()

	const moves = hits.filter((h) => h.cmd.startsWith('#PTS') && h.cmd !== '#PTS5050')
	assert.ok(moves.length < 20, `skipped stale positions (sent ${moves.length})`)
	assert.equal(moves.at(-1)?.cmd, '#PTS7050')
	assert.ok(hits.some((h) => h.cmd === '#Z46'))
	// Pan and tilt stop first; focus never moved, so isn't stopped
	assert.deepEqual(
		hits.slice(-2).map((h) => h.cmd),
		['#PTS5050', '#Z50'],
	)
})

test('panasonic: keeps the gap between commands, and pan never starves zoom', async () => {
	const { server, hits, port } = await fakeCamera()

	// The default 130 ms interval
	const camera = new Camera({ ...cameraConfig(port), sendInterval: newCamera({ kind: 'panasonic' }).sendInterval })
	camera.open()
	// A stick that never sits still, with zoom held alongside it
	const start = Date.now()
	for (let i = 0; Date.now() - start < 700; i++) {
		camera.setMotion({ pan: 10 + (i % 20), tilt: 0, zoom: 5, focus: 0 })
		await sleep(10)
	}
	await camera.close()
	server.close()

	const gaps = hits.slice(1).map((h, i) => h.at - hits[i]!.at)
	assert.ok(
		gaps.every((g) => g >= 125),
		`at least 130 ms apart, give or take a clock tick: ${gaps.join(', ')}`,
	)
	const zoomAt = hits.findIndex((h) => h.cmd === '#Z55')
	assert.ok(zoomAt >= 0 && zoomAt <= 1, `zoom went out second at the latest: ${hits.map((h) => h.cmd).join(' ')}`)
	assert.deepEqual(
		hits.slice(-2).map((h) => h.cmd),
		['#PTS5050', '#Z50'],
	)
})

test('panasonic: error replies show, busy replies change nothing, and standby shows', async () => {
	let standby = false
	const { server, port } = await fakeCamera((cmd, _req, res) => {
		if (cmd === '#O') return res.end(standby ? 'p0' : 'p1')
		if (cmd.startsWith('#F')) return res.end('eR3:F')
		if (cmd.startsWith('#R')) return res.end('eR2:R')
		res.end(cmd.slice(1))
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	camera.setMotion({ pan: 0, tilt: 0, zoom: 0, focus: 3 })
	await sleep(50)
	assert.match(camera.status.error ?? '', /auto focus off/)

	// Busy leaves the last error in place
	camera.command({ type: 'presetRecall', preset: 2 })
	await sleep(50)
	assert.match(camera.status.error ?? '', /auto focus off/)

	// A plain answer clears it
	camera.command({ type: 'home' })
	await sleep(50)
	assert.equal(camera.status.error, undefined)

	// Past the camera's presets, nothing is sent
	camera.command({ type: 'presetSet', preset: 100 })
	await sleep(50)
	assert.match(camera.status.error ?? '', /presets 1-100/)
	await camera.close()

	standby = true
	const link = new aw.PanasonicLink(cameraConfig(port))
	const replies: (string | undefined)[] = []
	link.on('reply', (r) => replies.push(r.error))
	link.open()
	link.ping()
	await sleep(50)
	assert.match(replies[0] ?? '', /standby/)
	await link.close()
	server.close()
})

test('panasonic: answers a digest challenge', async () => {
	const realm = 'Panasonic'
	const nonce = 'abc123'
	const { server, hits, port } = await fakeCamera((cmd, req, res) => {
		const auth = req.headers.authorization ?? ''
		const field = (name: string) => auth.match(new RegExp(`${name}="?([^",]+)"?`))?.[1] ?? ''
		const ha1 = md5(`admin:${realm}:secret`)
		const ha2 = md5(`GET:${field('uri')}`)
		const expected = md5(`${ha1}:${nonce}:${field('nc')}:${field('cnonce')}:auth:${ha2}`)
		if (auth.startsWith('Digest') && field('response') === expected) return res.end(cmd.slice(1))
		res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"` }).end()
	})

	const camera = new Camera(cameraConfig(port, { username: 'admin', password: 'secret' }))
	camera.open()
	camera.command({ type: 'home' })
	await sleep(50)
	assert.equal(camera.status.error, undefined)
	assert.ok(camera.status.lastReplyAt)
	await camera.close()

	const anonymous = new Camera(cameraConfig(port))
	anonymous.open()
	anonymous.command({ type: 'home' })
	await sleep(50)
	assert.match(anonymous.status.error ?? '', /user name and password/)
	await anonymous.close()
	server.close()

	assert.ok(hits.some((h) => h.cmd === '#APC80008000'))
})

test('panasonic: an unreachable camera shows as disconnected', async () => {
	const { server, port } = await fakeCamera()
	server.close()
	await once(server, 'close')

	const camera = new Camera(cameraConfig(port))
	camera.open()
	camera.command({ type: 'home' })
	await sleep(100)
	assert.equal(camera.status.connected, false)
	assert.ok(camera.status.error)
	await camera.close()
})
