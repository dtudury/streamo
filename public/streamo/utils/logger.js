/**
 * @file logger — leveled logging primitive, ported from turtb's
 * `lib/utils/logger.js`. A line is logged when its level number is
 * `<=` the current global level number. Default INFO (0): you see
 * fatal/error/warn/info but not debug/trace/silly.
 *
 * Callers can pass either values or a thunk; the thunk is only
 * invoked when the line will be logged, so expensive formatting
 * (e.g. ANSI-colored turtle blocks) is free at lower verbosity.
 *
 *   logInfo('streamo up')
 *   logTrace(() => `chunk bytes=${expensiveCount()}`)
 *
 * Level can be set from env (`STREAMO_LOG_LEVEL=trace`), CLI
 * (`--verbose trace` in bin/streamo.js), or programmatically via
 * `setLogLevel(TRACE)`.
 */

export const OFF   = Number.NEGATIVE_INFINITY
export const FATAL = -3
export const ERROR = -2
export const WARN  = -1
export const INFO  = 0
export const DEBUG = 1
export const TRACE = 2
export const SILLY = 3
export const ALL   = Number.POSITIVE_INFINITY

const NAME_TO_LEVEL = {
  off: OFF, fatal: FATAL, error: ERROR, warn: WARN, info: INFO,
  debug: DEBUG, trace: TRACE, silly: SILLY, all: ALL
}

/** Coerce a string ('debug'), number (1), or boolean (true → DEBUG) to a numeric level. */
export function parseLevel (v) {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? DEBUG : OFF
  if (typeof v === 'string') {
    const key = v.trim().toLowerCase()
    if (key in NAME_TO_LEVEL) return NAME_TO_LEVEL[key]
    const n = Number(key)
    if (!Number.isNaN(n)) return n
  }
  return INFO
}

function envDefault () {
  const env = globalThis.process?.env ?? {}
  if (env.STREAMO_LOG_LEVEL != null) return parseLevel(env.STREAMO_LOG_LEVEL)
  const argv = globalThis.process?.argv ?? []
  if (argv.includes('--test') || env.NODE_TEST_CONTEXT) return WARN
  return INFO
}

let currentLevel = envDefault()
export const getLogLevel = () => currentLevel
export const setLogLevel = level => { currentLevel = parseLevel(level) }

export function log (level, ...args) {
  if (level > currentLevel) return
  if (args.length === 1 && typeof args[0] === 'function') {
    const result = args[0]()
    if (result !== undefined) console.log(result)
  } else {
    console.log(...args)
  }
}

export const logFatal = (...args) => log(FATAL, ...args)
export const logError = (...args) => log(ERROR, ...args)
export const logWarn  = (...args) => log(WARN,  ...args)
export const logInfo  = (...args) => log(INFO,  ...args)
export const logDebug = (...args) => log(DEBUG, ...args)
export const logTrace = (...args) => log(TRACE, ...args)
export const logSilly = (...args) => log(SILLY, ...args)
