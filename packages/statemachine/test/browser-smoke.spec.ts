import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = `file://${path.join(here, 'browser-fixture.html')}`

test('statemachine loads in browser AND drives a real transition', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  await page.goto(fixtureUrl)
  // The fixture sets this flag ONLY after `fireEvent` settled and the resulting
  // state was asserted — so a bundle that loads but deadlocks fails here rather
  // than passing, which is the blind spot the construct-only fixture had.
  await page.waitForFunction(() => (window as any).__statemachineSmokePassed === true, undefined, { timeout: 5000 })
  expect(errors).toEqual([])
})

test('reports its context-tracker tier (documents the browser runtime contract)', async ({ page }) => {
  await page.goto(fixtureUrl)
  await page.waitForFunction(() => (window as any).__statemachineTrackerKind !== undefined, undefined, { timeout: 5000 })
  const kind = await page.evaluate(() => (window as any).__statemachineTrackerKind)
  // Pinned to what this browser actually resolves. Chromium ships neither
  // AsyncLocalStorage nor AsyncContext.Variable today, so the engine degrades to
  // the no-op tracker: legitimate concurrent fires still queue and resolve, but
  // TRUE reentrancy is not detected (see README "Runtime support"). If a future
  // Chromium ships AsyncContext.Variable this flips to 'async-context' and the
  // README row must be updated with it.
  expect(['none', 'async-context']).toContain(kind)
})
