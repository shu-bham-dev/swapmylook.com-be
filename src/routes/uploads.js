import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError } from '../middleware/errorHandler.js';
import { uploadRateLimiter, usageTracker } from '../middleware/rateLimiter.js';
import { generateStorageKey, generateUploadUrl, generateDownloadUrl, uploadBuffer, getObjectMetadata } from '../config/storage.js';
import ImageAsset from '../models/ImageAsset.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

/**
 * @swagger
 * tags:
 *   name: Uploads
 *   description: File upload and asset management endpoints
 */

const router = express.Router();
const logger = createLogger('upload-routes');

// Configure multer for in-memory file handling (for small files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB default
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = (process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml,image/bmp,image/tiff')
      .split(',')
      .map(type => type.trim());

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ValidationError(`File type ${file.mimetype} not allowed`), false);
    }
  }
});

/**
 * @swagger
 * /api/v1/uploads/signed-url:
 *   post:
 *     summary: Generate signed URL for direct upload
 *     description: Generate a pre-signed URL for direct upload to object storage - S3/B2 compatible
 *     tags: [Uploads]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - filename
 *               - contentType
 *               - purpose
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Original filename
 *                 example: "model-photo.jpg"
 *               contentType:
 *                 type: string
 *                 description: MIME type of the file
 *                 example: "image/jpeg"
 *               purpose:
 *                 type: string
 *                 enum: [model, outfit, output, thumbnail, other]
 *                 description: Purpose of the upload
 *                 example: "model"
 *               sizeBytes:
 *                 type: integer
 *                 description: File size in bytes - for validation
 *                 example: 5242880
 *               projectId:
 *                 type: string
 *                 format: objectid
 *                 description: Optional project ID to associate with the upload
 *     responses:
 *       200:
 *         description: Signed URL generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uploadUrl:
 *                   type: string
 *                   format: uri
 *                   description: Pre-signed URL for direct upload
 *                 storageKey:
 *                   type: string
 *                   description: Storage key/path for the uploaded file
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                   description: URL expiration time
 *                 purpose:
 *                   type: string
 *                   description: Upload purpose
 *                 maxSize:
 *                   type: integer
 *                   description: Maximum allowed file size in bytes
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
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/signed-url', requireAuth(), uploadRateLimiter, asyncHandler(async (req, res) => {
  const { filename, contentType, purpose, sizeBytes, projectId } = req.body;

  // Validate required fields
  if (!filename || !contentType || !purpose) {
    throw new ValidationError('Filename, contentType, and purpose are required');
  }

  // Validate purpose
  const allowedPurposes = ['model', 'outfit', 'output', 'thumbnail', 'other'];
  if (!allowedPurposes.includes(purpose)) {
    throw new ValidationError(`Purpose must be one of: ${allowedPurposes.join(', ')}`);
  }

  // Validate file size
  const maxSize = parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024;
  if (sizeBytes && sizeBytes > maxSize) {
    throw new ValidationError(`File size exceeds maximum allowed size of ${maxSize} bytes`);
  }

  // Generate storage key
  const storageKey = generateStorageKey(`uploads/${purpose}`, filename, req.user._id);

  // Generate signed upload URL
  const { uploadUrl, expiresAt } = await generateUploadUrl(
    storageKey,
    contentType,
    300 // 5 minutes expiration
  );

  // Log the signed URL generation
  await Audit.logUsage({
    userId: req.user._id,
    type: 'upload',
    action: 'signed_url_generated',
    resourceType: 'upload',
    details: {
      filename,
      contentType,
      purpose,
      sizeBytes,
      storageKey,
      expiresAt
    }
  });

  res.json({
    uploadUrl,
    storageKey,
    expiresAt: expiresAt.toISOString(),
    purpose,
    maxSize
  });
}));

/**
 * @swagger
 * /api/v1/uploads/complete:
 *   post:
 *     summary: Complete upload and create asset record
 *     description: Complete the upload process by creating an image asset record after file has been uploaded to storage
 *     tags: [Uploads]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - storageKey
 *               - type
 *               - mimeType
 *               - sizeBytes
 *             properties:
 *               storageKey:
 *                 type: string
 *                 description: Storage key returned from signed URL generation
 *                 example: "uploads/model/user-123/model-photo.jpg"
 *               type:
 *                 type: string
 *                 enum: [model, outfit, output, thumbnail]
 *                 description: Type of image asset
 *                 example: "model"
 *               width:
 *                 type: integer
 *                 description: Image width in pixels
 *                 example: 1920
 *               height:
 *                 type: integer
 *                 description: Image height in pixels
 *                 example: 1080
 *               mimeType:
 *                 type: string
 *                 description: MIME type of the file
 *                 example: "image/jpeg"
 *               sizeBytes:
 *                 type: integer
 *                 description: File size in bytes
 *                 example: 5242880
 *               projectId:
 *                 type: string
 *                 format: objectid
 *                 description: Optional project ID
 *               metadata:
 *                 type: object
 *                 description: Additional metadata
 *     responses:
 *       201:
 *         description: Image asset created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 imageAsset:
 *                   $ref: '#/components/schemas/ImageAsset'
 *       400:
 *         description: Bad request - validation error or file not found
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
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/complete', requireAuth(), uploadRateLimiter, asyncHandler(async (req, res) => {
  const { storageKey, type, width, height, mimeType, sizeBytes, projectId, metadata } = req.body;

  // Validate required fields
  if (!storageKey || !type || !mimeType || !sizeBytes) {
    throw new ValidationError('storageKey, type, mimeType, and sizeBytes are required');
  }

  // Validate type
  const allowedTypes = ['model', 'outfit', 'output', 'thumbnail'];
  if (!allowedTypes.includes(type)) {
    throw new ValidationError(`Type must be one of: ${allowedTypes.join(', ')}`);
  }

  // Verify the file exists in storage
  const exists = await getObjectMetadata(storageKey).catch(() => false);
  if (!exists) {
    throw new ValidationError('File not found in storage. Please upload first.');
  }

  // Generate public URL (or signed URL can be generated on demand)
  const downloadUrl = await generateDownloadUrl(storageKey, 3600); // 1 hour expiration for initial access

  // Create image asset record
  const imageAsset = new ImageAsset({
    userId: req.user._id,
    projectId: projectId || null,
    type,
    storageKey,
    url: downloadUrl,
    width: width || null,
    height: height || null,
    mimeType,
    sizeBytes: parseInt(sizeBytes),
    metadata: {
      filename: storageKey.split('/').pop(),
      originalName: metadata?.originalName,
      uploadDate: new Date(),
      ...metadata
    }
  });

  await imageAsset.save();

  // Log successful upload completion
  await Audit.logUsage({
    userId: req.user._id,
    type: 'upload',
    action: 'upload_completed',
    resourceType: 'image',
    resourceId: imageAsset._id,
    details: {
      storageKey,
      type,
      sizeBytes,
      mimeType,
      projectId
    }
  });

  res.status(201).json({
    imageAsset: {
      id: imageAsset._id,
      type: imageAsset.type,
      url: imageAsset.url,
      width: imageAsset.width,
      height: imageAsset.height,
      mimeType: imageAsset.mimeType,
      sizeBytes: imageAsset.sizeBytes,
      createdAt: imageAsset.createdAt,
      metadata: imageAsset.metadata
    }
  });
}));

/**
 * @swagger
 * /api/v1/uploads/direct:
 *   post:
 *     summary: Direct file upload
 *     description: Upload file directly through the API - for smaller files
 *     tags: [Uploads]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *               - purpose
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: File to upload
 *               purpose:
 *                 type: string
 *                 enum: [model, outfit, output, thumbnail, other]
 *                 description: Purpose of the upload
 *                 example: "model"
 *               projectId:
 *                 type: string
 *                 format: objectid
 *                 description: Optional project ID
 *     responses:
 *       201:
 *         description: File uploaded and asset created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 imageAsset:
 *                   $ref: '#/components/schemas/ImageAsset'
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
 *       413:
 *         description: File too large
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/direct', requireAuth(), uploadRateLimiter, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ValidationError('No file uploaded');
  }

  const { purpose, projectId, name, tags, isPublic } = req.body;
  const file = req.file;

  // Validate purpose
  const allowedPurposes = ['model', 'outfit', 'output', 'thumbnail', 'other'];
  if (!purpose || !allowedPurposes.includes(purpose)) {
    throw new ValidationError(`Purpose must be one of: ${allowedPurposes.join(', ')}`);
  }

  // Get image dimensions if it's an image
  let width, height;
  if (file.mimetype.startsWith('image/')) {
    try {
      const metadata = await sharp(file.buffer).metadata();
      width = metadata.width;
      height = metadata.height;
    } catch (error) {
      logger.warn('Could not extract image metadata', { error: error.message });
    }
  }

  // Generate storage key
  const storageKey = generateStorageKey(`uploads/${purpose}`, file.originalname, req.user._id);

  // Upload directly to storage
  await uploadBuffer(file.buffer, storageKey, file.mimetype);

  // Generate download URL
  const downloadUrl = await generateDownloadUrl(storageKey, 3600);

  // Create image asset record
  // For profile pictures (purpose 'other'), use type 'profile'
  const assetType = purpose === 'other' ? 'profile' : purpose;
  // Parse tags if provided (comma-separated string or array)
  let tagArray = [];
  if (tags) {
    if (typeof tags === 'string') {
      tagArray = tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    } else if (Array.isArray(tags)) {
      tagArray = tags.map(tag => tag.trim()).filter(tag => tag.length > 0);
    }
  }
  const imageAsset = new ImageAsset({
    userId: req.user._id,
    projectId: projectId || null,
    type: assetType,
    storageKey,
    url: downloadUrl,
    width,
    height,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    name: name || file.originalname,
    tags: tagArray,
    isPublic: isPublic === 'true' || isPublic === true,
    metadata: {
      filename: file.originalname,
      uploadDate: new Date()
    }
  });

  await imageAsset.save();

  // Log successful direct upload
  await Audit.logUsage({
    userId: req.user._id,
    type: 'upload',
    action: 'direct_upload_completed',
    resourceType: 'image',
    resourceId: imageAsset._id,
    details: {
      filename: file.originalname,
      purpose,
      sizeBytes: file.size,
      mimeType: file.mimetype
    }
  });

  res.status(201).json({
    imageAsset: {
      id: imageAsset._id,
      type: imageAsset.type,
      url: imageAsset.url,
      width: imageAsset.width,
      height: imageAsset.height,
      mimeType: imageAsset.mimeType,
      sizeBytes: imageAsset.sizeBytes,
      createdAt: imageAsset.createdAt
    }
  });
}));

/**
 * @swagger
 * /api/v1/uploads/thumbnail:
 *   post:
 *     summary: Generate thumbnails from image
 *     description: Generate thumbnails of different sizes from an existing image asset
 *     tags: [Uploads]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - imageId
 *             properties:
 *               imageId:
 *                 type: string
 *                 format: objectid
 *                 description: ID of the original image asset
 *                 example: "64abf1234567890abcdef123"
 *               sizes:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of thumbnail sizes - width/height in pixels
 *                 example: [256, 512]
 *     responses:
 *       200:
 *         description: Thumbnails generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 thumbnails:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: objectid
 *                       url:
 *                         type: string
 *                         format: uri
 *                       width:
 *                         type: integer
 *                       height:
 *                         type: integer
 *                       size:
 *                         type: integer
 *                       createdAt:
 *                         type: string
 *                         format: date-time
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
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/thumbnail', requireAuth(), uploadRateLimiter, asyncHandler(async (req, res) => {
  const { imageId, sizes = [256, 512] } = req.body;

  if (!imageId) {
    throw new ValidationError('imageId is required');
  }

  // Get original image
  const originalImage = await ImageAsset.findOne({
    _id: imageId,
    userId: req.user.id,
    isDeleted: false
  });

  if (!originalImage) {
    throw new ValidationError('Image not found or access denied');
  }

  // Generate thumbnails for each requested size
  const thumbnails = [];

  for (const size of sizes) {
    // Download original image
    // Note: In production, you'd want to stream this instead of loading into memory
    const response = await fetch(originalImage.url);
    const buffer = await response.arrayBuffer();
    
    // Create thumbnail
    const thumbnailBuffer = await sharp(Buffer.from(buffer))
      .resize(size, size, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Generate storage key for thumbnail
    const thumbnailKey = generateStorageKey(
      'thumbnails',
      `thumbnail-${size}-${originalImage.metadata.filename}.jpg`,
      req.user._id
    );

    // Upload thumbnail
    await uploadBuffer(thumbnailBuffer, thumbnailKey, 'image/jpeg');

    // Generate download URL
    const thumbnailUrl = await generateDownloadUrl(thumbnailKey, 86400); // 24 hours

    // Create thumbnail asset record
    const thumbnailAsset = new ImageAsset({
      userId: req.user._id,
      projectId: originalImage.projectId,
      type: 'thumbnail',
      storageKey: thumbnailKey,
      url: thumbnailUrl,
      width: size,
      height: size,
      mimeType: 'image/jpeg',
      sizeBytes: thumbnailBuffer.length,
      originalImageId: originalImage._id,
      metadata: {
        originalFilename: originalImage.metadata.filename,
        size,
        generatedAt: new Date()
      }
    });

    await thumbnailAsset.save();
    thumbnails.push(thumbnailAsset);
  }

  // Log thumbnail generation
  await Audit.logUsage({
    userId: req.user._id,
    type: 'upload',
    action: 'thumbnails_generated',
    resourceType: 'image',
    resourceId: originalImage._id,
    details: {
      originalImageId: originalImage._id,
      sizes,
      thumbnailsCount: thumbnails.length
    }
  });

  res.json({
    thumbnails: thumbnails.map(thumb => ({
      id: thumb._id,
      url: thumb.url,
      width: thumb.width,
      height: thumb.height,
      size: thumb.sizeBytes,
      createdAt: thumb.createdAt
    }))
  });
}));

/**
 * @swagger
 * /api/v1/uploads/limits:
 *   get:
 *     summary: Get upload limits and allowed types
 *     description: Returns the current upload limits and allowed file types
 *     tags: [Uploads]
 *     responses:
 *       200:
 *         description: Upload limits retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 maxFileSize:
 *                   type: integer
 *                   description: Maximum file size in bytes
 *                 maxFileSizeHuman:
 *                   type: string
 *                   description: Human-readable maximum file size
 *                 allowedFileTypes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Allowed MIME types
 *                 allowedPurposes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Allowed upload purposes
 */
router.get('/limits', (req, res) => {
  const maxSize = parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024;
  const allowedTypes = (process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml,image/bmp,image/tiff')
    .split(',')
    .map(type => type.trim());

  res.json({
    maxFileSize: maxSize,
    maxFileSizeHuman: `${(maxSize / (1024 * 1024)).toFixed(1)}MB`,
    allowedFileTypes: allowedTypes,
    allowedPurposes: ['model', 'outfit', 'output', 'thumbnail', 'other']
  });
});

export default router;