
import { describe, it, expect, vi } from 'vitest'
import { StateMachine } from '../state_machine'

describe('StateMachine Debug Reproduction', () => {

  // Создаем простейший адаптер для тестов
  const createMockAdaptee = (initialState: string = 'init') => ({
    state: initialState,
    setState: function(newState: any) {
        if (typeof newState === 'string') {
            this.state = newState
        } else if (newState.state) {
            this.state = newState.state
        }
    },
    get: function(prop: string) { return (this as any)[prop] }
  })

  // 1. Тест на проблему с Wildcard (*) в параллельных состояниях
  it('should handle wildcard (*) transitions within parallel states', async () => {
    const actionMock = vi.fn()
    const adaptee = createMockAdaptee('lobby')

    const config = {
      name: 'ParallelWildcardMachine',
      initialState: 'lobby',
      stateAttribute: 'state',
      states: {
        lobby: {
          regions: {
            teacher: {
              initial: 'waiting',
              waiting: {},
              ready: {}
            },
            connection: {
              initial: 'connected',
              connected: {},
              disconnected: {}
            }
          }
        }
      },
      events: {
        PEER_CONNECTED: {
          transitions: [
            {
              from: '*',
              to: '*',
              action: 'onPeerConnected'
            }
          ]
        }
      },
      context: {
        onPeerConnected: actionMock
      }
    }

    const machine = new StateMachine(config as any, adaptee)
    machine.setContext(config.context)

    // Инициализация
    // В текущей реализации initialState устанавливается в конструкторе, но regions могут требовать инициализации
    // Для теста предположим, что мы уже в сложном состоянии
    // (В реальности машина сама выставит начальные подсостояния)

    console.log('Current State before event:', machine.currentState)

    // Пытаемся вызвать событие с wildcard
    try {
      await machine.fireEvent('PEER_CONNECTED', { payload: { id: 123 } })
    } catch (e) {
      console.error('Error firing event:', e)
    }

    // Проверка: Action должен был вызваться
    expect(actionMock).toHaveBeenCalled()
  })

  // 2. Тест на выполнение Action при переходе (Transition Action)
  it('should execute actions defined on transitions', async () => {
    const transitionActionMock = vi.fn()
    const enterActionMock = vi.fn()
    const adaptee = createMockAdaptee('disconnected')

    const config = {
      name: 'TransitionActionMachine',
      initialState: 'disconnected',
      stateAttribute: 'state',
      states: {
        disconnected: {},
        connecting: {
          onEnter: 'onEnterConnecting'
        }
      },
      events: {
        CONNECT: {
          transitions: [
            {
              from: 'disconnected',
              to: 'connecting',
              action: 'transitionAction'
            }
          ]
        }
      },
      context: {
        transitionAction: transitionActionMock,
        onEnterConnecting: enterActionMock
      }
    }

    const machine = new StateMachine(config as any, adaptee)
    machine.setContext(config.context)

    await machine.fireEvent('CONNECT')

    expect(enterActionMock).toHaveBeenCalled()
    expect(transitionActionMock).toHaveBeenCalled() // Ожидаем провал здесь
  })

  // 3. Тест на передачу owner в Action
  it('should pass raw owner as first argument to actions', async () => {
    let capturedOwner: any = undefined
    const adaptee = createMockAdaptee('idle')
    ;(adaptee as any).role = 'tester'

    const config = {
      name: 'ContextMachine',
      initialState: 'idle',
      stateAttribute: 'state',
      states: {
        idle: {
          onEnter: 'checkContext'
        }
      },
      events: {
         START: { transitions: [{ from: 'idle', to: 'idle', action: 'checkContext' }] }
      },
      context: {
        role: 'tester',
        checkContext: (ctx: any) => {
          capturedOwner = ctx
        }
      }
    }

    const machine = new StateMachine(config as any, adaptee)
    // Важно: вызываем setContext как мы делали в фиксе
    machine.setContext(config.context)

    // Вызываем событие, чтобы триггернуть action
    await machine.fireEvent('START')

    console.log('Captured Owner:', capturedOwner)

    expect(capturedOwner).toBeDefined()
    expect(capturedOwner).toBe(adaptee)
    expect(capturedOwner.role).toBe('tester')
  })

})
