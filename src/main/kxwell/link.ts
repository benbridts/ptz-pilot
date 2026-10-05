/**
 * KXWell's level 1 protocol, spoken by the KT-RP8910 and KT-RP88810U control panels, which relay
 * it to the robotic heads they drive. ASCII over RS-232 (9600 8N1) or TCP, one command each:
 *
 *     #  [address]  [command]  [d1]  [d2]  CR
 *
 * The address is the head's, 01-FF, as two upper-case hex digits. Pan, tilt, zoom and focus each
 * take two decimal digits centred on 50, as Panasonic's do: 50 stops, 51-99 go right, up, tele or
 * far, and 49-01 the other way. Pan and tilt are separate commands.
 *
 * Presets are 00-99 on the wire, matching the 0-based numbers in the rest of the app.
 *
 * The panel never answers, so a camera's status only says whether the port or socket is open.
 *
 * KXWell's document says the head has to be powered on before it takes anything else, so every
 * connection starts with a power-on. It doesn't power the head off on close: the panel's own
 * operator may still be using it. Over IP the document also asks for `#01D61`, which is sent on
 * connecting and again with every idle check-in, in case the panel forgets it.
 */
import { EventEmitter } from 'node:events'
import type { CameraCommand, CameraConfig, CameraLink, LinkEvents } from '../visca/camera.js'
import { createTransport, type ViscaTransport } from '../visca/transports.js'
import { speedDigits } from '../panasonic/aw.js'

export const MAX_PRESET = 99
/** What KXWell's document asks an IP connection to send, verbatim */
export const IP_MODE = '#01D61'

export const addressDigits = (address: number) =>
	Math.min(Math.max(Math.round(address), 1), 255)
		.toString(16)
		.toUpperCase()
		.padStart(2, '0')

/** One command, without its CR */
export const message = (address: number, command: string) => `#${addressDigits(address)}${command}`

/** Positive pan is right, positive tilt is up */
export function pan(address: number, speed: number, max: number): string {
	return message(address, `P${speedDigits(speed, max)}`)
}

export function tilt(address: number, speed: number, max: number): string {
	return message(address, `T${speedDigits(speed, max)}`)
}

/** Speeds are 1-based as elsewhere in the app, onto the 49 steps. Positive is tele. */
export function zoom(address: number, speed: number, maxSpeed: number): string {
	return message(address, `Z${speedDigits(speed, maxSpeed + 1)}`)
}

/** As zoom. Positive focuses further away. */
export function focus(address: number, speed: number, maxSpeed: number): string {
	return message(address, `F${speedDigits(speed, maxSpeed + 1)}`)
}

export const powerOn = (address: number) => message(address, 'O1')

/** The message for a command, or a reason it can't be sent */
export function commandMessage(address: number, command: CameraCommand): string | { error: string } {
	switch (command.type) {
		case 'presetRecall':
		case 'presetSet': {
			const p = command.preset
			if (!Number.isInteger(p) || p < 0 || p > MAX_PRESET)
				return { error: `KXWell heads have presets 1-${MAX_PRESET + 1}` }
			return message(address, `${command.type === 'presetRecall' ? 'R' : 'M'}${String(p).padStart(2, '0')}`)
		}
		case 'home':
			return { error: 'KXWell heads have no home position; save one as a preset' }
		case 'autoFocus':
		case 'autoFocusToggle':
		case 'onePushFocus':
			return { error: 'KXWell heads only focus by hand' }
	}
}

/** Over the serial and TCP transports VISCA uses; their reply parsing never sees anything */
export class KxwellLink extends EventEmitter<LinkEvents> implements CameraLink {
	readonly #config: CameraConfig
	readonly #transport: ViscaTransport
	readonly #ip: boolean
	#connected = false
	/** An error shown for a refused command. With no replies to clear it, the next send does. */
	#showingError = false

	constructor(config: CameraConfig) {
		super()
		this.#config = config
		this.#ip = config.kind === 'kxwell-tcp'
		this.#transport = createTransport({ ...config, kind: this.#ip ? 'tcp' : 'serial' })
		this.#transport.on('status', (connected, error) => {
			this.#connected = connected
			this.#showingError = false
			if (connected) {
				if (this.#ip) this.#send(IP_MODE)
				this.#send(powerOn(config.address))
			}
			this.emit('status', connected, error)
		})
	}

	/** Serial and TCP writes never back up, so there is always room for the next one */
	get ready(): boolean {
		return true
	}

	open(): void {
		this.#transport.open()
	}

	async close(): Promise<void> {
		const { address } = this.#config
		this.#send(pan(address, 0, 1), tilt(address, 0, 1), zoom(address, 0, 0), focus(address, 0, 0))
		await this.#transport.close()
	}

	panTilt(p: number, t: number): void {
		const { address, maxPan, maxTilt } = this.#config
		this.#send(pan(address, p, maxPan), tilt(address, t, maxTilt))
	}

	zoom(speed: number): void {
		this.#send(zoom(this.#config.address, speed, this.#config.maxZoom))
	}

	focus(speed: number): void {
		this.#send(focus(this.#config.address, speed, this.#config.maxFocus))
	}

	command(command: CameraCommand): void {
		const m = commandMessage(this.#config.address, command)
		if (typeof m === 'string') return this.#send(m)
		this.emit('status', this.#connected, m.error)
		this.#showingError = true
	}

	/** There's nothing to ask; over IP, repeat what the panel wants to hear */
	ping(): void {
		if (this.#ip) this.#send(IP_MODE)
	}

	/** Several messages go in one write, so pan and tilt land together */
	#send(...messages: string[]): void {
		this.#transport.send(Buffer.from(messages.map((m) => `${m}\r`).join(''), 'ascii'), 'command')
		if (this.#showingError) {
			this.#showingError = false
			this.emit('status', this.#connected)
		}
	}
}
