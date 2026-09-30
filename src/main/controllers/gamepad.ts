/**
 * Gamepads read through Chromium's Gamepad API. The renderer polls navigator.getGamepads() on a
 * timer (not requestAnimationFrame, which Chromium suspends when the window is hidden) and sends
 * each pad's raw state here. This covers Xbox, PlayStation, Switch Pro, 8BitDo and most other
 * gamepads without per-brand code.
 */
import { EventEmitter } from 'node:events'
import type {
	ControlDescriptor,
	ControllerInfo,
	ControllerInput,
	ControllerSource,
	ControllerSourceEvents,
} from './types.js'

/** What the renderer sends for each connected pad */
export interface RawGamepad {
	/** Chromium's id string, e.g. "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" */
	id: string
	/** Which of the pads sharing this id string it is, counting from 0 */
	nth: number
	mapping: string
	axes: number[]
	buttons: number[]
}

/** Buttons of the W3C "standard" layout, in index order, named for any brand */
const STANDARD_BUTTONS: ControlDescriptor[] = [
	{ id: 'south', label: 'Bottom face (A / ✕ / B)' },
	{ id: 'east', label: 'Right face (B / ○ / A)' },
	{ id: 'west', label: 'Left face (X / □ / Y)' },
	{ id: 'north', label: 'Top face (Y / △ / X)' },
	{ id: 'lb', label: 'Left bumper' },
	{ id: 'rb', label: 'Right bumper' },
	{ id: 'lt', label: 'Left trigger' },
	{ id: 'rt', label: 'Right trigger' },
	{ id: 'select', label: 'View / Share / −' },
	{ id: 'start', label: 'Menu / Options / +' },
	{ id: 'ls', label: 'Left stick press' },
	{ id: 'rs', label: 'Right stick press' },
	{ id: 'up', label: 'D-pad up' },
	{ id: 'down', label: 'D-pad down' },
	{ id: 'left', label: 'D-pad left' },
	{ id: 'right', label: 'D-pad right' },
	{ id: 'home', label: 'Home / Guide' },
]

export const GAMEPAD_AXES: ControlDescriptor[] = [
	{ id: 'leftX', label: 'Left stick ↔' },
	{ id: 'leftY', label: 'Left stick ↕' },
	{ id: 'rightX', label: 'Right stick ↔' },
	{ id: 'rightY', label: 'Right stick ↕' },
	{ id: 'triggers', label: 'Triggers (right − left)' },
]
export const GAMEPAD_BUTTONS = STANDARD_BUTTONS

/** A trigger counts as a pressed button past this */
const TRIGGER_PRESS = 0.5
/** The renderer re-sends at least this often; silence for longer means the pad or window is gone */
const LOST_TIMEOUT = 750

/** "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" → vendor and product */
export function usbIdsOf(chromiumId: string): { vendorId: number; productId: number } | undefined {
	const match = /Vendor:\s*([0-9a-f]{4})\s+Product:\s*([0-9a-f]{4})/i.exec(chromiumId)
	return match ? { vendorId: parseInt(match[1], 16), productId: parseInt(match[2], 16) } : undefined
}

function cleanName(chromiumId: string): string {
	return chromiumId.replace(/\s*\(.*\)\s*$/, '').trim() || 'Gamepad'
}

function describe(raw: RawGamepad): ControllerInfo {
	const standard = raw.mapping === 'standard'
	return {
		id: `gamepad:${raw.id}#${raw.nth}`,
		kind: 'gamepad',
		name: cleanName(raw.id),
		axes: standard ? GAMEPAD_AXES : raw.axes.map((_, i) => ({ id: `axis${i}`, label: `Axis ${i + 1}` })),
		buttons: standard ? STANDARD_BUTTONS : raw.buttons.map((_, i) => ({ id: `button${i}`, label: `Button ${i + 1}` })),
	}
}

export function readGamepad(raw: RawGamepad): ControllerInput {
	if (raw.mapping !== 'standard') {
		// No known layout: pass through as numbered inputs, flipping Y-style axes is left to invert
		return {
			axes: Object.fromEntries(raw.axes.map((v, i) => [`axis${i}`, v])),
			buttons: Object.fromEntries(raw.buttons.map((v, i) => [`button${i}`, v >= TRIGGER_PRESS])),
		}
	}

	const a = (i: number) => raw.axes[i] ?? 0
	const b = (i: number) => raw.buttons[i] ?? 0
	return {
		axes: {
			leftX: a(0),
			// The Gamepad API has down as positive; here up is positive, as on every other controller
			leftY: -a(1),
			rightX: a(2),
			rightY: -a(3),
			triggers: b(7) - b(6),
		},
		buttons: Object.fromEntries(STANDARD_BUTTONS.map((d, i) => [d.id, b(i) >= TRIGGER_PRESS])),
	}
}

export class GamepadSource extends EventEmitter<ControllerSourceEvents> implements ControllerSource {
	readonly #known = new Map<string, { info: ControllerInfo; lastSeen: number; lost: boolean }>()
	#watchdog: ReturnType<typeof setInterval> | undefined
	/** Pads another source already handles (by USB id), so they are not driven twice */
	#isClaimed: (vendorId: number, productId: number) => boolean = () => false

	/** Let another source, such as direct HID, take over pads it handles itself */
	setClaimCheck(check: (vendorId: number, productId: number) => boolean): void {
		this.#isClaimed = check
	}

	start(): void {
		this.#watchdog = setInterval(() => this.#checkSilence(), 250)
	}

	async stop(): Promise<void> {
		clearInterval(this.#watchdog)
		for (const id of this.#known.keys()) this.emit('disconnected', id)
		this.#known.clear()
	}

	/** Called with every pad the renderer currently sees */
	update(pads: RawGamepad[]): void {
		const now = Date.now()
		const present = new Set<string>()

		for (const raw of pads) {
			const usb = usbIdsOf(raw.id)
			if (usb && this.#isClaimed(usb.vendorId, usb.productId)) continue

			const info = describe(raw)
			present.add(info.id)
			let known = this.#known.get(info.id)
			if (!known) {
				known = { info, lastSeen: now, lost: false }
				this.#known.set(info.id, known)
				this.emit('connected', info)
			}
			known.lastSeen = now
			known.lost = false
			this.emit('input', info.id, readGamepad(raw))
		}

		for (const id of [...this.#known.keys()]) {
			if (!present.has(id)) this.#remove(id)
		}
	}

	#checkSilence(): void {
		const now = Date.now()
		for (const [id, known] of this.#known) {
			if (!known.lost && now - known.lastSeen > LOST_TIMEOUT) {
				known.lost = true
				this.emit('lost', id)
			}
		}
	}

	#remove(id: string): void {
		this.#known.delete(id)
		this.emit('lost', id)
		this.emit('disconnected', id)
	}
}
