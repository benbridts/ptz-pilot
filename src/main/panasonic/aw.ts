/**
 * Panasonic's AW protocol: HTTP GETs to `/cgi-bin/aw_ptz` (pan, tilt, lens) and `/cgi-bin/aw_cam`
 * (camera settings), spoken by the AW-HE and AW-UE PTZ cameras. Each takes one short text command
 * and, with `res=1`, answers with a short text echo: `#PTS5050` gets `pTS5050`.
 *
 * Pan, tilt, zoom and focus speeds are two digits centred on 50: 50 stops, 51-99 go right, up,
 * tele or far, and 49-01 the other way, so each direction has 49 speeds.
 *
 * Presets are numbered 00-99 on the wire, matching the 0-based numbers in the rest of the app.
 *
 * Panasonic asks for a gap between commands to one camera: 130 ms on the AW-HE series, less on
 * newer models (40 ms on the AW-UE80, 16 ms on the AW-UE160). The camera's send interval keeps it.
 *
 * Most cameras need no login for these commands. Newer firmware can ask for HTTP Digest or Basic.
 */
import { EventEmitter } from 'node:events'
import type { AutoFocusState, CameraCommand, CameraConfig, CameraLink, LinkEvents } from '../visca/camera.js'
import { digestHeader, parseChallenge } from '../canon/xc.js'

/** Steps each side of the stop value, 50 */
export const MAX_SPEED = 49
export const MAX_PRESET = 99

const REQUEST_TIMEOUT = 2000
/** On close, how long to wait for the final stops to get through */
const CLOSE_TIMEOUT = 1500

export interface AwRequest {
	cgi: 'aw_ptz' | 'aw_cam'
	cmd: string
}

const ptz = (cmd: string): AwRequest => ({ cgi: 'aw_ptz', cmd })

/** 50 plus or minus the speed, clamped to 1..max (and never past 49), as two digits */
export function speedDigits(speed: number, max: number): string {
	if (speed === 0) return '50'
	const step = Math.min(Math.max(Math.round(Math.abs(speed)), 1), Math.min(Math.max(max, 1), MAX_SPEED))
	return String(50 + Math.sign(speed) * step).padStart(2, '0')
}

/** Positive pan is right, positive tilt is up. Both axes go in one command. */
export function panTilt(pan: number, tilt: number, maxPan: number, maxTilt: number): AwRequest {
	return ptz(`#PTS${speedDigits(pan, maxPan)}${speedDigits(tilt, maxTilt)}`)
}

/** Speeds are 1-based as elsewhere in the app, onto the camera's 49 steps. Positive is tele. */
export function zoom(speed: number, maxSpeed: number): AwRequest {
	return ptz(`#Z${speedDigits(speed, maxSpeed + 1)}`)
}

/** As zoom. Positive focuses further away. Manual focus only: in auto the camera answers eR3. */
export function focus(speed: number, maxSpeed: number): AwRequest {
	return ptz(`#F${speedDigits(speed, maxSpeed + 1)}`)
}

export const STOP_PAN_TILT = panTilt(0, 0, 1, 1)
export const STOP_ZOOM = zoom(0, 0)
export const STOP_FOCUS = focus(0, 0)

/** A one-off command: a single request, or the toggle (flip the surfaced state), or a reason it can't be sent */
export function commandRequest(command: CameraCommand): AwRequest | { toggle: true } | string {
	switch (command.type) {
		case 'presetRecall':
		case 'presetSet': {
			const p = command.preset
			if (!Number.isInteger(p) || p < 0 || p > MAX_PRESET) return `Panasonic cameras have presets 1-${MAX_PRESET + 1}`
			return ptz(`#${command.type === 'presetRecall' ? 'R' : 'M'}${String(p).padStart(2, '0')}`)
		}
		case 'home':
			// The spec names 8000h, 8000h as the home position
			return ptz('#APC80008000')
		case 'autoFocus':
			return ptz(`#D1${command.enabled ? 1 : 0}`)
		case 'autoFocusToggle':
			return { toggle: true }
		case 'onePushFocus':
			return { cgi: 'aw_cam', cmd: 'OSE:69:1' }
	}
}

/** The focus set for a given mode: `#D11` auto, `#D10` manual */
export const focusSet = (auto: boolean): AwRequest => ptz(`#D1${auto ? 1 : 0}`)

/** Power state: cheap to answer, and says whether the camera is in standby */
export const PING = ptz('#O')

/** The focus mode query: `#D1` with no argument, which echoes the current `d1` value */
export const AF_INQUIRY: AwRequest = ptz('#D1')

/** The focus mode from a `#D1` echo: `d11` auto (on), `d10` manual (off), else unknown */
export function parseFocusMode(body: string): AutoFocusState {
	const m = body.trim().match(/d1([01])/i)
	if (!m) return 'unknown'
	return m[1] === '1' ? 'on' : 'off'
}

/** `#` has to be escaped. Colons are left as the spec writes them, in case a camera is literal. */
export function requestPath(request: AwRequest): string {
	return `/cgi-bin/${request.cgi}?cmd=${encodeURIComponent(request.cmd).replace(/%3A/g, ':')}&res=1`
}

const ERROR_REPLY = /^er(\d)(?::(\w*))?/i

/**
 * What a reply means for the camera's status: an error to show, `undefined` for a plain answer
 * (which clears an earlier error), or `'routine'` for one that changes nothing.
 */
export function interpretReply(request: AwRequest, body: string): string | undefined | 'routine' {
	const text = body.trim()
	const error = text.match(ERROR_REPLY)
	if (error) {
		const what = error[2] || request.cmd.replace(/^#/, '')
		switch (error[1]) {
			case '1':
				return `The camera doesn't support the ${what} command`
			case '2':
				// Busy (mid preset, say) or in standby. Standby shows through the ping instead.
				return 'routine'
			case '3':
				if (request.cmd.startsWith('#F')) return 'Turn auto focus off to focus by hand'
				return `The camera refused ${what} as out of range`
			default:
				return `The camera answered ${text}`
		}
	}
	if (request === PING) {
		if (text === 'p0') return 'The camera is in standby'
		if (text === 'p3') return 'The camera is turning on'
	}
	return undefined
}

// --- The link ----------------------------------------------------------------

type Challenge = ReturnType<typeof parseChallenge>
type Axis = 'panTilt' | 'zoom' | 'focus'

/**
 * One request at a time, as Canon's link does: while one is out `ready` is false, so the pump
 * sends the latest stick position once it's back rather than a backlog. The pump's interval keeps
 * the gap the camera asks for between commands.
 */
export class PanasonicLink extends EventEmitter<LinkEvents> implements CameraLink {
	readonly #config: CameraConfig
	#inFlight: Promise<void> | undefined
	#closed = true
	#connected = false
	/** The last confirmed AF mode, so the toggle sends its opposite */
	#autoFocus: AutoFocusState = 'unknown'
	#lastRequestAt = 0
	/** Axes sent something other than a stop, which close then stops */
	readonly #moved: Record<Axis, boolean> = { panTilt: false, zoom: false, focus: false }
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
		const deadline = Date.now() + CLOSE_TIMEOUT
		const gap = Math.max(this.#config.sendInterval, 0)
		// Let what's out finish, but not hold the stop back past the gap if it hangs
		await Promise.race([this.#inFlight, pause(gap)])

		// Pan and tilt always, as the one that matters most; zoom and focus only if they moved
		const stops = [STOP_PAN_TILT]
		if (this.#moved.zoom) stops.push(STOP_ZOOM)
		if (this.#moved.focus) stops.push(STOP_FOCUS)
		for (const stop of stops) {
			const wait = Math.max(this.#lastRequestAt + gap - Date.now(), 0)
			if (Date.now() + wait >= deadline) break
			await pause(wait)
			await Promise.race([this.#request(stop), sleep(Math.max(deadline - Date.now(), 0))])
		}
		this.emit('status', false)
	}

	panTilt(pan: number, tilt: number): void {
		this.#move('panTilt', pan !== 0 || tilt !== 0, panTilt(pan, tilt, this.#config.maxPan, this.#config.maxTilt))
	}

	zoom(speed: number): void {
		this.#move('zoom', speed !== 0, zoom(speed, this.#config.maxZoom))
	}

	focus(speed: number): void {
		this.#move('focus', speed !== 0, focus(speed, this.#config.maxFocus))
	}

	command(command: CameraCommand): void {
		const request = commandRequest(command)
		if (typeof request === 'string') this.emit('reply', { error: request })
		else if ('toggle' in request) this.#run(() => this.#toggleFocus())
		// A confirmed AF set updates the surfaced state, so the button follows without a fresh read
		else if (command.type === 'autoFocus') this.#send(request, command.enabled ? 'on' : 'off')
		else this.#send(request)
	}

	ping(): void {
		this.#send(PING)
	}

	refreshAutoFocus(): void {
		// Quiet: a background refresh only surfaces AF state, never clearing a real error with a success
		this.#run(async () => {
			const mode = parseFocusMode(await this.#exchange(AF_INQUIRY))
			if (mode !== 'unknown') this.#setAutoFocus(mode)
		}, true)
	}

	/** Flip the surfaced AF state: set the opposite of what the button shows (AF on when unknown) */
	async #toggleFocus(): Promise<void> {
		const next: AutoFocusState = this.#autoFocus === 'on' ? 'off' : 'on'
		await this.#exchange(focusSet(next === 'on'))
		this.#setAutoFocus(next)
	}

	#setAutoFocus(state: AutoFocusState): void {
		if (state === this.#autoFocus) return
		this.#autoFocus = state
		this.emit('reply', { autoFocus: state })
	}

	#move(axis: Axis, moving: boolean, request: AwRequest): void {
		if (!this.ready) return
		if (moving) this.#moved[axis] = true
		this.#send(request)
	}

	/** Set when an on/off autoFocus is in flight, so its success can update the surfaced state */
	#afOnSuccess: AutoFocusState | undefined

	#send(request: AwRequest, afOnSuccess?: AutoFocusState): void {
		if (!this.ready) return
		this.#afOnSuccess = afOnSuccess
		const done = this.#request(request).finally(() => {
			if (this.#inFlight === done) this.#inFlight = undefined
		})
		this.#inFlight = done
	}

	/** A task of one or more exchanges, run as a single in-flight slot like the other HTTP links */
	#run(work: () => Promise<void>, quiet = false): void {
		if (!this.ready) return
		const done = this.#runTask(work, quiet).finally(() => {
			if (this.#inFlight === done) this.#inFlight = undefined
		})
		this.#inFlight = done
	}

	async #runTask(work: () => Promise<void>, quiet: boolean): Promise<void> {
		try {
			await work()
			this.#setConnected(true)
			// A quiet background refresh leaves any surfaced error alone rather than clearing it
			if (!quiet) this.emit('reply', { error: undefined })
		} catch (e) {
			const error = e as Error & { cause?: Error }
			const message =
				error.name === 'TimeoutError' ? 'No answer from the camera' : (error.cause?.message ?? error.message)
			this.#setConnected(false, message)
		}
	}

	async #request(request: AwRequest): Promise<void> {
		const afOnSuccess = this.#afOnSuccess
		this.#afOnSuccess = undefined
		const { host, port } = this.#config
		const path = requestPath(request)
		const url = `http://${host}:${port || 80}${path}`
		this.#lastRequestAt = Date.now()

		try {
			let response = await this.#fetch(url, path)
			if (response.status === 401 && this.#hasCredentials) {
				const header = response.headers.get('www-authenticate')
				if (header) {
					await response.arrayBuffer()
					this.#challenge = parseChallenge(header)
					this.#nonceCount = 0
					response = await this.#fetch(url, path)
				}
			}
			const body = await response.text()
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
				this.emit('reply', { error: `The camera refused ${request.cmd} (HTTP ${response.status})` })
			} else {
				if (afOnSuccess) this.#setAutoFocus(afOnSuccess)
				const error = interpretReply(request, body)
				this.emit('reply', error === 'routine' ? {} : { error })
			}
		} catch (e) {
			const error = e as Error & { cause?: Error }
			const message =
				error.name === 'TimeoutError' ? 'No answer from the camera' : (error.cause?.message ?? error.message)
			this.#setConnected(false, message)
		}
	}

	/** One request, answering a fresh challenge once if the camera asks, returning the body */
	async #exchange(request: AwRequest): Promise<string> {
		const { host, port } = this.#config
		const path = requestPath(request)
		const url = `http://${host}:${port || 80}${path}`
		this.#lastRequestAt = Date.now()

		let response = await this.#fetch(url, path)
		if (response.status === 401 && this.#hasCredentials) {
			const header = response.headers.get('www-authenticate')
			if (header) {
				await response.arrayBuffer()
				this.#challenge = parseChallenge(header)
				this.#nonceCount = 0
				response = await this.#fetch(url, path)
			}
		}
		const body = await response.text()
		this.#setConnected(true)

		if (response.status === 401) {
			// Don't replay a challenge that just failed
			this.#challenge = undefined
			throw new Error(
				this.#hasCredentials
					? 'The camera rejected the user name or password'
					: 'The camera needs a user name and password',
			)
		}
		if (!response.ok) throw new Error(`The camera refused ${request.cmd} (HTTP ${response.status})`)
		return body
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

/** A deadline raced against a request, which mustn't keep the app running after it */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())
/** A wait that is all there is to do, so it has to hold the event loop open. Never longer than the gap. */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
