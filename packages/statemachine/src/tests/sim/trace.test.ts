import { describe, expect, it } from 'vitest'
import {
  type CanonicalHeader,
  type CanonicalTrace,
  configHash,
  hashTrace,
  normalizeParts,
  PRNG_VERSION,
  type TraceFrame,
} from '../../sim/trace'

function header(overrides: Partial<CanonicalHeader> = {}): CanonicalHeader {
  return {
    seed: '0',
    configHash: 'cfg0',
    engine: 'statemachine@1.0.0-beta.3',
    version: 'trace-v1',
    runtime: 'node-20',
    prngVersion: PRNG_VERSION,
    errorHandlerEnabled: true,
    ...overrides,
  }
}

function frame(overrides: Partial<TraceFrame> = {}): TraceFrame {
  return {
    step: 0,
    t: 0,
    cause: 'init',
    from: 'root',
    to: 'root',
    queue: { internal: 0, external: 0 },
    quiescent: true,
    ...overrides,
  }
}

describe('trace: closed-schema teeth (@ts-expect-error)', () => {
  it('rejects excluded wall-clock/heap/error fields on a TraceFrame literal', () => {
    const f: TraceFrame = {
      step: 0,
      t: 0,
      cause: 'init',
      from: 'a',
      to: 'a',
      queue: { internal: 0, external: 0 },
      quiescent: true,
      // @ts-expect-error duration is structurally excluded (content-only hash plane)
      duration: 5,
    }
    expect(f.step).toBe(0)

    const g: TraceFrame = {
      step: 1,
      t: 1,
      cause: 'external',
      from: 'a',
      to: 'b',
      queue: { internal: 0, external: 0 },
      quiescent: true,
      // @ts-expect-error timestamp is structurally excluded
      timestamp: 123,
    }
    expect(g.step).toBe(1)

    const h: TraceFrame = {
      step: 2,
      t: 2,
      cause: 'internal',
      from: 'a',
      to: 'b',
      queue: { internal: 0, external: 0 },
      quiescent: true,
      // @ts-expect-error errorCode is structurally excluded (errorClass enum only)
      errorCode: 'E_BOOM',
    }
    expect(h.step).toBe(2)

    const k: TraceFrame = {
      step: 3,
      t: 3,
      cause: 'timer',
      from: 'a',
      to: 'b',
      queue: { internal: 0, external: 0 },
      quiescent: true,
      // @ts-expect-error message is structurally excluded (kept only as fixtures)
      message: 'something failed',
    }
    expect(k.step).toBe(3)

    const m: TraceFrame = {
      step: 4,
      t: 4,
      cause: 'internal',
      from: 'a',
      to: 'b',
      queue: { internal: 0, external: 0 },
      quiescent: true,
      // @ts-expect-error heap is structurally excluded (perf plane only)
      heap: 1024,
    }
    expect(m.step).toBe(4)
  })

  it('rejects synthetic-only members as a cause value', () => {
    const f: TraceFrame = {
      step: 0,
      t: 0,
      // @ts-expect-error 'errorState-fallback' is a synthetic, never a cause
      cause: 'errorState-fallback',
      from: 'a',
      to: 'a',
      queue: { internal: 0, external: 0 },
      quiescent: true,
    }
    expect(f.step).toBe(0)

    const g: TraceFrame = {
      step: 1,
      t: 1,
      // @ts-expect-error 'corrupt-state' is a synthetic, never a cause
      cause: 'corrupt-state',
      from: 'a',
      to: 'a',
      queue: { internal: 0, external: 0 },
      quiescent: true,
    }
    expect(g.step).toBe(1)
  })

  it('synthetic IS a valid orthogonal discriminator', () => {
    const f = frame({ synthetic: 'corrupt-state' })
    expect(f.synthetic).toBe('corrupt-state')
    const g = frame({ synthetic: 'post-restore' })
    expect(g.synthetic).toBe('post-restore')
  })
})

describe("trace: '|'-normalization invariance + comparator lock", () => {
  it("normalizeParts('b|a|c') === 'a|b|c'", () => {
    expect(normalizeParts('b|a|c')).toBe('a|b|c')
  })

  it('normalizeParts handles >2 parts, mixed lengths, ≥2 region-part labels (non-degenerate)', () => {
    expect(normalizeParts('root.regionB.leafLong|root.regionA.x|root.regionC.mm')).toBe(
      'root.regionA.x|root.regionB.leafLong|root.regionC.mm',
    )
  })

  it('hashTrace of two traces whose from/to differ only by part order is EQUAL', () => {
    const t1: CanonicalTrace = {
      header: header(),
      frames: [frame({ step: 1, cause: 'external', from: normalizeParts('a|b|c'), to: normalizeParts('x|y') })],
    }
    const t2: CanonicalTrace = {
      header: header(),
      frames: [frame({ step: 1, cause: 'external', from: normalizeParts('c|b|a'), to: normalizeParts('y|x') })],
    }
    expect(hashTrace(t1)).toBe(hashTrace(t2))
  })

  it('locks the DEFAULT .sort() comparator (matches state_machine.ts:639), NOT locale', () => {
    // ['Z','a'] sorts to ['Z','a'] under default (code-point) but ['a','Z'] under locale.
    expect(normalizeParts('a|Z')).toBe('Z|a')
    // sanity: this is the byte-for-byte default array .sort() the engine uses
    expect('a|Z'.split('|').sort().join('|')).toBe('Z|a')
    // and it is DIFFERENT from a locale sort, proving no locale comparator leaked in
    const locale = 'a|Z'.split('|').sort((x, y) => x.localeCompare(y)).join('|')
    expect(locale).toBe('a|Z')
    expect(normalizeParts('a|Z')).not.toBe(locale)
  })
})

describe('trace: configHash structural toString-fold + createdAt-leak behavioral', () => {
  it('two configs whose function bodies are textually identical hash EQUAL (no createdAt leak)', () => {
    // Construct two configs where a JSON.stringify/toJSON path would bake a
    // differing createdAt:Date.now(). The structural walk folds only the
    // function BODY text, so they must hash equal.
    const makeConfig = () => ({
      name: 'm',
      guard: (o: { k: number }) => o.k % 7 === 3,
      action: (o: { log: number[] }) => {
        o.log.push(1)
      },
    })
    const a = makeConfig()
    const b = makeConfig()
    expect(configHash(a)).toBe(configHash(b))
  })

  it('a function-body change yields a DIFFERENT hash', () => {
    const a = { guard: (o: { k: number }) => o.k % 7 === 3 }
    const b = { guard: (o: { k: number }) => o.k % 7 === 4 }
    expect(configHash(a)).not.toBe(configHash(b))
  })

  it('does not collapse functions to undefined (a config with vs without a fn differ)', () => {
    const withFn = { x: 1, f: () => 0 }
    const withoutFn = { x: 1 }
    expect(configHash(withFn)).not.toBe(configHash(withoutFn))
  })

  it('key order does not affect the hash (objects key-sorted)', () => {
    const a = { a: 1, b: 2, f: (o: number) => o }
    const b = { f: (o: number) => o, b: 2, a: 1 }
    expect(configHash(a)).toBe(configHash(b))
  })

  it('handles cyclic structures without throwing', () => {
    const obj: Record<string, unknown> = { x: 1 }
    obj.self = obj
    expect(() => configHash(obj)).not.toThrow()
  })

  it('walks bigint / symbol / null / nested arrays distinctly', () => {
    const sym = Symbol('s')
    const a = { big: 10n, sym, nil: null, arr: [1, [2, 3], { z: 'q' }] }
    const b = { big: 10n, sym, nil: null, arr: [1, [2, 3], { z: 'q' }] }
    expect(configHash(a)).toBe(configHash(b))
    // a bigint value change is observed
    expect(configHash({ big: 11n })).not.toBe(configHash({ big: 10n }))
    // a nested array element change is observed
    expect(configHash({ arr: [1, [2, 3]] })).not.toBe(configHash({ arr: [1, [2, 4]] }))
    // null vs absent differ
    expect(configHash({ nil: null })).not.toBe(configHash({}))
  })

  it('walks primitive scalars (number/boolean/string/undefined) distinctly', () => {
    expect(configHash({ n: 1, b: true, s: 'x', u: undefined })).toBe(
      configHash({ n: 1, b: true, s: 'x', u: undefined }),
    )
    expect(configHash({ n: 1 })).not.toBe(configHash({ n: 2 }))
    expect(configHash({ b: true })).not.toBe(configHash({ b: false }))
  })

  it('configHash accepts a top-level primitive', () => {
    expect(configHash('hello')).toBe(configHash('hello'))
    expect(configHash(42)).not.toBe(configHash(43))
    expect(configHash(null)).toBe(configHash(null))
  })
})

describe('trace: hashTrace key-sort + header participation + prngVersion const', () => {
  it('PRNG_VERSION is the FROZEN tag', () => {
    expect(PRNG_VERSION).toBe('splitmix64-bigint-v1')
  })

  it('header.prngVersion is the frozen tag on a constructed header', () => {
    expect(header().prngVersion).toBe('splitmix64-bigint-v1')
  })

  it('mutating prngVersion CHANGES the hash (header fully participates)', () => {
    const base: CanonicalTrace = { header: header(), frames: [frame()] }
    const flipped: CanonicalTrace = {
      // cast through unknown only to construct an off-contract header for the test
      header: { ...header(), prngVersion: 'OTHER' } as unknown as CanonicalHeader,
      frames: [frame()],
    }
    expect(hashTrace(flipped)).not.toBe(hashTrace(base))
  })

  it('mutating runtime CHANGES the hash (header fully participates)', () => {
    const base: CanonicalTrace = { header: header(), frames: [frame()] }
    const other: CanonicalTrace = { header: header({ runtime: 'node-18' }), frames: [frame()] }
    expect(hashTrace(other)).not.toBe(hashTrace(base))
  })

  it('mutating seed / configHash / engine / version CHANGES the hash', () => {
    const base: CanonicalTrace = { header: header(), frames: [frame()] }
    expect(hashTrace({ header: header({ seed: '1' }), frames: [frame()] })).not.toBe(hashTrace(base))
    expect(hashTrace({ header: header({ configHash: 'cfg1' }), frames: [frame()] })).not.toBe(hashTrace(base))
    expect(hashTrace({ header: header({ engine: 'other' }), frames: [frame()] })).not.toBe(hashTrace(base))
    expect(hashTrace({ header: header({ version: 'trace-v2' }), frames: [frame()] })).not.toBe(hashTrace(base))
  })

  it('two identical traces hash EQUAL (deterministic, key-order-independent)', () => {
    const t1: CanonicalTrace = { header: header(), frames: [frame({ step: 1, cause: 'external', to: 'b' })] }
    const t2: CanonicalTrace = { header: header(), frames: [frame({ step: 1, cause: 'external', to: 'b' })] }
    expect(hashTrace(t1)).toBe(hashTrace(t2))
  })

  it('a frame-content change CHANGES the hash', () => {
    const base: CanonicalTrace = { header: header(), frames: [frame({ step: 1, to: 'b' })] }
    const changed: CanonicalTrace = { header: header(), frames: [frame({ step: 1, to: 'c' })] }
    expect(hashTrace(changed)).not.toBe(hashTrace(base))
  })

  it('hashes frames carrying doneDelta arrays + optional fields (array/nested-object/undefined-skip paths)', () => {
    const withDelta: CanonicalTrace = {
      header: header(),
      frames: [
        frame({
          step: 1,
          cause: 'timer',
          event: 'done.state.C',
          to: 'b',
          errorClass: 'transition-timeout',
          faultApplied: 'clock-skew',
          fireOutcome: 'reject',
          doneDelta: [
            { composite: 'C', done: true },
            { composite: 'D', done: false },
          ],
        }),
      ],
    }
    // deterministic + equal to an identically-shaped trace
    const same: CanonicalTrace = {
      header: header(),
      frames: [
        frame({
          step: 1,
          cause: 'timer',
          event: 'done.state.C',
          to: 'b',
          errorClass: 'transition-timeout',
          faultApplied: 'clock-skew',
          fireOutcome: 'reject',
          doneDelta: [
            { composite: 'C', done: true },
            { composite: 'D', done: false },
          ],
        }),
      ],
    }
    expect(hashTrace(withDelta)).toBe(hashTrace(same))
    // a doneDelta difference changes the hash
    const diff: CanonicalTrace = {
      header: header(),
      frames: [frame({ step: 1, cause: 'timer', to: 'b', doneDelta: [{ composite: 'C', done: false }] })],
    }
    expect(hashTrace(diff)).not.toBe(hashTrace(withDelta))
  })

  it('absent optional fields do not perturb the hash vs explicit-undefined-shaped frame', () => {
    const a: CanonicalTrace = { header: header(), frames: [frame({ step: 1 })] }
    // building a frame that omits the optionals must equal one where they are simply not present
    const b: CanonicalTrace = {
      header: header(),
      frames: [
        {
          step: 1,
          t: 0,
          cause: 'init',
          from: 'root',
          to: 'root',
          queue: { internal: 0, external: 0 },
          quiescent: true,
        },
      ],
    }
    expect(hashTrace(a)).toBe(hashTrace(b))
  })
})
