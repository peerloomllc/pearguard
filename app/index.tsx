// app/index.tsx
//
// React Native shell. Entry point loaded by Expo Router.
// Responsibilities:
//   1. Load and start the Bare worklet (assets/bare-universal.bundle)
//   2. Load the WebView UI (assets/app-ui.bundle) and render it full-screen
//   3. Route all IPC between WebView ↔ RN ↔ Bare
//   4. Handle deep links (pearguard://) and forward to join.tsx

import { useState, useEffect, useRef, useCallback } from 'react'
import { View, StyleSheet, Platform, DeviceEventEmitter, NativeModules, NativeEventEmitter, PermissionsAndroid, StatusBar, Share, Modal, Text, TouchableOpacity, AppState, BackHandler } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as ImagePicker from 'expo-image-picker'
import * as FileSystem from 'expo-file-system/legacy'
import * as DocumentPicker from 'expo-document-picker'
import * as Sharing from 'expo-sharing'
import { useRouter } from 'expo-router'
import * as Linking from 'expo-linking'
import { setBareCaller } from './setup'
import { CameraView, useCameraPermissions } from 'expo-camera'
import Constants from 'expo-constants'
// Shared with the worklet so parent-facing bypass wording stays truthful:
// some reasons are tampering, others are PearGuard's own limitation.
import { describeBypassReason } from '../src/bypass-reasons'
// Bounded seq-keyed buffer of recent Bare→WebView events, replayed on every
// WebView (re)load so a reloaded context catches up on events it missed.
import { ReplayBuffer } from '../src/webview-replay'

const isAndroid = Platform.OS === 'android'
const { PearGuardNotifications, PearGuardHaptic, PearGuardBGSync, PearGuardLink, PearGuardCamera } = NativeModules

// ── Worklet singleton ─────────────────────────────────────────────────────────
// The worklet must survive re-renders and navigation — keep it in module scope.

let _worklet: any = null
let _workletStarted = false
let _mode: string | null = null
let _dbReady = false
let _nextId = 1
// Startup-handshake watchdog. dbReady only flips after the worklet completes
// bareReady -> init -> ready; none of those steps retries, so a dropped event or
// a silently-failed Worklet.start() leaves the UI blank until the user swipes the
// app away and reopens (observed intermittently on iPhone SE). This timer
// automates that recovery. Held at module scope so it survives re-renders.
let _handshakeTimer: ReturnType<typeof setTimeout> | null = null
let _handshakeRespawns = 0
const HANDSHAKE_TIMEOUT_MS = 8000
const MAX_HANDSHAKE_RESPAWNS = 2
function clearHandshakeWatchdog () {
  if (_handshakeTimer) { clearTimeout(_handshakeTimer); _handshakeTimer = null }
}
const _pending = new Map<number, { cb: (msg: any) => void; timer: ReturnType<typeof setTimeout> }>()
const IPC_TIMEOUT_MS = 30000
// Register a pending IPC call with a timeout so a lost worklet reply — a dropped
// message, or a dead Bare thread — rejects the caller instead of hanging the promise
// (and its spinner) forever.
function addPending (id: number, cb: (msg: any) => void) {
  const timer = setTimeout(() => {
    if (_pending.has(id)) { _pending.delete(id); cb({ error: 'IPC timeout' }) }
  }, IPC_TIMEOUT_MS)
  _pending.set(id, { cb, timer })
}
function settlePending (id: number, msg: any) {
  const entry = _pending.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  _pending.delete(id)
  entry.cb(msg)
}
// Settle every in-flight call with an error at once — used when the worklet
// terminates, so pending promises reject immediately rather than each waiting out
// its own timeout.
function rejectAllPending (reason: string) {
  const entries = [..._pending.values()]
  _pending.clear()
  for (const entry of entries) { clearTimeout(entry.timer); entry.cb({ error: reason }) }
}
const _eventHandlers = new Map<string, ((data: any) => void)[]>()
// Invite URL received before worklet was ready — sent once dispatch is initialized
let _pendingInviteUrl: string | null = null
// { childPublicKey, tab } from pear://pearguard/alerts deep link — injected into WebView after dbReady
let _pendingAlertsNav: { childPublicKey: string; tab?: string } | null = null
// pear://pearguard/child-requests deep link — navigate child app to Requests tab
let _pendingChildRequestsNav = false
// Recent Bare→WebView events, retained in a bounded seq-keyed buffer and replayed
// on every WebView load. Covers two cases: (1) events that fired before the first
// paint — Bare auto-reconnects on startup (reloads persisted topics), so
// peer:paired / child:connected can arrive before the WebView is ready; (2) events
// delivered to a context that was then reloaded (black-screen watchdog, or Android
// killing the render/content process) — the fresh page has no memory of them and
// would otherwise lose them. The seq lets the WebView drop anything it already
// applied, so replaying on every load is idempotent.
let _webViewLoaded = false
const _webViewReplay = new ReplayBuffer()
// Stable inject function updated each render so buffered events reach current WebView ref.
let _injectToWebView: ((js: string) => void) | null = null
// 60s child-mode ticker that pushes fresh app/usage into bare's heartbeat cache.
// bare.js owns the actual 60s heartbeat send (native worklet thread, survives
// Android JS-thread suspension); this just keeps the cache fresh when RN is alive.
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null

// ── Module-level deep link listeners ──────────────────────────────────────────
// These must live outside the component so they are never removed on unmount.
// When a deep link arrives, Expo Router may navigate to join.tsx which unmounts
// index.tsx — any listener registered in useEffect would be torn down. These
// listeners survive for the lifetime of the JS bundle.

// Notification deep links (alerts, child-requests) are now intercepted by
// MainActivity.interceptNotificationDeepLink() and stored in SharedPreferences.
// Only invite join links still arrive via Linking (they use a separate Expo Router route).
// A join link opened while the app is running reaches us twice: once via the OS
// Linking 'url' event, and once via join.tsx re-emitting 'pearguardLink'. Dedup by
// invite token within a short window so acceptInvite runs only once.
let _lastInviteToken: string | null = null
let _lastInviteAt = 0
function handleInviteUrl (url: string) {
  if (!url) return
  const token = (url.match(/[?&]t=([^&]+)/) || [])[1] || url
  const now = Date.now()
  if (token === _lastInviteToken && now - _lastInviteAt < 5000) {
    console.log('[RN] ignoring duplicate invite')
    return
  }
  _lastInviteToken = token
  _lastInviteAt = now
  if (_worklet) sendToWorklet({ method: 'acceptInvite', args: [url] })
  else _pendingInviteUrl = url  // worklet not ready (cold start) — sent from the ready handler
}

Linking.addEventListener('url', ({ url }) => {
  if (url && url.startsWith('pear://pearguard/join')) {
    console.log('[RN] invite URL (module-level Linking):', url)
    handleInviteUrl(url)
  }
})

DeviceEventEmitter.addListener('pearguardLink', (url: string) => {
  console.log('[RN] pearguardLink (module-level):', url)
  handleInviteUrl(url)
})

function onEvent (event: string, fn: (data: any) => void) {
  const handlers = _eventHandlers.get(event) ?? []
  handlers.push(fn)
  _eventHandlers.set(event, handlers)
}

function sendToWorklet (msg: object, pendingId?: number) {
  try {
    _worklet?.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
  } catch (e) {
    console.error('[RN] IPC write error:', e)
    if (pendingId !== undefined) settlePending(pendingId, { error: 'IPC write failed' })
  }
}

async function pushHeartbeatDataOnce () {
  try {
    const [usageList, currentAppPackage, screenTime, appLimits] = await Promise.all([
      NativeModules.UsageStatsModule?.getDailyUsageAllEvents?.(),
      NativeModules.UsageStatsModule?.getLastForegroundPackage?.(),
      // Enforced budget (#179). Distinct from the raw sum below, which counts
      // PearGuard, phone/messaging and screen-time-exempt apps.
      NativeModules.UsageStatsModule?.getScreenTimeStatus?.().catch(() => null),
      NativeModules.UsageStatsModule?.getAppLimitStatus?.().catch(() => null),
    ])
    const usage: { packageName: string; appName: string; secondsToday: number }[] = usageList || []
    const todayScreenTimeSeconds = usage.reduce((sum, a) => sum + (a.secondsToday || 0), 0)
    const foregroundEntry = currentAppPackage ? usage.find((a) => a.packageName === currentAppPackage) : null
    const currentApp = foregroundEntry ? foregroundEntry.appName : null
    sendToWorklet({ method: 'heartbeat:updateData', args: { currentApp, currentAppPackage: currentAppPackage || null, todayScreenTimeSeconds, screenTime: screenTime || null, appLimits: appLimits || null } })
  } catch (e) {
    console.warn('[PearGuard] heartbeat data push failed:', e)
  }
}

function startHeartbeatTimer () {
  if (_heartbeatTimer) return
  pushHeartbeatDataOnce()
  _heartbeatTimer = setInterval(pushHeartbeatDataOnce, 60 * 1000)
}

function stopHeartbeatTimer () {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer)
    _heartbeatTimer = null
  }
}

// ── Notification navigation via SharedPreferences ─────────────────────────────
// MainActivity stores notification deep link URLs in SharedPreferences and strips
// them from the intent so Expo Router never sees them. This function reads and
// clears that stored URL, then injects the appropriate navigation event into the
// WebView (or buffers it for cold start).

function consumePendingNavigation (): Promise<void> {
  const p = NativeModules.UsageStatsModule?.consumePendingNavigation?.()
  if (!p || typeof p.then !== 'function') return Promise.resolve()
  return p
    .then((url: string | null) => {
      if (!url) return
      if (url.includes('/alerts')) {
        const qs = url.split('?')[1] ?? ''
        const keyMatch = qs.match(/childPublicKey=([^&]+)/)
        const tabMatch = qs.match(/tab=([^&]+)/)
        if (keyMatch) {
          const nav = { childPublicKey: decodeURIComponent(keyMatch[1]), tab: tabMatch ? decodeURIComponent(tabMatch[1]) : undefined }
          // Always retain nav in module scope so it survives a WebView/Activity remount
          // that can happen when a deep-link intent reaches an already-alive RN process (#124).
          _pendingAlertsNav = nav
          if (_dbReady && _webViewLoaded) {
            _injectToWebView?.(`window.__pendingAlertsNav=${JSON.stringify(nav)};true;`)
            setTimeout(() => {
              _injectToWebView?.(
                'window.__pearEvent("navigate:child:alerts",' + JSON.stringify(nav) + ');true;'
              )
            }, 300)
          }
        }
      } else if (url.includes('/child-requests')) {
        _pendingChildRequestsNav = true
        if (_dbReady && _webViewLoaded) {
          setTimeout(() => {
            _injectToWebView?.('window.__pearEvent("navigate:child:requests",{});true;')
          }, 100)
        }
      }
    })
    .catch(() => {})
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml (appBundleJs: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover" />',
    '<style>',
    '* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }',
    'input, textarea, [contenteditable="true"] { -webkit-user-select: text; user-select: text; }',
    'button:active, [onclick]:active { opacity: 0.7; transition: opacity 0.05s; }',
    'html, body, #root { height: 100dvh; width: 100%; overflow: hidden; overflow-x: hidden; touch-action: pan-y; overscroll-behavior-x: none; background: #0D0D0D; }',
    '</style>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    '<script>' + appBundleJs + '</script>',
    '</body>',
    '</html>',
  ].join('\n')
}

// ── Scanner modal ──────────────────────────────────────────────────────────────

function ScannerModal ({
  visible,
  onScanned,
  onCancel,
  onPermissionDenied,
}: {
  visible: boolean
  onScanned: (url: string) => void
  onCancel: () => void
  onPermissionDenied: () => void
}) {
  const [permission, requestPermission] = useCameraPermissions()
  const scanned = useRef(false)

  useEffect(() => {
    if (!visible) { scanned.current = false; return }
    if (!permission?.granted) {
      requestPermission().then(result => {
        if (!result.granted) onPermissionDenied()
      })
    }
  }, [visible, permission, requestPermission, onPermissionDenied])

  function handleBarcode (result: any) {
    if (scanned.current) return
    scanned.current = true
    onScanned(result.data)
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {permission?.granted ? (
        <View style={{ flex: 1 }}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            onBarcodeScanned={handleBarcode}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          />
          <View style={scannerStyles.overlay} pointerEvents="box-none">
            <TouchableOpacity style={scannerStyles.cancelBtn} onPress={onCancel}>
              <Text style={scannerStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={scannerStyles.waiting}>
          <Text style={{ color: '#fff' }}>Requesting camera permission…</Text>
        </View>
      )}
    </Modal>
  )
}

const scannerStyles = StyleSheet.create({
  overlay:    { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', padding: 32 },
  cancelBtn:  { backgroundColor: 'rgba(0,0,0,0.65)', padding: 16, borderRadius: 8, alignItems: 'center' },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  waiting:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
})

function showNotification(title: string, body: string, childPublicKey?: string, tab?: string) {
  if (isAndroid) return
  PearGuardNotifications?.postNow?.({ title, body, childPublicKey: childPublicKey ?? '', tab: tab ?? '' }).catch?.(() => {})
}

// ── Root component ────────────────────────────────────────────────────────────

export default function Root () {
  const [html,         setHtml]         = useState<string | null>(null)
  const [dbReady,      setDbReady]      = useState(false)
  const [webViewReady, setWebViewReady] = useState(false)
  const webViewRef = useRef<any>(null)
  const [showScanner, setShowScanner] = useState(false)
  const scanResolve = useRef<((url: string) => void) | null>(null)
  const scanReject  = useRef<((reason: string) => void) | null>(null)
  const backPending = useRef(false)
  const router = useRouter()

  // Keep module-level inject pointer in sync with current WebView ref on every render
  _injectToWebView = (js: string) => webViewRef.current?.injectJavaScript(js)

  // Handle messages from the WebView
  const onWebViewMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data)

      // Android back gesture result from WebView
      if (msg.method === 'back:result') {
        backPending.current = false
        if (!msg.args?.handled) BackHandler.exitApp()
        return
      }

      // Methods handled directly in RN (not forwarded to Bare)
      if (msg.method === 'navigateTo') {
        router.push(msg.args[0])
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + msg.id + ', null);true;'
        )
        return
      }

      if (msg.method === 'haptic:tap') {
        if (isAndroid) {
          NativeModules.UsageStatsModule?.hapticTap?.()
        } else {
          PearGuardHaptic?.impact?.('light')
        }
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + msg.id + ', null);true;'
        )
        return
      }

      // Battery-optimization status for the parent dashboard banner. iOS has no
      // Doze whitelist, so report whitelisted=true and let the banner stay hidden.
      if (msg.method === 'battery:status') {
        if (isAndroid && NativeModules.UsageStatsModule?.checkBatteryOptimization) {
          NativeModules.UsageStatsModule.checkBatteryOptimization()
            .then((s: { whitelisted: boolean; asked: boolean }) => {
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msg.id + ', ' + JSON.stringify(s) + ');true;'
              )
            })
            .catch(() => {
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ whitelisted: true, asked: false }) + ');true;'
              )
            })
        } else {
          webViewRef.current?.injectJavaScript(
            'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ whitelisted: true, asked: false }) + ');true;'
          )
        }
        return
      }

      // Fire the system battery-optimization exemption prompt (Android only).
      if (msg.method === 'battery:request') {
        if (isAndroid && NativeModules.UsageStatsModule?.requestIgnoreBatteryOptimizations) {
          NativeModules.UsageStatsModule?.markBatteryOptAsked?.()
          NativeModules.UsageStatsModule.requestIgnoreBatteryOptimizations()
            .then((granted: boolean) => {
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ granted: !!granted }) + ');true;'
              )
            })
            .catch(() => {
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ granted: false }) + ');true;'
              )
            })
        } else {
          webViewRef.current?.injectJavaScript(
            'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ granted: true }) + ');true;'
          )
        }
        return
      }

      if (msg.method === 'clipboard:copy') {
        const { Clipboard: RNClipboard } = require('react-native')
        RNClipboard.setString(msg.args.text)
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + msg.id + ', { ok: true });true;'
        )
        return
      }

      if (msg.method === 'file:save') {
        (async () => {
          try {
            const { filename, content, mimeType } = msg.args || {}
            if (!filename || typeof content !== 'string') throw new Error('file:save missing filename or content')
            if (isAndroid && NativeModules.PearGuardDownloads?.saveToDownloads) {
              const path = await NativeModules.PearGuardDownloads.saveToDownloads(
                filename, content, mimeType || 'application/json'
              )
              NativeModules.PearGuardDownloads.showToast('Saved to ' + path, true)
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ ok: true, path }) + ');true;'
              )
              return
            }
            // iOS / fallback: write to cache and present share sheet.
            const uri = (FileSystem.cacheDirectory || '') + filename
            await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 })
            const canShare = await Sharing.isAvailableAsync()
            if (!canShare) throw new Error('sharing not available on this device')
            await Sharing.shareAsync(uri, {
              mimeType: mimeType || 'application/json',
              dialogTitle: 'Save ' + filename,
              UTI: 'public.json',
            })
            webViewRef.current?.injectJavaScript(
              'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ ok: true, uri }) + ');true;'
            )
          } catch (e: any) {
            webViewRef.current?.injectJavaScript(
              'window.__pearResponse(' + msg.id + ', null, ' + JSON.stringify(String(e?.message || e)) + ');true;'
            )
          }
        })()
        return
      }

      if (msg.method === 'file:pick') {
        (async () => {
          try {
            const res = await DocumentPicker.getDocumentAsync({
              type: ['application/json', 'text/plain', '*/*'],
              copyToCacheDirectory: true,
              multiple: false,
            })
            if (res.canceled) {
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ canceled: true }) + ');true;'
              )
              return
            }
            const asset = res.assets && res.assets[0]
            if (!asset) throw new Error('no file selected')
            const content = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 })
            webViewRef.current?.injectJavaScript(
              'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ canceled: false, content, name: asset.name }) + ');true;'
            )
          } catch (e: any) {
            webViewRef.current?.injectJavaScript(
              'window.__pearResponse(' + msg.id + ', null, ' + JSON.stringify(String(e?.message || e)) + ');true;'
            )
          }
        })()
        return
      }

      if (msg.method === 'clipboard:read') {
        (async () => {
          try {
            const { Clipboard: RNClipboard } = require('react-native')
            const text = await RNClipboard.getString()
            webViewRef.current?.injectJavaScript(
              'window.__pearResponse(' + msg.id + ', ' + JSON.stringify({ text: text || '' }) + ');true;'
            )
          } catch (e: any) {
            webViewRef.current?.injectJavaScript(
              'window.__pearResponse(' + msg.id + ', null, ' + JSON.stringify(String(e?.message || e)) + ');true;'
            )
          }
        })()
        return
      }

      if (msg.method === 'share:text') {
        Share.share({ message: msg.args.text })
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + msg.id + ', null);true;'
        )
        return
      }

      if (msg.method === 'canOpenURL') {
        Linking.canOpenURL(msg.args.url).then((can: boolean) => {
          webViewRef.current?.injectJavaScript(
            'window.__pearResponse(' + msg.id + ', ' + JSON.stringify(can) + ');true;'
          )
        }).catch(() => {
          webViewRef.current?.injectJavaScript(
            'window.__pearResponse(' + msg.id + ', false);true;'
          )
        })
        return
      }

      if (msg.method === 'openURL') {
        Linking.openURL(msg.args.url).catch(() => {})
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + msg.id + ', null);true;'
        )
        return
      }

      if (msg.method === 'qr:scan') {
        // Reject any in-flight scan before starting a new one
        scanReject.current?.('cancelled')
        const msgId = msg.id
        scanResolve.current = (url: string) => {
          setShowScanner(false)
          webViewRef.current?.injectJavaScript(
            'window.__pearResponse(' + msgId + ', ' + JSON.stringify(url) + ', null);true;'
          )
        }
        scanReject.current = (reason: string) => {
          setShowScanner(false)
          webViewRef.current?.injectJavaScript(
            'window.__pearResponse(' + msgId + ', null, ' + JSON.stringify(reason) + ');true;'
          )
        }
        setShowScanner(true)
        return
      }

      if (msg.method === 'avatar:pickPhoto') {
        const msgId = msg.id
        ;(async () => {
          try {
            if (!PearGuardCamera?.capture) {
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msgId + ', null, "camera unavailable");true;'
              )
              return
            }
            // Native module shows a single picker with both Camera and Gallery options.
            const dataUrl: string = await PearGuardCamera.capture()
            // dataUrl is "data:<mime>;base64,<data>"
            const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
            if (!match) {
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msgId + ', null, "no data");true;'
              )
            } else {
              webViewRef.current?.injectJavaScript(
                'window.__pearResponse(' + msgId + ', ' + JSON.stringify({ base64: match[2], mime: match[1] }) + ', null);true;'
              )
            }
          } catch (err: any) {
            webViewRef.current?.injectJavaScript(
              'window.__pearResponse(' + msgId + ', null, ' + JSON.stringify(err.message || 'picker error') + ');true;'
            )
          }
        })()
        return
      }

      // Forward everything else to Bare
      // bareId routes response back to the right callback; msg.id is preserved for the WebView response
      const bareId = _nextId++
      addPending(bareId, result => {
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + msg.id + ', ' + JSON.stringify(result.result ?? null) + ', ' + JSON.stringify(result.error ?? null) + ');true;'
        )
      })
      sendToWorklet({ ...msg, id: bareId }, bareId)
    } catch (err) { console.error('[RN] WebView msg error:', err) }
  }, [])

  // Start the worklet and load the HTML bundle
  // Android back gesture: ask the WebView if it can handle back navigation.
  // Always consume the gesture (return true) to prevent instant exit, then
  // exitApp() if the WebView reports it didn't handle it.
  useEffect(() => {
    if (!isAndroid) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (backPending.current) return true // already waiting for a response
      if (webViewRef.current) {
        backPending.current = true
        webViewRef.current.injectJavaScript('window.__pearBack?.();true;')
        // Safety timeout: if WebView doesn't respond within 500ms, exit
        setTimeout(() => {
          if (backPending.current) {
            backPending.current = false
            BackHandler.exitApp()
          }
        }, 500)
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [])

  useEffect(() => {
    let buf = ''
    const nativeSubs: ReturnType<typeof DeviceEventEmitter.addListener>[] = []

    async function start () {
      // Resolve the initial deep-link URL first — before loading any bundles —
      // so _pendingAlertsNav / _pendingChildRequestsNav are set before onLoad fires.
      // If called later (after worklet.start()), the ready event may have already
      // fired, the WebView may have already rendered, and onLoad may have already
      // checked these flags (finding them null) before this promise resolves.
      // Check for invite join links via Linking (still uses Expo Router for /join).
      const initialUrl = await Linking.getInitialURL().catch(() => null)
      if (initialUrl && initialUrl.startsWith('pear://pearguard/join')) {
        _pendingInviteUrl = _pendingInviteUrl ?? initialUrl
      }
      // Notification deep links (alerts, child-requests) are stored in
      // SharedPreferences by MainActivity — check on cold start too.
      // Await the read so _pendingAlertsNav / _pendingChildRequestsNav are set
      // before the WebView mounts and its onLoad handler checks them (#124).
      if (isAndroid) {
        await consumePendingNavigation()
      }

      // Request POST_NOTIFICATIONS permission (Android 13+, API 33)
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS').catch(() => {})
      }

      // Ensure data directory exists
      const docDir = FileSystem.documentDirectory!
      const dataUri = docDir + 'pearguard'
      await FileSystem.makeDirectoryAsync(dataUri, { intermediates: true }).catch(() => {})
      const dataDir = dataUri.replace(/^file:\/\//, '')

      // Always load the UI bundle (needed on every mount, including after setup navigates back)
      const jsAsset = Asset.fromModule(require('../assets/app-ui.bundle'))
      await jsAsset.downloadAsync()
      const appBundleJs = await fetch(jsAsset.localUri!).then(r => r.text())
      setHtml(buildHtml(appBundleJs))

      // Helper to call Bare methods and wait for response
      function callBare (method: string, args: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
          const id = _nextId++
          addPending(id, (msg) => {
            if (msg.error) reject(new Error(msg.error))
            else resolve(msg.result)
          })
          sendToWorklet({ method, args, id })
        })
      }
      setBareCaller(callBare)

      // Always register native event listeners — these must survive remounts
      // (e.g. returning from setup screen). If registered only after the early
      // return check below, they would be cleaned up on unmount and never re-added.
      // Cross-platform listeners
      nativeSubs.push(
        AppState.addEventListener('change', (state) => {
          if (state !== 'active') return
          sendToWorklet({ method: 'swarm:reconnect' })
          if (isAndroid) {
            consumePendingNavigation()
            if (_dbReady && _mode === 'child') {
              NativeModules.UsageStatsModule?.checkChildPermissions?.()
                .then((p: { accessibility: boolean; usageStats: boolean; batteryOptimization: boolean; batteryOptAsked: boolean }) => {
                  if (!p.accessibility) router.replace('/child-setup?step=1&source=bypass_recovery')
                  else if (!p.usageStats) router.replace('/child-setup?step=2')
                  else if (!p.batteryOptimization && !p.batteryOptAsked) router.replace('/child-setup?step=3')
                })
                .catch((e: unknown) => console.warn('[index] checkChildPermissions error:', e))
            }
          } else {
            // iOS: check for pending background sync
            PearGuardBGSync?.checkPendingBGSync?.().then((pending: boolean) => {
              if (pending) sendToWorklet({ method: 'swarm:reconnect' })
            }).catch?.(() => {})
            // iOS: check for pending notification navigation
            PearGuardLink?.getPendingNav?.().then((nav: { childPublicKey: string; tab: string } | null) => {
              if (nav && _webViewLoaded) {
                _injectToWebView?.(`window.__pendingAlertsNav=${JSON.stringify(nav)};true;`)
                setTimeout(() => {
                  _injectToWebView?.(
                    'window.__pearEvent("navigate:child:alerts",' + JSON.stringify(nav) + ');true;'
                  )
                }, 300)
              }
            }).catch?.(() => {})
          }
        }),
      )

      // Android-only native event listeners
      if (isAndroid) {
        nativeSubs.push(
          // New app installed — forward to bare worklet as app:installed
          DeviceEventEmitter.addListener('onAppInstalled', (e: { packageName: string; appName?: string; iconBase64?: string; category?: string }) => {
            sendToWorklet({ method: 'app:installed', args: { packageName: e.packageName, appName: e.appName, iconBase64: e.iconBase64, category: e.category } })
          }),

          // App uninstalled — forward to bare worklet so parent's Apps list stays current
          DeviceEventEmitter.addListener('onAppUninstalled', (e: { packageName: string }) => {
            sendToWorklet({ method: 'app:uninstalled', args: { packageName: e.packageName } })
          }),

          // Accessibility Service or Device Admin disabled — forward as bypass:detected
          DeviceEventEmitter.addListener('onBypassDetected', (e: { reason: string } | string) => {
            const reason = typeof e === 'string' ? e : e.reason
            sendToWorklet({ method: 'bypass:detected', args: { reason } })
          }),

          // Child tapped "Send Request" on block overlay — forward as time:request.
          // Pass all fields through so requestType ('approval' | 'extra_time') and
          // extraSeconds (for extra-time requests) reach the worklet.
          DeviceEventEmitter.addListener('onTimeRequest', (e: { packageName: string; appName: string; requestType?: string; extraSeconds?: number }) => {
            sendToWorklet({ method: 'time:request', args: { ...e } })
          }),

          // UsageFlushWorker fired with queued time requests (kid tapped a
          // duration on the block overlay while the RN bridge was detached).
          // Drain the on-disk queue and replay each entry as a time:request.
          DeviceEventEmitter.addListener('onTimeRequestDrain', async () => {
            try {
              const json = await NativeModules.UsageStatsModule.getQueuedTimeRequests()
              const entries = JSON.parse(json) as Array<{ packageName: string; appName?: string; requestType?: string; extraSeconds?: number }>
              if (!Array.isArray(entries) || entries.length === 0) return
              for (const e of entries) {
                if (!e || !e.packageName) continue
                sendToWorklet({ method: 'time:request', args: {
                  packageName: e.packageName,
                  appName: e.appName,
                  requestType: e.requestType,
                  extraSeconds: e.extraSeconds,
                } })
              }
              await NativeModules.UsageStatsModule.clearQueuedTimeRequests()
            } catch (err) {
              console.warn('[PearGuard] Time-request drain failed:', err)
            }
          }),

          // PIN entered successfully — log the override event
          DeviceEventEmitter.addListener('onPinSuccess', (e: { packageName: string; timestamp: number; durationSeconds: number }) => {
            sendToWorklet({ method: 'pin:used', args: e })
          }),

          // Child hit a PIN lockout from repeated wrong guesses — relay to parent
          DeviceEventEmitter.addListener('onPinFailure', (e: { packageName: string; timestamp: number; failCount: number; lockoutMs: number }) => {
            sendToWorklet({ method: 'pin:failed', args: e })
          }),

          // Notification tapped while app is in foreground — onNewIntent fires but
          // AppState doesn't change, so we need this dedicated listener.
          DeviceEventEmitter.addListener('pearguard_pendingNav', () => {
            consumePendingNavigation()
          }),

          // App was blocked by Accessibility Service — tell WebView so ChildRequests can enable button
          DeviceEventEmitter.addListener('onBlockOccurred', (e: { packageName: string }) => {
            webViewRef.current?.injectJavaScript(
              'window.__pearEvent("block:occurred",' + JSON.stringify({ packageName: e.packageName }) + ');true;'
            )
          }),

          // Usage flush timer fired — gather usage and send report
          DeviceEventEmitter.addListener('onUsageFlush', async (_e: { timestamp: number }) => {
            try {
              const [usageList, weeklyList, foregroundPkg, sessionsList, dailyTotals] = await Promise.all([
                NativeModules.UsageStatsModule.getDailyUsageAllEvents(),
                NativeModules.UsageStatsModule.getWeeklyUsageAll(),
                NativeModules.UsageStatsModule.getLastForegroundPackage(),
                NativeModules.UsageStatsModule.getSessionsSinceLastFlush(),
                NativeModules.UsageStatsModule.getDailyAggregatesRange?.(30) ?? Promise.resolve([]),
              ])
              sendToWorklet({ method: 'usage:flush', args: { usage: usageList, weekly: weeklyList, foregroundPackage: foregroundPkg, sessions: sessionsList, dailyTotals } })
            } catch (err) {
              console.warn('[PearGuard] Usage flush failed:', err)
            }
          }),

          // ParentConnectionService heartbeat — trigger swarm:reconnect to restore
          // any connections that dropped while the app was backgrounded
          DeviceEventEmitter.addListener('onParentReconnectNeeded', () => {
            sendToWorklet({ method: 'swarm:reconnect' })
          }),

          // EnforcementService: child-side reconnect (30s loop + network-change callback)
          DeviceEventEmitter.addListener('onChildReconnectNeeded', () => {
            sendToWorklet({ method: 'swarm:reconnect' })
          }),
        )
      }

      // iOS: listen for notification taps via NativeEventEmitter (fires even when
      // app is already in foreground, unlike AppState which only fires on bg->fg)
      if (!isAndroid && PearGuardLink) {
        const linkEmitter = new NativeEventEmitter(PearGuardLink)
        const sub = linkEmitter.addListener('notificationTapped', (nav: { childPublicKey: string; tab: string }) => {
          if (!nav?.childPublicKey) return
          if (_webViewLoaded) {
            _injectToWebView?.(`window.__pendingAlertsNav=${JSON.stringify(nav)};true;`)
            setTimeout(() => {
              _injectToWebView?.(
                'window.__pearEvent("navigate:child:alerts",' + JSON.stringify(nav) + ');true;'
              )
            }, 200)
          } else {
            _pendingAlertsNav = nav
          }
        })
        nativeSubs.push(sub)
      }

      // If worklet already running (e.g. returning from setup screen or after deep-link
      // navigation), mark DB ready immediately and send init (bare will re-emit 'ready'
      // but the event handlers from the old mount are stale — set dbReady directly here).
      if (_workletStarted && _worklet) {
        setDbReady(true)
        sendToWorklet({ method: 'init', dataDir, debug: __DEV__ })
        return
      }

      // Load and start the Bare worklet
      const bareModule = isAndroid
        ? require('../assets/bare-universal.bundle')
        : (Constants.isDevice
            ? require('../assets/bare-ios.bundle')
            : require('../assets/bare-ios-sim.bundle'))
      const bundleAsset = Asset.fromModule(bareModule)
      await bundleAsset.downloadAsync()
      const source = await fetch(bundleAsset.localUri!).then(r => r.text())
      // Handler for messages from Bare. Defined once and re-attached on every
      // (re)spawn of the worklet.
      const onWorkletData = (chunk: Uint8Array) => {
        buf += b4a.toString(chunk)
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'event') {
              // Handle apps:syncRequested locally — do NOT forward to WebView
              if (msg.event === 'apps:syncRequested') {
                // `apps` (launcher set) drives adds; `installedAll` (every installed
                // package) lets bare prune policy entries for apps uninstalled while the
                // bridge was down. The real-time PackageMonitor receiver never fires on
                // Android 8+ (manifest receivers are banned from PACKAGE_ADDED/REMOVED),
                // so this full-scan reconciliation on each sync is the reliable path.
                Promise.all([
                  NativeModules.UsageStatsModule?.getInstalledPackages?.(),
                  NativeModules.UsageStatsModule?.getAllInstalledPackageNames?.(),
                ])
                  .then(([apps, installedAll]: [{ packageName: string; appName: string }[], string[]]) => {
                    // Send all apps in one batch to avoid race-condition on parent side
                    // (individual messages all read same policy DB key concurrently, last-writer-wins)
                    sendToWorklet({ method: 'apps:sync', args: { apps, installedAll } })
                  })
                  .catch((e: any) => console.warn('[RN] getInstalledPackages failed:', e))
                return
              }
              // Handle usageFlushRequested locally — gather usage stats and flush immediately
              if (msg.event === 'usageFlushRequested') {
                Promise.all([
                  NativeModules.UsageStatsModule?.getDailyUsageAllEvents?.(),
                  NativeModules.UsageStatsModule?.getWeeklyUsageAll?.(),
                  NativeModules.UsageStatsModule?.getLastForegroundPackage?.(),
                  NativeModules.UsageStatsModule?.getSessionsSinceLastFlush?.(),
                  NativeModules.UsageStatsModule?.getDailyAggregatesRange?.(30) ?? Promise.resolve([]),
                ])
                  .then(([usageList, weeklyList, foregroundPkg, sessionsList, dailyTotals]: [{ packageName: string; appName: string; secondsToday: number }[], { packageName: string; appName: string; secondsThisWeek: number }[], string | null, any[], { date: string; apps: { packageName: string; displayName: string; secondsToday: number }[] }[]]) => {
                    sendToWorklet({ method: 'usage:flush', args: { usage: usageList, weekly: weeklyList, foregroundPackage: foregroundPkg, sessions: sessionsList, dailyTotals } })
                  })
                  .catch((e: any) => console.warn('[RN] usageFlushRequested getDailyUsageAll failed:', e))
                return
              }
              // Track child heartbeat timestamps so ParentConnectionService can detect force-stop
              if (msg.event === 'heartbeat:received') {
                const { childPublicKey, childDisplayName } = msg.data ?? {}
                if (childPublicKey) {
                  // Always use parent's clock — child's timestamp may have clock skew
                  // which would make the heartbeat appear stale to ParentConnectionService.
                  NativeModules.UsageStatsModule?.updateChildHeartbeat?.(
                    childPublicKey,
                    childDisplayName || 'Child',
                    Date.now()
                  )
                }
              }
              // Parent unpaired a child — clear heartbeat tracking so stale
              // "device has not checked in" notifications don't keep firing (#146).
              if (msg.event === 'child:unpaired') {
                const { childPublicKey } = msg.data ?? {}
                if (childPublicKey && isAndroid) {
                  NativeModules.UsageStatsModule?.clearChildHeartbeat?.(childPublicKey)
                }
              }
              // Show a notification on the parent device when a child sends a time request
              if (msg.event === 'time:request:received') {
                const { id: requestId, childDisplayName, appName, packageName, childPublicKey } = msg.data ?? {}
                const childLabel = childDisplayName || 'Your child'
                const appLabel = appName || packageName || 'an app'
                if (isAndroid) {
                  NativeModules.UsageStatsModule?.showTimeRequestNotification?.(childLabel, appLabel, childPublicKey || '')
                } else {
                  showNotification(childLabel + ' wants more time', appLabel, childPublicKey, 'activity')
                }
                // Mark notified so reconnect backfill doesn't re-fire this notification
                if (requestId) sendToWorklet({ method: 'request:markNotified', args: { requestId } })
              }
              // Show a notification on the child device when parent approves/denies a request.
              // Guard on _mode === 'child': the parent also emits request:updated (e.g. from
              // time:grant) and must not show the child-targeted notification on itself (#67).
              if (msg.event === 'request:updated' && _mode === 'child') {
                const { appName, packageName, status } = msg.data ?? {}
                if (status === 'approved' || status === 'denied') {
                  const label = appName || packageName || 'an app'
                  NativeModules.UsageStatsModule?.showDecisionNotification?.(label, status)
                }
              }
              // Tell the parent enforcement is off on a child's device. The text is
              // derived from the reason: some reasons are real tampering, but others
              // (e.g. an unsupported Wayland compositor) are PearGuard's own
              // limitation, and blaming the child for those would be a false
              // accusation. See src/bypass-reasons.js.
              if (msg.event === 'alert:bypass') {
                const { childPublicKey, childDisplayName, reason } = msg.data ?? {}
                const childName = childDisplayName || 'Your child'
                const { title, body } = describeBypassReason(reason, childName)
                if (isAndroid) {
                  NativeModules.UsageStatsModule?.showBypassAlertNotification?.(title, body, childPublicKey || '')
                } else {
                  showNotification(title, body, childPublicKey, 'activity')
                }
              }
              // Show a notification on the parent device when a child uses the PIN override
              if (msg.event === 'alert:pin_override') {
                const { childPublicKey, childDisplayName, appDisplayName } = msg.data ?? {}
                const childName = childDisplayName || 'Your child'
                const appLabel = appDisplayName || 'an app'
                if (isAndroid) {
                  NativeModules.UsageStatsModule?.showPinOverrideNotification?.(childName, appLabel, childPublicKey || '')
                } else {
                  showNotification('PIN Override', childName + ' used PIN to open ' + appLabel, childPublicKey, 'activity')
                }
              }
              // Notify the parent when a child hits a PIN lockout from repeated wrong guesses
              if (msg.event === 'alert:pin_failure') {
                const { childPublicKey, childDisplayName, appDisplayName, failCount, lockoutMs } = msg.data ?? {}
                const childName = childDisplayName || 'Your child'
                const attempts = failCount ? failCount + ' wrong attempts' : 'Repeated wrong attempts'
                const onApp = appDisplayName ? ' on ' + appDisplayName : ''
                const lockMin = lockoutMs ? Math.max(1, Math.round(lockoutMs / 60000)) : 0
                const lockedFor = lockMin ? ' Locked ' + lockMin + ' min.' : ''
                const detail = attempts + onApp + '.' + lockedFor
                if (isAndroid) {
                  NativeModules.UsageStatsModule?.showPinFailureNotification?.(childName, detail, childPublicKey || '')
                } else {
                  showNotification(childName + ' is guessing the PIN', detail, childPublicKey, 'activity')
                }
              }
              // Notify about app installs — behaviour differs by mode:
              // Parent: show "X installed a new app" notification (childDisplayName present = came via P2P)
              // Child: show "You installed a new app" notification (no childDisplayName = local event)
              if (msg.event === 'app:installed') {
                const { childPublicKey, childDisplayName, appName, packageName } = msg.data ?? {}
                const appLabel = appName || packageName || 'an app'
                if (childDisplayName) {
                  // Parent device — message arrived from child over P2P
                  if (isAndroid) {
                    NativeModules.UsageStatsModule?.showAppInstalledNotification?.(childDisplayName, appLabel, childPublicKey || '')
                  } else {
                    // Route the tap to Activity, where the Approve/Deny card for this
                    // install now is. Without the tab the parent lands on the dashboard
                    // and has to go looking for the decision we just told them to make.
                    showNotification(
                      'New App Installed',
                      childDisplayName + ' installed ' + appLabel + ' — approve or deny?',
                      childPublicKey,
                      'activity',
                    )
                  }
                } else if (_mode === 'child' && isAndroid) {
                  // Child device — local install event, notify the child themselves
                  NativeModules.UsageStatsModule?.showAppInstalledNotification?.('You', appLabel, '')
                }
              }
              // Notify about app uninstalls — same mode-split pattern
              if (msg.event === 'app:uninstalled') {
                const { childPublicKey, childDisplayName, appName, packageName } = msg.data ?? {}
                const appLabel = appName || packageName || 'an app'
                if (childDisplayName) {
                  // Parent device — message arrived from child over P2P
                  if (isAndroid) {
                    NativeModules.UsageStatsModule?.showAppUninstalledNotification?.(childDisplayName, appLabel, childPublicKey || '')
                  } else {
                    showNotification('App Removed', childDisplayName + ' uninstalled ' + appLabel, childPublicKey)
                  }
                } else if (_mode === 'child' && isAndroid) {
                  // Child device — local uninstall event
                  NativeModules.UsageStatsModule?.showAppUninstalledNotification?.('You', appLabel, '')
                }
              }
              // Child was remotely unpaired by parent — wipe local state and return to setup.
              // Clear the native policy first so AppBlockerModule stops blocking and any
              // active overlay is dismissed before navigating away.
              if (msg.event === 'child:reset') {
                NativeModules.UsageStatsModule?.clearChildState?.()
                NativeModules.UsageStatsModule?.dismissAllOverlays?.()
                router.replace('/setup')
                return
              }

              // Forward all other Bare events to WebView. Every event is recorded in a
              // bounded seq-keyed replay buffer (retained across WebView reloads, which
              // reset the page but not this RN JS context) so a freshly (re)loaded WebView
              // catches up on anything it missed. Inject live only once the WebView is up;
              // pre-load events ride out via the same buffer, replayed in onLoad below.
              const rec = _webViewReplay.record(msg.event, msg.data)
              if (_webViewLoaded) {
                _injectToWebView?.('window.__pearEvent(' + JSON.stringify(rec.event) + ',' + JSON.stringify(rec.data) + ',' + rec.seq + ');true;')
              }
              // iOS: complete background sync task on successful P2P activity
              if (!isAndroid && (msg.event === 'peer:connected' || msg.event === 'child:connected' || msg.event === 'usage:received' || msg.event === 'policy:synced')) {
                PearGuardBGSync?.completeBGSync?.(true)
              }
              ;(_eventHandlers.get(msg.event) ?? []).forEach(fn => fn(msg.data))
            } else if (msg.method === 'native:setPolicy') {
              // Write policy to SharedPreferences so native enforcement modules can read it
              NativeModules.UsageStatsModule?.setPolicy(msg.args.json)
              // Auto-dismiss overlay if the currently-blocked app is now allowed in the new policy.
              // Parse the JSON policy to find which packages are now allowed/overridden.
              try {
                const policy = JSON.parse(msg.args.json)
                const apps: Record<string, { status: string }> = policy?.apps ?? {}
                for (const [pkg, appData] of Object.entries(apps)) {
                  if (appData.status === 'allowed') {
                    NativeModules.UsageStatsModule?.dismissOverlayForPackage?.(pkg)
                  }
                }
              } catch (_) {}
            } else if (msg.method === 'native:grantOverride') {
              // Write P2P-granted override expiry to SharedPreferences so AppBlockerModule can read it
              NativeModules.UsageStatsModule?.grantOverride(
                msg.args.packageName,
                msg.args.expiresAt
              )
              // Auto-dismiss the overlay for this package — the parent just granted access
              NativeModules.UsageStatsModule?.dismissOverlayForPackage?.(msg.args.packageName)
            } else if (msg.method === 'native:setScreenTimeBonus') {
              // Parent granted extra general screen time — raise today's budget.
              // Stored separately from the policy, which the parent overwrites wholesale.
              NativeModules.UsageStatsModule?.setScreenTimeBonus?.(
                msg.args.date,
                msg.args.seconds
              )
              // Refresh the cached budget now rather than waiting for the next
              // heartbeat tick, so the child sees the new time left immediately.
              pushHeartbeatDataOnce()
            } else if (msg.method === 'native:showDecisionNotification') {
              // Parent denied an extra-time request — show a notification to the child
              NativeModules.UsageStatsModule?.showDecisionNotification?.(
                msg.args.appName,
                msg.args.decision
              )
            } else if (msg.type === 'response') {
              settlePending(msg.id, msg)
            }
          } catch (e) { console.error('[RN] IPC parse error:', e) }
        }
      }

      // When bare.js loads, it emits 'bareReady' — then we call init
      onEvent('bareReady', () => sendToWorklet({ method: 'init', dataDir, debug: __DEV__ }))

      // When init completes, bare emits 'ready' — dispatch is now initialized.
      // Handshake done: cancel the watchdog and reset its respawn budget so a
      // future terminate/respawn cycle gets a fresh set of attempts.
      onEvent('ready', (data) => {
        clearHandshakeWatchdog()
        _handshakeRespawns = 0
        _mode = data.mode
        _dbReady = true
        setDbReady(true)
        // Flush any invite URL that arrived before the worklet was ready
        if (_pendingInviteUrl) {
          sendToWorklet({ method: 'acceptInvite', args: [_pendingInviteUrl] })
          _pendingInviteUrl = null
        }
        if (!data.mode) {
          const ssScene = ((NativeModules as any).PearGuardScreenshot?.scene ?? 0)
          if (ssScene <= 0) {
            setTimeout(() => router.replace('/setup'), 500)
          }
        }
        // Start the parent background service so Hyperswarm stays connected
        // while the app is backgrounded (keeps process alive, prevents TCP drop)
        if (data.mode === 'parent') {
          if (isAndroid) {
            NativeModules.UsageStatsModule?.startParentService?.()
            // Prune heartbeat entries for children that are no longer paired (#146).
            NativeModules.UsageStatsModule?.pruneStaleHeartbeats?.(
              Array.isArray(data.pairedKeys) ? data.pairedKeys : []
            )
          } else {
            // Background sync scheduling happens in AppDelegate on launch.
            // Check if a pending background task woke us - if so, trigger reconnect.
            PearGuardBGSync?.checkPendingBGSync?.().then((pending: boolean) => {
              if (pending) sendToWorklet({ method: 'swarm:reconnect' })
            }).catch?.(() => {})
          }
        }

        // Push fresh currentApp and screen-time into bare's heartbeat cache
        // every 60s while RN's JS thread is alive. bare.js owns the actual
        // heartbeat send on its native-thread setInterval; this just keeps
        // the cache fresh whenever RN is awake. Gated on Android + child mode.
        if (data.mode === 'child' && isAndroid) {
          startHeartbeatTimer()
        } else {
          stopHeartbeatTimer()
        }


        // Force-stop and background-bypass detection (child only).
        if (data.mode === 'child') {
          NativeModules.UsageStatsModule?.checkChildPermissions?.()
            .then((p: { accessibility: boolean; usageStats: boolean; enforcementHeartbeatMs: number; bypassDetectedReason: string; bypassDetectedAt: number }) => {
              const now = Date.now()

              // Force-stop detection: heartbeat is recent but accessibility is now off.
              const heartbeatAge = now - (p.enforcementHeartbeatMs || 0)
              if (!p.accessibility && p.enforcementHeartbeatMs > 0 && heartbeatAge < 5 * 60 * 1000) {
                sendToWorklet({ method: 'bypass:detected', args: { reason: 'force_stopped' } })
                NativeModules.UsageStatsModule?.clearEnforcementHeartbeat?.()
              }

              // Background-bypass detection: EnforcementService persisted a bypass event
              // while the RN JS thread was suspended (app backgrounded). Relay it now.
              const bypassAge = now - (p.bypassDetectedAt || 0)
              if (p.bypassDetectedReason && bypassAge < 24 * 60 * 60 * 1000) {
                sendToWorklet({ method: 'bypass:detected', args: { reason: p.bypassDetectedReason } })
                NativeModules.UsageStatsModule?.clearBypassDetected?.()
              }
            })
            .catch(() => {})

          // Flush any usage reports queued while the RN bridge was dead
          NativeModules.UsageStatsModule?.getQueuedReports?.()
            .then((json: string) => {
              const reports = JSON.parse(json || '[]')
              if (reports.length === 0) return
              // Drop queued reports captured before today's local midnight.
              // Their todaySeconds values reflect a prior day and would otherwise
              // overwrite today's "latest" report with stale numbers.
              const startOfToday = new Date()
              startOfToday.setHours(0, 0, 0, 0)
              const todayMs = startOfToday.getTime()
              const fresh = reports.filter((r: { timestamp?: number }) => (r.timestamp || 0) >= todayMs)
              const staleCount = reports.length - fresh.length
              if (staleCount > 0) console.log('[PearGuard] Dropping', staleCount, 'stale queued usage reports (pre-midnight)')
              console.log('[PearGuard] Flushing', fresh.length, 'queued usage reports')
              for (const report of fresh) {
                sendToWorklet({ method: 'usage:flush', args: { usage: report.usage, queued: true } })
              }
              NativeModules.UsageStatsModule?.clearQueuedReports?.()
            })
            .catch((e: unknown) => console.warn('[PearGuard] Queue flush failed:', e))
        }
      })

      // (Re)create the Bare worklet, wire its data + termination handlers, and start
      // it. The worklet emits 'terminate' if the native Bare thread dies; without a
      // handler the app looked alive but did nothing and every pending call hung.
      const spawnWorklet = () => {
        buf = ''
        _workletStarted = true
        _worklet = new Worklet()
        _worklet.on('terminate', onWorkletTerminate)
        _worklet.IPC.on('data', onWorkletData)
        // A fresh worklet re-emits 'bareReady', which re-triggers init (registered
        // once below), so the DB reopens and the swarm rejoins on restart.
        // react-native-bare-kit's start() may return undefined rather than a
        // promise — guard so `.catch` doesn't throw a TypeError (which previously
        // aborted the rest of start()). A start that fails silently is caught by
        // the handshake watchdog below, not by this handler.
        const started = _worklet.start('bare.bundle', source)
        if (started && typeof started.catch === 'function') {
          started.catch((e: unknown) => console.error('[RN] worklet start error:', e))
        }
        armHandshakeWatchdog()
      }

      // Re-arm the startup-handshake watchdog. If dbReady is still false after
      // HANDSHAKE_TIMEOUT_MS, first re-send init (cheap and idempotent — bare's
      // _initialized guard just re-emits 'ready' — which recovers a lost
      // bareReady/init/ready event). If it's STILL false one more interval later,
      // respawn the worklet from scratch (recovers a Worklet.start() that never
      // brought the Bare thread up). Bounded by MAX_HANDSHAKE_RESPAWNS.
      const armHandshakeWatchdog = () => {
        clearHandshakeWatchdog()
        _handshakeTimer = setTimeout(() => {
          if (_dbReady) return
          console.warn('[RN] handshake watchdog: no ready after', HANDSHAKE_TIMEOUT_MS, 'ms — re-sending init')
          sendToWorklet({ method: 'init', dataDir, debug: __DEV__ })
          _handshakeTimer = setTimeout(() => {
            if (_dbReady) return
            if (_handshakeRespawns >= MAX_HANDSHAKE_RESPAWNS) {
              console.error('[RN] handshake watchdog: no ready after', MAX_HANDSHAKE_RESPAWNS, 'respawns — giving up')
              return
            }
            _handshakeRespawns++
            console.warn('[RN] handshake watchdog: re-init did not take — respawning worklet (attempt', _handshakeRespawns, 'of', MAX_HANDSHAKE_RESPAWNS + ')')
            rejectAllPending('worklet handshake timeout')
            try { _worklet?.terminate?.() } catch {}
            _worklet = null
            _workletStarted = false
            spawnWorklet()  // re-arms the watchdog for the fresh worklet
          }, HANDSHAKE_TIMEOUT_MS)
        }, HANDSHAKE_TIMEOUT_MS)
      }

      function onWorkletTerminate () {
        console.error('[RN] Bare worklet terminated — rejecting pending calls and restarting')
        rejectAllPending('worklet terminated')
        _worklet = null
        _workletStarted = false
        setDbReady(false)
        // Short backoff so a crash-on-start can't spin hot.
        setTimeout(() => { if (!_workletStarted) spawnWorklet() }, 1500)
      }

      spawnWorklet()
    }

    start().catch(e => console.error('[RN] start error:', e))
    return () => { nativeSubs.forEach(sub => sub.remove()) }
  }, [])

  // Black-screen watchdog: if the WebView hasn't fired onLoad within 3s after html
  // is set and render, reload. Covers cases where the WebView silently fails to paint
  // (e.g. Android renderer wedged after long background) without crashing.
  useEffect(() => {
    if (!html || !dbReady || webViewReady) return
    const t = setTimeout(() => {
      if (!_webViewLoaded) {
        console.warn('[RN] WebView onLoad watchdog timeout — reloading')
        webViewRef.current?.reload()
      }
    }, 3000)
    return () => clearTimeout(t)
  }, [html, dbReady, webViewReady])

  // Pending notification navigation is now consumed in the onLoad handler below,
  // not here, so the 600ms timer starts after the WebView has actually loaded
  // (not from dbReady, which fires before the WebView even begins loading).

  // Screenshot mode: the native ScreenshotModule exposes a non-zero scene,
  // bypass the dbReady gate so the WebView renders fixtures without waiting
  // on the bare worklet handshake.
  const _ssScene = ((NativeModules as any).PearGuardScreenshot?.scene ?? 0)
  if (!html || (!dbReady && _ssScene <= 0)) {
    return <View style={styles.loading} />
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html }}
        style={styles.webview}
        onMessage={onWebViewMessage}
        injectedJavaScriptBeforeContentLoaded={`window.__pearPlatform=${JSON.stringify(Platform.OS)};window.__pearVersion=${JSON.stringify(Constants.expoConfig?.version ?? '')};${_pendingAlertsNav ? `window.__pendingAlertsNav=${JSON.stringify(_pendingAlertsNav)};` : ''}${(() => {
          const mod = (NativeModules as any).PearGuardScreenshot
          const scene = mod?.scene ?? 0
          const dark = mod?.dark ?? -1
          if (scene <= 0) return ''
          return `window.__PEARGUARD_SCREENSHOT_SCENE=${scene};window.__PEARGUARD_SCREENSHOT_DARK=${dark};`
        })()}true;`}
        onRenderProcessGone={() => {
          console.warn('[RN] WebView render process gone — reloading')
          _webViewLoaded = false
          webViewRef.current?.reload()
        }}
        onContentProcessDidTerminate={() => {
          console.warn('[RN] WebView content process terminated — reloading')
          _webViewLoaded = false
          webViewRef.current?.reload()
        }}
        onLoad={() => {
          _webViewLoaded = true
          setWebViewReady(true)
          // Expose platform to WebView UI (used by AvatarPicker to show single Camera button on iOS)
          webViewRef.current?.injectJavaScript('window.__pearPlatform=' + JSON.stringify(Platform.OS) + ';true;')
          // Replay the recent-event buffer so a freshly (re)loaded WebView catches up:
          // events that fired before first paint (e.g. peer:paired from bare's startup
          // topic-rejoin) AND events delivered to a prior context that was then reloaded
          // (watchdog / render-process-gone). A fresh page has applied nothing, so it
          // gets the whole retained window; the WebView drops any seq it already saw.
          for (const { event, data, seq } of _webViewReplay.replay()) {
            webViewRef.current?.injectJavaScript(
              'window.__pearEvent(' + JSON.stringify(event) + ',' + JSON.stringify(data) + ',' + seq + ');true;'
            )
          }
          // Cold-start notification navigation: start the 600ms timer from here (after
          // WebView has loaded) rather than from dbReady (before WebView starts loading).
          // This gives the React app inside the WebView time to mount Dashboard and register
          // its navigate:child:alerts / navigate:child:requests event handler.
          if (_pendingAlertsNav) {
            const nav = _pendingAlertsNav
            _pendingAlertsNav = null
            // Set a persistent JS-level marker immediately — Dashboard reads this on mount,
            // so timing of __pearEvent vs. component lifecycle doesn't matter.
            webViewRef.current?.injectJavaScript(`window.__pendingAlertsNav=${JSON.stringify(nav)};true;`)
            setTimeout(() => {
              webViewRef.current?.injectJavaScript(
                'window.__pearEvent("navigate:child:alerts",' + JSON.stringify({ childPublicKey: nav.childPublicKey, tab: nav.tab }) + ');true;'
              )
            }, 200)
          }
          if (_pendingChildRequestsNav) {
            _pendingChildRequestsNav = false
            setTimeout(() => {
              webViewRef.current?.injectJavaScript(
                'window.__pearEvent("navigate:child:requests",{});true;'
              )
            }, 200)
          }
          // iOS: check for pending notification navigation from LinkModule
          if (!isAndroid) {
            PearGuardLink?.getPendingNav?.().then((nav: { childPublicKey: string; tab: string } | null) => {
              if (nav) {
                webViewRef.current?.injectJavaScript(`window.__pendingAlertsNav=${JSON.stringify(nav)};true;`)
                setTimeout(() => {
                  webViewRef.current?.injectJavaScript(
                    'window.__pearEvent("navigate:child:alerts",' + JSON.stringify(nav) + ');true;'
                  )
                }, 200)
              }
            }).catch?.(() => {})
            PearGuardLink?.getPendingLink?.().then((url: string | null) => {
              if (url && url.includes('/join')) {
                sendToWorklet({ method: 'acceptInvite', args: [url] })
              }
            }).catch?.(() => {})
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        scrollEnabled={false}
        overScrollMode="never"
      />
      <ScannerModal
        visible={showScanner}
        onScanned={(url) => scanResolve.current?.(url)}
        onCancel={() => scanReject.current?.('cancelled')}
        onPermissionDenied={() => scanReject.current?.('Camera permission denied. Please enable in Settings.')}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111', paddingTop: StatusBar.currentHeight ?? 0 },
  webview:   { flex: 1, backgroundColor: '#111' },
  loading:   { flex: 1, backgroundColor: '#111' },
})