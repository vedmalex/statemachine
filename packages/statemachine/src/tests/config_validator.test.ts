/**
 * Tests for configuration validation module
 */

import { describe, expect, it } from 'vitest'
import {
  ConfigValidator,
  DEFAULT_VALIDATION_CONFIG,
  isValidConfig,
  validateConfig,
  validateConfigStrict,
} from '../config_validator'

// Test configurations
const validConfig = {
  name: 'TestStateMachine',
  stateAttribute: 'state',
  initialState: 'idle',
  states: {
    idle: {
      display: 'Idle State',
    },
    active: {
      display: 'Active State',
    },
    error: {
      display: 'Error State',
    },
  },
  events: {
    start: {
      transitions: [{ from: 'idle', to: 'active' }],
    },
    stop: {
      transitions: [{ from: 'active', to: 'idle' }],
    },
    fail: {
      transitions: [{ from: 'active', to: 'error' }],
    },
  },
}

const invalidConfig = {
  // Missing name
  stateAttribute: 'state',
  initialState: 'nonexistent',
  states: {},
  events: {},
}

const hierarchicalConfig = {
  name: 'HierarchicalStateMachine',
  stateAttribute: 'state',
  initialState: 'parent',
  states: {
    parent: {
      display: 'Parent State',
      regions: {
        region1: {
          child1: {
            display: 'Child 1',
          },
          child2: {
            display: 'Child 2',
          },
        },
      },
      initial: 'child1',
    },
  },
  events: {
    navigate: {
      transitions: [
        { from: 'parent.region1.child1', to: 'parent.region1.child2' },
      ],
    },
  },
}

describe('Configuration Validator', () => {
  describe('ConfigValidator class', () => {
    it('should validate a correct configuration', () => {
      const validator = new ConfigValidator()
      const result = validator.validate(validConfig as any)

      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should detect missing required fields', () => {
      const validator = new ConfigValidator()
      const result = validator.validate(invalidConfig as any)

      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.code === 'MISSING_NAME')).toBe(true)
      expect(result.errors.some((e) => e.code === 'EMPTY_STATES')).toBe(true)
      expect(result.errors.some((e) => e.code === 'EMPTY_EVENTS')).toBe(true)
    })

    it('should validate initial state exists', () => {
      const configWithBadInitial = {
        ...validConfig,
        initialState: 'nonexistent',
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithBadInitial as any)

      expect(result.isValid).toBe(false)
      expect(
        result.errors.some((e) => e.code === 'INVALID_INITIAL_STATE'),
      ).toBe(true)
    })

    it('should validate transition paths', () => {
      const configWithBadTransition = {
        ...validConfig,
        events: {
          badEvent: {
            transitions: [{ from: 'nonexistent', to: 'idle' }],
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithBadTransition as any)

      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.code === 'INVALID_STATE_PATH')).toBe(
        true,
      )
    })

    it('should validate hierarchical states', () => {
      const validator = new ConfigValidator()
      const result = validator.validate(hierarchicalConfig as any)

      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should detect invalid regions', () => {
      const configWithBadRegions = {
        ...validConfig,
        states: {
          parent: {
            regions: 'invalid', // Should be object
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithBadRegions as any)

      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.code === 'INVALID_REGIONS')).toBe(true)
    })

    it('should validate history property', () => {
      const configWithBadHistory = {
        ...validConfig,
        states: {
          parent: {
            history: 'invalid', // Should be 'deep' or 'shallow'
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithBadHistory as any)

      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.code === 'INVALID_HISTORY')).toBe(true)
    })

    it('should detect missing transitions', () => {
      const configWithoutTransitions = {
        ...validConfig,
        events: {
          emptyEvent: {
            // Missing transitions
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithoutTransitions as any)

      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.code === 'MISSING_TRANSITIONS')).toBe(
        true,
      )
    })

    it('should warn about empty transitions', () => {
      const configWithEmptyTransitions = {
        ...validConfig,
        events: {
          emptyEvent: {
            transitions: [],
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithEmptyTransitions as any)

      expect(result.isValid).toBe(true) // Warnings don't make config invalid
      expect(result.warnings.some((w) => w.code === 'EMPTY_TRANSITIONS')).toBe(
        true,
      )
    })

    it('should validate transition priorities', () => {
      const configWithBadPriority = {
        ...validConfig,
        events: {
          priorityEvent: {
            transitions: [
              { from: 'idle', to: 'active', priority: 'high' }, // Should be number
            ],
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithBadPriority as any)

      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.code === 'INVALID_PRIORITY')).toBe(
        true,
      )
    })

    it('should warn about self-transitions', () => {
      const configWithSelfTransition = {
        ...validConfig,
        events: {
          selfEvent: {
            transitions: [{ from: 'idle', to: 'idle' }],
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithSelfTransition as any)

      expect(result.isValid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'SELF_TRANSITION')).toBe(
        true,
      )
    })

    it('should detect unreachable states', () => {
      const configWithUnreachableState = {
        ...validConfig,
        states: {
          ...validConfig.states,
          unreachable: {
            display: 'Unreachable State',
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(configWithUnreachableState as any)

      expect(result.isValid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'UNREACHABLE_STATE')).toBe(
        true,
      )
    })

    it('should warn about performance constraints', () => {
      const validator = new ConfigValidator({
        maxStatesCount: 2, // Very low limit for testing
        maxEventsCount: 2,
      })

      const result = validator.validate(validConfig as any)

      expect(result.isValid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'TOO_MANY_STATES')).toBe(
        true,
      )
      expect(result.warnings.some((w) => w.code === 'TOO_MANY_EVENTS')).toBe(
        true,
      )
    })

    it('should respect validation configuration', () => {
      const validator = new ConfigValidator({
        allowEmptyStates: true,
        allowEmptyEvents: true,
        requireInitialState: false,
      })

      const emptyConfig = {
        name: 'EmptyConfig',
        stateAttribute: 'state',
        states: {},
        events: {},
      }

      const result = validator.validate(emptyConfig as any)

      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should validate max depth constraint', () => {
      const deepConfig = {
        name: 'DeepConfig',
        stateAttribute: 'state',
        initialState: 'level1',
        states: {
          level1: {
            regions: {
              region1: {
                level2: {
                  regions: {
                    region2: {
                      level3: {
                        regions: {
                          region3: {
                            level4: {},
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        events: {},
      }

      const validator = new ConfigValidator({
        maxStateDepth: 2,
        allowEmptyEvents: true,
      })

      const result = validator.validate(deepConfig as any)

      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.code === 'MAX_DEPTH_EXCEEDED')).toBe(
        true,
      )
    })
  })

  describe('Utility functions', () => {
    it('should validate config with default settings', () => {
      const result = validateConfig(validConfig as any)

      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should validate config with custom settings', () => {
      // NB (W2b/V10): strict mode now PROMOTES warnings to errors, so a
      // performance advisory like TOO_MANY_STATES would flip isValid under
      // strictMode. This test's intent is "custom settings surface the advisory
      // and stay valid", so it uses the (non-strict) custom bound directly.
      const result = validateConfig(validConfig as any, {
        maxStatesCount: 2,
      })

      expect(result.isValid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'TOO_MANY_STATES')).toBe(
        true,
      )
    })

    it('should validate config in strict mode', () => {
      const result = validateConfigStrict(validConfig as any)

      expect(result.isValid).toBe(true)
    })

    it('should check if config is valid', () => {
      expect(isValidConfig(validConfig as any)).toBe(true)
      expect(isValidConfig(invalidConfig as any)).toBe(false)
    })
  })

  describe('Complex validation scenarios', () => {
    it('should validate composite state paths', () => {
      const compositeConfig = {
        name: 'CompositeConfig',
        stateAttribute: 'state',
        initialState: 'parent1',
        states: {
          parent1: {
            regions: {
              region1: {
                child1: {},
                child2: {},
              },
            },
          },
          parent2: {
            regions: {
              region2: {
                child3: {},
                child4: {},
              },
            },
          },
        },
        events: {
          multiTransition: {
            transitions: [
              {
                from: 'parent1.region1.child1|parent2.region2.child3',
                to: 'parent1.region1.child2',
              },
            ],
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(compositeConfig as any)

      expect(result.isValid).toBe(true)
    })

    it('should handle validation errors gracefully', () => {
      const malformedConfig = {
        name: 'MalformedConfig',
        stateAttribute: 'state',
        initialState: 'start',
        states: null, // This will cause validation to fail
        events: {},
      }

      const validator = new ConfigValidator()
      const result = validator.validate(malformedConfig as any)

      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.code === 'MISSING_STATES')).toBe(true)
    })

    it('should validate mixed priority transitions', () => {
      const mixedPriorityConfig = {
        ...validConfig,
        events: {
          mixedEvent: {
            transitions: [
              { from: 'idle', to: 'active', priority: 1 },
              { from: 'idle', to: 'error' }, // No priority
            ],
          },
        },
      }

      const validator = new ConfigValidator()
      const result = validator.validate(mixedPriorityConfig as any)

      expect(result.isValid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'MIXED_PRIORITIES')).toBe(
        true,
      )
    })
  })

  describe('Final states and done.state join validation', () => {
    it('should error when a final state has an outgoing transition (FINAL_STATE_HAS_OUTGOING)', () => {
      const config = {
        name: 'FinalOutgoing',
        stateAttribute: 'state',
        initialState: 'game',
        states: {
          game: {
            initial: 'a',
            regions: {
              r1: {
                a: {},
                doneR1: { final: true },
              },
            },
          },
          over: {},
        },
        events: {
          finishR1: {
            transitions: [
              { from: 'game.r1.a', to: 'game.r1.doneR1' },
            ],
          },
          leak: {
            // illegal: a final leaf cannot be a transition source
            transitions: [{ from: 'game.r1.doneR1', to: 'over' }],
          },
        },
      }

      const result = validateConfig(config as any)

      expect(result.isValid).toBe(false)
      expect(
        result.errors.some((e) => e.code === 'FINAL_STATE_HAS_OUTGOING'),
      ).toBe(true)
    })

    it('should warn when done.state.<C> has no reachable final substate (REGION_NO_REACHABLE_FINAL)', () => {
      const config = {
        name: 'NoReachableFinal',
        stateAttribute: 'state',
        initialState: 'game',
        states: {
          game: {
            initial: 'a',
            regions: {
              r1: {
                a: {},
                b: {},
              },
            },
          },
          over: {},
        },
        events: {
          // join declared, but no final substate under `game`
          'done.state.game': {
            transitions: [{ from: 'game', to: 'over' }],
          },
        },
      }

      const result = validateConfig(config as any)

      expect(result.isValid).toBe(true)
      expect(
        result.warnings.some((w) => w.code === 'REGION_NO_REACHABLE_FINAL'),
      ).toBe(true)
    })

    it('should advise when a region omits explicit initial, staying valid (REGION_MISSING_INITIAL)', () => {
      const config = {
        name: 'RegionMissingInitial',
        stateAttribute: 'state',
        initialState: 'game',
        states: {
          game: {
            // no `initial` pointer into any region -> first-key fallback
            regions: {
              r1: {
                a: {},
                b: {},
              },
            },
          },
        },
        events: {
          go: {
            transitions: [{ from: 'game.r1.a', to: 'game.r1.b' }],
          },
        },
      }

      const result = validateConfig(config as any)

      expect(result.isValid).toBe(true)
      expect(
        result.warnings.some((w) => w.code === 'REGION_MISSING_INITIAL'),
      ).toBe(true)
    })

    it('should validate a proper final + done.state config cleanly (no final/done errors)', () => {
      const config = {
        name: 'ProperFinal',
        stateAttribute: 'state',
        initialState: 'game',
        states: {
          game: {
            initial: 'playing',
            regions: {
              r1: {
                playing: {},
                won: { final: true },
              },
            },
          },
          over: {},
        },
        events: {
          win: {
            transitions: [{ from: 'game.r1.playing', to: 'game.r1.won' }],
          },
          'done.state.game': {
            transitions: [{ from: 'game', to: 'over' }],
          },
        },
      }

      const result = validateConfig(config as any)

      expect(result.isValid).toBe(true)
      expect(
        result.errors.some((e) => e.code === 'FINAL_STATE_HAS_OUTGOING'),
      ).toBe(false)
      expect(
        result.warnings.some((w) => w.code === 'REGION_NO_REACHABLE_FINAL'),
      ).toBe(false)
      expect(
        result.warnings.some((w) => w.code === 'FINAL_ON_COMPOSITE'),
      ).toBe(false)
    })

    it('should not flag a final leaf as UNREACHABLE_STATE', () => {
      const config = {
        name: 'FinalReachable',
        stateAttribute: 'state',
        initialState: 'game',
        states: {
          game: {
            initial: 'playing',
            regions: {
              r1: {
                playing: {},
                won: { final: true },
              },
            },
          },
        },
        events: {
          win: {
            transitions: [{ from: 'game.r1.playing', to: 'game.r1.playing' }],
          },
        },
      }

      const result = validateConfig(config as any)

      // The final leaf `game.r1.won` is entered via region expansion, never as a
      // transition target, so it must NOT be reported unreachable.
      expect(
        result.warnings.some(
          (w) =>
            w.code === 'UNREACHABLE_STATE' &&
            w.message.includes('game.r1.won'),
        ),
      ).toBe(false)
    })

    it('should warn when final is set on a composite (FINAL_ON_COMPOSITE)', () => {
      const config = {
        name: 'FinalOnComposite',
        stateAttribute: 'state',
        initialState: 'game',
        states: {
          game: {
            initial: 'playing',
            final: true, // illegal placement: composite cannot be final
            regions: {
              r1: {
                playing: {},
                won: { final: true },
              },
            },
          },
        },
        events: {
          win: {
            transitions: [{ from: 'game.r1.playing', to: 'game.r1.won' }],
          },
        },
      }

      const result = validateConfig(config as any)

      expect(result.isValid).toBe(true)
      expect(
        result.warnings.some((w) => w.code === 'FINAL_ON_COMPOSITE'),
      ).toBe(true)
    })

    it('should warn when a done.state join coexists with a from:<C> parallel-exit (DONE_VS_PARALLEL_EXIT_AMBIGUITY)', () => {
      const config = {
        name: 'DoneAmbiguity',
        stateAttribute: 'state',
        initialState: 'game',
        states: {
          game: {
            initial: 'playing',
            regions: {
              r1: {
                playing: {},
                won: { final: true },
              },
            },
          },
          over: {},
          aborted: {},
        },
        events: {
          // W2b: give region r1 a real path to its final leaf so the (new,
          // model-based) REGION_NO_PATH_TO_FINAL check stays quiet — this fixture
          // is about the done/parallel-exit AMBIGUITY, not an unreachable final.
          win: {
            transitions: [{ from: 'game.r1.playing', to: 'game.r1.won' }],
          },
          'done.state.game': {
            transitions: [{ from: 'game', to: 'over' }],
          },
          // user event using the bare composite as a parallel-exit source
          abort: {
            transitions: [{ from: 'game', to: 'aborted' }],
          },
        },
      }

      const result = validateConfig(config as any)

      expect(result.isValid).toBe(true)
      expect(
        result.warnings.some(
          (w) => w.code === 'DONE_VS_PARALLEL_EXIT_AMBIGUITY',
        ),
      ).toBe(true)
    })

    it('should not flag existing region fixtures pass->fail', () => {
      // hierarchicalConfig pins region1 via parent.initial -> stays valid, no
      // FINAL_* / done errors.
      const result = validateConfig(hierarchicalConfig as any)
      expect(result.isValid).toBe(true)
      expect(
        result.errors.some((e) => e.code === 'FINAL_STATE_HAS_OUTGOING'),
      ).toBe(false)
    })
  })

  describe('Default validation config', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_VALIDATION_CONFIG.strictMode).toBe(false)
      expect(DEFAULT_VALIDATION_CONFIG.allowEmptyStates).toBe(false)
      expect(DEFAULT_VALIDATION_CONFIG.allowEmptyEvents).toBe(false)
      expect(DEFAULT_VALIDATION_CONFIG.maxStateDepth).toBe(10)
      expect(DEFAULT_VALIDATION_CONFIG.maxStatesCount).toBe(1000)
      expect(DEFAULT_VALIDATION_CONFIG.maxEventsCount).toBe(1000)
      expect(DEFAULT_VALIDATION_CONFIG.requireInitialState).toBe(true)
      expect(DEFAULT_VALIDATION_CONFIG.validateTransitionPaths).toBe(true)
      expect(DEFAULT_VALIDATION_CONFIG.validateActionReferences).toBe(false)
    })
  })
})
