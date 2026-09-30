import { EventEmitter } from 'node:events'
import * as cmd from './commands.js'
import { createTransport, type TransportConfig, type ViscaTransport } from './transports.js'
import type { ViscaReply } from './replies.js'

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
}

export const PROFILES: Record<string, CameraProfile> = {
	sony: { label: 'Sony SRG / BRC / FR7', maxPan: 0x18, maxTilt: 0x17, maxZoom: 7, maxFocus: 7 },
	'sony-evi': { label: 'Sony EVI (older)', maxPan: 0x18, maxTilt: 0x14, maxZoom: 7, maxFocus: 7 },
	ptzoptics: { label: 'PTZOptics', maxPan: 0x18, maxTilt: 0x14, maxZoom: 7, maxFocus: 7 },
	generic: { label: 'Generic (conservative)', maxPan: 0x18, maxTilt: 0x14, maxZoom: 7, maxFocus: 7 },
}

export interface CameraConfig extends TransportConfig, SpeedLimits {
	id: string
	name: string
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
	readonly #transport: ViscaTransport

	#desired: Motion = { ...STOPPED }
	#sent: Motion = { ...STOPPED }
	/** Per channel: stop messages still to send, and when it was last sent */
	readonly #stopsPending: Record<Channel, number> = { panTilt: 0, zoom: 0, focus: 0 }
	readonly #lastSentAt: Record<Channel, number> = { panTilt: 0, zoom: 0, focus: 0 }
	/** One-off commands (presets, home...) go ahead of movement */
	readonly #queue: Buffer[] = []

	#pump: ReturnType<typeof setInterval> | undefined
	#lastSendAt = 0
	#status: CameraStatus

	constructor(config: CameraConfig) {
		super()
		this.#config = config
		this.#status = { id: config.id, connected: false, error: undefined, lastReplyAt: undefined }
		this.#transport = createTransport(config)

		this.#transport.on('status', (connected, error) => this.#setStatus({ connected, error }))
		this.#transport.on('reply', (reply) => this.#handleReply(reply))
	}

	get id(): string {
		return this.#config.id
	}
	get status(): CameraStatus {
		return this.#status
	}

	open(): void {
		this.#transport.open()
		this.#pump = setInterval(() => this.#tick(), Math.max(this.#config.sendInterval, 5))
	}

	async close(): Promise<void> {
		// Stop directly rather than through the pump, which is about to go away
		this.#sendNow(cmd.panTiltStop(this.#config.address))
		this.#sendNow(cmd.zoom(this.#config.address, 0))
		this.#sendNow(cmd.focus(this.#config.address, 0))
		clearInterval(this.#pump)
		await this.#transport.close()
	}

	setMotion(motion: Motion): void {
		this.#desired = { ...motion }
	}

	stop(): void {
		this.#desired = { ...STOPPED }
	}

	command(message: Buffer): void {
		this.#queue.push(message)
	}

	#handleReply(reply: ViscaReply): void {
		const error = reply.kind === 'error' ? reply.message : undefined
		// Buffer-full and cancelled are routine under fast stick movement, not worth surfacing
		const routine = reply.kind === 'error' && (reply.code === 0x03 || reply.code === 0x04)
		this.#setStatus({ lastReplyAt: Date.now(), ...(routine ? {} : { error }) })
	}

	#setStatus(update: Partial<CameraStatus>): void {
		this.#status = { ...this.#status, ...update }
		this.emit('status', this.#status)
	}

	#sendNow(message: Buffer, kind: 'command' | 'inquiry' = 'command'): void {
		this.#transport.send(message, kind)
		this.#lastSendAt = Date.now()
	}

	/** Pick the single most useful message to send this tick */
	#tick(): void {
		const queued = this.#queue.shift()
		if (queued) {
			this.#sendNow(queued)
			return
		}

		const now = Date.now()
		const channels: Channel[] = ['panTilt', 'zoom', 'focus']

		// Changes first, in priority order
		for (const channel of channels) {
			if (this.#changed(channel)) {
				this.#sendChannel(channel, now, true)
				return
			}
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

		if (now - this.#lastSendAt >= IDLE_PING_INTERVAL) this.#sendNow(cmd.powerInquiry(this.#config.address), 'inquiry')
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
		const { address } = this.#config
		const d = this.#desired

		switch (channel) {
			case 'panTilt':
				this.#sendNow(cmd.panTilt(address, d.pan, d.tilt, this.#config.maxPan, this.#config.maxTilt))
				this.#sent.pan = d.pan
				this.#sent.tilt = d.tilt
				break
			case 'zoom':
				this.#sendNow(cmd.zoom(address, d.zoom, this.#config.maxZoom))
				this.#sent.zoom = d.zoom
				break
			case 'focus':
				this.#sendNow(cmd.focus(address, d.focus, this.#config.maxFocus))
				this.#sent.focus = d.focus
				break
		}
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
