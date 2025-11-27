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

// Gemini API configuration
const GEMINI_CONFIG = {
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash-image',
  timeout: 120000, // 2 minutes
  maxRetries: 3
};

/**
 * Call Gemini API for image generation
 */
async function callGeminiAPI(modelImageBuffer, outfitImageBuffer) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key not configured');
  }

  // Use hardcoded prompt from environment variable
  const prompt = process.env.GENERATION_PROMPT || "Create a creative fashion composition. Combine elements from both images to create a new artistic fashion concept. Focus on the clothing and style elements rather than realistic human depictions.";

  try {
    // Convert images to base64
    const modelImageBase64 = modelImageBuffer.toString('base64');
    const outfitImageBase64 = outfitImageBuffer.toString('base64');

    // Prepare Gemini API request payload using the correct format
    const geminiPayload = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: 'image/png',
                data: modelImageBase64
              }
            },
            {
              inlineData: {
                mimeType: 'image/png',
                data: outfitImageBase64
              }
            },
            {
              text: prompt
            }
          ]
        }
      ]
    };

    const apiUrl = `${GEMINI_CONFIG.baseURL}/models/${GEMINI_CONFIG.model}:generateContent`;
    
    // Log the API call details
    logger.debug('Making Gemini API call', {
      url: apiUrl,
      headers: {
        'x-goog-api-key': `${process.env.GEMINI_API_KEY.substring(0, 10)}...`,
        'Content-Type': 'application/json'
      },
      timeout: GEMINI_CONFIG.timeout
    });

    // Debug: Log full payload for troubleshooting
    console.log('🔍 Gemini API Payload:', JSON.stringify({
      url: apiUrl,
      payload: {
        ...geminiPayload,
        contents: geminiPayload.contents.map(content => ({
          ...content,
          parts: content.parts.map(part => {
            if (part.inlineData) {
              return {
                ...part,
                inlineData: {
                  ...part.inlineData,
                  data: `${part.inlineData.data.substring(0, 50)}...` // Truncate base64 for readability
                }
              };
            }
            return part;
          })
        }))
      }
    }, null, 2));

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
      hasCandidates: !!response.data.candidates,
      responseKeys: Object.keys(response.data)
    });

    // Debug: Log full response structure for troubleshooting
    console.log('🔍 Gemini API Response:', JSON.stringify({
      status: response.status,
      data: response.data
    }, null, 2));

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

    // Import storage functions
    const { generateDownloadUrl } = await import('../config/storage.js');
    
    // Generate signed URLs for input images
    const [modelUrl, outfitUrl] = await Promise.all([
      generateDownloadUrl(modelImage.storageKey, 3600),
      generateDownloadUrl(outfitImage.storageKey, 3600)
    ]);
    
    // Download input images
    const [modelResponse, outfitResponse] = await Promise.all([
      axios.get(modelUrl, {
        responseType: 'arraybuffer'
      }),
      axios.get(outfitUrl, {
        responseType: 'arraybuffer'
      })
    ]);

    const modelImageBuffer = Buffer.from(modelResponse.data);
    const outfitImageBuffer = Buffer.from(outfitResponse.data);

    logger.debug('Downloaded input images', {
      jobId,
      modelImageSize: modelImageBuffer.length,
      outfitImageSize: outfitImageBuffer.length
    });

    // Call Gemini API for generation
    const geminiResult = await callGeminiAPI(
      modelImageBuffer,
      outfitImageBuffer
    );

    // Extract the generated image from Gemini response
    console.log('🔍 Checking Gemini response structure...');
    console.log('   Has candidates:', !!geminiResult.candidates);
    console.log('   Full response keys:', Object.keys(geminiResult));
    
    if (!geminiResult.candidates || !geminiResult.candidates[0]) {
      console.log('❌ No candidates found in response');
      console.log('📋 Full response:', JSON.stringify(geminiResult, null, 2));
      throw new Error('Gemini API did not return any candidates');
    }

    const candidate = geminiResult.candidates[0];
    console.log('   Candidate 0 keys:', Object.keys(candidate));
    console.log('   Candidate 0 has content:', !!candidate.content);
    console.log('   Candidate finish reason:', candidate.finishReason);
    console.log('   Candidate finish message:', candidate.finishMessage);
    
    // Handle safety filter rejections
    if (candidate.finishReason === 'IMAGE_OTHER' || candidate.finishReason === 'SAFETY') {
      const errorMessage = candidate.finishMessage || 'Image generation blocked by content safety filters';
      console.log('❌ Image generation blocked by safety filters:', errorMessage);
      throw new Error(`Gemini API safety filter: ${errorMessage}`);
    }
    
    if (!candidate.content || !candidate.content.parts) {
      console.log('❌ Candidate has no content or parts');
      console.log('📋 Candidate structure:', JSON.stringify(candidate, null, 2));
      throw new Error('Gemini API candidate has no content or parts');
    }

    console.log('   Parts count:', candidate.content.parts.length);
    
    // Search through all parts to find the image data
    let generatedImageData = null;
    candidate.content.parts.forEach((part, index) => {
      console.log(`   Part ${index} type:`, part.text ? 'text' : part.inlineData ? 'inlineData' : 'unknown');
      if (part.inlineData) {
        console.log(`   Part ${index} inlineData mimeType:`, part.inlineData.mimeType);
        if (!generatedImageData) {
          generatedImageData = part.inlineData;
        }
      }
    });

    if (!generatedImageData) {
      console.log('❌ No image data found in response parts');
      console.log('📋 Available parts:', candidate.content.parts.map((part, index) => ({
        index,
        type: part.text ? 'text' : part.inlineData ? 'inlineData' : 'unknown',
        text: part.text ? part.text.substring(0, 100) + '...' : undefined,
        mimeType: part.inlineData?.mimeType
      })));
      throw new Error('Gemini API did not return a valid image response - no inlineData found in parts');
    }

    console.log('✅ Found image data with mimeType:', generatedImageData.mimeType);
    
    // Convert base64 image to buffer
    const outputImageBuffer = Buffer.from(generatedImageData.data, 'base64');

    // Generate storage key for output (without extension - let Cloudinary detect)
    const { generateStorageKey, uploadBuffer } = await import('../config/storage.js');
    const outputKey = generateStorageKey('outputs', `output-${jobId}`, jobRecord.userId);

    // Upload output to storage (let Cloudinary detect MIME type)
    await uploadBuffer(outputImageBuffer, outputKey, generatedImageData.mimeType);

    // Generate download URL
    const downloadUrl = await generateDownloadUrl(outputKey, 86400); // 24 hours

    // Create output image asset
    const outputImage = new ImageAsset({
      userId: jobRecord.userId,
      type: 'output',
      storageKey: outputKey,
      url: downloadUrl,
      mimeType: generatedImageData.mimeType,
      sizeBytes: outputImageBuffer.length,
      originalImageId: jobRecord.inputModelImageId,
      metadata: {
        filename: `output-${jobId}`,
        prompt: jobRecord.prompt,
        options: jobRecord.options,
        processingTime: Date.now() - startTime,
        aiModel: 'gemini-2.5-flash-image',
        source: 'worker-generation'
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
        aiModel: 'gemini-2.5-flash-image'
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
  const { uploadBuffer, generateDownloadUrl } = await import('../config/storage.js');

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
      const thumbnailUrl = generateDownloadUrl(thumbnailKey, 86400);

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
  callGeminiAPI,
  generateThumbnails,
  initWorker
};