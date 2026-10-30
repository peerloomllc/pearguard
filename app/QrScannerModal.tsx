// Full-screen QR scanner, used by app/index.tsx and app/child-setup.tsx.
//
// The camera runs in a WebView of its own (src/ui/qrScannerPage.js, built to
// assets/qr-scanner.bundle) and jsQR reads each frame, so the app carries no
// native scanner and no Google ML Kit. The page is loaded on
// https://localhost/, the secure context getUserMedia needs; the main UI's
// WebView keeps its own origin.

import { useEffect, useRef, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Modal, Platform, PermissionsAndroid } from 'react-native'
import { WebView } from 'react-native-webview'
import { Asset } from 'expo-asset'

let _pageHtml: string | null = null

async function loadPage (): Promise<string> {
  if (_pageHtml) return _pageHtml
  const asset = Asset.fromModule(require('../assets/qr-scanner.bundle'))
  await asset.downloadAsync()
  const js = await fetch(asset.localUri!).then(r => r.text())
  _pageHtml = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}' +
    'video{width:100%;height:100%;object-fit:cover}' +
    '#f{position:absolute;left:50%;top:50%;width:240px;height:240px;margin:-120px 0 0 -120px;border:3px solid #fff;border-radius:16px}</style>' +
    '</head><body><video id="v" muted playsinline></video><div id="f"></div><script>' + js.replace(/<\/script/gi, '<\\/script') + '</script></body></html>'
  return _pageHtml
}

// Android's WebView gives no camera without the app's CAMERA permission.
// iOS asks by itself when the page opens the camera.
async function cameraAllowed (): Promise<boolean> {
  if (Platform.OS !== 'android') return true
  const perm = PermissionsAndroid.PERMISSIONS.CAMERA
  if (await PermissionsAndroid.check(perm)) return true
  return (await PermissionsAndroid.request(perm)) === PermissionsAndroid.RESULTS.GRANTED
}

export default function QrScannerModal ({
  visible,
  onScanned,
  onCancel,
  onPermissionDenied,
}: {
  visible: boolean
  onScanned: (text: string) => void
  onCancel: () => void
  onPermissionDenied?: () => void
}) {
  const [html, setHtml] = useState<string | null>(null)
  const scanned = useRef(false)

  useEffect(() => {
    if (!visible) { scanned.current = false; setHtml(null); return }
    let cancelled = false
    ;(async () => {
      if (!(await cameraAllowed())) { if (!cancelled) (onPermissionDenied ?? onCancel)(); return }
      const page = await loadPage()
      if (!cancelled) setHtml(page)
    })().catch(() => { if (!cancelled) onCancel() })
    return () => { cancelled = true }
  }, [visible])

  function onMessage (e: any) {
    let msg: any
    try { msg = JSON.parse(e.nativeEvent.data) } catch { return }
    if (msg.type === 'scanned' && !scanned.current) {
      scanned.current = true
      onScanned(String(msg.text))
    } else if (msg.type === 'error') {
      if (msg.denied) (onPermissionDenied ?? onCancel)()
      else onCancel()
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {html ? (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <WebView
            source={{ html, baseUrl: 'https://localhost/' }}
            originWhitelist={['*']}
            onMessage={onMessage}
            javaScriptEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            mediaCapturePermissionGrantType="grant"
            style={{ flex: 1, backgroundColor: '#000' }}
          />
          <View style={styles.overlay} pointerEvents="box-none">
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.waiting}>
          <Text style={{ color: '#fff' }}>Opening the camera…</Text>
        </View>
      )}
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay:    { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', padding: 32 },
  cancelBtn:  { backgroundColor: 'rgba(0,0,0,0.65)', padding: 16, borderRadius: 8, alignItems: 'center' },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  waiting:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
})
