import { describe, expect, it } from 'vitest'
import { StateMachine } from '../state_machine'
import { MemoryAdapter } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// W3b — invoke расширяется до операции с AbortSignal (SPEC §6а, решение «а») +
// ExitContext доп. аргументом в onExit (SPEC §6а, решение «б»).
//
// РОЛЬ: RED. Эти тесты описывают НОВУЮ фичу, которой нет на HEAD:
//   • StateInvocation.src — длительная операция { src(adaptee, signal), onDone?, onError? }
//   • отмена операции через AbortController при выходе из листа (abort ДО onExit)
//   • подавление onDone/onError у ОТМЕНЁННОЙ операции
//   • отказ операции без onError → monitor.recordError
//   • ExitContext { event, preempted, wasFinal, target } как ДОП. аргумент onExit
//
// На HEAD invoke — ТОЛЬКО таймерная форма { delay, event }; форма { src } не
// поддержана (src никогда не вызывается), а onExit получает голый payload без
// ExitContext. Поэтому все проверки ниже КРАСНЫ на HEAD. Не чинить src — по схеме.
// ─────────────────────────────────────────────────────────────────────────────

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('W3b Part 1 — invoke.src операция с AbortSignal (SPEC §6а)', () => {
  it('(1a) src-операция запускается при входе в лист и получает AbortSignal', async () => {
    let srcCalled = false
    let signalIsAbortSignal = false

    const config = {
      name: 'InvokeSrcStart',
      initialState: 'working',
      stateAttribute: 'state',
      states: {
        working: {
          invoke: [
            {
              src: async (_adaptee: any, signal: AbortSignal) => {
                srcCalled = true
                signalIsAbortSignal =
                  typeof signal === 'object' &&
                  signal !== null &&
                  typeof signal.aborted === 'boolean'
                return 'ok-result'
              },
              onDone: 'ok',
            },
          ],
        },
        done: {},
      },
      events: {
        ok: { transitions: [{ from: 'working', to: 'done' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'working' })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _sm = new StateMachine(config as any, adapter)

    await tick(10)

    // HEAD: форма { src } не поддержана → src никогда не вызывается.
    expect(srcCalled).toBe(true)
    expect(signalIsAbortSignal).toBe(true)
  })

  it('(1b) onDone поднимается при успехе, результат — в payload', async () => {
    let donePayload: unknown = undefined

    const config = {
      name: 'InvokeSrcOnDone',
      initialState: 'working',
      stateAttribute: 'state',
      states: {
        working: {
          invoke: [
            {
              src: async () => 'RESULT-42',
              onDone: 'ok',
            },
          ],
        },
        done: {
          onEnter: function (_adaptee: any, payload: unknown) {
            donePayload = payload
          },
        },
      },
      events: {
        ok: { transitions: [{ from: 'working', to: 'done' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'working' })
    const sm = new StateMachine(config as any, adapter)

    await tick(10)

    // HEAD: onDone-механизма нет → машина остаётся в 'working'.
    expect(sm.getCurrentState()).toBe('done')
    expect(donePayload).toBe('RESULT-42')
  })

  it('(1c) при выходе из листа abort() вызывается ДО onExit (signal.aborted виден в onExit)', async () => {
    let srcCalled = false
    let capturedSignal: AbortSignal | undefined
    let onExitRan = false
    let abortedAtOnExit: boolean | undefined
    let releaseSrc: () => void = () => {}
    const gate = new Promise<void>((res) => {
      releaseSrc = res
    })

    const config = {
      name: 'InvokeSrcAbort',
      initialState: 'working',
      stateAttribute: 'state',
      states: {
        working: {
          onExit: function () {
            onExitRan = true
            abortedAtOnExit = capturedSignal?.aborted
          },
          invoke: [
            {
              src: async (_adaptee: any, signal: AbortSignal) => {
                srcCalled = true
                capturedSignal = signal
                await gate
                return 'late'
              },
              onDone: 'ok',
            },
          ],
        },
        done: {},
        left: {},
      },
      events: {
        ok: { transitions: [{ from: 'working', to: 'done' }] },
        leave: { transitions: [{ from: 'working', to: 'left' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'working' })
    const sm = new StateMachine(config as any, adapter)

    await tick(10)
    await sm.fireEvent('leave')

    // Дать операции завершиться после отмены (не должна ничего поднять).
    releaseSrc()
    await tick(10)

    expect(sm.getCurrentState()).toBe('left')
    expect(onExitRan).toBe(true)
    // HEAD: src не вызван → capturedSignal undefined → abortedAtOnExit undefined.
    expect(srcCalled).toBe(true)
    expect(abortedAtOnExit).toBe(true)
  })

  it('(2) отменённая операция: abort до резолва → onDone НЕ поднято (лист покинут)', async () => {
    let srcCalled = false
    let releaseSrc: () => void = () => {}
    const gate = new Promise<void>((res) => {
      releaseSrc = res
    })

    const config = {
      name: 'InvokeSrcCancelled',
      initialState: 'working',
      stateAttribute: 'state',
      states: {
        working: {
          invoke: [
            {
              src: async (_adaptee: any, _signal: AbortSignal) => {
                srcCalled = true
                await gate
                return 'RESULT-late'
              },
              onDone: 'ok',
            },
          ],
        },
        done: {},
        left: {},
      },
      events: {
        ok: { transitions: [{ from: 'working', to: 'done' }] },
        leave: { transitions: [{ from: 'working', to: 'left' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'working' })
    const sm = new StateMachine(config as any, adapter)

    await tick(10)
    // Уходим из листа ДО резолва операции → операция отменяется.
    await sm.fireEvent('leave')
    expect(sm.getCurrentState()).toBe('left')

    // Теперь операция резолвится — но её событие от ОТМЕНЁННОЙ операции
    // (signal.aborted) игнорируется и НЕ попадает в очередь.
    releaseSrc()
    await tick(10)

    // Якорь RED: на HEAD src не вызывается вовсе.
    expect(srcCalled).toBe(true)
    // Отменённая операция не поднимает onDone → в 'done' не уходим.
    expect(sm.getCurrentState()).toBe('left')
  })

  it('(3-политика) отказ операции без onError → monitor.recordError (как гарды F7)', async () => {
    const recorded: Error[] = []
    const monitor = {
      recordTransition() {},
      recordError(err: Error) {
        recorded.push(err)
      },
    }

    const config = {
      name: 'InvokeSrcRejectNoOnError',
      initialState: 'working',
      stateAttribute: 'state',
      states: {
        working: {
          invoke: [
            {
              src: async () => {
                throw new Error('operation-boom')
              },
              onDone: 'ok',
              // onError НЕ задан → отказ должен уйти в monitor.recordError.
            },
          ],
        },
        done: {},
      },
      events: {
        ok: { transitions: [{ from: 'working', to: 'done' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'working' })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _sm = new StateMachine(config as any, adapter, {
      monitor: monitor as any,
    })

    await tick(10)

    // HEAD: src не вызывается → отказа операции нет → ничего про 'operation-boom'.
    const boom = recorded.find((e) => String(e?.message).includes('operation-boom'))
    expect(boom).toBeDefined()
  })
})

describe('W3b Part 2 — ExitContext доп. аргументом onExit (SPEC §6а)', () => {
  type Captured = { argc: number; ctx: any }

  it('(3a/preempted=true) parallel-exit: onExit покидаемого листа получает ExitContext {preempted:true, wasFinal:false, target, event}', async () => {
    const captures: Record<string, Captured> = {}
    const makeExit =
      (name: string) =>
      function (this: unknown, _adaptee: unknown, ...rest: any[]) {
        captures[name] = { argc: rest.length, ctx: rest[rest.length - 1] }
      }

    const config = {
      name: 'ExitCtxPreempted',
      initialState: 'proc',
      stateAttribute: 'state',
      states: {
        proc: {
          initial: 'a.run|b.run',
          regions: {
            a: {
              run: { onExit: makeExit('a.run') },
              done: { final: true },
            },
            b: {
              run: { onExit: makeExit('b.run') },
              done: { final: true },
            },
          },
        },
        aborted: {},
      },
      events: {
        kill: { transitions: [{ from: 'proc', to: 'aborted' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'proc' })
    const sm = new StateMachine(config as any, adapter)

    // Оба региона в run (не final). Внешнее событие сворачивает весь proc.
    await sm.fireEvent('kill')
    await tick(0)

    expect(sm.getCurrentState()).toBe('aborted')

    const cap = captures['a.run']
    // HEAD: onExit получает голый payload без ExitContext → argc === 0, ctx undefined.
    expect(cap).toBeDefined()
    expect(cap!.argc).toBe(1)
    expect(cap!.ctx).toBeDefined()
    expect(cap!.ctx.preempted).toBe(true)
    expect(cap!.ctx.wasFinal).toBe(false)
    expect(cap!.ctx.target).toBe('aborted')
    expect(cap!.ctx.event).toBe('kill')
  })

  it('(3b/preempted=false) регион дошёл до final: onExit final-листа получает {preempted:false, wasFinal:true, target}', async () => {
    const captures: Record<string, { argc: number; ctx: any }> = {}
    const makeExit =
      (name: string) =>
      function (this: unknown, _adaptee: unknown, ...rest: any[]) {
        captures[name] = { argc: rest.length, ctx: rest[rest.length - 1] }
      }

    const config = {
      name: 'ExitCtxFinal',
      initialState: 'proc',
      stateAttribute: 'state',
      states: {
        proc: {
          initial: 'a.run|b.run',
          regions: {
            a: {
              run: {},
              done: { final: true, onExit: makeExit('a.done') },
            },
            b: {
              run: {},
              done: { final: true, onExit: makeExit('b.done') },
            },
          },
        },
        complete: {},
      },
      events: {
        finishA: { transitions: [{ from: 'proc.a.run', to: 'proc.a.done' }] },
        finishB: { transitions: [{ from: 'proc.b.run', to: 'proc.b.done' }] },
        // Джойн на движковом done.state.<C>: оба региона final → выход в complete.
        'done.state.proc': { transitions: [{ from: 'proc', to: 'complete' }] },
      },
    }

    const adapter = new MemoryAdapter({ state: 'proc' })
    const sm = new StateMachine(config as any, adapter)

    await sm.fireEvent('finishA')
    await sm.fireEvent('finishB')
    // Дать внутренне поднятому done.state.proc продрейниться (джойн в complete).
    await tick(0)

    expect(sm.getCurrentState()).toBe('complete')

    const cap = captures['a.done']
    // HEAD: onExit получает голый payload без ExitContext → argc === 0, ctx undefined.
    expect(cap).toBeDefined()
    expect(cap!.argc).toBe(1)
    expect(cap!.ctx).toBeDefined()
    expect(cap!.ctx.preempted).toBe(false)
    expect(cap!.ctx.wasFinal).toBe(true)
    expect(cap!.ctx.target).toBe('complete')
  })
})
