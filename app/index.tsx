// app/index.tsx
//
// React Native shell. Entry point loaded by Expo Router.
// Responsibilities:
//   1. Load and start the Bare worklet (assets/bare-universal.bundle)
//   2. Load the WebView UI (assets/app-ui.bundle) and render it full-screen
//   3. Route all IPC between WebView ↔ RN ↔ Bare
//   4. Handle deep links (pearguard://) and forward to join.tsx

import { useState, useEffect, useRef, useCallback } from 'react'
import { View, StyleSheet, Platform, DeviceEventEmitter, NativeModules } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import { useRouter } from 'expo-router'
import { setBareCaller } from './setup'

// ── Worklet singleton ─────────────────────────────────────────────────────────
// The worklet must survive re-renders and navigation — keep it in module scope.

let _worklet: any = null
let _workletStarted = false
let _nextId = 1
const _pending = new Map<number, (msg: any) => void>()
const _eventHandlers = new Map<string, ((data: any) => void)[]>()

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

// ── Root component ────────────────────────────────────────────────────────────

export default function Root () {
  const [html,         setHtml]         = useState<string | null>(null)
  const [dbReady,      setDbReady]      = useState(false)
  const [webViewReady, setWebViewReady] = useState(false)
  const webViewRef = useRef<any>(null)
  const router = useRouter()

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
      // Ensure data directory exists
      const docDir = FileSystem.documentDirectory!
      const dataUri = docDir + 'pearguard'
      await FileSystem.makeDirectoryAsync(dataUri, { intermediates: true }).catch(() => {})
      const dataDir = dataUri.replace(/^file:\/\//, '')

      // Load the UI bundle
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

      // Load and start the Bare worklet
      const bundleAsset = Asset.fromModule(require('../assets/bare-universal.bundle'))
      await bundleAsset.downloadAsync()
      const source = await fetch(bundleAsset.localUri!).then(r => r.text())

      if (_workletStarted && _worklet) {
        sendToWorklet({ method: 'init', dataDir })
        return
      }
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
              // Forward Bare events to WebView
              webViewRef.current?.injectJavaScript(
                'window.__pearEvent(' + JSON.stringify(msg.event) + ',' + JSON.stringify(msg.data) + ');true;'
              )
              ;(_eventHandlers.get(msg.event) ?? []).forEach(fn => fn(msg.data))
            } else if (msg.method === 'policy:update') {
              // Write policy to SharedPreferences so native enforcement modules can read it
              NativeModules.UsageStatsModule?.setPolicy(JSON.stringify(msg.args))
            } else if (msg.type === 'response') {
              const resolve = _pending.get(msg.id)
              if (resolve) { _pending.delete(msg.id); resolve(msg) }
            }
          } catch (e) { console.error('[RN] IPC parse error:', e) }
        }
      })

      // When bare.js loads, it emits 'bareReady' — then we call init
      onEvent('bareReady', () => sendToWorklet({ method: 'init', dataDir }))

      // When init completes, bare emits 'ready' — mark DB ready and check mode
      onEvent('ready', (data) => {
        setDbReady(true)
        if (!data.mode) {
          setTimeout(() => router.push('/setup'), 500)
        }
      })

      await _worklet.start({ source })

      // Listen for deep link and native enforcement events
      nativeSubs.push(
        DeviceEventEmitter.addListener('pearguardLink', (url: string) => {
          console.log('[RN] pearguardLink received:', url)
          sendToWorklet({ method: 'acceptInvite', args: [url] })
        }),

        // New app installed — forward to bare worklet as app:installed
        DeviceEventEmitter.addListener('onAppInstalled', (e: { packageName: string }) => {
          sendToWorklet({ method: 'app:installed', args: { packageName: e.packageName } })
        }),

        // Accessibility Service or Device Admin disabled — forward as alert:bypass
        DeviceEventEmitter.addListener('onBypassDetected', (reason: string) => {
          sendToWorklet({ method: 'alert:bypass', args: { reason } })
        }),

        // Child tapped "Send Request" on block overlay — forward as time:request
        DeviceEventEmitter.addListener('onTimeRequest', (e: { packageName: string; appName: string }) => {
          sendToWorklet({ method: 'time:request', args: { packageName: e.packageName, appName: e.appName } })
        }),

        // PIN entered successfully — log the override event
        DeviceEventEmitter.addListener('onPinSuccess', (e: { packageName: string; timestamp: number; durationSeconds: number }) => {
          sendToWorklet({ method: 'pin:used', args: e })
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
      )
    }

    start().catch(e => console.error('[RN] start error:', e))
    return () => { nativeSubs.forEach(sub => sub.remove()) }
  }, [])

  if (!html) {
    return <View style={styles.loading} />
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html }}
        style={styles.webview}
        onMessage={onWebViewMessage}
        onLoad={() => setWebViewReady(true)}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        scrollEnabled={false}
        overScrollMode="never"
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },
  webview:   { flex: 1, backgroundColor: '#111' },
  loading:   { flex: 1, backgroundColor: '#111' },
})
