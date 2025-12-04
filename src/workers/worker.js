import { createLogger } from '../utils/logger.js';
import mongoose from 'mongoose';
import { connectRedis, getRedisClient } from '../config/redis.js';
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

    // Create worker
    const worker = new Worker('generate', processGenerationJob, {
      connection: redisClient,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2,
      pollInterval: 5000, // Reduce Redis polling frequency
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

    logger.info('✅ Image processor worker started successfully', {
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2
    });

    return { worker };

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

export { startWorker, setupGracefulShutdown };