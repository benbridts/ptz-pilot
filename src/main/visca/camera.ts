import { EventEmitter } from 'node:events'
import { protocolOf, type Protocol, type TransportConfig } from './transports.js'
import { ViscaLink } from './link.js'
import { CanonLink } from '../canon/xc.js'
import { HikvisionLink } from '../hikvision/isapi.js'
import { PanasonicLink } from '../panasonic/aw.js'
import { OnvifLink } from '../onvif/link.js'

/** The speed ranges a camera accepts. These differ between manufacturers and even models. */
export interface SpeedLimits {
	maxPan: number
	maxTilt: number
	/** 0-7 on almost everything */
	maxZoom: number
	maxFocus: number
}

export interface CameraProfile extends SpeedLimits {
	label: string
	/** The protocol whose speed ranges these are */
	protocol: Protocol
}

export const PROFILES: Record<string, CameraProfile> = {
	sony: { label: 'Sony SRG / BRC / FR7', protocol: 'visca', maxPan: 0x18, maxTilt: 0x17, maxZoom: 7, maxFocus: 7 },
	'sony-evi': { label: 'Sony EVI (older)', protocol: 'visca', maxPan: 0x18, maxTilt: 0x14, maxZoom: 7, maxFocus: 7 },
	ptzoptics: { label: 'PTZOptics', protocol: 'visca', maxPan: 0x18, maxTilt: 0x14, maxZoom: 7, maxFocus: 7 },
	generic: { label: 'Generic (conservative)', protocol: 'visca', maxPan: 0x18, maxTilt: 0x14, maxZoom: 7, maxFocus: 7 },
	// Pan and tilt in hundredths of a degree a second, up to 100°/s; zoom 0-127; focus low, medium, high
	canon: { label: 'Canon CR-N / CR-X', protocol: 'canon', maxPan: 10000, maxTilt: 10000, maxZoom: 127, maxFocus: 2 },
	// Percentages of the camera's top speed; zoom and focus 0-99 are 1-100 on the wire
	hikvision: { label: 'Hikvision PTZ', protocol: 'hikvision', maxPan: 100, maxTilt: 100, maxZoom: 99, maxFocus: 99 },
	// 49 speeds each side of stop, on every axis
	panasonic: {
		label: 'Panasonic AW-HE / AW-UE',
		protocol: 'panasonic',
		maxPan: 49,
		maxTilt: 49,
		maxZoom: 48,
		maxFocus: 48,
	},
	// Percent of the camera's top speed on every axis
	onvif: { label: 'ONVIF', protocol: 'onvif', maxPan: 100, maxTilt: 100, maxZoom: 99, maxFocus: 99 },
}

/** The profile a camera starts with, and falls back to when its protocol changes */
export const DEFAULT_PROFILE: Record<Protocol, string> = {
	visca: 'sony',
	canon: 'canon',
	hikvision: 'hikvision',
	panasonic: 'panasonic',
	onvif: 'onvif',
}

/** The range each speed limit may be set within, as [min, max] */
export type LimitRanges = Record<keyof SpeedLimits, [number, number]>

export const LIMIT_RANGES: Record<Protocol, LimitRanges> = {
	visca: { maxPan: [1, 0x18], maxTilt: [1, 0x18], maxZoom: [0, 7], maxFocus: [0, 7] },
	canon: { maxPan: [1, 10000], maxTilt: [1, 10000], maxZoom: [0, 127], maxFocus: [0, 2] },
	hikvision: { maxPan: [1, 100], maxTilt: [1, 100], maxZoom: [0, 99], maxFocus: [0, 99] },
	panasonic: { maxPan: [1, 49], maxTilt: [1, 49], maxZoom: [0, 48], maxFocus: [0, 48] },
	onvif: { maxPan: [1, 100], maxTilt: [1, 100], maxZoom: [0, 99], maxFocus: [0, 99] },
}

export interface CameraConfig extends TransportConfig, SpeedLimits {
	id: string
	name: string
	/** For protocols that log in (see KINDS). Blank where the camera needs none. */
	username: string
	password: string
	/** 1-7. Always 1 over IP; set per camera on a serial daisy chain. */
	address: number
	/** Minimum gap between messages, in ms. Some cameras drop commands that arrive too close together. */
	sendInterval: number
	/**
	 * The speed profile last picked, or '' for custom. Several profiles share the same limits, so
	 * the limits alone can't say which one was picked.
	 */
	profile: string
}

/** Signed speeds, already scaled to the camera's ranges. 0 is stopped. */
export interface Motion {
	pan: number
	tilt: number
	zoom: number
	focus: number
}

export const STOPPED: Motion = { pan: 0, tilt: 0, zoom: 0, focus: 0 }

/** One-off commands. Presets are 0-based, as VISCA numbers them. */
export type CameraCommand =
	| { type: 'presetRecall'; preset: number }
	| { type: 'presetSet'; preset: number }
	| { type: 'home' }
	| { type: 'autoFocus'; enabled: boolean }
	| { type: 'onePushFocus' }

export interface LinkEvents {
	/** Connected means the link is up, not that a camera has answered on it */
	status: [connected: boolean, error?: string]
	/** The camera answered. `error` set means it complained; left out means nothing worth showing. */
	reply: [update: { error?: string }]
}

/**
 * How a camera is spoken to: VISCA over one of its transports, or Canon's XC protocol over HTTP.
 * Speeds arrive as in `Motion`, already within the camera's limits.
 */
export interface CameraLink extends EventEmitter<LinkEvents> {
	/** False while the link can't take another message yet. The pump then waits, rather than queue. */
	readonly ready: boolean
	open(): void
	/** Sends a stop for every movement before closing, whatever else is in flight */
	close(): Promise<void>
	panTilt(pan: number, tilt: number): void
	zoom(speed: number): void
	focus(speed: number): void
	command(command: CameraCommand): void
	/** Ask the camera something harmless, to see that it is still there */
	ping(): void
}

export function createLink(config: CameraConfig): CameraLink {
	switch (protocolOf(config.kind)) {
		case 'visca':
			return new ViscaLink(config)
		case 'canon':
			return new CanonLink(config)
		case 'hikvision':
			return new HikvisionLink(config)
		case 'panasonic':
			return new PanasonicLink(config)
		case 'onvif':
			return new OnvifLink(config)
	}
}

/**
 * While moving, the current movement is re-sent this often. Over UDP a lost stop would leave the
 * camera turning; re-sending bounds how long a lost packet can matter, and stops are sent twice.
 */
const REFRESH_INTERVAL = 500
const STOP_REPEATS = 2
/**
 * With nothing else to send for this long, ask the camera something harmless, so its status
 * reflects whether it is still there rather than when it last happened to be moved.
 */
const IDLE_PING_INTERVAL = 3000

type Channel = 'panTilt' | 'zoom' | 'focus'

export interface CameraStatus {
	id: string
	connected: boolean
	error: string | undefined
	lastReplyAt: number | undefined
}

export interface CameraEvents {
	status: [CameraStatus]
}

/**
 * One camera. Movement is set as a desired state, and a pump sends at most one message per
 * `sendInterval`, always the latest value, so a burst of stick movement never builds a queue.
 */
export class Camera extends EventEmitter<CameraEvents> {
	readonly #config: CameraConfig
	readonly #link: CameraLink

	#desired: Motion = { ...STOPPED }
	#sent: Motion = { ...STOPPED }
	/** Per channel: stop messages still to send, and when it was last sent */
	readonly #stopsPending: Record<Channel, number> = { panTilt: 0, zoom: 0, focus: 0 }
	readonly #lastSentAt: Record<Channel, number> = { panTilt: 0, zoom: 0, focus: 0 }
	/** One-off commands (presets, home...) go ahead of movement */
	readonly #queue: CameraCommand[] = []

	#pump: ReturnType<typeof setInterval> | undefined
	#lastSendAt = 0
	#status: CameraStatus

	constructor(config: CameraConfig) {
		super()
		this.#config = config
		this.#status = { id: config.id, connected: false, error: undefined, lastReplyAt: undefined }
		this.#link = createLink(config)

		this.#link.on('status', (connected, error) => this.#setStatus({ connected, error }))
		this.#link.on('reply', (update) => this.#setStatus({ lastReplyAt: Date.now(), ...update }))
	}

	get id(): string {
		return this.#config.id
	}
	get status(): CameraStatus {
		return this.#status
	}

	open(): void {
		this.#link.open()
		this.#pump = setInterval(() => this.#tick(), Math.max(this.#config.sendInterval, 5))
	}

	async close(): Promise<void> {
		// The link stops the camera itself, rather than through the pump, which is about to go away
		clearInterval(this.#pump)
		await this.#link.close()
	}

	setMotion(motion: Motion): void {
		this.#desired = { ...motion }
	}

	stop(): void {
		this.#desired = { ...STOPPED }
	}

	command(command: CameraCommand): void {
		this.#queue.push(command)
	}

	#setStatus(update: Partial<CameraStatus>): void {
		this.#status = { ...this.#status, ...update }
		this.emit('status', this.#status)
	}

	#markSent(): void {
		this.#lastSendAt = Date.now()
	}

	/** Pick the single most useful message to send this tick */
	#tick(): void {
		// A link still busy with the last message gets the latest state once it's free, not a backlog
		if (!this.#link.ready) return

		const queued = this.#queue.shift()
		if (queued) {
			this.#link.command(queued)
			this.#markSent()
			return
		}

		const now = Date.now()
		const channels: Channel[] = ['panTilt', 'zoom', 'focus']

		// Changes first. A stop goes ahead of any speed change, so letting go never waits behind
		// another axis. Otherwise the one waiting longest, so a stick that never sits still can't
		// hold back the others where each is its own message (Panasonic sends one every 130 ms).
		// Ties keep priority order.
		const changed = channels
			.filter((channel) => this.#changed(channel))
			.sort((a, b) => Number(this.#moving(a)) - Number(this.#moving(b)) || this.#lastSentAt[a] - this.#lastSentAt[b])[0]
		if (changed) {
			this.#sendChannel(changed, now, true)
			return
		}

		// Then any stop still owed a repeat, then refreshes for whatever is still moving
		for (const channel of channels) {
			if (this.#stopsPending[channel] > 0) {
				this.#sendChannel(channel, now, false)
				return
			}
		}
		for (const channel of channels) {
			if (this.#moving(channel) && now - this.#lastSentAt[channel] >= REFRESH_INTERVAL) {
				this.#sendChannel(channel, now, false)
				return
			}
		}

		if (now - this.#lastSendAt >= IDLE_PING_INTERVAL) {
			this.#link.ping()
			this.#markSent()
		}
	}

	#changed(channel: Channel): boolean {
		const d = this.#desired
		const s = this.#sent
		if (channel === 'panTilt') return d.pan !== s.pan || d.tilt !== s.tilt
		return d[channel] !== s[channel]
	}

	#moving(channel: Channel): boolean {
		const d = this.#desired
		return channel === 'panTilt' ? d.pan !== 0 || d.tilt !== 0 : d[channel] !== 0
	}

	#sendChannel(channel: Channel, now: number, isChange: boolean): void {
		const d = this.#desired

		switch (channel) {
			case 'panTilt':
				this.#link.panTilt(d.pan, d.tilt)
				this.#sent.pan = d.pan
				this.#sent.tilt = d.tilt
				break
			case 'zoom':
				this.#link.zoom(d.zoom)
				this.#sent.zoom = d.zoom
				break
			case 'focus':
				this.#link.focus(d.focus)
				this.#sent.focus = d.focus
				break
		}
		this.#markSent()
		this.#lastSentAt[channel] = now

		if (this.#moving(channel)) {
			this.#stopsPending[channel] = 0
		} else if (isChange) {
			this.#stopsPending[channel] = STOP_REPEATS - 1
		} else if (this.#stopsPending[channel] > 0) {
			this.#stopsPending[channel]--
		}
	}
}
