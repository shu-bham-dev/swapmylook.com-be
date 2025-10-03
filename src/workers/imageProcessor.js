import { generateDownloadUrl } from '../config/storage.js';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import ImageAsset from '../models/ImageAsset.js';
import JobRecord from '../models/JobRecord.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';
import axios from 'axios';
import dotenv from 'dotenv';
import https from 'https';

// Load environment variables
dotenv.config();

const logger = createLogger('image-processor');

// nanobanana API configuration
const NANOBANANA_CONFIG = {
  baseURL: process.env.NANOBANANA_BASE_URL || 'https://api.nanobanana.ai',
  apiKey: process.env.NANOBANANA_API_KEY,
  timeout: 300000, // 5 minutes
  maxRetries: 3
};

/**
 * Call nanobanana API for image generation
 */
async function callNanobananaAPI(payload) {
  if (!NANOBANANA_CONFIG.apiKey) {
    throw new Error('nanobanana API key not configured');
  }

  try {
    // Create HTTPS agent to handle SSL issues
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false
    });

    const apiUrl = `${NANOBANANA_CONFIG.baseURL}/nanobanana/generate`;
    
    // Log the exact API call details
    logger.debug('Making nanobanana API call', {
      url: apiUrl,
      headers: {
        'Authorization': `Bearer ${NANOBANANA_CONFIG.apiKey.substring(0, 10)}...`,
        'Content-Type': 'application/json'
      },
      payload: payload,
      timeout: NANOBANANA_CONFIG.timeout
    });

    const response = await axios.post(
      apiUrl,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${NANOBANANA_CONFIG.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: NANOBANANA_CONFIG.timeout,
        httpsAgent: httpsAgent
      }
    );

    logger.debug('nanobanana API response', {
      status: response.status,
      headers: response.headers,
      data: response.data
    });

    return response.data;
  } catch (error) {
    // Enhanced error logging
    if (error.response) {
      // API returned error response
      logger.error('nanobanana API error response', {
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers,
        data: error.response.data,
        url: error.config?.url,
        method: error.config?.method
      });
      throw new Error(`nanobanana API error: ${error.response.status} - ${error.response.data?.message || error.response.statusText || 'Unknown error'}`);
    } else if (error.request) {
      // Network error
      logger.error('nanobanana API network error', {
        message: error.message,
        code: error.code,
        url: error.config?.url
      });
      throw new Error('nanobanana API network error: No response received');
    } else {
      // Other error
      logger.error('nanobanana API general error', {
        message: error.message,
        stack: error.stack
      });
      throw new Error(`nanobanana API error: ${error.message}`);
    }
  }
}

/**
 * Process image generation job
 */
async function processGenerationJob(job) {
  const { jobId, userId } = job.data;
  const startTime = Date.now();

  logger.info('Processing generation job', { jobId, userId });

  // Get job record from database
  const jobRecord = await JobRecord.findById(jobId);
  if (!jobRecord) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Update job status to processing
  await jobRecord.markProcessing();

  try {
    // Get input images
    const [modelImage, outfitImage] = await Promise.all([
      ImageAsset.findById(jobRecord.inputModelImageId),
      ImageAsset.findById(jobRecord.inputOutfitImageId)
    ]);

    if (!modelImage || !outfitImage) {
      throw new Error('Input images not found');
    }

    // Generate signed URLs for input images
    const [modelUrl, outfitUrl] = await Promise.all([
      generateDownloadUrl(modelImage.storageKey, 3600),
      generateDownloadUrl(outfitImage.storageKey, 3600)
    ]);

    // Prepare payload for nanobanana API
    const payload = {
      numImages: 1,
      prompt: jobRecord.prompt || "Generate outfit on model",
      type: "IMAGETOIAMGE", // Corrected type value
      callBackUrl: process.env.NANOBANANA_CALLBACK_URL || `${process.env.APP_URL}/api/v1/generate/webhook`,
      imageUrls: [modelUrl, outfitUrl]
    };

    logger.debug('Calling nanobanana API', {
      jobId,
      payload: { ...payload, imageUrls: ['REDACTED', 'REDACTED'] }
    });

    // Call nanobanana API to initiate generation
    const result = await callNanobananaAPI(payload);

    // Check if the API call was successful
    if (result.code !== 200) {
      throw new Error(`nanobanana API error: ${result.msg || 'Unknown error'}`);
    }

    if (!result.data?.taskId) {
      throw new Error('nanobanana API did not return a task ID');
    }

    // Update job record with nanobanana task ID and mark as processing
    jobRecord.nanobananaJobId = result.data.taskId;
    jobRecord.status = 'processing';
    await jobRecord.save();

    // For nanobanana, we need to wait for the webhook callback
    // The actual processing will be handled by the webhook endpoint
    // For now, we'll mark the job as processing and wait for callback
    
    logger.info('nanobanana job initiated', {
      jobId,
      nanobananaJobId: result.data.taskId,
      status: 'waiting_for_callback'
    });

    // Since we're using webhooks, we don't complete the job here
    // The webhook will handle the completion
    return {
      success: true,
      nanobananaJobId: result.data.taskId,
      status: 'processing',
      message: 'Generation initiated, waiting for webhook callback'
    };

    // Generate thumbnails (optional - can be done async)
    try {
      await generateThumbnails(outputImage);
    } catch (thumbnailError) {
      logger.warn('Thumbnail generation failed', {
        jobId,
        error: thumbnailError.message
      });
    }

    // Log successful generation
    await Audit.logUsage({
      userId,
      type: 'generation',
      action: 'generation_succeeded',
      resourceType: 'job',
      resourceId: jobRecord._id,
      details: {
        processingTime,
        outputSize: outputImageBuffer.length,
        aiModel: 'nanobanana'
      }
    });

    logger.info('Generation job completed successfully', {
      jobId,
      processingTime,
      outputImageId: outputImage._id
    });

    return {
      success: true,
      outputImageId: outputImage._id,
      processingTime
    };

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    // Update job record with failure
    await jobRecord.markFailed(error.message, {
      stack: error.stack,
      processingTime
    });

    // Log failure
    await Audit.logUsage({
      userId,
      type: 'generation',
      action: 'generation_failed',
      resourceType: 'job',
      resourceId: jobRecord._id,
      details: {
        error: error.message,
        processingTime,
        attempt: jobRecord.attempts
      },
      isSuccess: false
    });

    logger.error('Generation job failed', {
      jobId,
      error: error.message,
      processingTime,
      attempt: jobRecord.attempts
    });

    throw error; // Let BullMQ handle retries
  }
}

/**
 * Generate thumbnails for output image
 */
async function generateThumbnails(outputImage) {
  const thumbnailSizes = (process.env.THUMBNAIL_SIZES || '512,256')
    .split(',')
    .map(size => parseInt(size.trim()))
    .filter(size => !isNaN(size));

  if (thumbnailSizes.length === 0) {
    return;
  }

  const sharp = await import('sharp');
  const { uploadBuffer } = await import('../config/storage.js');

  // Download original image
  const response = await axios.get(outputImage.url, {
    responseType: 'arraybuffer'
  });
  const originalBuffer = Buffer.from(response.data);

  for (const size of thumbnailSizes) {
    try {
      // Create thumbnail
      const thumbnailBuffer = await sharp.default(originalBuffer)
        .resize(size, size, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      // Generate storage key
      const thumbnailKey = `thumbnails/${outputImage.userId}/${size}/${outputImage._id}.jpg`;

      // Upload thumbnail
      await uploadBuffer(thumbnailBuffer, thumbnailKey, 'image/jpeg');

      // Generate URL
      const thumbnailUrl = await generateDownloadUrl(thumbnailKey, 86400);

      // Create thumbnail asset
      const thumbnailAsset = new ImageAsset({
        userId: outputImage.userId,
        type: 'thumbnail',
        storageKey: thumbnailKey,
        url: thumbnailUrl,
        width: size,
        height: size,
        mimeType: 'image/jpeg',
        sizeBytes: thumbnailBuffer.length,
        originalImageId: outputImage._id,
        metadata: {
          originalImageId: outputImage._id,
          size,
          generatedAt: new Date()
        }
      });

      await thumbnailAsset.save();

      logger.debug('Thumbnail generated', {
        outputImageId: outputImage._id,
        size,
        thumbnailId: thumbnailAsset._id
      });

    } catch (error) {
      logger.warn('Failed to generate thumbnail', {
        outputImageId: outputImage._id,
        size,
        error: error.message
      });
    }
  }
}

/**
 * Initialize the worker
 */
function initWorker() {
  const worker = createWorker('generate', processGenerationJob, {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2,
    limiter: {
      max: 10,
      duration: 60000 // 1 minute
    }
  });

  logger.info('Image processor worker started', {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2
  });

  return worker;
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down image processor worker...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down image processor worker...');
  process.exit(0);
});

// Start worker if this file is run directly
logger.info('Starting image processor worker in standalone mode...');

// Import and use shared Redis configuration
import { connectRedis, getRedisClient } from '../config/redis.js';
import { initQueues } from '../config/queue.js';
import mongoose from 'mongoose';

async function startWorker() {
  try {
    // Connect to MongoDB first
    logger.info('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    logger.info('✅ MongoDB connected successfully');

    // Connect to Redis using shared configuration
    await connectRedis();
    const connection = getRedisClient();

    // Initialize queues to ensure they're ready
    await initQueues();

    // Create worker using shared Redis connection
    const worker = new Worker('generate', processGenerationJob, {
      connection,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2,
      limiter: {
        max: 10,
        duration: 60000 // 1 minute
      }
    });

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

    logger.info('Image processor worker started successfully', {
      concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 2
    });

    return worker;
  } catch (error) {
    logger.error('Failed to start image processor worker', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Start the worker
startWorker();

// Export for testing or other usage
export {
  processGenerationJob,
  callNanobananaAPI,
  generateThumbnails,
  initWorker
};