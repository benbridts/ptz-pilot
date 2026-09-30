// Renders assets/*.svg to the PNGs the app and electron-builder need, using Electron itself.
//   npx electron tools/render-icons.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const assets = path.join(__dirname, '..', 'assets')

/** [svg, output, size] */
const outputs = [
	['icon.svg', 'icon.png', 1024],
	['tray.svg', 'trayTemplate.png', 16],
	['tray.svg', 'trayTemplate@2x.png', 32],
	['tray.svg', 'tray.png', 32],
]

/** Render large and scale down: tiny windows fail to load, and downscaling smooths the edges */
async function render(svgFile, size) {
	const svg = readFileSync(path.join(assets, svgFile), 'utf8')
	const drawn = Math.max(size, 512)
	const win = new BrowserWindow({
		width: drawn,
		height: drawn,
		show: false,
		transparent: true,
		frame: false,
		webPreferences: { offscreen: true },
	})
	const html = `<html><body style="margin:0;background:transparent">
		<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${drawn}" height="${drawn}">
	</body></html>`
	await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
	await new Promise((r) => setTimeout(r, 300))
	const image = await win.webContents.capturePage({ x: 0, y: 0, width: drawn, height: drawn })
	win.destroy()
	// Offscreen capture is at device scale; normalise to the exact size wanted
	return image.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

// Each render opens and closes a window; don't let the first close quit the app
app.on('window-all-closed', () => undefined)

app.whenReady().then(async () => {
	for (const [svg, out, size] of outputs) {
		writeFileSync(path.join(assets, out), await render(svg, size))
		console.log(`assets/${out} (${size}px)`)
	}
	app.quit()
})
