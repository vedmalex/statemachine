import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureUrl = `file://${path.join(here, 'browser-fixture.html')}`

test('statemachine loads in browser without errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  await page.goto(fixtureUrl)
  await page.waitForFunction(() => (window as any).__statemachineSmokePassed === true, undefined, { timeout: 5000 })
  expect(errors).toEqual([])
})
