function compressImage(base64, size, quality, sourceMime) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      const min = Math.min(img.width, img.height)
      const sx = (img.width - min) / 2
      const sy = (img.height - min) / 2
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size)
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      resolve(dataUrl.split(',')[1])
    }
    img.src = 'data:' + (sourceMime || 'image/jpeg') + ';base64,' + base64
  })
}

const ANIMATED_MIMES = ['image/gif', 'image/webp']
const MAX_ANIMATED_BASE64 = 500_000

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target.result
      resolve(dataUrl.split(',')[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export async function pickCameraPhoto() {
  const result = await window.callBare('avatar:pickCamera')
  if (!result || !result.base64) return null
  const mime = result.mime || 'image/jpeg'
  const isAnimated = ANIMATED_MIMES.includes(mime)
  if (isAnimated && result.base64.length <= MAX_ANIMATED_BASE64) {
    const thumb64 = await compressImage(result.base64, 48, 0.6, mime)
    return { type: 'custom', base64: result.base64, thumb64, mime }
  }
  const base64 = await compressImage(result.base64, 256, 0.8, mime)
  const thumb64 = await compressImage(result.base64, 48, 0.6, mime)
  return { type: 'custom', base64, thumb64 }
}

export async function processFileForAvatar(file) {
  const mime = file.type || 'image/jpeg'
  const isAnimated = ANIMATED_MIMES.includes(mime)
  const raw = await readFileAsBase64(file)
  if (isAnimated && raw.length <= MAX_ANIMATED_BASE64) {
    const thumb64 = await compressImage(raw, 48, 0.6, mime)
    return { type: 'custom', base64: raw, thumb64, mime }
  }
  const base64 = await compressImage(raw, 256, 0.8, mime)
  const thumb64 = await compressImage(raw, 48, 0.6, mime)
  return { type: 'custom', base64, thumb64 }
}
