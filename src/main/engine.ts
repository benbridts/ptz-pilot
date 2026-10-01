import { EventEmitter } from 'node:events'
import {
	Camera,
	STOPPED,
	type CameraCommand,
	type CameraConfig,
	type CameraStatus,
	type Motion,
} from './visca/camera.js'
import {
	DEFAULT_GAMEPAD_BUTTONS,
	DEFAULT_LAYOUT,
	LAYOUTS,
	axesToMotion,
	layoutMapping,
	mergeMotion,
	type ButtonAction,
} from './mapping.js'
import { SettingsStore, type ControllerSettings, type Settings } from './settings.js'
import type { ControllerInfo, ControllerInput, ControllerSource } from './controllers/types.js'

export interface ControllerState {
	info: ControllerInfo
	/** False while the controller has gone quiet but not yet disconnected */
	live: boolean
	input: ControllerInput
	motion: Motion
}

export interface EngineState {
	/** Connected controllers only; settings.controllers also has the disconnected ones */
	controllers: Record<string, ControllerState>
	cameras: Record<string, CameraStatus>
	/** What each camera is being told to do right now, from all controllers and API clients */
	motion: Record<string, Motion>
}

/** A movement requested from outside (the API), as fractions of the camera's top speeds, -1..1 */
export type MotionFraction = Motion

export interface EngineEvents {
	state: [EngineState]
	settings: [Settings]
}

/** Actions from the window rather than a controller, acting on the camera the window shows */
export type CameraAction = CameraCommand

/** Axes change at 50 Hz or more; the window does not need them that often */
const STATE_THROTTLE = 33

const EMPTY_INPUT: ControllerInput = { axes: {}, buttons: {} }

/** How long any one part of shutting down may take */
const STOP_TIMEOUT = 1000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
	return Promise.race([
		promise,
		new Promise<undefined>((resolve) =>
			setTimeout(() => {
				console.warn(`Shutdown: ${label} did not finish within ${ms} ms, carrying on`)
				resolve(undefined)
			}, ms).unref(),
		),
	])
}

export class Engine extends EventEmitter<EngineEvents> {
	readonly #store: SettingsStore
	readonly #sources: ControllerSource[]
	readonly #cameras = new Map<string, Camera>()
	readonly #controllers = new Map<string, ControllerState>()

	/** Movements requested from outside, keyed by who asked, merged with controllers like one more */
	readonly #external = new Map<string, { cameraId: string; fraction: MotionFraction }>()
	#cameraMotion: Record<string, Motion> = {}

	#stateTimer: ReturnType<typeof setTimeout> | undefined
	#stopped = false

	constructor(store: SettingsStore, sources: ControllerSource[]) {
		super()
		this.#store = store
		this.#sources = sources

		for (const source of sources) {
			source.on('connected', (info) => this.#onConnected(info))
			source.on('input', (id, input) => this.#onInput(id, input))
			source.on('lost', (id) => this.#onLost(id))
			source.on('disconnected', (id) => this.#onDisconnected(id))
		}
	}

	get settings(): Settings {
		return this.#store.get()
	}

	get state(): EngineState {
		return {
			controllers: Object.fromEntries(this.#controllers),
			cameras: Object.fromEntries([...this.#cameras].map(([id, c]) => [id, c.status])),
			motion: { ...this.#cameraMotion },
		}
	}

	start(): void {
		this.#syncCameras()
		for (const source of this.#sources) source.start()
	}

	/**
	 * Cameras first: each sends its stops before anything else, so a controller that is slow to let
	 * go (a serial port stuck closing, say) can't leave a camera moving. No step may hold up the rest.
	 */
	async stop(): Promise<void> {
		this.#stopped = true
		clearTimeout(this.#stateTimer)
		const cameras = [...this.#cameras.values()]
		this.#cameras.clear()
		await Promise.allSettled(cameras.map((c) => withTimeout(c.close(), STOP_TIMEOUT, `camera ${c.id}`)))
		await Promise.allSettled(this.#sources.map((s) => withTimeout(s.stop(), STOP_TIMEOUT, s.constructor.name)))
	}

	updateSettings(change: (settings: Settings) => void): Settings {
		const before = this.#store.get()
		const after = this.#store.update(change)
		this.#syncCameras(before.cameras)
		this.#drive()
		this.emit('settings', after)
		return after
	}

	/** A one-off action, on the given camera or else the one the window is showing */
	cameraAction(action: CameraAction, cameraId = this.#store.get().activeCameraId): void {
		if (cameraId) this.#runOnCamera(cameraId, action)
	}

	/**
	 * Move a camera on behalf of `key` (an API client, say) until told otherwise. Merged with any
	 * controllers on the same camera, whichever pushes harder winning, exactly as for two controllers.
	 */
	setExternalMotion(key: string, cameraId: string, fraction: Partial<MotionFraction>): void {
		const clamp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0)
		const current = this.#external.get(key)
		const base = current?.cameraId === cameraId ? current.fraction : STOPPED
		this.#external.set(key, {
			cameraId,
			fraction: {
				pan: 'pan' in fraction ? clamp(fraction.pan) : base.pan,
				tilt: 'tilt' in fraction ? clamp(fraction.tilt) : base.tilt,
				zoom: 'zoom' in fraction ? clamp(fraction.zoom) : base.zoom,
				focus: 'focus' in fraction ? clamp(fraction.focus) : base.focus,
			},
		})
		this.#drive()
	}

	/** Drop every external movement whose key starts with `prefix`, e.g. all of one API client's */
	clearExternalMotion(prefix: string): void {
		for (const key of [...this.#external.keys()]) if (key.startsWith(prefix)) this.#external.delete(key)
		this.#drive()
	}

	/** Point a controller at the next or previous camera */
	stepControllerCamera(controllerId: string, step: 1 | -1): void {
		const settings = this.#store.get()
		const controller = settings.controllers.find((c) => c.id === controllerId)
		const cameraId = controller && this.#stepCamera(settings, controller, step)
		if (cameraId) {
			this.updateSettings((s) => {
				s.controllers.find((c) => c.id === controllerId)!.cameraId = cameraId
			})
		}
	}

	// --- Controllers -------------------------------------------------------------

	#onConnected(info: ControllerInfo): void {
		this.#controllers.set(info.id, { info, live: true, input: EMPTY_INPUT, motion: { ...STOPPED } })

		const settings = this.#store.get()
		const known = settings.controllers.find((c) => c.id === info.id)
		if (!known) {
			this.updateSettings((s) => s.controllers.push(this.#newControllerSettings(info, s)))
		} else if (known.name !== info.name || this.#missingAxes(known, info)) {
			// Keep the remembered name current, and give any axes it has gained a (blank) mapping
			this.updateSettings((s) => {
				const c = s.controllers.find((x) => x.id === info.id)!
				c.name = info.name
				for (const axis of info.axes) c.axes[axis.id] ??= layoutMapping([axis.id], {})[axis.id]
			})
		}
		this.#emitState()
	}

	#missingAxes(settings: ControllerSettings, info: ControllerInfo): boolean {
		return info.axes.some((a) => !settings.axes[a.id])
	}

	#newControllerSettings(info: ControllerInfo, settings: Settings): ControllerSettings {
		const axisIds = info.axes.map((a) => a.id)
		// A DJI controller from before per-controller settings keeps its old stick assignments
		const legacy = info.kind === 'dji' ? settings.legacyDjiMapping : undefined
		if (legacy) settings.legacyDjiMapping = undefined

		const layout = LAYOUTS[info.kind][DEFAULT_LAYOUT[info.kind]]
		const buttonIds = new Set(info.buttons.map((b) => b.id))
		return {
			id: info.id,
			kind: info.kind,
			name: info.name,
			// A new controller starts on the camera the window is showing
			cameraId: settings.activeCameraId,
			axes: legacy ? { ...layoutMapping(axisIds, {}), ...legacy } : layoutMapping(axisIds, layout.actions),
			buttons: Object.fromEntries(Object.entries(DEFAULT_GAMEPAD_BUTTONS).filter(([id]) => buttonIds.has(id))),
		}
	}

	#onInput(id: string, input: ControllerInput): void {
		const state = this.#controllers.get(id)
		if (!state) return

		const previous = state.input
		state.input = input
		state.live = true

		for (const [button, down] of Object.entries(input.buttons)) {
			if (down && !previous.buttons[button]) this.#onButton(id, button)
		}
		this.#drive()
	}

	#onLost(id: string): void {
		const state = this.#controllers.get(id)
		if (!state) return
		// Treat it as centred until it reports again, so nothing it was driving keeps moving
		state.live = false
		state.input = EMPTY_INPUT
		this.#drive()
	}

	#onDisconnected(id: string): void {
		this.#controllers.delete(id)
		this.#drive()
	}

	#onButton(controllerId: string, button: string): void {
		const settings = this.#store.get()
		const controller = settings.controllers.find((c) => c.id === controllerId)
		const action: ButtonAction = controller?.buttons[button] ?? { type: 'none' }
		if (!controller || action.type === 'none') return

		switch (action.type) {
			case 'nextCamera':
			case 'previousCamera':
			case 'selectCamera': {
				const cameraId =
					action.type === 'selectCamera'
						? action.cameraId
						: this.#stepCamera(settings, controller, action.type === 'nextCamera' ? 1 : -1)
				if (cameraId)
					this.updateSettings((s) => {
						s.controllers.find((c) => c.id === controllerId)!.cameraId = cameraId
					})
				return
			}
			default:
				if (controller.cameraId) this.#runOnCamera(controller.cameraId, action)
		}
	}

	#stepCamera(settings: Settings, controller: ControllerSettings, step: number): string | undefined {
		const cameras = settings.cameras
		if (cameras.length === 0) return undefined
		const index = cameras.findIndex((c) => c.id === controller.cameraId)
		const next = index < 0 ? 0 : (index + step + cameras.length) % cameras.length
		return cameras[next].id
	}

	#runOnCamera(
		cameraId: string,
		action: CameraAction | Exclude<ButtonAction, { type: 'none' | 'nextCamera' | 'previousCamera' | 'selectCamera' }>,
	): void {
		this.#cameras.get(cameraId)?.command(action)
	}

	// --- Driving -----------------------------------------------------------------

	/** Work out every camera's motion from every controller, and hand it on */
	#drive(): void {
		const settings = this.#store.get()
		const byCamera = new Map<string, Motion>()

		for (const [id, state] of this.#controllers) {
			const controller = settings.controllers.find((c) => c.id === id)
			const config = controller?.cameraId ? settings.cameras.find((c) => c.id === controller.cameraId) : undefined

			state.motion =
				controller && config && state.live ? axesToMotion(state.input.axes, controller.axes, config) : { ...STOPPED }
			if (config) byCamera.set(config.id, mergeMotion(byCamera.get(config.id) ?? STOPPED, state.motion))
		}

		for (const { cameraId, fraction } of this.#external.values()) {
			const config = settings.cameras.find((c) => c.id === cameraId)
			if (config)
				byCamera.set(cameraId, mergeMotion(byCamera.get(cameraId) ?? STOPPED, fractionToMotion(fraction, config)))
		}
		this.#cameraMotion = Object.fromEntries(
			[...this.#cameras.keys()].map((id) => [id, byCamera.get(id) ?? { ...STOPPED }]),
		)

		// Cameras nobody is driving any more are told to stop; unchanged ones send nothing
		for (const [id, camera] of this.#cameras) camera.setMotion(byCamera.get(id) ?? STOPPED)
		this.#emitState()
	}

	/** Open, close or reopen cameras to match settings. A changed config means a fresh connection. */
	#syncCameras(previous: CameraConfig[] = []): void {
		const wanted = new Map(this.#store.get().cameras.map((c) => [c.id, c]))
		const old = new Map(previous.map((c) => [c.id, c]))

		for (const [id, camera] of this.#cameras) {
			const next = wanted.get(id)
			if (!next || JSON.stringify(next) !== JSON.stringify(old.get(id))) {
				void camera.close()
				this.#cameras.delete(id)
			}
		}
		for (const [id, config] of wanted) {
			if (this.#cameras.has(id)) continue
			const camera = new Camera(config)
			camera.on('status', () => this.#emitState())
			camera.open()
			this.#cameras.set(id, camera)
		}
	}

	#emitState(): void {
		// Cameras still report status while closing; nobody should hear about it after stop()
		if (this.#stateTimer || this.#stopped) return
		this.#stateTimer = setTimeout(() => {
			this.#stateTimer = undefined
			this.emit('state', this.state)
		}, STATE_THROTTLE)
	}
}

/**
 * Turn fractions of top speed into camera speeds. Anything non-zero moves at least at the slowest
 * speed. Zoom and focus are 1-8 here for 0-7 on the wire, as in mapping.ts.
 */
function fractionToMotion(f: MotionFraction, limits: CameraConfig): Motion {
	const scale = (v: number, max: number) => (v === 0 ? 0 : Math.sign(v) * Math.max(1, Math.round(Math.abs(v) * max)))
	return {
		pan: scale(f.pan, limits.maxPan),
		tilt: scale(f.tilt, limits.maxTilt),
		zoom: scale(f.zoom, limits.maxZoom + 1),
		focus: scale(f.focus, limits.maxFocus + 1),
	}
}
