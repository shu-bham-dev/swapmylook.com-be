import express from 'express';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import { generateRateLimiter, quotaCheck, usageTracker } from '../middleware/rateLimiter.js';
import ImageAsset from '../models/ImageAsset.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';
import axios from 'axios';

const router = express.Router();
const logger = createLogger('tools-routes');

// Gemini API configuration for text-to-image
const GEMINI_CONFIG = {
  baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash-image',
  timeout: 120000, // 2 minutes
  maxRetries: 3
};

/**
 * @route   POST /api/v1/tools/quilt-design
 * @desc    Generate quilt design using AI (text-to-image)
 * @access  Private
 */
router.post('/quilt-design', requireAuth(), generateRateLimiter, quotaCheck(), usageTracker('generation'), asyncHandler(async (req, res) => {
  const { prompt, options } = req.body;

  // Validate required fields
  if (!prompt) {
    throw new ValidationError('Prompt is required');
  }

  // Validate options structure
  const validatedOptions = {
    style: options?.style || 'modern',
    colorPalette: options?.colorPalette || ['#FF6B6B', '#4ECDC4', '#FFD166', '#06D6A0', '#118AB2'],
    complexity: options?.complexity || 3,
    size: options?.size || 'throw',
    rows: options?.rows || 8,
    columns: options?.columns || 8,
    symmetry: options?.symmetry || 'mirror'
  };

  // Validate complexity range
  if (validatedOptions.complexity < 1 || validatedOptions.complexity > 5) {
    throw new ValidationError('Complexity must be between 1 and 5');
  }

  // Validate rows and columns
  if (validatedOptions.rows < 4 || validatedOptions.rows > 16) {
    throw new ValidationError('Rows must be between 4 and 16');
  }
  if (validatedOptions.columns < 4 || validatedOptions.columns > 16) {
    throw new ValidationError('Columns must be between 4 and 16');
  }

  // Check if Gemini API key is configured
  if (!process.env.GEMINI_API_KEY) {
    throw new ValidationError('Gemini API key is not configured');
  }

  // Increment generation attempts counter
  await req.user.incrementGenerationAttempts();

  const startTime = Date.now();

  try {
    // Create enhanced prompt with quilt design specifics
    const enhancedPrompt = `Create a quilt design with the following specifications:
    Style: ${validatedOptions.style}
    Colors: ${validatedOptions.colorPalette.join(', ')}
    Complexity level: ${validatedOptions.complexity}/5
    Size: ${validatedOptions.size}
    Grid: ${validatedOptions.rows} rows x ${validatedOptions.columns} columns
    Symmetry: ${validatedOptions.symmetry}
    
    Design description: ${prompt}
    
    Generate a visually appealing quilt pattern with geometric shapes, proper symmetry, and the specified color palette.`;

    // Prepare Gemini API request payload for text-to-image
    const geminiPayload = {
      contents: [
        {
          parts: [
            { 
              text: enhancedPrompt
            }
          ]
        }
      ]
    };

    const apiUrl = `${GEMINI_CONFIG.baseURL}/models/${GEMINI_CONFIG.model}:generateContent`;
    
    logger.debug('Making Gemini API call for text-to-image', {
      userId: req.user.id,
      promptLength: prompt.length,
      options: validatedOptions
    });

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
      userId: req.user.id,
      status: response.status,
      hasCandidates: !!response.data.candidates,
      responseKeys: Object.keys(response.data)
    });

    const geminiResult = response.data;
    
    // Extract the generated image from Gemini response
    if (!geminiResult.candidates || !geminiResult.candidates[0]) {
      logger.error('No candidates found in response', {
        userId: req.user.id,
        fullResponse: JSON.stringify(geminiResult, null, 2)
      });
      throw new Error('Gemini API did not return any candidates');
    }

    const candidate = geminiResult.candidates[0];
    
    // Log candidate structure for debugging
    logger.debug('Candidate structure', {
      candidateKeys: Object.keys(candidate),
      hasContent: !!candidate.content,
      finishReason: candidate.finishReason,
      finishMessage: candidate.finishMessage
    });
    
    // Handle safety filter rejections
    if (candidate.finishReason === 'IMAGE_OTHER' || candidate.finishReason === 'SAFETY') {
      const errorMessage = candidate.finishMessage || 'Image generation blocked by content safety filters';
      logger.error('Gemini API safety filter triggered', {
        finishReason: candidate.finishReason,
        finishMessage: candidate.finishMessage
      });
      throw new Error(`Gemini API safety filter: ${errorMessage}`);
    }
    
    if (!candidate.content || !candidate.content.parts) {
      logger.error('Candidate has no content or parts', {
        candidate: JSON.stringify(candidate, null, 2)
      });
      throw new Error('Gemini API candidate has no content or parts');
    }

    // Log parts structure for debugging
    logger.debug('Candidate parts', {
      partsCount: candidate.content.parts.length,
      parts: candidate.content.parts.map((part, index) => ({
        index,
        hasText: !!part.text,
        hasInlineData: !!part.inlineData,
        textPreview: part.text ? part.text.substring(0, 100) + '...' : null,
        mimeType: part.inlineData?.mimeType
      }))
    });

    // Search through all parts to find the image data
    let generatedImageData = null;
    candidate.content.parts.forEach((part, index) => {
      if (part.inlineData) {
        generatedImageData = part.inlineData;
        logger.debug('Found inlineData in part', {
          partIndex: index,
          mimeType: part.inlineData.mimeType,
          dataLength: part.inlineData.data ? part.inlineData.data.length : 0
        });
      }
    });

    if (!generatedImageData) {
      logger.error('No inlineData found in any parts', {
        parts: candidate.content.parts.map((part, index) => ({
          index,
          type: part.text ? 'text' : part.inlineData ? 'inlineData' : 'unknown',
          textPreview: part.text ? part.text.substring(0, 200) + '...' : null
        }))
      });
      throw new Error('Gemini API did not return a valid image response - no inlineData found in parts');
    }
    
    // Convert base64 image to buffer
    const outputImageBuffer = Buffer.from(generatedImageData.data, 'base64');

    // Generate storage key for output
    const { generateStorageKey, uploadBuffer, generateDownloadUrl } = await import('../config/storage.js');
    const outputKey = generateStorageKey('quilt-designs', `quilt-design-${Date.now()}`, req.user.id);

    // Upload output to storage
    await uploadBuffer(outputImageBuffer, outputKey, generatedImageData.mimeType || 'image/png');

    // Generate download URL
    const downloadUrl = await generateDownloadUrl(outputKey, 86400); // 24 hours

    // Create output image asset
    const outputImage = new ImageAsset({
      userId: req.user.id,
      type: 'output',
      storageKey: outputKey,
      url: downloadUrl,
      width: 1024, // Default width for quilt designs
      height: 1024, // Default height for quilt designs
      mimeType: generatedImageData.mimeType || 'image/png',
      sizeBytes: outputImageBuffer.length,
      metadata: {
        filename: `quilt-design-${Date.now()}`,
        prompt: prompt,
        options: validatedOptions,
        processingTime: Date.now() - startTime,
        aiModel: 'gemini-2.5-flash-image',
        source: 'quilt-design-generation'
      }
    });

    await outputImage.save();

    const processingTime = Date.now() - startTime;

    // Log successful generation
    await Audit.logUsage({
      userId: req.user.id,
      type: 'generation',
      action: 'quilt_design_generation_succeeded',
      resourceType: 'image',
      resourceId: outputImage._id,
      details: {
        processingTime,
        outputSize: outputImageBuffer.length,
        aiModel: 'gemini-2.5-flash-image',
        promptLength: prompt.length
      }
    });

    logger.info('Quilt design generation completed successfully', {
      userId: req.user.id,
      processingTime,
      outputImageId: outputImage._id
    });

    // Send response matching frontend's GenerationJob interface
    res.json({
      jobId: outputImage._id.toString(), // Using image ID as job ID for compatibility
      status: 'succeeded',
      estimatedTime: processingTime / 1000
      // Note: queuePosition is optional and not needed for synchronous processing
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    logger.error('Quilt design generation failed', {
      userId: req.user.id,
      error: error.message,
      processingTime,
      prompt: prompt
    });

    // Log failure
    await Audit.logUsage({
      userId: req.user.id,
      type: 'generation',
      action: 'quilt_design_generation_failed',
      resourceType: 'image',
      details: {
        error: error.message,
        processingTime,
        promptLength: prompt.length
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
 * @route   GET /api/v1/tools/quilt-design/:imageId/status
 * @desc    Get quilt design image status (for compatibility with frontend)
 * @access  Private
 */
router.get('/quilt-design/:imageId/status', requireAuth(), asyncHandler(async (req, res) => {
  const { imageId } = req.params;

  const image = await ImageAsset.findOne({
    _id: imageId,
    userId: req.user.id,
    type: 'output'
  });

  if (!image) {
    throw new NotFoundError('Quilt design image');
  }

  const response = {
    jobId: image._id.toString(),
    status: 'succeeded', // Since we're doing synchronous generation, it's always succeeded if it exists
    userId: image.userId.toString(),
    createdAt: image.createdAt.toISOString(),
    updatedAt: image.updatedAt.toISOString(),
    estimatedTime: image.metadata?.processingTime ? image.metadata.processingTime / 1000 : 60,
    processingTime: image.metadata?.processingTime || 0
  };

  response.outputImage = {
    id: image._id,
    url: image.url,
    width: image.width,
    height: image.height,
    sizeBytes: image.sizeBytes,
    prompt: image.metadata?.prompt || '',
    metadata: {
      style: image.metadata?.options?.style || 'modern',
      colorPalette: image.metadata?.options?.colorPalette || ['#FF6B6B', '#4ECDC4', '#FFD166', '#06D6A0', '#118AB2'],
      complexity: image.metadata?.options?.complexity || 3,
      size: image.metadata?.options?.size || 'throw',
      rows: image.metadata?.options?.rows || 8,
      columns: image.metadata?.options?.columns || 8,
      symmetry: image.metadata?.options?.symmetry || 'mirror'
    }
  };

  res.json(response);
}));

/**
 * @route   POST /api/v1/tools/text-to-image/direct
 * @desc    Direct text-to-image generation using Google Gemini API
 * @access  Private
 */
router.post('/text-to-image/direct', requireAuth(), generateRateLimiter, quotaCheck(), usageTracker('generation'), asyncHandler(async (req, res) => {
  const { prompt } = req.body;

  // Validate required fields
  if (!prompt) {
    throw new ValidationError('Prompt is required');
  }

  // Check if Gemini API key is configured
  if (!process.env.GEMINI_API_KEY) {
    throw new ValidationError('Gemini API key is not configured');
  }

  // Increment generation attempts counter
  await req.user.incrementGenerationAttempts();

  try {
    // Prepare Gemini API request payload for text-to-image
    const geminiPayload = {
      contents: [
        {
          parts: [
            { 
              text: `Generate a quilt design image based on this description: ${prompt}. Create a visually appealing quilt pattern with geometric shapes and colors.`
            }
          ]
        }
      ]
    };

    // Call Gemini API for text-to-image generation
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
        !geminiResponse.candidates[0].content.parts) {
      throw new Error('Gemini API did not return a valid response');
    }

    // Find the image part in the response
    const imagePart = geminiResponse.candidates[0].content.parts.find(
      part => part.inlineData
    );

    if (!imagePart || !imagePart.inlineData) {
      throw new Error('Gemini API did not return an image');
    }

    const generatedImageData = imagePart.inlineData;
    
    // Convert base64 image to buffer
    const imageBuffer = Buffer.from(generatedImageData.data, 'base64');
    
    // Generate storage key for the output
    const { generateStorageKey, uploadBuffer, generateDownloadUrl } = await import('../config/storage.js');
    const outputKey = generateStorageKey('text-to-image-outputs', `gemini-text-to-image-${Date.now()}`, req.user.id);
    
    // Upload output to storage
    await uploadBuffer(imageBuffer, outputKey, generatedImageData.mimeType || 'image/png');
    
    // Generate download URL
    const downloadUrl = await generateDownloadUrl(outputKey, 86400); // 24 hours
    
    // Create output image asset
    const outputImage = new ImageAsset({
      userId: req.user.id,
      type: 'output',
      storageKey: outputKey,
      url: downloadUrl,
      mimeType: generatedImageData.mimeType || 'image/png',
      sizeBytes: imageBuffer.length,
      metadata: {
        filename: `gemini-text-to-image-${Date.now()}`,
        prompt: prompt,
        processingTime: 'direct',
        aiModel: 'gemini-2.5-flash-image',
        source: 'text-to-image-generation'
      }
    });

    await outputImage.save();

    // Log successful generation
    await Audit.logUsage({
      userId: req.user.id,
      type: 'generation',
      action: 'text_to_image_generation_succeeded',
      resourceType: 'image',
      resourceId: outputImage._id,
      details: {
        promptLength: prompt.length,
        outputSize: imageBuffer.length,
        aiModel: 'gemini-2.5-flash-image'
      }
    });

    logger.info('Text-to-image generation completed successfully', {
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
    logger.error('Text-to-image generation failed', {
      userId: req.user.id,
      error: error.message,
      prompt: prompt
    });

    // Log failure
    await Audit.logUsage({
      userId: req.user.id,
      type: 'generation',
      action: 'text_to_image_generation_failed',
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

export default router;