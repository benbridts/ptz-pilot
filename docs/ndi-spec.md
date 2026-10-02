# NDI® support: spec

Status: draft, not started. Builds on the `CameraLink` layer and `KINDS` table.

NDI® is a registered trademark of Vizrt NDI AB. See [ndi.video](https://ndi.video).

## Goals

1. **Tally** — show when a camera is on program or preview, in the sidebar, the camera view and the controller view, and over the WebSocket API.
2. **Preview** — show a live picture from the camera in the app, so an operator can frame a shot without a separate monitor.
3. **NDI PTZ control** — fly any camera that accepts PTZ over NDI (BirdDog, PTZOptics, Panasonic, Sony, Canon and others), chosen by NDI source name rather than IP address.

Tally and preview work for **every** camera, whatever protocol drives it: a BirdDog flown over VISCA can still show its NDI picture and tally. NDI PTZ control is one more protocol, like Canon or ONVIF.

## Non-goals

- Monitoring-grade video. The preview is for framing: reduced bandwidth, no audio, no guaranteed frame rate, latency not measured against a monitor.
- Setting tally. PTZ Pilot is not a switcher and must never tell a camera it is on air. It only reads tally.
- Sending NDI, recording, audio, multiview.
- Exposure, white balance and other camera settings over NDI (the SDK has them; a later change can add them).
- Windows or Linux (the app is macOS only).

## What NDI gives us

All from the NDI SDK's receive API ([NDI-RECV docs](https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-recv)). A receiver connects to one source by name:

| Need            | SDK                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find sources    | `NDIlib_find_create_v2` (optionally with extra IPs or a discovery server), `NDIlib_find_get_current_sources`                                                                                      |
| Connect         | `NDIlib_recv_create_v3` with `bandwidth` (metadata only, lowest, highest) and `color_format` (`RGBX_RGBA`, `BGRX_BGRA`, `UYVY_*`, `fastest`, `best`)                                              |
| Receive         | `NDIlib_recv_capture_v3(recv, &video, &audio, &metadata, timeout_ms)` returns a video, audio, metadata or **status change** frame; each is freed with its `NDIlib_recv_free_*`                    |
| Tally           | The source echoes its combined tally to every receiver as metadata: `<ndi_tally_echo on_program="true" on_preview="false"/>`. `NDIlib_recv_set_tally` sets _our_ contribution, which we never do. |
| PTZ available   | `NDIlib_recv_ptz_is_supported`, valid after a status change frame                                                                                                                                 |
| Pan / tilt      | `NDIlib_recv_ptz_pan_tilt_speed(recv, pan, tilt)`, each -1..1, 0 stops                                                                                                                            |
| Zoom            | `NDIlib_recv_ptz_zoom_speed(recv, speed)`, -1..1                                                                                                                                                  |
| Focus           | `NDIlib_recv_ptz_focus_speed(recv, speed)` -1..1, `NDIlib_recv_ptz_auto_focus`, `NDIlib_recv_ptz_focus(recv, 0..1)` (absolute, manual)                                                            |
| Presets         | `NDIlib_recv_ptz_store_preset(recv, 0..99)`, `NDIlib_recv_ptz_recall_preset(recv, 0..99, speed 0..1)`                                                                                             |
| Home            | `NDIlib_recv_ptz_pan_tilt(recv, 0, 0)` (absolute centre)                                                                                                                                          |
| Health          | `NDIlib_recv_get_no_connections`                                                                                                                                                                  |
| Camera web page | `NDIlib_recv_get_web_control` (a URL; a nice "Open camera page" link)                                                                                                                             |

Every PTZ call returns a bool: false means it was not sent.

## Architecture

```
Main process                         NDI utility process                    Renderer
────────────                         ───────────────────                    ────────
Engine ─ Camera ─ NdiLink (proxy) ──▶ ndi-host.ts                            Camera view
                                       └ native addon (N-API, C++)           └ <canvas> preview
SettingsStore ── sources/tally ◀──────    └ libndi.dylib (bundled)  ── frames ──▶ (direct MessagePort)
```

### Native addon (`native/ndi/`)

A small C++ addon on **N-API** (`node-addon-api`), so one build per architecture works across Electron versions. It wraps only what the table above needs. No existing binding fits: the only maintained one with PTZ and tally (`ndi-node`) is GPL-3.0, which can't ship in this MIT app.

- **Loads the runtime at run time**, using the SDK's dynamic-load entry (`NDIlib_v6_load`), from the app bundle's `Contents/Frameworks/libndi.dylib`. If it isn't there or won't load, the addon reports "NDI unavailable" and **the rest of the app runs as before**.
- **Finder**: `start(extraIps)`, an event when the source list changes.
- **Receiver**: `open(source, { bandwidth, video })`, `close()`. Each receiver has its own capture thread that never blocks JavaScript; it posts events through a thread-safe function:
  - `status`: connected count, PTZ supported, web control URL
  - `tally`: parsed from `ndi_tally_echo`
  - `frame` (video receivers only): see Preview
- **PTZ calls** pass straight through and return the SDK's bool.
- Audio is never requested; captures pass a null audio frame, so the SDK drops it.

### Utility process (`src/ndi/host.ts`)

The addon runs in an Electron `utilityProcess`, not the main process:

- **Crash isolation.** A fault in native code or the NDI library takes down only this process. VISCA, Canon and the other cameras, the controllers and the API keep running.
- **Frames skip main.** Main hands the renderer a `MessagePort` connected straight to this process, so video never passes through the main process's event loop, where the controller loop runs.

Main talks to it over a second port, with a small typed message protocol (`ndi/protocol.ts`): `findSources`, `openReceiver`, `closeReceiver`, `ptz`, and events back.

**If the process dies**, main restarts it with back-off. NDI-driven cameras show an error until then. **On restart, main first sends a stop to every NDI-driven camera**, because a camera that was mid-move when the process died is still moving: NDI PTZ commands carry no timeout.

### Receivers per camera

A camera with an NDI source gets:

- **One metadata-only receiver**, always while the app runs. It carries tally, PTZ (for NDI-driven cameras) and health, at almost no bandwidth.
- **One video receiver**, only while that camera's preview is on screen. Bandwidth is fixed when a receiver is created. A separate receiver lets the preview come and go without disturbing control.

The SDK lets two receivers share a source. Neither ever sets tally.

## Configuration

`CameraConfig` gains:

- `ndiSource: string` — the NDI source name (`MACHINE (Stream)`), or blank. Every kind may have one, for tally and preview.

A new kind `ndi` (protocol `ndi`) controls the camera through `ndiSource` itself; host and port don't apply. `KINDS` gains `ndi: { protocol: 'ndi', login: false, sendInterval: 20 }`. The form's show/hide logic, which today only knows IP vs serial, grows an `address: 'ip' | 'serial' | 'ndi'` field in `KindInfo`.

App settings gain `ndi: { enabled: boolean, extraIps: string, previewFps: number }`:

- `enabled`: on by default when the runtime loads.
- `extraIps`: comma-separated, for sources on other subnets.
- `previewFps`: a cap, default 30.

An NDI discovery server configured through NDI's own `ndi-config.v1.json` (NDI Access Manager) is picked up by the SDK without anything from us.

## Tally

- **Where it shows:**
  - a dot on each camera in the sidebar
  - a border on the camera view's preview: red for program, green for preview, program winning when both
  - a pill on the controller view for the camera that controller drives
  - the tray menu, beside the camera name
- **API**: `cameras[].tally: { program: boolean, preview: boolean } | null` in the state message, `null` when the camera has no NDI source or no echo has arrived. Companion can then show tally on buttons. docs/api.md documents it.
- **Unknown is not off.** Before the first echo, or after the connection drops, tally is unknown and drawn as such, never as "off air".
- **Later (not in this spec):** a controller rumble or light when its camera goes to program, so an operator knows to stop moving.

## Preview

### Picture path

1. **Video receiver** opened with `bandwidth: lowest` (the source's reduced stream) and `color_format: RGBX_RGBA`, so pixels can go straight into an `ImageData`.
2. **Capture thread**:
   - Keeps only the newest frame, the same rule as the camera pump: no backlog, always the latest.
   - Scales it down in C++ to at most 640 pixels wide (some HX sources ignore `lowest` and send full size).
   - Forces alpha opaque, since RGBX alpha is undefined.
   - Sends at most `previewFps` frames a second.
3. **Frame message** to the renderer over the direct port: `{ width, height, timestamp, pixels: ArrayBuffer }`, transferring the buffer rather than copying it. If the renderer hasn't drawn the last frame yet, the new one replaces it.
4. **Renderer** draws into a `<canvas>` with `putImageData`, upscaled by CSS to the panel width. Switch to a WebGL texture upload only if profiling shows `putImageData` is too slow.

640×360 RGBA at 30 fps is about 27 MB/s across the port. That's fine for one preview; it's the reason for one preview at a time.

### When it runs

- The video receiver opens when a camera's view is shown and its preview is visible. It closes when you switch away, the window hides or minimises (PTZ Pilot lives in the tray), or the preview is collapsed.
- Only one preview runs at a time in this spec. A small preview on the controller view, of the camera that controller drives, is the next step and shares the same receiver when it is the same camera.

### States shown

- **connecting**
- **no video yet**
- **source offline**, with the last frame dimmed and a "last seen" time
- **NDI unavailable** (runtime missing)
- **no NDI source set**, with a link to the source picker

## NDI PTZ control (`NdiLink`)

A `CameraLink` in main that proxies to the utility process:

- **Speeds**: limits like ONVIF's, pan/tilt 1..100 and zoom/focus 0..99 as percent, mapped onto -1..1. Pan/tilt is one call; zoom and focus are their own.
- **`ready`** is always true. Messages to the utility process are cheap and the SDK call doesn't block on the camera, so the pump's latest-value logic is enough.
- **Commands**:
  - presets map 1:1 (0..99; beyond 99 reports an error)
  - recall at speed 1.0
  - home is absolute pan/tilt (0, 0)
  - auto focus is `ptz_auto_focus`
- **Status**: connected when the metadata receiver has a connection and PTZ is supported. Connected without PTZ support reports "This NDI source doesn't offer PTZ control."
- **Ping**: the pump's idle ping asks the host for the receiver's connection count.
- **Safety**: no timeout exists in NDI PTZ, so this relies on the existing refresh and double stop, the stop on close, and the stop after a utility-process restart.

## UI changes

- **Camera form**:
  - **NDI source**: a dropdown of discovered sources, plus free text for one not currently visible, with a refresh button. Shown for every kind. For `ndi` it's the control target, and the IP fields hide.
  - A link to ndi.video beside it (license requirement).
  - "Open camera page" when the source reports a web control URL.
- **Camera view**: a preview panel at the top with the tally border and the states above; collapsible, remembered per viewer.
- **Settings**: an NDI section with enabled, extra IPs and preview frame-rate cap. It shows the NDI runtime version or why it's unavailable, plus the ndi.video link.
- **About panel**: "NDI® is a registered trademark of Vizrt NDI AB" and the ndi.video link.

## Packaging and macOS

- **SDK in CI.** The NDI SDK for Apple is downloaded and installed by the build workflow (`.github/workflows/build.yml`) and locally by a script (`tools/fetch-ndi-sdk.sh`); it is **not committed**. The addon builds against its headers.
- **Runtime in the bundle.** `libndi.dylib` is copied to `Contents/Frameworks/` (electron-builder `extraFiles`) and re-signed with the app's Developer ID. Because it carries our team signature, the hardened runtime loads it without `disable-library-validation`.
- **Addon in the bundle.** The `.node` file goes in `asarUnpack` alongside node-hid and serialport. It's built per architecture in the existing x64 and arm64 DMG builds; the dylib is universal or per-arch to match.
- **Info.plist**: `NSLocalNetworkUsageDescription` and `NSBonjourServices` with `_ndi._tcp`. Current macOS requires the Bonjour entry to browse mDNS, so without it discovery silently finds nothing.
- **Size**: measure the dylib's effect on the DMG in the spike; expect tens of MB.

## Licensing (must be settled before release)

From NDI's [licensing](https://docs.ndi.video/all/developing-with-ndi/sdk/licensing) and [distribution](https://docs.ndi.video/all/developing-with-ndi/sdk/software-distribution) pages and the [license agreement](https://downloads.ndi.tv/SDK/NDI_SDK/NDI%20License%20Agreement.pdf):

- **Attribution**: "NDI®" with the ® on first use in a document, and "NDI® is a registered trademark of Vizrt NDI AB" near it, in the About box, README and docs.
- **ndi.video link**: next to every place NDI is used or picked in the app, on the website and in the docs.
- **Runtime placement**: ship it inside the app, not in a system location, and keep it up to date.
- **App EULA**: the app's EULA must cover the NDI SDK EULA's requirements. Today the app has only the MIT license, so an end-user license section is needed. **Needs a careful read of the agreement.**
- **Codecs**: we are responsible for licensing AAC, H.264 and H.265. Decoding NDI|HX cameras' streams uses H.264/H.265. **Needs a decision**: whether macOS's own VideoToolbox decoding covers it, or whether HX preview stays out of release builds.
- **Product name**: "PTZ Pilot" doesn't use "NDI", so no naming permission is needed.

## Testing

- **TypeScript side, without NDI**: `NdiLink`, tally state, the frame mailbox and the host message protocol run against a fake host, like the fake cameras in the other protocol tests. That covers:
  - speed mapping
  - stop on close and after a restart
  - unknown versus off tally
  - preview opening and closing with visibility
  - "NDI unavailable"
- **Native side, with the SDK** (runs where the SDK is installed, skipped otherwise): a test sender built with the SDK's send API that
  - advertises PTZ
  - records the PTZ commands it receives
  - sets tally so it echoes
  - sends a test pattern

  It checks that discovery finds it, PTZ calls arrive with the right values, tally echoes reach the metadata receiver, and frames arrive at the right size and rate.

- **Manual, on real cameras**: smoothness of proportional control, tally from a real switcher (vMix, TriCaster, ATEM via NDI), HX and full-bandwidth sources, CPU and latency with one preview running.

## Phases

0. **Trial run (go/no-go), in its own worktree:**
   - addon builds for arm64 and x64 inside Electron
   - signed and notarized DMG launches and loads the bundled runtime
   - finds a source and moves a real camera
   - receives a tally echo and draws one preview frame
   - DMG size measured
   - license and codec questions answered

   Stop here if any of these fails.

1. **Foundation**: utility process, addon, dynamic load and "NDI unavailable", discovery, the NDI source field and picker, settings section, attribution.
2. **Tally**: metadata receivers, sidebar, camera and controller view, tray, API and docs.
3. **Preview**: video receiver, frame path, canvas, states, visibility handling, frame-rate cap; profile CPU.
4. **NDI PTZ control**: the `ndi` kind and `NdiLink`, the restart stop, tests.
5. **Polish**: controller-view preview, "Open camera page", README section.

Each phase is a separate branch and can ship on its own. Tally is useful before preview exists, and preview before NDI control.

## Open questions for the trial run

- **Tally echo coverage.** Do cameras with embedded NDI|HX firmware send `ndi_tally_echo`, or only senders built on the full SDK? Without it, tally on those cameras would need a switcher integration instead.
- **`lowest` bandwidth on HX sources.** Does it actually give a smaller stream, or full size, which we then scale down?
- **Manual focus.** How do we switch to manual focus without jumping the lens? `ptz_focus` needs an absolute value we don't know. Maybe `ptz_focus_speed(0)`. And can one-push focus be done well (auto, then hold)?
- **Smoothness.** How smooth is proportional NDI PTZ on each brand, given some cameras translate it to VISCA internally?
- **Recall speed.** Does a recall speed of 1.0 mean "camera default" or "fastest"?
- **Bundled runtime vs installed NDI Tools.** Can the bundled runtime coexist with a user's own NDI Tools installation?
