# Google Gemini API Integration

This document describes the integration of Google Gemini API into the SwapMyLook backend, replacing the legacy nanobanana API.

## Overview

The integration provides two main approaches for image generation:

1. **Direct Generation** - Single API call with immediate response
2. **Worker-based Generation** - Queue-based processing for complex outfit generation

## Configuration

### Environment Variables

Add the following to your `.env` file:

```env
# Google Gemini API
GEMINI_API_KEY=your-gemini-api-key-here

# Legacy nanobanana (optional - for backward compatibility)
NANOBANANA_API_KEY=your-nanobanana-api-key
NANOBANANA_BASE_URL=https://api.nanobananaapi.ai
NANOBANANA_CALLBACK_URL=http://localhost:3001/api/v1/generate/webhook
WEBHOOK_SECRET=your-webhook-secret-here
```

### Getting a Gemini API Key

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create a new API key
3. Copy the key to your `.env` file as `GEMINI_API_KEY`

## API Endpoints

### Direct Generation

**Endpoint:** `POST /api/v1/generate/direct`

**Description:** Direct image generation using Gemini API with immediate response.

**Authentication:** Required (JWT token)

**Request:**
```http
POST /api/v1/generate/direct
Content-Type: multipart/form-data
Authorization: Bearer <jwt-token>

Body:
- image: <file> (required) - Input image file (JPEG, PNG, WebP)
- prompt: <string> (required) - Text prompt for generation
```

**Example Request:**
```bash
curl -X POST \
  http://localhost:3001/api/v1/generate/direct \
  -H 'Authorization: Bearer <jwt-token>' \
  -F 'image=@input.jpg' \
  -F 'prompt=Turn this into a watercolor painting'
```

**Response:**
```json
{
  "success": true,
  "outputImage": {
    "id": "67a1b2c3d4e5f6a7b8c9d0e1",
    "url": "https://storage.example.com/direct-outputs/...",
    "sizeBytes": 102400,
    "mimeType": "image/png"
  },
  "prompt": "Turn this into a watercolor painting"
}
```

### Worker-based Generation

**Endpoint:** `POST /api/v1/generate`

**Description:** Queue-based generation for complex outfit transformations.

**Authentication:** Required (JWT token)

**Request:**
```http
POST /api/v1/generate
Content-Type: application/json
Authorization: Bearer <jwt-token>

Body:
{
  "modelImageId": "67a1b2c3d4e5f6a7b8c9d0e1",
  "outfitImageId": "67a1b2c3d4e5f6a7b8c9d0e2",
  "prompt": "Generate outfit on model",
  "options": {
    "strength": 0.9,
    "preserveFace": true,
    "background": "transparent"
  }
}
```

**Response:**
```json
{
  "jobId": "67a1b2c3d4e5f6a7b8c9d0e3",
  "status": "queued",
  "estimatedTime": 45,
  "queuePosition": 2
}
```

## How It Works

### Direct Generation Flow

1. **Request Validation**
   - Check authentication
   - Validate file type and size
   - Verify Gemini API key

2. **Image Processing**
   - Convert uploaded image to base64
   - Prepare Gemini API payload

3. **Gemini API Call**
   ```javascript
   const payload = {
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
   ```

4. **Response Processing**
   - Extract generated image from Gemini response
   - Convert base64 to buffer
   - Upload to storage
   - Create image asset record

### Worker-based Generation Flow

1. **Job Creation**
   - Validate input images
   - Create job record in database
   - Add job to Redis queue

2. **Worker Processing**
   - Download input images
   - Call Gemini API with both model and outfit images
   - Process response and save output

3. **Gemini API Payload (Worker)**
   ```javascript
   const payload = {
     contents: [
       {
         parts: [
           { 
             text: "Generate a realistic outfit on the model person..."
           },
           {
             inline_data: {
               mime_type: 'image/png',
               data: modelImageBase64
             }
           },
           {
             inline_data: {
               mime_type: 'image/png',
               data: outfitImageBase64
             }
           }
         ]
       }
     ]
   };
   ```

## Error Handling

### Common Errors

1. **Missing API Key**
   ```json
   {
     "error": "Gemini API key is not configured"
   }
   ```

2. **Invalid File Type**
   ```json
   {
     "error": "File type image/gif is not supported. Please use JPEG, PNG, or WebP."
   }
   ```

3. **Gemini API Errors**
   ```json
   {
     "error": "Gemini API error: 400 - Invalid argument: prompt"
   }
   ```

4. **Network Errors**
   ```json
   {
     "error": "Gemini API network error: No response received"
   }
   ```

## Testing

### Run Integration Tests

```bash
# Test Gemini API connectivity and configuration
node test-gemini.js
```

### Manual Testing

1. **Start the services:**
   ```bash
   # Terminal 1 - Backend server
   npm run dev

   # Terminal 2 - Worker
   node src/workers/imageProcessor.js
   ```

2. **Test direct generation:**
   ```bash
   curl -X POST \
     http://localhost:3001/api/v1/generate/direct \
     -H 'Authorization: Bearer <jwt-token>' \
     -F 'image=@test-image.jpg' \
     -F 'prompt=Make this image more vibrant'
   ```

3. **Test worker generation:**
   ```bash
   curl -X POST \
     http://localhost:3001/api/v1/generate \
     -H 'Authorization: Bearer <jwt-token>' \
     -H 'Content-Type: application/json' \
     -d '{
       "modelImageId": "67a1b2c3d4e5f6a7b8c9d0e1",
       "outfitImageId": "67a1b2c3d4e5f6a7b8c9d0e2",
       "prompt": "Generate outfit on model"
     }'
   ```

## Performance Considerations

1. **Timeout Settings**
   - Direct generation: 2 minutes
   - Worker generation: 2 minutes
   - Adjust based on your requirements

2. **Image Size Limits**
   - Maximum file size: 10MB (configurable via `MAX_FILE_SIZE`)
   - Supported formats: JPEG, PNG, WebP

3. **Rate Limiting**
   - Uses existing rate limiting middleware
   - Configure via `RATE_LIMIT_PER_HOUR`

## Migration from nanobanana

### Changes Made

1. **New Endpoint:** `/api/v1/generate/direct` for immediate generation
2. **Updated Worker:** Uses Gemini API instead of nanobanana
3. **Legacy Support:** Webhook endpoint maintained for existing nanobanana jobs
4. **Environment Variables:** Added `GEMINI_API_KEY`

### Benefits

1. **Faster Response Times** - Direct generation provides immediate results
2. **Better Error Handling** - More detailed error messages
3. **Simplified Architecture** - No webhook dependencies for new generations
4. **Google Ecosystem** - Integration with Google's AI infrastructure

## Troubleshooting

### Common Issues

1. **"Gemini API key not configured"**
   - Check `.env` file for `GEMINI_API_KEY`
   - Restart the server after adding the key

2. **"Invalid file type"**
   - Ensure uploaded files are JPEG, PNG, or WebP
   - Check file extension matches actual format

3. **"Gemini API network error"**
   - Check internet connectivity
   - Verify Gemini API endpoint is accessible
   - Check firewall settings

4. **Slow response times**
   - Monitor Gemini API quotas and limits
   - Check image sizes (smaller images process faster)
   - Review network latency

### Debug Mode

Enable debug logging by setting:
```env
LOG_LEVEL=debug
```

This will show detailed API request/response information in the logs.

## Support

For issues with the Gemini integration:

1. Check the [Google AI Studio documentation](https://ai.google.dev/docs)
2. Review the [Gemini API reference](https://ai.google.dev/api/generate-content)
3. Check server logs for detailed error information
4. Test with the provided `test-gemini.js` script