/**
 * Hikvision's ISAPI: XML over HTTP, spoken by Hikvision PTZ domes and their NVRs. Movement is a
 * `PUT /ISAPI/PTZCtrl/channels/<ch>/continuous` carrying pan, tilt and zoom together:
 *
 * - each speed is a percentage of the camera's top speed, -100 to 100; 0 stops that axis
 * - positive pan is right, positive tilt is up, positive zoom is tele
 * - focus is separate, `PUT /ISAPI/System/Video/inputs/channels/<ch>/focus`, also -100 to 100
 *
 * Presets are numbered from 1 on the camera, against 0-based in the rest of the app.
 *
 * The camera always asks for a login, by HTTP Digest (Basic on some older firmware). It locks the
 * account after a few failed logins (5 by default), so a rejected password backs off, not retries.
 *
 * `momentary` (the same body plus a duration, after which the camera stops by itself) would be a
 * fail-safe against the app going quiet, but it is meant for nudges: it's optional in the
 * capabilities, and nothing shows that re-sending it every 500ms moves smoothly rather than in
 * steps. Hikvision's own browser SDK uses only continuous. The pump already re-sends held movement
 * and sends each stop twice, and close() stops everything.
 */
import { EventEmitter } from 'node:events'
import { digestHeader, parseChallenge } from '../canon/xc.js'
import type { AutoFocusState, CameraCommand, CameraConfig, CameraLink, LinkEvents } from '../visca/camera.js'

/** A dome is channel 1. An NVR passes PTZ through on the channel the camera is plugged into. */
export const CHANNEL = 1
export const MAX_SPEED = 100
/** Most Hikvision domes keep 256 or 300; the camera refuses past its own limit */
export const MAX_PRESET = 300

const REQUEST_TIMEOUT = 2000
/** On close, how long to wait for the final stop to get through */
const CLOSE_TIMEOUT = 1000
/** After a rejected password, wait this long before trying again, doubling each time */
const AUTH_BACKOFF = 60_000
const MAX_AUTH_BACKOFF = 30 * 60_000

export interface IsapiRequest {
	method: 'GET' | 'PUT'
	path: string
	body?: string
}

const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n'
const put = (path: string, body?: string): IsapiRequest => ({ method: 'PUT', path, body })
const ptz = (channel: number, rest: string) => `/ISAPI/PTZCtrl/channels/${channel}/${rest}`

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Math.round(value), min), max)
}

/** Pan and tilt arrive as 1..max already; 0 stops */
function percent(speed: number, max: number): number {
	if (speed === 0) return 0
	return Math.sign(speed) * clamp(Math.abs(speed), 1, Math.min(Math.max(max, 1), MAX_SPEED))
}

/** Zoom and focus arrive 1-based as elsewhere in the app: 1..max+1, onto the camera's 1..100 */
const oneBased = (speed: number, max: number) => percent(speed, max + 1)

export interface Speeds {
	pan: number
	tilt: number
	zoom: number
}

/** All three axes go in one body, so the caller passes whatever the other axes are doing */
export function continuous(speeds: Speeds, config: Pick<CameraConfig, 'maxPan' | 'maxTilt' | 'maxZoom'>): IsapiRequest {
	const pan = percent(speeds.pan, config.maxPan)
	const tilt = percent(speeds.tilt, config.maxTilt)
	const zoom = oneBased(speeds.zoom, config.maxZoom)
	return put(
		ptz(CHANNEL, 'continuous'),
		`${XML_PROLOG}<PTZData><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`,
	)
}

/** Positive focuses further away */
export function focus(speed: number, maxSpeed: number): IsapiRequest {
	return put(
		`/ISAPI/System/Video/inputs/channels/${CHANNEL}/focus`,
		`${XML_PROLOG}<FocusData><focus>${oneBased(speed, maxSpeed)}</focus></FocusData>`,
	)
}

export const FOCUS_CONFIGURATION = `/ISAPI/Image/channels/${CHANNEL}/focusConfiguration`

/**
 * Auto focus is a field in the channel's focus configuration, alongside others (minimum focus
 * distance and so on) that a bare document might reset. So the current one is read, and only
 * `focusStyle` changed. Without one to start from, `focusStyle` is the only required field.
 */
export function withFocusStyle(current: string | undefined, auto: boolean): string {
	const style = auto ? 'AUTO' : 'MANUAL'
	if (current && /<focusStyle\b[^>]*>[^<]*<\/focusStyle>/.test(current))
		return current.replace(/(<focusStyle\b[^>]*>)[^<]*(<\/focusStyle>)/, `$1${style}$2`)
	return `${XML_PROLOG}<FocusConfiguration><focusStyle>${style}</focusStyle></FocusConfiguration>`
}

/** A one-off command: a single request, the focus style, the toggle (flip the surfaced state), or a reason it can't be sent */
export function commandRequest(
	command: CameraCommand,
): IsapiRequest | { focusStyle: boolean } | { toggle: true } | string {
	switch (command.type) {
		case 'presetRecall':
		case 'presetSet': {
			const id = command.preset + 1
			if (!Number.isInteger(id) || id < 1 || id > MAX_PRESET) return `Hikvision cameras have presets 1-${MAX_PRESET}`
			if (command.type === 'presetRecall') return put(ptz(CHANNEL, `presets/${id}/goto`))
			return put(
				ptz(CHANNEL, `presets/${id}`),
				`${XML_PROLOG}<PTZPreset><enabled>true</enabled><id>${id}</id><presetName>Preset ${id}</presetName></PTZPreset>`,
			)
		}
		case 'home':
			return put(ptz(CHANNEL, 'homeposition/goto'))
		case 'autoFocus':
			return { focusStyle: command.enabled }
		case 'autoFocusToggle':
			return { toggle: true }
		case 'onePushFocus':
			// Sic: Hikvision's spelling
			return put(ptz(CHANNEL, 'onepushfoucs/start'))
	}
}

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
		case 'autoFocusToggle':
			return 'the focus mode'
		case 'onePushFocus':
			return 'one-push focus'
	}
}

/** Where the dome is pointing: small, and it fails if the channel has no PTZ */
export const PING: IsapiRequest = { method: 'GET', path: ptz(CHANNEL, 'status') }

/** The focus mode from a focus configuration body: `AUTO` on, `MANUAL` off, else unknown */
export function parseFocusStyle(body: string): AutoFocusState {
	const style = tag(body, 'focusStyle')?.toUpperCase()
	if (style === 'AUTO') return 'on'
	if (style === 'MANUAL') return 'off'
	return 'unknown'
}

// --- Answers -----------------------------------------------------------------

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}\\b[^>]*>\\s*([^<]*?)\\s*</${name}>`))?.[1]

export interface ResponseStatus {
	statusCode: number | undefined
	statusString: string | undefined
	subStatusCode: string | undefined
	errorMsg: string | undefined
	/** Only on a failed login */
	lockStatus: string | undefined
	retryTimes: number | undefined
	resLockTime: number | undefined
}

/** The `<ResponseStatus>` most ISAPI answers carry, or undefined if this isn't one */
export function parseResponseStatus(xml: string): ResponseStatus | undefined {
	if (!/<ResponseStatus\b/.test(xml)) return undefined
	const int = (name: string) => {
		const n = Number.parseInt(tag(xml, name) ?? '', 10)
		return Number.isFinite(n) ? n : undefined
	}
	return {
		statusCode: int('statusCode'),
		statusString: tag(xml, 'statusString'),
		subStatusCode: tag(xml, 'subStatusCode'),
		errorMsg: tag(xml, 'errorMsg'),
		lockStatus: tag(xml, 'lockStatus'),
		retryTimes: int('retryTimes'),
		resLockTime: int('resLockTime'),
	}
}

/** The sub-status codes worth saying in words; the rest are shown as the camera sent them */
const SUB_STATUS: Record<string, string> = {
	notSupport: 'not supported by this camera',
	lowPrivilege: 'this user lacks permission',
	badParameters: 'bad parameters',
	badXmlContent: 'bad request content',
	invalidOperation: 'invalid operation',
	deviceBusy: 'the camera is busy',
	deviceError: 'the camera reported an error',
}

/** What to show for a refused request, or undefined if it went through */
export function describeError(what: string, httpStatus: number, body: string): string | undefined {
	const status = parseResponseStatus(body)
	const code = status?.statusCode
	const ok = httpStatus >= 200 && httpStatus < 300
	if (ok && (code === undefined || code === 0 || code === 1)) return undefined
	if (!status || (!status.statusString && !status.subStatusCode))
		return `The camera refused ${what} (HTTP ${httpStatus})`

	const sub = status.subStatusCode && status.subStatusCode !== 'ok' ? status.subStatusCode : undefined
	const detail = status.errorMsg || (sub && (SUB_STATUS[sub] ?? sub))
	return `The camera refused ${what}: ${status.statusString ?? `status ${code}`}${detail ? ` (${detail})` : ''}`
}

/** How long to hold off after a rejected login, and what to say about it */
export function authFailure(body: string, previousBackoff: number): { backoff: number; error: string } {
	const status = parseResponseStatus(body)
	const minutes = (ms: number) => {
		const m = Math.ceil(ms / 60_000)
		return m === 1 ? '1 minute' : `${m} minutes`
	}
	if (status?.lockStatus === 'locked' || (status?.resLockTime ?? 0) > 0) {
		const backoff = Math.max((status?.resLockTime ?? 0) * 1000, AUTH_BACKOFF)
		return {
			backoff,
			error: `The camera has locked this account after too many failed logins. Trying again in ${minutes(backoff)}.`,
		}
	}
	const backoff = previousBackoff ? Math.min(previousBackoff * 2, MAX_AUTH_BACKOFF) : AUTH_BACKOFF
	const left = status?.retryTimes !== undefined ? ` (${status.retryTimes} tries left)` : ''
	return {
		backoff,
		error:
			`The camera rejected the user name or password${left}. Hikvision locks the account after a few ` +
			`failed logins, so PTZ Pilot waits ${minutes(backoff)} before trying again, or until the camera is saved.`,
	}
}

// --- The link ----------------------------------------------------------------

interface Answer {
	status: number
	body: string
}

/**
 * One request at a time, as for Canon: while one is out, `ready` is false and the camera's pump
 * holds off, so the next request carries the latest stick position rather than a backlog.
 */
export class HikvisionLink extends EventEmitter<LinkEvents> implements CameraLink {
	readonly #config: CameraConfig
	#inFlight: Promise<void> | undefined
	#closed = true
	#connected = false
	/** The last confirmed AF mode, so the toggle sends its opposite */
	#autoFocus: AutoFocusState = 'unknown'
	/** The speeds last asked for. Pan, tilt and zoom share a body, so each change carries the others. */
	readonly #speeds: Speeds = { pan: 0, tilt: 0, zoom: 0 }
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
			const stops = [
				this.#request('the stop', () => this.#exchange(continuous({ pan: 0, tilt: 0, zoom: 0 }, this.#config))),
				this.#request('the stop', () => this.#exchange(focus(0, this.#config.maxFocus))),
			]
			await Promise.race([Promise.allSettled([...stops, this.#inFlight]), sleep(CLOSE_TIMEOUT)])
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
		this.#send('focus', focus(speed, this.#config.maxFocus))
	}

	command(command: CameraCommand): void {
		const request = commandRequest(command)
		if (typeof request === 'string') this.emit('reply', { error: request })
		else if ('toggle' in request) this.#run('the focus mode', () => this.#toggleFocusStyle())
		else if ('focusStyle' in request)
			this.#run('the focus mode', () => this.#setFocusStyle(request.focusStyle, request.focusStyle ? 'on' : 'off'))
		else this.#send(describeCommand(command), request)
	}

	ping(): void {
		this.#send('the status request', PING)
	}

	refreshAutoFocus(): void {
		// Quiet: a background refresh only surfaces AF state, never clearing a real error with a success
		this.#run(
			'the focus mode',
			async () => {
				const current = await this.#exchange({ method: 'GET', path: FOCUS_CONFIGURATION })
				if (current.status === 200) {
					const mode = parseFocusStyle(current.body)
					if (mode !== 'unknown') this.#setAutoFocusState(mode)
				}
				return current
			},
			true,
		)
	}

	#move(): void {
		this.#send('movement', continuous(this.#speeds, this.#config))
	}

	/** Flip the surfaced AF state: write the opposite of what the button shows (AF on when unknown) */
	async #toggleFocusStyle(): Promise<Answer> {
		const next: AutoFocusState = this.#autoFocus === 'on' ? 'off' : 'on'
		return this.#setFocusStyle(next === 'on', next)
	}

	async #setFocusStyle(auto: boolean, afOnSuccess?: AutoFocusState, current?: string): Promise<Answer> {
		if (current === undefined) {
			const read = await this.#exchange({ method: 'GET', path: FOCUS_CONFIGURATION })
			// A camera without the setting says so here, and that is what gets shown
			if (read.status !== 200) return read
			current = read.body
		}
		const result = await this.#exchange(put(FOCUS_CONFIGURATION, withFocusStyle(current, auto)))
		// On a 2xx with no camera-reported error, the set went through, so follow the surfaced state
		if (afOnSuccess && !describeError('the focus mode', result.status, result.body))
			this.#setAutoFocusState(afOnSuccess)
		return result
	}

	#setAutoFocusState(state: AutoFocusState): void {
		if (state === this.#autoFocus) return
		this.#autoFocus = state
		this.emit('reply', { autoFocus: state })
	}

	#send(what: string, request: IsapiRequest): void {
		this.#run(what, () => this.#exchange(request))
	}

	#run(what: string, work: () => Promise<Answer>, quiet = false): void {
		if (!this.ready || this.#authBlocked) return
		const done = this.#request(what, work, quiet).finally(() => {
			if (this.#inFlight === done) this.#inFlight = undefined
		})
		this.#inFlight = done
	}

	get #authBlocked(): boolean {
		return Date.now() < this.#authBlockedUntil
	}

	async #request(what: string, work: () => Promise<Answer>, quiet = false): Promise<void> {
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
				const { backoff, error } = authFailure(body, this.#authBackoff)
				this.#authBackoff = backoff
				this.#authBlockedUntil = Date.now() + backoff
				this.emit('reply', { error })
				return
			}
			this.#authBackoff = 0
			const error = describeError(what, status, body)
			// A quiet background refresh leaves any surfaced error alone rather than clearing it on success
			if (!quiet || error) this.emit('reply', { error })
		} catch (e) {
			const error = e as Error & { cause?: Error }
			const message =
				error.name === 'TimeoutError' ? 'No answer from the camera' : (error.cause?.message ?? error.message)
			this.#setConnected(false, message)
		}
	}

	/** One request, answering a fresh challenge once if the camera asks for one */
	async #exchange(request: IsapiRequest): Promise<Answer> {
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
		// Read the body whatever it is, so the connection can be kept for the next request
		return { status: response.status, body: await response.text() }
	}

	#fetch(url: string, request: IsapiRequest): Promise<Response> {
		const headers: Record<string, string> = {}
		const auth = this.#authorization(request)
		if (auth) headers.authorization = auth
		if (request.body !== undefined) headers['content-type'] = 'application/xml'
		return fetch(url, {
			method: request.method,
			headers,
			body: request.body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT),
		})
	}

	get #hasCredentials(): boolean {
		return this.#config.username !== '' && this.#config.password !== ''
	}

	#authorization(request: IsapiRequest): string | undefined {
		const { username, password } = this.#config
		if (!this.#hasCredentials || !this.#challenge) return undefined
		if (this.#challenge.scheme.toLowerCase() === 'digest')
			return digestHeader(this.#challenge, username, password, request.method, request.path, ++this.#nonceCount)
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
