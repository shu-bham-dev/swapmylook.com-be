import express from 'express';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import { generateRateLimiter, quotaCheck, usageTracker } from '../middleware/rateLimiter.js';
import { Queue } from '../config/queue.js';
import ImageAsset from '../models/ImageAsset.js';
import JobRecord from '../models/JobRecord.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('generate-routes');

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
    ImageAsset.findOne({ _id: modelImageId, userId: req.user.id, isDeleted: false }),
    ImageAsset.findOne({ _id: outfitImageId, userId: req.user.id, isDeleted: false })
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
    userId: req.user.id,
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
    userId: req.user.id
  }, {
    jobId: jobRecord._id.toString(),
    priority: jobRecord.priority,
    attempts: jobRecord.maxAttempts
  });

  // Log job creation
  await Audit.logUsage({
    userId: req.user.id,
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
    userId: req.user.id
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
    userId: req.user.id
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
    userId: req.user.id,
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
  const filter = { userId: req.user.id };
  
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
  const stats = await JobRecord.getUserStats(req.user.id);

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
 *     summary: Webhook endpoint for external services
 *     description: Receive webhook notifications from external AI services - e.g., nanobanana
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

  // Update job based on webhook data
  if (status === 'completed' && outputUrl) {
    try {
      // Download the generated image
      const response = await axios.get(outputUrl, {
        responseType: 'arraybuffer',
        timeout: 60000
      });
      const outputImageBuffer = Buffer.from(response.data);

      // Generate storage key for output
      const { generateStorageKey, uploadBuffer, generateDownloadUrl } = await import('../config/storage.js');
      const outputKey = `outputs/${job.userId}/${Date.now()}-${Math.random().toString(36).substring(2, 8)}.jpg`;

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
          filename: `output-${jobId}.jpg`,
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

      logger.info('Webhook processed successfully', {
        jobId,
        outputImageId: outputImage._id,
        processingTime
      });

    } catch (error) {
      logger.error('Failed to process webhook output', {
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