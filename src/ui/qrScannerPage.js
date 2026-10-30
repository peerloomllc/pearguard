// The QR scanner page, a bundle of its own that app/QrScannerModal.tsx shows in
// a separate WebView. Camera frames from getUserMedia go through jsQR, so no
// native scanner and no Google ML Kit in the app. Built to
// assets/qr-scanner.bundle by npm run build:ui.
import jsQR from 'jsqr'

function post (msg) {
  window.ReactNativeWebView.postMessage(JSON.stringify(msg))
}

async function start () {
  const video = document.getElementById('v')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let stream
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no camera')
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch (e) {
    return post({ type: 'error', denied: !!(e && e.name === 'NotAllowedError') })
  }
  video.srcObject = stream
  await video.play()
  const tick = () => {
    if (video.readyState >= 2 && video.videoWidth) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      let img = null
      try { img = ctx.getImageData(0, 0, canvas.width, canvas.height) } catch {}
      const found = img && jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
      if (found && found.data) {
        stream.getTracks().forEach((t) => t.stop())
        return post({ type: 'scanned', text: found.data })
      }
    }
    requestAnimationFrame(tick)
  }
  tick()
}

start()
