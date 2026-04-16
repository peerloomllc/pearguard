# PearGuard Windows Child Client

Electron desktop child client for PearGuard. Runs the same P2P backend
(`src/bare.js`) as the mobile app but inside Electron's Node.js main process,
with the existing React UI (`src/ui/`) loaded in the renderer.

## Phase 1 scope (current)

- Electron scaffold with main + renderer
- BareKit shim that lets the unmodified `src/bare.js` run in Node.js
- IPC bridge: renderer `window.callBare` -> main -> bare dispatch
- Existing `assets/app-ui.bundle` loaded directly by the renderer

## Dev setup

First, build the UI bundle from the project root:

```
cd ..
npm run build:ui
```

Then install Electron deps and start:

```
cd windows
npm install
npm start
```

On first run Electron downloads native prebuilds for `sodium-native`,
`hypercore`, `hyperswarm`, etc. If any native module fails to load after an
Electron upgrade, run `npm run rebuild`.

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

- Child UI adaptations for desktop (Phase 2)
- Foreground window monitor + blocking overlay (Phase 3)
- NSIS installer, scheduled task, URL protocol (Phase 4)
- Watchdog, schedule enforcement, bypass detection (Phase 5)
