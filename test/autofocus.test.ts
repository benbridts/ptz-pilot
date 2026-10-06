import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoFocusDisplay } from '../src/main/autofocus.js'

test('autoFocusDisplay maps each state to a label and a matching af hook', () => {
	assert.deepEqual(autoFocusDisplay('on'), { label: 'AF on', af: 'on' })
	assert.deepEqual(autoFocusDisplay('off'), { label: 'AF off', af: 'off' })
	assert.deepEqual(autoFocusDisplay('unknown'), { label: 'AF ?', af: 'unknown' })
	// Anything unexpected degrades to the unknown pair
	assert.deepEqual(autoFocusDisplay('garbled' as never), { label: 'AF ?', af: 'unknown' })
})
