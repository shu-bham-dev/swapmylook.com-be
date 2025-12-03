import express from 'express';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import { generateDownloadUrl } from '../config/storage.js';
import ImageAsset from '../models/ImageAsset.js';
import JobRecord from '../models/JobRecord.js';
import Project from '../models/Project.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';
import crypto from 'crypto';

/**
 * @swagger
 * tags:
 *   name: Gallery
 *   description: User gallery and output image management endpoints
 */

const router = express.Router();
const logger = createLogger('gallery-routes');

/**
 * @swagger
 * /api/v1/gallery:
 *   get:
 *     summary: Get user's gallery - output images
 *     description: Retrieve paginated list of user's generated output images with filtering
 *     tags: [Gallery]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of items per page
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [createdAt, updatedAt, sizeBytes, favorite]
 *           default: createdAt
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Filter by project ID
 *       - in: query
 *         name: favorite
 *         schema:
 *           type: boolean
 *         description: Filter by favorite status
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for filename or metadata
 *     responses:
 *       200:
 *         description: Gallery items retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 images:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ImageAsset'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     pages:
 *                       type: integer
 *                 filters:
 *                   type: object
 *                   properties:
 *                     projectId:
 *                       type: string
 *                     favorite:
 *                       type: boolean
 *                     search:
 *                       type: string
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/', requireAuth(), asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    projectId,
    favorite,
    search
  } = req.query;

  // Build filter for output images
  const filter = {
    userId: req.user.id,
    type: 'output',
    isDeleted: false
  };

  if (projectId) {
    filter.projectId = projectId;
  }

  if (favorite !== undefined) {
    filter.favorite = favorite === 'true';
  }

  // Text search
  if (search) {
    filter.$or = [
      { 'metadata.filename': { $regex: search, $options: 'i' } },
      { 'metadata.originalName': { $regex: search, $options: 'i' } },
      { 'metadata.prompt': { $regex: search, $options: 'i' } }
    ];
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  const [images, total] = await Promise.all([
    ImageAsset.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select('-storageKey -__v')
      .populate('originalImageId', 'url metadata'),
    ImageAsset.countDocuments(filter)
  ]);

  // Generate fresh URLs for each image
  const imagesWithUrls = await Promise.all(
    images.map(async (image) => {
      try {
        const signedUrl = await generateDownloadUrl(image.storageKey, 3600);
        return {
          ...image.toObject(),
          url: signedUrl
        };
      } catch (error) {
        logger.error('Error generating URL for gallery image', {
          imageId: image._id,
          error: error.message
        });
        return image;
      }
    })
  );

  res.json({
    images: imagesWithUrls,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    },
    filters: { projectId, favorite, search }
  });
}));

/**
 * @swagger
 * /api/v1/gallery/{id}:
 *   get:
 *     summary: Get gallery item details with generation history
 *     description: Retrieve detailed information about a specific gallery item including generation history
 *     tags: [Gallery]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Gallery item ID
 *     responses:
 *       200:
 *         description: Gallery item details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 image:
 *                   $ref: '#/components/schemas/ImageAsset'
 *                 generation:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: objectid
 *                     prompt:
 *                       type: string
 *                     options:
 *                       type: object
 *                     status:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     processingTime:
 *                       type: integer
 *                     inputModelImage:
 *                       type: object
 *                       properties:
 *                         url:
 *                           type: string
 *                           format: uri
 *                         metadata:
 *                           type: object
 *                     inputOutfitImage:
 *                       type: object
 *                       properties:
 *                         url:
 *                           type: string
 *                           format: uri
 *                         metadata:
 *                           type: object
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Gallery item not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const image = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    type: 'output',
    isDeleted: false
  }).populate('originalImageId', 'url metadata');

  if (!image) {
    throw new NotFoundError('Gallery item');
  }

  // Get generation job history for this output
  const job = await JobRecord.findOne({
    outputImageId: id,
    userId: req.user.id
  })
    .populate('inputModelImageId', 'url metadata')
    .populate('inputOutfitImageId', 'url metadata');

  // Generate fresh URL
  const signedUrl = await generateDownloadUrl(image.storageKey, 3600);

  // Log gallery view
  await Audit.logUsage({
    userId: req.user.id,
    type: 'download',
    action: 'gallery_item_viewed',
    resourceType: 'image',
    resourceId: image._id,
    details: {
      assetType: image.type,
      sizeBytes: image.sizeBytes
    }
  });

  res.json({
    image: {
      ...image.toObject(),
      url: signedUrl
    },
    generation: job ? {
      id: job._id,
      prompt: job.prompt,
      options: job.options,
      status: job.status,
      createdAt: job.createdAt,
      processingTime: job.processingTime,
      inputModelImage: job.inputModelImageId,
      inputOutfitImage: job.inputOutfitImageId
    } : null
  });
}));

/**
 * @swagger
 * /api/v1/gallery/{id}/favorite:
 *   post:
 *     summary: Toggle favorite status for gallery item
 *     description: Mark or unmark a gallery item as favorite
 *     tags: [Gallery]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Gallery item ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - favorite
 *             properties:
 *               favorite:
 *                 type: boolean
 *                 description: Whether to mark as favorite
 *                 example: true
 *     responses:
 *       200:
 *         description: Favorite status updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 favorite:
 *                   type: boolean
 *       400:
 *         description: Bad request - validation error
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
 *       404:
 *         description: Gallery item not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/:id/favorite', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { favorite } = req.body;

  if (typeof favorite !== 'boolean') {
    throw new ValidationError('Favorite must be a boolean');
  }

  const image = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    type: 'output',
    isDeleted: false
  });

  if (!image) {
    throw new NotFoundError('Gallery item');
  }

  image.favorite = favorite;
  await image.save();

  // Log favorite action
  await Audit.logUsage({
    userId: req.user.id,
    type: 'upload',
    action: favorite ? 'gallery_item_favorited' : 'gallery_item_unfavorited',
    resourceType: 'image',
    resourceId: image._id,
    details: {
      assetType: image.type
    }
  });

  res.json({
    message: favorite ? 'Added to favorites' : 'Removed from favorites',
    favorite: image.favorite
  });
}));

/**
 * @swagger
 * /api/v1/gallery/{id}/share:
 *   post:
 *     summary: Generate shareable link for gallery item
 *     description: Create a temporary shareable link for a gallery item
 *     tags: [Gallery]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Gallery item ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               expiresIn:
 *                 type: integer
 *                 default: 86400
 *                 description: Link expiration time in seconds - default 24 hours
 *                 example: 3600
 *     responses:
 *       200:
 *         description: Share link generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 shareUrl:
 *                   type: string
 *                   format: uri
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 shareToken:
 *                   type: string
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Gallery item not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/:id/share', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { expiresIn = 86400 } = req.body; // Default: 24 hours

  const image = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    type: 'output',
    isDeleted: false
  });

  if (!image) {
    throw new NotFoundError('Gallery item');
  }

  // Generate longer-lasting signed URL for sharing
  const shareUrl = await generateDownloadUrl(image.storageKey, parseInt(expiresIn));

  // Create share token (you could store this in DB for revocation)
  const shareToken = crypto.randomBytes(16).toString('hex');

  // Log sharing action
  await Audit.logUsage({
    userId: req.user.id,
    type: 'download',
    action: 'gallery_item_shared',
    resourceType: 'image',
    resourceId: image._id,
    details: {
      expiresIn,
      shareToken
    }
  });

  res.json({
    shareUrl,
    expiresAt: new Date(Date.now() + parseInt(expiresIn) * 1000),
    shareToken,
    message: `Share link will expire in ${Math.floor(expiresIn / 3600)} hours`
  });
}));

/**
 * @swagger
 * /api/v1/gallery/{id}:
 *   delete:
 *     summary: Delete gallery item - soft delete
 *     description: Soft delete a gallery item - marks as deleted but keeps record
 *     tags: [Gallery]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Gallery item ID
 *     responses:
 *       200:
 *         description: Gallery item deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 deletedAt:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Gallery item not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/:id', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const image = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    type: 'output',
    isDeleted: false
  });

  if (!image) {
    throw new NotFoundError('Gallery item');
  }

  await image.softDelete();

  // Log deletion
  await Audit.logUsage({
    userId: req.user.id,
    type: 'upload',
    action: 'gallery_item_deleted',
    resourceType: 'image',
    resourceId: image._id,
    details: {
      assetType: image.type,
      sizeBytes: image.sizeBytes
    }
  });

  res.json({ 
    message: 'Gallery item deleted successfully',
    deletedAt: image.deletedAt
  });
}));

/**
 * @swagger
 * /api/v1/gallery/stats:
 *   get:
 *     summary: Get gallery statistics
 *     description: Retrieve statistics about user's gallery items
 *     tags: [Gallery]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Gallery statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalItems:
 *                   type: integer
 *                 totalSize:
 *                   type: integer
 *                 totalSizeHuman:
 *                   type: string
 *                 favoriteItems:
 *                   type: integer
 *                 monthlyBreakdown:
 *                   type: object
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/stats', requireAuth(), asyncHandler(async (req, res) => {
  const stats = await ImageAsset.aggregate([
    {
      $match: {
        userId: req.user._id,
        type: 'output',
        isDeleted: false
      }
    },
    {
      $group: {
        _id: null,
        totalItems: { $sum: 1 },
        totalSize: { $sum: '$sizeBytes' },
        favoriteItems: {
          $sum: { $cond: [{ $eq: ['$favorite', true] }, 1, 0] }
        },
        byMonth: {
          $push: {
            month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
            size: '$sizeBytes'
          }
        }
      }
    }
  ]);

  const monthlyBreakdown = {};
  if (stats[0]?.byMonth) {
    stats[0].byMonth.forEach(item => {
      if (!monthlyBreakdown[item.month]) {
        monthlyBreakdown[item.month] = { count: 0, size: 0 };
      }
      monthlyBreakdown[item.month].count += 1;
      monthlyBreakdown[item.month].size += item.size;
    });
  }

  const result = stats[0] || {
    totalItems: 0,
    totalSize: 0,
    favoriteItems: 0
  };

  res.json({
    totalItems: result.totalItems,
    totalSize: result.totalSize,
    totalSizeHuman: formatBytes(result.totalSize),
    favoriteItems: result.favoriteItems,
    monthlyBreakdown
  });
}));

/**
 * @swagger
 * /api/v1/gallery/projects:
 *   get:
 *     summary: Get projects with gallery items
 *     description: Retrieve list of projects that contain gallery items
 *     tags: [Gallery]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Projects retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 projects:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: objectid
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       imageCount:
 *                         type: integer
 *                       coverImageUrl:
 *                         type: string
 *                         format: uri
 *                       stats:
 *                         type: object
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/projects', requireAuth(), asyncHandler(async (req, res) => {
  const projects = await Project.find({
    userId: req.user.id,
    isArchived: false
  }).select('name description coverImageId stats');

  // Get image counts for each project
  const projectsWithCounts = await Promise.all(
    projects.map(async (project) => {
      const imageCount = await ImageAsset.countDocuments({
        userId: req.user.id,
        projectId: project._id,
        type: 'output',
        isDeleted: false
      });

      let coverImageUrl = null;
      if (project.coverImageId) {
        const coverImage = await ImageAsset.findById(project.coverImageId);
        if (coverImage) {
          coverImageUrl = await generateDownloadUrl(coverImage.storageKey, 3600);
        }
      }

      return {
        id: project._id,
        name: project.name,
        description: project.description,
        imageCount,
        coverImageUrl,
        stats: project.stats,
        createdAt: project.createdAt
      };
    })
  );

  res.json({ projects: projectsWithCounts });
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