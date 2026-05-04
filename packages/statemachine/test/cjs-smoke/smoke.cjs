'use strict'

const path = require('node:path')

// Import the freshly-built CJS dist via require (the actual F-CR-7 closure target).
// This verifies the published dist/index.cjs file works as a CommonJS module.
const distCjsPath = path.resolve(__dirname, '..', '..', 'dist', 'index.cjs')
const pkg = require(distCjsPath)

try {
  if (typeof pkg.createMachine !== 'function') {
    throw new Error('createMachine is not a function')
  }
  if (typeof pkg.StateMachine !== 'function') {
    throw new Error('StateMachine is not a class')
  }

  const m = pkg.createMachine({
    name: 'cjs-smoke',
    initialState: 's',
    states: { s: {} },
    events: {},
  })
  if (typeof m !== 'object' || m === null) {
    throw new Error('createMachine returned non-object')
  }

  console.log('CJS smoke: PASS (dist/index.cjs require)')
} catch (err) {
  console.error('CJS smoke: FAIL —', err.message)
  process.exit(1)
}
