import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from 'bun:test'
import { TimerScheduler } from '../scheduler'

describe('TimerScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    TimerScheduler.getInstance().clear()
    TimerScheduler.getInstance().stop()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should execute task after delay', () => {
    const scheduler = TimerScheduler.getInstance()
    const callback = jest.fn()

    scheduler.schedule(100, callback)

    // Should not execute immediately
    scheduler.process(Date.now())
    expect(callback).not.toHaveBeenCalled()

    // Advance time
    jest.advanceTimersByTime(100)

    // Process manually
    scheduler.process(Date.now())
    expect(callback).toHaveBeenCalled()
  })

  it('should handle multiple tasks in order', () => {
    const scheduler = TimerScheduler.getInstance()
    const calls: string[] = []

    scheduler.schedule(200, () => calls.push('second'))
    scheduler.schedule(100, () => calls.push('first'))
    scheduler.schedule(300, () => calls.push('third'))

    jest.advanceTimersByTime(150)
    scheduler.process(Date.now())
    expect(calls).toEqual(['first'])

    jest.advanceTimersByTime(100) // Total 250
    scheduler.process(Date.now())
    expect(calls).toEqual(['first', 'second'])

    jest.advanceTimersByTime(100) // Total 350
    scheduler.process(Date.now())
    expect(calls).toEqual(['first', 'second', 'third'])
  })

  it('should cancel tasks', () => {
    const scheduler = TimerScheduler.getInstance()
    const callback = jest.fn()

    const token = scheduler.schedule(100, callback)
    scheduler.cancel(token)

    jest.advanceTimersByTime(200)
    scheduler.process(Date.now())

    expect(callback).not.toHaveBeenCalled()
  })

  it('should work with auto-polling', () => {
    const scheduler = TimerScheduler.getInstance()
    const callback = jest.fn()

    // Enable polling every 50ms
    scheduler.setPollingInterval(50)
    scheduler.schedule(100, callback)

    // Advance time enough for polling to trigger and task to be due
    jest.advanceTimersByTime(150)

    expect(callback).toHaveBeenCalled()
  })
})
