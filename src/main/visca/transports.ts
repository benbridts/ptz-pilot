/**
 * The ways a VISCA message can reach a camera.
 *
 * - `sony-udp`: Sony's VISCA over IP. UDP, port 52381, every message wrapped in an 8-byte header
 *   carrying a payload type and sequence number. Sony SRG/BRC/FR7, and the many cameras that copy
 *   Sony's scheme (BirdDog, Lumens, Canon CR-N, Marshall and others).
 * - `udp`: bare VISCA in UDP datagrams, no header. PTZOptics (port 1259), AVer and most generic
 *   cameras.
 * - `tcp`: bare VISCA over a TCP stream. PTZOptics (port 5678) and many generic cameras.
 * - `serial`: bare VISCA over RS-232/RS-422, through a USB adapter. Up to 7 cameras on a daisy
 *   chain, told apart by address.
 *
 * `canon` isn't VISCA at all but Canon's XC protocol over HTTP; see canon/xc.ts.
 */
import { EventEmitter } from 'node:events'
import dgram from 'node:dgram'
import net from 'node:net'
import { SerialPort } from 'serialport'
import { parseReply, ViscaStreamSplitter, type ViscaReply } from './replies.js'

export type ViscaTransportKind = 'sony-udp' | 'udp' | 'tcp' | 'serial'
export type TransportKind = ViscaTransportKind | 'canon'
export type Protocol = 'visca' | 'canon'

export interface KindInfo {
	protocol: Protocol
	/** Takes a user name and password */
	login: boolean
	/** The send interval a new camera starts with, in ms */
	sendInterval: number
}

/** What sets each kind of camera apart. Each new protocol adds its kinds here. */
export const KINDS: Record<TransportKind, KindInfo> = {
	'sony-udp': { protocol: 'visca', login: false, sendInterval: 20 },
	udp: { protocol: 'visca', login: false, sendInterval: 20 },
	tcp: { protocol: 'visca', login: false, sendInterval: 20 },
	// Serial is slow
	serial: { protocol: 'visca', login: false, sendInterval: 50 },
	// Each message is an HTTP request
	canon: { protocol: 'canon', login: true, sendInterval: 50 },
}

export function protocolOf(kind: TransportKind): Protocol {
	return KINDS[kind].protocol
}

export interface TransportConfig {
	kind: TransportKind
	host: string
	port: number
	serialPath: string
	baudRate: number
}

export const DEFAULT_PORTS: Record<Exclude<TransportKind, 'serial'>, number> = {
	'sony-udp': 52381,
	udp: 1259,
	tcp: 5678,
	canon: 80,
}

export type MessageKind = 'command' | 'inquiry'

export interface TransportEvents {
	reply: [ViscaReply]
	/** Connected means the link is up, not that a camera has answered on it */
	status: [connected: boolean, error?: string]
}

export abstract class ViscaTransport extends EventEmitter<TransportEvents> {
	abstract open(): void
	abstract close(): Promise<void>
	abstract send(message: Buffer, kind: MessageKind): void

	protected handleMessage(message: Buffer): void {
		this.emit('reply', parseReply(message))
	}
}

export function createTransport(config: TransportConfig & { kind: ViscaTransportKind }): ViscaTransport {
	switch (config.kind) {
		case 'sony-udp':
			return new SonyUdpTransport(config.host, config.port || DEFAULT_PORTS['sony-udp'])
		case 'udp':
			return new UdpTransport(config.host, config.port || DEFAULT_PORTS.udp)
		case 'tcp':
			return new TcpTransport(config.host, config.port || DEFAULT_PORTS.tcp)
		case 'serial':
			return new SerialTransport(config.serialPath, config.baudRate || 9600)
	}
}

// --- Sony VISCA over IP ------------------------------------------------------

const PAYLOAD_COMMAND = 0x0100
const PAYLOAD_INQUIRY = 0x0110
const PAYLOAD_REPLY = 0x0111
const PAYLOAD_CONTROL = 0x0200
const PAYLOAD_CONTROL_REPLY = 0x0201

const HEADER_LENGTH = 8
/** Control payload asking the camera to reset its expected sequence number */
const CONTROL_RESET = Buffer.from([0x01])
/** Control reply meaning the sequence number was not what the camera expected */
const CONTROL_ERROR = 0x0f

export function sonyHeader(payloadType: number, payload: Buffer, seq: number): Buffer {
	const header = Buffer.alloc(HEADER_LENGTH)
	header.writeUInt16BE(payloadType, 0)
	header.writeUInt16BE(payload.length, 2)
	header.writeUInt32BE(seq >>> 0, 4)
	return Buffer.concat([header, payload])
}

/** A UDP socket as a transport sees it: send to its camera, and receive that camera's datagrams */
interface UdpEndpoint {
	send(data: Buffer, port: number, host: string, callback: (error: Error | null) => void): void
	close(): Promise<void>
}

interface EndpointHandlers {
	onMessage: (data: Buffer) => void
	onReady: (warning?: string) => void
	onError: (message: string) => void
}

/** A socket of the transport's own on a random local port. Replies come back to the port that sent. */
function openPrivateEndpoint(host: string, handlers: EndpointHandlers): UdpEndpoint {
	const socket = dgram.createSocket('udp4')
	socket.on('message', (data, rinfo) => {
		if (rinfo.address === host) handlers.onMessage(data)
	})
	socket.on('error', (e) => handlers.onError(e.message))
	socket.bind(0, () => handlers.onReady())
	return {
		send: (data, port, target, callback) => socket.send(data, port, target, callback),
		close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
	}
}

/**
 * Sony cameras reply to port 52381 on the controller, whatever port the command came from, so
 * every Sony camera shares one socket bound there, and replies are routed by the camera's address.
 *
 * If something else already holds 52381 (another controller app, say), the socket falls back to a
 * random port: commands still work, but replies from cameras that insist on 52381 are lost.
 */
const SONY_LOCAL_PORT = 52381

class SharedSonySocket {
	static #instance: SharedSonySocket | undefined

	static acquire(host: string, handlers: EndpointHandlers): UdpEndpoint {
		const shared = (SharedSonySocket.#instance ??= new SharedSonySocket())
		return shared.#add(host, handlers)
	}

	#socket: dgram.Socket
	#ready = false
	#warning: string | undefined
	readonly #routes = new Map<string, Set<EndpointHandlers>>()

	private constructor() {
		this.#socket = this.#bind(SONY_LOCAL_PORT)
	}

	#bind(port: number): dgram.Socket {
		const socket = dgram.createSocket('udp4')
		socket.on('message', (data, rinfo) => {
			for (const handlers of this.#routes.get(rinfo.address) ?? []) handlers.onMessage(data)
		})
		socket.on('error', (e: NodeJS.ErrnoException) => {
			if (!this.#ready && e.code === 'EADDRINUSE' && port !== 0) {
				socket.close()
				this.#warning = `Port ${SONY_LOCAL_PORT} is in use by another program, so camera replies can't be received`
				this.#socket = this.#bind(0)
				return
			}
			for (const set of this.#routes.values()) for (const handlers of set) handlers.onError(e.message)
		})
		socket.bind(port, () => {
			this.#ready = true
			for (const set of this.#routes.values()) for (const handlers of set) handlers.onReady(this.#warning)
		})
		return socket
	}

	#add(host: string, handlers: EndpointHandlers): UdpEndpoint {
		let set = this.#routes.get(host)
		if (!set) this.#routes.set(host, (set = new Set()))
		set.add(handlers)
		if (this.#ready) queueMicrotask(() => handlers.onReady(this.#warning))

		return {
			send: (data, port, target, callback) => this.#socket.send(data, port, target, callback),
			close: async () => {
				set.delete(handlers)
				if (set.size === 0) this.#routes.delete(host)
				if (this.#routes.size === 0) await this.#close()
			},
		}
	}

	async #close(): Promise<void> {
		if (SharedSonySocket.#instance === this) SharedSonySocket.#instance = undefined
		await new Promise<void>((resolve) => this.#socket.close(() => resolve()))
	}
}

class UdpTransport extends ViscaTransport {
	protected endpoint: UdpEndpoint | undefined

	constructor(
		protected readonly host: string,
		protected readonly port: number,
	) {
		super()
	}

	open(): void {
		if (this.endpoint) return

		this.endpoint = this.openEndpoint({
			onMessage: (data) => this.handleDatagram(data),
			onReady: (warning) => {
				this.emit('status', true, warning)
				this.onOpen()
			},
			onError: (message) => this.emit('status', false, message),
		})
	}

	protected openEndpoint(handlers: EndpointHandlers): UdpEndpoint {
		return openPrivateEndpoint(this.host, handlers)
	}

	protected onOpen(): void {
		// Nothing to set up for bare VISCA
	}

	protected handleDatagram(data: Buffer): void {
		// A datagram can carry more than one reply
		for (const message of new ViscaStreamSplitter().push(data)) this.handleMessage(message)
	}

	protected sendRaw(data: Buffer): void {
		this.endpoint?.send(data, this.port, this.host, (e) => {
			if (e) this.emit('status', false, e.message)
		})
	}

	send(message: Buffer, _kind: MessageKind): void {
		this.sendRaw(message)
	}

	async close(): Promise<void> {
		const endpoint = this.endpoint
		this.endpoint = undefined
		if (!endpoint) return
		await endpoint.close()
		this.emit('status', false)
	}
}

class SonyUdpTransport extends UdpTransport {
	#seq = 0

	protected override openEndpoint(handlers: EndpointHandlers): UdpEndpoint {
		return SharedSonySocket.acquire(this.host, handlers)
	}

	protected override onOpen(): void {
		this.#reset()
	}

	#reset(): void {
		this.sendRaw(sonyHeader(PAYLOAD_CONTROL, CONTROL_RESET, 0))
		this.#seq = 0
	}

	protected override handleDatagram(data: Buffer): void {
		let offset = 0
		while (offset + HEADER_LENGTH <= data.length) {
			const type = data.readUInt16BE(offset)
			const length = data.readUInt16BE(offset + 2)
			const payload = data.subarray(offset + HEADER_LENGTH, offset + HEADER_LENGTH + length)
			offset += HEADER_LENGTH + length

			if (type === PAYLOAD_REPLY) {
				this.handleMessage(payload)
			} else if ((type === PAYLOAD_CONTROL_REPLY || type === PAYLOAD_CONTROL) && payload[0] === CONTROL_ERROR) {
				// Out of step with the camera, typically because it rebooted. Start again from 0.
				// Sony documents this as a control reply (0x0201); some cameras send it as 0x0200.
				this.#reset()
			} else if (type === PAYLOAD_CONTROL_REPLY || type === PAYLOAD_CONTROL) {
				// Acknowledges our reset. Counts as a sign of life, like any reply.
				this.emit('reply', { kind: 'ack', address: 1, socket: 0 })
			}
		}
	}

	override send(message: Buffer, kind: MessageKind): void {
		this.#seq = (this.#seq + 1) >>> 0
		this.sendRaw(sonyHeader(kind === 'inquiry' ? PAYLOAD_INQUIRY : PAYLOAD_COMMAND, message, this.#seq))
	}
}

// --- TCP ---------------------------------------------------------------------

const TCP_RECONNECT_DELAY = 2000

class TcpTransport extends ViscaTransport {
	#socket: net.Socket | undefined
	#connected = false
	#closed = false
	#reconnect: ReturnType<typeof setTimeout> | undefined
	readonly #splitter = new ViscaStreamSplitter()

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {
		super()
	}

	open(): void {
		this.#closed = false
		this.#connect()
	}

	#connect(): void {
		if (this.#socket || this.#closed) return

		const socket = net.createConnection({ host: this.host, port: this.port })
		socket.setNoDelay(true)
		this.#socket = socket

		socket.on('connect', () => {
			this.#connected = true
			this.emit('status', true)
		})
		socket.on('data', (data) => {
			for (const message of this.#splitter.push(data)) this.handleMessage(message)
		})
		socket.on('error', (e) => this.emit('status', false, e.message))
		socket.on('close', () => {
			this.#socket = undefined
			if (this.#connected) this.emit('status', false)
			this.#connected = false
			if (!this.#closed) this.#reconnect = setTimeout(() => this.#connect(), TCP_RECONNECT_DELAY)
		})
	}

	send(message: Buffer, _kind: MessageKind): void {
		// While disconnected, drop rather than queue: a movement sent late is worse than none
		if (this.#connected) this.#socket?.write(message)
	}

	async close(): Promise<void> {
		this.#closed = true
		clearTimeout(this.#reconnect)
		const socket = this.#socket
		this.#socket = undefined
		if (!socket) return
		await new Promise<void>((resolve) => socket.end(() => resolve()))
		socket.destroy()
	}
}

// --- Serial ------------------------------------------------------------------

const SERIAL_RETRY_DELAY = 2000

class SerialTransport extends ViscaTransport {
	#port: SerialPort | undefined
	#closed = false
	#retry: ReturnType<typeof setTimeout> | undefined
	readonly #splitter = new ViscaStreamSplitter()

	constructor(
		private readonly path: string,
		private readonly baudRate: number,
	) {
		super()
	}

	open(): void {
		this.#closed = false
		this.#openPort()
	}

	#openPort(): void {
		if (this.#port || this.#closed) return
		if (!this.path) {
			this.emit('status', false, 'No serial port selected')
			return
		}

		const port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false })
		port.on('data', (data: Buffer) => {
			for (const message of this.#splitter.push(data)) this.handleMessage(message)
		})
		port.on('close', () => {
			this.#port = undefined
			this.emit('status', false)
			this.#scheduleRetry()
		})
		port.open((e) => {
			if (e) {
				this.emit('status', false, e.message)
				this.#scheduleRetry()
				return
			}
			this.#port = port
			this.emit('status', true)
		})
	}

	#scheduleRetry(): void {
		if (this.#closed) return
		clearTimeout(this.#retry)
		this.#retry = setTimeout(() => this.#openPort(), SERIAL_RETRY_DELAY)
	}

	send(message: Buffer, _kind: MessageKind): void {
		this.#port?.write(message)
	}

	async close(): Promise<void> {
		this.#closed = true
		clearTimeout(this.#retry)
		const port = this.#port
		this.#port = undefined
		if (!port?.isOpen) return
		await new Promise<void>((resolve) => port.close(() => resolve()))
	}
}
