// Polyfill for Node 18 — metro-config uses Array.prototype.toReversed (Node 20.3+)
if (!Array.prototype.toReversed) {
  Array.prototype.toReversed = function() { return [...this].reverse() }
}

const { getDefaultConfig } = require('expo/metro-config')
const config = getDefaultConfig(__dirname)
config.resolver.assetExts.push('bundle')
module.exports = config
