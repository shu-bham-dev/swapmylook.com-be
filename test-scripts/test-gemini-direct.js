#!/usr/bin/env node

/**
 * Direct Gemini API test script
 * Tests the API with actual images and shows full request/response
 */

import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY not found in environment variables');
  console.log('💡 Please add GEMINI_API_KEY to your .env file');
  process.exit(1);
}

/**
 * Test Gemini API directly with test images
 */
async function testGeminiDirect() {
  console.log('🚀 Testing Gemini API directly with test images...\n');

  try {
    // Read test images
    const modelImagePath = './test-images/female-model.jpg';
    const outfitImagePath = './test-images/female-outfit.jpg';
    
    if (!fs.existsSync(modelImagePath) || !fs.existsSync(outfitImagePath)) {
      console.error('❌ Test images not found in test-images/ folder');
      process.exit(1);
    }

    const modelImageBuffer = fs.readFileSync(modelImagePath);
    const outfitImageBuffer = fs.readFileSync(outfitImagePath);

    // Convert to base64
    const modelImageBase64 = modelImageBuffer.toString('base64');
    const outfitImageBase64 = outfitImageBuffer.toString('base64');

    console.log('📊 Image details:');
    console.log(`   Model image: ${modelImageBuffer.length} bytes`);
    console.log(`   Outfit image: ${outfitImageBuffer.length} bytes\n`);

    // Prepare Gemini API request payload
    const geminiPayload = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: modelImageBase64
              }
            },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: outfitImageBase64
              }
            },
            {
              text: "Create a professional e-commerce fashion photo. Take the outfit from the first image and let the model from the second image wear it. Generate a realistic, full-body shot of the model wearing the outfit, with the lighting and shadows adjusted to match the environment."
            }
          ]
        }
      ]
    };

    const apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent';

    console.log('🔍 Sending request to Gemini API...');
    console.log('📤 Request URL:', apiUrl);
    console.log('📤 Request headers:', {
      'Content-Type': 'application/json',
      'x-goog-api-key': `${GEMINI_API_KEY.substring(0, 10)}...`
    });

    // Log payload structure (without full base64)
    console.log('📤 Request payload structure:');
    console.log(JSON.stringify({
      contents: [
        {
          parts: geminiPayload.contents[0].parts.map(part => {
            if (part.inlineData) {
              return {
                ...part,
                inlineData: {
                  ...part.inlineData,
                  data: `${part.inlineData.data.substring(0, 50)}...`
                }
              };
            }
            return part;
          })
        }
      ]
    }, null, 2));

    // Make API call
    const response = await axios.post(apiUrl, geminiPayload, {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      timeout: 120000 // 2 minutes
    });

    console.log('\n✅ Gemini API call successful!');
    console.log('📥 Response status:', response.status);
    console.log('📥 Response headers:', response.headers);

    // Analyze response structure
    const responseData = response.data;
    console.log('\n🔍 Analyzing response structure...');

    // Check if we have candidates
    if (!responseData.candidates || !responseData.candidates.length) {
      console.log('❌ No candidates in response');
      console.log('📋 Full response:', JSON.stringify(responseData, null, 2));
      return;
    }

    const candidate = responseData.candidates[0];
    console.log('   Has candidate:', !!candidate);
    console.log('   Finish reason:', candidate.finishReason);
    console.log('   Index:', candidate.index);

    // Check content
    if (!candidate.content) {
      console.log('❌ No content in candidate');
      console.log('📋 Candidate:', JSON.stringify(candidate, null, 2));
      return;
    }

    console.log('   Has content:', !!candidate.content);
    console.log('   Role:', candidate.content.role);

    // Check parts
    if (!candidate.content.parts || !candidate.content.parts.length) {
      console.log('❌ No parts in content');
      console.log('📋 Content:', JSON.stringify(candidate.content, null, 2));
      return;
    }

    console.log('   Parts count:', candidate.content.parts.length);

    // Analyze each part
    candidate.content.parts.forEach((part, index) => {
      console.log(`\n   Part ${index}:`);
      console.log('     Keys:', Object.keys(part));
      
      if (part.text) {
        console.log('     Type: TEXT');
        console.log('     Text:', part.text.substring(0, 200) + '...');
      } else if (part.inlineData) {
        console.log('     Type: INLINE_DATA');
        console.log('     MimeType:', part.inlineData.mimeType);
        console.log('     Data length:', part.inlineData.data.length);
        console.log('     Data preview:', part.inlineData.data.substring(0, 50) + '...');
        
        // Try to save the image
        try {
          const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
          const outputPath = `./test-output-${Date.now()}.png`;
          fs.writeFileSync(outputPath, imageBuffer);
          console.log(`     ✅ Image saved to: ${outputPath}`);
        } catch (error) {
          console.log('     ❌ Failed to save image:', error.message);
        }
      } else {
        console.log('     Type: UNKNOWN');
        console.log('     Full part:', JSON.stringify(part, null, 2));
      }
    });

    // Check usage metadata
    if (responseData.usageMetadata) {
      console.log('\n📊 Usage metadata:');
      console.log('   Total tokens:', responseData.usageMetadata.totalTokenCount);
      console.log('   Prompt tokens:', responseData.usageMetadata.promptTokenCount);
      console.log('   Candidate tokens:', responseData.usageMetadata.candidatesTokenCount);
    }

    // Check model version
    console.log('   Model version:', responseData.modelVersion);
    console.log('   Response ID:', responseData.responseId);

  } catch (error) {
    console.error('❌ Gemini API test failed:', error.message);
    
    if (error.response) {
      console.error('📊 API error details:');
      console.error('   Status:', error.response.status);
      console.error('   Status text:', error.response.statusText);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('📊 Network error - no response received');
    } else {
      console.error('📊 Other error:', error.message);
    }
  }
}

// Run the test
testGeminiDirect().catch(error => {
  console.error('💥 Test runner failed:', error);
  process.exit(1);
});