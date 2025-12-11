import express from 'express';
import { asyncHandler, ValidationError } from '../middleware/errorHandler.js';
import { generateDownloadUrl } from '../config/storage.js';
import ImageAsset from '../models/ImageAsset.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('public-routes');

/**
 * @swagger
 * /api/v1/public/images:
 *   get:
 *     summary: Fetch public images with filtering
 *     description: Retrieve public images (models and outfits) with filtering by name, type, and tags
 *     tags: [Public]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [model, outfit]
 *         description: Filter by image type (model or outfit)
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by name (partial match, case-insensitive)
 *       - in: query
 *         name: tags
 *         schema:
 *           type: string
 *         description: Comma-separated list of tags to filter by (all tags must match)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
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
 *           enum: [createdAt, updatedAt, name]
 *           default: createdAt
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Public images retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 images:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: objectid
 *                       name:
 *                         type: string
 *                       type:
 *                         type: string
 *                         enum: [model, outfit]
 *                       url:
 *                         type: string
 *                         format: uri
 *                       width:
 *                         type: integer
 *                       height:
 *                         type: integer
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
 *                     name:
 *                       type: string
 *                     tags:
 *                       type: string
 *       400:
 *         description: Bad request - validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/images', asyncHandler(async (req, res) => {
  const {
    type,
    name,
    tags,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;

  // Build filter - only public, non-deleted images of type model or outfit
  const filter = {
    isPublic: true,
    isDeleted: false,
    type: { $in: ['model', 'outfit'] }
  };

  // Filter by type
  if (type) {
    if (!['model', 'outfit'].includes(type)) {
      throw new ValidationError('Type must be either "model" or "outfit"');
    }
    filter.type = type;
  }

  // Filter by name (search in name field)
  if (name) {
    filter.name = { $regex: name, $options: 'i' };
  }

  // Filter by tags (comma-separated)
  if (tags) {
    const tagArray = tags.split(',').map(tag => tag.trim().toLowerCase());
    if (tagArray.length > 0) {
      filter.tags = { $all: tagArray };
    }
  }

  // Pagination
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  // Execute query
  const [images, total] = await Promise.all([
    ImageAsset.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select('-storageKey -__v -userId -projectId -nanobananaJobId -favorite'),
    ImageAsset.countDocuments(filter)
  ]);
  // Generate fresh URLs for each image
  const imagesWithUrls = await Promise.all(
    images.map(async (image) => {
        let url = image.url;
      
      try {
        // const signedUrl = await generateDownloadUrl(image.storageKey, 3600);
        // url = signedUrl;
        // console.log(signedUrl,"<<<<<>>>>>");
      } catch (error) {
        logger.error('Error generating URL for public image', {
          imageId: image._id,
          error: error.message
        });
        // Keep the existing url if available
        if (!url) {
          url = null;
        }
      }
      return {
        id: image._id,
        name: image.name || image.metadata?.originalName || image.metadata?.filename || 'Unnamed',
        type: image.type,
        url: url,
        width: image.width,
        height: image.height,
        tags: image.tags,
        metadata: image.metadata
      };
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
    filters: { type, name, tags }
  });
}));

export default router;