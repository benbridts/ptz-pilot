import type { ControllerKind } from './controllers/types.js'
import type { Motion, SpeedLimits } from './visca/camera.js'

export type MotionChannel = keyof Motion
export const MOTION_CHANNELS: MotionChannel[] = ['pan', 'tilt', 'zoom', 'focus']

/** What one controller axis does */
export interface AxisMapping {
	/** Which camera movement this axis drives, or none */
	action: MotionChannel | 'none'
	invert: boolean
	/** Readings within this fraction of centre count as zero */
	deadzone: number
	/** Readings within this fraction of the end count as full travel, so worn sticks still reach max */
	saturation: number
	/**
	 * Response curve exponent. 1 is linear; higher gives finer control near centre while still
	 * reaching full speed at the end.
	 */
	curve: number
	/** Fraction of the camera's top speed that full travel reaches */
	maxSpeed: number
}

/** Keyed by axis id, as the controller describes its axes */
export type Mapping = Record<string, AxisMapping>

export type ButtonAction =
	| { type: 'none' }
	| { type: 'nextCamera' }
	| { type: 'previousCamera' }
	| { type: 'selectCamera'; cameraId: string }
	| { type: 'presetRecall'; preset: number }
	| { type: 'home' }
	| { type: 'onePushFocus' }
	| { type: 'autoFocus'; enabled: boolean }

/** Keyed by button id */
export type ButtonMapping = Record<string, ButtonAction>

export const DEFAULT_AXIS: Omit<AxisMapping, 'action'> = {
	invert: false,
	deadzone: 0.08,
	saturation: 0.03,
	curve: 2,
	maxSpeed: 1,
}

/** Zoom and focus feel better with a gentler curve than pan and tilt */
export const DEFAULT_CURVE: Record<MotionChannel | 'none', number> = { pan: 2, tilt: 2, zoom: 1.5, focus: 1.5, none: 2 }

type Actions = Record<string, MotionChannel | 'none'>

export interface Layout {
	label: string
	actions: Actions
}

/** Ready-made assignments per kind of controller, for switching the whole layout at once */
export const LAYOUTS: Record<ControllerKind, Record<string, Layout>> = {
	dji: {
		right: {
			label: 'Right stick pan/tilt, left stick zoom, wheel focus',
			actions: { rightX: 'pan', rightY: 'tilt', leftY: 'zoom', wheel: 'focus' },
		},
		left: {
			label: 'Left stick pan/tilt, right stick zoom, wheel focus',
			actions: { leftX: 'pan', leftY: 'tilt', rightY: 'zoom', wheel: 'focus' },
		},
		split: {
			label: 'Left stick pan, right stick tilt/zoom, wheel focus',
			actions: { leftX: 'pan', rightY: 'tilt', rightX: 'zoom', wheel: 'focus' },
		},
		wheelZoom: {
			label: 'Right stick pan/tilt, wheel zoom, left stick focus',
			actions: { rightX: 'pan', rightY: 'tilt', wheel: 'zoom', leftY: 'focus' },
		},
	},
	gamepad: {
		leftTriggers: {
			label: 'Left stick pan/tilt, triggers zoom, right stick focus',
			actions: { leftX: 'pan', leftY: 'tilt', triggers: 'zoom', rightY: 'focus' },
		},
		rightTriggers: {
			label: 'Right stick pan/tilt, triggers zoom, left stick focus',
			actions: { rightX: 'pan', rightY: 'tilt', triggers: 'zoom', leftY: 'focus' },
		},
		leftStickZoom: {
			label: 'Left stick pan/tilt, right stick zoom, triggers focus',
			actions: { leftX: 'pan', leftY: 'tilt', rightY: 'zoom', triggers: 'focus' },
		},
	},
}

export const DEFAULT_LAYOUT: Record<ControllerKind, string> = { dji: 'right', gamepad: 'leftTriggers' }

/** Buttons a gamepad starts with. D-pad and bumpers get around; face buttons recall presets. */
export const DEFAULT_GAMEPAD_BUTTONS: ButtonMapping = {
	lb: { type: 'previousCamera' },
	rb: { type: 'nextCamera' },
	left: { type: 'previousCamera' },
	right: { type: 'nextCamera' },
	south: { type: 'presetRecall', preset: 0 },
	east: { type: 'presetRecall', preset: 1 },
	west: { type: 'presetRecall', preset: 2 },
	north: { type: 'presetRecall', preset: 3 },
	start: { type: 'home' },
	select: { type: 'onePushFocus' },
}

/**
 * Build a mapping from a set of actions. Axes the layout doesn't mention do nothing. An axis that
 * keeps its job keeps its tuning; otherwise it starts from the defaults for its new one.
 */
export function layoutMapping(axisIds: string[], actions: Actions, base?: Mapping): Mapping {
	const out: Mapping = {}
	for (const axis of axisIds) {
		const action = actions[axis] ?? 'none'
		const previous = base?.[axis]
		out[axis] =
			previous && previous.action === action
				? { ...previous }
				: { ...DEFAULT_AXIS, curve: DEFAULT_CURVE[action], action }
	}
	return out
}

/** The layout id `mapping` matches exactly, if any */
export function matchingLayout(kind: ControllerKind, axisIds: string[], mapping: Mapping): string | undefined {
	return Object.entries(LAYOUTS[kind]).find(([, layout]) =>
		axisIds.every((axis) => (layout.actions[axis] ?? 'none') === (mapping[axis]?.action ?? 'none')),
	)?.[0]
}

/**
 * Give `axis` the action `action`. A camera movement belongs to one axis at a time, so whichever
 * axis had it before is freed.
 */
export function assignAction(mapping: Mapping, axis: string, action: MotionChannel | 'none'): Mapping {
	const out = structuredClone(mapping)
	if (action !== 'none') {
		for (const other of Object.keys(out)) {
			if (other !== axis && out[other].action === action) out[other].action = 'none'
		}
	}
	const current = out[axis] ?? { ...DEFAULT_AXIS, action: 'none' }
	out[axis] = current.action === action ? current : { ...current, action, curve: DEFAULT_CURVE[action] }
	return out
}

/** Apply deadzone, saturation and curve: -1..1 in, -1..1 out */
export function shapeAxis(value: number, m: Omit<AxisMapping, 'action'>): number {
	const magnitude = Math.abs(value)
	const low = Math.min(Math.max(m.deadzone, 0), 0.9)
	const high = Math.max(1 - Math.max(m.saturation, 0), low + 0.05)

	if (magnitude <= low) return 0
	const scaled = Math.min((magnitude - low) / (high - low), 1)
	const curved = scaled ** Math.max(m.curve, 0.1)

	const sign = Math.sign(value) * (m.invert ? -1 : 1)
	return curved * sign
}

/**
 * Scale a shaped value onto 1..max. Anything past the deadzone moves at least at speed 1, so the
 * first nudge off centre is never swallowed by rounding.
 */
export function toSpeed(shaped: number, max: number, maxFraction: number): number {
	if (shaped === 0) return 0
	const top = Math.max(1, Math.round(max * Math.min(Math.max(maxFraction, 0.05), 1)))
	const speed = 1 + Math.round(Math.abs(shaped) * (top - 1))
	return speed * Math.sign(shaped)
}

const CHANNEL_LIMIT: Record<MotionChannel, keyof SpeedLimits> = {
	pan: 'maxPan',
	tilt: 'maxTilt',
	zoom: 'maxZoom',
	focus: 'maxFocus',
}

/**
 * Zoom and focus speeds are 0-7 on the wire, but here speed 1 has to mean "slowest" so that 0 can
 * mean stop. So their range is shifted up by one: 1-8 here is 0-7 on the wire (see commands.ts).
 */
const RANGE_OFFSET: Record<MotionChannel, number> = { pan: 0, tilt: 0, zoom: 1, focus: 1 }

export function axesToMotion(axes: Record<string, number>, mapping: Mapping, limits: SpeedLimits): Motion {
	const motion: Motion = { pan: 0, tilt: 0, zoom: 0, focus: 0 }
	for (const [axis, m] of Object.entries(mapping)) {
		if (m.action === 'none') continue
		const max = limits[CHANNEL_LIMIT[m.action]] + RANGE_OFFSET[m.action]
		const speed = toSpeed(shapeAxis(axes[axis] ?? 0, m), max, m.maxSpeed)
		// Should two axes ever share a job, the one pushed further wins
		if (Math.abs(speed) > Math.abs(motion[m.action])) motion[m.action] = speed
	}
	return motion
}

/** When several controllers drive one camera, each movement goes to whichever pushes hardest */
export function mergeMotion(a: Motion, b: Motion): Motion {
	const pick = (x: number, y: number) => (Math.abs(y) > Math.abs(x) ? y : x)
	return {
		pan: pick(a.pan, b.pan),
		tilt: pick(a.tilt, b.tilt),
		zoom: pick(a.zoom, b.zoom),
		focus: pick(a.focus, b.focus),
	}
}
