import express from 'express';
import { healthCheck as dbHealthCheck } from '../config/database.js';
import { healthCheck as redisHealthCheck } from '../config/redis.js';
import { getStorageStats } from '../config/storage.js';
import { getQueueMetrics } from '../config/queue.js';
import { createLogger } from '../utils/logger.js';

/**
 * @swagger
 * tags:
 *   name: Health
 *   description: Service health and monitoring endpoints
 */

const router = express.Router();
const logger = createLogger('health-routes');

/**
 * @swagger
 * /api/v1/health:
 *   get:
 *     summary: Comprehensive health check
 *     description: Check the health status of all service dependencies
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [healthy, degraded]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 responseTime:
 *                   type: string
 *                 version:
 *                   type: string
 *                 environment:
 *                   type: string
 *                 dependencies:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: object
 *                     redis:
 *                       type: object
 *                     storage:
 *                       type: object
 *                     queue:
 *                       type: object
 *       503:
 *         description: Service is degraded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [degraded]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 responseTime:
 *                   type: string
 *                 dependencies:
 *                   type: object
 *       500:
 *         description: Health check failed unexpectedly
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [unhealthy]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 error:
 *                   type: string
 */
router.get('/', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Check all dependencies
    const [dbStatus, redisStatus, storageStatus, queueStatus] = await Promise.allSettled([
      dbHealthCheck(),
      redisHealthCheck(),
      getStorageStats(),
      getQueueMetrics()
    ]);

    const dependencies = {
      database: dbStatus.status === 'fulfilled' ? dbStatus.value : { status: 'unhealthy', error: dbStatus.reason.message },
      redis: redisStatus.status === 'fulfilled' ? redisStatus.value : { status: 'unhealthy', error: redisStatus.reason.message },
      storage: storageStatus.status === 'fulfilled' ? storageStatus.value : { status: 'unhealthy', error: storageStatus.reason.message },
      queue: queueStatus.status === 'fulfilled' ? queueStatus.value : { status: 'unhealthy', error: queueStatus.reason.message }
    };

    // Determine overall status
    const allHealthy = Object.values(dependencies).every(
      dep => dep.status === 'healthy' || (typeof dep === 'object' && dep.status === 'healthy')
    );

    const responseTime = Date.now() - startTime;

    const response = {
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      responseTime: `${responseTime}ms`,
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      dependencies
    };

    // Log health check
    if (!allHealthy) {
      logger.warn('Health check degraded', {
        responseTime,
        unhealthyServices: Object.entries(dependencies)
          .filter(([_, dep]) => dep.status !== 'healthy')
          .map(([service]) => service)
      });
    }

    res.status(allHealthy ? 200 : 503).json(response);
  } catch (error) {
    const responseTime = Date.now() - startTime;
    logger.error('Health check failed', {
      error: error.message,
      responseTime
    });

    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      responseTime: `${responseTime}ms`,
      error: 'Health check failed unexpectedly',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @swagger
 * /api/v1/health/liveness:
 *   get:
 *     summary: Liveness probe
 *     description: Basic service availability check - used by Kubernetes/container orchestration
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is alive
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [alive]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get('/liveness', (req, res) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString()
  });
});

/**
 * @swagger
 * /api/v1/health/readiness:
 *   get:
 *     summary: Readiness probe
 *     description: Check if service is ready to accept traffic - essential dependencies available
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [ready]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 services:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: string
 *                     redis:
 *                       type: string
 *       503:
 *         description: Service is not ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [not_ready]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 services:
 *                   type: object
 */
router.get('/readiness', async (req, res) => {
  try {
    // Basic checks for essential services
    const [dbReady, redisReady] = await Promise.allSettled([
      dbHealthCheck(),
      redisHealthCheck()
    ]);

    const isReady = dbReady.status === 'fulfilled' && 
                   dbReady.value.status === 'healthy' &&
                   redisReady.status === 'fulfilled' &&
                   redisReady.value.status === 'healthy';

    if (isReady) {
      res.json({
        status: 'ready',
        timestamp: new Date().toISOString(),
        services: {
          database: 'connected',
          redis: 'connected'
        }
      });
    } else {
      res.status(503).json({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        services: {
          database: dbReady.status === 'fulfilled' ? dbReady.value.status : 'error',
          redis: redisReady.status === 'fulfilled' ? redisReady.value.status : 'error'
        }
      });
    }
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: 'Readiness check failed'
    });
  }
});

/**
 * @swagger
 * /api/v1/health/metrics:
 *   get:
 *     summary: Service metrics
 *     description: Get detailed service metrics and performance statistics
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Metrics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 uptime:
 *                   type: number
 *                   format: float
 *                 memory:
 *                   type: object
 *                   properties:
 *                     rss:
 *                       type: integer
 *                     heapTotal:
 *                       type: integer
 *                     heapUsed:
 *                       type: integer
 *                     external:
 *                       type: integer
 *                 storage:
 *                   type: object
 *                 queue:
 *                   type: object
 *                 database:
 *                   type: object
 *                 redis:
 *                   type: object
 *       500:
 *         description: Failed to collect metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get('/metrics', async (req, res) => {
  try {
    const [
      dbStats,
      redisStats,
      storageStats,
      queueMetrics,
      memoryUsage
    ] = await Promise.allSettled([
      // Database statistics
      Promise.resolve({}), // Placeholder - would implement actual DB stats
      
      // Redis statistics  
      Promise.resolve({}), // Placeholder
      
      // Storage statistics
      getStorageStats(),
      
      // Queue metrics
      getQueueMetrics(),
      
      // Memory usage
      Promise.resolve(process.memoryUsage())
    ]);

    const metrics = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: memoryUsage.status === 'fulfilled' ? {
        rss: Math.round(memoryUsage.value.rss / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.value.heapTotal / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.value.heapUsed / 1024 / 1024),
        external: Math.round(memoryUsage.value.external / 1024 / 1024)
      } : null,
      storage: storageStats.status === 'fulfilled' ? storageStats.value : null,
      queue: queueMetrics.status === 'fulfilled' ? queueMetrics.value : null,
      database: dbStats.status === 'fulfilled' ? dbStats.value : null,
      redis: redisStats.status === 'fulfilled' ? redisStats.value : null
    };

    res.json(metrics);
  } catch (error) {
    logger.error('Metrics collection failed', { error: error.message });
    res.status(500).json({
      error: 'Failed to collect metrics',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * @swagger
 * /api/v1/health/info:
 *   get:
 *     summary: Service information
 *     description: Get service information and configuration details
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 service:
 *                   type: string
 *                 version:
 *                   type: string
 *                 environment:
 *                   type: string
 *                 nodeVersion:
 *                   type: string
 *                 platform:
 *                   type: string
 *                 arch:
 *                   type: string
 *                 pid:
 *                   type: integer
 *                 uptime:
 *                   type: integer
 *                 memory:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: string
 *                     heap:
 *                       type: string
 *                 config:
 *                   type: object
 *                 timestamps:
 *                   type: object
 */
router.get('/info', (req, res) => {
  const info = {
    service: 'SwapMyLook API',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    memory: {
      total: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    },
    config: {
      storageProvider: process.env.STORAGE_PROVIDER || 'b2',
      rateLimit: process.env.RATE_LIMIT_PER_HOUR || 100,
      maxFileSize: process.env.MAX_FILE_SIZE || '10MB'
    },
    timestamps: {
      current: new Date().toISOString(),
      started: new Date(Date.now() - process.uptime() * 1000).toISOString()
    }
  };

  res.json(info);
});

/**
 * @swagger
 * /api/v1/health/dependencies:
 *   get:
 *     summary: Detailed dependency health
 *     description: Get detailed health information for all external dependencies
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Dependency health retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 dependencies:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       type:
 *                         type: string
 *                       status:
 *                         type: string
 *                       responseTime:
 *                         type: number
 *                       details:
 *                         type: object
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                 overallStatus:
 *                   type: string
 *       500:
 *         description: Failed to check dependencies
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get('/dependencies', async (req, res) => {
  try {
    const dependencies = await checkAllDependencies();
    res.json(dependencies);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check dependencies',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Check all external dependencies
 */
async function checkAllDependencies() {
  const checks = [
    {
      name: 'MongoDB',
      type: 'database',
      check: async () => {
        const result = await dbHealthCheck();
        return {
          status: result.status,
          responseTime: result.responseTime,
          details: result.error ? { error: result.error } : undefined
        };
      }
    },
    {
      name: 'Redis',
      type: 'cache/queue',
      check: async () => {
        const result = await redisHealthCheck();
        return {
          status: result.status,
          responseTime: result.responseTime,
          details: result.error ? { error: result.error } : undefined
        };
      }
    },
    {
      name: 'Object Storage',
      type: 'storage',
      check: async () => {
        try {
          const stats = await getStorageStats();
          return {
            status: 'healthy',
            details: stats
          };
        } catch (error) {
          return {
            status: 'unhealthy',
            details: { error: error.message }
          };
        }
      }
    },
    {
      name: 'Job Queue',
      type: 'queue',
      check: async () => {
        try {
          const metrics = await getQueueMetrics();
          return {
            status: 'healthy',
            details: metrics
          };
        } catch (error) {
          return {
            status: 'unhealthy',
            details: { error: error.message }
          };
        }
      }
    }
  ];

  const results = await Promise.all(
    checks.map(async (check) => {
      try {
        const result = await check.check();
        return {
          name: check.name,
          type: check.type,
          status: result.status,
          responseTime: result.responseTime,
          details: result.details,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          name: check.name,
          type: check.type,
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    })
  );

  return {
    timestamp: new Date().toISOString(),
    dependencies: results,
    overallStatus: results.every(dep => dep.status === 'healthy') ? 'healthy' : 'degraded'
  };
}

export default router;