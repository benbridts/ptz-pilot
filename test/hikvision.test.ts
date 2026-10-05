import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import * as isapi from '../src/main/hikvision/isapi.js'
import { Camera, PROFILES, type CameraConfig } from '../src/main/visca/camera.js'
import { newCamera, sanitiseCamera } from '../src/main/settings.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const md5 = (v: string) => createHash('md5').update(v).digest('hex')
const limits = PROFILES.hikvision!
const ptzData = (pan: number, tilt: number, zoom: number) =>
	`<PTZData><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`

const notSupported = (url: string) =>
	`<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<requestURL>${url}</requestURL>
<statusCode>4</statusCode>
<statusString>Invalid Operation</statusString>
<subStatusCode>notSupport</subStatusCode>
</ResponseStatus>`

test('hikvision: pan, tilt and zoom go together as percentages', () => {
	const request = isapi.continuous({ pan: 40, tilt: -100, zoom: 0 }, limits)
	assert.equal(request.method, 'PUT')
	assert.equal(request.path, '/ISAPI/PTZCtrl/channels/1/continuous')
	assert.ok(request.body?.endsWith(ptzData(40, -100, 0)))
	// Clamped to the camera's top speed and to ISAPI's 100
	assert.ok(
		isapi.continuous({ pan: 500, tilt: 0, zoom: 0 }, { ...limits, maxPan: 60 }).body?.endsWith(ptzData(60, 0, 0)),
	)
	// Zoom is 1-based: 1 is the slowest, 1%, and maxZoom + 1 the fastest
	assert.ok(isapi.continuous({ pan: 0, tilt: 0, zoom: 1 }, limits).body?.endsWith(ptzData(0, 0, 1)))
	assert.ok(isapi.continuous({ pan: 0, tilt: 0, zoom: -100 }, limits).body?.endsWith(ptzData(0, 0, -100)))
	assert.ok(isapi.continuous({ pan: 0, tilt: 0, zoom: 250 }, limits).body?.endsWith(ptzData(0, 0, 100)))
})

test('hikvision: focus speed is 1-based too, and 0 stops', () => {
	const near = isapi.focus(-3, 99)
	assert.equal(near.path, '/ISAPI/System/Video/inputs/channels/1/focus')
	assert.ok(near.body?.endsWith('<FocusData><focus>-3</focus></FocusData>'))
	assert.ok(isapi.focus(0, 99).body?.endsWith('<focus>0</focus></FocusData>'))
	assert.ok(isapi.focus(500, 49).body?.endsWith('<focus>50</focus></FocusData>'))
})

test('hikvision: commands, with presets numbered from 1', () => {
	assert.deepEqual(isapi.commandRequest({ type: 'presetRecall', preset: 0 }), {
		method: 'PUT',
		path: '/ISAPI/PTZCtrl/channels/1/presets/1/goto',
		body: undefined,
	})
	const set = isapi.commandRequest({ type: 'presetSet', preset: 4 }) as isapi.IsapiRequest
	assert.equal(set.path, '/ISAPI/PTZCtrl/channels/1/presets/5')
	assert.ok(
		set.body?.includes('<PTZPreset><enabled>true</enabled><id>5</id><presetName>Preset 5</presetName></PTZPreset>'),
	)
	assert.equal(typeof isapi.commandRequest({ type: 'presetRecall', preset: 300 }), 'string', 'past preset 300')
	assert.equal(
		(isapi.commandRequest({ type: 'home' }) as isapi.IsapiRequest).path,
		'/ISAPI/PTZCtrl/channels/1/homeposition/goto',
	)
	assert.equal(
		(isapi.commandRequest({ type: 'onePushFocus' }) as isapi.IsapiRequest).path,
		'/ISAPI/PTZCtrl/channels/1/onepushfoucs/start',
	)
	assert.deepEqual(isapi.commandRequest({ type: 'autoFocus', enabled: true }), { focusStyle: true })
	assert.deepEqual(isapi.PING, { method: 'GET', path: '/ISAPI/PTZCtrl/channels/1/status' })
})

test('hikvision: auto focus changes only the focus style', () => {
	const current =
		'<FocusConfiguration version="2.0"><focusStyle>SEMIAUTOMATIC</focusStyle><focusLimited>10</focusLimited></FocusConfiguration>'
	assert.equal(
		isapi.withFocusStyle(current, false),
		'<FocusConfiguration version="2.0"><focusStyle>MANUAL</focusStyle><focusLimited>10</focusLimited></FocusConfiguration>',
	)
	assert.ok(
		isapi
			.withFocusStyle(undefined, true)
			.endsWith('<FocusConfiguration><focusStyle>AUTO</focusStyle></FocusConfiguration>'),
	)
})

test('hikvision: a ResponseStatus error reads as words', () => {
	const ok =
		'<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString><subStatusCode>ok</subStatusCode></ResponseStatus>'
	assert.equal(isapi.describeError('going home', 200, ok), undefined)
	assert.equal(isapi.describeError('the status request', 200, '<PTZStatus></PTZStatus>'), undefined)
	assert.equal(
		isapi.describeError('one-push focus', 403, notSupported('/ISAPI/PTZCtrl/channels/1/onepushfoucs/start')),
		'The camera refused one-push focus: Invalid Operation (not supported by this camera)',
	)
	// A failure inside a 200 still counts
	assert.match(isapi.describeError('preset 1', 200, notSupported('/x')) ?? '', /Invalid Operation/)
	assert.equal(isapi.describeError('movement', 404, '<html>Not found</html>'), 'The camera refused movement (HTTP 404)')
	assert.equal(isapi.parseResponseStatus('<PTZStatus/>'), undefined)
})

test('hikvision: a rejected login backs off, longer each time and as long as any lock', () => {
	const body = '<ResponseStatus><statusCode>4</statusCode><retryTimes>3</retryTimes></ResponseStatus>'
	const first = isapi.authFailure(body, 0)
	assert.equal(first.backoff, 60_000)
	assert.match(first.error, /3 tries left/)
	assert.match(first.error, /waits 1 minute/)
	assert.equal(isapi.authFailure('', first.backoff).backoff, 120_000)
	assert.equal(isapi.authFailure('', 30 * 60_000).backoff, 30 * 60_000, 'capped')

	const locked = isapi.authFailure(
		'<ResponseStatus><lockStatus>locked</lockStatus><resLockTime>1800</resLockTime></ResponseStatus>',
		0,
	)
	assert.equal(locked.backoff, 1_800_000)
	assert.match(locked.error, /locked this account.*30 minutes/)
})

test('hikvision: settings keep speeds in the Hikvision range', () => {
	const camera = newCamera({ kind: 'hikvision' })
	assert.equal(camera.port, 80)
	assert.equal(camera.profile, 'hikvision')
	assert.equal(camera.maxPan, 100)
	assert.equal(camera.maxZoom, 99)
	assert.equal(camera.sendInterval, 100)
	assert.equal(sanitiseCamera({ ...camera, maxPan: 10000 }).maxPan, 100)
	assert.equal(sanitiseCamera({ ...camera, maxFocus: 500 }).maxFocus, 99)
	// Another protocol's profile doesn't carry over
	assert.equal(sanitiseCamera({ ...camera, profile: 'canon' }).profile, '')
})

// --- Against a fake camera ---------------------------------------------------------------

interface Seen {
	method: string
	url: string
	body: string
	authorization: string | undefined
}

function cameraConfig(port: number, partial: Partial<CameraConfig> = {}): CameraConfig {
	return {
		...newCamera({ kind: 'hikvision', host: '127.0.0.1', port }),
		...limits,
		username: 'admin',
		password: 'secret',
		sendInterval: 10,
		...partial,
	}
}

async function fakeCamera(handle: (req: Seen, res: http.ServerResponse) => void) {
	const requests: Seen[] = []
	const server = http.createServer((req, res) => {
		let body = ''
		req.on('data', (chunk) => (body += chunk))
		req.on('end', () => {
			const seen = { method: req.method ?? '', url: req.url ?? '', body, authorization: req.headers.authorization }
			requests.push(seen)
			handle(seen, res)
		})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	return { server, requests, port: (server.address() as AddressInfo).port }
}

const OK =
	'<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString><subStatusCode>ok</subStatusCode></ResponseStatus>'
/** Lets everything through, the way a camera with Basic auth and a known challenge would */
const basicChallenge = (req: Seen, res: http.ServerResponse) => {
	if (!req.authorization) {
		res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DS-2DE"' }).end()
		return false
	}
	return true
}

test('hikvision: sends the latest movement, keeps the other axes, and stops on close', async () => {
	const { server, requests, port } = await fakeCamera((req, res) => {
		if (!basicChallenge(req, res)) return
		// Slow enough that stick changes pile up behind each request
		setTimeout(() => res.end(OK), 30)
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(50)
	for (let pan = 10; pan <= 100; pan += 10) {
		camera.setMotion({ pan, tilt: -20, zoom: 0, focus: 0 })
		await sleep(5)
	}
	await sleep(100)
	// Zoom changes while still panning: the body carries the pan too
	camera.setMotion({ pan: 100, tilt: -20, zoom: 50, focus: 0 })
	await sleep(100)
	assert.ok(camera.status.connected, 'connected')
	assert.equal(camera.status.error, undefined)
	await camera.close()
	server.close()

	const moves = requests.filter((r) => r.url.endsWith('/continuous') && r.body.includes('<tilt>-20</tilt>'))
	const pans = moves.filter((r) => r.body.includes('<zoom>0</zoom>'))
	assert.ok(pans.length < 10, `skipped stale positions (sent ${pans.length})`)
	assert.ok(
		pans.some((r) => r.body.endsWith(ptzData(100, -20, 0))),
		'reached the latest pan',
	)
	assert.ok(
		moves.some((r) => r.body.endsWith(ptzData(100, -20, 50))),
		'zoom kept pan and tilt',
	)
	assert.ok(moves.every((r) => r.method === 'PUT'))

	const last = requests.filter((r) => r.url.endsWith('/continuous')).at(-1)
	assert.ok(last?.body.endsWith(ptzData(0, 0, 0)), 'last movement stops everything')
	assert.ok(requests.some((r) => r.url.endsWith('/focus') && r.body.endsWith('<focus>0</focus></FocusData>')))
})

test('hikvision: answers a digest challenge for a PUT', async () => {
	const realm = 'DS-2DE4425IW'
	const nonce = 'abc123'
	const { server, requests, port } = await fakeCamera((req, res) => {
		const auth = req.authorization ?? ''
		const field = (name: string) => auth.match(new RegExp(`${name}="?([^",]+)"?`))?.[1] ?? ''
		const ha1 = md5(`admin:${realm}:secret`)
		const ha2 = md5(`${req.method}:${field('uri')}`)
		const expected = md5(`${ha1}:${nonce}:${field('nc')}:${field('cnonce')}:auth:${ha2}`)
		if (auth.startsWith('Digest') && field('response') === expected && field('uri') === req.url) return res.end(OK)
		res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"` }).end()
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(50)
	camera.command({ type: 'home' })
	await sleep(50)
	assert.equal(camera.status.error, undefined)
	assert.ok(camera.status.lastReplyAt)
	await camera.close()

	// Without a password the camera says why, and that isn't a failed login to back off from
	const anonymous = new Camera(cameraConfig(port, { username: '', password: '' }))
	anonymous.open()
	await sleep(50)
	anonymous.command({ type: 'home' })
	await sleep(50)
	assert.match(anonymous.status.error ?? '', /user name and password/)
	await anonymous.close()
	server.close()

	assert.ok(requests.some((r) => r.method === 'PUT' && r.url === '/ISAPI/PTZCtrl/channels/1/homeposition/goto'))
})

test('hikvision: a rejected password stops further logins, so the account is not locked', async () => {
	const { server, requests, port } = await fakeCamera((_req, res) => {
		res
			.writeHead(401, { 'WWW-Authenticate': 'Digest realm="DS-2DE", nonce="n1", qop="auth"' })
			.end('<ResponseStatus><statusCode>4</statusCode><retryTimes>4</retryTimes></ResponseStatus>')
	})

	const camera = new Camera(cameraConfig(port, { password: 'wrong' }))
	camera.open()
	await sleep(30)
	camera.command({ type: 'home' })
	for (let pan = 1; pan <= 10; pan++) {
		camera.setMotion({ pan, tilt: 0, zoom: 0, focus: 0 })
		await sleep(15)
	}
	camera.command({ type: 'presetRecall', preset: 0 })
	await sleep(100)
	assert.match(camera.status.error ?? '', /rejected the user name or password \(4 tries left\)/)
	assert.match(camera.status.error ?? '', /locks the account/)
	await camera.close()
	server.close()

	const logins = requests.filter((r) => r.authorization?.startsWith('Digest'))
	assert.equal(logins.length, 1, 'one failed login, then nothing')
	assert.equal(requests.length, 2, 'the challenge and the one login; not even a stop on close')
})

test('hikvision: a camera that refuses a command says why', async () => {
	const { server, port } = await fakeCamera((req, res) => {
		if (!basicChallenge(req, res)) return
		if (req.url.includes('onepushfoucs')) return res.writeHead(403).end(notSupported(req.url))
		res.end(OK)
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(30)
	camera.command({ type: 'onePushFocus' })
	await sleep(50)
	assert.equal(camera.status.connected, true)
	assert.equal(
		camera.status.error,
		'The camera refused one-push focus: Invalid Operation (not supported by this camera)',
	)

	// The next command that goes through clears it
	camera.command({ type: 'presetRecall', preset: 2 })
	await sleep(50)
	assert.equal(camera.status.error, undefined)
	await camera.close()
	server.close()
})

test('hikvision: auto focus reads the focus configuration and writes it back changed', async () => {
	const current =
		'<?xml version="1.0" encoding="UTF-8"?>\n<FocusConfiguration version="2.0"><focusStyle>SEMIAUTOMATIC</focusStyle><focusLimited>100</focusLimited></FocusConfiguration>'
	const { server, requests, port } = await fakeCamera((req, res) => {
		if (!basicChallenge(req, res)) return
		if (req.method === 'GET' && req.url.endsWith('/focusConfiguration')) return res.end(current)
		res.end(OK)
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(30)
	camera.command({ type: 'autoFocus', enabled: false })
	await sleep(60)
	assert.equal(camera.status.error, undefined)
	await camera.close()
	server.close()

	const write = requests.find((r) => r.method === 'PUT' && r.url === '/ISAPI/Image/channels/1/focusConfiguration')
	assert.equal(write?.body, current.replace('SEMIAUTOMATIC', 'MANUAL'))
})

test('hikvision: parseFocusStyle reads the style, and the toggle is a read-then-set', () => {
	assert.equal(isapi.parseFocusStyle('<FocusConfiguration><focusStyle>AUTO</focusStyle></FocusConfiguration>'), 'on')
	assert.equal(isapi.parseFocusStyle('<FocusConfiguration><focusStyle>MANUAL</focusStyle></FocusConfiguration>'), 'off')
	assert.equal(
		isapi.parseFocusStyle('<FocusConfiguration><focusStyle>SEMIAUTOMATIC</focusStyle></FocusConfiguration>'),
		'unknown',
	)
	assert.equal(isapi.parseFocusStyle('<PTZStatus/>'), 'unknown')
	assert.deepEqual(isapi.commandRequest({ type: 'autoFocusToggle' }), { toggle: true })
})

test('hikvision: autoFocusToggle reads focusStyle then writes the opposite', async () => {
	for (const [start, written] of [
		['AUTO', 'MANUAL'],
		['MANUAL', 'AUTO'],
	] as const) {
		// Stateful: the write changes what the next GET returns, as a real camera would
		let style = start
		const { server, requests, port } = await fakeCamera((req, res) => {
			if (!basicChallenge(req, res)) return
			if (req.method === 'GET' && req.url.endsWith('/focusConfiguration'))
				return res.end(`<FocusConfiguration><focusStyle>${style}</focusStyle></FocusConfiguration>`)
			if (req.method === 'PUT' && req.url.endsWith('/focusConfiguration')) {
				const m = req.body.match(/<focusStyle>(\w+)<\/focusStyle>/)
				if (m) style = m[1] as typeof style
				return res.end(OK)
			}
			res.end(OK)
		})
		const camera = new Camera(cameraConfig(port))
		camera.open()
		await sleep(30)
		camera.command({ type: 'autoFocusToggle' })
		await sleep(80)
		const write = requests.find((r) => r.method === 'PUT' && r.url.endsWith('/focusConfiguration'))
		assert.ok(write?.body.includes(`<focusStyle>${written}</focusStyle>`), `${start} toggled to ${written}`)
		assert.equal(camera.status.autoFocus, written === 'MANUAL' ? 'off' : 'on')
		await camera.close()
		server.close()
	}
})
