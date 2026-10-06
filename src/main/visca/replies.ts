/**
 * VISCA replies: `y0 4z FF` ack, `y0 5z FF` completion, `y0 6z ee FF` error, where y is the
 * camera address + 8 and z the socket number.
 */

export type ViscaReply =
	| { kind: 'ack'; address: number; socket: number }
	| { kind: 'completion'; address: number; socket: number; data: Buffer }
	| { kind: 'error'; address: number; socket: number; code: number; message: string }
	| { kind: 'unknown'; raw: Buffer }

const ERROR_MESSAGES: Record<number, string> = {
	0x01: 'Message length error',
	0x02: 'Syntax error',
	0x03: 'Command buffer full',
	0x04: 'Command cancelled',
	0x05: 'No socket',
	0x41: 'Command not executable',
}

export function parseReply(raw: Buffer): ViscaReply {
	if (raw.length < 3 || raw[raw.length - 1] !== 0xff || (raw[0] & 0x8f) !== 0x80) return { kind: 'unknown', raw }

	const address = (raw[0] >> 4) - 8
	const type = raw[1] & 0xf0
	const socket = raw[1] & 0x0f

	switch (type) {
		case 0x40:
			return { kind: 'ack', address, socket }
		case 0x50:
			return { kind: 'completion', address, socket, data: raw.subarray(2, raw.length - 1) }
		case 0x60: {
			const code = raw[2]
			return { kind: 'error', address, socket, code, message: ERROR_MESSAGES[code] ?? `Error 0x${code.toString(16)}` }
		}
		default:
			return { kind: 'unknown', raw }
	}
}

/** The auto focus mode a completion reply carries: `02` auto (on), `03` manual (off), else undefined */
export function decodeAutoFocusReply(reply: ViscaReply): 'on' | 'off' | undefined {
	if (reply.kind !== 'completion' || reply.data.length !== 1) return undefined
	if (reply.data[0] === 0x02) return 'on'
	if (reply.data[0] === 0x03) return 'off'
	return undefined
}

/**
 * Split a byte stream into VISCA messages at each FF terminator. Serial and TCP both deliver
 * replies as a stream, so they can arrive split or merged.
 */
export class ViscaStreamSplitter {
	#buffer = Buffer.alloc(0)

	push(chunk: Buffer): Buffer[] {
		this.#buffer = Buffer.concat([this.#buffer, chunk])
		const messages: Buffer[] = []

		let end: number
		while ((end = this.#buffer.indexOf(0xff)) >= 0) {
			const message = this.#buffer.subarray(0, end + 1)
			this.#buffer = this.#buffer.subarray(end + 1)
			if (message.length > 1) messages.push(Buffer.from(message))
		}

		// A lost terminator would otherwise grow this without bound
		if (this.#buffer.length > 64) this.#buffer = Buffer.alloc(0)

		return messages
	}
}
