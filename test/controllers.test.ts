import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readGamepad, usbIdsOf, GamepadSource, type RawGamepad } from '../src/main/controllers/gamepad.js'
import { createXboxState, parseXboxReport } from '../src/main/controllers/xbox-report.js'
import { parseChannels } from '../src/main/controllers/dji.js'

const pad = (partial: Partial<RawGamepad> = {}): RawGamepad => ({
	id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
	nth: 0,
	mapping: 'standard',
	axes: [0, 0, 0, 0],
	buttons: Array(17).fill(0),
	...partial,
})

test('gamepad: standard mapping, with up positive and triggers as one axis', () => {
	const buttons = Array(17).fill(0)
	buttons[0] = 1 // south
	buttons[6] = 0.25 // left trigger, lightly
	buttons[7] = 1 // right trigger, fully
	const input = readGamepad(pad({ axes: [0.5, -1, 0, 0.25], buttons }))
	assert.equal(input.axes.leftX, 0.5)
	assert.equal(input.axes.leftY, 1, 'pushed up reads positive')
	assert.equal(input.axes.rightY, -0.25)
	assert.equal(input.axes.triggers, 0.75)
	assert.equal(input.buttons.south, true)
	assert.equal(input.buttons.lt, false, 'a light trigger is not a press')
	assert.equal(input.buttons.rt, true)
})

test('gamepad: usb ids come out of the Chromium id string', () => {
	assert.deepEqual(usbIdsOf(pad().id), { vendorId: 0x045e, productId: 0x0b13 })
	assert.equal(usbIdsOf('Some Pad'), undefined)
})

test('gamepad source: pads claimed over HID are left alone', () => {
	const source = new GamepadSource()
	const connected: string[] = []
	source.on('connected', (info) => connected.push(info.name))

	source.setClaimCheck((vendorId, productId) => vendorId === 0x045e && productId === 0x0b13)
	source.update([pad(), pad({ id: '8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)' })])
	assert.deepEqual(connected, ['8BitDo Pro 2'])
})

test('gamepad source: a pad that disappears is reported lost and disconnected', () => {
	const source = new GamepadSource()
	const events: string[] = []
	source.on('connected', () => events.push('connected'))
	source.on('lost', () => events.push('lost'))
	source.on('disconnected', () => events.push('disconnected'))
	source.update([pad()])
	source.update([])
	assert.deepEqual(events, ['connected', 'lost', 'disconnected'])
})

test('xbox over USB (GIP): sticks, triggers and buttons', () => {
	const report = Buffer.alloc(18)
	report[0] = 0x20
	report.writeUInt16LE((1 << 4) | (1 << 12), 4) // A and left bumper
	report.writeUInt16LE(1023, 8) // right trigger fully
	report.writeInt16LE(32767, 10) // left stick full right
	report.writeInt16LE(-32767, 16) // right stick full down
	const state = createXboxState()
	assert.equal(parseXboxReport(report, state), true)
	assert.equal(state.buttons.south, true)
	assert.equal(state.buttons.lb, true)
	assert.equal(state.buttons.rt, true)
	assert.equal(state.leftX, 1)
	assert.equal(state.rightY, -1)

	const guide = Buffer.from([0x07, 0, 0, 0, 1])
	assert.equal(parseXboxReport(guide, state), true)
	assert.equal(state.buttons.home, true)
})

test('dji: channel reply decodes to axes', () => {
	// Status byte, then 3-byte slots: right X full right, left Y full down
	const payload = Buffer.alloc(26)
	const slot = (i: number, v: number) => payload.writeUInt16LE(v, 2 + i * 3)
	for (let i = 0; i < 8; i++) slot(i, 1024)
	slot(0, 1684)
	slot(2, 364)
	const axes = parseChannels(payload)!
	assert.equal(axes.rightX, 1)
	assert.equal(axes.leftY, -1)
	assert.equal(axes.wheel, 0)
})
