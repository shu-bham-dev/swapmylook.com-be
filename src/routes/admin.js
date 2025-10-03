import express from 'express';
import { requireAdmin } from '../config/passport.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import JobRecord from '../models/JobRecord.js';
import ImageAsset from '../models/ImageAsset.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('admin-routes');

/**
 * @route   GET /api/v1/admin/users
 * @desc    Get all users with pagination and filtering
 * @access  Private (Admin only)
 */
router.get('/users', requireAdmin(), asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    plan,
    search,
    active
  } = req.query;

  // Build filter
  const filter = {};

  if (plan) {
    filter.plan = plan;
  }

  if (active !== undefined) {
    filter.isActive = active === 'true';
  }

  if (search) {
    filter.$or = [
      { email: { $regex: search, $options: 'i' } },
      { name: { $regex: search, $options: 'i' } }
    ];
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select('-googleId -__v'),
    User.countDocuments(filter)
  ]);

  // Get additional stats for each user
  const usersWithStats = await Promise.all(
    users.map(async (user) => {
      const [jobStats, storageUsage] = await Promise.all([
        JobRecord.getUserStats(user._id),
        ImageAsset.getStorageUsage(user._id)
      ]);

      return {
        ...user.toObject(),
        stats: {
          totalJobs: jobStats.total,
          successfulJobs: jobStats.byStatus.succeeded || 0,
          storageUsage: storageUsage.totalBytes,
          storageUsageHuman: formatBytes(storageUsage.totalBytes)
        }
      };
    })
  );

  res.json({
    users: usersWithStats,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    },
    filters: { plan, search, active }
  });
}));

/**
 * @route   GET /api/v1/admin/users/:id
 * @desc    Get detailed user information
 * @access  Private (Admin only)
 */
router.get('/users/:id', requireAdmin(), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const user = await User.findById(id).select('-googleId -__v');
  if (!user) {
    throw new NotFoundError('User');
  }

  const [jobStats, storageUsage, recentJobs, recentAudits] = await Promise.all([
    JobRecord.getUserStats(user._id),
    ImageAsset.getStorageUsage(user._id),
    JobRecord.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('inputModelImageId', 'url metadata')
      .populate('inputOutfitImageId', 'url metadata')
      .populate('outputImageId', 'url metadata'),
    Audit.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(10)
  ]);

  res.json({
    user,
    stats: {
      jobs: jobStats,
      storage: storageUsage,
      totalImages: storageUsage.totalFiles,
      monthlyUsage: user.quota.usedThisMonth,
      monthlyLimit: user.quota.monthlyRequests
    },
    recentActivity: {
      jobs: recentJobs,
      audits: recentAudits
    }
  });
}));

/**
 * @route   POST /api/v1/admin/users/:id/quota
 * @desc    Adjust user quota
 * @access  Private (Admin only)
 */
router.post('/users/:id/quota', requireAdmin(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { monthlyRequests, usedThisMonth, resetDate } = req.body;

  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError('User');
  }

  // Update quota
  if (monthlyRequests !== undefined) {
    user.quota.monthlyRequests = parseInt(monthlyRequests);
  }

  if (usedThisMonth !== undefined) {
    user.quota.usedThisMonth = parseInt(usedThisMonth);
  }

  if (resetDate) {
    user.quota.resetDate = new Date(resetDate);
  }

  await user.save();

  // Log quota adjustment
  await Audit.logUsage({
    userId: req.user.id,
    type: 'quota_adjustment',
    action: 'admin_quota_adjustment',
    resourceType: 'user',
    resourceId: user._id,
    details: {
      adminId: req.user.id,
      monthlyRequests: user.quota.monthlyRequests,
      usedThisMonth: user.quota.usedThisMonth,
      resetDate: user.quota.resetDate
    }
  });

  res.json({
    message: 'User quota updated successfully',
    quota: user.quota
  });
}));

/**
 * @route   POST /api/v1/admin/users/:id/plan
 * @desc    Change user plan
 * @access  Private (Admin only)
 */
router.post('/users/:id/plan', requireAdmin(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { plan } = req.body;

  const validPlans = ['free', 'pro', 'enterprise'];
  if (!validPlans.includes(plan)) {
    throw new ValidationError(`Plan must be one of: ${validPlans.join(', ')}`);
  }

  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError('User');
  }

  const oldPlan = user.plan;
  user.plan = plan;

  // Adjust quota based on plan
  if (plan === 'pro') {
    user.quota.monthlyRequests = 500;
  } else if (plan === 'enterprise') {
    user.quota.monthlyRequests = 5000;
  } else {
    user.quota.monthlyRequests = 100;
  }

  await user.save();

  // Log plan change
  await Audit.logUsage({
    userId: req.user.id,
    type: 'subscription_change',
    action: 'admin_plan_change',
    resourceType: 'user',
    resourceId: user._id,
    details: {
      adminId: req.user.id,
      oldPlan,
      newPlan: plan,
      newQuota: user.quota.monthlyRequests
    }
  });

  res.json({
    message: `User plan changed to ${plan}`,
    plan: user.plan,
    quota: user.quota
  });
}));

/**
 * @route   POST /api/v1/admin/users/:id/status
 * @desc    Toggle user active status
 * @access  Private (Admin only)
 */
router.post('/users/:id/status', requireAdmin(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;

  if (typeof isActive !== 'boolean') {
    throw new ValidationError('isActive must be a boolean');
  }

  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError('User');
  }

  user.isActive = isActive;
  await user.save();

  // Log status change
  await Audit.logUsage({
    userId: req.user.id,
    type: 'user_management',
    action: isActive ? 'user_activated' : 'user_deactivated',
    resourceType: 'user',
    resourceId: user._id,
    details: {
      adminId: req.user.id,
      previousStatus: !isActive,
      newStatus: isActive
    }
  });

  res.json({
    message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
    isActive: user.isActive
  });
}));

/**
 * @route   GET /api/v1/admin/jobs
 * @desc    Get all jobs with filtering and pagination
 * @access  Private (Admin only)
 */
router.get('/jobs', requireAdmin(), asyncHandler(async (req, res) => {
  const {
    status,
    userId,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    dateFrom,
    dateTo
  } = req.query;

  // Build filter
  const filter = {};

  if (status) {
    filter.status = status;
  }

  if (userId) {
    filter.userId = userId;
  }

  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  const [jobs, total] = await Promise.all([
    JobRecord.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .populate('userId', 'email name')
      .populate('inputModelImageId', 'url metadata')
      .populate('inputOutfitImageId', 'url metadata')
      .populate('outputImageId', 'url metadata'),
    JobRecord.countDocuments(filter)
  ]);

  res.json({
    jobs,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    },
    filters: { status, userId, dateFrom, dateTo }
  });
}));

/**
 * @swagger
 * /api/v1/admin/stats:
 *   get:
 *     summary: Get system-wide statistics
 *     description: Retrieve comprehensive system statistics including users, jobs, and storage - admin only
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: object
 *                 jobs:
 *                   type: object
 *                 storage:
 *                   type: object
 *                 recentActivity:
 *                   type: array
 *                 totals:
 *                   type: object
 *                   properties:
 *                     users:
 *                       type: integer
 *                     jobs:
 *                       type: integer
 *                     storage:
 *                       type: integer
 *                     storageHuman:
 *                       type: string
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/stats', requireAdmin(), asyncHandler(async (req, res) => {
  const [userStats, jobStats, storageStats, recentActivity] = await Promise.all([
    // User statistics
    User.aggregate([
      {
        $group: {
          _id: '$plan',
          count: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } }
        }
      }
    ]),

    // Job statistics
    JobRecord.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalProcessingTime: { $sum: '$processingTime' }
        }
      }
    ]),

    // Storage statistics
    ImageAsset.aggregate([
      {
        $match: { isDeleted: false }
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalSize: { $sum: '$sizeBytes' }
        }
      }
    ]),

    // Recent activity
    Audit.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('userId', 'email name')
  ]);

  // Format statistics
  const formattedStats = {
    users: userStats.reduce((acc, stat) => {
      acc[stat._id] = { total: stat.count, active: stat.active };
      return acc;
    }, {}),
    jobs: jobStats.reduce((acc, stat) => {
      acc[stat._id] = { count: stat.count, totalProcessingTime: stat.totalProcessingTime };
      return acc;
    }, {}),
    storage: storageStats.reduce((acc, stat) => {
      acc[stat._id] = { 
        count: stat.count, 
        totalSize: stat.totalSize,
        totalSizeHuman: formatBytes(stat.totalSize)
      };
      return acc;
    }, {}),
    recentActivity
  };

  // Calculate totals
  formattedStats.totals = {
    users: userStats.reduce((sum, stat) => sum + stat.count, 0),
    jobs: jobStats.reduce((sum, stat) => sum + stat.count, 0),
    storage: storageStats.reduce((sum, stat) => sum + stat.totalSize, 0),
    storageHuman: formatBytes(storageStats.reduce((sum, stat) => sum + stat.totalSize, 0))
  };

  res.json(formattedStats);
}));

/**
 * @swagger
 * /api/v1/admin/jobs/{id}/retry:
 *   post:
 *     summary: Retry a failed job
 *     description: Retry a failed generation job - admin only
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Job ID
 *     responses:
 *       200:
 *         description: Job queued for retry
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 jobId:
 *                   type: string
 *                   format: objectid
 *                 status:
 *                   type: string
 *       400:
 *         description: Bad request - job cannot be retried
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - admin access required
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
router.post('/jobs/:id/retry', requireAdmin(), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const job = await JobRecord.findById(id);
  if (!job) {
    throw new NotFoundError('Job');
  }

  if (job.status !== 'failed') {
    throw new ValidationError('Only failed jobs can be retried');
  }

  // Reset job status and add to queue
  job.status = 'queued';
  job.attempts = 0;
  job.error = null;
  job.errorDetails = {};
  job.retryAt = null;
  await job.save();

  // Add to queue
  const { Queue } = await import('../config/queue.js');
  await Queue.add('generate', {
    jobId: job._id.toString(),
    userId: job.userId
  });

  // Log retry
  await Audit.logUsage({
    userId: req.user.id,
    type: 'generation',
    action: 'admin_job_retry',
    resourceType: 'job',
    resourceId: job._id,
    details: {
      adminId: req.user.id,
      previousAttempts: job.attempts
    }
  });

  res.json({
    message: 'Job queued for retry',
    jobId: job._id,
    status: job.status
  });
}));

/**
 * @swagger
 * /api/v1/admin/cleanup:
 *   post:
 *     summary: Cleanup old data
 *     description: Clean up old job records and audit logs - admin only
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               days:
 *                 type: integer
 *                 default: 30
 *                 description: Number of days to keep data
 *               types:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [jobs, audit]
 *                 default: [jobs, audit]
 *                 description: Types of data to clean up
 *     responses:
 *       200:
 *         description: Cleanup completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 days:
 *                   type: integer
 *                 types:
 *                   type: array
 *                 results:
 *                   type: object
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/cleanup', requireAdmin(), asyncHandler(async (req, res) => {
  const { days = 30, types = ['jobs', 'audit'] } = req.body;

  const cleanupResults = {};

  if (types.includes('jobs')) {
    cleanupResults.jobs = await JobRecord.cleanupOldJobs(days);
  }

  if (types.includes('audit')) {
    cleanupResults.audit = await Audit.cleanupOldRecords(days);
  }

  // Log cleanup
  await Audit.logUsage({
    userId: req.user.id,
    type: 'system',
    action: 'admin_cleanup',
    details: {
      days,
      types,
      results: cleanupResults
    }
  });

  res.json({
    message: 'Cleanup completed',
    days,
    types,
    results: cleanupResults
  });
}));

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export default router;