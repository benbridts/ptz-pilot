/**
 * ONVIF over SOAP 1.2: the requests PTZ Pilot sends and the few answers it reads. Everything here
 * is pure string building and regex reading, so it can be tested without a camera.
 *
 * - Device service (`tds`): the clock, and where the other services live
 * - Media service (`trt`, ver10): the profiles, one of which carries the PTZ configuration
 * - PTZ service (`tptz`, ver20): movement, presets, home
 * - Imaging service (`timg`, ver20): focus
 *
 * Velocities are in the generic space, -1..1 on every axis: positive pan is right, positive tilt is
 * up, positive zoom is tele. Positive focus speed is towards far.
 */
import { createHash, randomBytes } from 'node:crypto'

export const NS = {
	s: 'http://www.w3.org/2003/05/soap-envelope',
	tt: 'http://www.onvif.org/ver10/schema',
	tds: 'http://www.onvif.org/ver10/device/wsdl',
	trt: 'http://www.onvif.org/ver10/media/wsdl',
	tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
	timg: 'http://www.onvif.org/ver20/imaging/wsdl',
}

const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd'
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd'
const PASSWORD_DIGEST =
	'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest'
const BASE64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary'

/** Where the device service lives on nearly every camera; the others are asked for */
export const DEVICE_PATH = '/onvif/device_service'

export type Service = 'device' | 'media' | 'ptz' | 'imaging'

const PREFIX: Record<Service, keyof typeof NS> = { device: 'tds', media: 'trt', ptz: 'tptz', imaging: 'timg' }

export interface OnvifRequest {
	service: Service
	operation: string
	/** The operation element, ready to go in the SOAP body */
	body: string
}

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`)
}

/** An operation element, its children given as [name, text] (escaped here) or ready-made XML */
function op(service: Service, operation: string, ...children: ([string, string] | string)[]): OnvifRequest {
	const p = PREFIX[service]
	const inner = children
		.map((c) => (typeof c === 'string' ? c : `<${p}:${c[0]}>${escapeXml(c[1])}</${p}:${c[0]}>`))
		.join('')
	return {
		service,
		operation,
		body: inner ? `<${p}:${operation}>${inner}</${p}:${operation}>` : `<${p}:${operation}/>`,
	}
}

/** The SOAP action, which some cameras (Pelco, by the onvif npm package's account) insist on */
export function soapAction(request: OnvifRequest): string {
	return `${NS[PREFIX[request.service]]}/${request.operation}`
}

export function envelope(request: OnvifRequest, security = ''): string {
	const xmlns = Object.entries(NS)
		.map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
		.join('')
	return (
		'<?xml version="1.0" encoding="UTF-8"?>' +
		`<s:Envelope${xmlns}>` +
		(security ? `<s:Header>${security}</s:Header>` : '') +
		`<s:Body>${request.body}</s:Body></s:Envelope>`
	)
}

// --- WS-Security -------------------------------------------------------------

/** Base64(SHA1(nonce + created + password)), from the WS-Security UsernameToken profile */
export function passwordDigest(nonce: Buffer, created: string, password: string): string {
	return createHash('sha1')
		.update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
		.digest('base64')
}

/** xsd:dateTime to the second, as the ONVIF examples write it */
export function wsTime(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * The Security header. `created` should be the camera's idea of now, not ours: cameras reject
 * tokens created too far from their own clock.
 */
export function usernameToken(username: string, password: string, created: Date, nonce = randomBytes(16)): string {
	const time = wsTime(created)
	return (
		`<wsse:Security s:mustUnderstand="1" xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}">` +
		'<wsse:UsernameToken>' +
		`<wsse:Username>${escapeXml(username)}</wsse:Username>` +
		`<wsse:Password Type="${PASSWORD_DIGEST}">${passwordDigest(nonce, time, password)}</wsse:Password>` +
		`<wsse:Nonce EncodingType="${BASE64}">${nonce.toString('base64')}</wsse:Nonce>` +
		`<wsu:Created>${time}</wsu:Created>` +
		'</wsse:UsernameToken></wsse:Security>'
	)
}

// --- Requests ----------------------------------------------------------------

/** Answered without a login, so it can be asked before we know the camera's clock */
export const getSystemDateAndTime = () => op('device', 'GetSystemDateAndTime')
export const getServices = () => op('device', 'GetServices', ['IncludeCapability', 'false'])
/** Deprecated, but the only way to find the services on cameras older than ONVIF 2.0 */
export const getCapabilities = () => op('device', 'GetCapabilities', ['Category', 'All'])
export const getProfiles = () => op('media', 'GetProfiles')

export const getPresets = (profile: string) => op('ptz', 'GetPresets', ['ProfileToken', profile])
export const ptzStatus = (profile: string) => op('ptz', 'GetStatus', ['ProfileToken', profile])
export const gotoHome = (profile: string) => op('ptz', 'GotoHomePosition', ['ProfileToken', profile])
export const gotoPreset = (profile: string, token: string) =>
	op('ptz', 'GotoPreset', ['ProfileToken', profile], ['PresetToken', token])

/** Without a token the camera picks one; with one it overwrites (or, on some cameras, creates) that preset */
export function setPreset(profile: string, name: string, token?: string): OnvifRequest {
	const children: [string, string][] = [
		['ProfileToken', profile],
		['PresetName', name],
	]
	if (token !== undefined) children.push(['PresetToken', token])
	return op('ptz', 'SetPreset', ...children)
}

export interface Velocity {
	pan: number
	tilt: number
	zoom: number
}

/** Short decimals, never exponent notation */
const decimal = (value: number) => String(Number(value.toFixed(4)))

/**
 * Pan, tilt and zoom go in one message, so each move restates every axis. `timeout` in ms makes the
 * camera stop by itself if nothing follows, so a crashed app or lost network can't leave it turning.
 */
export function continuousMove(profile: string, v: Velocity, timeout?: number): OnvifRequest {
	const velocity =
		'<tptz:Velocity>' +
		`<tt:PanTilt x="${decimal(v.pan)}" y="${decimal(v.tilt)}"/>` +
		`<tt:Zoom x="${decimal(v.zoom)}"/>` +
		'</tptz:Velocity>'
	const children: ([string, string] | string)[] = [['ProfileToken', profile], velocity]
	if (timeout !== undefined) children.push(['Timeout', `PT${decimal(timeout / 1000)}S`])
	return op('ptz', 'ContinuousMove', ...children)
}

export const ptzStop = (profile: string) =>
	op('ptz', 'Stop', ['ProfileToken', profile], ['PanTilt', 'true'], ['Zoom', 'true'])

export const getMoveOptions = (source: string) => op('imaging', 'GetMoveOptions', ['VideoSourceToken', source])
export const focusMove = (source: string, speed: number) =>
	op(
		'imaging',
		'Move',
		['VideoSourceToken', source],
		`<timg:Focus><tt:Continuous><tt:Speed>${decimal(speed)}</tt:Speed></tt:Continuous></timg:Focus>`,
	)
export const focusStop = (source: string) => op('imaging', 'Stop', ['VideoSourceToken', source])
export const setFocusMode = (source: string, auto: boolean) =>
	op(
		'imaging',
		'SetImagingSettings',
		['VideoSourceToken', source],
		`<timg:ImagingSettings><tt:Focus><tt:AutoFocusMode>${auto ? 'AUTO' : 'MANUAL'}</tt:AutoFocusMode></tt:Focus></timg:ImagingSettings>`,
	)

// --- Speeds ------------------------------------------------------------------

/** Pan and tilt limits are percent of the camera's top speed, so 1..100 onto 0.01..1 */
export const PAN_TILT_STEPS = 100
/** Zoom and focus are 1-based like elsewhere in the app: 1..100 onto 0.01..1 */
export const ZOOM_FOCUS_STEPS = 100

const scaled = (speed: number, max: number, steps: number) =>
	speed === 0 ? 0 : (Math.sign(speed) * Math.min(Math.max(Math.round(Math.abs(speed)), 1), max)) / steps

export const panTiltVelocity = (pan: number, tilt: number, maxPan: number, maxTilt: number) => ({
	pan: scaled(pan, maxPan, PAN_TILT_STEPS),
	tilt: scaled(tilt, maxTilt, PAN_TILT_STEPS),
})
export const zoomVelocity = (speed: number, maxZoom: number) => scaled(speed, maxZoom + 1, ZOOM_FOCUS_STEPS)
/** `range` is the camera's top continuous focus speed, from GetMoveOptions */
export const focusSpeed = (speed: number, maxFocus: number, range = 1) =>
	scaled(speed, maxFocus + 1, ZOOM_FOCUS_STEPS) * range

// --- Reading answers ---------------------------------------------------------

interface Element {
	attrs: string
	inner: string
}

/** Every element with this local name, whatever its prefix. Fine for the flat answers read here. */
export function elements(xml: string, name: string): Element[] {
	const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`, 'g')
	return [...xml.matchAll(re)].map((m) => ({ attrs: m[1] ?? '', inner: m[2] ?? '' }))
}

const unescapeXml = (value: string) =>
	value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')

export function text(xml: string, name: string): string | undefined {
	const el = elements(xml, name)[0]
	return el ? unescapeXml(el.inner.trim()) : undefined
}

export function attr(attrs: string, name: string): string | undefined {
	const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))
	return m ? unescapeXml(m[1] ?? m[2] ?? '') : undefined
}

export interface Fault {
	/** The most specific code given, e.g. `ter:NotAuthorized` */
	code: string
	reason: string
}

export function parseFault(xml: string): Fault | undefined {
	const fault = elements(xml, 'Fault')[0]
	if (!fault) return undefined
	const code = elements(fault.inner, 'Code')[0]
	const values = code ? elements(code.inner, 'Value') : []
	const reason = text(fault.inner, 'Text') ?? text(fault.inner, 'faultstring') ?? ''
	const last = values.at(-1)
	return { code: last ? unescapeXml(last.inner.trim()) : (text(fault.inner, 'faultcode') ?? ''), reason }
}

export function isAuthFault(fault: Fault): boolean {
	return (
		/NotAuthorized|FailedAuthentication|InvalidSecurity/i.test(fault.code) || /not ?authori[sz]ed/i.test(fault.reason)
	)
}

/** The camera's UTC clock, from GetSystemDateAndTime */
export function parseDateTime(xml: string): Date | undefined {
	const utc = elements(xml, 'UTCDateTime')[0]
	if (!utc) return undefined
	const n = (name: string) => Number(text(utc.inner, name))
	const date = new Date(Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second')))
	return Number.isNaN(date.getTime()) ? undefined : date
}

const SERVICE_NAMESPACES: Record<string, Service> = {
	[NS.tds]: 'device',
	[NS.trt]: 'media',
	[NS.tptz]: 'ptz',
	[NS.timg]: 'imaging',
}

export type ServiceAddresses = Partial<Record<Service, string>>

export function parseServices(xml: string): ServiceAddresses {
	const out: ServiceAddresses = {}
	for (const service of elements(xml, 'Service')) {
		const kind = SERVICE_NAMESPACES[text(service.inner, 'Namespace') ?? '']
		const address = text(service.inner, 'XAddr')
		if (kind && address && !out[kind]) out[kind] = address
	}
	return out
}

export function parseCapabilities(xml: string): ServiceAddresses {
	const out: ServiceAddresses = {}
	const names: [Service, string][] = [
		['device', 'Device'],
		['media', 'Media'],
		['ptz', 'PTZ'],
		['imaging', 'Imaging'],
	]
	for (const [kind, name] of names) {
		const el = elements(xml, name)[0]
		const address = el && text(el.inner, 'XAddr')
		if (address) out[kind] = address
	}
	return out
}

export interface Profile {
	token: string
	/** The video source, which imaging (focus) is addressed by */
	videoSource: string | undefined
	ptz: boolean
}

export function parseProfiles(xml: string): Profile[] {
	return elements(xml, 'Profiles').map((p) => {
		const source = elements(p.inner, 'VideoSourceConfiguration')[0]
		return {
			token: attr(p.attrs, 'token') ?? '',
			videoSource: source ? text(source.inner, 'SourceToken') : undefined,
			ptz: elements(p.inner, 'PTZConfiguration').length > 0,
		}
	})
}

export interface Preset {
	token: string
	name: string
}

export function parsePresets(xml: string): Preset[] {
	return elements(xml, 'Preset')
		.map((p) => ({ token: attr(p.attrs, 'token') ?? '', name: text(p.inner, 'Name') ?? '' }))
		.filter((p) => p.token !== '')
}

/**
 * The fastest continuous focus speed, from GetMoveOptions. Undefined when the camera offers no
 * continuous focus at all.
 */
export function parseFocusRange(xml: string): number | undefined {
	const continuous = elements(xml, 'Continuous')[0]
	if (!continuous) return undefined
	const speed = elements(continuous.inner, 'Speed')[0]
	const min = Math.abs(Number(text(speed?.inner ?? '', 'Min')))
	const max = Math.abs(Number(text(speed?.inner ?? '', 'Max')))
	const range = Math.max(Number.isFinite(min) ? min : 0, Number.isFinite(max) ? max : 0)
	return range > 0 ? range : 1
}

/**
 * Preset number `n` (1-based, as shown in the app) is the preset whose token is `n` (Hikvision and
 * most others number their tokens), or failing that one named or tokened like "n" or "Preset n".
 */
export function findPreset(presets: Preset[], n: number): Preset | undefined {
	const like = new RegExp(`^(?:preset[\\s_-]*)?0*${n}$`, 'i')
	return (
		presets.find((p) => p.token === String(n)) ??
		presets.find((p) => like.test(p.token.trim())) ??
		presets.find((p) => like.test(p.name.trim()))
	)
}

/** Keep the path the camera gave, but on the host and port we reach it by: cameras often report an internal address */
export function servicePath(address: string | undefined): string | undefined {
	if (!address) return undefined
	try {
		const url = new URL(address.trim().split(/\s+/)[0]!)
		return url.pathname + url.search
	} catch {
		return address.startsWith('/') ? address : undefined
	}
}
