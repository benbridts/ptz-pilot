# PTZ Pilot

Fly PTZ cameras with a game controller. PTZ Pilot turns a gamepad, or a spare DJI drone remote,
into a proportional pan/tilt/zoom/focus controller for VISCA cameras: the further you push, the
faster the camera moves.

## Controllers

- **Gamepads**: Xbox, PlayStation, Switch Pro, 8BitDo and most others, over USB or Bluetooth.
  Read through Chromium's Gamepad API, so no drivers are needed.
- **Xbox controllers over direct HID**, independent of the app window. Takes priority over the
  Gamepad API for the same controller.
- **DJI drone remotes** (RC-N1, model RC231), over the USB-C port on the bottom. Sticks and
  gimbal wheel only: the remote doesn't report its buttons on that port.

Any number of controllers can be connected at once. Each one drives the camera you assign it,
with its own stick and button assignments, so two operators can each fly a camera. Two
controllers on the same camera share it: whichever pushes harder wins, per movement.

Gamepads appear once you press one of their buttons (a Gamepad API privacy rule).

## Cameras

| Protocol                  | Typical cameras                                    | Default port |
| ------------------------- | -------------------------------------------------- | ------------ |
| Sony VISCA over IP (UDP)  | Sony SRG/BRC/FR7, BirdDog, Lumens, Canon, Marshall | 52381        |
| VISCA over UDP, no header | PTZOptics, AVer, most generic cameras              | 1259         |
| VISCA over TCP            | PTZOptics, many generic cameras                    | 5678         |
| Serial RS-232 / RS-422    | Up to 7 cameras on a daisy chain                   | —            |

Sony cameras reply to port 52381 on the controlling machine, so PTZ Pilot listens there. If
another program already holds that port, cameras still move but the app can't see their replies.

## Safety

- A camera stops within 250 ms of its controller going quiet: unplugged, out of range, asleep.
- Every stop is sent twice, and a held movement is re-sent every 500 ms, so a lost UDP packet
  can't leave a camera turning.
- Quitting stops every camera first.

## Using it

- **Stick assignments**: pick what each axis does (pan, tilt, zoom, focus or nothing), with
  invert, deadzone, response curve and top speed per axis. Or choose a ready-made layout.
- **Buttons**: next/previous camera, switch to a given camera, recall presets 1-16, home, and
  focus modes.
- **Closing the window** leaves PTZ Pilot running in the menu bar, where you can also point each
  controller at a camera.

## Development

```bash
npm install
npm start          # build and run
npm test           # unit and loopback tests
npm run pack       # signed .app in release/, no DMG, not notarized
npm run dist:mac   # signed, notarized DMGs for Apple Silicon and Intel
npm run icons      # re-render assets/*.png from the SVGs
```

Notarization runs when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set.
Pushing a `v*.*.*` tag builds, signs, notarizes and publishes a GitHub release; the workflow
expects `DEVELOPER_ID_CERT`, `DEVELOPER_ID_CERT_PASSWORD`, `APPLE_ID`, `APPLE_ID_PASSWORD` and
`APPLE_TEAM_ID` secrets.

Set `PTZ_PILOT_USER_DATA` to run against a separate settings folder.

## License

MIT
