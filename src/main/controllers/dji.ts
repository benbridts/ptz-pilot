/**
 * DJI drone remote controllers, read over their USB serial port. Shares its protocol handling with
 * the Companion surface module (companion-surface-dji-controller).
 *
 * Only the sticks and gimbal wheel are available this way: the controller reports its buttons to
 * the DJI Fly app over the phone connection, not over this port.
 */
import { EventEmitter } from 'node:events'
import { SerialPort } from 'serialport'
import { DumlParser, encodeFrame, type DumlFrame } from './duml.js'
import type { ControlDescriptor, ControllerInfo, ControllerSource, ControllerSourceEvents } from './types.js'

interface DjiProduct {
	vendorId: number
	productId: number
	name: string
}

export const DJI_PRODUCTS: DjiProduct[] = [{ vendorId: 0x2ca3, productId: 0x1020, name: 'DJI RC-N1' }]
export const DJI_VENDOR_ID = 0x2ca3

export const DJI_AXES: ControlDescriptor[] = [
	{ id: 'leftX', label: 'Left stick ↔' },
	{ id: 'leftY', label: 'Left stick ↕' },
	{ id: 'rightX', label: 'Right stick ↔' },
	{ id: 'rightY', label: 'Right stick ↕' },
	{ id: 'wheel', label: 'Wheel' },
]

// --- Protocol ----------------------------------------------------------------

const ADDRESS_PC = 0x0a
const ADDRESS_RC = 0x06
const CMD_TYPE_REQUEST = 0x40
const CMD_SET_RC = 0x06
const CMD_GET_CHANNELS = 0x01
const CMD_ENABLE_SIMULATOR = 0x24

function request(seq: number, cmdId: number, payload: Buffer): Buffer {
	const frame: DumlFrame = {
		src: ADDRESS_PC,
		dst: ADDRESS_RC,
		seq,
		cmdType: CMD_TYPE_REQUEST,
		cmdSet: CMD_SET_RC,
		cmdId,
		payload,
	}
	return encodeFrame(frame)
}

const enableSimulator = (seq: number) => request(seq, CMD_ENABLE_SIMULATOR, Buffer.from([0x01]))
const getChannels = (seq: number) => request(seq, CMD_GET_CHANNELS, Buffer.alloc(0))

function isChannelsReply(frame: DumlFrame): boolean {
	return frame.cmdSet === CMD_SET_RC && frame.cmdId === CMD_GET_CHANNELS
}

/**
 * Status byte, then 3-byte slots holding a u16 LE one byte in. Centre 1024, travel ±660. Slot
 * order and directions confirmed on an RC-N1: up and right read high.
 */
const CHANNEL_SLOTS: Record<string, number> = { rightX: 0, rightY: 1, leftY: 2, leftX: 3, wheel: 4 }

export function parseChannels(payload: Buffer): Record<string, number> | undefined {
	const axes: Record<string, number> = {}
	for (const [axis, slot] of Object.entries(CHANNEL_SLOTS)) {
		const offset = 2 + slot * 3
		if (offset + 2 > payload.length) return undefined
		axes[axis] = Math.max(-1, Math.min(1, (payload.readUInt16LE(offset) - 1024) / 660))
	}
	return axes
}

// --- Source --------------------------------------------------------------------

const BAUD_RATE = 115200
const POLL_INTERVAL = 20
/**
 * The controller can take over a second to answer after the previous owner of the port let go of
 * it abruptly, so the probe repeats its request every PROBE_RETRY until PROBE_TIMEOUT.
 */
const PROBE_TIMEOUT = 1500
const PROBE_RETRY = 100
const SCAN_INTERVAL = 2000
/**
 * With no reply for this long the controller is treated as lost. Cameras are stopped at this
 * point, so a stick held over when the cable is pulled does not leave a camera turning.
 */
const STALE_TIMEOUT = 250

interface Attached {
	info: ControllerInfo
	port: SerialPort
	parser: DumlParser
	poll: ReturnType<typeof setInterval>
	lastReply: number
	stale: boolean
}

/** Finds DJI controllers, any number of them, and reports their sticks */
export class DjiSource extends EventEmitter<ControllerSourceEvents> implements ControllerSource {
	readonly #attached = new Map<string, Attached>()
	/** Serial numbers currently being probed, so a slow probe isn't started twice */
	readonly #probing = new Set<string>()
	#scan: ReturnType<typeof setTimeout> | undefined
	#seq = 0
	#stopped = true

	start(): void {
		this.#stopped = false
		void this.#search()
	}

	async stop(): Promise<void> {
		this.#stopped = true
		clearTimeout(this.#scan)
		await Promise.all([...this.#attached.keys()].map((id) => this.#detach(id)))
	}

	#nextSeq(): number {
		this.#seq = (this.#seq + 1) & 0xffff
		return this.#seq
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
		// Each controller shows two ports with the same serial number, and only one of them answers
		const byController = new Map<string, { product: DjiProduct; paths: string[] }>()
		for (const info of await SerialPort.list()) {
			if (!info.vendorId || !info.productId) continue
			const product = DJI_PRODUCTS.find(
				(p) => p.vendorId === parseInt(info.vendorId!, 16) && p.productId === parseInt(info.productId!, 16),
			)
			if (!product) continue
			const key = info.serialNumber ?? info.locationId ?? info.path
			const entry = byController.get(key) ?? { product, paths: [] }
			entry.paths.push(info.path)
			byController.set(key, entry)
		}

		for (const [serial, { product, paths }] of byController) {
			const id = `dji:${serial}`
			if (this.#attached.has(id) || this.#probing.has(id)) continue
			this.#probing.add(id)
			void this.#tryAttach(id, product, paths.sort()).finally(() => this.#probing.delete(id))
		}
	}

	async #tryAttach(id: string, product: DjiProduct, paths: string[]): Promise<void> {
		for (const path of paths) {
			const port = await openPort(path).catch(() => undefined)
			if (!port) continue
			if (await this.#probe(port)) {
				if (this.#stopped) {
					await closePort(port)
					return
				}
				this.#attach(port, { id, kind: 'dji', name: product.name, axes: DJI_AXES, buttons: [] })
				return
			}
			await closePort(port)
		}
	}

	async #probe(port: SerialPort): Promise<boolean> {
		const parser = new DumlParser()
		return new Promise((resolve) => {
			const onData = (data: Buffer) => {
				if (parser.push(data).some(isChannelsReply)) finish(true)
			}
			const ask = () => {
				port.write(enableSimulator(this.#nextSeq()))
				port.write(getChannels(this.#nextSeq()))
			}
			const retry = setInterval(ask, PROBE_RETRY)
			const timeout = setTimeout(() => finish(false), PROBE_TIMEOUT)
			const finish = (ok: boolean) => {
				clearInterval(retry)
				clearTimeout(timeout)
				port.off('data', onData)
				resolve(ok)
			}
			port.on('data', onData)
			ask()
		})
	}

	#attach(port: SerialPort, info: ControllerInfo): void {
		const attached: Attached = {
			info,
			port,
			parser: new DumlParser(),
			lastReply: Date.now(),
			stale: false,
			poll: setInterval(() => this.#pollOnce(attached), POLL_INTERVAL),
		}
		this.#attached.set(info.id, attached)
		this.emit('connected', info)

		port.on('data', (data: Buffer) => {
			for (const frame of attached.parser.push(data)) {
				if (!isChannelsReply(frame)) continue
				const axes = parseChannels(frame.payload)
				if (!axes) continue

				attached.lastReply = Date.now()
				attached.stale = false
				this.emit('input', info.id, { axes, buttons: {} })
			}
		})
		port.on('close', () => void this.#gone(info.id))
		port.on('error', () => void this.#gone(info.id))
	}

	#pollOnce(attached: Attached): void {
		const silence = Date.now() - attached.lastReply
		if (silence > STALE_TIMEOUT && !attached.stale) {
			attached.stale = true
			this.emit('lost', attached.info.id)
			// It may have dropped out of simulator mode, e.g. after a power cycle
			attached.port.write(enableSimulator(this.#nextSeq()))
		}
		if (silence > SCAN_INTERVAL) {
			void this.#gone(attached.info.id)
			return
		}
		attached.port.write(getChannels(this.#nextSeq()))
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
		clearInterval(attached.poll)
		if (attached.port.isOpen) await closePort(attached.port)
	}
}

function openPort(path: string): Promise<SerialPort> {
	return new Promise((resolve, reject) => {
		const port = new SerialPort({ path, baudRate: BAUD_RATE, autoOpen: false })
		port.open((e) => (e ? reject(e) : resolve(port)))
	})
}

function closePort(port: SerialPort): Promise<void> {
	return new Promise((resolve) => port.close(() => resolve()))
}
