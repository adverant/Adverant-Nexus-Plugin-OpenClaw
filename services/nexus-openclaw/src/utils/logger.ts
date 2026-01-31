/**
 * Structured Logging with Winston
 *
 * Provides centralized logging with:
 * - JSON format for production
 * - Context enrichment (userId, organizationId, requestId)
 * - Log rotation
 * - Multiple transports (console, file)
 */

import winston from 'winston';
// @ts-ignore - winston-daily-rotate-file types not bundled
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

// Log levels
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Environment configuration
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug');
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

// Custom format for development
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaStr}`;
  })
);

// Custom format for production (JSON)
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create transports
const transports: winston.transport[] = [
  // Console transport
  new winston.transports.Console({
    format: NODE_ENV === 'production' ? prodFormat : devFormat,
  }),
];

// Add file transports in production
if (NODE_ENV === 'production') {
  // Error log
  transports.push(
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d',
      format: prodFormat,
    })
  );

  // Combined log
  transports.push(
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: prodFormat,
    })
  );
}

// Create internal winston logger instance
const winstonLogger = winston.createLogger({
  levels: LOG_LEVELS,
  level: LOG_LEVEL,
  transports,
  exitOnError: false,
});

// Logger interface with context enrichment
export interface LogContext {
  userId?: string;
  organizationId?: string;
  requestId?: string;
  sessionId?: string;
  skillName?: string;
  channelType?: string;
  error?: Error;
  [key: string]: any;
}

export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): Logger {
    return new Logger({ ...this.context, ...context });
  }

  /**
   * Log error message
   */
  error(message: string, context: LogContext = {}): void {
    winstonLogger.error(message, { ...this.context, ...context });
  }

  /**
   * Log warning message
   */
  warn(message: string, context: LogContext = {}): void {
    winstonLogger.warn(message, { ...this.context, ...context });
  }

  /**
   * Log info message
   */
  info(message: string, context: LogContext = {}): void {
    winstonLogger.info(message, { ...this.context, ...context });
  }

  /**
   * Log debug message
   */
  debug(message: string, context: LogContext = {}): void {
    winstonLogger.debug(message, { ...this.context, ...context });
  }

  /**
   * Log with automatic level detection from error
   */
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, context: LogContext = {}): void {
    winstonLogger.log(level, message, { ...this.context, ...context });
  }
}

// Export default logger instance
export const defaultLogger = new Logger({
  service: 'nexus-openclaw',
});

// Export as 'logger' for backwards compatibility
export const logger = defaultLogger;

// Export convenience functions
export const createLogger = (context: LogContext): Logger => {
  return new Logger(context);
};

export default defaultLogger;
