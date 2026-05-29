import { spawn } from 'child_process'
import readline from 'readline'

// Bright ANSI palette; bright red intentionally omitted so real errors
// stay visually loud against this background.
const PREFIX_COLORS = [
  '\x1b[1;32m',
  '\x1b[1;34m',
  '\x1b[1;33m',
  '\x1b[1;35m',
  '\x1b[1;36m',
  '\x1b[1;37m',
  '\x1b[1;92m',
  '\x1b[1;94m'
]
const RESET = '\x1b[0m'

const SIGKILL_GRACE_MS = 3000

const sameNodeAsParent = process.execPath

/**
 * Spawn N streamo relays and supervise them. Resolves only when every
 * child has exited — callers `await` this for the relay fleet's lifetime.
 *
 * Each config: { name, args, env?, staggerMs? }.
 * `staggerMs` waits that many ms BEFORE spawning this child, so the log
 * story reads deterministically — the substrate's retry-first-connect
 * handles arbitrary spawn order, but a fixed pattern keeps colored
 * output easy to follow.
 */
export async function runRelays (configs, { streamoBin = 'bin/streamo.js' } = {}) {
  const children = []
  const maxNameWidth = Math.max(...configs.map(c => c.name.length))

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]
    if (cfg.staggerMs) {
      await new Promise(r => setTimeout(r, cfg.staggerMs))
    }
    const color = PREFIX_COLORS[i % PREFIX_COLORS.length]
    const prefix = `${color}[${cfg.name.padEnd(maxNameWidth)}]${RESET}`

    console.log(`${prefix} spawning: node ${streamoBin} ${cfg.args.join(' ')}`)
    const child = spawn(sameNodeAsParent, [streamoBin, ...cfg.args], {
      env: { ...process.env, ...(cfg.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    forwardLinesWithPrefix(child.stdout, prefix, process.stdout)
    forwardLinesWithPrefix(child.stderr, prefix, process.stderr)

    child.on('exit', (code, signal) => {
      const suffix = signal ? `signal=${signal}` : `code=${code}`
      process.stdout.write(`${prefix} ${RESET}exited (${suffix})\n`)
    })

    children.push(child)
  }

  let shuttingDown = false
  const cleanup = () => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write('\nshutting down all relays…\n')
    for (const c of children) {
      try { c.kill('SIGINT') } catch {}
    }
    const sigkillFallback = setTimeout(() => {
      for (const c of children) {
        try { c.kill('SIGKILL') } catch {}
      }
      process.exit(0)
    }, SIGKILL_GRACE_MS)
    // .unref so the fallback timer doesn't itself keep the event loop
    // alive after the children exit cleanly under SIGINT. ?. defends
    // against environments whose timer handles lack unref.
    sigkillFallback.unref?.()
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  await Promise.all(children.map(c =>
    new Promise(resolve => c.on('exit', resolve))
  ))
}

// readline (not stream.on('data')): 'data' events deliver arbitrary byte
// chunks — a single log line can split across two events, or two lines
// can glue into one. readline buffers and emits at true line boundaries,
// so the colored prefix always lands at the start of each child line.
function forwardLinesWithPrefix (stream, prefix, out) {
  const rl = readline.createInterface({ input: stream, terminal: false })
  rl.on('line', line => {
    out.write(`${prefix} ${line}\n`)
  })
}
