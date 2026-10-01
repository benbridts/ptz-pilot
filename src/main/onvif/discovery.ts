/**
 * Finding ONVIF cameras on the local network with WS-Discovery: a SOAP Probe multicast to
 * 239.255.255.250:3702, answered by each camera with a ProbeMatch carrying its device service
 * address and some scopes (name, hardware).
 */
import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import { elements, text } from './soap.js'

const MULTICAST_ADDRESS = '239.255.255.250'
const MULTICAST_PORT = 3702
const LISTEN_TIME = 2500

export interface FoundCamera {
	host: string
	port: number
	/** From the camera's scopes, when it gives them */
	name: string
	hardware: string
}

/**
 * Probe types are all-of, so asking for both in one probe would miss cameras that only claim one.
 * NetworkVideoTransmitter is what Profile S cameras announce; some only say Device.
 */
export const PROBE_TYPES = ['dn:NetworkVideoTransmitter', 'tds:Device']

export function probeMessage(type: string, messageId = `uuid:${randomUUID()}`): string {
	return (
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"' +
		' xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
		' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"' +
		' xmlns:dn="http://www.onvif.org/ver10/network/wsdl"' +
		' xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
		'<s:Header>' +
		'<a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>' +
		`<a:MessageID>${messageId}</a:MessageID>` +
		'<a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>' +
		'<a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>' +
		'</s:Header>' +
		`<s:Body><d:Probe><d:Types>${type}</d:Types></d:Probe></s:Body>` +
		'</s:Envelope>'
	)
}

const scope = (scopes: string[], kind: string) => {
	const prefix = `onvif://www.onvif.org/${kind}/`
	const found = scopes.find((s) => s.startsWith(prefix))
	if (!found) return ''
	try {
		return decodeURIComponent(found.slice(prefix.length)).replace(/_/g, ' ')
	} catch {
		return found.slice(prefix.length)
	}
}

/** The cameras in one answer. `from` is the address it came from, preferred when the camera lists several. */
export function parseProbeMatches(xml: string, from?: string): FoundCamera[] {
	const found: FoundCamera[] = []
	for (const match of elements(xml, 'ProbeMatch')) {
		const urls = (text(match.inner, 'XAddrs') ?? '')
			.split(/\s+/)
			.flatMap((x) => {
				try {
					const url = new URL(x)
					return url.protocol === 'http:' ? [url] : []
				} catch {
					return []
				}
			})
			// IPv6 and link-local addresses rarely reach; the one it answered from always does
			.filter((u) => !u.hostname.startsWith('['))
		const url = urls.find((u) => u.hostname === from) ?? urls.find((u) => !u.hostname.startsWith('169.254.')) ?? urls[0]
		if (!url) continue
		const scopes = (text(match.inner, 'Scopes') ?? '').split(/\s+/)
		found.push({
			host: url.hostname,
			port: Number(url.port) || 80,
			name: scope(scopes, 'name'),
			hardware: scope(scopes, 'hardware'),
		})
	}
	return found
}

/** Every IPv4 interface address, so the probe goes out on each network, not just the default one */
function localAddresses(): string[] {
	return Object.values(networkInterfaces())
		.flat()
		.filter((i) => i && i.family === 'IPv4' && !i.internal)
		.map((i) => i!.address)
}

/**
 * Probe, listen for a couple of seconds, and return what answered, once each. `target` is only
 * changed by tests, which answer on loopback rather than multicast.
 */
export async function discover(
	listenTime = LISTEN_TIME,
	target = { address: MULTICAST_ADDRESS, port: MULTICAST_PORT },
): Promise<FoundCamera[]> {
	const found = new Map<string, FoundCamera>()
	const sockets: dgram.Socket[] = []
	const addresses = target.address === MULTICAST_ADDRESS ? localAddresses() : ['127.0.0.1']

	await Promise.all(
		addresses.map(
			(address) =>
				new Promise<void>((resolve) => {
					const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
					sockets.push(socket)
					// One interface failing shouldn't spoil the others
					socket.on('error', () => resolve())
					socket.on('message', (message, rinfo) => {
						for (const camera of parseProbeMatches(message.toString('utf8'), rinfo.address)) {
							const key = `${camera.host}:${camera.port}`
							if (!found.has(key)) found.set(key, camera)
						}
					})
					socket.bind(0, address, () => {
						for (const type of PROBE_TYPES) {
							const probe = Buffer.from(probeMessage(type))
							socket.send(probe, target.port, target.address)
						}
						resolve()
					})
				}),
		),
	)

	await new Promise((resolve) => setTimeout(resolve, listenTime))
	for (const socket of sockets) {
		try {
			socket.close()
		} catch {
			// Already closed after an error
		}
	}
	return [...found.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }))
}
