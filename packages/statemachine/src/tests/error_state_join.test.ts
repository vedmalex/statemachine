/**
 * @module tests/error_state_join — W9.
 *
 * The `errorState` (zombie-state prevention) recovery commits a configuration
 * just like the success path does, but it used to skip `checkCompletion`. When
 * the recovery configuration is itself ALL-FINAL — `errorState` pointing at a
 * region's final leaf while the sibling regions are already final — the engine
 * reported `isDone(C) === true` while NEVER raising `done.state.<C>`, so a
 * consumer's completion handler silently never ran.
 *
 * Found while giving the I-5 oracle real teeth: the oracle's own predicate would
 * have flagged this configuration as a genuine "became done without a raise",
 * which is exactly the class it exists to catch — so this is an ENGINE fix, not
 * an oracle exception.
 */
import { describe, expect, it } from 'vitest'
import { StateMachine } from '../index'

const cfg = {
  name: 'errJoin',
  stateAttribute: 'state',
  initialState: 'P',
  states: {
    P: {
      initial: 'r1.idle|r2.done',
      regions: {
        r1: { idle: {}, work: { onEnter: () => { throw new Error('boom') } }, done: { final: true } },
        r2: { done: { final: true } },
      },
    },
    after: {},
  },
  events: {
    go: { transitions: [{ from: 'P.r1.idle', to: 'P.r1.work' }] },
    'done.state.P': { transitions: [{ from: 'P', to: 'after' }] },
  },
} as never

describe('W9 — errorState recovery into an ALL-FINAL configuration raises the join', () => {
  it('reaches the join target instead of silently sitting in a done-but-unannounced config', async () => {
    const owner = { state: 'P' } as never
    const sm = new StateMachine(cfg, owner, { errorState: 'P.r1.done' } as never)
    await new Promise((r) => setTimeout(r, 20))
    expect(sm.getCurrentState()).toBe('P.r1.idle|P.r2.done')

    // The transition's onEnter throws → recovery commits `P.r1.done`, which makes
    // P all-final. Pre-fix the machine stopped there with the join never raised.
    await sm.fireEvent('go' as never).catch(() => {})
    await new Promise((r) => setTimeout(r, 20))

    expect(sm.getCurrentState()).toBe('after')
  })

  it('a recovery that does NOT complete the composite raises nothing (edge-triggered, no spurious join)', async () => {
    const partial = {
      ...(cfg as unknown as Record<string, unknown>),
      states: {
        P: {
          initial: 'r1.idle|r2.idle',
          regions: {
            r1: { idle: {}, work: { onEnter: () => { throw new Error('boom') } }, done: { final: true } },
            r2: { idle: {}, done: { final: true } }, // r2 NOT final → P cannot be done
          },
        },
        after: {},
      },
    } as never
    const owner = { state: 'P' } as never
    const sm = new StateMachine(partial, owner, { errorState: 'P.r1.done' } as never)
    await new Promise((r) => setTimeout(r, 20))
    await sm.fireEvent('go' as never).catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    // Recovered into r1.done, but r2 is still idle → no join, machine stays in P.
    expect(sm.getCurrentState()).toBe('P.r1.done|P.r2.idle')
    expect(sm.isDone('P' as never)).toBe(false)
  })
})
