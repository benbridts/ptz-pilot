import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readKeyboard, KeyboardSource, KEYBOARD_AXES, KEYBOARD_BUTTONS } from '../src/main/controllers/keyboard.js'
import { defaultLayout, defaultButtons } from '../src/main/mapping.js'
import type { ControllerInfo } from '../src/main/controllers/types.js'

test('keyboard: arrow keys drive the stick with up and right positive', () => {
	assert.deepEqual(readKeyboard(['ArrowUp']).axes, { leftX: 0, leftY: 1 })
	assert.deepEqual(readKeyboard(['ArrowDown']).axes, { leftX: 0, leftY: -1 })
	assert.deepEqual(readKeyboard(['ArrowRight']).axes, { leftX: 1, leftY: 0 })
	assert.deepEqual(readKeyboard(['ArrowLeft']).axes, { leftX: -1, leftY: 0 })
	// A diagonal is two directions at once
	assert.deepEqual(readKeyboard(['ArrowUp', 'ArrowRight']).axes, { leftX: 1, leftY: 1 })
})

test('keyboard: opposite keys held together cancel to zero', () => {
	assert.deepEqual(readKeyboard(['ArrowUp', 'ArrowDown']).axes, { leftX: 0, leftY: 0 })
	assert.deepEqual(readKeyboard(['ArrowLeft', 'ArrowRight']).axes, { leftX: 0, leftY: 0 })
})

test('keyboard: WASD is an alias for the arrow stick', () => {
	assert.deepEqual(readKeyboard(['KeyW']).axes, readKeyboard(['ArrowUp']).axes)
	assert.deepEqual(readKeyboard(['KeyS']).axes, readKeyboard(['ArrowDown']).axes)
	assert.deepEqual(readKeyboard(['KeyA']).axes, readKeyboard(['ArrowLeft']).axes)
	assert.deepEqual(readKeyboard(['KeyD']).axes, readKeyboard(['ArrowRight']).axes)
	// W and D together is the same up-right as ArrowUp and ArrowRight
	assert.deepEqual(readKeyboard(['KeyW', 'KeyD']).axes, { leftX: 1, leftY: 1 })
})

test('keyboard: held keys map to the right button ids, others stay false', () => {
	const input = readKeyboard(['KeyQ', 'Space', 'PageUp'])
	assert.equal(input.buttons.lb, true, 'Q is the left bumper')
	assert.equal(input.buttons.south, true, 'Space is the south face button')
	assert.equal(input.buttons.up, true, 'Page Up is the d-pad up')
	assert.equal(input.buttons.rb, false, 'E was not held')
	assert.equal(input.buttons.start, false, 'Enter was not held')
})

test('keyboard source: first key connects then reports input, later keys just report input', () => {
	const source = new KeyboardSource()
	const events: string[] = []
	let lastInfo: ControllerInfo | undefined
	let lastAxes: Record<string, number> | undefined
	source.on('connected', (info) => {
		lastInfo = info
		events.push('connected')
	})
	source.on('input', (_id, input) => {
		lastAxes = input.axes
		events.push('input')
	})
	source.on('lost', () => events.push('lost'))
	source.on('disconnected', () => events.push('disconnected'))

	source.update(['ArrowUp'])
	assert.deepEqual(events, ['connected', 'input'], 'first update connects then inputs')
	assert.equal(lastInfo?.kind, 'keyboard')
	assert.equal(lastInfo?.name, 'Keyboard')
	assert.equal(lastAxes?.leftY, 1)

	source.update(['ArrowRight'])
	assert.deepEqual(events, ['connected', 'input', 'input'], 'a later update only inputs')
	assert.equal(lastAxes?.leftX, 1)
})

test('keyboard source: letting go of everything disconnects the keyboard', () => {
	const source = new KeyboardSource()
	const events: string[] = []
	source.on('connected', () => events.push('connected'))
	source.on('input', () => events.push('input'))
	source.on('lost', () => events.push('lost'))
	source.on('disconnected', () => events.push('disconnected'))

	source.update(['Space'])
	source.update([])
	assert.deepEqual(events, ['connected', 'input', 'lost', 'disconnected'])
	// Nothing held and never connected: no events at all
	source.update([])
	assert.deepEqual(events, ['connected', 'input', 'lost', 'disconnected'])
})

test('keyboard source: silence past the timeout reports the keyboard lost', async () => {
	const source = new KeyboardSource()
	const events: string[] = []
	source.on('lost', () => events.push('lost'))
	source.on('disconnected', () => events.push('disconnected'))

	source.start()
	source.update(['ArrowUp'])
	// The watchdog fires on an interval; wait past LOST_TIMEOUT (750ms) for it to notice the silence
	await new Promise((resolve) => setTimeout(resolve, 1100))
	assert.deepEqual(events, ['lost'], 'gone quiet, so lost, but not yet disconnected')

	await source.stop()
	assert.deepEqual(events, ['lost', 'disconnected'], 'stop disconnects a connected keyboard')
})

test('keyboard source: stop() emits only disconnected, like the gamepad source', async () => {
	const source = new KeyboardSource()
	const events: string[] = []
	source.on('lost', () => events.push('lost'))
	source.on('disconnected', () => events.push('disconnected'))

	source.start()
	source.update(['ArrowUp'])
	// Still live (no silence): shutting down emits a single 'disconnected', not 'lost' then 'disconnected'
	await source.stop()
	assert.deepEqual(events, ['disconnected'])
})

test('keyboard default mapping: arrows pan/tilt and Q/E zoom out of the box', () => {
	const axisIds = KEYBOARD_AXES.map((a) => a.id)
	const buttonIds = KEYBOARD_BUTTONS.map((b) => b.id)

	const layout = defaultLayout('keyboard', axisIds)
	assert.equal(layout.actions.leftX, 'pan', 'left-right arrows pan')
	assert.equal(layout.actions.leftY, 'tilt', 'up-down arrows tilt')

	// With no zoom axis in the layout, the bumpers (Q/E) become hold-zoom
	const buttons = defaultButtons(axisIds, buttonIds, layout)
	assert.deepEqual(buttons.lb, { type: 'hold', channel: 'zoom', direction: -1 }, 'Q zooms out')
	assert.deepEqual(buttons.rb, { type: 'hold', channel: 'zoom', direction: 1 }, 'E zooms in')
})
