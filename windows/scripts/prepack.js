#!/usr/bin/env node
// Copies cross-directory dependencies from pearguard/src/ and pearguard/assets/
// into windows/vendor/ so the Windows tree is self-contained for electron-builder.
// Runs from postinstall (dev launch needs vendor/ populated) and from the build
// script (so dist always has fresh copies).
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const srcDir = path.join(repoRoot, 'src')
const bundlePath = path.join(repoRoot, 'assets', 'app-ui.bundle')
const vendorDir = path.join(__dirname, '..', 'vendor')
const vendorSrc = path.join(vendorDir, 'src')

const EXCLUDE = new Set(['policy.test.js'])

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyFile(from, to) {
  ensureDir(path.dirname(to))
  fs.copyFileSync(from, to)
}

function copyTopLevelJs() {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  const copied = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.js')) continue
    if (EXCLUDE.has(entry.name)) continue
    const from = path.join(srcDir, entry.name)
    const to = path.join(vendorSrc, entry.name)
    copyFile(from, to)
    copied.push(entry.name)
  }
  return copied
}

function main() {
  if (!fs.existsSync(srcDir)) {
    console.error(`[prepack] missing src dir: ${srcDir}`)
    process.exit(1)
  }
  if (!fs.existsSync(bundlePath)) {
    console.error(`[prepack] missing UI bundle: ${bundlePath} (run npm run build:ui in repo root)`)
    process.exit(1)
  }
  ensureDir(vendorSrc)
  const jsFiles = copyTopLevelJs()
  copyFile(bundlePath, path.join(vendorDir, 'app-ui.bundle'))
  console.log(`[prepack] copied ${jsFiles.length} js files + app-ui.bundle into ${path.relative(repoRoot, vendorDir)}`)
}

main()
