import express from 'express';
import multer from 'multer';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import { generateRateLimiter, quotaCheck, usageTracker } from '../middleware/rateLimiter.js';
import { Queue } from '../config/queue.js';
import ImageAsset from '../models/ImageAsset.js';
import JobRecord from '../models/JobRecord.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';
import axios from 'axios';

const router = express.Router();
const logger = createLogger('generate-routes');

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB default
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = (process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/webp').split(',');
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ValidationError(`File type ${file.mimetype} is not allowed`), false);
    }
  }
});

// Gemini API configuration
const GEMINI_CONFIG = {
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash-image',
  timeout: 120000, // 2 minutes
  maxRetries: 3
};

/**
 * @route   POST /api/v1/generate/direct
 * @desc    Direct image generation using Google Gemini API
 * @access  Private
 */
router.post('/direct', requireAuth(), generateRateLimiter, quotaCheck(), upload.single('image'), asyncHandler(async (req, res) => {
  const { prompt } = req.body;
  const imageFile = req.file;

  // Validate required fields
  if (!prompt) {
    throw new ValidationError('Prompt is required');
  }

  if (!imageFile) {
    throw new ValidationError('Image file is required');
  }

  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(imageFile.mimetype)) {
    throw new ValidationError(`File type ${imageFile.mimetype} is not supported. Please use JPEG, PNG, or WebP.`);
  }

  // Check if Gemini API key is configured
  if (!process.env.GEMINI_API_KEY) {
    throw new ValidationError('Gemini API key is not configured');
  }

  try {
    // Convert image to base64
    const base64Image = imageFile.buffer.toString('base64');
    
    // Prepare Gemini API request payload
    const geminiPayload = {
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: imageFile.mimetype,
                data: base64Image
              }
            }
          ]
        }
      ]
    };

    // Call Gemini API
    const apiUrl = `${GEMINI_CONFIG.baseURL}/models/${GEMINI_CONFIG.model}:generateContent`;
    const response = await axios.post(apiUrl, geminiPayload, {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      timeout: GEMINI_CONFIG.timeout
    });

    // Parse Gemini response
    const geminiResponse = response.data;
    
    // Extract the generated image from the response
    if (!geminiResponse.candidates ||
        !geminiResponse.candidates[0] ||
        !geminiResponse.candidates[0].content ||
        !geminiResponse.candidates[0].content.parts ||
        !geminiResponse.candidates[0].content.parts[0] ||
        !geminiResponse.candidates[0].content.parts[0].inline_data) {
      throw new Error('Gemini API did not return a valid image response');
    }

    const generatedImageData = geminiResponse.candidates[0].content.parts[0].inline_data;
    
    // Convert base64 image to buffer
    const imageBuffer = Buffer.from(generatedImageData.data, 'base64');
    
    // Generate storage key for the output (without extension - let Cloudinary detect)
    const { generateStorageKey, uploadBuffer, generateDownloadUrl } = await import('../config/storage.js');
    const outputKey = generateStorageKey('direct-outputs', `gemini-output-${Date.now()}`, req.user.id);
    
    // Upload output to storage (use actual MIME type from Gemini response)
    await uploadBuffer(imageBuffer, outputKey, generatedImageData.mime_type || 'image/png');
    
    // Generate download URL
    const downloadUrl = await generateDownloadUrl(outputKey, 86400); // 24 hours
    
    // Create output image asset
    const outputImage = new ImageAsset({
      userId: req.user.id,
      type: 'output',
      storageKey: outputKey,
      url: downloadUrl,
      mimeType: generatedImageData.mime_type || 'image/png',
      sizeBytes: imageBuffer.length,
      metadata: {
        filename: `gemini-output-${Date.now()}`,
        prompt: prompt,
        processingTime: 'direct',
        aiModel: 'gemini-2.5-flash-image',
        source: 'direct-generation'
      }
    });

    await outputImage.save();

    // Log successful generation
    await Audit.logUsage({
      userId: req.user.id,
      type: 'generation',
      action: 'direct_generation_succeeded',
      resourceType: 'image',
      resourceId: outputImage._id,
      details: {
        promptLength: prompt.length,
        outputSize: imageBuffer.length,
        aiModel: 'gemini-2.5-flash-image'
      }
    });

    logger.info('Direct generation completed successfully', {
      userId: req.user.id,
      outputImageId: outputImage._id,
      promptLength: prompt.length
    });

    // Send response with image URL
    res.json({
      success: true,
      outputImage: {
        id: outputImage._id,
        url: downloadUrl,
        sizeBytes: imageBuffer.length,
        mimeType: generatedImageData.mime_type || 'image/png'
      },
      prompt: prompt
    });

  } catch (error) {
    logger.error('Direct generation failed', {
      userId: req.user.id,
      error: error.message,
      prompt: prompt
    });

    // Log failure
    await Audit.logUsage({
      userId: req.user.id,
      type: 'generation',
      action: 'direct_generation_failed',
      resourceType: 'image',
      details: {
        error: error.message,
        prompt: prompt
      },
      isSuccess: false
    });

    if (error.response) {
      // Gemini API error
      throw new Error(`Gemini API error: ${error.response.status} - ${error.response.data?.error?.message || 'Unknown error'}`);
    } else if (error.request) {
      // Network error
      throw new Error('Gemini API network error: No response received');
    } else {
      // Other error
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }
}));

/**
 * @route   POST /api/v1/generate
 * @desc    Create new generation job
 * @access  Private
 */
router.post('/', requireAuth(), generateRateLimiter, quotaCheck(), asyncHandler(async (req, res) => {
  const { modelImageId, outfitImageId, prompt, options, callbackUrl, projectId } = req.body;

  // Validate required fields
  if (!modelImageId || !outfitImageId) {
    throw new ValidationError('modelImageId and outfitImageId are required');
  }

  // Verify that images belong to the user and exist
  const [modelImage, outfitImage] = await Promise.all([
    ImageAsset.findOne({ _id: modelImageId, userId: req.user._id, isDeleted: false }),
    ImageAsset.findOne({ _id: outfitImageId, userId: req.user._id, isDeleted: false })
  ]);

  if (!modelImage) {
    throw new NotFoundError('Model image');
  }

  if (!outfitImage) {
    throw new NotFoundError('Outfit image');
  }

  // Validate image types
  if (modelImage.type !== 'model') {
    throw new ValidationError('Model image must be of type "model"');
  }

  if (outfitImage.type !== 'outfit') {
    throw new ValidationError('Outfit image must be of type "outfit"');
  }

  // Create job record
  const jobRecord = new JobRecord({
    userId: req.user._id,
    inputModelImageId: modelImageId,
    inputOutfitImageId: outfitImageId,
    prompt: prompt || '',
    options: {
      strength: options?.strength || 0.9,
      preserveFace: options?.preserveFace !== false,
      background: options?.background || 'transparent',
      style: options?.style,
      seed: options?.seed
    },
    callbackUrl,
    estimatedTime: 45 // Default estimate
  });

  await jobRecord.save();

  // Add job to queue
  await Queue.add('generate', {
    jobId: jobRecord._id.toString(),
    userId: req.user._id
  }, {
    jobId: jobRecord._id.toString(),
    priority: jobRecord.priority,
    attempts: jobRecord.maxAttempts
  });

  // Log job creation
  await Audit.logUsage({
    userId: req.user._id,
    type: 'generation',
    action: 'job_created',
    resourceType: 'job',
    resourceId: jobRecord._id,
    details: {
      modelImageId,
      outfitImageId,
      promptLength: prompt?.length || 0,
      options: jobRecord.options
    }
  });

  res.status(202).json({
    jobId: jobRecord._id,
    status: 'queued',
    estimatedTime: jobRecord.estimatedTime,
    queuePosition: await Queue.getJobCounts('waiting')
  });
}));

/**
 * @route   GET /api/v1/generate/:jobId/status
 * @desc    Get job status and results
 * @access  Private
 */
router.get('/:jobId/status', requireAuth(), asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const job = await JobRecord.findOne({
    _id: jobId,
    userId: req.user._id
  });

  if (!job) {
    throw new NotFoundError('Job');
  }

  let outputImage = null;
  if (job.outputImageId) {
    outputImage = await ImageAsset.findById(job.outputImageId);
  }

  const response = {
    jobId: job._id,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    estimatedTime: job.estimatedTime,
    processingTime: job.processingTime,
    queueTime: job.queueTime
  };

  if (job.status === 'succeeded' && outputImage) {
    response.outputImage = {
      id: outputImage._id,
      url: outputImage.url,
      width: outputImage.width,
      height: outputImage.height,
      sizeBytes: outputImage.sizeBytes
    };
  }

  if (job.status === 'failed') {
    response.error = job.error;
    response.errorDetails = job.errorDetails;
  }

  if (job.status === 'processing') {
    response.startedAt = job.updatedAt;
  }

  res.json(response);
}));

/**
 * @route   POST /api/v1/generate/:jobId/cancel
 * @desc    Cancel a queued job
 * @access  Private
 */
router.post('/:jobId/cancel', requireAuth(), asyncHandler(async (req, res) => {
  const { jobId } = req.params;

  const job = await JobRecord.findOne({
    _id: jobId,
    userId: req.user._id
  });

  if (!job) {
    throw new NotFoundError('Job');
  }

  if (job.status !== 'queued') {
    throw new ValidationError('Only queued jobs can be cancelled');
  }

  // Cancel the job
  await job.cancel();

  // Remove from queue if it's still there
  try {
    const queueJob = await Queue.getJob(jobId);
    if (queueJob) {
      await queueJob.remove();
    }
  } catch (error) {
    logger.warn('Error removing job from queue', {
      jobId,
      error: error.message
    });
  }

  // Log cancellation
  await Audit.logUsage({
    userId: req.user._id,
    type: 'generation',
    action: 'job_cancelled',
    resourceType: 'job',
    resourceId: job._id,
    details: {
      status: job.status,
      attempts: job.attempts
    }
  });

  res.json({
    message: 'Job cancelled successfully',
    jobId: job._id,
    status: job.status
  });
}));

/**
 * @route   GET /api/v1/generate
 * @desc    List user's generation jobs
 * @access  Private
 */
router.get('/', requireAuth(), asyncHandler(async (req, res) => {
  const {
    status,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    projectId
  } = req.query;

  // Build filter
  const filter = { userId: req.user._id };
  
  if (status) {
    filter.status = status;
  }

  if (projectId) {
    filter.projectId = projectId;
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  const [jobs, total] = await Promise.all([
    JobRecord.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .populate('inputModelImageId', 'url metadata')
      .populate('inputOutfitImageId', 'url metadata')
      .populate('outputImageId', 'url metadata'),
    JobRecord.countDocuments(filter)
  ]);

  res.json({
    jobs: jobs.map(job => ({
      id: job._id,
      status: job.status,
      inputModelImage: job.inputModelImageId,
      inputOutfitImage: job.inputOutfitImageId,
      outputImage: job.outputImageId,
      prompt: job.prompt,
      options: job.options,
      attempts: job.attempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      error: job.error
    })),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    },
    filters: { status, projectId }
  });
}));

/**
 * @route   GET /api/v1/generate/stats
 * @desc    Get user's generation statistics
 * @access  Private
 */
router.get('/stats', requireAuth(), asyncHandler(async (req, res) => {
  const stats = await JobRecord.getUserStats(req.user._id);

  res.json({
    total: stats.total,
    byStatus: stats.byStatus,
    averageProcessingTime: stats.averageProcessingTime,
    successRate: stats.byStatus.succeeded 
      ? (stats.byStatus.succeeded / stats.total) * 100 
      : 0
  });
}));

/**
 * @swagger
 * /api/v1/generate/webhook:
 *   post:
 *     summary: Webhook endpoint for external services (Legacy nanobanana support)
 *     description: Receive webhook notifications from legacy external AI services - e.g., nanobanana
 *     tags: [Generation]
 *     parameters:
 *       - in: header
 *         name: x-webhook-secret
 *         schema:
 *           type: string
 *         required: true
 *         description: Webhook secret for authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jobId
 *               - status
 *             properties:
 *               jobId:
 *                 type: string
 *                 format: objectid
 *                 description: Job ID to update
 *               status:
 *                 type: string
 *                 enum: [completed, failed]
 *                 description: Job status from external service
 *               outputUrl:
 *                 type: string
 *                 format: uri
 *                 description: URL of the generated output image
 *               error:
 *                 type: string
 *                 description: Error message if job failed
 *               metadata:
 *                 type: object
 *                 description: Additional metadata from external service
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 *                 jobId:
 *                   type: string
 *                   format: objectid
 *       400:
 *         description: Bad request - validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - invalid webhook secret
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Job not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/webhook', asyncHandler(async (req, res) => {
  const { jobId, status, outputUrl, error, metadata } = req.body;

  // Basic validation
  if (!jobId) {
    throw new ValidationError('jobId is required');
  }

  // In production, you should verify the webhook signature
  const webhookSecret = req.headers['x-webhook-secret'];
  if (process.env.WEBHOOK_SECRET && webhookSecret !== process.env.WEBHOOK_SECRET) {
    throw new ValidationError('Invalid webhook secret');
  }

  const job = await JobRecord.findById(jobId);
  if (!job) {
    throw new NotFoundError('Job');
  }

  // Update job based on webhook data (legacy nanobanana support)
  if (status === 'completed' && outputUrl) {
    try {
      // Download the generated image
      const response = await axios.get(outputUrl, {
        responseType: 'arraybuffer',
        timeout: 60000
      });
      const outputImageBuffer = Buffer.from(response.data);

      // Generate storage key for output (without extension - let Cloudinary detect)
      const { generateStorageKey, uploadBuffer, generateDownloadUrl } = await import('../config/storage.js');
      const outputKey = generateStorageKey('outputs', `legacy-output-${jobId}`, job.userId);

      // Upload output to storage
      await uploadBuffer(outputImageBuffer, outputKey, 'image/jpeg');

      // Generate download URL
      const downloadUrl = await generateDownloadUrl(outputKey, 86400); // 24 hours

      // Create output image asset
      const ImageAsset = (await import('../models/ImageAsset.js')).default;
      const outputImage = new ImageAsset({
        userId: job.userId,
        type: 'output',
        storageKey: outputKey,
        url: downloadUrl,
        mimeType: 'image/jpeg',
        sizeBytes: outputImageBuffer.length,
        originalImageId: job.inputModelImageId,
        nanobananaJobId: job.nanobananaJobId,
        metadata: {
          filename: `output-${jobId}`,
          prompt: job.prompt,
          options: job.options,
          processingTime: Date.now() - job.createdAt,
          aiModel: 'nanobanana',
          sourceUrl: outputUrl
        }
      });

      await outputImage.save();

      // Update job record with success
      const processingTime = Date.now() - job.createdAt;
      job.status = 'succeeded';
      job.outputImageId = outputImage._id;
      job.completedAt = new Date();
      job.processingTime = processingTime;

      // Log webhook reception
      await Audit.logUsage({
        userId: job.userId,
        type: 'generation',
        action: 'webhook_received',
        resourceType: 'job',
        resourceId: job._id,
        details: {
          status: 'succeeded',
          outputUrl,
          metadata,
          processingTime
        }
      });

      logger.info('Legacy webhook processed successfully', {
        jobId,
        outputImageId: outputImage._id,
        processingTime
      });

    } catch (error) {
      logger.error('Failed to process legacy webhook output', {
        jobId,
        error: error.message
      });
      
      job.status = 'failed';
      job.error = `Failed to process generated image: ${error.message}`;
      job.completedAt = new Date();
    }
  } else if (status === 'failed') {
    job.status = 'failed';
    job.error = error || 'External service failed';
    job.errorDetails = metadata;
    job.completedAt = new Date();
  }

  await job.save();

  res.json({ received: true, jobId });
}));

// Apply usage tracking to successful generations
router.use(usageTracker('generation'));

export default router;