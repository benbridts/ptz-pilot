/**
 * Controllers that speak iCade: they pose as a Bluetooth keyboard and type one letter when a
 * control goes down and another when it comes up, so held controls can be tracked from taps.
 * The Magicsee R1 ring does this in its game mode (@ + B).
 *
 * The keys arrive as ordinary HID keyboard reports: a report id, a modifier byte, a reserved byte,
 * then up to six key codes held at once.
 */

export const ICADE_BUTTON_IDS = ['south', 'east', 'west', 'north', 'lb', 'rb'] as const
export type IcadeButton = (typeof ICADE_BUTTON_IDS)[number]
type Direction = 'up' | 'down' | 'left' | 'right'

/** Letter typed on press, letter typed on release */
const ICADE_KEYS: Record<Direction | IcadeButton, [string, string]> = {
	up: ['w', 'e'],
	down: ['x', 'z'],
	left: ['a', 'q'],
	right: ['d', 'c'],
	// As the Magicsee R1's buttons send them: A, B, C, D, then the lower and upper triggers
	south: ['u', 'f'],
	east: ['h', 'r'],
	west: ['y', 't'],
	north: ['j', 'n'],
	lb: ['o', 'g'],
	rb: ['l', 'v'],
}

/** HID keyboard usage of a lowercase letter: a is 0x04 through z at 0x1d */
const usageOf = (letter: string) => 0x04 + letter.charCodeAt(0) - 'a'.charCodeAt(0)

const OPPOSITE: Partial<Record<Direction | IcadeButton, Direction>> = {
	up: 'down',
	down: 'up',
	left: 'right',
	right: 'left',
}

const TRANSITIONS = new Map<number, { control: Direction | IcadeButton; down: boolean }>()
for (const [control, [press, release]] of Object.entries(ICADE_KEYS) as [Direction | IcadeButton, [string, string]][]) {
	TRANSITIONS.set(usageOf(press), { control, down: true })
	TRANSITIONS.set(usageOf(release), { control, down: false })
}

const KEYBOARD_REPORT_ID = 0x03
const KEYS_OFFSET = 3
const KEYS_LENGTH = 6

export interface IcadeState {
	held: Record<Direction | IcadeButton, boolean>
	/** Key codes in the last report, so a key is acted on when it arrives rather than while it stays */
	keys: Set<number>
}

export function createIcadeState(): IcadeState {
	return {
		held: Object.fromEntries(Object.keys(ICADE_KEYS).map((c) => [c, false])) as IcadeState['held'],
		keys: new Set(),
	}
}

/**
 * Update the state from one report, calling `onChange` after each control that goes down or up.
 * A quick tap can put both its letters in one report, listed by key code rather than in the order
 * they were typed, so a control whose two letters arrive together flips both ways: down then up if
 * it was up, so the press is still seen, or up then down if it was held.
 */
export function parseIcadeReport(data: Buffer, state: IcadeState, onChange: () => void): void {
	if (data.length < KEYS_OFFSET + KEYS_LENGTH || data[0] !== KEYBOARD_REPORT_ID) return
	const keys = new Set([...data.subarray(KEYS_OFFSET, KEYS_OFFSET + KEYS_LENGTH)].filter((k) => k !== 0))
	const arrived = new Map<Direction | IcadeButton, Set<boolean>>()
	for (const key of keys) {
		const transition = TRANSITIONS.get(key)
		if (!transition || state.keys.has(key)) continue
		const ways = arrived.get(transition.control) ?? new Set()
		arrived.set(transition.control, ways.add(transition.down))
	}
	state.keys = keys

	for (const [control, ways] of arrived) {
		const order = ways.size === 2 ? [!state.held[control], state.held[control]] : [...ways]
		for (const down of order) {
			if (state.held[control] === down) continue
			state.held[control] = down
			// Swung straight across, the stick doesn't always send the release of where it was
			const opposite = OPPOSITE[control as Direction]
			if (down && opposite) state.held[opposite] = false
			onChange()
		}
	}
}

/**
 * Let go of everything; false if nothing was held. For when no key has been down for a while yet
 * something is still held, meaning a release letter went missing: while any control is held, the
 * Magicsee R1 keeps the letter of the last one pressed down, and sends the release letters within
 * a few milliseconds of letting that up.
 */
export function releaseIcade(state: IcadeState): boolean {
	const controls = Object.keys(state.held) as (keyof IcadeState['held'])[]
	if (!controls.some((c) => state.held[c])) return false
	for (const c of controls) state.held[c] = false
	return true
}

/** The stick as -1, 0 or 1 on each axis, up and right positive */
export function icadeStick(state: IcadeState): { x: number; y: number } {
	const { up, down, left, right } = state.held
	return { x: Number(right) - Number(left), y: Number(up) - Number(down) }
}
