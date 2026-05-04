import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'

import type { ILogger } from '../../index'

describe('EP-5 ILogger — ABI conformance', () => {
  it('minimal stub is structurally assignable', () => {
    const stub: ILogger = {
      debug: (_msg: string) => {},
      info: (_msg: string) => {},
      warn: (_msg: string) => {},
      error: (_msg: string) => {},
    }
    expectTypeOf(stub).toMatchTypeOf<ILogger>()
    expect(typeof stub.debug).toBe('function')
    expect(typeof stub.info).toBe('function')
    expect(typeof stub.warn).toBe('function')
    expect(typeof stub.error).toBe('function')
  })

  it('full implementation with context and error params is structurally assignable', () => {
    const logs: string[] = []
    const logger: ILogger = {
      debug: (msg: string, ctx?: unknown) => { logs.push(`debug:${msg}`) },
      info: (msg: string, ctx?: unknown) => { logs.push(`info:${msg}`) },
      warn: (msg: string, ctx?: unknown, err?: Error) => { logs.push(`warn:${msg}`) },
      error: (msg: string, ctx?: unknown, err?: Error) => { logs.push(`error:${msg}`) },
    }
    expectTypeOf(logger).toMatchTypeOf<ILogger>()
    logger.debug('hello')
    logger.info('world')
    logger.warn('careful', {}, new Error('test'))
    logger.error('boom', {}, new Error('test'))
    expect(logs).toEqual(['debug:hello', 'info:world', 'warn:careful', 'error:boom'])
  })
})
