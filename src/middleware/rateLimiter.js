import { createLogger } from '../utils/logger.js';
import { RateLimitError } from './errorHandler.js';

const logger = createLogger('rateLimiter');

// Rate limit configurations (kept for reference but not used)
const rateLimitConfigs = {
  // Global rate limit for all requests
  global: {
    points: 1000,
    duration: 3600,
    blockDuration: 300,
  },
  
  // Authentication endpoints
  auth: {
    points: 10,
    duration: 300,
    blockDuration: 900,
  },
  
  // File upload endpoints
  upload: {
    points: 50,
    duration: 3600,
    blockDuration: 600,
  },
  
  // Generation endpoints (AI processing)
  generate: {
    points: parseInt(process.env.RATE_LIMIT_PER_HOUR) || 100,
    duration: 3600,
    blockDuration: 1800,
  },
  
  // API endpoints
  api: {
    points: 500,
    duration: 3600,
    blockDuration: 300,
  }
};

/**
 * Default key generator for rate limiting (no-op)
 */
function defaultKeyGenerator(req) {
  // Use user ID if authenticated, otherwise IP address
  if (req.user && req.user.id) {
    return `user:${req.user.id}`;
  }
  
  // Fallback to IP address
  const ip = req.ip || 
             req.connection.remoteAddress || 
             req.socket.remoteAddress ||
             (req.connection.socket ? req.connection.socket.remoteAddress : null);
  
  return `ip:${ip}`;
}

/**
 * Set rate limit headers in response (no-op)
 */
function setRateLimitHeaders(res, rateLimitRes, endpoint) {
  // No headers set
}

/**
 * Get rate limit information for a user/IP (no-op)
 */
export async function getRateLimitInfo(key, endpoint = 'api') {
  logger.warn('Rate limiting is disabled, returning unlimited info');
  return {
    limit: rateLimitConfigs[endpoint]?.points || 100,
    remaining: 1000,
    reset: new Date(Date.now() + 3600000),
    blocked: false
  };
}

/**
 * Reset rate limit for a specific key (no-op)
 */
export async function resetRateLimit(key, endpoint = 'api') {
  logger.warn('Rate limiting is disabled, reset does nothing');
  return true;
}

/**
 * Middleware to check if user has available quota
 */
export function quotaCheck() {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next();
      }
      
      // Check if user has available quota
      const hasQuota = await req.user.hasAvailableQuota();
      
      if (!hasQuota) {
        logger.warn('Quota exceeded', {
          userId: req.user.id,
          email: req.user.email
        });
        
        return next(new RateLimitError(
          'Monthly generation quota exceeded. Please upgrade your plan or wait until next month.'
        ));
      }
      
      next();
    } catch (error) {
      logger.error('Error checking quota', {
        error: error.message,
        userId: req.user?.id
      });
      
      next(error);
    }
  };
}

/**
 * Middleware to increment usage after successful operation
 */
export function usageTracker(type = 'generation', amount = 1) {
  return async (req, res, next) => {
    // Store original send function
    const originalSend = res.send;
    
    // Override send function to track usage after response
    res.send = function(body) {
      try {
        // Only track usage for successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (req.user && type === 'generation') {
            // Increment user's usage counter
            req.user.incrementUsage().catch(error => {
              logger.error('Error incrementing usage', {
                error: error.message,
                userId: req.user.id
              });
            });
          }
          
          // TODO: Log to audit system
        }
      } catch (error) {
        logger.error('Error in usage tracker', {
          error: error.message,
          userId: req.user?.id
        });
      }
      
      // Call original send function
      return originalSend.call(this, body);
    };
    
    next();
  };
}

// Rate limiters are disabled, but we keep the exported functions for compatibility
let rateLimitersInitialized = true;

export function initRateLimiters() {
  logger.info('Rate limiting is disabled (Redis removed)');
  rateLimitersInitialized = true;
}

export function createRateLimiter(endpoint, options = {}) {
  const keyGenerator = options.keyGenerator || defaultKeyGenerator;
  
  return async (req, res, next) => {
    // No rate limiting, just pass through
    logger.debug('Rate limiting disabled for endpoint', { endpoint, key: keyGenerator(req) });
    next();
  };
}

// Pre-configured rate limiters (no-op)
export const globalRateLimiter = createRateLimiter('global');
export const authRateLimiter = createRateLimiter('auth');
export const uploadRateLimiter = createRateLimiter('upload');
export const generateRateLimiter = createRateLimiter('generate');
export const apiRateLimiter = createRateLimiter('api');

export default {
  initRateLimiters,
  createRateLimiter,
  getRateLimitInfo,
  resetRateLimit,
  quotaCheck,
  usageTracker,
  globalRateLimiter,
  authRateLimiter,
  uploadRateLimiter,
  generateRateLimiter,
  apiRateLimiter
};