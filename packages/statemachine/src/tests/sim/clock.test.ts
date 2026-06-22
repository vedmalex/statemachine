import { describe, expect, it } from 'vitest'
import type { Clock } from '../../index'
import { makeSimClock } from '../../sim/clock'
import { SimError } from '../../sim/prng'

describe('clock: monotonic SimClock', () => {
  it('makeSimClock(0): now()===0', () => {
    const c = makeSimClock(0)
    expect(c.now()).toBe(0)
    expect(c.t).toBe(0)
  })

  it('default start is 0', () => {
    const c = makeSimClock()
    expect(c.now()).toBe(0)
  })

  it('set(100) -> now()===100, t===100', () => {
    const c = makeSimClock(0)
    c.set(100)
    expect(c.now()).toBe(100)
    expect(c.t).toBe(100)
  })

  it('forward and stay-put are allowed', () => {
    const c = makeSimClock(10)
    c.set(10) // stay-put
    expect(c.now()).toBe(10)
    c.set(20)
    expect(c.now()).toBe(20)
  })

  it('backward set(50) after set(100) THROWS SimError', () => {
    const c = makeSimClock(0)
    c.set(100)
    expect(() => c.set(50)).toThrow(SimError)
    // time unchanged after the failed backward set
    expect(c.now()).toBe(100)
  })

  it('non-finite set / start throws SimError', () => {
    expect(() => makeSimClock(Number.NaN)).toThrow(SimError)
    expect(() => makeSimClock(Number.POSITIVE_INFINITY)).toThrow(SimError)
    const c = makeSimClock(0)
    expect(() => c.set(Number.NaN)).toThrow(SimError)
    expect(() => c.set(Number.POSITIVE_INFINITY)).toThrow(SimError)
  })
})

describe('clock: Clock assignability (engine seam)', () => {
  it('clk.now is assignable to the engine Clock = () => number', () => {
    const clk = makeSimClock(5)
    const c: Clock = clk.now
    expect(c()).toBe(5)
    clk.set(7)
    // the bound now() reflects the current logical time
    expect(c()).toBe(7)
  })
})
