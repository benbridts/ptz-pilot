/**
 * Hanwha's SUNAPI (STW-CGI): query strings over HTTP GET, spoken by Hanwha Vision (Wisenet,
 * formerly Samsung Techwin) PTZ cameras. Movement is
 * `/stw-cgi/ptzcontrol.cgi?msubmenu=continuous&action=control&NormalizedSpeed=True&Pan=..&Tilt=..&Zoom=..`
 * carrying every axis together:
 *
 * - with `NormalizedSpeed=True` each speed is a percentage of the camera's top speed, -100 to 100
 * - positive pan is right, positive tilt is up, positive zoom is tele
 * - focus rides along as `Focus=Near|Far|Stop`: a direction, with no speed
 * - `msubmenu=stop&OperationType=All` stops everything at once
 *
 * The camera is channel 0; SUNAPI counts channels from 0. Presets are numbered from 1 on the
 * camera, against 0-based in the rest of the app.
 *
 * Errors come back as `NG` and an `Error Code` / `Error Details` pair, or the same in JSON, often
 * with HTTP 200, so the body is read whatever the status.
 *
 * The camera asks for a login by HTTP Digest, and blocks an address after a few failed logins
 * (5 by default), so a rejected password backs off, not retries.
 */
import { EventEmitter } from 'node:events'
import { digestHeader, parseChallenge } from '../canon/xc.js'
import type { CameraCommand, CameraConfig, CameraLink, LinkEvents } from '../visca/camera.js'

/** A camera is channel 0 */
export const CHANNEL = 0
export const MAX_SPEED = 100
/** Most Wisenet PTZ cameras keep 300; the camera refuses past its own limit */
export const MAX_PRESET = 300

const REQUEST_TIMEOUT = 2000
/** On close, how long to wait for the final stop to get through */
const CLOSE_TIMEOUT = 1000
/** After a rejected password, wait this long before trying again, doubling each time */
const AUTH_BACKOFF = 60_000
const MAX_AUTH_BACKOFF = 30 * 60_000

export interface SunapiRequest {
	/** Path and query; SUNAPI is all GETs */
	path: string
}

/** One CGI call: `/stw-cgi/<cgi>.cgi?msubmenu=..&action=..&Channel=0&...` */
export function cgi(name: string, submenu: string, action: string, params: Record<string, string | number> = {}) {
	const query = new URLSearchParams({ msubmenu: submenu, action, Channel: String(CHANNEL) })
	for (const [key, value] of Object.entries(params)) query.set(key, String(value))
	// SUNAPI lists values with bare commas, and some firmware doesn't decode %2C
	return { path: `/stw-cgi/${name}.cgi?${query.toString().replaceAll('%2C', ',')}` }
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Math.round(value), min), max)
}

/** Pan and tilt arrive as 1..max already; 0 stops */
function percent(speed: number, max: number): number {
	if (speed === 0) return 0
	return Math.sign(speed) * clamp(Math.abs(speed), 1, Math.min(Math.max(max, 1), MAX_SPEED))
}

/** Zoom arrives 1-based as elsewhere in the app: 1..max+1, onto the camera's 1..100 */
const oneBased = (speed: number, max: number) => percent(speed, max + 1)

export interface Speeds {
	pan: number
	tilt: number
	zoom: number
	focus: number
}

export type FocusDirection = 'Near' | 'Far' | 'Stop'

export const focusDirection = (speed: number): FocusDirection => (speed > 0 ? 'Far' : speed < 0 ? 'Near' : 'Stop')

export const STOP: SunapiRequest = cgi('ptzcontrol', 'stop', 'control', { OperationType: 'All' })

/**
 * All axes go in one request, so the caller passes whatever the other axes are doing. Focus is
 * left out unless it is moving or `stopFocus` says it just was: a `Focus=Stop` with every other
 * move could knock the camera out of auto focus.
 */
export function continuous(
	speeds: Speeds,
	config: Pick<CameraConfig, 'maxPan' | 'maxTilt' | 'maxZoom'>,
	stopFocus = false,
): SunapiRequest {
	const pan = percent(speeds.pan, config.maxPan)
	const tilt = percent(speeds.tilt, config.maxTilt)
	const zoom = oneBased(speeds.zoom, config.maxZoom)
	if (pan === 0 && tilt === 0 && zoom === 0 && speeds.focus === 0) return STOP
	const params: Record<string, string | number> = { NormalizedSpeed: 'True', Pan: pan, Tilt: tilt, Zoom: zoom }
	if (speeds.focus !== 0 || stopFocus) params.Focus = focusDirection(speeds.focus)
	return cgi('ptzcontrol', 'continuous', 'control', params)
}

/** A one-off command: one request, or saving a preset (add, then update if it exists), or a reason it can't be sent */
export function commandRequest(command: CameraCommand): SunapiRequest | { savePreset: number } | string {
	switch (command.type) {
		case 'presetRecall':
		case 'presetSet': {
			const id = command.preset + 1
			if (!Number.isInteger(id) || id < 1 || id > MAX_PRESET) return `Hanwha cameras have presets 1-${MAX_PRESET}`
			if (command.type === 'presetRecall') return cgi('ptzcontrol', 'preset', 'control', { Preset: id })
			return { savePreset: id }
		}
		case 'home':
			return cgi('ptzcontrol', 'home', 'control')
		case 'autoFocus':
			return cgi('image', 'focus', 'set', { FocusMode: command.enabled ? 'Auto' : 'Manual' })
		case 'onePushFocus':
			return cgi('image', 'focus', 'control', { Mode: 'SimpleFocus' })
		case 'tally':
			return 'Tally control is not implemented for Hanwha cameras'
	}
}

/** Preset names are short and plain on Wisenet cameras: letters and digits, up to 12 */
export const savePreset = (id: number, action: 'add' | 'update'): SunapiRequest =>
	cgi('ptzconfig', 'preset', action, { Preset: id, Name: `Preset${id}` })

/** How a refused command is named in the error */
function describeCommand(command: CameraCommand): string {
	switch (command.type) {
		case 'presetRecall':
			return `preset ${command.preset + 1}`
		case 'presetSet':
			return `saving preset ${command.preset + 1}`
		case 'home':
			return 'going home'
		case 'autoFocus':
			return 'the focus mode'
		case 'onePushFocus':
			return 'one-push focus'
		case 'tally':
			return 'the tally light'
	}
}

/** Present on every SUNAPI camera, PTZ or not, and small */
export const PING: SunapiRequest = { path: '/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view' }

// --- Answers -----------------------------------------------------------------

export interface SunapiError {
	code: number | undefined
	details: string | undefined
}

/** The error a body reports, in either the text or the JSON form, or undefined if it reports none */
export function parseError(body: string): SunapiError | undefined {
	const text = body.trim()
	if (text.startsWith('{')) {
		try {
			const json = JSON.parse(text) as { Response?: string; Error?: { Code?: number; Details?: string } }
			if (!json.Error && json.Response !== 'Fail') return undefined
			return { code: json.Error?.Code, details: json.Error?.Details }
		} catch {
			return undefined
		}
	}
	if (!/^NG\b/.test(text) && !/Error Code\s*:/i.test(text)) return undefined
	const code = Number.parseInt(text.match(/Error Code\s*:\s*(\d+)/i)?.[1] ?? '', 10)
	return {
		code: Number.isFinite(code) ? code : undefined,
		details: text.match(/Error Details\s*:\s*(.+)/i)?.[1]?.trim(),
	}
}

/** What to show for a refused request, or undefined if it went through */
export function describeError(what: string, httpStatus: number, body: string): string | undefined {
	const error = parseError(body)
	const ok = httpStatus >= 200 && httpStatus < 300
	if (ok && !error) return undefined
	if (!error || (error.code === undefined && !error.details)) return `The camera refused ${what} (HTTP ${httpStatus})`
	const detail = error.details ?? `error ${error.code}`
	return `The camera refused ${what}: ${detail}${error.details && error.code !== undefined ? ` (${error.code})` : ''}`
}

/** How long to hold off after a rejected login, and what to say about it */
export function authFailure(previousBackoff: number): { backoff: number; error: string } {
	const backoff = previousBackoff ? Math.min(previousBackoff * 2, MAX_AUTH_BACKOFF) : AUTH_BACKOFF
	const m = Math.ceil(backoff / 60_000)
	return {
		backoff,
		error:
			`The camera rejected the user name or password. Hanwha cameras block logins after a few failures, ` +
			`so PTZ Pilot waits ${m === 1 ? '1 minute' : `${m} minutes`} before trying again, or until the camera is saved.`,
	}
}

// --- The link ----------------------------------------------------------------

interface Answer {
	status: number
	body: string
}

/**
 * One request at a time, as for Hikvision: while one is out, `ready` is false and the camera's
 * pump holds off, so the next request carries the latest stick position rather than a backlog.
 */
export class HanwhaLink extends EventEmitter<LinkEvents> implements CameraLink {
	readonly #config: CameraConfig
	#inFlight: Promise<void> | undefined
	#closed = true
	#connected = false
	/** The speeds last asked for. Every axis shares a request, so each change carries the others. */
	readonly #speeds: Speeds = { pan: 0, tilt: 0, zoom: 0, focus: 0 }
	/** Focus was last sent moving, so the next request has to stop it */
	#focusMoving = false
	/** Kept between requests, so a live challenge is reused rather than paying for a 401 each time */
	#challenge: ReturnType<typeof parseChallenge> | undefined
	#nonceCount = 0
	/** After a rejected login, nothing is sent until then */
	#authBlockedUntil = 0
	#authBackoff = 0

	constructor(config: CameraConfig) {
		super()
		this.#config = config
	}

	/** Still true while backing off from a failed login, so the pump drops stale commands, not queues them */
	get ready(): boolean {
		return !this.#inFlight && !this.#closed
	}

	open(): void {
		this.#closed = false
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		// With the password refused, a stop can't get through and would count as another failed login
		if (!this.#authBlocked) {
			// Stop alongside whatever is still out, rather than behind it
			const stop = this.#request('the stop', () => this.#exchange(STOP))
			await Promise.race([Promise.allSettled([stop, this.#inFlight]), sleep(CLOSE_TIMEOUT)])
		}
		this.emit('status', false)
	}

	panTilt(pan: number, tilt: number): void {
		this.#speeds.pan = pan
		this.#speeds.tilt = tilt
		this.#move()
	}

	zoom(speed: number): void {
		this.#speeds.zoom = speed
		this.#move()
	}

	focus(speed: number): void {
		this.#speeds.focus = speed
		this.#move()
	}

	command(command: CameraCommand): void {
		const request = commandRequest(command)
		if (typeof request === 'string') this.emit('reply', { error: request })
		else if ('savePreset' in request) this.#run(describeCommand(command), () => this.#savePreset(request.savePreset))
		else this.#send(describeCommand(command), request)
	}

	ping(): void {
		this.#send('the status request', PING)
	}

	#move(): void {
		if (!this.ready || this.#authBlocked) return
		const request = continuous(this.#speeds, this.#config, this.#focusMoving)
		this.#focusMoving = this.#speeds.focus !== 0
		this.#send('movement', request)
	}

	/** `add` refuses a number already in use, and `update` one not yet saved */
	async #savePreset(id: number): Promise<Answer> {
		const added = await this.#exchange(savePreset(id, 'add'))
		if (added.status === 401 || !describeError('', added.status, added.body)) return added
		return this.#exchange(savePreset(id, 'update'))
	}

	#send(what: string, request: SunapiRequest): void {
		this.#run(what, () => this.#exchange(request))
	}

	#run(what: string, work: () => Promise<Answer>): void {
		if (!this.ready || this.#authBlocked) return
		const done = this.#request(what, work).finally(() => {
			if (this.#inFlight === done) this.#inFlight = undefined
		})
		this.#inFlight = done
	}

	get #authBlocked(): boolean {
		return Date.now() < this.#authBlockedUntil
	}

	async #request(what: string, work: () => Promise<Answer>): Promise<void> {
		try {
			const { status, body } = await work()
			this.#setConnected(true)

			if (status === 401) {
				if (!this.#hasCredentials) {
					this.emit('reply', { error: 'The camera needs a user name and password' })
					return
				}
				// Don't replay a challenge that just failed
				this.#challenge = undefined
				const { backoff, error } = authFailure(this.#authBackoff)
				this.#authBackoff = backoff
				this.#authBlockedUntil = Date.now() + backoff
				this.emit('reply', { error })
				return
			}
			this.#authBackoff = 0
			this.emit('reply', { error: describeError(what, status, body) })
		} catch (e) {
			const error = e as Error & { cause?: Error }
			const message =
				error.name === 'TimeoutError' ? 'No answer from the camera' : (error.cause?.message ?? error.message)
			this.#setConnected(false, message)
		}
	}

	/** One request, answering a fresh challenge once if the camera asks for one */
	async #exchange(request: SunapiRequest): Promise<Answer> {
		const { host, port } = this.#config
		const url = `http://${host}:${port || 80}${request.path}`

		let response = await this.#fetch(url, request)
		if (response.status === 401 && this.#hasCredentials) {
			const header = response.headers.get('www-authenticate')
			if (header) {
				await response.arrayBuffer()
				this.#challenge = parseChallenge(header)
				this.#nonceCount = 0
				response = await this.#fetch(url, request)
			}
		}
		// Read the body whatever it is: errors arrive in it, and the connection can then be kept
		return { status: response.status, body: await response.text() }
	}

	#fetch(url: string, request: SunapiRequest): Promise<Response> {
		const headers: Record<string, string> = {}
		const auth = this.#authorization(request)
		if (auth) headers.authorization = auth
		return fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
	}

	get #hasCredentials(): boolean {
		return this.#config.username !== '' && this.#config.password !== ''
	}

	#authorization(request: SunapiRequest): string | undefined {
		const { username, password } = this.#config
		if (!this.#hasCredentials || !this.#challenge) return undefined
		if (this.#challenge.scheme.toLowerCase() === 'digest')
			return digestHeader(this.#challenge, username, password, 'GET', request.path, ++this.#nonceCount)
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
