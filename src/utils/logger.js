import winston from 'winston';
import 'winston-daily-rotate-file';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaString = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const stackString = stack ? `\n${stack}` : '';
  return `${timestamp} [${level}]: ${message}${metaString}${stackString}`;
});

// Log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Colors for different log levels
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(colors);

// Create a logger instance
function createLogger(moduleName = 'app') {
  const transports = [
    // Console transport for development
    new winston.transports.Console({
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        logFormat
      ),
    }),
  ];

  // File transport for production
  if (process.env.NODE_ENV === 'production') {
    transports.push(
      new winston.transports.DailyRotateFile({
        filename: 'logs/application-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
        level: 'info',
        format: combine(
          timestamp(),
          errors({ stack: true }),
          logFormat
        ),
      })
    );

    // Error logs in separate file
    transports.push(
      new winston.transports.DailyRotateFile({
        filename: 'logs/error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '30d',
        level: 'error',
        format: combine(
          timestamp(),
          errors({ stack: true }),
          logFormat
        ),
      })
    );
  }

  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    levels,
    defaultMeta: { module: moduleName },
    format: combine(
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      errors({ stack: true }),
      logFormat
    ),
    transports,
    exceptionHandlers: [
      new winston.transports.File({ filename: 'logs/exceptions.log' }),
    ],
    rejectionHandlers: [
      new winston.transports.File({ filename: 'logs/rejections.log' }),
    ],
  });

  // Create logs directory if it doesn't exist
  if (process.env.NODE_ENV === 'production') {
    const fs = require('fs');
    const path = require('path');
    const logsDir = path.join(process.cwd(), 'logs');
    
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  }

  return logger;
}

// Global application logger
const appLogger = createLogger('app');

// Request logging middleware
function requestLogger() {
  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const logData = {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent'),
      };

      if (res.statusCode >= 400) {
        appLogger.warn('HTTP Request', logData);
      } else {
        appLogger.http('HTTP Request', logData);
      }
    });

    next();
  };
}

// Error logging utility
function logError(error, context = {}) {
  appLogger.error('Application Error', {
    error: error.message,
    stack: error.stack,
    ...context,
  });
}

// Performance logging
function logPerformance(operation, duration, metadata = {}) {
  appLogger.debug('Performance', {
    operation,
    duration: `${duration}ms`,
    ...metadata,
  });
}

// Database query logging
function logQuery(query, duration, collection) {
  if (process.env.LOG_QUERIES === 'true') {
    appLogger.debug('Database Query', {
      collection,
      query: typeof query === 'object' ? JSON.stringify(query) : query,
      duration: `${duration}ms`,
    });
  }
}

// Audit logging
function logAudit(action, userId, resourceType, resourceId, details = {}) {
  appLogger.info('Audit Log', {
    action,
    userId,
    resourceType,
    resourceId,
    ...details,
  });
}

export {
  createLogger,
  requestLogger,
  logError,
  logPerformance,
  logQuery,
  logAudit,
  appLogger as logger,
};

export default createLogger;