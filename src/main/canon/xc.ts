/**
 * Canon's XC protocol: plain HTTP GETs under `/-wvhttp-01-/`, spoken by the CR-N and CR-X PTZ
 * cameras (and the XF605). Movement goes to `control.cgi` as a direction and a speed:
 *
 * - pan and tilt speeds are hundredths of a degree a second, 10 (0.1°/s) to 10000 (100°/s)
 * - zoom speed is 0-127
 * - focus speed is a separate setting: 0, 1 or 2 for low, medium, high
 *
 * Presets are numbered 1-100 on the camera, against 0-based in the rest of the app.
 *
 * A camera with guest access needs no login. One without asks for HTTP Digest (or Basic) auth.
 */
import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import type { CameraCommand, CameraConfig, CameraLink, LinkEvents } from '../visca/camera.js'

const BASE_PATH = '/-wvhttp-01-/'
const CONTROL = 'control.cgi'

/** The slowest pan or tilt speed the cameras accept */
export const MIN_PAN_TILT_SPEED = 10
export const MAX_PRESET = 100

const REQUEST_TIMEOUT = 2000
/** On close, how long to wait for the final stop to get through */
const CLOSE_TIMEOUT = 1000

/** A request: the path under BASE_PATH, and its parameters in the order they go on the URL */
export interface XcRequest {
	path: string
	params: [string, string][]
}

const control = (...params: [string, string][]): XcRequest => ({ path: CONTROL, params })

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Math.round(value), min), max)
}

/** Positive pan is right, positive tilt is up. 0 stops that axis. */
export function panTilt(pan: number, tilt: number, maxPan: number, maxTilt: number): XcRequest {
	const axis = (name: string, speed: number, max: number, forward: string, back: string): [string, string][] =>
		speed === 0
			? [[name, 'stop']]
			: [
					[name, speed > 0 ? forward : back],
					[`${name}.speed.dir`, String(clamp(Math.abs(speed), MIN_PAN_TILT_SPEED, Math.max(max, MIN_PAN_TILT_SPEED)))],
				]
	return control(...axis('pan', pan, maxPan, 'right', 'left'), ...axis('tilt', tilt, maxTilt, 'up', 'down'))
}

/** Speeds are 1-based as elsewhere in the app, so 1 is the camera's slowest, 0. Positive is tele. */
export function zoom(speed: number, maxSpeed: number): XcRequest {
	if (speed === 0) return control(['zoom', 'stop'])
	return control(
		['zoom', speed > 0 ? 'tele' : 'wide'],
		['zoom.speed.dir', String(clamp(Math.abs(speed) - 1, 0, maxSpeed))],
	)
}

/** As zoom: 1-3 here for low, medium, high. Positive focuses further away. Manual focus only. */
export function focus(speed: number, maxSpeed: number): XcRequest {
	if (speed === 0) return control(['focus.action', 'stop'])
	return control(
		['focus.speed', String(clamp(Math.abs(speed) - 1, 0, Math.min(maxSpeed, 2)))],
		['focus.action', speed > 0 ? 'far' : 'near'],
	)
}

export function stopAll(): XcRequest {
	return control(['pan', 'stop'], ['tilt', 'stop'], ['zoom', 'stop'], ['focus.action', 'stop'])
}

/** The request for a command, or a reason it can't be sent */
export function commandRequest(command: CameraCommand): XcRequest | string {
	switch (command.type) {
		case 'presetRecall':
		case 'presetSet': {
			const p = command.preset + 1
			if (!Number.isInteger(p) || p < 1 || p > MAX_PRESET) return `Canon cameras have presets 1-${MAX_PRESET}`
			if (command.type === 'presetRecall') return control(['p', String(p)])
			return {
				path: 'preset/set',
				params: [
					['p', String(p)],
					['name', `Preset ${p}`],
					['all', 'enabled'],
				],
			}
		}
		case 'home':
			return control(['pan', '0'], ['tilt', '0'])
		case 'autoFocus':
			return control(['focus', command.enabled ? 'auto' : 'manual'])
		case 'onePushFocus':
			return control(['c.1.focus.action', 'one_shot'])
	}
}

/** Ask for a single item, so a ping stays small */
export const PING: XcRequest = { path: 'info.cgi', params: [['item', 'c.1.type']] }

export function requestPath(request: XcRequest): string {
	const query = new URLSearchParams(request.params).toString()
	return BASE_PATH + request.path + (query ? `?${query}` : '')
}

// --- Auth --------------------------------------------------------------------

interface Challenge {
	scheme: string
	params: Record<string, string>
}

export function parseChallenge(header: string): Challenge {
	const scheme = header.split(' ')[0] ?? ''
	const params: Record<string, string> = {}
	for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? ''
	return { scheme, params }
}

const md5 = (value: string) => createHash('md5').update(value).digest('hex')

/** RFC 2617 Digest, qop=auth when offered */
export function digestHeader(
	challenge: Challenge,
	username: string,
	password: string,
	method: string,
	uri: string,
	nonceCount: number,
	cnonce = randomBytes(8).toString('hex'),
): string {
	const { realm = '', nonce = '', qop, opaque } = challenge.params
	const ha1 = md5(`${username}:${realm}:${password}`)
	const ha2 = md5(`${method}:${uri}`)
	const useQop = qop?.split(',').some((q) => q.trim() === 'auth')
	const nc = String(nonceCount).padStart(8, '0')
	const response = useQop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`)

	let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
	if (opaque) header += `, opaque="${opaque}"`
	if (useQop) header += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`
	return header
}

// --- The link ----------------------------------------------------------------

/**
 * One request at a time. While one is out, `ready` is false and the camera's pump holds off, so
 * when the answer comes back the next request carries the latest stick position, not a backlog.
 */
export class CanonLink extends EventEmitter<LinkEvents> implements CameraLink {
	readonly #config: CameraConfig
	#inFlight: Promise<void> | undefined
	#closed = true
	#connected = false
	/** Kept between requests, so a live challenge is reused rather than paying for a 401 each time */
	#challenge: Challenge | undefined
	#nonceCount = 0

	constructor(config: CameraConfig) {
		super()
		this.#config = config
	}

	get ready(): boolean {
		return !this.#inFlight && !this.#closed
	}

	open(): void {
		this.#closed = false
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		// Stop alongside whatever is still out, rather than behind it
		const stop = this.#request(stopAll())
		await Promise.race([Promise.allSettled([stop, this.#inFlight]), sleep(CLOSE_TIMEOUT)])
		this.emit('status', false)
	}

	panTilt(pan: number, tilt: number): void {
		this.#send(panTilt(pan, tilt, this.#config.maxPan, this.#config.maxTilt))
	}

	zoom(speed: number): void {
		this.#send(zoom(speed, this.#config.maxZoom))
	}

	focus(speed: number): void {
		this.#send(focus(speed, this.#config.maxFocus))
	}

	command(command: CameraCommand): void {
		const request = commandRequest(command)
		if (typeof request === 'string') this.emit('reply', { error: request })
		else this.#send(request)
	}

	ping(): void {
		this.#send(PING)
	}

	#send(request: XcRequest): void {
		if (!this.ready) return
		const done = this.#request(request).finally(() => {
			if (this.#inFlight === done) this.#inFlight = undefined
		})
		this.#inFlight = done
	}

	async #request(request: XcRequest): Promise<void> {
		const { host, port } = this.#config
		const path = requestPath(request)
		const url = `http://${host}:${port || 80}${path}`

		try {
			let response = await this.#fetch(url, path)
			if (response.status === 401 && this.#hasCredentials) {
				const header = response.headers.get('www-authenticate')
				if (header) {
					this.#challenge = parseChallenge(header)
					this.#nonceCount = 0
					response = await this.#fetch(url, path)
				}
			}
			// Drain the body, so the connection can be kept for the next request
			await response.arrayBuffer()
			this.#setConnected(true)

			if (response.status === 401) {
				// Don't replay a challenge that just failed
				this.#challenge = undefined
				this.emit('reply', {
					error: this.#hasCredentials
						? 'The camera rejected the user name or password'
						: 'The camera needs a user name and password',
				})
			} else if (!response.ok) {
				this.emit('reply', { error: `The camera refused ${request.path} (HTTP ${response.status})` })
			} else {
				this.emit('reply', { error: undefined })
			}
		} catch (e) {
			const error = e as Error & { cause?: Error }
			const message =
				error.name === 'TimeoutError' ? 'No answer from the camera' : (error.cause?.message ?? error.message)
			this.#setConnected(false, message)
		}
	}

	#fetch(url: string, path: string): Promise<Response> {
		const headers: Record<string, string> = {}
		const auth = this.#authorization(path)
		if (auth) headers.authorization = auth
		return fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
	}

	get #hasCredentials(): boolean {
		return this.#config.username !== '' && this.#config.password !== ''
	}

	#authorization(path: string): string | undefined {
		const { username, password } = this.#config
		if (!this.#hasCredentials || !this.#challenge) return undefined
		if (this.#challenge.scheme.toLowerCase() === 'digest')
			return digestHeader(this.#challenge, username, password, 'GET', path, ++this.#nonceCount)
		return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
	}

	#setConnected(connected: boolean, error?: string): void {
		if (this.#closed && connected) return
		if (connected === this.#connected && !error) return
		this.#connected = connected
		this.emit('status', connected, error)
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())
