import Redis from 'ioredis';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('redis');

// Redis connection options
const redisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 10000,
  lazyConnect: true,
  retryStrategy: (times) => {
    if (times > 10) {
      logger.error('Redis connection failed after 10 attempts');
      return null;
    }
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  }
};

// Redis clients
let redisClient = null;
let pubClient = null;
let subClient = null;

// Connection state
let isConnected = false;

/**
 * Create Redis client instance
 * @returns {Redis}
 */
function createClient() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  // Handle Railway Redis environment variable
  if (process.env.RAILWAY_REDIS_URL) {
    return new Redis(process.env.RAILWAY_REDIS_URL, redisOptions);
  }
  
  if (redisUrl.startsWith('rediss://')) {
    // SSL connection
    return new Redis(redisUrl, {
      ...redisOptions,
      tls: {
        rejectUnauthorized: false
      }
    });
  }
  
  return new Redis(redisUrl, redisOptions);
}

/**
 * Connect to Redis
 * @returns {Promise<void>}
 */
export async function connectRedis() {
  try {
    if (isConnected) {
      logger.info('Redis already connected');
      return;
    }

    // Check if Redis URL is available
    const redisUrl = process.env.REDIS_URL || process.env.RAILWAY_REDIS_URL;
    if (!redisUrl) {
      logger.warn('Redis URL not found in environment variables. Redis functionality will be disabled.');
      return;
    }

    logger.info('Connecting to Redis...');
    
    // Create main client
    redisClient = createClient();
    
    // Create pub/sub clients for different purposes
    pubClient = createClient();
    subClient = createClient();
    
    // Event handlers
    redisClient.on('connect', () => {
      logger.info('Redis client connecting...');
    });
    
    redisClient.on('ready', () => {
      isConnected = true;
      logger.info('✅ Redis connected successfully');
    });
    
    redisClient.on('error', (error) => {
      logger.error('❌ Redis connection error:', error);
      isConnected = false;
    });
    
    redisClient.on('close', () => {
      logger.warn('Redis connection closed');
      isConnected = false;
    });
    
    redisClient.on('reconnecting', () => {
      logger.info('Redis reconnecting...');
    });
    
    // Wait for connection with timeout
    await Promise.race([
      redisClient.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout')), 10000)
      )
    ]);
    
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    logger.warn('Redis connection failed. Application will continue without Redis functionality.');
    // Don't throw error - allow application to continue without Redis
    isConnected = false;
  }
}

/**
 * Disconnect from Redis
 * @returns {Promise<void>}
 */
export async function disconnectRedis() {
  try {
    if (redisClient) {
      await redisClient.quit();
    }
    if (pubClient) {
      await pubClient.quit();
    }
    if (subClient) {
      await subClient.quit();
    }
    logger.info('Redis disconnected successfully');
    isConnected = false;
  } catch (error) {
    logger.error('Error disconnecting from Redis:', error);
    throw error;
  }
}

/**
 * Get Redis connection status
 * @returns {boolean}
 */
export function getRedisStatus() {
  return isConnected;
}

/**
 * Get Redis client instance
 * @returns {Redis}
 */
export function getRedisClient() {
  if (!redisClient) {
    throw new Error('Redis client not initialized');
  }
  return redisClient;
}

/**
 * Get Redis pub client for publishing
 * @returns {Redis}
 */
export function getPubClient() {
  if (!pubClient) {
    throw new Error('Redis pub client not initialized');
  }
  return pubClient;
}

/**
 * Get Redis sub client for subscribing
 * @returns {Redis}
 */
export function getSubClient() {
  if (!subClient) {
    throw new Error('Redis sub client not initialized');
  }
  return subClient;
}

/**
 * Health check for Redis
 * @returns {Promise<{status: string, timestamp: Date, responseTime: number}>}
 */
export async function healthCheck() {
  const startTime = Date.now();
  
  try {
    if (!isConnected) {
      throw new Error('Redis not connected');
    }
    
    const result = await redisClient.ping();
    const responseTime = Date.now() - startTime;
    
    if (result !== 'PONG') {
      throw new Error('Redis ping returned unexpected response');
    }
    
    return {
      status: 'healthy',
      timestamp: new Date(),
      responseTime
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    return {
      status: 'unhealthy',
      timestamp: new Date(),
      responseTime,
      error: error.message
    };
  }
}

/**
 * Get Redis statistics
 * @returns {Promise<Object>}
 */
export async function getRedisStats() {
  try {
    if (!isConnected) {
      throw new Error('Redis not connected');
    }
    
    const info = await redisClient.info();
    const stats = {};
    
    // Parse Redis INFO command output
    info.split('\r\n').forEach(line => {
      if (line && !line.startsWith('#')) {
        const [key, value] = line.split(':');
        if (key && value) {
          stats[key.trim()] = value.trim();
        }
      }
    });
    
    return {
      connected: isConnected,
      version: stats.redis_version,
      mode: stats.redis_mode,
      os: stats.os,
      uptime: stats.uptime_in_seconds,
      connected_clients: stats.connected_clients,
      used_memory: stats.used_memory_human,
      total_commands_processed: stats.total_commands_processed
    };
  } catch (error) {
    logger.error('Error getting Redis stats:', error);
    return {
      connected: isConnected,
      error: error.message
    };
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  try {
    await disconnectRedis();
    process.exit(0);
  } catch (error) {
    logger.error('Error during Redis shutdown:', error);
    process.exit(1);
  }
});

export default {
  connectRedis,
  disconnectRedis,
  getRedisStatus,
  getRedisClient,
  getPubClient,
  getSubClient,
  healthCheck,
  getRedisStats
};