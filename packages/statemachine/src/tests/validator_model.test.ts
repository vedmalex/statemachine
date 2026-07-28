/**
 * W2b — валидатор на модель (дефекты F10 / П11, SPEC §1а/§1б).
 *
 * РОЛЬ ЭТОГО ФАЙЛА: RED-тесты. На HEAD (aa6bf5a, ветка remediation/w1-prep) валидатор
 * парсит пути заново (три реализации «валидного пути», корень F10/V3) и НЕ потребляет
 * нормализованную модель `compileModel` (src/model.ts, W2a). Каждый тест ниже краснеет
 * на HEAD на СВОЁМ целевом ассерте; зелёным его делает W2b (перевод валидатора на модель
 * + новые проверки корректности + политика «ошибки модели БРОСАЮТ при компиляции»).
 *
 * Тесты чёрно-ящичные: работают через публичную поверхность (`validateConfig` /
 * `validateConfigStrict` / `createMachine`), не через приватные внутренности валидатора.
 *
 * Подтверждённое поведение HEAD (запуском probe до фиксации файла):
 *  - README-пример регионов  → INVALID_INITIAL_STATE@states.proc.initial (F10),
 *                              UNREACHABLE_STATE@states.proc.a.run / proc.b.run (ложные).
 *  - from:'*'                 → INVALID_STATE_PATH + UNUSED_EVENT (ложные).
 *  - REGION_STARTS_FINAL / UNSATISFIABLE_FROM / DUPLICATE_REGION_NAME → НЕ выдаются.
 *  - createMachine(битый from) → строит машину, НЕ бросает.
 */
import { describe, expect, it } from 'vitest'
import { validateConfig, validateConfigStrict } from '../config_validator'
import { createMachine } from '../lite'

/**
 * Канонический README-пример регионов (README.md §"Hierarchical regions...").
 * `initial: 'a.run|b.run'` — точечный, региональный, ОБЕ области параллельно.
 * Рантайм принимает его; валидатор на HEAD бракует (F10/V3).
 */
function readmeRegionsConfig(): any {
  return {
    name: 'proc',
    stateAttribute: 'state',
    initialState: 'proc',
    states: {
      proc: {
        initial: 'a.run|b.run', // обе области активны параллельно
        regions: {
          a: { run: {}, done: { final: true } },
          b: { run: {}, done: { final: true } },
        },
      },
      complete: {},
    },
    events: {
      finishA: { transitions: [{ from: 'proc.a.run', to: 'proc.a.done' }] },
      finishB: { transitions: [{ from: 'proc.b.run', to: 'proc.b.done' }] },
      'done.state.proc': { transitions: [{ from: 'proc', to: 'complete' }] },
    },
  }
}

describe('W2b validator-on-model — RED (fails on HEAD)', () => {
  // (1) F10/V3: точечный initial ('a.run|b.run' и одиночный 'a.run') не должен
  // браковаться. initial резолвится ЧЕРЕЗ МОДЕЛЬ, как в рантайме.
  describe('F10 — точечный initial валиден', () => {
    it('README-пример регионов НЕ даёт INVALID_INITIAL_STATE (composite initial "a.run|b.run")', () => {
      const result = validateConfig(readmeRegionsConfig())

      const initialErr = result.errors.find(
        (e) => e.code === 'INVALID_INITIAL_STATE',
      )
      // HEAD: INVALID_INITIAL_STATE@states.proc.initial присутствует → красный.
      expect(initialErr).toBeUndefined()
    })

    it('одиночный точечный initial "a.run" НЕ даёт INVALID_INITIAL_STATE', () => {
      const config = readmeRegionsConfig()
      config.states.proc.initial = 'a.run'

      const result = validateConfig(config)

      expect(
        result.errors.some((e) => e.code === 'INVALID_INITIAL_STATE'),
      ).toBe(false)
    })

    it('README-пример валиден целиком (isValid, ошибок нет)', () => {
      const result = validateConfig(readmeRegionsConfig())
      // HEAD: isValid=false из-за F10 → красный.
      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })
  })

  // (2) Ложный UNREACHABLE: входные листья регионов достижимы через раскрытие
  // начальной конфигурации; UNREACHABLE должен строиться обходом достижимости ПО МОДЕЛИ.
  describe('UNREACHABLE_STATE — входные листья регионов НЕ недостижимы', () => {
    it('proc.a.run и proc.b.run не помечены UNREACHABLE_STATE', () => {
      const result = validateConfig(readmeRegionsConfig())

      const unreachablePaths = result.warnings
        .filter((w) => w.code === 'UNREACHABLE_STATE')
        .map((w) => w.path)

      // HEAD: обе входные вершины региона ложно недостижимы → красный.
      expect(unreachablePaths).not.toContain('states.proc.a.run')
      expect(unreachablePaths).not.toContain('states.proc.b.run')
    })
  })

  // (3) V2: wildcard from:'*' / to:'*' поддержан рантаймом (:1857/1865/1910),
  // валидатор не должен браковать wildcard как несуществующий путь и не должен
  // объявлять событие UNUSED только из-за wildcard-источника.
  describe('V2 — wildcard from/to валиден', () => {
    it("from:'*' не даёт INVALID_STATE_PATH и не даёт UNUSED_EVENT", () => {
      const result = validateConfig({
        name: 'wild',
        stateAttribute: 'state',
        initialState: 'idle',
        states: { idle: {}, running: {} },
        events: {
          reset: { transitions: [{ from: '*', to: 'idle' }] },
        },
      } as any)

      // HEAD: INVALID_STATE_PATH (isValidStatePath('*')===false) → красный.
      expect(
        result.errors.some((e) => e.code === 'INVALID_STATE_PATH'),
      ).toBe(false)
      // HEAD: UNUSED_EVENT для reset (allStateNames не содержит '*') → красный.
      expect(
        result.warnings.some(
          (w) => w.code === 'UNUSED_EVENT' && w.path === 'events.reset',
        ),
      ).toBe(false)
    })

    it("to:'*' не даёт INVALID_STATE_PATH", () => {
      const result = validateConfig({
        name: 'wild2',
        stateAttribute: 'state',
        initialState: 'idle',
        states: { idle: {}, running: {} },
        events: {
          anywhere: { transitions: [{ from: 'idle', to: '*' }] },
        },
      } as any)

      expect(
        result.errors.some((e) => e.code === 'INVALID_STATE_PATH'),
      ).toBe(false)
    })
  })

  // (4) Новые проверки корректности (SPEC §1а) — сегодня НЕ ловятся.
  describe('Новые проверки корректности (§1а)', () => {
    it('REGION_STARTS_FINAL: входное состояние региона помечено final', () => {
      const result = validateConfig({
        name: 'startsFinal',
        stateAttribute: 'state',
        initialState: 'P',
        states: {
          // Область a стартует со своего ЕДИНСТВЕННОГО/входного листа run,
          // который помечен final → join смыкается немедленно, работа не идёт.
          P: { initial: 'a.run', regions: { a: { run: { final: true } } } },
          done: {},
        },
        events: {
          go: { transitions: [{ from: 'P', to: 'done' }] },
        },
      } as any)

      // HEAD: код REGION_STARTS_FINAL не существует → красный.
      expect(
        [...result.errors, ...result.warnings].some(
          (d) => d.code === 'REGION_STARTS_FINAL',
        ),
      ).toBe(true)
      expect(
        result.errors.some((e) => e.code === 'REGION_STARTS_FINAL'),
      ).toBe(true)
      expect(result.isValid).toBe(false)
    })

    it("UNSATISFIABLE_FROM: составной from называет два состояния одного региона ('P.a.x|P.a.y')", () => {
      const result = validateConfig({
        name: 'unsat',
        stateAttribute: 'state',
        initialState: 'P',
        states: {
          P: {
            initial: 'a.x',
            regions: {
              a: { x: {}, y: {} },
              b: { m: {}, n: {} },
            },
          },
          out: {},
        },
        events: {
          // область a не может быть одновременно в x И в y → невыполнимо.
          ev: { transitions: [{ from: 'P.a.x|P.a.y', to: 'out' }] },
        },
      } as any)

      // HEAD: UNSATISFIABLE_FROM не выдаётся → красный.
      expect(
        result.errors.some((e) => e.code === 'UNSATISFIABLE_FROM'),
      ).toBe(true)
      expect(result.isValid).toBe(false)
    })

    it('DUPLICATE_REGION_NAME: коллизия имени области с другим узлом в модели', () => {
      const result = validateConfig({
        name: 'dupRegion',
        stateAttribute: 'state',
        initialState: 'P',
        states: {
          // Область a композита P имеет id модели 'P.a'; корневой лист 'P.a'
          // претендует на тот же id — неразличимость «лист P.a» vs «регион-контейнер P.a»,
          // которую нормализованная модель обязана ловить (см. model.ts, getRegionKey).
          P: { regions: { a: { x: {} } } },
          'P.a': {},
        },
        events: {
          ev: { transitions: [{ from: 'P.a.x', to: 'P' }] },
        },
      } as any)

      // HEAD: коллизия молча проглатывается (isValid=true, лишь warning) → красный.
      expect(
        result.errors.some((e) => e.code === 'DUPLICATE_REGION_NAME'),
      ).toBe(true)
      expect(result.isValid).toBe(false)
    })
  })

  // (5) Политика §1а: ошибки МОДЕЛИ бросают при компиляции конфига.
  describe('Политика — ошибки модели БРОСАЮТ при компиляции', () => {
    it('createMachine с битым from БРОСАЕТ при конструкции', () => {
      const build = () =>
        createMachine(
          {
            name: 'brokenFrom',
            stateAttribute: 'state',
            initialState: 'idle',
            states: { idle: {}, running: {} },
            events: {
              // from ссылается на несуществующий путь — ошибка модели.
              go: {
                transitions: [{ from: 'nope.broken.path', to: 'running' }],
              },
            },
          } as any,
          { state: 'idle' },
        )

      // HEAD: createMachine логирует и СТРОИТ сломанную машину, не бросает → красный.
      expect(build).toThrow()
    })

    it('validateConfigStrict поднимает warning до ошибки (V10)', () => {
      // Конфиг с настоящим warning (self-transition), без ошибок модели.
      const config = {
        name: 'strict',
        stateAttribute: 'state',
        initialState: 'idle',
        states: { idle: {}, running: {} },
        events: {
          spin: { transitions: [{ from: 'idle', to: 'idle' }] }, // SELF_TRANSITION warning
        },
      } as any

      const lenient = validateConfig(config)
      // sanity: в мягком режиме это валидно с предупреждением.
      expect(lenient.warnings.some((w) => w.code === 'SELF_TRANSITION')).toBe(
        true,
      )

      const strict = validateConfigStrict(config)
      // HEAD: strictMode не поднимает warning до ошибок → strict.isValid=true → красный.
      expect(strict.isValid).toBe(false)
    })
  })
})
