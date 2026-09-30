import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** The only surface the renderer gets onto the main process */
const api = {
	init: () => ipcRenderer.invoke('init'),

	addCamera: (partial: unknown) => ipcRenderer.invoke('camera:add', partial),
	saveCamera: (camera: unknown) => ipcRenderer.invoke('camera:save', camera),
	removeCamera: (id: string) => ipcRenderer.invoke('camera:remove', id),
	selectCamera: (id: string) => ipcRenderer.invoke('camera:select', id),
	cameraAction: (action: unknown) => ipcRenderer.invoke('camera:action', action),
	listSerialPorts: () => ipcRenderer.invoke('serial:list'),

	setControllerCamera: (id: string, cameraId: string | null) => ipcRenderer.invoke('controller:camera', id, cameraId),
	assignAxis: (id: string, axis: string, action: string) =>
		ipcRenderer.invoke('controller:assignAxis', id, axis, action),
	tuneAxis: (id: string, axis: string, tuning: unknown) => ipcRenderer.invoke('controller:tuneAxis', id, axis, tuning),
	applyLayout: (id: string, layoutId: string) => ipcRenderer.invoke('controller:layout', id, layoutId),
	assignButton: (id: string, button: string, action: unknown) =>
		ipcRenderer.invoke('controller:button', id, button, action),
	forgetController: (id: string) => ipcRenderer.invoke('controller:forget', id),

	/** Fire-and-forget, many times a second */
	sendGamepads: (pads: unknown) => ipcRenderer.send('gamepads', pads),

	on: (channel: 'state' | 'settings', listener: (payload: unknown) => void) => {
		const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
		ipcRenderer.on(channel, wrapped)
		return () => ipcRenderer.off(channel, wrapped)
	},
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
