import { EventEmitter } from 'node:events'
import * as cmd from './commands.js'
import { createTransport, type ViscaTransport, type ViscaTransportKind } from './transports.js'
import { decodeAutoFocusReply, type ViscaReply } from './replies.js'
import type { AutoFocusState, CameraCommand, CameraConfig, CameraLink, LinkEvents } from './camera.js'

/** A camera spoken to in VISCA, over any of its transports */
export class ViscaLink extends EventEmitter<LinkEvents> implements CameraLink {
	readonly #config: CameraConfig
	readonly #transport: ViscaTransport
	/** The last decoded AF mode, so a toggle can send its opposite without a round-trip */
	#autoFocus: AutoFocusState = 'unknown'
	/**
	 * Which inquiry the next completion answers. VISCA replies carry no tag, so a completion is read
	 * against the inquiry that was last sent. Cleared on any completion.
	 */
	#lastInquiry: 'power' | 'af' | undefined

	constructor(config: CameraConfig) {
		super()
		this.#config = config
		this.#transport = createTransport({ ...config, kind: config.kind as ViscaTransportKind })
		this.#transport.on('status', (connected, error) => this.emit('status', connected, error))
		this.#transport.on('reply', (reply) => this.#handleReply(reply))
	}

	/** Datagrams and serial writes never back up, so there is always room for the next one */
	get ready(): boolean {
		return true
	}

	open(): void {
		this.#transport.open()
	}

	async close(): Promise<void> {
		const { address } = this.#config
		this.#transport.send(cmd.panTiltStop(address), 'command')
		this.#transport.send(cmd.zoom(address, 0), 'command')
		this.#transport.send(cmd.focus(address, 0), 'command')
		await this.#transport.close()
	}

	panTilt(pan: number, tilt: number): void {
		const { address, maxPan, maxTilt } = this.#config
		this.#transport.send(cmd.panTilt(address, pan, tilt, maxPan, maxTilt), 'command')
	}

	zoom(speed: number): void {
		this.#transport.send(cmd.zoom(this.#config.address, speed, this.#config.maxZoom), 'command')
	}

	focus(speed: number): void {
		this.#transport.send(cmd.focus(this.#config.address, speed, this.#config.maxFocus), 'command')
	}

	command(command: CameraCommand): void {
		const a = this.#config.address
		switch (command.type) {
			case 'presetRecall':
				return this.#transport.send(cmd.presetRecall(a, command.preset), 'command')
			case 'presetSet':
				return this.#transport.send(cmd.presetSet(a, command.preset), 'command')
			case 'home':
				return this.#transport.send(cmd.home(a), 'command')
			case 'autoFocus':
				this.#transport.send(cmd.autoFocus(a, command.enabled), 'command')
				// Optimistic on send: VISCA gives no reply to correlate, so trust the command took
				return this.#setAutoFocus(command.enabled ? 'on' : 'off')
			case 'autoFocusToggle': {
				// One wire message: the opposite of the last decoded mode, or AF on when unknown
				const next = this.#autoFocus === 'on' ? 'off' : 'on'
				this.#transport.send(cmd.autoFocus(a, next === 'on'), 'command')
				return this.#setAutoFocus(next)
			}
			case 'onePushFocus':
				return this.#transport.send(cmd.onePushFocus(a), 'command')
		}
	}

	ping(): void {
		this.#lastInquiry = 'power'
		this.#transport.send(cmd.powerInquiry(this.#config.address), 'inquiry')
	}

	refreshAutoFocus(): void {
		this.#lastInquiry = 'af'
		this.#transport.send(cmd.autoFocusInquiry(this.#config.address), 'inquiry')
	}

	#setAutoFocus(state: AutoFocusState): void {
		this.#autoFocus = state
		this.emit('reply', { autoFocus: state })
	}

	#handleReply(reply: ViscaReply): void {
		if (reply.kind === 'completion') {
			// A completion answers whichever inquiry was last sent; it carries no tag of its own
			if (this.#lastInquiry === 'af') {
				const af = decodeAutoFocusReply(reply)
				if (af) this.#setAutoFocus(af)
			}
			this.#lastInquiry = undefined
		}
		// Buffer-full and cancelled are routine under fast stick movement, not worth surfacing
		const routine = reply.kind === 'error' && (reply.code === 0x03 || reply.code === 0x04)
		if (routine) this.emit('reply', {})
		else this.emit('reply', { error: reply.kind === 'error' ? reply.message : undefined })
	}
}
