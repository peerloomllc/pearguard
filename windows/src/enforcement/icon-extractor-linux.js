// Resolve Icon= values from .desktop files into base64-encoded PNGs.
// Mirrors the Windows icon-extractor's shape so apps-enumerator can call
// either platform's extractor by the same contract.
//
// Why we hand-roll instead of using libnotify/Gtk lookup APIs:
//   - Bare Node has no Gtk bindings and we don't want to ship one.
//   - The Icon= spec is simple enough to implement faithfully for PNGs.
//   - SVG rendering would need a rasterizer (rsvg/sharp). We skip SVG-only
//     icons for now; the parent UI falls back to initials, which is the
//     same fallback Windows uses when a PE has no icon group.
//
// XDG icon-theme spec: https://specifications.freedesktop.org/icon-theme-spec/latest/
// We honor the search-order intent (per-theme size dirs first, then fallback
// chains, then /usr/share/pixmaps) but skip the full theme inheritance graph
// since hicolor + the current theme cover virtually every desktop app.
const fs = require('fs').promises
const path = require('path')
const os = require('os')

// Size preference. We aim for ~128 so the parent dashboard has enough
// resolution to render at common UI scales without a network round-trip per
// app. When 128 / 96 / 64 are absent we'd rather jump up to 256 than fall
// back to 48 — a HiDPI 48 looks worse than a downscaled 256. Anything below
// 48 is a last resort (16/22/24 only really exist for menu/toolbar use).
const DEFAULT_SIZE_PRIORITY = [128, 96, 64, 256, 192, 160, 48, 32, 24, 22, 16]

function defaultIconRoots() {
  const home = os.homedir()
  const xdgData = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
  const userData = xdgData || path.join(home, '.local/share')
  return [
    path.join(home, '.icons'),                              // legacy user override
    path.join(userData, 'icons'),                           // XDG user icons dir
    path.join(home, '.local/share/flatpak/exports/share/icons'),
    '/var/lib/flatpak/exports/share/icons',
    '/usr/local/share/icons',
    '/usr/share/icons',
    // Flat layout: /usr/share/pixmaps/<name>.png. Used by older apps that
    // never adopted hicolor. Tried last because resolution is uncontrolled.
    '/usr/share/pixmaps',
    '/usr/local/share/pixmaps',
  ]
}

// Themes to try, in order. The current theme (XDG-set) wins, then hicolor as
// the spec-blessed fallback that every app ships. We don't walk theme
// inheritance — most real desktop apps have an hicolor icon and Adwaita
// covers the few that only ship under a theme.
function themesPriority() {
  const themes = []
  const current = process.env.XDG_CURRENT_DESKTOP || ''
  // Crude map from session to a likely theme name; not exhaustive, but
  // covers Debian/Fedora/Ubuntu defaults.
  if (/GNOME/i.test(current)) themes.push('Adwaita')
  if (/KDE/i.test(current)) themes.push('breeze', 'Breeze')
  if (/XFCE/i.test(current)) themes.push('elementary-xfce')
  themes.push('hicolor')
  // De-dupe preserving order.
  return Array.from(new Set(themes))
}

// Try to resolve a single icon name into an absolute file path. Returns null
// if nothing matched. Caller decides whether to read the bytes.
async function resolveIconPath(iconKey, {
  roots = defaultIconRoots(),
  themes = themesPriority(),
  sizes = DEFAULT_SIZE_PRIORITY,
} = {}) {
  if (typeof iconKey !== 'string' || !iconKey) return null
  // Absolute path: trust and verify it exists.
  if (path.isAbsolute(iconKey)) {
    if (/\.png$/i.test(iconKey)) {
      try { await fs.access(iconKey); return iconKey } catch (_) { return null }
    }
    return null  // skip svg/xpm/other formats; pre-rendered PNG only
  }
  // Strip an extension if the .desktop included one. Spec says Icon= is a
  // name; but a handful of distro entries do include .png.
  const base = iconKey.replace(/\.(png|svg|xpm)$/i, '')

  // Theme-organized layout: <root>/<theme>/<size>x<size>/apps/<name>.png
  // Some themes use scalable/apps/<name>.svg only — skipped because we
  // can't rasterize without a dependency.
  for (const size of sizes) {
    for (const theme of themes) {
      for (const root of roots) {
        const p = path.join(root, theme, `${size}x${size}`, 'apps', `${base}.png`)
        try { await fs.access(p); return p } catch (_) {}
      }
    }
  }

  // Flat layout: /usr/share/pixmaps/<name>.png (and variants). Caught by the
  // pixmaps roots above when joined as <root>/<name>.png.
  for (const root of roots) {
    if (!/pixmaps$/.test(root)) continue
    const p = path.join(root, `${base}.png`)
    try { await fs.access(p); return p } catch (_) {}
  }

  return null
}

// Batch resolver: take an iterable of icon keys, return Map<key, base64>.
// Missing icons are absent from the map (caller checks .get() for null).
async function extractLinuxIcons(iconKeys, opts = {}) {
  const out = new Map()
  if (process.platform !== 'linux') return out
  // Dedupe early so a popular icon (e.g. distro-default browser icon shared
  // across many launchers) doesn't get resolved + read N times.
  const unique = Array.from(new Set(Array.from(iconKeys).filter(Boolean)))
  await Promise.all(unique.map(async (key) => {
    try {
      const p = await resolveIconPath(key, opts)
      if (!p) return
      const buf = await fs.readFile(p)
      // Belt-and-suspenders: only emit base64 for actual PNGs. .access()
      // already filtered by extension; this guards against a misnamed file.
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) return
      out.set(key, buf.toString('base64'))
    } catch (_) { /* skip on read error */ }
  }))
  return out
}

module.exports = {
  resolveIconPath,
  extractLinuxIcons,
  defaultIconRoots,
  themesPriority,
  DEFAULT_SIZE_PRIORITY,
}
