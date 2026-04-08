import React from 'react'
import { useTheme } from '../theme.js'
import { PRESETS } from './presetAvatars.js'

function getInitials(name) {
  return name && name.trim()
    ? name.trim().split(/\s+/).map((w) => w[0].toUpperCase()).slice(0, 2).join('')
    : '?'
}

function getColor(name) {
  let hash = 0
  const str = name || '?'
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  const colors = ['#1a73e8', '#e8461a', '#34a853', '#f59e0b', '#9c27b0', '#00bcd4', '#e91e63', '#607d8b']
  return colors[Math.abs(hash) % colors.length]
}

// Resolves an avatarThumb string (from peer records) into an avatar object
function resolveThumb(thumb) {
  if (!thumb) return null
  if (thumb.startsWith('preset:')) return { type: 'preset', id: thumb.slice(7) }
  // Animated avatars use "mime:<type>;base64" prefix to preserve MIME type
  if (thumb.startsWith('mime:')) {
    const semiIdx = thumb.indexOf(';')
    const mime = thumb.slice(5, semiIdx)
    const data = thumb.slice(semiIdx + 1)
    return { type: 'custom', thumb64: data, mime }
  }
  return { type: 'custom', thumb64: thumb }
}

export default function Avatar({ avatar, name, size = 48, onClick }) {
  const { colors } = useTheme()
  const resolved = typeof avatar === 'string' ? resolveThumb(avatar) : avatar
  const circleStyle = {
    width: size + 'px',
    height: size + 'px',
    borderRadius: '50%',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    cursor: onClick ? 'pointer' : 'default',
  }

  if (resolved && resolved.type === 'preset' && PRESETS[resolved.id]) {
    return (
      <div style={circleStyle} onClick={onClick}>
        <div
          style={{ width: '100%', height: '100%' }}
          dangerouslySetInnerHTML={{ __html: PRESETS[resolved.id] }}
        />
      </div>
    )
  }

  if (resolved && resolved.type === 'custom') {
    const src = resolved.base64 || resolved.thumb64
    if (src) {
      const mime = resolved.mime || 'image/jpeg'
      return (
        <div style={circleStyle} onClick={onClick}>
          <img
            src={`data:${mime};base64,${src}`}
            alt="avatar"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
      )
    }
  }

  // Fallback: initials circle
  return (
    <div
      style={{ ...circleStyle, backgroundColor: colors.surface.elevated }}
      onClick={onClick}
    >
      <span style={{ color: colors.text.secondary, fontSize: Math.round(size * 0.35) + 'px', fontWeight: '700' }}>
        {getInitials(name)}
      </span>
    </div>
  )
}
