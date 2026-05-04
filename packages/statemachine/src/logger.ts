/**
 * Professional logging system for StateMachine library
 * Replaces console.log/console.error with configurable, structured logging
 */

// Log levels in order of severity
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
  OFF: 5,
} as const

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel]

// Log level names for display
export const LogLevelNames: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.FATAL]: 'FATAL',
  [LogLevel.OFF]: 'OFF',
}

// Log entry structure
export interface LogEntry {
  timestamp: number
  level: LogLevel
  message: string
  context?: Record<string, any>
  error?: Error
  source: string
}

// Logger configuration
export interface LoggerConfig {
  level: LogLevel
  enableConsole: boolean
  enableStructuredLogging: boolean
  timestampFormat: 'iso' | 'unix' | 'relative'
  includeStackTrace: boolean
}

// Default logger configuration
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  level: LogLevel.WARN, // Only warnings and above in production
  enableConsole: true,
  enableStructuredLogging: false,
  timestampFormat: 'iso',
  includeStackTrace: false,
}

// Log appender interface for extensibility
export interface LogAppender {
  append(entry: LogEntry): void
}

// Console appender implementation
export class ConsoleAppender implements LogAppender {
  private config: LoggerConfig

  constructor(config: LoggerConfig) {
    this.config = config
  }

  append(entry: LogEntry): void {
    if (!this.config.enableConsole) return

    const timestamp = this.formatTimestamp(entry.timestamp)
    const levelName = LogLevelNames[entry.level]
    const prefix = `[${timestamp}] [${levelName}] [${entry.source}]`

    if (this.config.enableStructuredLogging) {
      const structuredEntry = {
        timestamp: entry.timestamp,
        level: levelName,
        source: entry.source,
        message: entry.message,
        context: entry.context,
        error: entry.error?.message,
      }
      console.log(JSON.stringify(structuredEntry))
    } else {
      const message = `${prefix} ${entry.message}`

      switch (entry.level) {
        case LogLevel.DEBUG:
        case LogLevel.INFO:
          console.log(message, entry.context || '')
          break
        case LogLevel.WARN:
          console.warn(message, entry.context || '')
          break
        case LogLevel.ERROR:
        case LogLevel.FATAL:
          console.error(message, entry.context || '', entry.error || '')
          if (this.config.includeStackTrace && entry.error) {
            console.error(entry.error.stack)
          }
          break
      }
    }
  }

  private formatTimestamp(timestamp: number): string {
    switch (this.config.timestampFormat) {
      case 'unix':
        return timestamp.toString()
      case 'relative':
        return `+${timestamp - Date.now()}ms`
      case 'iso':
      default:
        return new Date(timestamp).toISOString()
    }
  }
}

// Memory appender for testing
export class MemoryAppender implements LogAppender {
  private entries: LogEntry[] = []

  append(entry: LogEntry): void {
    this.entries.push(entry)
  }

  getEntries(): LogEntry[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries = []
  }

  getEntriesByLevel(level: LogLevel): LogEntry[] {
    return this.entries.filter((entry) => entry.level === level)
  }
}

// Main logger class
export class Logger {
  private config: LoggerConfig
  private appenders: LogAppender[] = []
  private source: string

  constructor(source: string, config: Partial<LoggerConfig> = {}) {
    this.source = source
    this.config = { ...DEFAULT_LOGGER_CONFIG, ...config }

    // Add default console appender
    this.appenders.push(new ConsoleAppender(this.config))
  }

  // Add custom appender
  addAppender(appender: LogAppender): void {
    this.appenders.push(appender)
  }

  // Remove appender
  removeAppender(appender: LogAppender): void {
    const index = this.appenders.indexOf(appender)
    if (index > -1) {
      this.appenders.splice(index, 1)
    }
  }

  // Update configuration
  updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  // Check if level is enabled
  isLevelEnabled(level: LogLevel): boolean {
    return level >= this.config.level && this.config.level !== LogLevel.OFF
  }

  // Core logging method
  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, any>,
    error?: Error,
  ): void {
    if (!this.isLevelEnabled(level)) return

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      ...(context !== undefined ? { context } : {}),
      ...(error !== undefined ? { error } : {}),
      source: this.source,
    }

    this.appenders.forEach((appender) => {
      try {
        appender.append(entry)
      } catch (e) {
        // Fallback to console if appender fails
        console.error('Logger appender failed:', e)
      }
    })
  }

  // Convenience methods
  debug(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, context)
  }

  info(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, context)
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, context)
  }

  error(message: string, context?: Record<string, any>, error?: Error): void {
    this.log(LogLevel.ERROR, message, context, error)
  }

  fatal(message: string, context?: Record<string, any>, error?: Error): void {
    this.log(LogLevel.FATAL, message, context, error)
  }

  // Create child logger with additional context
  child(childSource: string, _additionalContext?: Record<string, any>): Logger {
    const childLogger = new Logger(`${this.source}.${childSource}`, this.config)
    childLogger.appenders = this.appenders
    return childLogger
  }
}

// Global logger factory
export class LoggerFactory {
  private static defaultConfig: LoggerConfig = DEFAULT_LOGGER_CONFIG
  private static loggers: Map<string, Logger> = new Map()

  static setDefaultConfig(config: Partial<LoggerConfig>): void {
    LoggerFactory.defaultConfig = { ...DEFAULT_LOGGER_CONFIG, ...config }
  }

  static getLogger(source: string, config?: Partial<LoggerConfig>): Logger {
    const key = source
    if (!LoggerFactory.loggers.has(key)) {
      const loggerConfig = config
        ? { ...LoggerFactory.defaultConfig, ...config }
        : LoggerFactory.defaultConfig
      LoggerFactory.loggers.set(key, new Logger(source, loggerConfig))
    }
    return LoggerFactory.loggers.get(key)!
  }

  static clearLoggers(): void {
    LoggerFactory.loggers.clear()
  }
}

// Convenience exports
export const getLogger = LoggerFactory.getLogger
export const setDefaultLogLevel = (level: LogLevel) => {
  LoggerFactory.setDefaultConfig({ level })
}

// Pre-configured loggers for common use cases
export const stateMachineLogger = getLogger('StateMachine')
export const securityLogger = getLogger('Security')
export const serializationLogger = getLogger('Serialization')
