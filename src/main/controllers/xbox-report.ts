/**
 * Xbox controller input reports, as read directly over HID. Ported from
 * companion-surface-xbox-controller (MIT), where the layouts were worked out on hardware.
 *
 * A controller reports in one of two shapes depending on how it is attached, and the leading byte
 * says which. Over USB it speaks Microsoft's GIP protocol, which macOS and Windows hand over as
 * HID reports. Over Bluetooth it is an ordinary HID gamepad with a numbered report.
 *
 * The GIP layout was read off a Series X|S controller over USB on macOS. The Bluetooth layout has
 * not been verified on hardware yet.
 */

export const XBOX_BUTTON_IDS = [
	'south',
	'east',
	'west',
	'north',
	'lb',
	'rb',
	'lt',
	'rt',
	'select',
	'start',
	'ls',
	'rs',
	'up',
	'down',
	'left',
	'right',
	'home',
	'share',
] as const
export type XboxButton = (typeof XBOX_BUTTON_IDS)[number]

export interface XboxState {
	buttons: Record<XboxButton, boolean>
	/** Sticks -1..1 with up and right positive; triggers 0..1 */
	leftX: number
	leftY: number
	rightX: number
	rightY: number
	leftTrigger: number
	rightTrigger: number
}

export function createXboxState(): XboxState {
	return {
		buttons: Object.fromEntries(XBOX_BUTTON_IDS.map((b) => [b, false])) as Record<XboxButton, boolean>,
		leftX: 0,
		leftY: 0,
		rightX: 0,
		rightY: 0,
		leftTrigger: 0,
		rightTrigger: 0,
	}
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)
const signed = (v: number, max: number) => clamp(v / max, -1, 1)
const unsigned = (v: number, max: number) => clamp(v / max, 0, 1)

const GIP_COMMAND_INPUT = 0x20
const GIP_COMMAND_GUIDE = 0x07
const BLUETOOTH_REPORT_ID = 0x01

const GIP_OFFSET = { buttons: 4, leftTrigger: 6, rightTrigger: 8, leftX: 10, leftY: 12, rightX: 14, rightY: 16 }
const GIP_INPUT_LENGTH = 18
const GIP_GUIDE_STATE = 4
const GIP_GUIDE_LENGTH = 5
const STICK_MAX = 32767
const TRIGGER_MAX = 1023

/** The d-pad is part of the GIP button field, so diagonals are just two bits */
const GIP_BUTTON_BITS: Partial<Record<XboxButton, number>> = {
	start: 1 << 2,
	select: 1 << 3,
	south: 1 << 4,
	east: 1 << 5,
	west: 1 << 6,
	north: 1 << 7,
	up: 1 << 8,
	down: 1 << 9,
	left: 1 << 10,
	right: 1 << 11,
	lb: 1 << 12,
	rb: 1 << 13,
	ls: 1 << 14,
	rs: 1 << 15,
}

/** Offsets within a Bluetooth report body, after the report id */
const BT_OFFSET = {
	leftX: 0,
	leftY: 2,
	rightX: 4,
	rightY: 6,
	leftTrigger: 8,
	rightTrigger: 10,
	dpad: 12,
	b1: 13,
	b2: 14,
	b3: 15,
}
const BT_BODY_LENGTH = 16
const BT_STICK_MAX = 65535

const BT_BUTTONS1: Partial<Record<XboxButton, number>> = {
	south: 0x01,
	east: 0x02,
	west: 0x08,
	north: 0x10,
	lb: 0x40,
	rb: 0x80,
}
const BT_BUTTONS2: Partial<Record<XboxButton, number>> = { select: 0x04, start: 0x08, home: 0x10, ls: 0x20, rs: 0x40 }

/** The Bluetooth d-pad hat: 0 centred, then 1-8 clockwise from up */
const DPAD: Record<number, XboxButton[]> = {
	1: ['up'],
	2: ['up', 'right'],
	3: ['right'],
	4: ['down', 'right'],
	5: ['down'],
	6: ['down', 'left'],
	7: ['left'],
	8: ['up', 'left'],
}

/** Triggers also count as buttons once pulled this far */
const TRIGGER_PRESS = 0.5

/**
 * Decode a report into `state`, mutating it in place.
 * @returns true if the report was understood
 */
export function parseXboxReport(data: Buffer, state: XboxState): boolean {
	if (data.length >= GIP_GUIDE_LENGTH && data[0] === GIP_COMMAND_GUIDE) {
		// The Xbox button arrives in a frame of its own. macOS repeats each one, so act only on changes.
		state.buttons.home = data[GIP_GUIDE_STATE] !== 0
		return true
	}

	if (data.length >= GIP_INPUT_LENGTH && data[0] === GIP_COMMAND_INPUT) {
		const buttons = data.readUInt16LE(GIP_OFFSET.buttons)
		for (const [button, mask] of Object.entries(GIP_BUTTON_BITS) as [XboxButton, number][]) {
			state.buttons[button] = (buttons & mask) !== 0
		}
		state.leftTrigger = unsigned(data.readUInt16LE(GIP_OFFSET.leftTrigger), TRIGGER_MAX)
		state.rightTrigger = unsigned(data.readUInt16LE(GIP_OFFSET.rightTrigger), TRIGGER_MAX)
		state.leftX = signed(data.readInt16LE(GIP_OFFSET.leftX), STICK_MAX)
		state.leftY = signed(data.readInt16LE(GIP_OFFSET.leftY), STICK_MAX)
		state.rightX = signed(data.readInt16LE(GIP_OFFSET.rightX), STICK_MAX)
		state.rightY = signed(data.readInt16LE(GIP_OFFSET.rightY), STICK_MAX)
		setTriggerButtons(state)
		return true
	}

	if (data.length >= BT_BODY_LENGTH + 1 && data[0] === BLUETOOTH_REPORT_ID) {
		parseBluetooth(data.subarray(1), state)
		setTriggerButtons(state)
		return true
	}

	return false
}

function parseBluetooth(body: Buffer, state: XboxState): void {
	// Centre is half scale. Y is positive-downwards over Bluetooth, so it is flipped to keep up positive.
	const stick = (offset: number) => signed(body.readUInt16LE(offset) - BT_STICK_MAX / 2, BT_STICK_MAX / 2)
	state.leftX = stick(BT_OFFSET.leftX)
	state.leftY = -stick(BT_OFFSET.leftY)
	state.rightX = stick(BT_OFFSET.rightX)
	state.rightY = -stick(BT_OFFSET.rightY)
	state.leftTrigger = unsigned(body.readUInt16LE(BT_OFFSET.leftTrigger), TRIGGER_MAX)
	state.rightTrigger = unsigned(body.readUInt16LE(BT_OFFSET.rightTrigger), TRIGGER_MAX)

	for (const [button, mask] of Object.entries(BT_BUTTONS1) as [XboxButton, number][]) {
		state.buttons[button] = (body[BT_OFFSET.b1] & mask) !== 0
	}
	for (const [button, mask] of Object.entries(BT_BUTTONS2) as [XboxButton, number][]) {
		state.buttons[button] = (body[BT_OFFSET.b2] & mask) !== 0
	}
	state.buttons.share = (body[BT_OFFSET.b3] & 0x01) !== 0

	state.buttons.up = state.buttons.down = state.buttons.left = state.buttons.right = false
	for (const button of DPAD[body[BT_OFFSET.dpad]] ?? []) state.buttons[button] = true
}

function setTriggerButtons(state: XboxState): void {
	state.buttons.lt = state.leftTrigger >= TRIGGER_PRESS
	state.buttons.rt = state.rightTrigger >= TRIGGER_PRESS
}
