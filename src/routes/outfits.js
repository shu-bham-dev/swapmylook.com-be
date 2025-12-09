import express from 'express';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import ImageAsset from '../models/ImageAsset.js';
import JobRecord from '../models/JobRecord.js';
import Audit from '../models/Audit.js';
import User from '../models/User.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('outfits-routes');

/**
 * @swagger
 * /api/v1/outfits:
 *   get:
 *     summary: Get user's outfits (models, outfits, and AI-generated images)
 *     description: Retrieve all images (models, outfits, and AI-generated outputs) for the authenticated user
 *     tags: [Outfits]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [model, outfit, output, all]
 *         description: Filter by image type
 *         example: "all"
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Page number for pagination
 *         example: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Number of items per page
 *         example: 20
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [createdAt, updatedAt, sizeBytes]
 *         description: Field to sort by
 *         example: "createdAt"
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort order
 *         example: "desc"
 *       - in: query
 *         name: favorite
 *         schema:
 *           type: boolean
 *         description: Filter by favorite status
 *     responses:
 *       200:
 *         description: User outfits retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 outfits:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: objectid
 *                       type:
 *                         type: string
 *                         enum: [model, outfit, output]
 *                       url:
 *                         type: string
 *                         format: uri
 *                       width:
 *                         type: integer
 *                       height:
 *                         type: integer
 *                       sizeBytes:
 *                         type: integer
 *                       mimeType:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                       favorite:
 *                         type: boolean
 *                       tags:
 *                         type: array
 *                         items:
 *                           type: string
 *                       metadata:
 *                         type: object
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
 *                     type:
 *                       type: string
 *                     favorite:
 *                       type: boolean
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/', requireAuth(), asyncHandler(async (req, res) => {
  const {
    type = 'all',
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    favorite
  } = req.query;

  // Build filter - only show user's own images
  const filter = {
    userId: req.user._id,
    isDeleted: false
  };

  // Filter by type - outfits API should only return model, outfit, and output types
  if (type !== 'all') {
    filter.type = type;
  } else {
    // When type=all, exclude profile and thumbnail types
    filter.type = { $in: ['model', 'outfit', 'output'] };
  }

  // Filter by favorite
  if (favorite !== undefined) {
    filter.favorite = favorite === 'true';
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  const [outfits, total] = await Promise.all([
    ImageAsset.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select('-storageKey -__v'),
    ImageAsset.countDocuments(filter)
  ]);

  // Log outfits retrieval
  await Audit.logUsage({
    userId: req.user._id,
    type: 'outfits',
    action: 'outfits_retrieved',
    resourceType: 'outfits',
    details: {
      type,
      page,
      limit,
      total,
      filters: { type, favorite }
    }
  });

  res.json({
    outfits: outfits.map(outfit => ({
      id: outfit._id,
      type: outfit.type,
      url: outfit.url,
      width: outfit.width,
      height: outfit.height,
      sizeBytes: outfit.sizeBytes,
      mimeType: outfit.mimeType,
      createdAt: outfit.createdAt,
      updatedAt: outfit.updatedAt,
      favorite: outfit.favorite,
      tags: outfit.tags,
      metadata: outfit.metadata
    })),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    },
    filters: { type, favorite }
  });
}));

/**
 * @swagger
 * /api/v1/outfits/stats:
 *   get:
 *     summary: Get user's outfits statistics
 *     description: Get statistics about user's uploaded models, outfits, and generated images
 *     tags: [Outfits]
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
 *                 total:
 *                   type: integer
 *                   description: Total number of images
 *                 byType:
 *                   type: object
 *                   properties:
 *                     model:
 *                       type: integer
 *                     outfit:
 *                       type: integer
 *                     output:
 *                       type: integer
 *                 storageUsage:
 *                   type: object
 *                   properties:
 *                     totalBytes:
 *                       type: integer
 *                     totalFiles:
 *                       type: integer
 *                     byType:
 *                       type: object
 *                 favorites:
 *                   type: integer
 *                   description: Number of favorite images
 *                 generationAttempts:
 *                   type: integer
 *                   description: Total number of generation attempts (including failed)
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/stats', requireAuth(), asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Get counts by type - outfits API should only count model, outfit, and output types
  const countsByType = await ImageAsset.aggregate([
    {
      $match: {
        userId: req.user._id,
        isDeleted: false,
        type: { $in: ['model', 'outfit', 'output'] }
      }
    },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 }
      }
    }
  ]);

  // Get storage usage - outfits API should only count model, outfit, and output types
  const storageUsage = await ImageAsset.getOutfitsStorageUsage(userId);

  // Get favorites count - outfits API should only count model, outfit, and output types
  const favoritesCount = await ImageAsset.countDocuments({
    userId: req.user._id,
    isDeleted: false,
    favorite: true,
    type: { $in: ['model', 'outfit', 'output'] }
  });

  // Get generation attempts count
  const user = await User.findById(userId).select('generationAttempts');
  const generationAttempts = user ? user.generationAttempts : 0;

  // Format counts by type
  const byType = {
    model: 0,
    outfit: 0,
    output: 0
  };

  countsByType.forEach(item => {
    byType[item._id] = item.count;
  });

  // Log statistics retrieval
  await Audit.logUsage({
    userId: req.user._id,
    type: 'outfits',
    action: 'stats_retrieved',
    resourceType: 'outfits',
    details: {
      total: storageUsage.totalFiles,
      byType,
      favorites: favoritesCount,
      storageUsage: storageUsage.totalBytes,
      generationAttempts
    }
  });

  res.json({
    total: storageUsage.totalFiles,
    byType,
    storageUsage,
    favorites: favoritesCount,
    generationAttempts
  });
}));

/**
 * @swagger
 * /api/v1/outfits/{id}/favorite:
 *   post:
 *     summary: Toggle favorite status for an image
 *     description: Mark or unmark an image as favorite
 *     tags: [Outfits]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Image asset ID
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
 *                 image:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     favorite:
 *                       type: boolean
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
 *         description: Image not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/:id/favorite', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { favorite } = req.body;

  if (typeof favorite !== 'boolean') {
    throw new ValidationError('favorite field is required and must be a boolean');
  }

  const image = await ImageAsset.findOne({
    _id: id,
    userId: req.user._id,
    isDeleted: false
  });

  if (!image) {
    throw new NotFoundError('Image');
  }

  image.favorite = favorite;
  await image.save();

  // Log favorite action
  await Audit.logUsage({
    userId: req.user._id,
    type: 'outfits',
    action: favorite ? 'image_favorited' : 'image_unfavorited',
    resourceType: 'image',
    resourceId: image._id,
    details: {
      imageType: image.type,
      favorite
    }
  });

  res.json({
    message: favorite ? 'Image marked as favorite' : 'Image removed from favorites',
    image: {
      id: image._id,
      favorite: image.favorite
    }
  });
}));

/**
 * @swagger
 * /api/v1/outfits/{id}/tags:
 *   post:
 *     summary: Update tags for an image
 *     description: Add or update tags for an image asset
 *     tags: [Outfits]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Image asset ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tags
 *             properties:
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of tags
 *                 example: ["casual", "summer", "blue"]
 *     responses:
 *       200:
 *         description: Tags updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 image:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     tags:
 *                       type: array
 *                       items:
 *                         type: string
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
 *         description: Image not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/:id/tags', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { tags } = req.body;

  if (!Array.isArray(tags)) {
    throw new ValidationError('tags must be an array');
  }

  // Validate tags (max 10 tags, each max 20 chars)
  if (tags.length > 10) {
    throw new ValidationError('Maximum 10 tags allowed');
  }

  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length > 20) {
      throw new ValidationError('Each tag must be a string with maximum 20 characters');
    }
  }

  const image = await ImageAsset.findOne({
    _id: id,
    userId: req.user._id,
    isDeleted: false
  });

  if (!image) {
    throw new NotFoundError('Image');
  }

  image.tags = tags.map(tag => tag.trim().toLowerCase());
  await image.save();

  // Log tags update
  await Audit.logUsage({
    userId: req.user._id,
    type: 'outfits',
    action: 'tags_updated',
    resourceType: 'image',
    resourceId: image._id,
    details: {
      imageType: image.type,
      tagsCount: tags.length,
      tags
    }
  });

  res.json({
    message: 'Tags updated successfully',
    image: {
      id: image._id,
      tags: image.tags
    }
  });
}));

/**
 * @swagger
 * /api/v1/outfits/{id}:
 *   delete:
 *     summary: Soft delete an image
 *     description: Mark an image as deleted (soft delete)
 *     tags: [Outfits]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Image asset ID
 *     responses:
 *       200:
 *         description: Image deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 image:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     isDeleted:
 *                       type: boolean
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Image not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/:id', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const image = await ImageAsset.findOne({
    _id: id,
    userId: req.user._id,
    isDeleted: false
  });

  if (!image) {
    throw new NotFoundError('Image');
  }

  await image.softDelete();

  // Log deletion
  await Audit.logUsage({
    userId: req.user._id,
    type: 'outfits',
    action: 'image_deleted',
    resourceType: 'image',
    resourceId: image._id,
    details: {
      imageType: image.type,
      sizeBytes: image.sizeBytes
    }
  });

  res.json({
    message: 'Image deleted successfully',
    image: {
      id: image._id,
      isDeleted: image.isDeleted
    }
  });
}));

export default router;