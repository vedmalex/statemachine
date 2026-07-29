/**
 * @module tests/raw_owner_diagnostic — W8/V10.
 *
 * A non-Adapter 2nd positional to `fireEvent` is an EVENT ARGUMENT by design
 * (that is what makes `fireEvent(event, arg1, arg2)` work), so a multi-owner
 * caller passing a RAW object gets it treated as a payload while the event
 * resolves against the PRIMARY owner — historically failing with a baffling
 * "Invalid event: X for state: Y" that names a state their object was never in.
 * The engine now says so explicitly. The SEMANTICS are unchanged (fixing them
 * would break payload passing); only the diagnostic is new.
 */
import { describe, expect, it } from 'vitest'
import { MemoryAdapter, StateMachine, type ILogger, type StateMachineConfig } from '../index'

type Box = { state: string; [k: string]: unknown }

const cfg: StateMachineConfig<Box> = {
  name: 'multiOwner',
  stateAttribute: 'state',
  initialState: 'idle',
  states: { idle: {}, active: {} },
  events: { go: { transitions: [{ from: 'idle', to: 'active' }] } },
}

function collectingLogger(): { logger: ILogger; warnings: string[] } {
  const warnings: string[] = []
  const logger: ILogger = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => { warnings.push(m) },
    error: () => {},
  }
  return { logger, warnings }
}

describe('W8/V10 — raw-object second owner is diagnosed, not silently misread', () => {
  it('warns that a RAW object carrying the stateAttribute is taken as an ARGUMENT, naming the fix', async () => {
    const { logger, warnings } = collectingLogger()
    const primary: Box = { state: 'idle' }
    const sm = new StateMachine<Box, typeof cfg>(cfg, primary, { logger })
    await Promise.resolve()
    await sm.fireEvent('go', primary) // primary → active
    await sm.fireEvent('go', { state: 'idle' } as never).catch(() => {})
    const hit = warnings.find((w) => w.includes('RAW object'))
    expect(hit).toBeDefined()
    expect(hit).toContain('MemoryAdapter') // the actionable fix is named
  })

  it('stays SILENT for a legitimate payload that does not carry the stateAttribute', async () => {
    const { logger, warnings } = collectingLogger()
    const primary: Box = { state: 'idle' }
    const sm = new StateMachine<Box, typeof cfg>(cfg, primary, { logger })
    await Promise.resolve()
    await sm.fireEvent('go', { verdict: 'ok' } as never).catch(() => {})
    expect(warnings.filter((w) => w.includes('RAW object'))).toHaveLength(0)
  })

  it('the documented multi-owner form (an explicit Adapter) works and warns nothing', async () => {
    const { logger, warnings } = collectingLogger()
    const primary: Box = { state: 'idle' }
    const sm = new StateMachine<Box, typeof cfg>(cfg, primary, { logger })
    await Promise.resolve()
    await sm.fireEvent('go', primary)
    const second = new MemoryAdapter<Box>({ state: 'idle' })
    await sm.fireEvent('go', second)
    expect(second.get('state')).toBe('active')
    expect(primary.state).toBe('active')
    expect(warnings.filter((w) => w.includes('RAW object'))).toHaveLength(0)
  })
})

describe('W9/Г4 — the *For family: multi-owner without ceremony or ambiguity', () => {
  it('drives TWO raw objects independently (owner-first slot, no MemoryAdapter needed)', async () => {
    const a: Box = { state: 'idle' }
    const b: Box = { state: 'idle' }
    const sm = new StateMachine<Box, typeof cfg>(cfg, a)
    await Promise.resolve()
    await sm.fireEventFor(a, 'go')
    expect(a.state).toBe('active')
    expect(b.state).toBe('idle') // untouched
    await sm.fireEventFor(b, 'go')
    expect(b.state).toBe('active')
  })

  it('emits NO raw-owner warning (the ambiguity is gone structurally)', async () => {
    const { logger, warnings } = collectingLogger()
    const a: Box = { state: 'idle' }
    const sm = new StateMachine<Box, typeof cfg>(cfg, a, { logger })
    await Promise.resolve()
    await sm.fireEventFor({ state: 'idle' } as Box, 'go')
    expect(warnings.filter((w) => w.includes('RAW object'))).toHaveLength(0)
  })

  it('args land as ARGUMENTS, never confused with the owner', async () => {
    const seen: unknown[] = []
    const withArgs: StateMachineConfig<Box> = {
      name: 'withArgs',
      stateAttribute: 'state',
      initialState: 'idle',
      states: { idle: {}, active: {} },
      events: {
        go: { transitions: [{ from: 'idle', to: 'active', action: (_o: Box, ...rest: unknown[]) => { seen.push(...rest) } }] },
      },
    }
    const owner: Box = { state: 'idle' }
    const sm = new StateMachine<Box, typeof withArgs>(withArgs, owner)
    await Promise.resolve()
    await sm.fireEventFor(owner, 'go', { verdict: 'ok' }, 42)
    expect(seen).toEqual([{ verdict: 'ok' }, 42])
  })

  it('canFireEventFor / getAvailableEventsFor answer PER OWNER', async () => {
    const a: Box = { state: 'idle' }
    const b: Box = { state: 'idle' }
    const sm = new StateMachine<Box, typeof cfg>(cfg, a)
    await Promise.resolve()
    await sm.fireEventFor(a, 'go') // a → active, b stays idle
    expect(sm.canFireEventFor(a, 'go')).toBe(false) // no transition out of active
    expect(sm.canFireEventFor(b, 'go')).toBe(true)
    expect(sm.getAvailableEventsFor(b)).toContain('go')
    expect(sm.getAvailableEventsFor(a)).not.toContain('go')
  })

  it('the same raw owner resolves to the SAME cached adapter (per-owner state is stable)', async () => {
    const a: Box = { state: 'idle' }
    const b: Box = { state: 'idle' }
    const sm = new StateMachine<Box, typeof cfg>(cfg, a)
    await Promise.resolve()
    // Two calls for b must share one adapter, otherwise b's own state/timers would
    // be split across adapters and the second call would read a stale state.
    expect(sm.canFireEventFor(b, 'go')).toBe(true)
    await sm.fireEventFor(b, 'go')
    expect(b.state).toBe('active')
    expect(sm.canFireEventFor(b, 'go')).toBe(false)
  })
})
