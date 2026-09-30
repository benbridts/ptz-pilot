import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	assignAction,
	axesToMotion,
	DEFAULT_AXIS,
	LAYOUTS,
	layoutMapping,
	matchingLayout,
	mergeMotion,
	shapeAxis,
	toSpeed,
} from '../src/main/mapping.js'
import { sanitiseMapping, sanitiseSettings } from '../src/main/settings.js'
import { PROFILES } from '../src/main/visca/camera.js'

const DJI_AXES = ['leftX', 'leftY', 'rightX', 'rightY', 'wheel']
const GAMEPAD_AXES = ['leftX', 'leftY', 'rightX', 'rightY', 'triggers']
const djiDefault = () => layoutMapping(DJI_AXES, LAYOUTS.dji.right.actions)

test('mapping shapes and scales', () => {
	const m = { ...DEFAULT_AXIS, deadzone: 0.1, saturation: 0.1, curve: 1 }
	assert.equal(shapeAxis(0.05, m), 0)
	assert.equal(shapeAxis(0.95, m), 1)
	assert.equal(shapeAxis(-0.5, m), -0.5)
	assert.equal(shapeAxis(-0.5, { ...m, invert: true }), 0.5)

	// Just past the deadzone still moves, at the slowest speed
	assert.equal(toSpeed(0.001, 24, 1), 1)
	assert.equal(toSpeed(-1, 24, 1), -24)
	assert.equal(toSpeed(1, 24, 0.5), 12)

	const motion = axesToMotion({ rightX: 1, rightY: -1, leftY: 1 }, djiDefault(), PROFILES.ptzoptics)
	assert.deepEqual(motion, { pan: 24, tilt: -20, zoom: 8, focus: 0 })
})

test('gamepad default layout: left stick pan/tilt, triggers zoom', () => {
	const m = layoutMapping(GAMEPAD_AXES, LAYOUTS.gamepad.leftTriggers.actions)
	const motion = axesToMotion({ leftX: -1, leftY: 1, triggers: -1 }, m, PROFILES.sony)
	assert.deepEqual(motion, { pan: -24, tilt: 23, zoom: -8, focus: 0 })
	assert.equal(matchingLayout('gamepad', GAMEPAD_AXES, m), 'leftTriggers')
})

test('assigning a movement moves it off the axis that had it', () => {
	const m = assignAction(djiDefault(), 'leftX', 'pan')
	assert.equal(m.leftX.action, 'pan')
	assert.equal(m.rightX.action, 'none', 'right stick X gave up pan')
	assert.equal(m.rightY.action, 'tilt', 'others untouched')
	assert.equal(axesToMotion({ leftX: -1, rightX: 1 }, m, PROFILES.sony).pan, -24, 'pan follows the left stick')
	assert.equal(matchingLayout('dji', DJI_AXES, m), undefined, 'no longer a named layout')
})

test('layouts keep tuning for axes whose job is unchanged', () => {
	const tuned = djiDefault()
	tuned.wheel = { ...tuned.wheel, deadzone: 0.2 }
	const m = layoutMapping(DJI_AXES, LAYOUTS.dji.left.actions, tuned)
	assert.equal(m.leftX.action, 'pan')
	assert.equal(m.rightY.action, 'zoom')
	assert.equal(m.rightX.action, 'none', 'axes a layout leaves out do nothing')
	assert.equal(m.wheel.deadzone, 0.2, 'wheel still focuses, so it keeps its deadzone')
})

test('a movement given to two axes is kept on the first only', () => {
	const m = sanitiseMapping({ ...djiDefault(), leftX: { ...DEFAULT_AXIS, action: 'pan' } })
	const panners = Object.entries(m).filter(([, a]) => a.action === 'pan')
	assert.equal(panners.length, 1)
})

test('two controllers on one camera: the harder push wins per movement', () => {
	assert.deepEqual(mergeMotion({ pan: 5, tilt: 0, zoom: -2, focus: 0 }, { pan: -9, tilt: 3, zoom: 1, focus: 0 }), {
		pan: -9,
		tilt: 3,
		zoom: -2,
		focus: 0,
	})
})

test('old single-DJI settings migrate, both historic shapes', () => {
	// The very first shape: keyed by movement, naming the axis
	const first = sanitiseSettings({
		mapping: {
			pan: { source: 'leftX', invert: true, deadzone: 0.1, saturation: 0, curve: 1, maxSpeed: 0.5 },
			tilt: { source: 'leftY' },
			zoom: { source: 'none' },
			focus: { source: 'wheel' },
		},
	} as never)
	assert.equal(first.legacyDjiMapping?.leftX.action, 'pan')
	assert.equal(first.legacyDjiMapping?.leftX.invert, true)
	assert.equal(first.legacyDjiMapping?.leftX.maxSpeed, 0.5)
	assert.equal(first.legacyDjiMapping?.wheel.action, 'focus')

	// The second: keyed by axis, with actions
	const second = sanitiseSettings({ mapping: djiDefault() } as never)
	assert.equal(second.legacyDjiMapping?.rightX.action, 'pan')
	assert.deepEqual(second.controllers, [])
})

test('controller settings drop references to cameras that are gone', () => {
	const s = sanitiseSettings({
		cameras: [{ id: 'cam-a', name: 'A' }],
		controllers: [
			{
				id: 'pad',
				kind: 'gamepad',
				name: 'Pad',
				cameraId: 'cam-gone',
				axes: {},
				buttons: {
					south: { type: 'selectCamera', cameraId: 'cam-gone' },
					north: { type: 'selectCamera', cameraId: 'cam-a' },
				},
			},
		],
	} as never)
	assert.equal(s.controllers[0].cameraId, undefined)
	assert.deepEqual(s.controllers[0].buttons.south, { type: 'none' })
	assert.deepEqual(s.controllers[0].buttons.north, { type: 'selectCamera', cameraId: 'cam-a' })
})
