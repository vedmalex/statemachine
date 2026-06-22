/**
 * @module tests/sim/capabilities_totality
 *
 * Step-9 ADR-8 totality teeth + key-set snapshot drift (DoD 1/2/3/8).
 *
 * Proves the closed-union {@link CapabilityId} + total `Record` contract:
 *  - every literal has exactly one entry with non-empty `engineRefs` + a probe;
 *  - a Record literal MISSING one id is a `tsc` error (the `@ts-expect-error` teeth
 *    — removing an entry makes the build fail, exactly DoD #2);
 *  - the committed `etc/sim-capabilities.txt` equals the sorted live key-set.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  type Capability,
  type CapabilityId,
  capabilityKeys,
} from '../../sim/capabilities'

describe('capabilities: closed-union totality (DoD 1/3)', () => {
  it('every CapabilityId has exactly one entry whose id matches its key', () => {
    for (const key of capabilityKeys()) {
      const cap = CAPABILITIES[key]
      expect(cap, `missing entry for ${key}`).toBeDefined()
      expect(cap.id, `entry under key ${key} has mismatched id`).toBe(key)
    }
  })

  it('every entry has non-empty engineRefs and a pure probe function', () => {
    for (const key of capabilityKeys()) {
      const cap = CAPABILITIES[key]
      expect(cap.engineRefs.length, `${key} has empty engineRefs`).toBeGreaterThan(0)
      expect(typeof cap.probe, `${key} has no probe`).toBe('function')
      // engineRefs are file:line citations.
      for (const ref of cap.engineRefs) {
        expect(ref, `${key} engineRef not a file:line citation`).toMatch(/\.ts:\d+/)
      }
    }
  })

  it('the registry has exactly 39 literals (one per design §6 row)', () => {
    expect(capabilityKeys()).toHaveLength(39)
  })
})

describe('capabilities: total-Record teeth — a missing entry fails tsc (DoD 2)', () => {
  it('an over-narrow partial Record is a compile error (@ts-expect-error)', () => {
    // The teeth: a Record<CapabilityId, …> literal that OMITS even ONE id is a
    // `tsc --noEmit` error ("Property '<id>' is missing"). The @ts-expect-error
    // below MUST stay flagged: if the union ever loses a member (so this partial
    // becomes total) OR the Record stops being keyed by the closed union, the
    // directive turns into an "unused @ts-expect-error" error and this test breaks
    // — which is the failure DoD #2 demands.
    // @ts-expect-error — omitting any CapabilityId key makes this Record non-total.
    const broken: Record<CapabilityId, number> = {
      'event.fire.external': 1,
    }
    // touch it so it is not dead code; the assertion value is irrelevant — the
    // load-bearing check is the compile error above.
    expect(Object.keys(broken).length).toBeGreaterThanOrEqual(1)
  })

  it('a full Record over the live key-set typechecks (the positive control)', () => {
    const full = Object.fromEntries(capabilityKeys().map((k) => [k, k])) as Record<CapabilityId, string>
    expect(Object.keys(full)).toHaveLength(39)
  })
})

describe('capabilities: key-set snapshot drift (DoD 8)', () => {
  it('etc/sim-capabilities.txt equals the sorted live keys(CAPABILITIES)', () => {
    const snapshotPath = resolve(process.cwd(), 'etc/sim-capabilities.txt')
    const committed = readFileSync(snapshotPath, 'utf8').trim().split('\n')
    const live = capabilityKeys()
    expect(committed).toEqual(live)
  })

  it('the committed snapshot is sorted (deterministic generation)', () => {
    const snapshotPath = resolve(process.cwd(), 'etc/sim-capabilities.txt')
    const committed = readFileSync(snapshotPath, 'utf8').trim().split('\n')
    const resorted = [...committed].sort()
    expect(committed).toEqual(resorted)
  })
})

describe('capabilities: coverageStatus is NOT a static pass flag (DoD 7)', () => {
  it('no registry entry hard-codes coverageStatus (it is computed at run time)', () => {
    for (const key of capabilityKeys()) {
      const cap: Capability = CAPABILITIES[key]
      // The registry literal never sets coverageStatus — computeCoverage derives it.
      expect(cap.coverageStatus, `${key} hard-codes coverageStatus`).toBeUndefined()
    }
  })
})
