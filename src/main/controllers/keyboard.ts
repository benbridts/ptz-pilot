/**
 * The computer's own keyboard, read through ordinary DOM keydown/keyup events in the renderer's
 * focused window. Unlike the iCade path (icade.ts), which reads raw HID keyboard reports and so
 * needs macOS Input Monitoring, this never touches HID: the renderer captures KeyboardEvent.code
 * values and sends the set of currently-held keys here, exactly as the Gamepad API source works.
 *
 * The arrow keys (with WASD as an alias) drive a single stick on leftX/leftY, and a handful of
 * comfortable keys stand in for the usual gamepad buttons so the default mappings in mapping.ts
 * apply without special-casing.
 */
import { EventEmitter } from 'node:events'
import type {
	ControlDescriptor,
	ControllerInfo,
	ControllerInput,
	ControllerSource,
	ControllerSourceEvents,
} from './types.js'

/** The one keyboard: there is only ever one, so its id and info are fixed */
const KEYBOARD_ID = 'keyboard'

/** The renderer re-sends at least this often; silence for longer means the window went away */
const LOST_TIMEOUT = 750

export const KEYBOARD_AXES: ControlDescriptor[] = [
	{ id: 'leftX', label: 'Arrows / WASD ↔' },
	{ id: 'leftY', label: 'Arrows / WASD ↕' },
]

/**
 * Buttons named with the usual gamepad vocabulary so the default button mappings apply. Each is
 * driven by a KeyboardEvent.code, which is layout-independent (KeyQ is the same physical key on
 * every layout).
 */
export const KEYBOARD_BUTTONS: ControlDescriptor[] = [
	{ id: 'lb', label: 'Q' },
	{ id: 'rb', label: 'E' },
	{ id: 'south', label: 'Space' },
	{ id: 'east', label: 'F' },
	{ id: 'west', label: 'R' },
	{ id: 'north', label: 'C' },
	{ id: 'start', label: 'Enter' },
	{ id: 'select', label: 'Backspace' },
	{ id: 'left', label: 'Z' },
	{ id: 'right', label: 'X' },
	{ id: 'up', label: 'Page Up' },
	{ id: 'down', label: 'Page Down' },
]

/** The codes that push each axis one way or the other, up and right positive */
const AXIS_KEYS = {
	leftX: { positive: ['ArrowRight', 'KeyD'], negative: ['ArrowLeft', 'KeyA'] },
	leftY: { positive: ['ArrowUp', 'KeyW'], negative: ['ArrowDown', 'KeyS'] },
}

/** The code that presses each button */
const BUTTON_KEYS: Record<string, string> = {
	KeyQ: 'lb',
	KeyE: 'rb',
	Space: 'south',
	KeyF: 'east',
	KeyR: 'west',
	KeyC: 'north',
	Enter: 'start',
	Backspace: 'select',
	KeyZ: 'left',
	KeyX: 'right',
	PageUp: 'up',
	PageDown: 'down',
}

/** -1, 0 or 1 for an axis, from which of its two directions are held */
function axis(held: Set<string>, keys: { positive: string[]; negative: string[] }): number {
	const positive = keys.positive.some((code) => held.has(code))
	const negative = keys.negative.some((code) => held.has(code))
	return Number(positive) - Number(negative)
}

/** Map the set of held KeyboardEvent.code values to a controller input. Pure, for testing. */
export function readKeyboard(heldCodes: string[]): ControllerInput {
	const held = new Set(heldCodes)
	const buttons: Record<string, boolean> = Object.fromEntries(KEYBOARD_BUTTONS.map((b) => [b.id, false]))
	for (const [code, id] of Object.entries(BUTTON_KEYS)) {
		if (held.has(code)) buttons[id] = true
	}
	return {
		axes: {
			leftX: axis(held, AXIS_KEYS.leftX),
			leftY: axis(held, AXIS_KEYS.leftY),
		},
		buttons,
	}
}

const KEYBOARD_INFO: ControllerInfo = {
	id: KEYBOARD_ID,
	kind: 'keyboard',
	name: 'Keyboard',
	axes: KEYBOARD_AXES,
	buttons: KEYBOARD_BUTTONS,
}

/**
 * The keyboard as a controller source. Like a gamepad, it only appears once a key is pressed, so a
 * keyboard with nothing held doesn't permanently sit in the sidebar; it goes quiet (lost) when the
 * renderer stops sending, and is disconnected when it has let go of everything or the source stops.
 */
export class KeyboardSource extends EventEmitter<ControllerSourceEvents> implements ControllerSource {
	#connected = false
	#lastSeen = 0
	#lost = false
	#watchdog: ReturnType<typeof setInterval> | undefined

	start(): void {
		this.#watchdog = setInterval(() => this.#checkSilence(), 250)
	}

	async stop(): Promise<void> {
		clearInterval(this.#watchdog)
		this.#watchdog = undefined
		// On shutdown emit only 'disconnected', matching GamepadSource.stop(); the normal
		// nothing-held disconnect still emits 'lost' first so whatever it drove stops cleanly
		if (this.#connected) {
			this.#connected = false
			this.#lost = false
			this.emit('disconnected', KEYBOARD_ID)
		}
	}

	/** Called with every key the renderer currently sees held down */
	update(heldCodes: string[]): void {
		// Appear on the first key, and leave once nothing is held, like a gamepad with no button pressed
		if (heldCodes.length === 0) {
			if (this.#connected) this.#disconnect()
			return
		}

		if (!this.#connected) {
			this.#connected = true
			this.emit('connected', KEYBOARD_INFO)
		}
		this.#lastSeen = Date.now()
		this.#lost = false
		this.emit('input', KEYBOARD_ID, readKeyboard(heldCodes))
	}

	#checkSilence(): void {
		if (this.#connected && !this.#lost && Date.now() - this.#lastSeen > LOST_TIMEOUT) {
			this.#lost = true
			this.emit('lost', KEYBOARD_ID)
		}
	}

	#disconnect(): void {
		this.#connected = false
		// Whatever it drove must stop; skip a second 'lost' if the watchdog already sent one
		if (!this.#lost) this.emit('lost', KEYBOARD_ID)
		this.#lost = false
		this.emit('disconnected', KEYBOARD_ID)
	}
}
