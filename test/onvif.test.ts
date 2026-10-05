import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import dgram from 'node:dgram'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import * as soap from '../src/main/onvif/soap.js'
import * as discovery from '../src/main/onvif/discovery.js'
import { Camera, PROFILES, type CameraConfig } from '../src/main/visca/camera.js'
import { newCamera, sanitiseCamera } from '../src/main/settings.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const md5 = (v: string) => createHash('md5').update(v).digest('hex')

test('onvif: password digest matches the ONVIF programmer’s guide example', () => {
	const nonce = Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64')
	assert.equal(soap.passwordDigest(nonce, '2010-09-16T07:50:45Z', 'userpassword'), 'tuOSpGlFlIXsozq4HFNeeGeFLEI=')

	const header = soap.usernameToken('admin', 'userpassword', new Date('2010-09-16T07:50:45.123Z'), nonce)
	assert.match(header, /<wsse:Username>admin<\/wsse:Username>/)
	assert.match(header, /#PasswordDigest">tuOSpGlFlIXsozq4HFNeeGeFLEI=<\/wsse:Password>/)
	assert.match(header, /<wsse:Nonce [^>]*>LKqI6G\/AikKCQrN0zqZFlg==<\/wsse:Nonce>/)
	assert.match(header, /<wsu:Created>2010-09-16T07:50:45Z<\/wsu:Created>/, 'to the second')
})

test('onvif: moves carry every axis and a timeout; stop names both', () => {
	const move = soap.continuousMove('Profile_1', { pan: 0.5, tilt: -0.25, zoom: 0 }, 1000)
	assert.equal(
		move.body,
		'<tptz:ContinuousMove><tptz:ProfileToken>Profile_1</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="0.5" y="-0.25"/><tt:Zoom x="0"/></tptz:Velocity><tptz:Timeout>PT1S</tptz:Timeout></tptz:ContinuousMove>',
	)
	assert.equal(soap.soapAction(move), 'http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove')
	assert.doesNotMatch(soap.continuousMove('p', { pan: 1, tilt: 0, zoom: 0 }).body, /Timeout/)
	assert.equal(
		soap.ptzStop('a&b').body,
		'<tptz:Stop><tptz:ProfileToken>a&amp;b</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>',
	)
	const env = soap.envelope(soap.getSystemDateAndTime())
	assert.match(
		env,
		/^<\?xml version="1.0" encoding="UTF-8"\?><s:Envelope xmlns:s="http:\/\/www.w3.org\/2003\/05\/soap-envelope"/,
	)
	assert.match(env, /<s:Body><tds:GetSystemDateAndTime\/><\/s:Body><\/s:Envelope>$/)
	assert.doesNotMatch(env, /s:Header/, 'no header without a login')
})

test('onvif: focus, presets and imaging requests', () => {
	assert.equal(
		soap.focusMove('VideoSource_1', -0.5).body,
		'<timg:Move><timg:VideoSourceToken>VideoSource_1</timg:VideoSourceToken><timg:Focus><tt:Continuous><tt:Speed>-0.5</tt:Speed></tt:Continuous></timg:Focus></timg:Move>',
	)
	assert.equal(
		soap.setFocusMode('V', false).body,
		'<timg:SetImagingSettings><timg:VideoSourceToken>V</timg:VideoSourceToken><timg:ImagingSettings><tt:Focus><tt:AutoFocusMode>MANUAL</tt:AutoFocusMode></tt:Focus></timg:ImagingSettings></timg:SetImagingSettings>',
	)
	assert.equal(
		soap.gotoPreset('P', '3').body,
		'<tptz:GotoPreset><tptz:ProfileToken>P</tptz:ProfileToken><tptz:PresetToken>3</tptz:PresetToken></tptz:GotoPreset>',
	)
	assert.equal(
		soap.setPreset('P', 'Preset 3').body,
		'<tptz:SetPreset><tptz:ProfileToken>P</tptz:ProfileToken><tptz:PresetName>Preset 3</tptz:PresetName></tptz:SetPreset>',
	)
	assert.match(soap.setPreset('P', 'Preset 3', '3').body, /<\/tptz:PresetName><tptz:PresetToken>3<\/tptz:PresetToken>/)
	assert.equal(
		soap.getImagingSettings('V').body,
		'<timg:GetImagingSettings><timg:VideoSourceToken>V</timg:VideoSourceToken></timg:GetImagingSettings>',
	)
})

test('onvif: parseAutoFocusMode reads AutoFocusMode', () => {
	assert.equal(soap.parseAutoFocusMode('<tt:Focus><tt:AutoFocusMode>AUTO</tt:AutoFocusMode></tt:Focus>'), 'on')
	assert.equal(soap.parseAutoFocusMode('<tt:Focus><tt:AutoFocusMode>MANUAL</tt:AutoFocusMode></tt:Focus>'), 'off')
	assert.equal(soap.parseAutoFocusMode('<tt:Focus/>'), 'unknown')
})

test('onvif: speeds are percent, zoom and focus 1-based', () => {
	assert.deepEqual(soap.panTiltVelocity(50, -100, 100, 100), { pan: 0.5, tilt: -1 })
	// Clamped to the limit
	assert.deepEqual(soap.panTiltVelocity(100, 0, 40, 100), { pan: 0.4, tilt: 0 })
	assert.equal(soap.zoomVelocity(1, 99), 0.01)
	assert.equal(soap.zoomVelocity(-100, 99), -1)
	assert.equal(soap.zoomVelocity(100, 49), 0.5)
	assert.equal(soap.focusSpeed(50, 99, 7), 3.5, 'scaled to the camera’s focus range')
	assert.equal(soap.focusSpeed(0, 99), 0)
})

test('onvif: presets are found by token, then by name', () => {
	const presets = [
		{ token: '1', name: 'Pulpit' },
		{ token: 'Preset2', name: 'Choir' },
		{ token: 'abc', name: 'Preset 3' },
		{ token: 'def', name: '30' },
	]
	assert.equal(soap.findPreset(presets, 1)?.token, '1')
	assert.equal(soap.findPreset(presets, 2)?.token, 'Preset2')
	assert.equal(soap.findPreset(presets, 3)?.token, 'abc')
	assert.equal(soap.findPreset(presets, 30)?.token, 'def')
	assert.equal(soap.findPreset(presets, 4), undefined)
})

test('onvif: reads services, profiles, presets, the clock and faults', () => {
	const services = soap.parseServices(
		'<tds:GetServicesResponse><tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>http://10.0.0.5/onvif/device_service</tds:XAddr></tds:Service>' +
			'<tds:Service><tds:Namespace>http://www.onvif.org/ver20/ptz/wsdl</tds:Namespace><tds:XAddr>http://10.0.0.5/onvif/PTZ</tds:XAddr><tds:Version><tt:Major>2</tt:Major></tds:Version></tds:Service></tds:GetServicesResponse>',
	)
	assert.deepEqual(services, {
		device: 'http://10.0.0.5/onvif/device_service',
		ptz: 'http://10.0.0.5/onvif/PTZ',
	})
	assert.equal(
		soap.parseCapabilities('<tt:Media><tt:XAddr>http://x/onvif/Media</tt:XAddr><tt:StreamingCapabilities/></tt:Media>')
			.media,
		'http://x/onvif/Media',
	)
	// The camera's own idea of its address is ignored; only the path is kept
	assert.equal(soap.servicePath('http://172.16.0.2:8080/onvif/PTZ'), '/onvif/PTZ')

	const profiles = soap.parseProfiles(
		'<trt:Profiles token="main" fixed="true"><tt:Name>main</tt:Name><tt:VideoSourceConfiguration token="vsc"><tt:SourceToken>VideoSource_1</tt:SourceToken></tt:VideoSourceConfiguration></trt:Profiles>' +
			'<trt:Profiles token="ptz"><tt:VideoSourceConfiguration token="vsc"><tt:SourceToken>VideoSource_1</tt:SourceToken></tt:VideoSourceConfiguration><tt:PTZConfiguration token="ptzc"/></trt:Profiles>',
	)
	assert.deepEqual(profiles, [
		{ token: 'main', videoSource: 'VideoSource_1', ptz: false },
		{ token: 'ptz', videoSource: 'VideoSource_1', ptz: true },
	])

	assert.deepEqual(
		soap.parsePresets('<tptz:Preset token="1"><tt:Name>A &amp; B</tt:Name></tptz:Preset><tptz:Preset token="2"/>'),
		[
			{ token: '1', name: 'A & B' },
			{ token: '2', name: '' },
		],
	)
	assert.equal(
		soap.parseFocusRange(
			'<timg:MoveOptions><tt:Continuous><tt:Speed><tt:Min>-7</tt:Min><tt:Max>7</tt:Max></tt:Speed></tt:Continuous></timg:MoveOptions>',
		),
		7,
	)
	assert.equal(soap.parseFocusRange('<timg:MoveOptions/>'), undefined)

	assert.equal(
		soap.parseDateTime(dateTimeResponse(new Date('2026-03-04T05:06:07Z')))?.toISOString(),
		'2026-03-04T05:06:07.000Z',
	)

	const f = soap.parseFault(faultXml('ter:NotAuthorized', 'Sender not Authorized'))
	assert.deepEqual(f, { code: 'ter:NotAuthorized', reason: 'Sender not Authorized' })
	assert.ok(soap.isAuthFault(f!))
	assert.equal(soap.parseFault('<s:Body><x/></s:Body>'), undefined)
})

test('onvif: settings keep speeds in percent', () => {
	const camera = newCamera({ kind: 'onvif' })
	assert.equal(camera.port, 80)
	assert.equal(camera.profile, 'onvif')
	assert.equal(camera.maxPan, 100)
	assert.equal(camera.maxZoom, 99)
	assert.equal(camera.sendInterval, 100)
	assert.equal(sanitiseCamera({ ...camera, maxPan: 10000, maxFocus: 500 }).maxPan, 100)
	assert.equal(sanitiseCamera({ ...camera, maxFocus: 500 }).maxFocus, 99)
	assert.equal(sanitiseCamera({ ...camera, username: 'u' }).username, 'u', 'keeps the login')
})

// --- A fake camera -----------------------------------------------------------

function dateTimeResponse(d: Date): string {
	return (
		'<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:UTCDateTime>' +
		`<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>` +
		`<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>` +
		'</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>'
	)
}

function faultXml(code: string, reason: string): string {
	return (
		'<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>' +
		code +
		`</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">${reason}</s:Text></s:Reason></s:Fault>`
	)
}

const wrap = (body: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${soap.NS.s}" xmlns:tt="${soap.NS.tt}"><s:Body>${body}</s:Body></s:Envelope>`

interface Received {
	path: string
	operation: string
	body: string
}

interface FakeOptions {
	/** The camera's clock is this far ahead of ours */
	clockOffset?: number
	/** Also demand HTTP Digest */
	digest?: boolean
	/** Overrides, by operation */
	answers?: Record<string, (body: string) => { status?: number; xml: string } | undefined>
	delay?: number
}

const USER = 'admin'
const PASSWORD = 'secret'
const REALM = 'onvif'
const NONCE = 'n0nce'

/** Checks WS-Security against the camera's clock, as real cameras do */
function authorised(body: string, clockOffset: number): boolean {
	const field = (name: string) => soap.text(body, name)
	const created = field('Created')
	if (field('Username') !== USER || !created) return false
	if (Math.abs(Date.parse(created) - (Date.now() + clockOffset)) > 5000) return false
	return soap.passwordDigest(Buffer.from(field('Nonce') ?? '', 'base64'), created, PASSWORD) === field('Password')
}

function digestOk(req: http.IncomingMessage): boolean {
	const auth = req.headers.authorization ?? ''
	const field = (name: string) => auth.match(new RegExp(`${name}="?([^",]+)"?`))?.[1] ?? ''
	const ha1 = md5(`${USER}:${REALM}:${PASSWORD}`)
	const ha2 = md5(`POST:${field('uri')}`)
	return (
		auth.startsWith('Digest') &&
		field('response') === md5(`${ha1}:${NONCE}:${field('nc')}:${field('cnonce')}:auth:${ha2}`)
	)
}

async function fakeCamera(t: TestContext, options: FakeOptions = {}) {
	const received: Received[] = []
	const clockOffset = options.clockOffset ?? 0
	const server = http.createServer(async (req, res) => {
		let body = ''
		for await (const chunk of req) body += chunk
		const operation = body.match(/<s:Body><\w+:(\w+)/)?.[1] ?? ''
		received.push({ path: req.url ?? '', operation, body })

		const send = (status: number, xml: string) => {
			const reply = () =>
				res.writeHead(status, { 'content-type': 'application/soap+xml; charset=utf-8' }).end(wrap(xml))
			if (options.delay) setTimeout(reply, options.delay)
			else reply()
		}

		if (operation === 'GetSystemDateAndTime') return send(200, dateTimeResponse(new Date(Date.now() + clockOffset)))
		if (options.digest && !digestOk(req)) {
			res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="${NONCE}", qop="auth"` }).end()
			return
		}
		if (!authorised(body, clockOffset)) return send(400, faultXml('ter:NotAuthorized', 'Sender not Authorized'))

		const custom = options.answers?.[operation]?.(body)
		if (custom) return send(custom.status ?? 200, custom.xml)

		switch (operation) {
			case 'GetServices':
				return send(
					200,
					'<tds:GetServicesResponse>' +
						[
							[soap.NS.tds, '/onvif/device_service'],
							[soap.NS.trt, '/onvif/Media'],
							[soap.NS.tptz, '/onvif/PTZ'],
							[soap.NS.timg, '/onvif/Imaging'],
						]
							.map(
								([ns, path]) =>
									`<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>http://192.168.99.99${path}</tds:XAddr></tds:Service>`,
							)
							.join('') +
						'</tds:GetServicesResponse>',
				)
			case 'GetProfiles':
				return send(
					200,
					'<trt:GetProfilesResponse>' +
						'<trt:Profiles token="Profile_1"><tt:VideoSourceConfiguration token="v"><tt:SourceToken>VideoSource_1</tt:SourceToken></tt:VideoSourceConfiguration><tt:PTZConfiguration token="ptz"/></trt:Profiles>' +
						'</trt:GetProfilesResponse>',
				)
			case 'GetPresets':
				return send(
					200,
					'<tptz:GetPresetsResponse><tptz:Preset token="1"><tt:Name>Preset 1</tt:Name></tptz:Preset><tptz:Preset token="2"><tt:Name>Lectern</tt:Name></tptz:Preset></tptz:GetPresetsResponse>',
				)
			case 'GetMoveOptions':
				return send(
					200,
					'<timg:GetMoveOptionsResponse><timg:MoveOptions><tt:Continuous><tt:Speed><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:Speed></tt:Continuous></timg:MoveOptions></timg:GetMoveOptionsResponse>',
				)
			default:
				return send(200, `<x:${operation}Response xmlns:x="urn:x"/>`)
		}
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => server.close(() => {}))
	return { server, received, port: (server.address() as AddressInfo).port }
}

/** A camera that is closed when the test ends, whether or not it passed, so a failure can't hang the run */
function flying(t: TestContext, config: CameraConfig): Camera {
	const camera = new Camera(config)
	camera.open()
	t.after(() => camera.close())
	return camera
}

function cameraConfig(port: number, partial: Partial<CameraConfig> = {}): CameraConfig {
	return {
		...newCamera({ kind: 'onvif', host: '127.0.0.1', port }),
		...PROFILES.onvif,
		username: USER,
		password: PASSWORD,
		sendInterval: 10,
		...partial,
	}
}

const ops = (received: Received[]) => received.map((r) => r.operation)

test('onvif: sets up against the camera’s clock, then flies the latest movement and stops on close', async (t) => {
	// A camera an hour fast would refuse a token timed by our clock
	const { received, port } = await fakeCamera(t, { clockOffset: 3600_000, delay: 20 })

	const camera = flying(t, cameraConfig(port))
	await sleep(250)
	assert.equal(camera.status.error, undefined)
	assert.ok(camera.status.connected, 'connected')
	assert.deepEqual(ops(received).slice(0, 6), [
		'GetSystemDateAndTime',
		'GetServices',
		'GetProfiles',
		'GetPresets',
		'GetMoveOptions',
		'GetStatus',
	])
	// Services are asked for by path, on the address we were given rather than the one the camera reported
	assert.ok(received.find((r) => r.operation === 'GetProfiles')?.path === '/onvif/Media')
	assert.ok(received.find((r) => r.operation === 'GetStatus')?.body.includes('Profile_1'))

	for (let pan = 10; pan <= 100; pan += 10) {
		camera.setMotion({ pan, tilt: 0, zoom: 20, focus: 0 })
		await sleep(5)
	}
	await sleep(150)
	await camera.close()

	const moves = received.filter((r) => r.operation === 'ContinuousMove')
	assert.ok(moves.length > 0 && moves.length < 10, `skipped stale positions (sent ${moves.length})`)
	const last = moves.at(-1)!
	assert.equal(last.path, '/onvif/PTZ')
	assert.match(last.body, /<tt:PanTilt x="1" y="0"\/><tt:Zoom x="0.2"\/>/, 'pan and zoom together')
	assert.match(last.body, /<tptz:Timeout>PT1S<\/tptz:Timeout>/)

	const lastMove = received.lastIndexOf(last)
	const stops = received.slice(lastMove).filter((r) => r.operation === 'Stop')
	assert.ok(
		stops.some((r) => r.path === '/onvif/PTZ' && r.body.includes('<tptz:PanTilt>true</tptz:PanTilt>')),
		'PTZ stopped on close',
	)
	assert.ok(
		stops.some((r) => r.path === '/onvif/Imaging'),
		'focus stopped on close',
	)
})

test('onvif: presets, focus and faults', async (t) => {
	const { received, port } = await fakeCamera(t, {
		answers: {
			GotoHomePosition: () => ({ status: 500, xml: faultXml('ter:Action', 'No home position') }),
		},
	})
	const camera = flying(t, cameraConfig(port))
	await sleep(80)

	camera.command({ type: 'presetRecall', preset: 1 })
	await sleep(40)
	assert.match(
		received.find((r) => r.operation === 'GotoPreset')?.body ?? '',
		/<tptz:PresetToken>2<\/tptz:PresetToken>/,
	)

	camera.command({ type: 'presetSet', preset: 0 })
	await sleep(40)
	assert.match(
		received.find((r) => r.operation === 'SetPreset')?.body ?? '',
		/<tptz:PresetName>Preset 1<\/tptz:PresetName><tptz:PresetToken>1<\/tptz:PresetToken>/,
	)

	camera.command({ type: 'presetRecall', preset: 8 })
	await sleep(40)
	assert.equal(camera.status.error, 'The camera has no preset 9')

	camera.command({ type: 'home' })
	await sleep(40)
	assert.equal(camera.status.error, 'The camera refused GotoHomePosition: No home position')

	camera.setMotion({ pan: 0, tilt: 0, zoom: 0, focus: -50 })
	await sleep(40)
	assert.match(received.find((r) => r.operation === 'Move')?.body ?? '', /<tt:Speed>-0.5<\/tt:Speed>/)
	assert.equal(camera.status.error, undefined, 'a good reply clears the error')

	camera.command({ type: 'autoFocus', enabled: true })
	await sleep(40)
	assert.match(
		received.find((r) => r.operation === 'SetImagingSettings')?.body ?? '',
		/<tt:AutoFocusMode>AUTO<\/tt:AutoFocusMode>/,
	)

	await camera.close()
})

test('onvif: autoFocusToggle reads the mode then sends the opposite', async (t) => {
	for (const [start, written] of [
		['AUTO', 'MANUAL'],
		['MANUAL', 'AUTO'],
	] as const) {
		// Stateful imaging: SetImagingSettings changes what GetImagingSettings returns next
		let mode = start
		const { received, port } = await fakeCamera(t, {
			answers: {
				GetImagingSettings: () => ({
					xml: `<timg:GetImagingSettingsResponse><timg:ImagingSettings><tt:Focus><tt:AutoFocusMode>${mode}</tt:AutoFocusMode></tt:Focus></timg:ImagingSettings></timg:GetImagingSettingsResponse>`,
				}),
				SetImagingSettings: (body) => {
					const m = body.match(/<tt:AutoFocusMode>(\w+)<\/tt:AutoFocusMode>/)
					if (m) mode = m[1] as typeof mode
					return { xml: '<timg:SetImagingSettingsResponse/>' }
				},
			},
		})
		const camera = flying(t, cameraConfig(port))
		await sleep(80)
		camera.command({ type: 'autoFocusToggle' })
		await sleep(60)
		const set = received.find((r) => r.operation === 'SetImagingSettings')
		assert.match(
			set?.body ?? '',
			new RegExp(`<tt:AutoFocusMode>${written}</tt:AutoFocusMode>`),
			`${start} -> ${written}`,
		)
		assert.equal(camera.status.autoFocus, written === 'MANUAL' ? 'off' : 'on')
		await camera.close()
	}
})

test('onvif: an inquiry during a pending one-push does not corrupt the final state', async (t) => {
	// One-push turns AF on, then after ONE_PUSH_TIME switches back to manual (#backToManual).
	// A refresh during that window must not leave the surfaced state stuck on 'on'.
	let mode = 'MANUAL'
	const { received, port } = await fakeCamera(t, {
		answers: {
			GetImagingSettings: () => ({
				xml: `<timg:GetImagingSettingsResponse><timg:ImagingSettings><tt:Focus><tt:AutoFocusMode>${mode}</tt:AutoFocusMode></tt:Focus></timg:ImagingSettings></timg:GetImagingSettingsResponse>`,
			}),
			SetImagingSettings: (body) => {
				const m = body.match(/<tt:AutoFocusMode>(\w+)<\/tt:AutoFocusMode>/)
				if (m) mode = m[1] as typeof mode
				return { xml: '<timg:SetImagingSettingsResponse/>' }
			},
		},
	})
	const camera = flying(t, cameraConfig(port))
	await sleep(80)
	camera.command({ type: 'onePushFocus' })
	// Wait past ONE_PUSH_TIME (2000ms) so #backToManual has run
	await sleep(2300)
	assert.equal(camera.status.autoFocus, 'off', 'ends in manual once one-push completes')
	assert.ok(received.some((r) => r.operation === 'SetImagingSettings'))
	await camera.close()
})

test('onvif: a camera without imaging says so instead of focusing', async (t) => {
	const { port } = await fakeCamera(t, {
		answers: {
			GetServices: () => ({
				xml: `<tds:Service><tds:Namespace>${soap.NS.trt}</tds:Namespace><tds:XAddr>/onvif/Media</tds:XAddr></tds:Service><tds:Service><tds:Namespace>${soap.NS.tptz}</tds:Namespace><tds:XAddr>/onvif/PTZ</tds:XAddr></tds:Service>`,
			}),
		},
	})
	const camera = flying(t, cameraConfig(port))
	await sleep(60)
	camera.command({ type: 'onePushFocus' })
	await sleep(40)
	assert.match(camera.status.error ?? '', /no ONVIF imaging service/)
	assert.ok(camera.status.connected)
	await camera.close()
})

test('onvif: finds services with GetCapabilities when GetServices falls short', async (t) => {
	const { received, port } = await fakeCamera(t, {
		answers: {
			GetServices: () => ({ status: 500, xml: faultXml('ter:ActionNotSupported', 'Not supported') }),
			GetCapabilities: () => ({
				xml: '<tds:Capabilities><tt:Imaging><tt:XAddr>http://10.0.0.9/img</tt:XAddr></tt:Imaging><tt:Media><tt:XAddr>http://10.0.0.9/media</tt:XAddr></tt:Media><tt:PTZ><tt:XAddr>http://10.0.0.9/ptz</tt:XAddr></tt:PTZ></tds:Capabilities>',
			}),
		},
	})
	const camera = flying(t, cameraConfig(port))
	await sleep(80)
	camera.setMotion({ pan: 0, tilt: 0, zoom: 0, focus: 10 })
	await sleep(40)
	assert.equal(camera.status.error, undefined)
	assert.equal(received.find((r) => r.operation === 'GetProfiles')?.path, '/media')
	assert.equal(received.find((r) => r.operation === 'GetStatus')?.path, '/ptz')
	assert.equal(received.find((r) => r.operation === 'Move')?.path, '/img')
	await camera.close()
})

test('onvif: falls back to HTTP Digest, and says when the login is wrong', async (t) => {
	const { received, port } = await fakeCamera(t, { digest: true })

	const camera = flying(t, cameraConfig(port))
	await sleep(80)
	camera.command({ type: 'home' })
	await sleep(40)
	assert.equal(camera.status.error, undefined)
	assert.ok(received.some((r) => r.operation === 'GotoHomePosition'))
	await camera.close()

	const wrong = flying(t, cameraConfig(port, { password: 'nope' }))
	await sleep(80)
	assert.equal(wrong.status.error, 'The camera rejected the user name or password')
	await wrong.close()

	const anonymous = flying(t, cameraConfig(port, { username: '', password: '' }))
	await sleep(80)
	assert.equal(anonymous.status.error, 'The camera needs a user name and password')
	await anonymous.close()
})

test('onvif: a camera that refuses move timeouts is flown without them', async (t) => {
	const { received, port } = await fakeCamera(t, {
		answers: {
			ContinuousMove: (body) =>
				body.includes('Timeout')
					? { status: 500, xml: faultXml('ter:InvalidArgVal', 'Timeout out of range') }
					: undefined,
		},
	})
	const camera = flying(t, cameraConfig(port))
	await sleep(60)
	camera.setMotion({ pan: 20, tilt: 0, zoom: 0, focus: 0 })
	await sleep(40)
	camera.setMotion({ pan: 30, tilt: 0, zoom: 0, focus: 0 })
	await sleep(40)
	assert.equal(camera.status.error, undefined)
	await camera.close()

	const moves = received.filter((r) => r.operation === 'ContinuousMove')
	assert.equal(moves.filter((r) => r.body.includes('Timeout')).length, 1, 'only tried once')
	assert.match(moves.at(-1)!.body, /x="0.3"/)
})

test('onvif: an unreachable camera shows as disconnected', async (t) => {
	const { server, port } = await fakeCamera(t)
	server.close()
	await once(server, 'close')

	const camera = flying(t, cameraConfig(port))
	await sleep(100)
	assert.equal(camera.status.connected, false)
	assert.ok(camera.status.error)
	await camera.close()
})

// --- Discovery ---------------------------------------------------------------

const probeMatch = (xaddrs: string, scopes: string) =>
	'<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><s:Body><d:ProbeMatches><d:ProbeMatch>' +
	`<d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types><d:Scopes>${scopes}</d:Scopes><d:XAddrs>${xaddrs}</d:XAddrs>` +
	'</d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>'

test('onvif discovery: one probe per type, and answers read for host, port and name', () => {
	const probe = discovery.probeMessage('dn:NetworkVideoTransmitter', 'uuid:1')
	assert.match(probe, /<d:Probe><d:Types>dn:NetworkVideoTransmitter<\/d:Types><\/d:Probe>/)
	assert.match(probe, /<a:MessageID>uuid:1<\/a:MessageID>/)
	assert.match(probe, /discovery\/Probe<\/a:Action>/)
	assert.deepEqual(discovery.PROBE_TYPES, ['dn:NetworkVideoTransmitter', 'tds:Device'])

	const xml = probeMatch(
		'http://169.254.1.2/onvif/device_service http://192.168.1.64:8000/onvif/device_service http://[fe80::1]/onvif/device_service',
		'onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/HIKVISION%20DS-2DE4A425 onvif://www.onvif.org/hardware/DS-2DE4A425IW-DE',
	)
	assert.deepEqual(discovery.parseProbeMatches(xml), [
		{ host: '192.168.1.64', port: 8000, name: 'HIKVISION DS-2DE4A425', hardware: 'DS-2DE4A425IW-DE' },
	])
	// The address it answered from wins when it's listed
	assert.equal(discovery.parseProbeMatches(xml, '169.254.1.2')[0]?.host, '169.254.1.2')
	assert.deepEqual(discovery.parseProbeMatches('<x/>'), [])
})

test('onvif discovery: collects answers once each', async () => {
	const responder = dgram.createSocket('udp4')
	const probes: string[] = []
	responder.on('message', (message, rinfo) => {
		probes.push(message.toString())
		// Answer both probes, as cameras claiming both types do
		const reply = Buffer.from(probeMatch('http://10.1.1.5/onvif/device_service', 'onvif://www.onvif.org/name/PTZ_Cam'))
		responder.send(reply, rinfo.port, rinfo.address)
	})
	responder.bind(0, '127.0.0.1')
	await once(responder, 'listening')

	const port = (responder.address() as AddressInfo).port
	const found = await discovery.discover(150, { address: '127.0.0.1', port })
	responder.close()
	assert.equal(probes.length, 2)
	assert.deepEqual(found, [{ host: '10.1.1.5', port: 80, name: 'PTZ Cam', hardware: '' }])
})
