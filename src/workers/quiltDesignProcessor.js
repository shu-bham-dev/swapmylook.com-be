import { Worker } from 'bullmq';
import Redis from 'ioredis';
import ImageAsset from '../models/ImageAsset.js';
import JobRecord from '../models/JobRecord.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const logger = createLogger('quilt-design-processor');

// Gemini API configuration for text-to-image
const GEMINI_CONFIG = {
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash-image',
  timeout: 120000, // 2 minutes
  maxRetries: 3
};

/**
 * Call Gemini API for text-to-image generation
 */
async function callGeminiTextToImageAPI(prompt, options) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key not configured');
  }

  try {
    // Create enhanced prompt with quilt design specifics
    const enhancedPrompt = `Create a quilt design with the following specifications:
    Style: ${options.style}
    Colors: ${options.colorPalette.join(', ')}
    Complexity level: ${options.complexity}/5
    Size: ${options.size}
    Grid: ${options.rows} rows x ${options.columns} columns
    Symmetry: ${options.symmetry}
    
    Design description: ${prompt}
    
    Generate a visually appealing quilt pattern with geometric shapes, proper symmetry, and the specified color palette.`;

    // Prepare Gemini API request payload for text-to-image
    const geminiPayload = {
      contents: [
        {
          parts: [
            { 
              text: enhancedPrompt
            }
          ]
        }
      ]
    };

    const apiUrl = `${GEMINI_CONFIG.baseURL}/models/${GEMINI_CONFIG.model}:generateContent`;
    
    logger.debug('Making Gemini API call for text-to-image', {
      url: apiUrl,
      promptLength: prompt.length,
      options
    });

    const response = await axios.post(
      apiUrl,
      geminiPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        timeout: GEMINI_CONFIG.timeout
      }
    );

    logger.debug('Gemini API response received', {
      status: response.status,
      hasCandidates: !!response.data.candidates
    });

    return response.data;
  } catch (error) {
    // Enhanced error logging
    if (error.response) {
      // API returned error response
      logger.error('Gemini API error response', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        url: error.config?.url,
        method: error.config?.method
      });
      throw new Error(`Gemini API error: ${error.response.status} - ${error.response.data?.error?.message || error.response.statusText || 'Unknown error'}`);
    } else if (error.request) {
      // Network error
      logger.error('Gemini API network error', {
        message: error.message,
        code: error.code,
        url: error.config?.url
      });
      throw new Error('Gemini API network error: No response received');
    } else {
      // Other error
      logger.error('Gemini API general error', {
        message: error.message,
        stack: error.stack
      });
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }
}

/**
 * Process quilt design generation job
 */
async function processQuiltDesignJob(job) {
  const { jobId, userId, prompt, options } = job.data;
  const startTime = Date.now();

  logger.info('Processing quilt design job', { jobId, userId, promptLength: prompt.length });

  // Get job record from database
  const jobRecord = await JobRecord.findById(jobId);
  if (!jobRecord) {
    throw new Error(`Quilt design job ${jobId} not found`);
  }

  // Update job status to processing
  await jobRecord.markProcessing();

  try {
    // Call Gemini API for text-to-image generation
    const geminiResult = await callGeminiTextToImageAPI(prompt, options);
    
    // Extract the generated image from Gemini response
    if (!geminiResult.candidates || !geminiResult.candidates[0]) {
      logger.error('No candidates found in response', {
        fullResponse: geminiResult
      });
      throw new Error('Gemini API did not return any candidates');
    }

    const candidate = geminiResult.candidates[0];
    
    // Handle safety filter rejections
    if (candidate.finishReason === 'IMAGE_OTHER' || candidate.finishReason === 'SAFETY') {
      const errorMessage = candidate.finishMessage || 'Image generation blocked by content safety filters';
      throw new Error(`Gemini API safety filter: ${errorMessage}`);
    }
    
    if (!candidate.content || !candidate.content.parts) {
      throw new Error('Gemini API candidate has no content or parts');
    }

    // Search through all parts to find the image data
    let generatedImageData = null;
    candidate.content.parts.forEach((part) => {
      if (part.inline_data) {
        generatedImageData = part.inline_data;
      }
    });

    if (!generatedImageData) {
      throw new Error('Gemini API did not return a valid image response - no inline_data found in parts');
    }
    
    // Convert base64 image to buffer
    const outputImageBuffer = Buffer.from(generatedImageData.data, 'base64');

    // Generate storage key for output
    const { generateStorageKey, uploadBuffer, generateDownloadUrl } = await import('../config/storage.js');
    const outputKey = generateStorageKey('quilt-designs', `quilt-design-${jobId}`, jobRecord.userId);

    // Upload output to storage
    await uploadBuffer(outputImageBuffer, outputKey, generatedImageData.mime_type || 'image/png');

    // Generate download URL
    const downloadUrl = await generateDownloadUrl(outputKey, 86400); // 24 hours

    // Create output image asset
    const outputImage = new ImageAsset({
      userId: jobRecord.userId,
      type: 'quilt-design',
      storageKey: outputKey,
      url: downloadUrl,
      mimeType: generatedImageData.mime_type || 'image/png',
      sizeBytes: outputImageBuffer.length,
      metadata: {
        filename: `quilt-design-${jobId}`,
        prompt: prompt,
        options: options,
        processingTime: Date.now() - startTime,
        aiModel: 'gemini-2.5-flash-image',
        source: 'quilt-design-generation'
      }
    });

    await outputImage.save();

    // Update job record with success
    const processingTime = Date.now() - startTime;
    jobRecord.status = 'succeeded';
    jobRecord.outputImageId = outputImage._id;
    jobRecord.completedAt = new Date();
    jobRecord.processingTime = processingTime;
    await jobRecord.save();

    // Log successful generation
    await Audit.logUsage({
      userId,
      type: 'generation',
      action: 'quilt_design_generation_succeeded',
      resourceType: 'job',
      resourceId: jobRecord._id,
      details: {
        processingTime,
        outputSize: outputImageBuffer.length,
        aiModel: 'gemini-2.5-flash-image',
        promptLength: prompt.length
      }
    });

    logger.info('Quilt design job completed successfully', {
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
      action: 'quilt_design_generation_failed',
      resourceType: 'job',
      resourceId: jobRecord._id,
      details: {
        error: error.message,
        processingTime,
        attempt: jobRecord.attempts,
        promptLength: prompt.length
      },
      isSuccess: false
    });

    logger.error('Quilt design job failed', {
      jobId,
      error: error.message,
      processingTime,
      attempt: jobRecord.attempts
    });

    throw error; // Let BullMQ handle retries
  }
}

/**
 * Initialize the worker
 */
function initWorker() {
  const worker = createWorker('quilt-design', processQuiltDesignJob, {
    concurrency: parseInt(process.env.QUILT_DESIGN_WORKER_CONCURRENCY) || 1,
    limiter: {
      max: 5,
      duration: 60000 // 1 minute
    }
  });

  logger.info('Quilt design processor worker started', {
    concurrency: parseInt(process.env.QUILT_DESIGN_WORKER_CONCURRENCY) || 1
  });

  return worker;
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down quilt design processor worker...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down quilt design processor worker...');
  process.exit(0);
});

// Start worker if this file is run directly
logger.info('Starting quilt design processor worker in standalone mode...');

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
    const worker = new Worker('quilt-design', processQuiltDesignJob, {
      connection,
      concurrency: parseInt(process.env.QUILT_DESIGN_WORKER_CONCURRENCY) || 1,
      pollInterval: 5000, // Reduce Redis polling frequency
      limiter: {
        max: 5,
        duration: 60000 // 1 minute
      }
    });

    worker.on('completed', (job, result) => {
      logger.info('Quilt design job completed', {
        jobId: job.id,
        result: typeof result === 'object' ? JSON.stringify(result) : result
      });
    });

    worker.on('failed', (job, error) => {
      logger.error('Quilt design job failed', {
        jobId: job?.id,
        error: error.message,
        stack: error.stack
      });
    });

    worker.on('error', (error) => {
      logger.error('Quilt design worker error', {
        error: error.message,
        stack: error.stack
      });
    });

    worker.on('stalled', (jobId) => {
      logger.warn('Quilt design job stalled', { jobId });
    });

    worker.on('active', (job) => {
      logger.info('Quilt design job started processing', {
        jobId: job.id,
        data: job.data
      });
    });

    logger.info('Quilt design processor worker started successfully', {
      concurrency: parseInt(process.env.QUILT_DESIGN_WORKER_CONCURRENCY) || 1
    });

    return worker;
  } catch (error) {
    logger.error('Failed to start quilt design processor worker', {
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
  processQuiltDesignJob,
  callGeminiTextToImageAPI,
  initWorker
};