/**
 * Controllers read directly over HID, independent of the window and of the Gamepad API. Currently
 * Xbox controllers, with the report handling ported from companion-surface-xbox-controller.
 *
 * Direct HID can claim a controller exclusively, so other apps on the machine don't also act on
 * it. Whatever this source handles is reported to the Gamepad API source as claimed, so the same
 * controller isn't driving cameras twice.
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import HID from 'node-hid'
import { GAMEPAD_AXES } from './gamepad.js'
import { createXboxState, parseXboxReport, XBOX_BUTTON_IDS, type XboxState } from './xbox-report.js'
import type { ControlDescriptor, ControllerInfo, ControllerSource, ControllerSourceEvents } from './types.js'

interface HidProduct {
	vendorId: number
	productId: number
	name: string
}

const MICROSOFT = 0x045e

/** USB and Bluetooth product ids differ, so both are listed */
export const HID_PRODUCTS: HidProduct[] = [
	...[0x0b12, 0x0b13, 0x0b20, 0x0b21].map((productId) => ({
		vendorId: MICROSOFT,
		productId,
		name: 'Xbox Wireless Controller',
	})),
	...[0x02e0, 0x02ea, 0x02fd].map((productId) => ({ vendorId: MICROSOFT, productId, name: 'Xbox One S Controller' })),
	...[0x0b00, 0x0b05, 0x0b22].map((productId) => ({
		vendorId: MICROSOFT,
		productId,
		name: 'Xbox Elite Controller Series 2',
	})),
	...[0x0b0a, 0x0b0c].map((productId) => ({ vendorId: MICROSOFT, productId, name: 'Xbox Adaptive Controller' })),
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

const SCAN_INTERVAL = 2000
const USAGE_PAGE_GENERIC_DESKTOP = 0x01
const GAMEPAD_USAGES = new Set([0x04, 0x05, 0x08])

function findProduct(vendorId: number, productId: number): HidProduct | undefined {
	return HID_PRODUCTS.find((p) => p.vendorId === vendorId && p.productId === productId)
}

/** A controller can publish several HID collections; only the gamepad one carries input */
function isGamepadCollection(device: HID.Device): boolean {
	if (device.usagePage === undefined || device.usage === undefined) return true
	return device.usagePage === USAGE_PAGE_GENERIC_DESKTOP && GAMEPAD_USAGES.has(device.usage)
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
	state: XboxState
}

export class HidSource extends EventEmitter<ControllerSourceEvents> implements ControllerSource {
	readonly #attached = new Map<string, Attached>()
	readonly #opening = new Set<string>()
	#scan: ReturnType<typeof setTimeout> | undefined
	#stopped = true

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
			const product = findProduct(device.vendorId, device.productId)
			if (!product || !device.path || !isGamepadCollection(device)) continue

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
			} catch {
				return
			}
		}
		if (this.#stopped) {
			await handle.close().catch(() => undefined)
			return
		}

		const attached: Attached = {
			info: { id, kind: 'gamepad', name: device.product || product.name, axes: GAMEPAD_AXES, buttons: XBOX_BUTTONS },
			device: handle,
			usb: { vendorId: device.vendorId, productId: device.productId },
			state: createXboxState(),
		}
		this.#attached.set(id, attached)
		this.emit('connected', attached.info)

		handle.on('data', (data: Buffer) => {
			if (!parseXboxReport(data, attached.state)) return
			const s = attached.state
			this.emit('input', id, {
				axes: {
					leftX: s.leftX,
					leftY: s.leftY,
					rightX: s.rightX,
					rightY: s.rightY,
					triggers: s.rightTrigger - s.leftTrigger,
				},
				buttons: { ...s.buttons },
			})
		})
		handle.on('error', () => void this.#gone(id))
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
		await attached.device.close().catch(() => undefined)
	}
}
