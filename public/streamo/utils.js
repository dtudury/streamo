export function arraysEqual (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const cryptoSubtle = typeof crypto !== 'undefined' ? crypto.subtle : (await import('crypto')).webcrypto.subtle

export async function sha256 (bytes) {
  return new Uint8Array(await cryptoSubtle.digest('SHA-256', bytes))
}

export async function chainHashOf (prev, newBytes) {
  const newBytesHash = await sha256(newBytes)
  const combined = new Uint8Array(64)
  combined.set(prev, 0)
  combined.set(newBytesHash, 32)
  return await sha256(combined)
}

export function bytesToHex (bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes (hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export function numberToVar (n) {
  if (n < 0) throw new Error('n must be non-negative')
  if (!n) return new Uint8Array([0])
  const bytes = []
  while (n) {
    bytes.push(n & 0xff)
    n >>>= 8
  }
  return new Uint8Array(bytes)
}

export function varToNumber (bytes) {
  let n = 0
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n * 256 + bytes[i]) >>> 0
  }
  return n
}

export function range (length) {
  return Array.from({ length }, (_, i) => i)
}

export function parseOrigin (hostPort) {
  if (/^wss?:\/\//.test(hostPort)) {
    const url = new URL(hostPort)
    const protocol = url.protocol === 'wss:' ? 'wss' : 'ws'
    const port = +(url.port || (protocol === 'wss' ? 443 : 80))
    return { host: url.hostname, port, protocol }
  }
  const [host, portStr] = hostPort.split(':')
  const explicitPort = portStr ? +portStr : null
  const browserProtocol = globalThis.location?.protocol
  let protocol
  if (browserProtocol === 'https:') protocol = 'wss'
  else if (browserProtocol === 'http:') protocol = 'ws'
  else protocol = (explicitPort == null || explicitPort === 443) ? 'wss' : 'ws'
  const port = explicitPort ?? (protocol === 'wss' ? 443 : 80)
  return { host, port, protocol }
}
