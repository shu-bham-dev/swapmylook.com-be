import { createLogger } from '../utils/logger.js';
import mongoose from 'mongoose';
import { connectRedis, getRedisClient } from '../config/redis.js';
import { initQueues } from '../config/queue.js';
import { Worker } from 'bullmq';
import { processGenerationJob } from './imageProcessor.js';

const logger = createLogger('worker-main');

// Graceful shutdown handler
function setupGracefulShutdown(worker) {
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    
    try {
      // Close worker first
      if (worker) {
        await worker.close();
        logger.info('Worker closed');
      }
      
      // Close database connections
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        logger.info('MongoDB disconnected');
      }
      
      logger.info('Worker shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGQUIT', () => shutdown('SIGQUIT'));
}

// Health check endpoint for Railway
function setupHealthCheck() {
  const http = require('http');
  
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        queue: 'generate'
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  // Railway automatically provides PORT environment variable
  // Use WORKER_PORT if defined, otherwise PORT, with 3001 as fallback for local development
  const PORT = process.env.WORKER_PORT || process.env.PORT || 3001;
  server.listen(PORT, () => {
    logger.info(`Worker health check server running on port ${PORT}`);
    logger.info(`Health check endpoint: http://localhost:${PORT}/health`);
  });

  return server;
}

// Main worker startup function
async function startWorker() {
  try {
    logger.info('Starting image processor worker...');

    // Connect to MongoDB
    logger.info('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    logger.info('✅ MongoDB connected successfully');

    // Connect to Redis
    await connectRedis();
    const redisClient = getRedisClient();
    logger.info('✅ Redis connected successfully');

    // Initialize queues
    await initQueues();
    logger.info('✅ Queues initialized');

    // Create worker
    const worker = new Worker('generate', processGenerationJob, {
      connection: redisClient,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2,
      limiter: {
        max: 10,
        duration: 60000 // 1 minute
      }
    });

    // Worker event handlers
    worker.on('completed', (job, result) => {
      logger.info('Job completed', {
        jobId: job.id,
        result: typeof result === 'object' ? JSON.stringify(result) : result
      });
    });

    worker.on('failed', (job, error) => {
      logger.error('Job failed', {
        jobId: job?.id,
        error: error.message,
        stack: error.stack
      });
    });

    worker.on('error', (error) => {
      logger.error('Worker error', {
        error: error.message,
        stack: error.stack
      });
    });

    worker.on('stalled', (jobId) => {
      logger.warn('Job stalled', { jobId });
    });

    worker.on('active', (job) => {
      logger.info('Job started processing', {
        jobId: job.id,
        data: job.data
      });
    });

    // Setup graceful shutdown
    setupGracefulShutdown(worker);

    // Setup health check
    const healthServer = setupHealthCheck();

    logger.info('✅ Image processor worker started successfully', {
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2,
      port: process.env.WORKER_PORT || process.env.PORT || 3001
    });

    return { worker, healthServer };

  } catch (error) {
    logger.error('Failed to start image processor worker', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Start the worker if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker();
}

export { startWorker, setupGracefulShutdown, setupHealthCheck };