import { createMachine } from '../dist/index.js'

const m = createMachine({
  name: 'deno-smoke',
  initialState: 's',
  states: { s: {} },
  events: {},
})

if (typeof m !== 'object' || m === null) {
  console.error('Deno smoke: createMachine returned non-object')
  Deno.exit(1)
}

console.log('Deno smoke: PASS')
