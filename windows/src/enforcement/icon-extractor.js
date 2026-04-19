const { execFile } = require('child_process')

// Icon extraction for Windows apps. Two code paths, matching the two
// enumerator sources:
//   - Win32 apps: ExtractAssociatedIcon on the exe → PNG → base64
//   - UWP apps: read Square44x44Logo from the appx manifest → base64
//
// Both extractors accept an injectable `exec(script)` for tests so we can
// drive them with canned JSON without touching PowerShell.

const MAX_BUFFER = 64 * 1024 * 1024  // icons fit easily; leaves headroom for ~300 apps

function defaultPowershellExec(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout || '')
      },
    )
  })
}

// PS embeds the caller-supplied paths as single-quoted strings. PowerShell
// escapes a literal ' inside a '...' string by doubling it ('').
function psEscape(s) {
  return String(s).replace(/'/g, "''")
}

function buildWin32Script(exePaths) {
  const list = exePaths.map((p) => `'${psEscape(p)}'`).join(',')
  // Add-Type loads System.Drawing once. ExtractAssociatedIcon returns a 32×32
  // icon for most exes (the shell's default large-icon size), rendered as PNG
  // to a MemoryStream and base64-encoded. Failures per-path are caught so a
  // single broken exe doesn't abort the batch.
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$paths = @(${list})
$results = foreach ($p in $paths) {
  try {
    if (-not (Test-Path -LiteralPath $p)) { [PSCustomObject]@{ path = $p; icon = $null }; continue }
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
    if (-not $icon) { [PSCustomObject]@{ path = $p; icon = $null }; continue }
    $bmp = $icon.ToBitmap()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $bmp.Dispose(); $icon.Dispose(); $ms.Dispose()
    [PSCustomObject]@{ path = $p; icon = $b64 }
  } catch {
    [PSCustomObject]@{ path = $p; icon = $null }
  }
}
@($results) | ConvertTo-Json -Compress -Depth 2
`.trim()
}

function buildUwpScript(families) {
  const list = families.map((f) => `'${psEscape(f)}'`).join(',')
  // Get-AppxPackage is cached; filtering by PackageFamilyName avoids the
  // Name/Publisher split. The manifest's Square44x44Logo is a relative path
  // and often uses scale qualifiers at runtime (Calculator.scale-200.png
  // rather than Calculator.png), so we fall back to the largest sibling
  // file sharing the base name when the literal path isn't on disk.
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$wanted = @(${list})
$all = Get-AppxPackage
$byFamily = @{}
foreach ($p in $all) { $byFamily[$p.PackageFamilyName] = $p }
$results = foreach ($f in $wanted) {
  try {
    $pkg = $byFamily[$f]
    if (-not $pkg) { [PSCustomObject]@{ family = $f; icon = $null }; continue }
    $manifestPath = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
    if (-not (Test-Path -LiteralPath $manifestPath)) { [PSCustomObject]@{ family = $f; icon = $null }; continue }
    $xml = [xml](Get-Content -LiteralPath $manifestPath -Raw)
    $appNode = @($xml.Package.Applications.Application)[0]
    if (-not $appNode) { [PSCustomObject]@{ family = $f; icon = $null }; continue }
    $ve = $appNode.VisualElements
    $logoRel = $null
    if ($ve) { $logoRel = $ve.Square44x44Logo }
    if (-not $logoRel -and $ve) { $logoRel = $ve.Square150x150Logo }
    if (-not $logoRel) { [PSCustomObject]@{ family = $f; icon = $null }; continue }
    $logoPath = Join-Path $pkg.InstallLocation ($logoRel -replace '/', '\\')
    if (-not (Test-Path -LiteralPath $logoPath)) {
      $dir = Split-Path $logoPath
      $base = [IO.Path]::GetFileNameWithoutExtension($logoPath)
      $ext = [IO.Path]::GetExtension($logoPath)
      if (Test-Path -LiteralPath $dir) {
        $candidates = Get-ChildItem -LiteralPath $dir -Filter "$base*$ext" -ErrorAction SilentlyContinue
        if ($candidates) {
          $best = $candidates | Sort-Object Length -Descending | Select-Object -First 1
          if ($best) { $logoPath = $best.FullName }
        }
      }
    }
    if (Test-Path -LiteralPath $logoPath) {
      $bytes = [IO.File]::ReadAllBytes($logoPath)
      $b64 = [Convert]::ToBase64String($bytes)
      [PSCustomObject]@{ family = $f; icon = $b64 }
    } else {
      [PSCustomObject]@{ family = $f; icon = $null }
    }
  } catch {
    [PSCustomObject]@{ family = $f; icon = $null }
  }
}
@($results) | ConvertTo-Json -Compress -Depth 2
`.trim()
}

function parseRows(stdout, logger = console) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    if (typeof logger.warn === 'function') logger.warn('[icon-extractor] parse failed:', e.message)
    return []
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') return [parsed]
  return []
}

// Extract icons for a batch of Win32 exe paths. Returns a Map keyed by the
// original input path (case-preserved) → base64 PNG. Paths where extraction
// failed are omitted so `map.get(path)` returns undefined and the caller's
// `|| null` fallback kicks in.
async function extractWin32Icons(exePaths, { exec = defaultPowershellExec, logger = console } = {}) {
  const out = new Map()
  if (!Array.isArray(exePaths) || exePaths.length === 0) return out
  if (process.platform !== 'win32' && exec === defaultPowershellExec) return out
  const unique = Array.from(new Set(exePaths.filter((p) => typeof p === 'string' && p)))
  if (unique.length === 0) return out
  let stdout = ''
  try {
    stdout = await exec(buildWin32Script(unique))
  } catch (e) {
    if (typeof logger.warn === 'function') logger.warn('[icon-extractor] win32 extract failed:', e.message)
    return out
  }
  for (const row of parseRows(stdout, logger)) {
    if (row && typeof row.path === 'string' && row.icon) out.set(row.path, row.icon)
  }
  return out
}

// Extract icons for a batch of UWP PackageFamilyNames. Returns a Map keyed
// by family name → base64 PNG.
async function extractUwpIcons(families, { exec = defaultPowershellExec, logger = console } = {}) {
  const out = new Map()
  if (!Array.isArray(families) || families.length === 0) return out
  if (process.platform !== 'win32' && exec === defaultPowershellExec) return out
  const unique = Array.from(new Set(families.filter((f) => typeof f === 'string' && f)))
  if (unique.length === 0) return out
  let stdout = ''
  try {
    stdout = await exec(buildUwpScript(unique))
  } catch (e) {
    if (typeof logger.warn === 'function') logger.warn('[icon-extractor] uwp extract failed:', e.message)
    return out
  }
  for (const row of parseRows(stdout, logger)) {
    if (row && typeof row.family === 'string' && row.icon) out.set(row.family, row.icon)
  }
  return out
}

module.exports = {
  extractWin32Icons,
  extractUwpIcons,
  buildWin32Script,
  buildUwpScript,
  parseRows,
}
