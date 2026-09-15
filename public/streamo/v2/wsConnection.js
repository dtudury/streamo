import { WebSocket } from 'ws'

export function wsConnection (ws) {
  return {
    send (data) { ws.send(data) },
    on (event, fn) {
      if (event === 'message') {
        ws.on('message', (data, isBinary) => fn(isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString()))
      } else if (event === 'close') {
        ws.on('close', () => fn())
      }
    },
    close () { ws.close() }
  }
}

export function connectWs (url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(wsConnection(ws)))
    ws.once('error', reject)
  })
}
