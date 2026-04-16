# PearGuard Windows Child Client

Electron desktop child client for PearGuard. Runs the same P2P backend
(`src/bare.js`) as the mobile app but inside Electron's Node.js main process,
with the existing React UI (`src/ui/`) loaded in the renderer.

## Status

- Phase 1 DONE: Electron scaffold, BareKit shim, IPC bridge, bare dispatch smoke test
- Phase 2 DONE: `src/ui/` app-ui.bundle loads in the renderer and talks to bare
- Phase 3 TODO: enforcement (foreground-window monitor + blocking overlay)
- Phase 4 TODO: NSIS installer, scheduled task, URL protocol
- Phase 5 TODO: watchdog, schedule enforcement, bypass detection

## Dev setup

First, build the UI bundle from the project root:

```
cd ..
npm run build:ui
```

Then install Electron deps:

```
cd windows
npm install
```

On first run Electron downloads native prebuilds for `sodium-native`,
`hypercore`, `hyperswarm`, etc. If any native module fails to load after an
Electron upgrade, run `npm run rebuild`.

### Scripts

- `npm start` - production launch (Windows target)
- `npm run start:dev-linux` - Linux dev launch with sandbox/GPU disabled
  (Fedora Wayland's chrome-sandbox and GPU process don't play nice with Electron)
- `npm run smoke` - headless bare-dispatch smoke test against `smoke.html`
- `npm run smoke:ui` - headless boot check that loads the real `app-ui.bundle`
  and dumps the rendered DOM to stdout

## Architecture

```
┌─────────────────────────────┐
│  Renderer (src/ui/)         │
│  - window.callBare()        │
│  - window.onBareEvent()     │
└──────┬──────────────────────┘
       │ ipcRenderer.invoke('bare-call')
       v
┌─────────────────────────────┐
│  Main process               │
│  - ipcMain.handle           │
│  - BareKit shim (IPC pipe)  │
│  - require('src/bare.js')   │  <-- unmodified mobile bare worklet
└─────────────────────────────┘
```

The BareKit shim provides `global.BareKit.IPC.write` and `.on('data')` as
EventEmitters before `src/bare.js` loads, so the mobile bare worklet runs
unchanged inside Electron's Node.js runtime.

## Not yet implemented (future phases)

- Foreground window monitor + blocking overlay (Phase 3)
- NSIS installer, scheduled task, URL protocol (Phase 4)
- Watchdog, schedule enforcement, bypass detection (Phase 5)
