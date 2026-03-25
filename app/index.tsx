// app/index.tsx
//
// React Native shell. Entry point loaded by Expo Router.
// Responsibilities:
//   1. Load and start the Bare worklet (assets/bare-universal.bundle)
//   2. Load the WebView UI (assets/app-ui.bundle) and render it full-screen
//   3. Route all IPC between WebView ↔ RN ↔ Bare
//   4. Handle deep links (pearguard://) and forward to join.tsx

import { useState, useEffect, useRef, useCallback } from 'react'
import { View, StyleSheet, Platform, DeviceEventEmitter, NativeModules, PermissionsAndroid, StatusBar, Share, Modal, Text, TouchableOpacity, AppState } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import { useRouter } from 'expo-router'
import * as Linking from 'expo-linking'
import { setBareCaller } from './setup'
import { CameraView, useCameraPermissions } from 'expo-camera'

// ── Worklet singleton ─────────────────────────────────────────────────────────
// The worklet must survive re-renders and navigation — keep it in module scope.

let _worklet: any = null
let _workletStarted = false
let _mode: string | null = null
let _dbReady = false
let _nextId = 1
const _pending = new Map<number, (msg: any) => void>()
const _eventHandlers = new Map<string, ((data: any) => void)[]>()
// Invite URL received before worklet was ready — sent once dispatch is initialized
let _pendingInviteUrl: string | null = null
// { childPublicKey, tab } from pear://pearguard/alerts deep link — injected into WebView after dbReady
let _pendingAlertsNav: { childPublicKey: string; tab?: string } | null = null
// pear://pearguard/child-requests deep link — navigate child app to Requests tab
let _pendingChildRequestsNav = false
// Events that fired before the WebView finished loading — replayed once onLoad fires.
// Bare auto-reconnects on startup (reloads persisted topics), so peer:paired /
// child:connected can fire before the WebView is ready to receive them.
let _webViewLoaded = false
const _pendingWebViewEvents: { event: string; data: any }[] = []
// Stable inject function updated each render so buffered events reach current WebView ref.
let _injectToWebView: ((js: string) => void) | null = null

// ── Module-level deep link listeners ──────────────────────────────────────────
// These must live outside the component so they are never removed on unmount.
// When a deep link arrives, Expo Router may navigate to join.tsx which unmounts
// index.tsx — any listener registered in useEffect would be torn down. These
// listeners survive for the lifetime of the JS bundle.

Linking.addEventListener('url', ({ url }) => {
  if (url && url.startsWith('pear://pearguard/join')) {
    console.log('[RN] invite URL (module-level Linking):', url)
    sendToWorklet({ method: 'acceptInvite', args: [url] })
  } else if (url && url.startsWith('pear://pearguard/alerts')) {
    const qs = url.split('?')[1] ?? ''
    const keyMatch = qs.match(/childPublicKey=([^&]+)/)
    const tabMatch = qs.match(/tab=([^&]+)/)
    if (keyMatch) _pendingAlertsNav = { childPublicKey: decodeURIComponent(keyMatch[1]), tab: tabMatch ? decodeURIComponent(tabMatch[1]) : undefined }
  } else if (url && url.startsWith('pear://pearguard/child-requests')) {
    _pendingChildRequestsNav = true
  }
})

DeviceEventEmitter.addListener('pearguardLink', (url: string) => {
  console.log('[RN] pearguardLink (module-level):', url)
  if (_worklet) {
    sendToWorklet({ method: 'acceptInvite', args: [url] })
  } else {
    // Worklet not yet ready (cold start) — buffer and send from ready handler
    _pendingInviteUrl = url
  }
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
    if (pendingId !== undefined) {
      const resolve = _pending.get(pendingId)
      if (resolve) { _pending.delete(pendingId); resolve({ error: 'IPC write failed' }) }
    }
  }
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
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    'html, body, #root { height: 100dvh; width: 100%; overflow: hidden; background: #111; }',
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
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          onBarcodeScanned={handleBarcode}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        >
          <View style={scannerStyles.overlay}>
            <TouchableOpacity style={scannerStyles.cancelBtn} onPress={onCancel}>
              <Text style={scannerStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </CameraView>
      ) : (
        <View style={scannerStyles.waiting}>
          <Text style={{ color: '#fff' }}>Requesting camera permission…</Text>
        </View>
      )}
    </Modal>
  )
}

const scannerStyles = StyleSheet.create({
  overlay:    { flex: 1, justifyContent: 'flex-end', padding: 32 },
  cancelBtn:  { backgroundColor: 'rgba(0,0,0,0.65)', padding: 16, borderRadius: 8, alignItems: 'center' },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  waiting:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
})

// ── Root component ────────────────────────────────────────────────────────────

export default function Root () {
  const [html,         setHtml]         = useState<string | null>(null)
  const [dbReady,      setDbReady]      = useState(false)
  const [webViewReady, setWebViewReady] = useState(false)
  const webViewRef = useRef<any>(null)
  const [showScanner, setShowScanner] = useState(false)
  const scanResolve = useRef<((url: string) => void) | null>(null)
  const scanReject  = useRef<((reason: string) => void) | null>(null)
  const router = useRouter()

  // Keep module-level inject pointer in sync with current WebView ref on every render
  _injectToWebView = (js: string) => webViewRef.current?.injectJavaScript(js)

  // Handle messages from the WebView
  const onWebViewMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data)

      // Methods handled directly in RN (not forwarded to Bare)
      if (msg.method === 'navigateTo') {
        router.push(msg.args[0])
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + msg.id + ', null);true;'
        )
        return
      }

      if (msg.method === 'share:text') {
        Share.share({ message: msg.args.text })
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

      // Forward everything else to Bare
      // bareId routes response back to the right callback; msg.id is preserved for the WebView response
      const bareId = _nextId++
      _pending.set(bareId, result => {
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + msg.id + ', ' + JSON.stringify(result.result ?? null) + ', ' + JSON.stringify(result.error ?? null) + ');true;'
        )
      })
      sendToWorklet({ ...msg, id: bareId }, bareId)
    } catch (err) { console.error('[RN] WebView msg error:', err) }
  }, [])

  // Start the worklet and load the HTML bundle
  useEffect(() => {
    let buf = ''
    const nativeSubs: ReturnType<typeof DeviceEventEmitter.addListener>[] = []

    async function start () {
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
          _pending.set(id, (msg) => {
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
      nativeSubs.push(
        // New app installed — forward to bare worklet as app:installed
        DeviceEventEmitter.addListener('onAppInstalled', (e: { packageName: string; appName?: string; iconBase64?: string }) => {
          sendToWorklet({ method: 'app:installed', args: { packageName: e.packageName, appName: e.appName, iconBase64: e.iconBase64 } })
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

        // Child tapped "Send Request" on block overlay — forward as time:request
        DeviceEventEmitter.addListener('onTimeRequest', (e: { packageName: string; appName: string }) => {
          sendToWorklet({ method: 'time:request', args: { packageName: e.packageName, appName: e.appName } })
        }),

        // PIN entered successfully — log the override event
        DeviceEventEmitter.addListener('onPinSuccess', (e: { packageName: string; timestamp: number; durationSeconds: number }) => {
          sendToWorklet({ method: 'pin:used', args: e })
        }),

        // App foregrounded — kick Hyperswarm to reconnect in case connection dropped while backgrounded
        AppState.addEventListener('change', (state) => {
          if (state !== 'active') return
          sendToWorklet({ method: 'swarm:reconnect' })
          // Re-appear check: only after DB is ready and mode is known
          if (_dbReady && _mode === 'child') {
            NativeModules.UsageStatsModule?.checkChildPermissions?.()
              .then((p: { accessibility: boolean; usageStats: boolean }) => {
                if (!p.accessibility) router.replace('/child-setup?step=1&source=bypass_recovery')
                else if (!p.usageStats) router.replace('/child-setup?step=2')
              })
              .catch((e: unknown) => console.warn('[index] checkChildPermissions error:', e))
          }
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
            const usageList = await NativeModules.UsageStatsModule.getDailyUsageAll()
            sendToWorklet({ method: 'usage:flush', args: { usage: usageList } })
          } catch (err) {
            console.warn('[PearGuard] Usage flush failed:', err)
          }
        }),

        // ParentConnectionService heartbeat — trigger swarm:reconnect to restore
        // any connections that dropped while the app was backgrounded
        DeviceEventEmitter.addListener('onParentReconnectNeeded', () => {
          sendToWorklet({ method: 'swarm:reconnect' })
        }),
      )

      // If worklet already running (e.g. returning from setup screen or after deep-link
      // navigation), mark DB ready immediately and send init (bare will re-emit 'ready'
      // but the event handlers from the old mount are stale — set dbReady directly here).
      if (_workletStarted && _worklet) {
        setDbReady(true)
        sendToWorklet({ method: 'init', dataDir })
        return
      }

      // Load and start the Bare worklet
      const bundleAsset = Asset.fromModule(require('../assets/bare-universal.bundle'))
      await bundleAsset.downloadAsync()
      const source = await fetch(bundleAsset.localUri!).then(r => r.text())
      _workletStarted = true
      _worklet = new Worklet()

      // Listen for messages from Bare
      _worklet.IPC.on('data', (chunk: Uint8Array) => {
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
                NativeModules.UsageStatsModule?.getInstalledPackages?.()
                  .then((apps: { packageName: string; appName: string }[]) => {
                    // Send all apps in one batch to avoid race-condition on parent side
                    // (individual messages all read same policy DB key concurrently, last-writer-wins)
                    sendToWorklet({ method: 'apps:sync', args: { apps } })
                  })
                  .catch((e: any) => console.warn('[RN] getInstalledPackages failed:', e))
                return
              }
              // Handle usageFlushRequested locally — gather usage stats and flush immediately
              if (msg.event === 'usageFlushRequested') {
                NativeModules.UsageStatsModule?.getDailyUsageAll?.()
                  .then((usageList: { packageName: string; appName: string; secondsToday: number }[]) => {
                    sendToWorklet({ method: 'usage:flush', args: { usage: usageList } })
                  })
                  .catch((e: any) => console.warn('[RN] usageFlushRequested getDailyUsageAll failed:', e))
                return
              }
              // Track child heartbeat timestamps so ParentConnectionService can detect force-stop
              if (msg.event === 'heartbeat:received') {
                const { childPublicKey, childDisplayName, timestamp } = msg.data ?? {}
                if (childPublicKey) {
                  NativeModules.UsageStatsModule?.updateChildHeartbeat?.(
                    childPublicKey,
                    childDisplayName || 'Child',
                    timestamp || Date.now()
                  )
                }
              }
              // Show a notification on the parent device when a child sends a time request
              if (msg.event === 'time:request:received') {
                const { childDisplayName, appName, packageName, childPublicKey } = msg.data ?? {}
                const childLabel = childDisplayName || 'Your child'
                const appLabel = appName || packageName || 'an app'
                NativeModules.UsageStatsModule?.showTimeRequestNotification?.(childLabel, appLabel, childPublicKey || '')
              }
              // Show a notification on the child device when parent approves/denies a time request
              if (msg.event === 'request:updated') {
                const { appName, packageName, status } = msg.data ?? {}
                if (status === 'approved' || status === 'denied') {
                  const label = appName || packageName || 'an app'
                  NativeModules.UsageStatsModule?.showDecisionNotification?.(label, status)
                }
              }
              // Show a notification on the parent device when a child's accessibility service is disabled
              if (msg.event === 'alert:bypass') {
                const { childPublicKey, childDisplayName } = msg.data ?? {}
                const childName = childDisplayName || 'Your child'
                NativeModules.UsageStatsModule?.showBypassAlertNotification?.(childName, childPublicKey || '')
              }
              // Notify about app installs — behaviour differs by mode:
              // Parent: show "X installed a new app" notification (childDisplayName present = came via P2P)
              // Child: show "You installed a new app" notification (no childDisplayName = local event)
              if (msg.event === 'app:installed') {
                const { childPublicKey, childDisplayName, appName, packageName } = msg.data ?? {}
                const appLabel = appName || packageName || 'an app'
                if (childDisplayName) {
                  // Parent device — message arrived from child over P2P
                  NativeModules.UsageStatsModule?.showAppInstalledNotification?.(childDisplayName, appLabel, childPublicKey || '')
                } else if (_mode === 'child') {
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
                  NativeModules.UsageStatsModule?.showAppUninstalledNotification?.(childDisplayName, appLabel, childPublicKey || '')
                } else if (_mode === 'child') {
                  // Child device — local uninstall event
                  NativeModules.UsageStatsModule?.showAppUninstalledNotification?.('You', appLabel, '')
                }
              }
              // Child was remotely unpaired by parent — wipe local state and return to setup.
              // Clear the native policy first so AppBlockerModule stops blocking and any
              // active overlay is dismissed before navigating away.
              if (msg.event === 'child:reset') {
                NativeModules.UsageStatsModule?.setPolicy('')
                NativeModules.UsageStatsModule?.dismissAllOverlays?.()
                router.replace('/setup')
                return
              }

              // Forward all other Bare events to WebView (buffer if not yet loaded)
              const pearEventJs = 'window.__pearEvent(' + JSON.stringify(msg.event) + ',' + JSON.stringify(msg.data) + ');true;'
              if (_webViewLoaded) {
                _injectToWebView?.(pearEventJs)
              } else {
                _pendingWebViewEvents.push({ event: msg.event, data: msg.data })
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
            } else if (msg.type === 'response') {
              const resolve = _pending.get(msg.id)
              if (resolve) { _pending.delete(msg.id); resolve(msg) }
            }
          } catch (e) { console.error('[RN] IPC parse error:', e) }
        }
      })

      // When bare.js loads, it emits 'bareReady' — then we call init
      onEvent('bareReady', () => sendToWorklet({ method: 'init', dataDir }))

      // When init completes, bare emits 'ready' — dispatch is now initialized
      onEvent('ready', (data) => {
        _mode = data.mode
        _dbReady = true
        setDbReady(true)
        // Flush any invite URL that arrived before the worklet was ready
        if (_pendingInviteUrl) {
          sendToWorklet({ method: 'acceptInvite', args: [_pendingInviteUrl] })
          _pendingInviteUrl = null
        }
        if (!data.mode) {
          setTimeout(() => router.replace('/setup'), 500)
        }
        // Start the parent background service so Hyperswarm stays connected
        // while the app is backgrounded (keeps process alive, prevents TCP drop)
        if (data.mode === 'parent') {
          NativeModules.UsageStatsModule?.startParentService?.()
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
        }
      })

      await _worklet.start('bare.bundle', source)

      // Cold start: app launched by a deep link — buffer the URL so the ready
      // handler sends it after dispatch is initialized (no racy setTimeout).
      Linking.getInitialURL().then(url => {
        if (url && url.startsWith('pear://pearguard/join')) {
          _pendingInviteUrl = _pendingInviteUrl ?? url
        } else if (url && url.startsWith('pear://pearguard/alerts')) {
          const qs = url.split('?')[1] ?? ''
          const keyMatch = qs.match(/childPublicKey=([^&]+)/)
          const tabMatch = qs.match(/tab=([^&]+)/)
          if (keyMatch) _pendingAlertsNav = _pendingAlertsNav ?? { childPublicKey: decodeURIComponent(keyMatch[1]), tab: tabMatch ? decodeURIComponent(tabMatch[1]) : undefined }
        } else if (url && url.startsWith('pear://pearguard/child-requests')) {
          _pendingChildRequestsNav = _pendingChildRequestsNav || true
        }
      }).catch(() => {})
    }

    start().catch(e => console.error('[RN] start error:', e))
    return () => { nativeSubs.forEach(sub => sub.remove()) }
  }, [])

  // When db is ready and a notification-tap deep link is pending, navigate to that child's tab
  useEffect(() => {
    if (!dbReady || !_pendingAlertsNav) return
    const { childPublicKey, tab } = _pendingAlertsNav
    _pendingAlertsNav = null
    // Give the WebView React app 600ms to fully render before injecting navigation
    setTimeout(() => {
      webViewRef.current?.injectJavaScript(
        'window.__pearEvent("navigate:child:alerts",' + JSON.stringify({ childPublicKey, tab }) + ');true;'
      )
    }, 600)
  }, [dbReady])

  // When db is ready and a child-requests deep link is pending, navigate child app to Requests tab
  useEffect(() => {
    if (!dbReady || !_pendingChildRequestsNav) return
    _pendingChildRequestsNav = false
    setTimeout(() => {
      webViewRef.current?.injectJavaScript(
        'window.__pearEvent("navigate:child:requests",{});true;'
      )
    }, 600)
  }, [dbReady])

  if (!html || !dbReady) {
    return <View style={styles.loading} />
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html }}
        style={styles.webview}
        onMessage={onWebViewMessage}
        onLoad={() => {
          _webViewLoaded = true
          setWebViewReady(true)
          // Replay events that fired before the WebView was ready (e.g. peer:paired
          // from bare's startup topic-rejoin running before the WebView finishes loading)
          const queued = _pendingWebViewEvents.splice(0)
          for (const { event, data } of queued) {
            webViewRef.current?.injectJavaScript(
              'window.__pearEvent(' + JSON.stringify(event) + ',' + JSON.stringify(data) + ');true;'
            )
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