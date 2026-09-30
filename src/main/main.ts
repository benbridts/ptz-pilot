import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { SerialPort } from 'serialport'
import { Engine, type CameraAction } from './engine.js'
import { SettingsStore, newCamera, type Settings } from './settings.js'
import { PROFILES, type CameraConfig } from './visca/camera.js'
import { DEFAULT_PORTS } from './visca/transports.js'
import {
	LAYOUTS,
	assignAction,
	layoutMapping,
	type AxisMapping,
	type ButtonAction,
	type MotionChannel,
} from './mapping.js'
import { DjiSource, DJI_VENDOR_ID } from './controllers/dji.js'
import { GamepadSource, type RawGamepad } from './controllers/gamepad.js'
import { HidSource } from './controllers/hid.js'
import { createTray, DEVELOPER_URL, type TrayHandle } from './tray.js'
import { ApiServer } from './api.js'

// Lets a test run use its own settings instead of the real ones
if (process.env.PTZ_PILOT_USER_DATA) app.setPath('userData', process.env.PTZ_PILOT_USER_DATA)

// A second copy would fight the first over the controllers and port 52381
if (!app.requestSingleInstanceLock()) app.exit(0)

let engine: Engine | undefined
let api: ApiServer | undefined
let window: BrowserWindow | undefined
let tray: TrayHandle | undefined
let quitting = false

/** Settings from before the app was renamed, carried over once */
function migrateOldSettings(): void {
	const target = path.join(app.getPath('userData'), 'settings.json')
	const old = path.join(app.getPath('appData'), 'DJI VISCA Controller', 'settings.json')
	if (existsSync(target) || !existsSync(old)) return
	mkdirSync(path.dirname(target), { recursive: true })
	copyFileSync(old, target)
}

function createWindow(): void {
	window = new BrowserWindow({
		width: 1180,
		height: 800,
		minWidth: 880,
		minHeight: 600,
		title: 'PTZ Pilot',
		backgroundColor: '#15171a',
		show: false,
		webPreferences: {
			preload: path.join(__dirname, '../preload/preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// The window polls gamepads; that has to keep going while it is hidden
			backgroundThrottling: false,
		},
	})

	// Renderer and preload failures are otherwise silent unless DevTools happens to be open
	window.webContents.on('preload-error', (_event, preloadPath, error) => {
		console.error(`Preload failed (${preloadPath}):`, error)
	})
	window.webContents.on('console-message', (event) => {
		if (event.level === 'warning' || event.level === 'error') console.error(`[renderer] ${event.message}`)
	})

	// Links in the page open in the browser, never in the app window
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('https://')) void shell.openExternal(url)
		return { action: 'deny' }
	})
	window.webContents.on('will-navigate', (event, url) => {
		event.preventDefault()
		if (url.startsWith('https://')) void shell.openExternal(url)
	})

	// Closing the window only hides it: cameras keep being driven, and it lives on in the tray
	window.on('close', (event) => {
		if (quitting) return
		event.preventDefault()
		window?.hide()
		if (process.platform === 'darwin') app.dock?.hide()
	})
	window.once('ready-to-show', () => window?.show())

	void window.loadFile(path.join(app.getAppPath(), 'src/renderer/index.html'))
}

function showWindow(): void {
	if (!window || window.isDestroyed()) createWindow()
	if (process.platform === 'darwin') void app.dock?.show()
	window!.show()
	window!.focus()
}

function send(channel: string, payload: unknown): void {
	if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function editController(e: Engine, id: string, change: (c: Settings['controllers'][number], s: Settings) => void) {
	return e.updateSettings((s) => {
		const controller = s.controllers.find((c) => c.id === id)
		if (controller) change(controller, s)
	})
}

function registerIpc(e: Engine, gamepads: GamepadSource, apiServer: ApiServer): void {
	ipcMain.handle('init', () => ({
		settings: e.settings,
		state: e.state,
		profiles: PROFILES,
		defaultPorts: DEFAULT_PORTS,
		layouts: LAYOUTS,
		version: app.getVersion(),
		apiStatus: apiServer.status,
	}))

	ipcMain.handle('api:save', (_event, config: Partial<Settings['api']>) =>
		e.updateSettings((s) => {
			s.api = { ...s.api, ...config }
		}),
	)
	apiServer.on('status', (status) => send('api-status', status))

	// --- Cameras
	ipcMain.handle('camera:add', (_event, partial: Partial<CameraConfig>) =>
		e.updateSettings((s) => {
			const camera = newCamera({ name: `Camera ${s.cameras.length + 1}`, ...partial })
			s.cameras.push(camera)
			s.activeCameraId = camera.id
		}),
	)
	ipcMain.handle('camera:save', (_event, camera: CameraConfig) =>
		e.updateSettings((s) => {
			s.cameras = s.cameras.map((c) => (c.id === camera.id ? camera : c))
		}),
	)
	ipcMain.handle('camera:remove', (_event, id: string) =>
		e.updateSettings((s) => {
			s.cameras = s.cameras.filter((c) => c.id !== id)
		}),
	)
	ipcMain.handle('camera:select', (_event, id: string) =>
		e.updateSettings((s) => {
			s.activeCameraId = id
		}),
	)
	ipcMain.handle('camera:action', (_event, action: CameraAction) => e.cameraAction(action))

	// --- Controllers
	ipcMain.handle('controller:camera', (_event, id: string, cameraId: string | null) =>
		editController(e, id, (c) => {
			c.cameraId = cameraId ?? undefined
		}),
	)
	ipcMain.handle('controller:assignAxis', (_event, id: string, axis: string, action: MotionChannel | 'none') =>
		editController(e, id, (c) => {
			c.axes = assignAction(c.axes, axis, action)
		}),
	)
	ipcMain.handle(
		'controller:tuneAxis',
		(_event, id: string, axis: string, tuning: Partial<Omit<AxisMapping, 'action'>>) =>
			editController(e, id, (c) => {
				// The action only changes through assignAxis, which keeps each movement on one axis
				if (c.axes[axis]) c.axes[axis] = { ...c.axes[axis], ...tuning, action: c.axes[axis].action }
			}),
	)
	ipcMain.handle('controller:layout', (_event, id: string, layoutId: string) =>
		editController(e, id, (c) => {
			const layout = LAYOUTS[c.kind][layoutId]
			if (layout) c.axes = layoutMapping(Object.keys(c.axes), layout.actions, c.axes)
		}),
	)
	ipcMain.handle('controller:button', (_event, id: string, button: string, action: ButtonAction) =>
		editController(e, id, (c) => {
			c.buttons[button] = action
		}),
	)
	ipcMain.handle('controller:forget', (_event, id: string) =>
		e.updateSettings((s) => {
			s.controllers = s.controllers.filter((c) => c.id !== id)
		}),
	)

	// The window's Gamepad API polling
	ipcMain.on('gamepads', (_event, pads: RawGamepad[]) => gamepads.update(pads))

	ipcMain.handle('serial:list', async () => {
		const ports = await SerialPort.list()
		// Leave out DJI controllers, which are not cameras
		return ports
			.filter((p) => parseInt(p.vendorId ?? '0', 16) !== DJI_VENDOR_ID)
			.map((p) => ({ path: p.path, label: p.manufacturer ?? '' }))
	})

	e.on('state', (state) => {
		send('state', state)
		tray?.update(e.settings, state)
	})
	e.on('settings', (settings) => {
		send('settings', settings)
		tray?.update(settings, e.state)
	})
}

app.on('second-instance', () => showWindow())

// Being asked to terminate (logout, shutdown, `kill`) should stop the cameras just like Quit does
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => app.quit())

app.whenReady().then(() => {
	migrateOldSettings()

	const hid = new HidSource()
	const gamepads = new GamepadSource()
	// Pads handled over HID also appear to the Gamepad API; drive them from HID only
	gamepads.setClaimCheck((vendorId, productId) => hid.claims(vendorId, productId))

	engine = new Engine(new SettingsStore(app.getPath('userData')), [new DjiSource(), hid, gamepads])
	api = new ApiServer(engine, app.getVersion())
	registerIpc(engine, gamepads, api)
	engine.start()
	api.start()

	app.setAboutPanelOptions({
		applicationName: 'PTZ Pilot',
		applicationVersion: app.getVersion(),
		copyright: 'Made by Joseph Adams',
		website: DEVELOPER_URL,
		iconPath: path.join(app.getAppPath(), 'assets', 'icon.png'),
	})

	const e = engine
	tray = createTray({
		show: showWindow,
		quit: () => app.quit(),
		assign: (controllerId, cameraId) =>
			editController(e, controllerId, (c) => {
				c.cameraId = cameraId
			}),
	})
	tray.update(engine.settings, engine.state)
	createWindow()

	app.on('activate', () => showWindow())
})

// Keep running in the tray with no window
app.on('window-all-closed', () => undefined)

app.on('before-quit', (event) => {
	quitting = true
	if (!engine) return
	// Give every camera its stop before the process goes away
	event.preventDefault()
	const e = engine
	engine = undefined
	// Nothing should reach the tray or window once they start going away
	e.removeAllListeners()
	api?.removeAllListeners()
	// However shutdown goes, don't let it keep the app from quitting
	const stopping = Promise.allSettled([api?.stop(), e.stop()])
	void Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 2000))]).finally(() => {
		tray?.destroy()
		tray = undefined
		// Exit directly: re-running quit from inside before-quit doesn't reliably finish, and
		// everything that needed doing (stopping cameras, closing ports) is done
		app.exit(0)
	})
})
