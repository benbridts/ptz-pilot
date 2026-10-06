/**
 * VISCA command builders.
 *
 * These produce the bare VISCA message — `8x ... FF` — with no transport framing. Sony's VISCA
 * over IP wraps it in an extra header; the other transports send it as is. See transports.ts.
 *
 * Speeds are signed: the sign picks the direction, the magnitude the speed. 0 means stop.
 */

const TERMINATOR = 0xff

/** Camera addresses run 1-7. Over IP only address 1 is used. */
function header(address: number): number {
	if (!Number.isInteger(address) || address < 1 || address > 7) throw new RangeError(`Invalid VISCA address ${address}`)
	return 0x80 | address
}

function clampSpeed(speed: number, max: number): number {
	return Math.min(Math.max(Math.round(Math.abs(speed)), 1), max)
}

const PAN_LEFT = 0x01
const PAN_RIGHT = 0x02
const TILT_UP = 0x01
const TILT_DOWN = 0x02
const AXIS_STOP = 0x03

/**
 * Pan-tilt drive: `8x 01 06 01 VV WW 0p 0q FF`.
 *
 * VISCA has no "speed 0", so a stopped axis still needs a valid speed byte alongside its stop
 * direction. Positive pan is right, positive tilt is up.
 */
export function panTilt(address: number, pan: number, tilt: number, maxPan: number, maxTilt: number): Buffer {
	const panDir = pan === 0 ? AXIS_STOP : pan > 0 ? PAN_RIGHT : PAN_LEFT
	const tiltDir = tilt === 0 ? AXIS_STOP : tilt > 0 ? TILT_UP : TILT_DOWN

	return Buffer.from([
		header(address),
		0x01,
		0x06,
		0x01,
		clampSpeed(pan, maxPan),
		clampSpeed(tilt, maxTilt),
		panDir,
		tiltDir,
		TERMINATOR,
	])
}

export function panTiltStop(address: number): Buffer {
	return panTilt(address, 0, 0, 1, 1)
}

/**
 * Variable zoom: `8x 01 04 07 2p FF` tele, `3p` wide, `00` stop. p is 0-7.
 * Positive zooms in (tele).
 */
export function zoom(address: number, speed: number, maxSpeed = 7): Buffer {
	return Buffer.from([header(address), 0x01, 0x04, 0x07, variableDrive(speed, maxSpeed), TERMINATOR])
}

/**
 * Variable focus: `8x 01 04 08 2p FF` far, `3p` near, `00` stop. p is 0-7.
 * Positive focuses further away. Only has an effect in manual focus mode.
 */
export function focus(address: number, speed: number, maxSpeed = 7): Buffer {
	return Buffer.from([header(address), 0x01, 0x04, 0x08, variableDrive(speed, maxSpeed), TERMINATOR])
}

/** The zoom and focus drives share an encoding: 0x2p one way, 0x3p the other, 0x00 stop */
function variableDrive(speed: number, maxSpeed: number): number {
	if (speed === 0) return 0x00
	// Speeds here are 0-based, so the slowest movement is p = 0
	const p = Math.min(Math.max(Math.round(Math.abs(speed)) - 1, 0), Math.min(maxSpeed, 7))
	return (speed > 0 ? 0x20 : 0x30) | p
}

export function autoFocus(address: number, enabled: boolean): Buffer {
	return Buffer.from([header(address), 0x01, 0x04, 0x38, enabled ? 0x02 : 0x03, TERMINATOR])
}

/** One-push autofocus: focus once, then hold */
export function onePushFocus(address: number): Buffer {
	return Buffer.from([header(address), 0x01, 0x04, 0x18, 0x01, TERMINATOR])
}

export function home(address: number): Buffer {
	return Buffer.from([header(address), 0x01, 0x06, 0x04, TERMINATOR])
}

function checkPreset(preset: number): number {
	// Sony allows 0-255 on newer models; older and most other cameras stop at 0-127 or lower
	if (!Number.isInteger(preset) || preset < 0 || preset > 0xff) throw new RangeError(`Invalid preset ${preset}`)
	return preset
}

export function presetRecall(address: number, preset: number): Buffer {
	return Buffer.from([header(address), 0x01, 0x04, 0x3f, 0x02, checkPreset(preset), TERMINATOR])
}

export function presetSet(address: number, preset: number): Buffer {
	return Buffer.from([header(address), 0x01, 0x04, 0x3f, 0x01, checkPreset(preset), TERMINATOR])
}

/** Clears the command buffers on every camera on the chain. Broadcast, so no address. */
export function ifClear(): Buffer {
	return Buffer.from([0x88, 0x01, 0x00, 0x01, TERMINATOR])
}

/** Serial only: assigns addresses along a daisy chain, starting at 1. Broadcast. */
export function addressSet(): Buffer {
	return Buffer.from([0x88, 0x30, 0x01, TERMINATOR])
}

/** Power inquiry, used as a cheap "are you there" ping: `8x 09 04 00 FF` */
export function powerInquiry(address: number): Buffer {
	return Buffer.from([header(address), 0x09, 0x04, 0x00, TERMINATOR])
}

/** Auto focus mode inquiry: `8x 09 04 38 FF`. The camera answers `y0 50 02 FF` auto, `03 FF` manual. */
export function autoFocusInquiry(address: number): Buffer {
	return Buffer.from([header(address), 0x09, 0x04, 0x38, TERMINATOR])
}
