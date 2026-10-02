// Builds the macOS helpers in native/ into dist/native, for both Intel and Apple silicon. Elsewhere
// there is nothing to build.
const { execFileSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const path = require('node:path')

if (process.platform !== 'darwin') process.exit(0)

const root = path.join(__dirname, '..')
const out = path.join(root, 'dist', 'native')
mkdirSync(out, { recursive: true })
execFileSync(
	'clang',
	[
		...['-arch', 'arm64', '-arch', 'x86_64'],
		'-mmacosx-version-min=10.15',
		'-O2',
		...['-framework', 'IOKit', '-framework', 'CoreFoundation'],
		...['-o', path.join(out, 'input-monitoring')],
		path.join(root, 'native', 'input-monitoring.c'),
	],
	{ stdio: 'inherit' },
)
