// Spawn N streamo relays as child processes, prefix each one's stdout/stderr
// with a colored tag, and stream the combined output to this terminal.
//
// Used by the demo scripts (demo-relays-3.js, etc.) to launch a coordinated
// set of relays where you can see which line came from which relay in real
// time. SIGINT shuts them all down cleanly.

import { spawn } from 'child_process'
import readline from 'readline'

// Bright ANSI palette — distinct enough at a glance, avoids bright red so
// real errors stay visually loud.
const COLORS = [
  '\x1b[1;32m', // bright green
  '\x1b[1;34m', // bright blue
  '\x1b[1;33m', // bright yellow
  '\x1b[1;35m', // bright magenta
  '\x1b[1;36m', // bright cyan
  '\x1b[1;37m', // bright white
  '\x1b[1;92m', // bright green (alt)
  '\x1b[1;94m'  // bright blue (alt)
]
const RESET = '\x1b[0m'

/**
 * Spawn a collection of streamo relays, each with its own colored stdout
 * prefix, and pipe their combined output to this process's stdout/stderr.
 * Resolves when all children exit; rejects only if a spawn fails outright.
 *
 * @param {Array<{
 *   name: string,            // short tag shown in log prefix (e.g. 'library')
 *   args: string[],          // CLI args passed to bin/streamo.js
 *   env?: Record<string,string>,    // optional env overrides for this child
 *   startupDelayMs?: number  // delay BEFORE spawning this relay (sequencing)
 * }>} configs
 * @param {object} [options]
 * @param {string} [options.streamoBin='bin/streamo.js']  path to the entry script
 * @returns {Promise<void>}
 */
export async function runRelays (configs, { streamoBin = 'bin/streamo.js' } = {}) {
  const children = []
  const maxNameWidth = Math.max(...configs.map(c => c.name.length))

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]
    if (cfg.startupDelayMs) {
      await new Promise(r => setTimeout(r, cfg.startupDelayMs))
    }
    const color = COLORS[i % COLORS.length]
    const prefix = `${color}[${cfg.name.padEnd(maxNameWidth)}]${RESET}`

    console.log(`${prefix} spawning: node ${streamoBin} ${cfg.args.join(' ')}`)
    const child = spawn(process.execPath, [streamoBin, ...cfg.args], {
      env: { ...process.env, ...(cfg.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    prefixLines(child.stdout, prefix, process.stdout)
    prefixLines(child.stderr, prefix, process.stderr)

    child.on('exit', (code, signal) => {
      const suffix = signal ? `signal=${signal}` : `code=${code}`
      process.stdout.write(`${prefix} ${RESET}exited (${suffix})\n`)
    })

    children.push(child)
  }

  // Clean shutdown on SIGINT — send SIGINT to all children, then SIGKILL
  // anything still alive after a grace period.
  let shuttingDown = false
  const cleanup = () => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write('\nshutting down all relays…\n')
    for (const c of children) {
      try { c.kill('SIGINT') } catch {}
    }
    setTimeout(() => {
      for (const c of children) {
        try { c.kill('SIGKILL') } catch {}
      }
      process.exit(0)
    }, 3000).unref?.()
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  // Resolve when every child has exited.
  await Promise.all(children.map(c =>
    new Promise(resolve => c.on('exit', resolve))
  ))
}

/**
 * Read line-by-line from a child stream and emit each line prefixed with
 * the relay's colored tag. Using readline avoids partial-line splits.
 */
function prefixLines (stream, prefix, out) {
  const rl = readline.createInterface({ input: stream, terminal: false })
  rl.on('line', line => {
    out.write(`${prefix} ${line}\n`)
  })
}
