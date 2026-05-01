#!/usr/bin/env node
/**
 * Serve public/ as a static site.
 * Usage: node scripts/serve.js [port]
 */
import express from 'express'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const port = Number(process.argv[2] ?? process.env.PORT ?? 3000)
const root = join(dirname(fileURLToPath(import.meta.url)), '../public')

const app = express()
app.use(express.static(root))
app.listen(port, () => console.log(`http://localhost:${port}`))
