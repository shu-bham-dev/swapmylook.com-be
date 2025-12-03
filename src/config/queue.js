import { Queue as BullQueue, Worker } from 'bullmq';
import { getRedisClient } from './redis.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('queue');

// Queue instances
const queues = new Map();

/**
 * Initialize job queues
 */
export function initQueues() {
  try {
    const redisClient = getRedisClient();
    
    // Main generation queue
    const generateQueue = new BullQueue('generate', {
      connection: redisClient,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 30000 // 30 seconds
        },
        removeOnComplete: {
          age: 24 * 3600, // keep completed jobs for 24 hours
          count: 1000 // keep up to 1000 completed jobs
        },
        removeOnFail: {
          age: 7 * 24 * 3600 // keep failed jobs for 7 days
        }
      }
    });

    queues.set('generate', generateQueue);

    logger.info('Job queues initialized');
    return queues;
  } catch (error) {
    logger.warn('Queue initialization failed (Redis not available):', error.message);
    // Return empty queues map to prevent crashes
    return queues;
  }
}

/**
 * Get queue by name
 * @param {string} name - Queue name
 * @returns {BullQueue} - Queue instance
 */
export function getQueue(name = 'generate') {
  const queue = queues.get(name);
  if (!queue) {
    // Return a mock queue that doesn't do anything
    logger.warn(`Queue ${name} not initialized (Redis unavailable)`);
    return {
      add: () => Promise.reject(new Error('Redis unavailable - queues disabled')),
      getJob: () => Promise.reject(new Error('Redis unavailable - queues disabled')),
      getWaitingCount: () => Promise.resolve(0),
      getActiveCount: () => Promise.resolve(0),
      getCompletedCount: () => Promise.resolve(0),
      getFailedCount: () => Promise.resolve(0),
      getDelayedCount: () => Promise.resolve(0),
      getPausedCount: () => Promise.resolve(0),
      clean: () => Promise.resolve([]),
      pause: () => Promise.resolve(),
      resume: () => Promise.resolve(),
      obliterate: () => Promise.resolve(),
      getJobCounts: () => Promise.resolve({}),
      close: () => Promise.resolve()
    };
  }
  return queue;
}

/**
 * Add job to queue
 * @param {string} queueName - Queue name
 * @param {string} jobName - Job name
 * @param {Object} data - Job data
 * @param {Object} options - Job options
 * @returns {Promise<Job>} - Added job
 */
export async function add(queueName, jobName, data, options = {}) {
  const queue = getQueue(queueName);
  return queue.add(jobName, data, options);
}

/**
 * Get job by ID
 * @param {string} queueName - Queue name
 * @param {string} jobId - Job ID
 * @returns {Promise<Job>} - Job instance
 */
export async function getJob(queueName, jobId) {
  const queue = getQueue(queueName);
  return queue.getJob(jobId);
}

/**
 * Get queue metrics
 * @param {string} queueName - Queue name
 * @returns {Promise<Object>} - Queue metrics
 */
export async function getQueueMetrics(queueName = 'generate') {
  const queue = getQueue(queueName);
  
  const [
    waiting,
    active,
    completed,
    failed,
    delayed,
    paused
  ] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
    queue.getPausedCount()
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    paused,
    total: waiting + active + completed + failed + delayed + paused
  };
}

/**
 * Clean old jobs from queue
 * @param {string} queueName - Queue name
 * @param {number} maxAge - Maximum age in hours
 * @returns {Promise<Object>} - Cleanup results
 */
export async function cleanQueue(queueName = 'generate', maxAge = 24) {
  const queue = getQueue(queueName);
  
  const completed = await queue.clean(
    maxAge * 3600 * 1000, // Convert hours to milliseconds
    1000,
    'completed'
  );

  const failed = await queue.clean(
    maxAge * 3600 * 1000,
    1000,
    'failed'
  );

  logger.info('Queue cleanup completed', {
    queue: queueName,
    maxAge,
    completedRemoved: completed.length,
    failedRemoved: failed.length
  });

  return { completed, failed };
}

/**
 * Pause queue
 * @param {string} queueName - Queue name
 * @returns {Promise<void>}
 */
export async function pauseQueue(queueName = 'generate') {
  const queue = getQueue(queueName);
  await queue.pause();
  logger.info('Queue paused', { queue: queueName });
}

/**
 * Resume queue
 * @param {string} queueName - Queue name
 * @returns {Promise<void>}
 */
export async function resumeQueue(queueName = 'generate') {
  const queue = getQueue(queueName);
  await queue.resume();
  logger.info('Queue resumed', { queue: queueName });
}

/**
 * Empty queue (remove all jobs)
 * @param {string} queueName - Queue name
 * @returns {Promise<void>}
 */
export async function emptyQueue(queueName = 'generate') {
  const queue = getQueue(queueName);
  await queue.obliterate({ force: true });
  logger.info('Queue emptied', { queue: queueName });
}

/**
 * Get job counts by status
 * @param {string} queueName - Queue name
 * @returns {Promise<Object>} - Job counts
 */
export async function getJobCounts(queueName = 'generate') {
  const queue = getQueue(queueName);
  return queue.getJobCounts();
}

/**
 * Create worker for queue
 * @param {string} queueName - Queue name
 * @param {Function} processor - Job processor function
 * @param {Object} options - Worker options
 * @returns {Worker} - Worker instance
 */
export function createWorker(queueName, processor, options = {}) {
  try {
    const redisClient = getRedisClient();
    
    const worker = new Worker(queueName, processor, {
      connection: redisClient,
      concurrency: options.concurrency || 1,
      limiter: options.limiter,
      pollInterval: 5000, // Reduce Redis polling frequency
      ...options
    });

    worker.on('completed', (job, result) => {
      logger.info('Job completed', {
        queue: queueName,
        jobId: job.id,
        result: typeof result === 'object' ? JSON.stringify(result) : result
      });
    });

    worker.on('failed', (job, error) => {
      logger.error('Job failed', {
        queue: queueName,
        jobId: job?.id,
        error: error.message,
        stack: error.stack
      });
    });

    worker.on('error', (error) => {
      logger.error('Worker error', {
        queue: queueName,
        error: error.message,
        stack: error.stack
      });
    });

    worker.on('stalled', (jobId) => {
      logger.warn('Job stalled', {
        queue: queueName,
        jobId
      });
    });

    logger.info('Worker created', { queue: queueName });
    return worker;
  } catch (error) {
    logger.warn('Worker creation failed (Redis unavailable):', error.message);
    // Return a mock worker that doesn't do anything
    return {
      on: () => {},
      close: () => Promise.resolve()
    };
  }
}

/**
 * Graceful shutdown for queues
 */
export async function shutdownQueues() {
  for (const [name, queue] of queues) {
    try {
      await queue.close();
      logger.info('Queue closed', { queue: name });
    } catch (error) {
      logger.error('Error closing queue', {
        queue: name,
        error: error.message
      });
    }
  }
}

// Initialize queues on import - but only if Redis is available
let queueInitialized = false;

async function initializeQueueSystem() {
  if (queueInitialized) return;
  
  try {
    // Check if Redis client is available before initializing queues
    getRedisClient();
    initQueues();
    queueInitialized = true;
    logger.info('Queue system initialized');
  } catch (error) {
    logger.warn('Queue initialization deferred (Redis not ready yet)', {
      error: error.message
    });
    // Retry after 1 second
    setTimeout(initializeQueueSystem, 1000);
  }
}

if (process.env.NODE_ENV !== 'test') {
  initializeQueueSystem();
}

// Graceful shutdown
process.on('SIGINT', async () => {
  await shutdownQueues();
});

process.on('SIGTERM', async () => {
  await shutdownQueues();
});

export const Queue = {
  add: (jobName, data, options) => add('generate', jobName, data, options),
  getJob: (jobId) => getJob('generate', jobId),
  getMetrics: () => getQueueMetrics('generate'),
  clean: (maxAge) => cleanQueue('generate', maxAge),
  pause: () => pauseQueue('generate'),
  resume: () => resumeQueue('generate'),
  empty: () => emptyQueue('generate'),
  getJobCounts: () => getJobCounts('generate')
};

export default {
  initQueues,
  getQueue,
  add,
  getJob,
  getQueueMetrics,
  cleanQueue,
  pauseQueue,
  resumeQueue,
  emptyQueue,
  getJobCounts,
  createWorker,
  shutdownQueues,
  Queue
};