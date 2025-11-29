import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getRedisClient } from '../config/redis.js';
import { createLogger } from '../utils/logger.js';
import { RateLimitError } from './errorHandler.js';

const logger = createLogger('rateLimiter');

// Rate limit configurations
const rateLimitConfigs = {
  // Global rate limit for all requests
  global: {
    points: 1000, // Total requests
    duration: 3600, // Per hour
    blockDuration: 300, // Block for 5 minutes if exceeded
  },
  
  // Authentication endpoints
  auth: {
    points: 10, // Login attempts
    duration: 300, // Per 5 minutes
    blockDuration: 900, // Block for 15 minutes if exceeded
  },
  
  // File upload endpoints
  upload: {
    points: 50, // Upload requests
    duration: 3600, // Per hour
    blockDuration: 600, // Block for 10 minutes if exceeded
  },
  
  // Generation endpoints (AI processing)
  generate: {
    points: parseInt(process.env.RATE_LIMIT_PER_HOUR) || 100, // Generations
    duration: 3600, // Per hour
    blockDuration: 1800, // Block for 30 minutes if exceeded
  },
  
  // API endpoints
  api: {
    points: 500, // General API requests
    duration: 3600, // Per hour
    blockDuration: 300, // Block for 5 minutes if exceeded
  }
};

// Rate limiter instances
const rateLimiters = {};


/**
 * Default key generator for rate limiting
 * @param {Object} req - Express request
 * @returns {string} - Rate limit key
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
 * Set rate limit headers in response
 * @param {Object} res - Express response
 * @param {Object} rateLimitRes - Rate limit response
 * @param {string} endpoint - Endpoint type
 */
function setRateLimitHeaders(res, rateLimitRes, endpoint) {
  res.setHeader('X-RateLimit-Limit', rateLimitConfigs[endpoint]?.points || 100);
  res.setHeader('X-RateLimit-Remaining', rateLimitRes.remainingPoints);
  res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimitRes.msBeforeNext).toISOString());
  
  if (rateLimitRes.consumedPoints > rateLimitRes.remainingPoints) {
    res.setHeader('Retry-After', Math.ceil(rateLimitRes.msBeforeNext / 1000));
  }
}

/**
 * Get rate limit information for a user/IP
 * @param {string} key - Rate limit key
 * @param {string} endpoint - Endpoint type
 * @returns {Promise<Object>} - Rate limit info
 */
export async function getRateLimitInfo(key, endpoint = 'api') {
  try {
    const limiter = getLimiter(endpoint);
    const rateLimitRes = await limiter.get(key);
    
    return {
      limit: rateLimitConfigs[endpoint]?.points || 100,
      remaining: rateLimitRes?.remainingPoints || 0,
      reset: rateLimitRes ? new Date(Date.now() + rateLimitRes.msBeforeNext) : new Date(),
      blocked: rateLimitRes?.remainingPoints === 0
    };
  } catch (error) {
    logger.error('Error getting rate limit info', {
      error: error.message,
      key,
      endpoint
    });
    
    return {
      limit: rateLimitConfigs[endpoint]?.points || 100,
      remaining: 0,
      reset: new Date(),
      blocked: false,
      error: error.message
    };
  }
}

/**
 * Reset rate limit for a specific key
 * @param {string} key - Rate limit key
 * @param {string} endpoint - Endpoint type
 * @returns {Promise<boolean>} - Success status
 */
export async function resetRateLimit(key, endpoint = 'api') {
  try {
    const limiter = getLimiter(endpoint);
    await limiter.delete(key);
    
    logger.info('Rate limit reset', {
      key,
      endpoint
    });
    
    return true;
  } catch (error) {
    logger.error('Error resetting rate limit', {
      error: error.message,
      key,
      endpoint
    });
    
    return false;
  }
}

/**
 * Middleware to check if user has available quota
 * @returns {Function} - Express middleware
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
 * @param {string} type - Usage type
 * @param {number} amount - Amount to increment
 * @returns {Function} - Express middleware
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

// Pre-configured rate limiters for common endpoints (lazy initialization)
let rateLimitersInitialized = false;

function getRateLimiter(endpoint) {
  if (!rateLimitersInitialized) {
    throw new Error(`Rate limiters not initialized yet. Call initRateLimiters() first.`);
  }
  const limiter = rateLimiters[endpoint] || rateLimiters.api;
  if (!limiter) {
    throw new Error(`Rate limiter for ${endpoint} not initialized`);
  }
  return limiter;
}

export function createRateLimiter(endpoint, options = {}) {
  const keyGenerator = options.keyGenerator || defaultKeyGenerator;
  
  return async (req, res, next) => {
    try {
      if (!rateLimitersInitialized) {
        // Rate limiters not ready yet, allow the request
        next();
        return;
      }
      
      const limiter = getRateLimiter(endpoint);
      const key = keyGenerator(req);
      const rateLimitRes = await limiter.consume(key);
      
      // Set rate limit headers
      setRateLimitHeaders(res, rateLimitRes, endpoint);
      
      next();
    } catch (error) {
      if (error.message.includes('not initialized')) {
        // Rate limiters not ready yet, allow the request
        next();
        return;
      }
      
      // Rate limit exceeded
      if (error.remainingPoints !== undefined) {
        setRateLimitHeaders(res, error, endpoint);
        
        const retryAfter = Math.ceil(error.msBeforeNext / 1000);
        const rateLimitError = new RateLimitError(
          `Rate limit exceeded. Try again in ${retryAfter} seconds.`
        );
        
        logger.warn('Rate limit exceeded', {
          endpoint,
          key: keyGenerator(req),
          ip: req.ip,
          userId: req.user?.id,
          retryAfter
        });
        
        next(rateLimitError);
      } else {
        // Other error, allow the request
        logger.warn('Rate limiter error, allowing request', {
          error: error.message,
          endpoint
        });
        next();
      }
    }
  };
}

// Initialize rate limiters and mark as ready
export async function initRateLimiters() {
  try {
    const redisClient = getRedisClient();
    
    Object.keys(rateLimitConfigs).forEach(key => {
      const config = rateLimitConfigs[key];
      
      rateLimiters[key] = new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: `rate_limit:${key}`,
        points: config.points,
        duration: config.duration,
        blockDuration: config.blockDuration,
        execEvenly: false
      });
    });
    
    rateLimitersInitialized = true;
    logger.info('Rate limiters initialized');
  } catch (error) {
    logger.warn('Failed to initialize rate limiters, continuing without rate limiting:', error.message);
    // Continue without rate limiting rather than crashing the app
    rateLimitersInitialized = false;
  }
}

// Pre-configured rate limiters for common endpoints
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