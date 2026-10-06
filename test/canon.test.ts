import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import * as xc from '../src/main/canon/xc.js'
import { Camera, PROFILES, type CameraConfig } from '../src/main/visca/camera.js'
import { newCamera, sanitiseCamera } from '../src/main/settings.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const path = (r: ReturnType<typeof xc.commandRequest> | xc.XcRequest) =>
	typeof r === 'string' ? r : 'toggle' in r ? 'toggle' : xc.requestPath(r)
const md5 = (v: string) => createHash('md5').update(v).digest('hex')

test('canon: pan and tilt carry a direction and a speed, or stop', () => {
	assert.equal(
		path(xc.panTilt(2500, -40, 10000, 10000)),
		'/-wvhttp-01-/control.cgi?pan=right&pan.speed.dir=2500&tilt=down&tilt.speed.dir=40',
	)
	assert.equal(path(xc.panTilt(-1, 0, 10000, 10000)), '/-wvhttp-01-/control.cgi?pan=left&pan.speed.dir=10&tilt=stop')
	// Clamped to the camera's top speed
	assert.equal(path(xc.panTilt(0, 99999, 10000, 5000)), '/-wvhttp-01-/control.cgi?pan=stop&tilt=up&tilt.speed.dir=5000')
})

test('canon: zoom and focus speeds are 1-based onto the camera range', () => {
	assert.equal(path(xc.zoom(1, 127)), '/-wvhttp-01-/control.cgi?zoom=tele&zoom.speed.dir=0')
	assert.equal(path(xc.zoom(-128, 127)), '/-wvhttp-01-/control.cgi?zoom=wide&zoom.speed.dir=127')
	assert.equal(path(xc.zoom(0, 127)), '/-wvhttp-01-/control.cgi?zoom=stop')
	assert.equal(path(xc.focus(3, 2)), '/-wvhttp-01-/control.cgi?focus.speed=2&focus.action=far')
	assert.equal(path(xc.focus(-1, 2)), '/-wvhttp-01-/control.cgi?focus.speed=0&focus.action=near')
	assert.equal(path(xc.focus(0, 2)), '/-wvhttp-01-/control.cgi?focus.action=stop')
})

test('canon: commands, with presets numbered from 1', () => {
	assert.equal(path(xc.commandRequest({ type: 'presetRecall', preset: 0 })), '/-wvhttp-01-/control.cgi?p=1')
	assert.equal(
		path(xc.commandRequest({ type: 'presetSet', preset: 4 })),
		'/-wvhttp-01-/preset/set?p=5&name=Preset+5&all=enabled',
	)
	assert.equal(typeof xc.commandRequest({ type: 'presetRecall', preset: 100 }), 'string', 'past preset 100')
	assert.equal(path(xc.commandRequest({ type: 'home' })), '/-wvhttp-01-/control.cgi?pan=0&tilt=0')
	assert.equal(path(xc.commandRequest({ type: 'autoFocus', enabled: false })), '/-wvhttp-01-/control.cgi?focus=manual')
	assert.equal(path(xc.commandRequest({ type: 'onePushFocus' })), '/-wvhttp-01-/control.cgi?c.1.focus.action=one_shot')
})

test('canon: AF inquiry path and focus-mode parsing', () => {
	assert.equal(xc.requestPath(xc.AF_INQUIRY), '/-wvhttp-01-/info.cgi?item=c.1.focus.mode')
	assert.equal(xc.parseFocusMode('c.1.focus.mode=auto\n'), 'on')
	assert.equal(xc.parseFocusMode('c.1.focus.mode=manual'), 'off')
	assert.equal(xc.parseFocusMode('c.1.type=something'), 'unknown')
	assert.equal(xc.parseFocusMode(''), 'unknown')
})

test('canon: autoFocusToggle flips the surfaced state and sends the opposite set', async () => {
	for (const [start, opposite] of [
		['auto', 'manual'],
		['manual', 'auto'],
	] as const) {
		const { server, requests, port } = await fakeCamera((_req, res) => res.end('OK'))
		const camera = new Camera(cameraConfig(port))
		camera.open()
		await sleep(40)
		// Establish the known cached state the way the on/off command does
		camera.command({ type: 'autoFocus', enabled: start === 'auto' })
		await sleep(50)
		assert.equal(camera.status.autoFocus, start === 'auto' ? 'on' : 'off')
		const before = requests.length
		camera.command({ type: 'autoFocusToggle' })
		await sleep(80)
		const duringToggle = requests.slice(before)
		const setAt = duringToggle.indexOf(`/-wvhttp-01-/control.cgi?focus=${opposite}`)
		assert.ok(setAt !== -1, `${start} toggled to ${opposite} (got ${duringToggle.join(' | ')})`)
		// The toggle sends the set straight away: no AF read precedes it (any inquiry after is the
		// background self-heal re-inquiry, not a pre-read)
		assert.ok(
			!duringToggle.slice(0, setAt).some((r) => r.includes('c.1.focus.mode')),
			`no pre-read inquiry before the set (got ${duringToggle.join(' | ')})`,
		)
		assert.equal(camera.status.autoFocus, opposite === 'manual' ? 'off' : 'on')
		await camera.close()
		server.close()
	}
})

test('canon: an unknown focus mode toggles to AF on without a pre-read', async () => {
	const { server, requests, port } = await fakeCamera((_req, res) => res.end('OK'))
	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(40)
	// No prior read or set: the cache is unknown, so the toggle defaults to AF on
	assert.equal(camera.status.autoFocus, 'unknown')
	const before = requests.length
	camera.command({ type: 'autoFocusToggle' })
	await sleep(80)
	const duringToggle = requests.slice(before)
	const setAt = duringToggle.indexOf('/-wvhttp-01-/control.cgi?focus=auto')
	assert.ok(setAt !== -1, 'fell back to AF on')
	// No AF read precedes the set; any inquiry after is the background self-heal, not a pre-read
	assert.ok(
		!duringToggle.slice(0, setAt).some((r) => r.includes('c.1.focus.mode')),
		'no pre-read inquiry before the set',
	)
	assert.equal(camera.status.autoFocus, 'on')
	await camera.close()
	server.close()
})

test('canon: digest auth matches RFC 2617', () => {
	// The worked example from RFC 2617 section 3.5
	const challenge = xc.parseChallenge(
		'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
	)
	const header = xc.digestHeader(challenge, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', 1, '0a4f113b')
	assert.match(header, /response="6629fae49393a05397450978507c4ef1"/)
	assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/)
})

test('canon: settings keep speeds in the Canon range', () => {
	const camera = newCamera({ kind: 'canon' })
	assert.equal(camera.port, 80)
	assert.equal(camera.profile, 'canon')
	assert.equal(camera.maxPan, 10000)
	assert.equal(camera.sendInterval, 50)
	assert.equal(sanitiseCamera({ ...camera, maxFocus: 7, maxZoom: 500 }).maxFocus, 2)
	assert.equal(sanitiseCamera({ ...camera, maxZoom: 500 }).maxZoom, 127)
	// A VISCA camera can't keep Canon's speeds or profile
	const visca = sanitiseCamera({ ...camera, kind: 'sony-udp' })
	assert.equal(visca.maxPan, 0x18)
	assert.equal(visca.profile, '')
})

function cameraConfig(port: number, partial: Partial<CameraConfig> = {}): CameraConfig {
	return {
		...newCamera({ kind: 'canon', host: '127.0.0.1', port }),
		...PROFILES.canon,
		sendInterval: 10,
		...partial,
	}
}

async function fakeCamera(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
	const requests: string[] = []
	const server = http.createServer((req, res) => {
		requests.push(req.url ?? '')
		handle(req, res)
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	return { server, requests, port: (server.address() as AddressInfo).port }
}

test('canon: sends the latest movement over HTTP, and stops on close', async () => {
	const { server, requests, port } = await fakeCamera((_req, res) => {
		// Slow enough that stick changes pile up behind each request
		setTimeout(() => res.end('OK'), 30)
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(50)
	for (let pan = 100; pan <= 1000; pan += 100) {
		camera.setMotion({ pan, tilt: 0, zoom: 0, focus: 0 })
		await sleep(5)
	}
	await sleep(100)
	assert.ok(camera.status.connected, 'connected')
	assert.equal(camera.status.error, undefined)
	await camera.close()
	server.close()

	const moves = requests.filter((r) => r.includes('pan=right'))
	assert.ok(moves.length < 10, `skipped stale positions (sent ${moves.length})`)
	assert.equal(moves.at(-1), '/-wvhttp-01-/control.cgi?pan=right&pan.speed.dir=1000&tilt=stop')
	assert.equal(
		requests.at(-1),
		'/-wvhttp-01-/control.cgi?pan=stop&tilt=stop&zoom=stop&focus.action=stop',
		'last request stops everything',
	)
})

test('canon: answers a digest challenge', async () => {
	const realm = 'Canon'
	const nonce = 'abc123'
	const { server, requests, port } = await fakeCamera((req, res) => {
		const auth = req.headers.authorization ?? ''
		const field = (name: string) => auth.match(new RegExp(`${name}="?([^",]+)"?`))?.[1] ?? ''
		const ha1 = md5(`admin:${realm}:secret`)
		const ha2 = md5(`GET:${field('uri')}`)
		const expected = md5(`${ha1}:${nonce}:${field('nc')}:${field('cnonce')}:auth:${ha2}`)
		if (auth.startsWith('Digest') && field('response') === expected) return res.end('OK')
		res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"` }).end()
	})

	const camera = new Camera(cameraConfig(port, { username: 'admin', password: 'secret' }))
	camera.open()
	await sleep(50)
	camera.command({ type: 'home' })
	await sleep(50)
	assert.equal(camera.status.error, undefined)
	assert.ok(camera.status.lastReplyAt)
	await camera.close()

	// Without the password the camera says why
	const anonymous = new Camera(cameraConfig(port))
	anonymous.open()
	await sleep(50)
	assert.match(anonymous.status.error ?? '', /user name and password/)
	await anonymous.close()
	server.close()

	assert.ok(requests.includes('/-wvhttp-01-/control.cgi?pan=0&tilt=0'))
})

test('canon: an unreachable camera shows as disconnected', async () => {
	// Nothing listens here once the server closes
	const { server, port } = await fakeCamera((_req, res) => res.end())
	server.close()
	await once(server, 'close')

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(100)
	assert.equal(camera.status.connected, false)
	assert.ok(camera.status.error)
	await camera.close()
})
