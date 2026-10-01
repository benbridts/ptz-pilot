/**
 * ONVIF PTZ cameras, over SOAP 1.2 and HTTP. Before the first move the link finds the camera's
 * services, its first media profile with PTZ, and that profile's video source (for focus). This is
 * done lazily, by whichever request comes first, and again after the camera goes away.
 *
 * Speeds: pan and tilt limits are percent of the camera's top speed (1-100). Zoom and focus are
 * 1-based as elsewhere, so a limit of 99 means speeds 1-100, again in percent.
 *
 * Presets: preset N in the app is the camera preset with token "N" (Hikvision and many others
 * number their tokens), or failing that one named "N" or "Preset N"; see `findPreset`.
 *
 * Login: WS-Security UsernameToken with a password digest, timed by the camera's clock. A camera
 * that also wants HTTP Digest gets it once it answers 401.
 */
import { EventEmitter } from 'node:events'
import { parseChallenge, digestHeader } from '../canon/xc.js'
import type { CameraCommand, CameraConfig, CameraLink, LinkEvents } from '../visca/camera.js'
import * as soap from './soap.js'

type Challenge = ReturnType<typeof parseChallenge>

const REQUEST_TIMEOUT = 2000
/** On close, how long to wait for the final stop to get through */
const CLOSE_TIMEOUT = 1000
/**
 * Each move tells the camera to stop by itself after this long. The camera's pump refreshes held
 * movement every 500ms, so this only runs out when the app or the network has gone quiet.
 */
export const MOVE_TIMEOUT = 1000
/**
 * ONVIF has no one-push focus. Autofocus is switched on for this long, then back to manual, which
 * leaves the lens where autofocus put it.
 */
export const ONE_PUSH_TIME = 2000

/** What setup learned about the camera */
interface Session {
	paths: Record<'device' | 'media' | 'ptz', string> & { imaging?: string }
	profile: string
	videoSource: string | undefined
	presets: soap.Preset[]
	/** The top continuous focus speed, or undefined when focus can't be driven */
	focusRange: number | undefined
}

class OnvifError extends Error {
	constructor(
		message: string,
		readonly kind: 'auth' | 'fault' | 'network',
	) {
		super(message)
	}
}

const fault = (message: string) => new OnvifError(message, 'fault')

export class OnvifLink extends EventEmitter<LinkEvents> implements CameraLink {
	readonly #config: CameraConfig
	#inFlight: Promise<void> | undefined
	#closed = true
	#connected = false
	#session: Session | undefined
	/** Camera clock minus ours, in ms */
	#clockOffset = 0
	/** Kept between requests, so a live challenge is reused rather than paying for a 401 each time */
	#challenge: Challenge | undefined
	#nonceCount = 0
	/** The velocity last asked for on each axis, since a move restates them all */
	#velocity: soap.Velocity = { pan: 0, tilt: 0, zoom: 0 }
	/** Cleared if the camera refuses moves that carry a timeout */
	#useMoveTimeout = true
	#onePushTimer: ReturnType<typeof setTimeout> | undefined

	constructor(config: CameraConfig) {
		super()
		this.#config = config
	}

	get ready(): boolean {
		return !this.#inFlight && !this.#closed
	}

	/** Setup waits for the first request, which is the pump's first ping */
	open(): void {
		this.#closed = false
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		clearTimeout(this.#onePushTimer)
		// Stop alongside whatever is still out, then again once it's back in case it was a move
		const inFlight = this.#inFlight
		const stops = [this.#stopAll()]
		if (inFlight) stops.push(inFlight.then(() => this.#stopAll()))
		await Promise.race([Promise.allSettled(stops), sleep(CLOSE_TIMEOUT)])
		this.emit('status', false)
	}

	panTilt(pan: number, tilt: number): void {
		const { maxPan, maxTilt } = this.#config
		this.#velocity = { ...this.#velocity, ...soap.panTiltVelocity(pan, tilt, maxPan, maxTilt) }
		this.#move()
	}

	zoom(speed: number): void {
		this.#velocity = { ...this.#velocity, zoom: soap.zoomVelocity(speed, this.#config.maxZoom) }
		this.#move()
	}

	focus(speed: number): void {
		this.#send(async (s) => {
			if (speed === 0) {
				// Nothing can be moving on a camera that can't focus
				if (s.videoSource && s.focusRange !== undefined) await this.#call(s, soap.focusStop(s.videoSource))
				return
			}
			const source = this.#focusSource(s)
			await this.#call(s, soap.focusMove(source, soap.focusSpeed(speed, this.#config.maxFocus, s.focusRange)))
		})
	}

	command(command: CameraCommand): void {
		if (command.type !== 'onePushFocus') clearTimeout(this.#onePushTimer)
		switch (command.type) {
			case 'presetRecall':
			case 'presetSet': {
				const n = command.preset + 1
				if (!Number.isInteger(n) || n < 1) return void this.emit('reply', { error: 'Presets are numbered from 1' })
				return this.#send((s) => (command.type === 'presetRecall' ? this.#recall(s, n) : this.#store(s, n)))
			}
			case 'home':
				return this.#send((s) => this.#call(s, soap.gotoHome(s.profile)).then(() => {}))
			case 'autoFocus':
				return this.#send((s) =>
					this.#call(s, soap.setFocusMode(this.#imagingSource(s), command.enabled)).then(() => {}),
				)
			case 'onePushFocus':
				return this.#send(async (s) => {
					await this.#call(s, soap.setFocusMode(this.#imagingSource(s), true))
					clearTimeout(this.#onePushTimer)
					this.#onePushTimer = setTimeout(() => this.#backToManual(), ONE_PUSH_TIME)
				})
		}
	}

	/** Asks the PTZ service, so a lost login or profile shows up, not just a camera that's switched on */
	ping(): void {
		this.#send((s) => this.#call(s, soap.ptzStatus(s.profile)).then(() => {}))
	}

	// --- Movement and commands -----------------------------------------------

	#move(): void {
		const v = this.#velocity
		this.#send(async (s) => {
			if (v.pan === 0 && v.tilt === 0 && v.zoom === 0) {
				await this.#call(s, soap.ptzStop(s.profile))
				return
			}
			if (this.#useMoveTimeout) {
				try {
					await this.#call(s, soap.continuousMove(s.profile, v, MOVE_TIMEOUT))
					return
				} catch (e) {
					if (!(e instanceof OnvifError) || e.kind !== 'fault') throw e
					// Some cameras only take timeouts within a range they set; do without
					this.#useMoveTimeout = false
				}
			}
			await this.#call(s, soap.continuousMove(s.profile, v))
		})
	}

	async #recall(s: Session, n: number): Promise<void> {
		let preset = soap.findPreset(s.presets, n)
		if (!preset) {
			// It may have been stored on the camera since we last looked
			s.presets = await this.#presets(s)
			preset = soap.findPreset(s.presets, n)
		}
		if (!preset) throw fault(`The camera has no preset ${n}`)
		await this.#call(s, soap.gotoPreset(s.profile, preset.token))
	}

	async #store(s: Session, n: number): Promise<void> {
		const existing = soap.findPreset(s.presets, n)
		if (existing) {
			await this.#call(s, soap.setPreset(s.profile, existing.name || `Preset ${n}`, existing.token))
		} else {
			try {
				// Hikvision and others keep a slot per number, so ask for token "n" first
				await this.#call(s, soap.setPreset(s.profile, `Preset ${n}`, String(n)))
			} catch (e) {
				if (!(e instanceof OnvifError) || e.kind !== 'fault') throw e
				// Cameras that pick their own tokens refuse one they don't know; find it by name later
				await this.#call(s, soap.setPreset(s.profile, `Preset ${n}`))
			}
		}
		s.presets = await this.#presets(s)
	}

	async #presets(s: Session): Promise<soap.Preset[]> {
		return soap.parsePresets(await this.#call(s, soap.getPresets(s.profile)))
	}

	#imagingSource(s: Session): string {
		if (!s.paths.imaging || !s.videoSource)
			throw fault('This camera has no ONVIF imaging service, so focus is out of reach')
		return s.videoSource
	}

	#focusSource(s: Session): string {
		const source = this.#imagingSource(s)
		if (s.focusRange === undefined) throw fault('This camera has no continuous focus over ONVIF')
		return source
	}

	#backToManual(): void {
		this.#onePushTimer = undefined
		if (this.#closed) return
		// Wait for a gap rather than drop it: leaving autofocus on would be a surprise
		if (!this.ready) {
			this.#onePushTimer = setTimeout(() => this.#backToManual(), 20)
			return
		}
		this.#send((s) => this.#call(s, soap.setFocusMode(this.#imagingSource(s), false)).then(() => {}))
	}

	async #stopAll(): Promise<void> {
		const s = this.#session
		// Without a session nothing was ever moved
		if (!s) return
		const stops = [this.#call(s, soap.ptzStop(s.profile))]
		if (s.paths.imaging && s.videoSource && s.focusRange !== undefined)
			stops.push(this.#call(s, soap.focusStop(s.videoSource)))
		await Promise.allSettled(stops)
	}

	// --- Requests ------------------------------------------------------------

	/**
	 * One task at a time. While one is out, `ready` is false and the camera's pump holds off, so
	 * when the answer comes back the next request carries the latest stick position, not a backlog.
	 */
	#send(task: (session: Session) => Promise<void>): void {
		if (!this.ready) return
		const done = this.#run(task).finally(() => {
			if (this.#inFlight === done) this.#inFlight = undefined
		})
		this.#inFlight = done
	}

	async #run(task: (session: Session) => Promise<void>): Promise<void> {
		try {
			const session = await this.#ensureSession()
			// Closed during setup: the stop on close has already gone, so don't start anything now
			if (this.#closed) return
			await task(session)
			this.emit('reply', { error: undefined })
		} catch (e) {
			const error = e instanceof OnvifError ? e : new OnvifError((e as Error).message, 'fault')
			if (error.kind === 'network') {
				this.#session = undefined
				this.#setConnected(false, error.message)
				return
			}
			if (error.kind === 'auth') {
				// Don't replay a challenge that just failed, and look again once the login is fixed
				this.#challenge = undefined
				this.#session = undefined
			}
			this.emit('reply', { error: error.message })
		}
	}

	async #ensureSession(): Promise<Session> {
		if (this.#session) return this.#session

		// The clock first, unauthenticated, so the login that follows is timed by the camera's clock
		try {
			const time = soap.parseDateTime(await this.#post(soap.DEVICE_PATH, soap.getSystemDateAndTime(), false))
			if (time) this.#clockOffset = time.getTime() - Date.now()
		} catch (e) {
			if (!(e instanceof OnvifError) || e.kind === 'network') throw e
			// Some cameras want a login even for this; carry on with our own clock
		}

		let addresses: soap.ServiceAddresses = {}
		try {
			addresses = soap.parseServices(await this.#post(soap.DEVICE_PATH, soap.getServices()))
		} catch (e) {
			if (!(e instanceof OnvifError) || e.kind !== 'fault') throw e
		}
		// Some cameras leave services out of GetServices (one seen in testing listed media but not PTZ)
		if (!addresses.ptz || !addresses.media || !addresses.imaging)
			addresses = {
				...soap.parseCapabilities(await this.#post(soap.DEVICE_PATH, soap.getCapabilities())),
				...addresses,
			}

		const ptz = soap.servicePath(addresses.ptz)
		const media = soap.servicePath(addresses.media)
		if (!ptz) throw fault('The camera offers no ONVIF PTZ service')
		if (!media) throw fault('The camera offers no ONVIF media service')
		const imaging = soap.servicePath(addresses.imaging)

		const profiles = soap.parseProfiles(await this.#post(media, soap.getProfiles()))
		const profile = profiles.find((p) => p.ptz && p.token)
		if (!profile) throw fault('None of the camera’s media profiles has PTZ')

		const session: Session = {
			paths: { device: soap.servicePath(addresses.device) ?? soap.DEVICE_PATH, media, ptz, imaging },
			profile: profile.token,
			videoSource: profile.videoSource,
			presets: [],
			focusRange: undefined,
		}

		// Presets and focus are extras: a camera without them can still be flown
		try {
			session.presets = await this.#presets(session)
		} catch (e) {
			if (!(e instanceof OnvifError) || e.kind !== 'fault') throw e
		}
		if (imaging && profile.videoSource) {
			try {
				session.focusRange = soap.parseFocusRange(await this.#post(imaging, soap.getMoveOptions(profile.videoSource)))
			} catch (e) {
				if (!(e instanceof OnvifError) || e.kind !== 'fault') throw e
				// Couldn't say; try continuous focus in the generic range
				session.focusRange = 1
			}
		}

		this.#session = session
		return session
	}

	#call(s: Session, request: soap.OnvifRequest): Promise<string> {
		const path = request.service === 'imaging' ? s.paths.imaging : s.paths[request.service]
		if (!path) return Promise.reject(fault(`The camera offers no ONVIF ${request.service} service`))
		return this.#post(path, request)
	}

	/** One SOAP request, answered with the response XML or thrown as an OnvifError */
	async #post(path: string, request: soap.OnvifRequest, authenticate = true): Promise<string> {
		const { host, port } = this.#config
		const url = `http://${host}:${port || 80}${path}`
		const security =
			authenticate && this.#hasCredentials
				? soap.usernameToken(this.#config.username, this.#config.password, new Date(Date.now() + this.#clockOffset))
				: ''
		const body = soap.envelope(request, security)

		let response: Response
		let xml: string
		try {
			response = await this.#fetch(url, path, request, body)
			if (response.status === 401 && this.#hasCredentials) {
				const header = response.headers.get('www-authenticate')
				if (header && /^digest/i.test(header)) {
					await response.arrayBuffer()
					this.#challenge = parseChallenge(header)
					this.#nonceCount = 0
					response = await this.#fetch(url, path, request, body)
				}
			}
			xml = await response.text()
		} catch (e) {
			const error = e as Error & { cause?: Error }
			const message =
				error.name === 'TimeoutError' ? 'No answer from the camera' : (error.cause?.message ?? error.message)
			throw new OnvifError(message, 'network')
		}
		this.#setConnected(true)

		const f = soap.parseFault(xml)
		if (response.status === 401 || (f && soap.isAuthFault(f))) {
			// The unauthenticated clock request is allowed to fail; the caller decides what that means
			throw new OnvifError(
				this.#hasCredentials
					? 'The camera rejected the user name or password'
					: 'The camera needs a user name and password',
				'auth',
			)
		}
		if (f) throw fault(`The camera refused ${request.operation}: ${f.reason || f.code}`)
		if (!response.ok) throw fault(`The camera refused ${request.operation} (HTTP ${response.status})`)
		return xml
	}

	#fetch(url: string, path: string, request: soap.OnvifRequest, body: string): Promise<Response> {
		const headers: Record<string, string> = {
			'content-type': `application/soap+xml; charset=utf-8; action="${soap.soapAction(request)}"`,
		}
		const { username, password } = this.#config
		if (this.#challenge && this.#hasCredentials)
			headers.authorization = digestHeader(this.#challenge, username, password, 'POST', path, ++this.#nonceCount)
		return fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
	}

	get #hasCredentials(): boolean {
		return this.#config.username !== '' && this.#config.password !== ''
	}

	#setConnected(connected: boolean, error?: string): void {
		if (this.#closed && connected) return
		if (connected === this.#connected && !error) return
		this.#connected = connected
		this.emit('status', connected, error)
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())
