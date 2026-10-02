/**
 * Controllers read directly over HID, independent of the window and of the Gamepad API: Xbox
 * controllers, with the report handling ported from companion-surface-xbox-controller, and iCade
 * controllers such as the Magicsee R1, which pose as keyboards.
 *
 * Direct HID can claim a controller exclusively, so other apps on the machine don't also act on
 * it. Whatever this source handles is reported to the Gamepad API source as claimed, so the same
 * controller isn't driving cameras twice. For a keyboard-like controller, that claim also keeps its
 * letters from typing into whatever app is in front. macOS only lets an app read one with the Input
 * Monitoring permission.
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import HID from 'node-hid'
import { GAMEPAD_AXES } from './gamepad.js'
import { createXboxState, parseXboxReport, XBOX_BUTTON_IDS, type XboxState } from './xbox-report.js'
import {
	createIcadeState,
	icadeStick,
	parseIcadeReport,
	releaseIcade,
	ICADE_BUTTON_IDS,
	type IcadeState,
} from './icade.js'
import type {
	ControlDescriptor,
	ControllerInfo,
	ControllerInput,
	ControllerSource,
	ControllerSourceEvents,
} from './types.js'

interface HidProduct {
	vendorId: number
	productId: number
	name: string
	protocol: 'xbox' | 'icade'
	/** For ids that aren't the maker's own, the product name as well, so nothing else matches */
	productName?: string
}

const MICROSOFT = 0x045e
/** Bluetooth LE's vendor id for Apple, which the Magicsee R1 borrows */
const APPLE_BLE = 0x004c

const xbox = (name: string, productIds: number[]): HidProduct[] =>
	productIds.map((productId) => ({ vendorId: MICROSOFT, productId, name, protocol: 'xbox' }))

/** USB and Bluetooth product ids differ, so both are listed */
export const HID_PRODUCTS: HidProduct[] = [
	...xbox('Xbox Wireless Controller', [0x0b12, 0x0b13, 0x0b20, 0x0b21]),
	...xbox('Xbox One S Controller', [0x02e0, 0x02ea, 0x02fd]),
	...xbox('Xbox Elite Controller Series 2', [0x0b00, 0x0b05, 0x0b22]),
	...xbox('Xbox Adaptive Controller', [0x0b0a, 0x0b0c]),
	{ vendorId: APPLE_BLE, productId: 0x014c, name: 'Magicsee R1', protocol: 'icade', productName: 'Magicsee R1' },
]

const XBOX_BUTTON_LABELS: Record<(typeof XBOX_BUTTON_IDS)[number], string> = {
	south: 'A',
	east: 'B',
	west: 'X',
	north: 'Y',
	lb: 'Left bumper',
	rb: 'Right bumper',
	lt: 'Left trigger',
	rt: 'Right trigger',
	select: 'View',
	start: 'Menu',
	ls: 'Left stick press',
	rs: 'Right stick press',
	up: 'D-pad up',
	down: 'D-pad down',
	left: 'D-pad left',
	right: 'D-pad right',
	home: 'Xbox button',
	share: 'Share',
}
const XBOX_BUTTONS: ControlDescriptor[] = XBOX_BUTTON_IDS.map((id) => ({ id, label: XBOX_BUTTON_LABELS[id] }))

const ICADE_AXES: ControlDescriptor[] = [
	{ id: 'leftX', label: 'Stick ↔' },
	{ id: 'leftY', label: 'Stick ↕' },
]
const ICADE_BUTTON_LABELS: Record<(typeof ICADE_BUTTON_IDS)[number], string> = {
	south: 'A',
	east: 'B',
	west: 'C',
	north: 'D',
	lb: 'Lower trigger',
	rb: 'Upper trigger',
}
const ICADE_BUTTONS: ControlDescriptor[] = ICADE_BUTTON_IDS.map((id) => ({ id, label: ICADE_BUTTON_LABELS[id] }))

/**
 * An iCade stick is only on or off, so it eases in: a tap nudges the camera and holding a
 * direction builds to full speed over this long.
 */
const ICADE_RAMP_MS = 1500
/** Where the ease starts, as a fraction of full travel */
const ICADE_RAMP_START = 0.3
const ICADE_RAMP_TICK = 20
/**
 * With no key down for this long, nothing is held, whatever the letters said: the release letters
 * would have come by now. It keeps a lost release from leaving a camera moving.
 */
const ICADE_SILENCE_RELEASE = 300

const SCAN_INTERVAL = 2000
const USAGE_PAGE_GENERIC_DESKTOP = 0x01
const GAMEPAD_USAGES = new Set([0x04, 0x05, 0x08])
const KEYBOARD_USAGES = new Set([0x06])
/** What opening a keyboard-like device fails with until the app has Input Monitoring */
const NOT_PERMITTED = /not permitted|0xE00002E2/i

function findProduct(device: HID.Device): HidProduct | undefined {
	return HID_PRODUCTS.find(
		(p) =>
			p.vendorId === device.vendorId &&
			p.productId === device.productId &&
			(!p.productName || p.productName === device.product),
	)
}

/** A controller can publish several HID collections; only one of them carries its input */
function isInputCollection(device: HID.Device, product: HidProduct): boolean {
	if (device.usagePage === undefined || device.usage === undefined) return true
	const usages = product.protocol === 'icade' ? KEYBOARD_USAGES : GAMEPAD_USAGES
	return device.usagePage === USAGE_PAGE_GENERIC_DESKTOP && usages.has(device.usage)
}

/** Some platforms invent a serial by hashing the ids, which is no use for telling pads apart */
function realSerial(device: HID.Device): string | undefined {
	if (!device.serialNumber) return undefined
	const synthetic = createHash('sha1').update(`${device.vendorId}:${device.productId}`).digest('hex').slice(0, 20)
	return device.serialNumber === synthetic ? undefined : device.serialNumber
}

interface Attached {
	info: ControllerInfo
	device: HID.HIDAsync
	usb: { vendorId: number; productId: number }
	/** Undoes anything the protocol set going, such as a ramp timer */
	release?: () => void
}

function xboxInput(s: XboxState): ControllerInput {
	return {
		axes: {
			leftX: s.leftX,
			leftY: s.leftY,
			rightX: s.rightX,
			rightY: s.rightY,
			triggers: s.rightTrigger - s.leftTrigger,
		},
		buttons: { ...s.buttons },
	}
}

export class HidSource extends EventEmitter<ControllerSourceEvents> implements ControllerSource {
	readonly #attached = new Map<string, Attached>()
	readonly #opening = new Set<string>()
	/** Controllers already reported as needing Input Monitoring, so each is reported once */
	readonly #blocked = new Set<string>()
	#onBlocked: (name: string) => void = () => undefined
	#scan: ReturnType<typeof setTimeout> | undefined
	#stopped = true

	/** Be told when macOS won't let a controller be read until the app has Input Monitoring */
	setBlockedHandler(handler: (name: string) => void): void {
		this.#onBlocked = handler
	}

	/** Whether a pad with these USB ids is being handled here */
	claims(vendorId: number, productId: number): boolean {
		for (const a of this.#attached.values()) {
			if (a.usb.vendorId === vendorId && a.usb.productId === productId) return true
		}
		return false
	}

	start(): void {
		this.#stopped = false
		void this.#search()
	}

	async stop(): Promise<void> {
		this.#stopped = true
		clearTimeout(this.#scan)
		await Promise.all([...this.#attached.keys()].map((id) => this.#detach(id)))
	}

	async #search(): Promise<void> {
		if (this.#stopped) return
		try {
			await this.#scanOnce()
		} catch {
			// Try again on the next scan
		}
		if (!this.#stopped) this.#scan = setTimeout(() => void this.#search(), SCAN_INTERVAL)
	}

	async #scanOnce(): Promise<void> {
		const devices = await HID.devicesAsync()
		const seenPaths = new Set([...this.#attached.values()].map((a) => a.info.id))
		const countByModel = new Map<string, number>()

		for (const device of devices) {
			const product = findProduct(device)
			if (!product || !device.path || !isInputCollection(device, product)) continue

			const serial = realSerial(device)
			const model = `${device.vendorId}:${device.productId}`
			const nth = countByModel.get(model) ?? 0
			countByModel.set(model, nth + 1)
			const id = serial ? `hid:${serial}` : `hid:${model}#${nth}`

			if (seenPaths.has(id) || this.#opening.has(id)) continue
			this.#opening.add(id)
			void this.#open(id, device, product).finally(() => this.#opening.delete(id))
		}
	}

	async #open(id: string, device: HID.Device, product: HidProduct): Promise<void> {
		let handle: HID.HIDAsync
		try {
			// Prefer an exclusive claim, so the button presses don't also reach other apps
			handle = await HID.HIDAsync.open(device.path!)
		} catch {
			try {
				handle = await HID.HIDAsync.open(device.path!, { nonExclusive: true })
			} catch (err) {
				if (NOT_PERMITTED.test(String(err)) && !this.#blocked.has(id)) {
					this.#blocked.add(id)
					this.#onBlocked(device.product || product.name)
				}
				return
			}
		}
		if (this.#stopped) {
			await handle.close().catch(() => undefined)
			return
		}

		const icade = product.protocol === 'icade'
		const attached: Attached = {
			info: {
				id,
				kind: 'gamepad',
				name: device.product || product.name,
				axes: icade ? ICADE_AXES : GAMEPAD_AXES,
				buttons: icade ? ICADE_BUTTONS : XBOX_BUTTONS,
			},
			device: handle,
			usb: { vendorId: device.vendorId, productId: device.productId },
		}
		this.#blocked.delete(id)
		this.#attached.set(id, attached)
		this.emit('connected', attached.info)

		if (icade) {
			this.#readIcade(attached)
		} else {
			const state = createXboxState()
			handle.on('data', (data: Buffer) => {
				if (parseXboxReport(data, state)) this.emit('input', id, xboxInput(state))
			})
		}
		handle.on('error', () => void this.#gone(id))
	}

	#readIcade(attached: Attached): void {
		const id = attached.info.id
		const state: IcadeState = createIcadeState()
		let heldSince: number | undefined
		let ramp: ReturnType<typeof setInterval> | undefined

		const send = () => {
			const stick = icadeStick(state)
			const moving = stick.x !== 0 || stick.y !== 0
			if (moving) heldSince ??= Date.now()
			else heldSince = undefined
			const travel = moving
				? Math.min(1, ICADE_RAMP_START + ((Date.now() - heldSince!) / ICADE_RAMP_MS) * (1 - ICADE_RAMP_START))
				: 0
			this.emit('input', id, {
				axes: { leftX: stick.x * travel, leftY: stick.y * travel },
				buttons: Object.fromEntries(ICADE_BUTTON_IDS.map((b) => [b, state.held[b]])),
			})
			// Keep easing in while a direction is held; nothing to send once it is let go
			if (moving && travel < 1) ramp ??= setInterval(send, ICADE_RAMP_TICK)
			else {
				clearInterval(ramp)
				ramp = undefined
			}
		}

		let silence: ReturnType<typeof setTimeout> | undefined
		attached.release = () => {
			clearInterval(ramp)
			clearTimeout(silence)
		}
		attached.device.on('data', (data: Buffer) => {
			parseIcadeReport(data, state, send)
			clearTimeout(silence)
			if (state.keys.size === 0) {
				silence = setTimeout(() => {
					if (releaseIcade(state)) send()
				}, ICADE_SILENCE_RELEASE)
			}
		})
	}

	async #gone(id: string): Promise<void> {
		if (!this.#attached.has(id)) return
		this.emit('lost', id)
		await this.#detach(id)
		this.emit('disconnected', id)
	}

	async #detach(id: string): Promise<void> {
		const attached = this.#attached.get(id)
		if (!attached) return
		this.#attached.delete(id)
		attached.release?.()
		await attached.device.close().catch(() => undefined)
	}
}
