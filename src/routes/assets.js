import express from 'express';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import { generateDownloadUrl, deleteObject } from '../config/storage.js';
import ImageAsset from '../models/ImageAsset.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

/**
 * @swagger
 * tags:
 *   name: Assets
 *   description: Image asset management and retrieval endpoints
 */

const router = express.Router();
const logger = createLogger('assets-routes');

/**
 * @swagger
 * /api/v1/assets/{id}:
 *   get:
 *     summary: Get asset metadata and signed URL
 *     description: Retrieve asset metadata and generate a fresh signed download URL
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Asset ID
 *     responses:
 *       200:
 *         description: Asset retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ImageAsset'
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Asset not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const asset = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    isDeleted: false
  });

  if (!asset) {
    throw new NotFoundError('Image asset');
  }

  // Generate fresh signed URL
  const signedUrl = await generateDownloadUrl(asset.storageKey, 3600); // 1 hour expiration

  // Update asset URL (optional - you might want to keep the original URL)
  asset.url = signedUrl;
  await asset.save();

  // Log asset access
  await Audit.logUsage({
    userId: req.user.id,
    type: 'download',
    action: 'asset_accessed',
    resourceType: 'image',
    resourceId: asset._id,
    details: {
      assetType: asset.type,
      sizeBytes: asset.sizeBytes
    }
  });

  res.json({
    id: asset._id,
    type: asset.type,
    url: signedUrl,
    width: asset.width,
    height: asset.height,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    metadata: asset.metadata,
    projectId: asset.projectId
  });
}));

/**
 * @swagger
 * /api/v1/assets/{id}:
 *   delete:
 *     summary: Delete asset - soft delete
 *     description: Soft delete an asset - marks as deleted but keeps record
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Asset ID
 *     responses:
 *       200:
 *         description: Asset deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Asset deleted successfully"
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
 *         description: Asset not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/:id', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const asset = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    isDeleted: false
  });

  if (!asset) {
    throw new NotFoundError('Image asset');
  }

  // Soft delete - mark as deleted but keep record
  await asset.softDelete();

  // Optionally: Actually delete from storage (commented out for safety)
  // await deleteObject(asset.storageKey);

  // Log deletion
  await Audit.logUsage({
    userId: req.user.id,
    type: 'upload',
    action: 'asset_deleted',
    resourceType: 'image',
    resourceId: asset._id,
    details: {
      assetType: asset.type,
      sizeBytes: asset.sizeBytes,
      storageKey: asset.storageKey
    }
  });

  res.json({ 
    message: 'Asset deleted successfully',
    deletedAt: asset.deletedAt
  });
}));

/**
 * @swagger
 * /api/v1/assets:
 *   get:
 *     summary: List user's assets with filtering and pagination
 *     description: Retrieve paginated list of user's assets with filtering options
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [model, outfit, output, thumbnail]
 *         description: Filter by asset type
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Filter by project ID
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
 *         description: Assets retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 assets:
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
 *                     type:
 *                       type: string
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
    type, 
    projectId, 
    page = 1, 
    limit = 20, 
    sortBy = 'createdAt', 
    sortOrder = 'desc',
    favorite,
    search
  } = req.query;

  // Build filter object
  const filter = {
    userId: req.user.id,
    isDeleted: false
  };

  if (type) {
    filter.type = type;
  }

  if (projectId) {
    filter.projectId = projectId;
  }

  if (favorite !== undefined) {
    filter.favorite = favorite === 'true';
  }

  // Text search (if implemented)
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

  // Execute query
  const [assets, total] = await Promise.all([
    ImageAsset.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select('-storageKey -__v'),
    ImageAsset.countDocuments(filter)
  ]);

  // Generate fresh URLs for each asset
  const assetsWithUrls = await Promise.all(
    assets.map(async (asset) => {
      try {
        const signedUrl = await generateDownloadUrl(asset.storageKey, 3600);
        return {
          ...asset.toObject(),
          url: signedUrl
        };
      } catch (error) {
        logger.error('Error generating URL for asset', {
          assetId: asset._id,
          error: error.message
        });
        return asset;
      }
    })
  );

  res.json({
    assets: assetsWithUrls,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    },
    filters: {
      type,
      projectId,
      favorite,
      search
    }
  });
}));

/**
 * @swagger
 * /api/v1/assets/{id}/favorite:
 *   patch:
 *     summary: Toggle favorite status for asset
 *     description: Mark or unmark an asset as favorite
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Asset ID
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
 *         description: Asset not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.patch('/:id/favorite', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { favorite } = req.body;

  if (typeof favorite !== 'boolean') {
    throw new ValidationError('Favorite must be a boolean');
  }

  const asset = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    isDeleted: false
  });

  if (!asset) {
    throw new NotFoundError('Image asset');
  }

  asset.favorite = favorite;
  await asset.save();

  // Log favorite action
  await Audit.logUsage({
    userId: req.user.id,
    type: 'upload',
    action: favorite ? 'asset_favorited' : 'asset_unfavorited',
    resourceType: 'image',
    resourceId: asset._id,
    details: {
      assetType: asset.type
    }
  });

  res.json({
    message: favorite ? 'Asset added to favorites' : 'Asset removed from favorites',
    favorite: asset.favorite
  });
}));

/**
 * @swagger
 * /api/v1/assets/{id}/metadata:
 *   put:
 *     summary: Update asset metadata
 *     description: Update metadata for an asset - merges with existing metadata
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Asset ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - metadata
 *             properties:
 *               metadata:
 *                 type: object
 *                 description: Metadata object to merge with existing metadata
 *                 example: { tags: ["summer", "casual"], description: "Summer outfit" }
 *     responses:
 *       200:
 *         description: Metadata updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 metadata:
 *                   type: object
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
 *         description: Asset not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/:id/metadata', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { metadata } = req.body;

  if (!metadata || typeof metadata !== 'object') {
    throw new ValidationError('Metadata must be an object');
  }

  const asset = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    isDeleted: false
  });

  if (!asset) {
    throw new NotFoundError('Image asset');
  }

  // Update metadata (merge with existing)
  asset.metadata = { ...asset.metadata, ...metadata };
  await asset.save();

  // Log metadata update
  await Audit.logUsage({
    userId: req.user.id,
    type: 'upload',
    action: 'metadata_updated',
    resourceType: 'image',
    resourceId: asset._id,
    details: {
      assetType: asset.type,
      updatedFields: Object.keys(metadata)
    }
  });

  res.json({
    message: 'Metadata updated successfully',
    metadata: asset.metadata
  });
}));

/**
 * @swagger
 * /api/v1/assets/storage/usage:
 *   get:
 *     summary: Get user's storage usage statistics
 *     description: Retrieve storage usage statistics for the authenticated user
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Storage usage retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalBytes:
 *                   type: integer
 *                   description: Total storage used in bytes
 *                 totalFiles:
 *                   type: integer
 *                   description: Total number of files
 *                 byType:
 *                   type: object
 *                   description: Usage breakdown by asset type
 *                 totalBytesHuman:
 *                   type: string
 *                   description: Human-readable storage size
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/storage/usage', requireAuth(), asyncHandler(async (req, res) => {
  const usage = await ImageAsset.getStorageUsage(req.user.id);

  res.json({
    totalBytes: usage.totalBytes,
    totalFiles: usage.totalFiles,
    byType: usage.byType,
    totalBytesHuman: formatBytes(usage.totalBytes)
  });
}));

/**
 * @swagger
 * /api/v1/assets/{id}/restore:
 *   post:
 *     summary: Restore soft-deleted asset
 *     description: Restore a previously soft-deleted asset
 *     tags: [Assets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: objectid
 *         description: Asset ID
 *     responses:
 *       200:
 *         description: Asset restored successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 restoredAt:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Asset not found or not deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/:id/restore', requireAuth(), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const asset = await ImageAsset.findOne({
    _id: id,
    userId: req.user.id,
    isDeleted: true
  });

  if (!asset) {
    throw new NotFoundError('Deleted image asset');
  }

  await asset.restore();

  // Log restoration
  await Audit.logUsage({
    userId: req.user.id,
    type: 'upload',
    action: 'asset_restored',
    resourceType: 'image',
    resourceId: asset._id,
    details: {
      assetType: asset.type
    }
  });

  res.json({ 
    message: 'Asset restored successfully',
    restoredAt: new Date()
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