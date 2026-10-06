import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import * as sunapi from '../src/main/hanwha/sunapi.js'
import { Camera, PROFILES, type CameraConfig } from '../src/main/visca/camera.js'
import { newCamera, sanitiseCamera } from '../src/main/settings.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const md5 = (v: string) => createHash('md5').update(v).digest('hex')
const limits = PROFILES.hanwha!
const query = (path: string) => Object.fromEntries(new URL(path, 'http://camera').searchParams)
const NG = 'NG\r\nError Code : 600\r\nError Details : Submenu Not Found\r\n'

test('hanwha: pan, tilt and zoom go together as normalised percentages', () => {
	const request = sunapi.continuous({ pan: 40, tilt: -100, zoom: 0, focus: 0 }, limits)
	assert.ok(request.path.startsWith('/stw-cgi/ptzcontrol.cgi?'))
	assert.deepEqual(query(request.path), {
		msubmenu: 'continuous',
		action: 'control',
		Channel: '0',
		NormalizedSpeed: 'True',
		Pan: '40',
		Tilt: '-100',
		Zoom: '0',
	})
	// Clamped to the camera's top speed and to SUNAPI's 100; zoom is 1-based
	assert.equal(
		query(sunapi.continuous({ pan: 500, tilt: 0, zoom: 0, focus: 0 }, { ...limits, maxPan: 60 }).path).Pan,
		'60',
	)
	assert.equal(query(sunapi.continuous({ pan: 0, tilt: 0, zoom: 1, focus: 0 }, limits).path).Zoom, '1')
	assert.equal(query(sunapi.continuous({ pan: 0, tilt: 0, zoom: -250, focus: 0 }, limits).path).Zoom, '-100')
})

test('hanwha: focus rides along only while it moves or has just stopped, and all zero is a stop', () => {
	assert.equal(query(sunapi.continuous({ pan: 0, tilt: 0, zoom: 0, focus: 1 }, limits).path).Focus, 'Far')
	assert.equal(query(sunapi.continuous({ pan: 5, tilt: 0, zoom: 0, focus: -1 }, limits).path).Focus, 'Near')
	assert.equal(query(sunapi.continuous({ pan: 5, tilt: 0, zoom: 0, focus: 0 }, limits).path).Focus, undefined)
	assert.equal(query(sunapi.continuous({ pan: 5, tilt: 0, zoom: 0, focus: 0 }, limits, true).path).Focus, 'Stop')
	assert.equal(sunapi.continuous({ pan: 0, tilt: 0, zoom: 0, focus: 0 }, limits, true), sunapi.STOP)
	assert.deepEqual(query(sunapi.STOP.path), { msubmenu: 'stop', action: 'control', Channel: '0', OperationType: 'All' })
})

test('hanwha: commands, with presets numbered from 1', () => {
	const recall = sunapi.commandRequest({ type: 'presetRecall', preset: 0 }) as sunapi.SunapiRequest
	assert.deepEqual(query(recall.path), { msubmenu: 'preset', action: 'control', Channel: '0', Preset: '1' })
	assert.deepEqual(sunapi.commandRequest({ type: 'presetSet', preset: 4 }), { savePreset: 5 })
	assert.deepEqual(query(sunapi.savePreset(5, 'add').path), {
		msubmenu: 'preset',
		action: 'add',
		Channel: '0',
		Preset: '5',
		Name: 'Preset5',
	})
	assert.equal(typeof sunapi.commandRequest({ type: 'presetRecall', preset: 300 }), 'string', 'past preset 300')
	assert.equal(query((sunapi.commandRequest({ type: 'home' }) as sunapi.SunapiRequest).path).msubmenu, 'home')
	const onePush = sunapi.commandRequest({ type: 'onePushFocus' }) as sunapi.SunapiRequest
	assert.ok(onePush.path.startsWith('/stw-cgi/image.cgi?'))
	assert.equal(query(onePush.path).Mode, 'SimpleFocus')
	const auto = sunapi.commandRequest({ type: 'autoFocus', enabled: false }) as sunapi.SunapiRequest
	assert.deepEqual(query(auto.path), { msubmenu: 'focus', action: 'set', Channel: '0', FocusMode: 'Manual' })
})

test('hanwha: AF inquiry is a focus view, and FocusMode parses from text or JSON', () => {
	assert.deepEqual(query(sunapi.AF_INQUIRY.path), { msubmenu: 'focus', action: 'view', Channel: '0' })
	assert.equal(sunapi.parseFocusMode('FocusMode=Auto\r\n'), 'on')
	assert.equal(sunapi.parseFocusMode('FocusMode=Manual'), 'off')
	assert.equal(sunapi.parseFocusMode('{"FocusMode":"Auto"}'), 'on')
	assert.equal(sunapi.parseFocusMode('{"FocusMode":"Manual"}'), 'off')
	assert.equal(sunapi.parseFocusMode('{"Model":"XNP-6400"}'), 'unknown')
	assert.equal(sunapi.parseFocusMode('NG'), 'unknown')
	assert.deepEqual(sunapi.commandRequest({ type: 'autoFocusToggle' }), { toggle: true })
})

test('hanwha: autoFocusToggle flips the surfaced state and sets the opposite', async () => {
	for (const [start, written] of [
		['Auto', 'Manual'],
		['Manual', 'Auto'],
	] as const) {
		const { server, requests, port } = await fakeCamera((req, res) => {
			if (!basicChallenge(req, res)) return
			res.end('OK\r\n')
		})
		const camera = new Camera(cameraConfig(port))
		camera.open()
		await sleep(40)
		// Establish the known cached state the way the on/off command does
		camera.command({ type: 'autoFocus', enabled: start === 'Auto' })
		await sleep(60)
		assert.equal(camera.status.autoFocus, start === 'Auto' ? 'on' : 'off')
		const before = requests.length
		camera.command({ type: 'autoFocusToggle' })
		await sleep(80)
		const during = requests.slice(before).map((r) => query(r.url))
		const setAt = during.findIndex((q) => q.msubmenu === 'focus' && q.action === 'set')
		assert.ok(setAt !== -1, `${start} toggled to a set`)
		assert.equal(during[setAt]?.FocusMode, written, `${start} toggled to ${written}`)
		// No focus view precedes the set; any view after is the background self-heal, not a pre-read
		assert.ok(
			!during.slice(0, setAt).some((q) => q.msubmenu === 'focus' && q.action === 'view'),
			'no pre-read focus view before the set',
		)
		assert.equal(camera.status.autoFocus, written === 'Manual' ? 'off' : 'on')
		await camera.close()
		server.close()
	}
})

test('hanwha: autoFocusToggle from unknown turns AF on without a pre-read', async () => {
	const { server, requests, port } = await fakeCamera((req, res) => {
		if (!basicChallenge(req, res)) return
		res.end('OK\r\n')
	})
	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(40)
	// No prior read or set: the cache is unknown, so the toggle defaults to AF on
	assert.equal(camera.status.autoFocus, 'unknown')
	const before = requests.length
	camera.command({ type: 'autoFocusToggle' })
	await sleep(80)
	const queries = requests.slice(before).map((r) => query(r.url))
	const setAt = queries.findIndex((q) => q.msubmenu === 'focus' && q.action === 'set')
	assert.ok(setAt !== -1, 'fell back to a set')
	assert.equal(queries[setAt]?.FocusMode, 'Auto', 'fell back to AF on')
	// No focus view precedes the set; any view after is the background self-heal, not a pre-read
	assert.ok(
		!queries.slice(0, setAt).some((q) => q.msubmenu === 'focus' && q.action === 'view'),
		'no pre-read focus view before the set',
	)
	assert.equal(camera.status.autoFocus, 'on')
	await camera.close()
	server.close()
})

test('hanwha: errors read as words, in text or JSON, whatever the HTTP status', () => {
	assert.equal(sunapi.describeError('going home', 200, 'OK\r\n'), undefined)
	assert.equal(sunapi.describeError('going home', 200, ''), undefined)
	assert.equal(sunapi.describeError('the status request', 200, '{"Model":"XNP-6400"}'), undefined)
	assert.equal(sunapi.describeError('going home', 200, NG), 'The camera refused going home: Submenu Not Found (600)')
	assert.equal(
		sunapi.describeError('preset 9', 200, '{"Response":"Fail","Error":{"Code":602,"Details":"Invalid Value"}}'),
		'The camera refused preset 9: Invalid Value (602)',
	)
	assert.equal(
		sunapi.describeError('movement', 404, '<html>Not found</html>'),
		'The camera refused movement (HTTP 404)',
	)
	assert.equal(sunapi.describeError('movement', 200, 'NG'), 'The camera refused movement (HTTP 200)')
})

test('hanwha: a rejected login backs off, longer each time', () => {
	const first = sunapi.authFailure(0)
	assert.equal(first.backoff, 60_000)
	assert.match(first.error, /1 minute/)
	assert.equal(sunapi.authFailure(first.backoff).backoff, 120_000)
	assert.equal(sunapi.authFailure(30 * 60_000).backoff, 30 * 60_000, 'capped')
})

test('hanwha: settings keep speeds in the Hanwha range', () => {
	const camera = newCamera({ kind: 'hanwha' })
	assert.equal(camera.port, 80)
	assert.equal(camera.profile, 'hanwha')
	assert.equal(camera.maxPan, 100)
	assert.equal(camera.maxZoom, 99)
	assert.equal(camera.maxFocus, 0)
	assert.equal(camera.sendInterval, 100)
	assert.equal(sanitiseCamera({ ...camera, maxPan: 10000 }).maxPan, 100)
	assert.equal(sanitiseCamera({ ...camera, maxFocus: 5 }).maxFocus, 0)
	assert.equal(sanitiseCamera({ ...camera, profile: 'hikvision' }).profile, '')
})

// --- Against a fake camera ---------------------------------------------------------------

interface Seen {
	url: string
	authorization: string | undefined
}

function cameraConfig(port: number, partial: Partial<CameraConfig> = {}): CameraConfig {
	return {
		...newCamera({ kind: 'hanwha', host: '127.0.0.1', port }),
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
		req.resume()
		req.on('end', () => {
			const seen = { url: req.url ?? '', authorization: req.headers.authorization }
			requests.push(seen)
			handle(seen, res)
		})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	return { server, requests, port: (server.address() as AddressInfo).port }
}

const basicChallenge = (req: Seen, res: http.ServerResponse) => {
	if (!req.authorization) {
		res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Wisenet"' }).end()
		return false
	}
	return true
}

test('hanwha: sends the latest movement, keeps the other axes, and stops on close', async () => {
	const { server, requests, port } = await fakeCamera((req, res) => {
		if (!basicChallenge(req, res)) return
		setTimeout(() => res.end('OK\r\n'), 30)
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(50)
	for (let pan = 10; pan <= 100; pan += 10) {
		camera.setMotion({ pan, tilt: -20, zoom: 0, focus: 0 })
		await sleep(5)
	}
	await sleep(100)
	camera.setMotion({ pan: 100, tilt: -20, zoom: 50, focus: 1 })
	await sleep(100)
	camera.setMotion({ pan: 100, tilt: -20, zoom: 50, focus: 0 })
	await sleep(100)
	assert.ok(camera.status.connected, 'connected')
	assert.equal(camera.status.error, undefined)
	await camera.close()
	server.close()

	const moves = requests.map((r) => query(r.url)).filter((q) => q.msubmenu === 'continuous' && q.Tilt === '-20')
	const pans = moves.filter((q) => q.Zoom === '0')
	assert.ok(pans.length < 10, `skipped stale positions (sent ${pans.length})`)
	assert.ok(
		pans.some((q) => q.Pan === '100'),
		'reached the latest pan',
	)
	assert.ok(
		moves.some((q) => q.Pan === '100' && q.Zoom === '50' && q.Focus === 'Far'),
		'focus kept pan and zoom',
	)
	assert.ok(
		moves.some((q) => q.Pan === '100' && q.Focus === 'Stop'),
		'focus stopped while still panning',
	)
	assert.equal(query(requests.at(-1)!.url).msubmenu, 'stop', 'stops everything on close')
})

test('hanwha: answers a digest challenge over the full query string', async () => {
	const realm = 'Wisenet'
	const nonce = 'abc123'
	const { server, requests, port } = await fakeCamera((req, res) => {
		const auth = req.authorization ?? ''
		const field = (name: string) => auth.match(new RegExp(`${name}="?([^",]+)"?`))?.[1] ?? ''
		const ha1 = md5(`admin:${realm}:secret`)
		const ha2 = md5(`GET:${field('uri')}`)
		const expected = md5(`${ha1}:${nonce}:${field('nc')}:${field('cnonce')}:auth:${ha2}`)
		if (auth.startsWith('Digest') && field('response') === expected && field('uri') === req.url)
			return res.end('OK\r\n')
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
	server.close()

	assert.ok(requests.some((r) => r.authorization && query(r.url).msubmenu === 'home'))
})

test('hanwha: a rejected password stops further logins', async () => {
	const { server, requests, port } = await fakeCamera((_req, res) => {
		res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="Wisenet", nonce="n1", qop="auth"' }).end()
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(50)
	camera.command({ type: 'home' })
	await sleep(50)
	const after = requests.length
	camera.command({ type: 'presetRecall', preset: 0 })
	camera.setMotion({ pan: 50, tilt: 0, zoom: 0, focus: 0 })
	await sleep(100)
	assert.match(camera.status.error ?? '', /rejected the user name or password/)
	await camera.close()
	server.close()
	assert.equal(requests.length, after, 'nothing more sent, not even the stop')
})

test('hanwha: saving a preset that exists falls back to update, and a refusal says why', async () => {
	const { server, requests, port } = await fakeCamera((req, res) => {
		if (!basicChallenge(req, res)) return
		const q = query(req.url)
		if (q.msubmenu === 'preset' && q.action === 'add')
			return res.end('NG\r\nError Code : 602\r\nError Details : Already Exists\r\n')
		if (q.msubmenu === 'home') return res.end(NG)
		res.end('OK\r\n')
	})

	const camera = new Camera(cameraConfig(port))
	camera.open()
	await sleep(50)
	camera.command({ type: 'presetSet', preset: 2 })
	await sleep(80)
	assert.equal(camera.status.error, undefined)
	camera.command({ type: 'home' })
	await sleep(50)
	assert.equal(camera.status.error, 'The camera refused going home: Submenu Not Found (600)')
	await camera.close()
	server.close()

	const saves = requests
		.filter((r) => r.authorization)
		.map((r) => query(r.url))
		.filter((q) => q.msubmenu === 'preset' && q.Preset === '3')
	assert.deepEqual(
		saves.map((q) => q.action),
		['add', 'update'],
	)
})
