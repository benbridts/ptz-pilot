/**
 * A WebSocket API for remote control and telemetry, e.g. from a Companion module.
 *
 * Messages are JSON objects with a `type`. The server sends:
 *   hello      once, on connect
 *   state      cameras and controllers: on connect, and whenever anything about them changes
 *   telemetry  what every camera and controller is doing, up to 10 times a second while it changes
 *   response   the outcome of a request that carried an `id`
 *
 * See docs/api.md for the requests.
 */
import { EventEmitter } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Engine, EngineState } from './engine.js'
import type { ApiSettings, Settings } from './settings.js'
import type { Motion } from './visca/camera.js'
import { KINDS } from './visca/transports.js'

export const API_VERSION = 1

const TELEMETRY_INTERVAL = 100
/** Clients that stop answering pings are dropped, and whatever they were moving stops */
const PING_INTERVAL = 5000

export type CameraStatusName = 'responding' | 'not-responding' | 'waiting' | 'not-connected' | 'error'

export interface ApiStatus {
	listening: boolean
	url: string | undefined
	clients: number
	error: string | undefined
}

export interface ApiEvents {
	status: [ApiStatus]
}

type Request = { id?: string | number; type?: string; [key: string]: unknown }

/** The same reading of a camera's health as the window and the tray use */
export function cameraStatusName(state: EngineState, id: string): { status: CameraStatusName; error?: string } {
	const s = state.cameras[id]
	if (!s) return { status: 'not-connected' }
	if (s.error) return { status: 'error', error: s.error }
	if (!s.connected) return { status: 'not-connected' }
	if (s.lastReplyAt && Date.now() - s.lastReplyAt < 10_000) return { status: 'responding' }
	return { status: s.lastReplyAt ? 'not-responding' : 'waiting' }
}

class RequestError extends Error {}

export class ApiServer extends EventEmitter<ApiEvents> {
	readonly #engine: Engine
	readonly #version: string
	#server: WebSocketServer | undefined
	#config: ApiSettings | undefined
	#status: ApiStatus = { listening: false, url: undefined, clients: 0, error: undefined }

	#lastState = ''
	#lastTelemetry = ''
	#telemetryTimer: ReturnType<typeof setInterval> | undefined
	#pingTimer: ReturnType<typeof setInterval> | undefined
	readonly #alive = new WeakMap<WebSocket, boolean>()
	readonly #clientIds = new WeakMap<WebSocket, string>()
	#nextClient = 1

	constructor(engine: Engine, version: string) {
		super()
		this.#engine = engine
		this.#version = version

		engine.on('settings', (settings) => {
			this.#configure(settings.api)
			this.#broadcastStateIfChanged()
		})
		// Controllers coming and going, and camera health, arrive as engine state
		engine.on('state', () => this.#broadcastStateIfChanged())
	}

	get status(): ApiStatus {
		return this.#status
	}

	start(): void {
		this.#configure(this.#engine.settings.api)
		this.#telemetryTimer = setInterval(() => this.#broadcastTelemetryIfChanged(), TELEMETRY_INTERVAL)
		this.#pingTimer = setInterval(() => this.#ping(), PING_INTERVAL)
	}

	async stop(): Promise<void> {
		clearInterval(this.#telemetryTimer)
		clearInterval(this.#pingTimer)
		await this.#close()
	}

	// --- Server lifecycle ------------------------------------------------------

	#configure(config: ApiSettings): void {
		const changed = JSON.stringify(config) !== JSON.stringify(this.#config)
		this.#config = { ...config }
		if (!changed) return

		void this.#close().then(() => {
			if (config.enabled) this.#listen(config)
		})
	}

	#listen(config: ApiSettings): void {
		const host = config.allowRemote ? '0.0.0.0' : '127.0.0.1'
		const server = new WebSocketServer({ host, port: config.port })
		this.#server = server

		server.on('listening', () => {
			const shown = config.allowRemote ? 'this computer’s address' : '127.0.0.1'
			this.#setStatus({ listening: true, url: `ws://${shown}:${config.port}`, error: undefined })
		})
		server.on('error', (e: NodeJS.ErrnoException) => {
			const error = e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use` : e.message
			this.#setStatus({ listening: false, url: undefined, error })
		})
		server.on('connection', (socket) => this.#onConnection(socket))
	}

	async #close(): Promise<void> {
		const server = this.#server
		this.#server = undefined
		if (!server) return
		for (const client of server.clients) client.terminate()
		await new Promise<void>((resolve) => server.close(() => resolve()))
		this.#setStatus({ listening: false, url: undefined, clients: 0 })
	}

	#setStatus(update: Partial<ApiStatus>): void {
		this.#status = { ...this.#status, ...update }
		this.emit('status', this.#status)
	}

	// --- Clients -----------------------------------------------------------------

	#onConnection(socket: WebSocket): void {
		const clientId = `api:${this.#nextClient++}:`
		this.#clientIds.set(socket, clientId)
		this.#alive.set(socket, true)
		this.#setStatus({ clients: this.#server?.clients.size ?? 0 })

		socket.on('pong', () => this.#alive.set(socket, true))
		socket.on('message', (data) => this.#onMessage(socket, data.toString()))
		socket.on('close', () => {
			// Nothing a client was moving keeps moving once it has gone
			this.#engine.clearExternalMotion(clientId)
			this.#setStatus({ clients: this.#server?.clients.size ?? 0 })
		})

		this.#send(socket, { type: 'hello', app: 'PTZ Pilot', version: this.#version, apiVersion: API_VERSION })
		this.#send(socket, this.#stateMessage())
		this.#send(socket, this.#telemetryMessage())
	}

	#ping(): void {
		for (const socket of this.#server?.clients ?? []) {
			if (!this.#alive.get(socket)) {
				socket.terminate()
				continue
			}
			this.#alive.set(socket, false)
			socket.ping()
		}
	}

	#send(socket: WebSocket, message: object): void {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
	}

	#broadcast(message: string): void {
		for (const socket of this.#server?.clients ?? []) if (socket.readyState === socket.OPEN) socket.send(message)
	}

	#onMessage(socket: WebSocket, text: string): void {
		let request: Request
		try {
			request = JSON.parse(text)
			if (!request || typeof request !== 'object') throw new Error()
		} catch {
			this.#send(socket, { type: 'response', ok: false, error: 'Messages must be JSON objects' })
			return
		}

		const respond = (ok: boolean, extra: object = {}) => {
			if (request.id !== undefined) this.#send(socket, { type: 'response', id: request.id, ok, ...extra })
		}
		try {
			const result = this.#handle(socket, request)
			respond(true, result ? { result } : {})
		} catch (e) {
			const error = e instanceof RequestError ? e.message : `Internal error: ${(e as Error).message}`
			// Errors are always reported, even without an id, so a client isn't left guessing
			this.#send(socket, {
				type: 'response',
				...(request.id !== undefined ? { id: request.id } : {}),
				ok: false,
				error,
			})
		}
	}

	// --- Requests ----------------------------------------------------------------

	#handle(socket: WebSocket, r: Request): object | undefined {
		const engine = this.#engine
		const clientId = this.#clientIds.get(socket)!

		switch (r.type) {
			case 'getState':
				return this.#stateMessage()

			case 'selectCamera': {
				const camera = this.#camera(r.camera)
				engine.updateSettings((s) => {
					s.activeCameraId = camera
				})
				return undefined
			}

			case 'setControllerCamera': {
				const controller = this.#controller(r.controller)
				const camera =
					r.camera === null || r.camera === undefined || r.camera === '' ? undefined : this.#camera(r.camera)
				engine.updateSettings((s) => {
					s.controllers.find((c) => c.id === controller)!.cameraId = camera
				})
				return undefined
			}

			case 'stepControllerCamera': {
				const step = r.step === -1 || r.step === 'previous' ? -1 : 1
				engine.stepControllerCamera(this.#controller(r.controller), step)
				return undefined
			}

			case 'presetRecall':
			case 'presetStore': {
				const preset = Number(r.preset)
				// Presets are numbered from 1, as in the window; the wire counts from 0
				if (!Number.isInteger(preset) || preset < 1 || preset > 256) throw new RequestError('preset must be 1-256')
				engine.cameraAction(
					{ type: r.type === 'presetRecall' ? 'presetRecall' : 'presetSet', preset: preset - 1 },
					this.#cameraOrActive(r.camera),
				)
				return undefined
			}

			case 'home':
				engine.cameraAction({ type: 'home' }, this.#cameraOrActive(r.camera))
				return undefined

			case 'onePushFocus':
				engine.cameraAction({ type: 'onePushFocus' }, this.#cameraOrActive(r.camera))
				return undefined

			case 'autoFocus':
				engine.cameraAction({ type: 'autoFocus', enabled: r.enabled !== false }, this.#cameraOrActive(r.camera))
				return undefined

			case 'move': {
				const camera = this.#cameraOrActive(r.camera)
				const fraction: Partial<Motion> = {}
				for (const key of ['pan', 'tilt', 'zoom', 'focus'] as const) {
					if (r[key] === undefined) continue
					if (typeof r[key] !== 'number' || !Number.isFinite(r[key]))
						throw new RequestError(`${key} must be a number, -1 to 1`)
					fraction[key] = r[key] as number
				}
				// Held until a stop, or until this client disconnects
				engine.setExternalMotion(`${clientId}${camera}`, camera, fraction)
				return undefined
			}

			case 'stop':
				engine.clearExternalMotion(r.camera === undefined ? clientId : `${clientId}${this.#camera(r.camera)}`)
				return undefined

			default:
				throw new RequestError(`Unknown request type ${JSON.stringify(r.type)}`)
		}
	}

	/** Accept a camera by id, by name, or by its number in the list (from 1) */
	#camera(value: unknown): string {
		const cameras = this.#engine.settings.cameras
		const camera =
			cameras.find((c) => c.id === value) ??
			cameras.find((c) => typeof value === 'string' && c.name.toLowerCase() === value.toLowerCase()) ??
			(typeof value === 'number' ? cameras[value - 1] : undefined)
		if (!camera) throw new RequestError(`No camera ${JSON.stringify(value)}`)
		return camera.id
	}

	#cameraOrActive(value: unknown): string {
		if (value !== undefined && value !== null && value !== '') return this.#camera(value)
		const active = this.#engine.settings.activeCameraId
		if (!active) throw new RequestError('No camera given, and none selected')
		return active
	}

	/** Accept a controller by id or by name */
	#controller(value: unknown): string {
		const controllers = this.#engine.settings.controllers
		const controller =
			controllers.find((c) => c.id === value) ??
			controllers.find((c) => typeof value === 'string' && c.name.toLowerCase() === value.toLowerCase())
		if (!controller) throw new RequestError(`No controller ${JSON.stringify(value)}`)
		return controller.id
	}

	// --- Outgoing ------------------------------------------------------------------

	#stateMessage(): object {
		const settings: Settings = this.#engine.settings
		const state = this.#engine.state
		return {
			type: 'state',
			activeCamera: settings.activeCameraId ?? null,
			cameras: settings.cameras.map((c, i) => ({
				id: c.id,
				number: i + 1,
				name: c.name,
				protocol: c.kind,
				address: KINDS[c.kind].serial ? c.serialPath : `${c.host}:${c.port}`,
				...cameraStatusName(state, c.id),
				controllers: settings.controllers
					.filter((x) => x.cameraId === c.id && state.controllers[x.id])
					.map((x) => x.id),
			})),
			controllers: settings.controllers.map((c) => ({
				id: c.id,
				name: c.name,
				kind: c.kind,
				connected: !!state.controllers[c.id],
				live: state.controllers[c.id]?.live ?? false,
				camera: c.cameraId ?? null,
			})),
		}
	}

	#telemetryMessage(): object {
		const state = this.#engine.state
		return {
			type: 'telemetry',
			cameras: state.motion,
			controllers: Object.fromEntries(Object.entries(state.controllers).map(([id, c]) => [id, c.motion])),
		}
	}

	#broadcastStateIfChanged(): void {
		if (!this.#server?.clients.size) return
		const message = JSON.stringify(this.#stateMessage())
		if (message === this.#lastState) return
		this.#lastState = message
		this.#broadcast(message)
	}

	#broadcastTelemetryIfChanged(): void {
		if (!this.#server?.clients.size) return
		const message = JSON.stringify(this.#telemetryMessage())
		if (message === this.#lastTelemetry) return
		this.#lastTelemetry = message
		this.#broadcast(message)
	}
}
