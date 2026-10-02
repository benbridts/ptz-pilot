import type { Api } from '../preload/preload.js'
import type { ControllerState, EngineState } from '../main/engine.js'
import type { ControllerSettings, Settings } from '../main/settings.js'
import type { CameraCommand, CameraConfig, CameraProfile, LimitRanges } from '../main/visca/camera.js'
import type { KindInfo, Protocol } from '../main/visca/transports.js'
import type { AxisMapping, ButtonAction, Layout, MotionChannel } from '../main/mapping.js'
import type { ControllerKind } from '../main/controllers/types.js'
import type { ApiStatus } from '../main/api.js'
import type { FoundCamera } from '../main/onvif/discovery.js'

declare global {
	interface Window {
		api: Api
	}
}

const api = window.api
const PRESET_COUNT = 16
/** Presets offered for controller buttons */
const BUTTON_PRESETS = 16
const CHANNELS: MotionChannel[] = ['pan', 'tilt', 'zoom', 'focus']
const ACTIONS: [MotionChannel | 'none', string][] = [
	['none', 'Nothing'],
	['pan', 'Pan'],
	['tilt', 'Tilt'],
	['zoom', 'Zoom'],
	['focus', 'Focus'],
]
const ACTION_LABEL = Object.fromEntries(ACTIONS) as Record<MotionChannel | 'none', string>

interface InitData {
	settings: Settings
	state: EngineState
	profiles: Record<string, CameraProfile>
	limitRanges: Record<Protocol, LimitRanges>
	defaultPorts: Record<string, number>
	kinds: Record<string, KindInfo>
	layouts: Record<ControllerKind, Record<string, Layout>>
	version: string
	apiStatus: ApiStatus
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!

let settings: Settings
let state: EngineState
let profiles: Record<string, CameraProfile> = {}
let limitRanges: Record<Protocol, LimitRanges>
let defaultPorts: Record<string, number> = {}
let kinds: Record<string, KindInfo> = {}
let layouts: InitData['layouts']

type Selection = { type: 'camera'; id: string } | { type: 'controller'; id: string } | { type: 'settings' } | undefined
let apiStatus: ApiStatus
let selection: Selection

const activeCamera = (): CameraConfig | undefined => settings.cameras.find((c) => c.id === settings.activeCameraId)
function selectedController(): ControllerSettings | undefined {
	if (selection?.type !== 'controller') return undefined
	const { id } = selection
	return settings.controllers.find((c) => c.id === id)
}

// --- Gamepads ------------------------------------------------------------------

/**
 * Poll the Gamepad API on a timer and pass every pad to the main process. A timer rather than
 * requestAnimationFrame, which Chromium suspends while the window is hidden, and the window is
 * hidden whenever it is "closed".
 */
function startGamepadPolling(): void {
	let lastSent = ''
	let lastSentAt = 0

	setInterval(() => {
		const counts = new Map<string, number>()
		const pads = []
		for (const pad of navigator.getGamepads()) {
			if (!pad?.connected) continue
			const nth = counts.get(pad.id) ?? 0
			counts.set(pad.id, nth + 1)
			pads.push({
				id: pad.id,
				nth,
				mapping: pad.mapping,
				axes: [...pad.axes],
				buttons: pad.buttons.map((b) => b.value),
			})
		}

		// Only send changes, plus a heartbeat so the main process can tell a pad is still there
		const serialised = JSON.stringify(pads)
		const now = Date.now()
		if (serialised === lastSent && now - lastSentAt < 250) return
		lastSent = serialised
		lastSentAt = now
		api.sendGamepads(pads)
	}, 10)
}

// --- Status --------------------------------------------------------------------

type Tone = 'good' | 'warn' | 'bad' | ''

/** A camera only counts as good once it has answered recently; a bound socket proves nothing */
function cameraTone(id: string): { tone: Tone; label: string } {
	const status = state.cameras[id]
	if (!status) return { tone: '', label: 'Idle' }
	if (status.error) return { tone: 'bad', label: status.error }
	if (!status.connected) return { tone: 'bad', label: 'Not connected' }
	// The app checks in every few seconds when idle, so a gap longer than that means trouble
	if (status.lastReplyAt && Date.now() - status.lastReplyAt < 10_000) return { tone: 'good', label: 'Responding' }
	if (status.lastReplyAt) return { tone: 'bad', label: 'Not responding' }
	return { tone: 'warn', label: 'No replies yet' }
}

function controllerTone(id: string): { tone: Tone; label: string } {
	const live = state.controllers[id]
	if (!live) return { tone: '', label: 'Disconnected' }
	if (!live.live) return { tone: 'warn', label: 'Not responding' }
	return { tone: 'good', label: 'Connected' }
}

function setPill(el: HTMLElement, tone: Tone, label: string): void {
	el.className = `pill ${tone}`
	el.textContent = label
}

const cameraName = (id: string | undefined) => settings.cameras.find((c) => c.id === id)?.name

// --- Sidebar -------------------------------------------------------------------

function navButton(label: string, detail: string, active: boolean, dotId: string, onClick: () => void): HTMLLIElement {
	const li = document.createElement('li')
	const button = document.createElement('button')
	button.className = active ? 'active' : ''

	const text = document.createElement('span')
	text.className = 'nav-text'
	const name = document.createElement('span')
	name.className = 'name'
	name.textContent = label
	const sub = document.createElement('span')
	sub.className = 'sub'
	sub.textContent = detail
	text.append(name, sub)

	const dot = document.createElement('span')
	dot.className = 'status-dot'
	dot.dataset.statusFor = dotId

	button.append(text, dot)
	button.addEventListener('click', onClick)
	li.append(button)
	return li
}

function renderSidebar(): void {
	const cameras = $('#camera-list')
	cameras.replaceChildren(
		...settings.cameras.map((camera) =>
			navButton(
				camera.name,
				kinds[camera.kind]?.serial ? camera.serialPath || 'Serial' : camera.host,
				selection?.type === 'camera' && selection.id === camera.id,
				`camera:${camera.id}`,
				() => select({ type: 'camera', id: camera.id }),
			),
		),
	)

	// Connected controllers first, then remembered ones
	const controllers = [...settings.controllers].sort(
		(a, b) => Number(!!state.controllers[b.id]) - Number(!!state.controllers[a.id]),
	)
	const list = $('#controller-list')
	list.replaceChildren(
		...controllers.map((c) =>
			navButton(
				c.name,
				`→ ${cameraName(c.cameraId) ?? 'no camera'}`,
				selection?.type === 'controller' && selection.id === c.id,
				`controller:${c.id}`,
				() => select({ type: 'controller', id: c.id }),
			),
		),
	)
	if (controllers.length === 0) {
		const empty = document.createElement('li')
		empty.className = 'empty'
		empty.textContent = 'None yet'
		list.append(empty)
	}
	renderDots()
}

/** Status arrives ~30 times a second, so only touch the dots; rebuilding the lists would eat clicks */
function renderDots(): void {
	for (const dot of document.querySelectorAll<HTMLElement>('[data-status-for]')) {
		const [type, ...rest] = dot.dataset.statusFor!.split(':')
		const id = rest.join(':')
		const { tone, label } = type === 'camera' ? cameraTone(id) : controllerTone(id)
		dot.className = `status-dot ${tone}`
		dot.title = label
	}
}

function select(next: Selection): void {
	releaseAll()
	selection = next
	if (next?.type === 'camera' && next.id !== settings.activeCameraId) void api.selectCamera(next.id)
	formSource = ''
	renderAll()
}

// --- Camera view -----------------------------------------------------------------

function renderCameraView(): void {
	const camera = activeCamera()
	if (!camera) return

	$('#camera-name').textContent = camera.name
	const { tone, label } = cameraTone(camera.id)
	setPill($('#camera-status'), tone, label)

	const drivers = settings.controllers.filter((c) => c.cameraId === camera.id && state.controllers[c.id])
	$('#camera-drivers').textContent = drivers.length ? `Driven by ${drivers.map((c) => c.name).join(', ')}` : ''
	renderCameraForm()
	renderCameraMotion()
}

function renderPresets(): void {
	const grid = $('#presets')
	grid.replaceChildren()
	for (let i = 1; i <= PRESET_COUNT; i++) {
		const button = document.createElement('button')
		button.className = 'button secondary'
		button.textContent = String(i)
		button.dataset.preset = String(i - 1)
		button.addEventListener('click', () => {
			const store = $<HTMLInputElement>('#store-mode').checked
			// VISCA presets are 0-based on the wire
			void api.cameraAction({ type: store ? 'presetSet' : 'presetRecall', preset: i - 1 })
			if (store) setStoreMode(false)
		})
		grid.append(button)
	}
}

/** Light a button up briefly, starting over if it is already lit */
function flash(el: Element | null): void {
	if (!el) return
	el.classList.remove('flash')
	void (el as HTMLElement).offsetWidth
	el.classList.add('flash')
}

/** Show a one-off action that reached the camera on screen, whether a controller, the API or a click sent it */
function showCameraAction(action: CameraCommand): void {
	switch (action.type) {
		case 'presetRecall':
		case 'presetSet':
			return flash(document.querySelector(`#presets [data-preset="${action.preset}"]`))
		case 'autoFocus':
			return flash(document.querySelector(`[data-action="${action.enabled ? 'autoFocusOn' : 'autoFocusOff'}"]`))
		default:
			return flash(document.querySelector(`[data-action="${action.type}"]`))
	}
}

/** Light the arrows for the way the camera is being moved, from every controller and API client together */
function renderCameraMotion(): void {
	const camera = activeCamera()
	const motion = camera && state.motion[camera.id]
	// Zoom and focus speeds are one more than the limits, as in mapping.ts
	const top: Record<MotionChannel, number> = camera
		? { pan: camera.maxPan, tilt: camera.maxTilt, zoom: camera.maxZoom + 1, focus: camera.maxFocus + 1 }
		: { pan: 1, tilt: 1, zoom: 1, focus: 1 }
	for (const el of document.querySelectorAll<HTMLElement>('#camera-motion [data-motion]')) {
		const channel = el.dataset.motion as MotionChannel
		const value = (motion?.[channel] ?? 0) * Number(el.dataset.sign)
		el.classList.toggle('on', value > 0)
		el.style.setProperty('--level', String(value > 0 ? Math.min(value / Math.max(top[channel], 1), 1) : 0))
	}
}

/** Channels held down with the window's own controls, each +1 or -1, from the mouse and keys together */
const held = new Map<string, { channel: MotionChannel; sign: number }>()

function moveSpeed(): number {
	return Number($<HTMLInputElement>('#move-speed').value) / 100
}

/** Tell the engine what the window's controls add up to now */
function sendHeld(): void {
	const camera = activeCamera()
	if (!camera || held.size === 0) {
		void api.stopCamera()
		return
	}
	const fraction: Record<MotionChannel, number> = { pan: 0, tilt: 0, zoom: 0, focus: 0 }
	for (const { channel, sign } of held.values()) fraction[channel] = sign * moveSpeed()
	void api.moveCamera(camera.id, fraction)
}

function hold(key: string, channel: MotionChannel, sign: number): void {
	if (held.has(key)) return
	held.set(key, { channel, sign })
	sendHeld()
}

function release(key: string): void {
	if (held.delete(key)) sendHeld()
}

function releaseAll(): void {
	if (held.size === 0) return
	held.clear()
	sendHeld()
}

const ARROW_KEYS: Record<string, [MotionChannel, number]> = {
	ArrowUp: ['tilt', 1],
	ArrowDown: ['tilt', -1],
	ArrowLeft: ['pan', -1],
	ArrowRight: ['pan', 1],
}

function setupMoveControls(): void {
	for (const el of document.querySelectorAll<HTMLElement>('#camera-motion [data-motion]')) {
		const channel = el.dataset.motion as MotionChannel
		const sign = Number(el.dataset.sign)
		const key = `pointer:${channel}:${sign}`
		el.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return
			// Keep hearing about this press even if the pointer slides off the button
			el.setPointerCapture(e.pointerId)
			hold(key, channel, sign)
		})
		for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
			el.addEventListener(type, () => release(key))
	}

	const speed = $<HTMLInputElement>('#move-speed')
	speed.addEventListener('input', () => {
		$('#move-speed-value').textContent = `${speed.value}%`
		if (held.size) sendHeld()
	})

	document.addEventListener('keydown', (e) => {
		const arrow = ARROW_KEYS[e.key]
		if (!arrow || selection?.type !== 'camera' || isTyping(e.target)) return
		e.preventDefault()
		hold(`key:${e.key}`, ...arrow)
	})
	document.addEventListener('keyup', (e) => release(`key:${e.key}`))
	// A release that happens elsewhere never arrives, so stop rather than run on
	window.addEventListener('blur', releaseAll)
	document.addEventListener('visibilitychange', () => document.hidden && releaseAll())
}

/** Arrow keys and number keys belong to a field that has focus */
function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement
	)
}

function setStoreMode(on: boolean): void {
	$<HTMLInputElement>('#store-mode').checked = on
	document.body.classList.toggle('store-mode', on)
}

const form = $<HTMLFormElement>('#camera-form')
const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T

const protocolOf = (kind: string): Protocol => kinds[kind]?.protocol ?? 'visca'
const LIMITS = ['maxPan', 'maxTilt', 'maxZoom', 'maxFocus'] as const

/** The profile picked, while the limits still match it; otherwise the first profile that matches */
function matchingProfile(camera: CameraConfig): string {
	const matches = (p: CameraProfile) =>
		p.protocol === protocolOf(camera.kind) &&
		p.maxPan === camera.maxPan &&
		p.maxTilt === camera.maxTilt &&
		p.maxZoom === camera.maxZoom &&
		p.maxFocus === camera.maxFocus
	const picked = profiles[camera.profile]
	if (picked && matches(picked)) return camera.profile
	return Object.keys(profiles).find((id) => matches(profiles[id]!)) ?? ''
}

function showTransportFields(kind: string): void {
	const serial = kinds[kind]?.serial ?? false
	const maxAddress = kinds[kind]?.maxAddress ?? 1
	for (const el of form.querySelectorAll<HTMLElement>('[data-for="ip"]')) el.hidden = serial
	for (const el of form.querySelectorAll<HTMLElement>('[data-for="serial"]')) el.hidden = !serial
	for (const el of form.querySelectorAll<HTMLElement>('[data-for="address"]')) el.hidden = maxAddress <= 1
	field<HTMLInputElement>('address').max = String(maxAddress)
	for (const el of form.querySelectorAll<HTMLElement>('[data-for="login"]')) el.hidden = !kinds[kind]?.login
	for (const el of form.querySelectorAll<HTMLElement>('[data-for="onvif"]')) el.hidden = protocolOf(kind) !== 'onvif'

	// Speed profiles and ranges belong to the protocol
	const protocol = protocolOf(kind)
	for (const option of field<HTMLSelectElement>('profile').options)
		option.hidden = option.value !== '' && profiles[option.value]?.protocol !== protocol
	for (const key of LIMITS) {
		const [min, max] = limitRanges[protocol][key]
		const input = field<HTMLInputElement>(key)
		input.min = String(min)
		input.max = String(max)
	}
}

function applyProfile(p: CameraProfile): void {
	for (const key of LIMITS) field(key).value = String(p[key])
}

async function fillSerialPorts(selected: string): Promise<void> {
	const select = field<HTMLSelectElement>('serialPath')
	const ports = (await api.listSerialPorts()) as { path: string; label: string }[]
	select.replaceChildren(new Option('Choose a port…', ''))
	for (const p of ports) select.append(new Option(p.label ? `${p.path} (${p.label})` : p.path, p.path))
	if (selected && !ports.some((p) => p.path === selected))
		select.append(new Option(`${selected} (not found)`, selected))
	select.value = selected
}

/** What the form was last filled from, so unrelated saves don't wipe unsaved edits */
let formSource = ''
/** The protocol picked in the form, saved or not */
let formKind = ''

function renderCameraForm(): void {
	const camera = activeCamera()
	if (!camera) return

	const source = JSON.stringify(camera)
	if (source === formSource) return
	formSource = source

	field('name').value = camera.name
	field('kind').value = camera.kind
	formKind = camera.kind
	field('host').value = camera.host
	field('port').value = String(camera.port)
	field('baudRate').value = String(camera.baudRate)
	field('address').value = String(camera.address)
	field('username').value = camera.username
	field('password').value = camera.password
	field('maxPan').value = String(camera.maxPan)
	field('maxTilt').value = String(camera.maxTilt)
	field('maxZoom').value = String(camera.maxZoom)
	field('maxFocus').value = String(camera.maxFocus)
	field('sendInterval').value = String(camera.sendInterval)
	field('profile').value = matchingProfile(camera)
	showTransportFields(camera.kind)
	void fillSerialPorts(camera.serialPath)
}

function setupCameraForm(): void {
	const profileSelect = field<HTMLSelectElement>('profile')
	for (const [id, p] of Object.entries(profiles)) profileSelect.append(new Option(p.label, id))

	profileSelect.addEventListener('change', () => {
		const p = profiles[profileSelect.value]
		if (p) applyProfile(p)
	})

	const kindSelect = field<HTMLSelectElement>('kind')
	kindSelect.addEventListener('change', () => {
		const kind = kindSelect.value
		showTransportFields(kind)
		if (defaultPorts[kind]) field('port').value = String(defaultPorts[kind])
		field('sendInterval').value = String(kinds[kind]?.sendInterval ?? 20)
		// Another protocol's speeds mean something else entirely, so start from its first profile
		if (protocolOf(kind) !== protocolOf(formKind)) {
			const id = Object.keys(profiles).find((id) => profiles[id]!.protocol === protocolOf(kind))
			if (id) {
				profileSelect.value = id
				applyProfile(profiles[id]!)
			}
		}
		formKind = kind
	})

	form.addEventListener('submit', (e) => {
		e.preventDefault()
		const camera = activeCamera()
		if (!camera) return
		const value = (name: string) => field(name).value
		void api.saveCamera({
			...camera,
			name: value('name'),
			kind: value('kind'),
			host: value('host'),
			port: Number(value('port')),
			serialPath: value('serialPath'),
			baudRate: Number(value('baudRate')),
			address: Number(value('address')),
			username: value('username').trim(),
			password: value('password'),
			maxPan: Number(value('maxPan')),
			maxTilt: Number(value('maxTilt')),
			maxZoom: Number(value('maxZoom')),
			maxFocus: Number(value('maxFocus')),
			sendInterval: Number(value('sendInterval')),
			profile: value('profile'),
		})
	})

	$('#remove-camera').addEventListener('click', () => {
		const camera = activeCamera()
		if (camera && confirm(`Remove ${camera.name}?`)) void api.removeCamera(camera.id)
	})
	setupOnvifDiscovery()
}

/** WS-Discovery: list the ONVIF cameras that answer, and fill in the one picked */
function setupOnvifDiscovery(): void {
	const button = $<HTMLButtonElement>('#find-cameras')
	const list = $<HTMLSelectElement>('#found-cameras')
	const status = $('#find-status')
	let found: FoundCamera[] = []

	button.addEventListener('click', async () => {
		button.disabled = true
		list.hidden = true
		status.textContent = 'Looking…'
		try {
			found = (await api.discoverOnvif()) as FoundCamera[]
		} catch {
			found = []
		}
		button.disabled = false
		status.textContent = found.length ? '' : 'No ONVIF cameras answered'
		list.replaceChildren(
			new Option(`${found.length} found: choose one…`, ''),
			...found.map((c, i) => {
				const label = [c.name, c.hardware].filter(Boolean).join(' · ')
				return new Option(`${c.host}${c.port === 80 ? '' : `:${c.port}`}${label ? ` (${label})` : ''}`, String(i))
			}),
		)
		list.hidden = found.length === 0
	})

	list.addEventListener('change', () => {
		const camera = found[Number(list.value)]
		if (!list.value || !camera) return
		field('host').value = camera.host
		field('port').value = String(camera.port)
	})
}

// --- Controller view -------------------------------------------------------------

/** The live view is rebuilt when the controller or its assignments change, and updated in between */
let liveFor = ''

function renderControllerView(): void {
	const c = selectedController()
	if (!c) return
	const live = state.controllers[c.id]

	$('#controller-name').textContent = c.name
	const { tone, label } = controllerTone(c.id)
	setPill($('#controller-status'), tone, label)
	$('#forget-row').hidden = !!live

	const cameraSelect = $<HTMLSelectElement>('#controller-camera')
	cameraSelect.replaceChildren(
		new Option('No camera', ''),
		...settings.cameras.map((cam) => new Option(cam.name, cam.id)),
	)
	cameraSelect.value = c.cameraId ?? ''

	renderLayoutPicker(c)
	renderAxisRows(c)
	renderButtonRows(c)
	liveFor = ''
	renderLive()
}

function axesOf(c: ControllerSettings): { id: string; label: string }[] {
	const live = state.controllers[c.id]
	return live?.info.axes ?? Object.keys(c.axes).map((id) => ({ id, label: id }))
}

function buttonsOf(c: ControllerSettings): { id: string; label: string }[] {
	const live = state.controllers[c.id]
	return live?.info.buttons ?? Object.keys(c.buttons).map((id) => ({ id, label: id }))
}

function renderLayoutPicker(c: ControllerSettings): void {
	const select = $<HTMLSelectElement>('#layout')
	const options = layouts[c.kind] ?? {}
	select.replaceChildren(new Option('Custom', ''), ...Object.entries(options).map(([id, l]) => new Option(l.label, id)))
	const axisIds = Object.keys(c.axes)
	select.value =
		Object.entries(options).find(([, l]) =>
			axisIds.every((axis) => (l.actions[axis] ?? 'none') === c.axes[axis].action),
		)?.[0] ?? ''
}

const percent = (v: number) => `${Math.round(v * 100)}%`

function rangeInput(
	value: number,
	min: number,
	max: number,
	step: number,
	format: (v: number) => string,
	onChange: (v: number) => void,
): HTMLElement {
	const wrap = document.createElement('div')
	wrap.className = 'range'
	const input = document.createElement('input')
	input.type = 'range'
	input.min = String(min)
	input.max = String(max)
	input.step = String(step)
	input.value = String(value)
	const output = document.createElement('output')
	output.textContent = format(value)
	input.addEventListener('input', () => (output.textContent = format(Number(input.value))))
	input.addEventListener('change', () => onChange(Number(input.value)))
	wrap.append(input, output)
	return wrap
}

function renderAxisRows(c: ControllerSettings): void {
	const tbody = $<HTMLTableSectionElement>('#axis-rows')
	tbody.replaceChildren()

	for (const axis of axesOf(c)) {
		const m = c.axes[axis.id]
		if (!m) continue
		const row = tbody.insertRow()
		row.classList.toggle('unassigned', m.action === 'none')
		// Labels may wrap in a narrow window, but "Left stick ↔" shouldn't lose its arrow
		row.insertCell().textContent = axis.label.replace(/ (?=[↔↕]$)/, ' ')

		const select = document.createElement('select')
		for (const [value, text] of ACTIONS) select.append(new Option(text, value))
		select.value = m.action
		select.addEventListener('change', () => void api.assignAxis(c.id, axis.id, select.value))
		row.insertCell().append(select)

		const tune = (tuning: Partial<Omit<AxisMapping, 'action'>>) => void api.tuneAxis(c.id, axis.id, tuning)
		const invert = document.createElement('input')
		invert.type = 'checkbox'
		invert.checked = m.invert
		invert.addEventListener('change', () => tune({ invert: invert.checked }))
		row.insertCell().append(invert)

		row.insertCell().append(rangeInput(m.deadzone, 0, 0.3, 0.01, percent, (v) => tune({ deadzone: v })))
		row.insertCell().append(
			rangeInput(
				m.curve,
				1,
				3,
				0.1,
				(v) => v.toFixed(1),
				(v) => tune({ curve: v }),
			),
		)
		row.insertCell().append(rangeInput(m.maxSpeed, 0.1, 1, 0.05, percent, (v) => tune({ maxSpeed: v })))
	}
}

/** Button actions as select options: value is the JSON of the action */
function buttonActionOptions(): HTMLOptionElement[] {
	const option = (label: string, action: ButtonAction) => new Option(label, JSON.stringify(action))
	const group = (label: string, options: HTMLOptionElement[]) => {
		const g = document.createElement('optgroup')
		g.label = label
		g.append(...options)
		return g as unknown as HTMLOptionElement
	}
	return [
		option('Nothing', { type: 'none' }),
		group('Camera', [
			option('Next camera', { type: 'nextCamera' }),
			option('Previous camera', { type: 'previousCamera' }),
			...settings.cameras.map((cam) => option(`Switch to ${cam.name}`, { type: 'selectCamera', cameraId: cam.id })),
		]),
		group('Presets', [
			...Array.from({ length: BUTTON_PRESETS }, (_, i) =>
				option(`Recall preset ${i + 1}`, { type: 'presetRecall', preset: i }),
			),
			option('Home', { type: 'home' }),
		]),
		group('Focus', [
			option('One-push autofocus', { type: 'onePushFocus' }),
			option('Autofocus on', { type: 'autoFocus', enabled: true }),
			option('Autofocus off (manual)', { type: 'autoFocus', enabled: false }),
		]),
	]
}

function renderButtonRows(c: ControllerSettings): void {
	const buttons = buttonsOf(c)
	$('#button-panel').hidden = buttons.length === 0
	const tbody = $<HTMLTableSectionElement>('#button-rows')
	tbody.replaceChildren()

	for (const button of buttons) {
		const row = tbody.insertRow()
		row.insertCell().textContent = button.label
		const select = document.createElement('select')
		select.append(...buttonActionOptions())
		select.value = JSON.stringify(c.buttons[button.id] ?? { type: 'none' })
		select.addEventListener('change', () => void api.assignButton(c.id, button.id, JSON.parse(select.value)))
		row.insertCell().append(select)
	}
}

/** Pairs of axes shown together as a stick; anything else is a bar */
const STICKS: [string, string, string][] = [
	['leftX', 'leftY', 'Left stick'],
	['rightX', 'rightY', 'Right stick'],
]

function buildLive(c: ControllerSettings, live: ControllerState): void {
	const container = $('#live-inputs')
	container.replaceChildren()
	const axisIds = new Set(live.info.axes.map((a) => a.id))
	const role = (...ids: string[]) =>
		ids
			.map((id) => c.axes[id]?.action ?? 'none')
			.filter((a) => a !== 'none')
			.map((a) => ACTION_LABEL[a])
			.join(' / ') || '—'

	for (const [x, y, label] of STICKS) {
		if (!axisIds.has(x) || !axisIds.has(y)) continue
		axisIds.delete(x)
		axisIds.delete(y)
		const figure = document.createElement('figure')
		figure.className = 'stick'
		figure.innerHTML = `<div class="stick-pad"><span class="dot" data-x="${x}" data-y="${y}"></span></div>`
		const caption = document.createElement('figcaption')
		caption.textContent = label
		const roleEl = document.createElement('span')
		roleEl.className = 'role'
		roleEl.textContent = role(x, y)
		caption.append(roleEl)
		figure.append(caption)
		container.append(figure)
	}

	for (const axis of live.info.axes.filter((a) => axisIds.has(a.id))) {
		const figure = document.createElement('figure')
		figure.className = 'wheel'
		figure.innerHTML = `<div class="wheel-track"><span class="bar" data-axis="${axis.id}"></span></div>`
		const caption = document.createElement('figcaption')
		caption.textContent = axis.label.replace(/\s*\(.*\)$/, '')
		const roleEl = document.createElement('span')
		roleEl.className = 'role'
		roleEl.textContent = role(axis.id)
		caption.append(roleEl)
		figure.append(caption)
		container.append(figure)
	}

	const buttons = $('#live-buttons')
	buttons.replaceChildren(
		...live.info.buttons.map((b) => {
			const chip = document.createElement('span')
			chip.className = 'chip'
			chip.dataset.button = b.id
			chip.textContent = b.label
			return chip
		}),
	)
}

function renderLive(): void {
	const c = selectedController()
	if (!c) return
	const live = state.controllers[c.id]
	$('#controller-view').classList.toggle('offline', !live)
	if (!live) {
		$('#live-inputs').replaceChildren()
		$('#live-buttons').replaceChildren()
		for (const ch of CHANNELS) $(`#speed-${ch}`).textContent = '0'
		return
	}

	const key = JSON.stringify([c.id, c.axes, live.info])
	if (key !== liveFor) {
		liveFor = key
		buildLive(c, live)
	}

	const axes = live.input.axes
	for (const dot of document.querySelectorAll<HTMLElement>('#live-inputs .dot')) {
		// Up is positive on the controller, but down is positive on screen
		dot.style.transform = `translate(${(axes[dot.dataset.x!] ?? 0) * 61}px, ${-(axes[dot.dataset.y!] ?? 0) * 61}px)`
	}
	for (const bar of document.querySelectorAll<HTMLElement>('#live-inputs .bar')) {
		const value = axes[bar.dataset.axis!] ?? 0
		const half = Math.abs(value) * 50
		bar.style.height = `${half}%`
		bar.style.top = value >= 0 ? `${50 - half}%` : '50%'
	}
	for (const chip of document.querySelectorAll<HTMLElement>('#live-buttons .chip')) {
		chip.classList.toggle('on', !!live.input.buttons[chip.dataset.button!])
	}
	for (const channel of CHANNELS) {
		const value = live.motion[channel]
		$(`#speed-${channel}`).textContent = value === 0 ? '0' : `${value > 0 ? '+' : '−'}${Math.abs(value)}`
	}
}

function setupControllerView(): void {
	$<HTMLSelectElement>('#controller-camera').addEventListener('change', (e) => {
		const c = selectedController()
		if (c) void api.setControllerCamera(c.id, (e.target as HTMLSelectElement).value || null)
	})
	$<HTMLSelectElement>('#layout').addEventListener('change', (e) => {
		const c = selectedController()
		const value = (e.target as HTMLSelectElement).value
		if (c && value) void api.applyLayout(c.id, value)
	})
	$('#forget-controller').addEventListener('click', () => {
		const c = selectedController()
		if (c && confirm(`Forget ${c.name} and its assignments?`)) {
			void api.forgetController(c.id)
			selection = settings.activeCameraId ? { type: 'camera', id: settings.activeCameraId } : undefined
		}
	})
}

// --- Settings view ---------------------------------------------------------------

const apiForm = $<HTMLFormElement>('#api-form')
const apiField = (name: string) => apiForm.elements.namedItem(name) as HTMLInputElement
let apiFormSource = ''

function renderSettingsView(): void {
	const source = JSON.stringify(settings.api)
	if (source !== apiFormSource) {
		apiFormSource = source
		apiField('enabled').checked = settings.api.enabled
		apiField('port').value = String(settings.api.port)
		apiField('allowRemote').checked = settings.api.allowRemote
	}
	renderApiStatus()
}

function renderApiStatus(): void {
	const s = apiStatus
	if (!settings.api.enabled) setPill($('#api-status'), '', 'Off')
	else if (s.error) setPill($('#api-status'), 'bad', s.error)
	else if (s.listening) setPill($('#api-status'), 'good', `${s.clients} ${s.clients === 1 ? 'client' : 'clients'}`)
	else setPill($('#api-status'), 'warn', 'Starting…')

	$('#api-detail').textContent = s.listening
		? `Listening on ${s.url}${settings.api.allowRemote ? '' : ' (this computer only)'}`
		: ''
}

function setupSettingsView(): void {
	$('#open-settings').addEventListener('click', () => select({ type: 'settings' }))
	apiForm.addEventListener('submit', (e) => {
		e.preventDefault()
		void api.saveApi({
			enabled: apiField('enabled').checked,
			port: Number(apiField('port').value),
			allowRemote: apiField('allowRemote').checked,
		})
	})
}

// --- Wiring ----------------------------------------------------------------------

function renderAll(): void {
	// Fall back to something sensible if the selection went away
	if (selection?.type === 'controller' && !selectedController()) selection = undefined
	if (selection?.type === 'camera') {
		const { id } = selection
		if (!settings.cameras.some((c) => c.id === id)) selection = undefined
	}
	if (!selection && settings.activeCameraId) selection = { type: 'camera', id: settings.activeCameraId }

	$('#camera-view').hidden = selection?.type !== 'camera'
	$('#controller-view').hidden = selection?.type !== 'controller'
	$('#settings-view').hidden = selection?.type !== 'settings'
	$('#empty-view').hidden = !!selection

	renderSidebar()
	if (selection?.type === 'camera') renderCameraView()
	if (selection?.type === 'controller') renderControllerView()
	if (selection?.type === 'settings') renderSettingsView()
}

function setupActions(): void {
	const addCamera = async () => {
		const next = (await api.addCamera({})) as Settings
		settings = next
		select({ type: 'camera', id: next.activeCameraId! })
	}
	$('#add-camera').addEventListener('click', () => void addCamera())
	$('#empty-add-camera').addEventListener('click', () => void addCamera())
	$<HTMLInputElement>('#store-mode').addEventListener('change', (e) =>
		setStoreMode((e.target as HTMLInputElement).checked),
	)

	for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
		button.addEventListener('click', () => {
			const action = button.dataset.action
			if (action === 'autoFocusOn') void api.cameraAction({ type: 'autoFocus', enabled: true })
			else if (action === 'autoFocusOff') void api.cameraAction({ type: 'autoFocus', enabled: false })
			else void api.cameraAction({ type: action })
		})
	}

	// Number keys select cameras, unless typing into a field
	document.addEventListener('keydown', (e) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
		const n = Number(e.key)
		if (n >= 1 && n <= 9 && settings.cameras[n - 1]) select({ type: 'camera', id: settings.cameras[n - 1].id })
	})
}

async function main(): Promise<void> {
	const init = (await api.init()) as InitData
	settings = init.settings
	state = init.state
	profiles = init.profiles
	limitRanges = init.limitRanges
	defaultPorts = init.defaultPorts
	kinds = init.kinds
	layouts = init.layouts
	apiStatus = init.apiStatus
	$('#version').textContent = `v${init.version}`

	setupCameraForm()
	setupControllerView()
	setupSettingsView()
	setupActions()
	setupMoveControls()
	renderPresets()
	renderAll()
	startGamepadPolling()

	api.on('api-status', (payload) => {
		apiStatus = payload as ApiStatus
		if (selection?.type === 'settings') renderApiStatus()
	})

	api.on('camera-action', (payload) => {
		const { cameraId, action } = payload as { cameraId: string; action: CameraCommand }
		if (selection?.type === 'camera' && selection.id === cameraId) showCameraAction(action)
	})

	api.on('settings', (payload) => {
		settings = payload as Settings
		renderAll()
	})

	let knownControllers = Object.keys(state.controllers).sort().join()
	api.on('state', (payload) => {
		state = payload as EngineState
		// A controller arriving or leaving changes the lists; otherwise just refresh what's live
		const controllers = Object.keys(state.controllers).sort().join()
		if (controllers !== knownControllers) {
			knownControllers = controllers
			renderAll()
			return
		}
		renderDots()
		if (selection?.type === 'camera') {
			const camera = activeCamera()
			if (camera) {
				const { tone, label } = cameraTone(camera.id)
				setPill($('#camera-status'), tone, label)
			}
			renderCameraMotion()
		}
		if (selection?.type === 'controller') {
			const c = selectedController()
			if (c) {
				const { tone, label } = controllerTone(c.id)
				setPill($('#controller-status'), tone, label)
			}
			renderLive()
		}
	})
}

void main()
