import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v2 as cloudinary } from 'cloudinary';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('storage');

// Storage client configuration
let s3Client = null;
let storageConfig = {};
let currentProvider = null;

/**
 * Initialize storage client based on provider
 */
export function initStorage() {
  const provider = process.env.STORAGE_PROVIDER || 'cloudinary';
  currentProvider = provider;
  
  switch (provider) {
    case 'cloudinary':
      // Configure Cloudinary
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dexw1oojh',
        api_key: process.env.CLOUDINARY_API_KEY || '864666324575381',
        api_secret: process.env.CLOUDINARY_API_SECRET || 'FxTZxiOsM325uAbSOC920Ik9ngY',
        secure: true
      });
      logger.info('Cloudinary storage initialized');
      break;
    
    case 'b2':
    case 'backblaze':
      storageConfig = {
        endpoint: process.env.B2_ENDPOINT || `https://s3.${process.env.B2_REGION || 'us-west-002'}.backblazeb2.com`,
        region: process.env.B2_REGION || 'us-west-002',
        credentials: {
          accessKeyId: process.env.B2_KEY_ID,
          secretAccessKey: process.env.B2_APP_KEY
        },
        forcePathStyle: true
      };
      
      s3Client = new S3Client({
        ...storageConfig,
        maxAttempts: 3,
        requestTimeout: 30000,
        connectionTimeout: 10000
      });
      break;
    
    case 'spaces':
    case 'digitalocean':
      storageConfig = {
        endpoint: process.env.SPACES_ENDPOINT || 'https://nyc3.digitaloceanspaces.com',
        region: process.env.SPACES_REGION || 'nyc3',
        credentials: {
          accessKeyId: process.env.SPACES_KEY,
          secretAccessKey: process.env.SPACES_SECRET
        },
        forcePathStyle: false
      };
      
      s3Client = new S3Client({
        ...storageConfig,
        maxAttempts: 3,
        requestTimeout: 30000,
        connectionTimeout: 10000
      });
      break;
    
    case 's3':
    case 'aws':
      storageConfig = {
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        },
        forcePathStyle: false
      };
      
      s3Client = new S3Client({
        ...storageConfig,
        maxAttempts: 3,
        requestTimeout: 30000,
        connectionTimeout: 10000
      });
      break;
    
    default:
      throw new Error(`Unsupported storage provider: ${provider}`);
  }

  logger.info(`Storage initialized with provider: ${provider}`, {
    bucket: process.env.B2_BUCKET || process.env.S3_BUCKET,
    region: storageConfig.region
  });
}

/**
 * Get storage bucket name
 * @returns {string}
 */
function getBucket() {
  return process.env.B2_BUCKET || process.env.S3_BUCKET || process.env.STORAGE_BUCKET;
}

/**
 * Generate storage key for file
 * @param {string} prefix - Folder prefix (e.g., 'uploads', 'outputs')
 * @param {string} filename - Original filename
 * @param {string} userId - User ID
 * @returns {string} - Storage key
 */
export function generateStorageKey(prefix, filename, userId) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  
  // Extract just the filename without path
  const cleanFilename = filename.split('/').pop();
  
  // Remove extension from filename for Cloudinary (it will add automatically)
  const hasExtension = cleanFilename.includes('.');
  let baseName;
  
  if (hasExtension) {
    const lastDotIndex = cleanFilename.lastIndexOf('.');
    baseName = cleanFilename.substring(0, lastDotIndex);
  } else {
    baseName = cleanFilename;
  }
  
  // Generate unique filename with timestamp and random string
  // Don't include extension - Cloudinary will add it automatically
  const finalFilename = `${timestamp}-${random}-${baseName}`;
  
  return `${prefix}/${userId}/${finalFilename}`;
}

/**
 * Generate signed URL for upload
 * @param {string} key - Storage key
 * @param {string} contentType - File content type
 * @param {number} expiresIn - URL expiration in seconds (default: 300)
 * @returns {Promise<{uploadUrl: string, key: string, expiresAt: Date}>}
 */
export async function generateUploadUrl(key, contentType, expiresIn = 300) {
  if (currentProvider === 'cloudinary') {
    // Cloudinary doesn't support pre-signed upload URLs in the same way as S3
    // For Cloudinary, we'll return a direct upload endpoint
    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudinary.config().cloud_name}/auto/upload`;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    logger.debug('Generated Cloudinary upload URL', {
      key,
      contentType,
      expiresIn
    });

    return {
      uploadUrl,
      key,
      expiresAt
    };
  }
  
  if (!s3Client) initStorage();
  
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType,
    // Additional metadata if needed
    Metadata: {
      uploadedAt: new Date().toISOString()
    }
  });

  try {
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    logger.debug('Generated upload URL', {
      key,
      contentType,
      expiresIn
    });

    return {
      uploadUrl,
      key,
      expiresAt
    };
  } catch (error) {
    logger.error('Failed to generate upload URL', {
      error: error.message,
      key,
      contentType
    });
    throw new Error('Failed to generate upload URL');
  }
}

/**
 * Generate signed URL for download
 * @param {string} key - Storage key
 * @param {number} expiresIn - URL expiration in seconds (default: 3600)
 * @returns {Promise<string>} - Signed download URL
 */
export async function generateDownloadUrl(key, expiresIn = 3600) {
  if (currentProvider === 'cloudinary') {
    // For Cloudinary, generate a secure URL
    try {
      const downloadUrl = cloudinary.url(key, {
        secure: true,
        type: 'upload'
      });
      
      logger.debug('Generated Cloudinary download URL', {
        key,
        expiresIn
      });

      return downloadUrl;
    } catch (error) {
      logger.error('Failed to generate Cloudinary download URL', {
        error: error.message,
        key
      });
      throw new Error('Failed to generate download URL');
    }
  }
  
  if (!s3Client) initStorage();
  
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key
  });

  try {
    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn });
    
    logger.debug('Generated download URL', {
      key,
      expiresIn
    });

    return downloadUrl;
  } catch (error) {
    logger.error('Failed to generate download URL', {
      error: error.message,
      key
    });
    throw new Error('Failed to generate download URL');
  }
}

/**
 * Delete object from storage
 * @param {string} key - Storage key
 * @returns {Promise<boolean>} - Success status
 */
export async function deleteObject(key) {
  if (!s3Client) initStorage();
  
  const command = new DeleteObjectCommand({
    Bucket: getBucket(),
    Key: key
  });

  try {
    await s3Client.send(command);
    logger.info('Object deleted from storage', { key });
    return true;
  } catch (error) {
    logger.error('Failed to delete object from storage', {
      error: error.message,
      key
    });
    return false;
  }
}

/**
 * Check if object exists in storage
 * @param {string} key - Storage key
 * @returns {Promise<boolean>} - Existence status
 */
export async function objectExists(key) {
  if (!s3Client) initStorage();
  
  const command = new HeadObjectCommand({
    Bucket: getBucket(),
    Key: key
  });

  try {
    await s3Client.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NotFound') {
      return false;
    }
    logger.error('Error checking object existence', {
      error: error.message,
      key
    });
    throw error;
  }
}

/**
 * Get object metadata
 * @param {string} key - Storage key
 * @returns {Promise<Object>} - Object metadata
 */
export async function getObjectMetadata(key) {
  if (!s3Client) initStorage();
  
  const command = new HeadObjectCommand({
    Bucket: getBucket(),
    Key: key
  });

  try {
    const response = await s3Client.send(command);
    return {
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      lastModified: response.LastModified,
      etag: response.ETag,
      metadata: response.Metadata
    };
  } catch (error) {
    logger.error('Failed to get object metadata', {
      error: error.message,
      key
    });
    throw new Error('Failed to get object metadata');
  }
}

/**
 * Upload buffer directly to storage (for smaller files)
 * @param {Buffer} buffer - File buffer
 * @param {string} key - Storage key
 * @param {string} contentType - File content type
 * @returns {Promise<boolean>} - Success status
 */
export async function uploadBuffer(buffer, key, contentType) {
  if (currentProvider === 'cloudinary') {
    try {
      // Convert buffer to base64 for Cloudinary upload
      const base64Data = buffer.toString('base64');
      const dataUri = `data:${contentType};base64,${base64Data}`;
      
      // Extract format from content type
      const format = contentType.split('/')[1] || 'jpg';
      
      const result = await cloudinary.uploader.upload(dataUri, {
        public_id: key,
        resource_type: 'image',
        format: format,
        overwrite: true,
        timeout: 30000 // 30 second timeout
      });
      
      logger.info('Buffer uploaded to Cloudinary', {
        key,
        size: buffer.length,
        contentType,
        public_id: result.public_id
      });
      return true;
    } catch (error) {
      logger.error('Failed to upload buffer to Cloudinary', {
        error: error.message,
        key,
        size: buffer.length,
        contentType
      });
      throw new Error(`Failed to upload buffer to Cloudinary: ${error.message}`);
    }
  }
  
  if (!s3Client) initStorage();
  
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: buffer,
    ContentType: contentType,
    Metadata: {
      uploadedAt: new Date().toISOString(),
      uploadedBy: 'direct-upload'
    }
  });

  try {
    await s3Client.send(command);
    logger.info('Buffer uploaded to storage', {
      key,
      size: buffer.length,
      contentType
    });
    return true;
  } catch (error) {
    logger.error('Failed to upload buffer to storage', {
      error: error.message,
      key,
      size: buffer.length
    });
    throw new Error('Failed to upload buffer to storage');
  }
}

/**
 * Get storage usage statistics (if supported by provider)
 * @returns {Promise<Object>} - Storage statistics
 */
export async function getStorageStats() {
  // This would require provider-specific API calls
  // For simplicity, we'll return basic info
  return {
    provider: process.env.STORAGE_PROVIDER || 'b2',
    bucket: getBucket(),
    region: storageConfig.region,
    endpoint: storageConfig.endpoint
  };
}

// Initialize storage on import
if (process.env.NODE_ENV !== 'test') {
  try {
    initStorage();
    logger.info('Storage configuration loaded');
  } catch (error) {
    logger.warn('Storage initialization failed (may be expected in some environments)', {
      error: error.message
    });
  }
}

export default {
  initStorage,
  generateStorageKey,
  generateUploadUrl,
  generateDownloadUrl,
  deleteObject,
  objectExists,
  getObjectMetadata,
  uploadBuffer,
  getStorageStats
};