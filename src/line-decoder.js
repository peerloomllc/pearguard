// src/line-decoder.js
//
// Buffers raw bytes across chunk boundaries and yields only COMPLETE
// newline-delimited lines, each decoded as UTF-8.
//
// Why this exists: the IPC and peer-connection streams used `buf += chunk.toString()`,
// which decodes every chunk independently. A multi-byte UTF-8 character split across
// two chunks (e.g. `é` = 0xC3 0xA9) is then decoded as two replacement characters
// BEFORE the string is assembled, corrupting the payload. For P2P messages that is
// worse than cosmetic: a mangled unicode `displayName`/`lockMessage` changes the bytes
// that were signed, so `verifyMessage` fails and the whole message is silently dropped.
//
// Decoding only whole lines is safe because the newline byte (0x0A) never appears
// inside a multi-byte UTF-8 sequence, so a line boundary is always a valid character
// boundary.

const b4a = require('b4a')

const NEWLINE = 0x0a

/**
 * Create a stateful decoder. Call the returned function with each incoming chunk
 * (a Buffer/Uint8Array, or defensively a string); it returns an array of the
 * complete lines that just became available (without their trailing newline).
 * Partial trailing bytes are retained until the rest of the line arrives.
 *
 * @returns {(chunk: (Uint8Array|string)) => string[]}
 */
function createLineDecoder () {
  let buf = b4a.alloc(0)
  return function push (chunk) {
    const bytes = typeof chunk === 'string' ? b4a.from(chunk, 'utf8') : chunk
    buf = b4a.concat([buf, bytes]) // concat always returns a fresh, owned buffer
    const lines = []
    let start = 0
    let nl
    while ((nl = b4a.indexOf(buf, NEWLINE, start)) !== -1) {
      lines.push(b4a.toString(buf.subarray(start, nl), 'utf8'))
      start = nl + 1
    }
    // Retain only the unconsumed tail (copied so we never alias the stream's buffer).
    buf = start === 0 ? buf : b4a.from(buf.subarray(start))
    return lines
  }
}

module.exports = { createLineDecoder }
