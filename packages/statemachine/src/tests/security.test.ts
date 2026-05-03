import { describe, expect, it } from 'bun:test'
import { FunctionValidator, SafeFunctionSerializer } from '../security'

describe('Security', () => {
  it('detects builtin patterns', () => {
    const validator = new FunctionValidator()

    const evalResult = validator.validate('eval("1+1")')
    expect(evalResult.isValid).toBe(false)
    expect(evalResult.riskLevel).toBe('critical')
    expect(evalResult.detectedPatterns).toContain('Direct eval() usage')

    const fnResult = validator.validate('new Function("return 1")')
    expect(fnResult.isValid).toBe(false)
    expect(fnResult.riskLevel).toBe('high')
    expect(fnResult.detectedPatterns).toContain('Dynamic function creation')

    const fnCallResult = validator.validate('Function("return 1")')
    expect(fnCallResult.isValid).toBe(false)
    expect(fnCallResult.riskLevel).toBe('high')
    expect(fnCallResult.detectedPatterns).toContain(
      'Dynamic Function constructor call',
    )

    const timeoutResult = validator.validate('setTimeout("alert(1)", 0)')
    expect(timeoutResult.isValid).toBe(false)
    expect(timeoutResult.riskLevel).toBe('high')
    expect(timeoutResult.detectedPatterns).toContain('setTimeout with string code')

    const domResult = validator.validate('el.innerHTML = "<b>x</b>"')
    expect(domResult.isValid).toBe(false)
    expect(domResult.riskLevel).toBe('high')
    expect(domResult.detectedPatterns).toContain('innerHTML manipulation (XSS risk)')

    const procResult = validator.validate('const cp = "child_process"; exec("ls")')
    expect(procResult.isValid).toBe(false)
    expect(procResult.riskLevel).toBe('critical')
    expect(procResult.detectedPatterns).toContain('Child process execution')
    expect(procResult.detectedPatterns).toContain('Command execution')
  })

  it('supports customPatterns via constructor', () => {
    const validator = new FunctionValidator({
      customPatterns: [
        {
          pattern: /fetch\s*\(/,
          risk: 'medium',
          description: 'Network access via fetch',
          category: 'network',
        },
      ],
    })

    const result = validator.validate('fetch("/api")')
    expect(result.isValid).toBe(false)
    expect(result.detectedPatterns).toContain('Network access via fetch')
    expect(result.riskLevel).toBe('medium')
  })

  it('supports dynamic custom patterns via addCustomPattern()', () => {
    const validator = new FunctionValidator()
    validator.addCustomPattern({
      pattern: /XMLHttpRequest/,
      risk: 'high',
      description: 'Network access via XMLHttpRequest',
      category: 'network',
    })

    const result = validator.validate('const x = new XMLHttpRequest()')
    expect(result.isValid).toBe(false)
    expect(result.detectedPatterns).toContain('Network access via XMLHttpRequest')
    expect(result.riskLevel).toBe('high')
  })

  it('exposes validator on SafeFunctionSerializer for addCustomPattern()', () => {
    const serializer = new SafeFunctionSerializer()
    serializer.validator.addCustomPattern({
      pattern: /fetch\s*\(/,
      risk: 'medium',
      description: 'fetch()',
    })

    const result = serializer.validator.validate('fetch("/api")')
    expect(result.isValid).toBe(false)
    expect(result.detectedPatterns).toContain('fetch()')
  })
})
