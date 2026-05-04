'use strict'

const fs = require('node:fs')
const path = require('node:path')

const required = [
  'dist/index.js',
  'dist/index.cjs',
  'types/index.d.ts',
]

const root = path.resolve(__dirname, '..')
let failed = false

for (const rel of required) {
  const abs = path.join(root, rel)
  try {
    fs.accessSync(abs, fs.constants.F_OK)
    const stats = fs.statSync(abs)
    if (!stats.isFile() || stats.size === 0) {
      console.error(`✗ ${rel} present but empty`)
      failed = true
      continue
    }
    console.log(`✓ ${rel} (${stats.size} bytes)`)
  } catch (err) {
    console.error(`✗ ${rel} missing: ${err.message}`)
    failed = true
  }
}

if (failed) {
  process.exit(1)
}
