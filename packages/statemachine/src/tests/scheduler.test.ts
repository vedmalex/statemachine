import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { TimerScheduler } from '../scheduler'

// TASK-004: use direct instantiation instead of TimerScheduler.getInstance()
// Each test gets its own scheduler instance to avoid cross-test interference.

describe('TimerScheduler', () => {
  let scheduler: TimerScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    scheduler = new TimerScheduler()
  })

  afterEach(() => {
    scheduler.stop()
    scheduler.clear()
    vi.useRealTimers()
  })

  it('should execute task after delay', () => {
    const callback = vi.fn()

    scheduler.schedule(100, callback)

    // Should not execute immediately
    scheduler.process(Date.now())
    expect(callback).not.toHaveBeenCalled()

    // Advance time
    vi.advanceTimersByTime(100)

    // Process manually
    scheduler.process(Date.now())
    expect(callback).toHaveBeenCalled()
  })

  it('should handle multiple tasks in order', () => {
    const calls: string[] = []

    scheduler.schedule(200, () => calls.push('second'))
    scheduler.schedule(100, () => calls.push('first'))
    scheduler.schedule(300, () => calls.push('third'))

    vi.advanceTimersByTime(150)
    scheduler.process(Date.now())
    expect(calls).toEqual(['first'])

    vi.advanceTimersByTime(100) // Total 250
    scheduler.process(Date.now())
    expect(calls).toEqual(['first', 'second'])

    vi.advanceTimersByTime(100) // Total 350
    scheduler.process(Date.now())
    expect(calls).toEqual(['first', 'second', 'third'])
  })

  it('should cancel tasks', () => {
    const callback = vi.fn()

    const token = scheduler.schedule(100, callback)
    scheduler.cancel(token)

    vi.advanceTimersByTime(200)
    scheduler.process(Date.now())

    expect(callback).not.toHaveBeenCalled()
  })

  it('should work with auto-polling', () => {
    const callback = vi.fn()

    // Enable polling every 50ms
    scheduler.setPollingInterval(50)
    scheduler.schedule(100, callback)

    // Advance time enough for polling to trigger and task to be due
    vi.advanceTimersByTime(150)

    expect(callback).toHaveBeenCalled()
  })
})
