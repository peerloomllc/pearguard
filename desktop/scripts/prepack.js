#!/usr/bin/env node
// Copies cross-directory dependencies from pearguard/src/ and pearguard/assets/
// into desktop/vendor/ so the Windows tree is self-contained for electron-builder.
// Runs from postinstall (dev launch needs vendor/ populated) and from the build
// script (so dist always has fresh copies).
const fs = require('fs')
const path = require('path')
const https = require('https')
const { execSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '..', '..')
const srcDir = path.join(repoRoot, 'src')
const bundlePath = path.join(repoRoot, 'assets', 'app-ui.bundle')
const vendorDir = path.join(__dirname, '..', 'vendor')
const vendorSrc = path.join(vendorDir, 'src')
const activeWinDir = path.join(__dirname, '..', 'node_modules', 'active-win')

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

// Fetch a missing active-win prebuilt binding for a target platform. node-pre-gyp
// only downloads the binding for the host OS during npm install; cross-packaging
// for another platform would otherwise ship without the native .node, and
// active-win's binding loader falls back to a stub that returns undefined so
// the foreground monitor never records usage. Explicitly fetch the prebuilt
// for any target the build needs that isn't already present.
function ensureActiveWinBinding(triple) {
  const bindingDir = path.join(activeWinDir, 'lib', 'binding', `napi-6-${triple}`)
  const bindingFile = path.join(bindingDir, 'node-active-win.node')
  if (fs.existsSync(bindingFile)) return
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(activeWinDir, 'package.json'), 'utf8'))
    const version = pkg.version
    const url = `https://github.com/sindresorhus/active-win/releases/download/v${version}/napi-6-${triple}.tar.gz`
    ensureDir(bindingDir)
    const tmpTar = path.join(bindingDir, '..', `napi-6-${triple}-v${version}.tar.gz`)
    console.log(`[prepack] fetching active-win ${triple} binding ${version}`)
    execSync(`curl -fsSL "${url}" -o "${tmpTar}"`, { stdio: 'inherit' })
    execSync(`tar -xzf "${tmpTar}" -C "${path.dirname(bindingDir)}"`, { stdio: 'inherit' })
    fs.unlinkSync(tmpTar)
    if (!fs.existsSync(bindingFile)) {
      console.error(`[prepack] active-win ${triple} binding extraction did not produce node-active-win.node`)
      process.exit(1)
    }
    console.log(`[prepack] active-win ${triple} binding installed at ${path.relative(repoRoot, bindingFile)}`)
  } catch (e) {
    console.error(`[prepack] failed to fetch active-win ${triple} binding:`, e.message)
    process.exit(1)
  }
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
  // Linux uses xprop/xwininfo via execFile (no native binding loaded); only
  // Windows cross-binding has to be fetched explicitly when building from Linux.
  if (fs.existsSync(activeWinDir)) ensureActiveWinBinding('win32-unknown-x64')
  console.log(`[prepack] copied ${jsFiles.length} js files + app-ui.bundle into ${path.relative(repoRoot, vendorDir)}`)
}

main()
