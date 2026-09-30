/**
 * DJI's DUML framing, as spoken by the remote controller over its USB serial port.
 *
 *   0      1-2               3       4    5    6-7  8         9        10      11..n-3  n-2..n-1
 *   0x55   length | ver<<10  crc8    src  dst  seq  cmd type  cmd set  cmd id  payload  crc16
 *
 * `length` covers the whole frame, including both checksums. The checksums are the usual reflected
 * CRC-8 and CRC-16 algorithms, but seeded with DJI's own initial values.
 */

const SOF = 0x55
const VERSION = 1
const HEADER_LENGTH = 11
const MIN_FRAME_LENGTH = HEADER_LENGTH + 2
const MAX_FRAME_LENGTH = 0x3ff

const CRC8_INIT = 0x77
const CRC16_INIT = 0x3692

export interface DumlFrame {
	src: number
	dst: number
	seq: number
	cmdType: number
	cmdSet: number
	cmdId: number
	payload: Buffer
}

export function crc8(data: Uint8Array, crc = CRC8_INIT): number {
	for (const byte of data) {
		crc ^= byte
		for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0x8c : crc >> 1
	}
	return crc
}

export function crc16(data: Uint8Array, crc = CRC16_INIT): number {
	for (const byte of data) {
		crc ^= byte
		for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1
	}
	return crc
}

export function encodeFrame(frame: DumlFrame): Buffer {
	const length = MIN_FRAME_LENGTH + frame.payload.length
	const buf = Buffer.alloc(length)

	buf[0] = SOF
	buf.writeUInt16LE((length & MAX_FRAME_LENGTH) | (VERSION << 10), 1)
	buf[3] = crc8(buf.subarray(0, 3))
	buf[4] = frame.src
	buf[5] = frame.dst
	buf.writeUInt16LE(frame.seq & 0xffff, 6)
	buf[8] = frame.cmdType
	buf[9] = frame.cmdSet
	buf[10] = frame.cmdId
	frame.payload.copy(buf, HEADER_LENGTH)
	buf.writeUInt16LE(crc16(buf.subarray(0, length - 2)), length - 2)

	return buf
}

/**
 * Reassembles frames from a byte stream. Serial reads split and merge frames arbitrarily, and the
 * controller interleaves its own unsolicited pushes with our replies, so resync on any bad header.
 */
export class DumlParser {
	#buffer: Buffer = Buffer.alloc(0)

	push(chunk: Buffer): DumlFrame[] {
		this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk
		const frames: DumlFrame[] = []

		for (;;) {
			const start = this.#buffer.indexOf(SOF)
			if (start < 0) {
				this.#buffer = Buffer.alloc(0)
				break
			}
			if (start > 0) this.#buffer = this.#buffer.subarray(start)
			if (this.#buffer.length < 4) break

			const length = this.#buffer.readUInt16LE(1) & MAX_FRAME_LENGTH
			if (crc8(this.#buffer.subarray(0, 3)) !== this.#buffer[3] || length < MIN_FRAME_LENGTH) {
				this.#buffer = this.#buffer.subarray(1)
				continue
			}
			if (this.#buffer.length < length) break

			const raw = this.#buffer.subarray(0, length)
			this.#buffer = this.#buffer.subarray(length)

			if (crc16(raw.subarray(0, length - 2)) !== raw.readUInt16LE(length - 2)) continue

			frames.push({
				src: raw[4],
				dst: raw[5],
				seq: raw.readUInt16LE(6),
				cmdType: raw[8],
				cmdSet: raw[9],
				cmdId: raw[10],
				payload: Buffer.from(raw.subarray(HEADER_LENGTH, length - 2)),
			})
		}

		return frames
	}
}
