import type { AutoFocusState } from './visca/camera.js'

/**
 * How the single AF button shows a camera's autofocus mode. Label and `af` come from the same
 * object, so the text and the styling hook can't drift apart. Anything but on/off is unknown.
 */
export function autoFocusDisplay(state: AutoFocusState): { label: string; af: AutoFocusState } {
	switch (state) {
		case 'on':
			return { label: 'AF on', af: 'on' }
		case 'off':
			return { label: 'AF off', af: 'off' }
		default:
			return { label: 'AF ?', af: 'unknown' }
	}
}
