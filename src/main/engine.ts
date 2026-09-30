import { EventEmitter } from 'node:events'
import { Camera, STOPPED, type CameraConfig, type CameraStatus, type Motion } from './visca/camera.js'
import * as cmd from './visca/commands.js'
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
}

export interface EngineEvents {
	state: [EngineState]
	settings: [Settings]
}

/** Actions from the window rather than a controller, acting on the camera the window shows */
export type CameraAction =
	| { type: 'presetRecall'; preset: number }
	| { type: 'presetSet'; preset: number }
	| { type: 'home' }
	| { type: 'autoFocus'; enabled: boolean }
	| { type: 'onePushFocus' }

/** Axes change at 50 Hz or more; the window does not need them that often */
const STATE_THROTTLE = 33

const EMPTY_INPUT: ControllerInput = { axes: {}, buttons: {} }

export class Engine extends EventEmitter<EngineEvents> {
	readonly #store: SettingsStore
	readonly #sources: ControllerSource[]
	readonly #cameras = new Map<string, Camera>()
	readonly #controllers = new Map<string, ControllerState>()

	#stateTimer: ReturnType<typeof setTimeout> | undefined

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
		}
	}

	start(): void {
		this.#syncCameras()
		for (const source of this.#sources) source.start()
	}

	async stop(): Promise<void> {
		await Promise.all(this.#sources.map((s) => s.stop()))
		await Promise.all([...this.#cameras.values()].map((c) => c.close()))
		this.#cameras.clear()
	}

	updateSettings(change: (settings: Settings) => void): Settings {
		const before = this.#store.get()
		const after = this.#store.update(change)
		this.#syncCameras(before.cameras)
		this.#drive()
		this.emit('settings', after)
		return after
	}

	/** An action from the window, on the camera it is showing */
	cameraAction(action: CameraAction): void {
		const cameraId = this.#store.get().activeCameraId
		if (cameraId) this.#runOnCamera(cameraId, action)
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
		const config = this.#store.get().cameras.find((c) => c.id === cameraId)
		const camera = this.#cameras.get(cameraId)
		if (!config || !camera) return

		const a = config.address
		switch (action.type) {
			case 'presetRecall':
				camera.command(cmd.presetRecall(a, action.preset))
				break
			case 'presetSet':
				camera.command(cmd.presetSet(a, action.preset))
				break
			case 'home':
				camera.command(cmd.home(a))
				break
			case 'autoFocus':
				camera.command(cmd.autoFocus(a, action.enabled))
				break
			case 'onePushFocus':
				camera.command(cmd.onePushFocus(a))
				break
		}
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
		if (this.#stateTimer) return
		this.#stateTimer = setTimeout(() => {
			this.#stateTimer = undefined
			this.emit('state', this.state)
		}, STATE_THROTTLE)
	}
}
