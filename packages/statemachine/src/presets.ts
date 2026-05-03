import type { ValidationConfig } from './config_validator'
import { LogLevel } from './logger'
import type { MonitoringConfig } from './monitoring'

export interface PresetConfig {
  logger?: {
    level: LogLevel
    enableStructuredLogging?: boolean
  }
  monitoring?: Partial<MonitoringConfig>
  validation?: Partial<ValidationConfig>
}

export const Presets = {
  /**
   * Максимальная производительность, минимум логов.
   * Идеально для клиентской части (SPA).
   */
  Frontend: {
    logger: {
      level: LogLevel.WARN,
      enableStructuredLogging: false,
    },
    monitoring: {
      enabled: true, // Включаем, но с мягкими лимитами
      metricsInterval: 60000, // Раз в минуту (экономим сеть/батарею)
      healthCheckInterval: 0, // Выключено на клиенте
      thresholds: {
        transitionTimeWarning: 100, // 100ms ок для логики
        transitionTimeCritical: 500, // Блокировка UI
        errorRateWarning: 10,
        errorRateCritical: 30,
      },
    },
    validation: {
      strictMode: false,
      validateTransitionPaths: false, // Экономим время старта
    },
  } as PresetConfig,

  /**
   * Полный контроль, JSON-логи, метрики.
   * Идеально для Node.js / Microservices.
   */
  Backend: {
    logger: {
      level: LogLevel.INFO,
      enableStructuredLogging: true,
    },
    monitoring: {
      enabled: true,
      metricsInterval: 5000, // Каждые 5 сек (Prometheus-совместимый экспорт)
      healthCheckInterval: 15000,
      thresholds: {
        transitionTimeWarning: 50, // На сервере должно быть быстрее
        transitionTimeCritical: 200,
        errorRateWarning: 1, // Строже к ошибкам
        errorRateCritical: 5,
      },
    },
    validation: {
      strictMode: true,
      validateTransitionPaths: true,
    },
  } as PresetConfig,

  /**
   * Режим отладки: все проверки включены, подробные логи.
   */
  Debug: {
    logger: {
      level: LogLevel.DEBUG,
      enableStructuredLogging: false,
    },
    monitoring: {
      enabled: true,
      healthCheckInterval: 1000,
    },
    validation: {
      strictMode: true,
      validateActionReferences: true,
    },
  } as PresetConfig,
}
