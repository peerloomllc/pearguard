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
      const mime = sourceMime || 'image/jpeg'
      const dataUrl = canvas.toDataURL(mime, quality)
      resolve(dataUrl.split(',')[1])
    }
    img.src = 'data:' + (sourceMime || 'image/jpeg') + ';base64,' + base64
  })
}

const ANIMATED_MIMES = ['image/gif', 'image/webp']
const MAX_ANIMATED_BASE64 = 500_000

export async function pickPhoto() {
  const result = await window.callBare('avatar:pickPhoto')
  if (!result || !result.base64) return null
  const mime = result.mime || 'image/jpeg'
  const isAnimated = ANIMATED_MIMES.includes(mime)
  if (isAnimated && result.base64.length <= MAX_ANIMATED_BASE64) {
    const thumb64 = await compressImage(result.base64, 48, 0.6, mime)
    return { type: 'custom', base64: result.base64, thumb64, mime }
  }
  const base64 = await compressImage(result.base64, 256, 0.8, mime)
  const thumb64 = await compressImage(result.base64, 48, 0.6, mime)
  return { type: 'custom', base64, thumb64, mime }
}
