// app/index.tsx
//
// React Native shell. Entry point loaded by Expo Router.
// Responsibilities:
//   1. Load and start the Bare worklet (assets/bare-universal.bundle)
//   2. Load the WebView UI (assets/app-ui.bundle) and render it full-screen
//   3. Route all IPC between WebView ↔ RN ↔ Bare
//   4. Handle deep links (pearguard://) and forward to join.tsx

import { useState, useEffect, useRef, useCallback } from 'react'
import { View, StyleSheet, Platform } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import { useRouter } from 'expo-router'

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

function sendToWorklet (msg: object) {
  _worklet?.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
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
          'window.__pearResponse(' + JSON.stringify({ id: msg.id, result: null }) + ');true;'
        )
        return
      }

      // Forward everything else to Bare
      const bareId = _nextId++
      _pending.set(bareId, result => {
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + JSON.stringify({ ...result, id: msg.id }) + ');true;'
        )
      })
      sendToWorklet({ ...msg, id: bareId })
    } catch (err) { console.error('[RN] WebView msg error:', err) }
  }, [])

  // Start the worklet and load the HTML bundle
  useEffect(() => {
    let buf = ''

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
            } else if (msg.type === 'response') {
              const resolve = _pending.get(msg.id)
              if (resolve) { _pending.delete(msg.id); resolve(msg) }
            }
          } catch (e) { console.error('[RN] IPC parse error:', e) }
        }
      })

      // When bare.js loads, it emits 'bareReady' — then we call init
      onEvent('bareReady', () => sendToWorklet({ method: 'init', dataDir }))

      // When init completes, bare emits 'ready' — mark DB ready
      onEvent('ready', (data) => {
        setDbReady(true)
      })

      await _worklet.start({ source })
    }

    start().catch(e => console.error('[RN] start error:', e))
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
