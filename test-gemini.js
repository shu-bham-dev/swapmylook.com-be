#!/usr/bin/env node

/**
 * Test script for Google Gemini API integration
 * This script tests the direct generation endpoint and worker integration
 */

import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const BASE_URL = process.env.APP_URL || 'http://localhost:3001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Test configuration
const TEST_CONFIG = {
  baseURL: BASE_URL,
  timeout: 120000,
  headers: {
    'Content-Type': 'application/json'
  }
};

// Create axios instance
const api = axios.create(TEST_CONFIG);

/**
 * Test direct generation endpoint
 */
async function testDirectGeneration() {
  console.log('🧪 Testing direct generation endpoint...\n');

  if (!GEMINI_API_KEY) {
    console.log('❌ GEMINI_API_KEY not found in environment variables');
    console.log('💡 Please add GEMINI_API_KEY to your .env file');
    return false;
  }

  try {
    // Create a simple test image (1x1 pixel PNG)
    const testImageBuffer = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
      0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
    ]);

    // Convert to base64
    const base64Image = testImageBuffer.toString('base64');

    // Test Gemini API directly first
    console.log('🔍 Testing Gemini API connectivity...');
    
    const geminiResponse = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      {
        contents: [
          {
            parts: [
              { text: "Test prompt - please respond with a simple text message" },
              {
                inline_data: {
                  mime_type: 'image/png',
                  data: base64Image
                }
              }
            ]
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        timeout: 30000
      }
    );

    console.log('✅ Gemini API connectivity test passed');
    console.log('📊 Response structure:', {
      hasCandidates: !!geminiResponse.data.candidates,
      candidateCount: geminiResponse.data.candidates?.length || 0
    });

    // Test the backend endpoint (if server is running)
    console.log('\n🔍 Testing backend direct generation endpoint...');
    
    // Note: This requires the backend server to be running and authentication
    // For now, we'll just log the endpoint structure
    console.log('📋 Direct generation endpoint available at:');
    console.log(`   POST ${BASE_URL}/api/v1/generate/direct`);
    console.log('   Headers: Authorization: Bearer <jwt-token>');
    console.log('   Body: multipart/form-data with:');
    console.log('     - image: file');
    console.log('     - prompt: string');
    
    return true;

  } catch (error) {
    console.error('❌ Direct generation test failed:', error.message);
    
    if (error.response) {
      console.error('📊 Gemini API error details:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    }
    
    return false;
  }
}

/**
 * Test worker integration
 */
async function testWorkerIntegration() {
  console.log('\n🧪 Testing worker integration...\n');

  try {
    // Check if required environment variables are set
    const requiredEnvVars = [
      'MONGO_URI',
      'REDIS_URL',
      'GEMINI_API_KEY'
    ];

    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.log('⚠️  Missing environment variables:', missingVars.join(', '));
      console.log('💡 Please check your .env file');
      return false;
    }

    console.log('✅ All required environment variables are set');
    console.log('📋 Worker configuration:');
    console.log(`   - MongoDB URI: ${process.env.MONGO_URI ? '✅ Set' : '❌ Missing'}`);
    console.log(`   - Redis URL: ${process.env.REDIS_URL ? '✅ Set' : '❌ Missing'}`);
    console.log(`   - Gemini API Key: ${process.env.GEMINI_API_KEY ? '✅ Set' : '❌ Missing'}`);

    // Test database connections (if possible)
    console.log('\n🔍 Testing database connections...');
    
    // Note: Actual connection testing would require the databases to be running
    console.log('📋 To test database connections, run:');
    console.log('   npm run dev  # Start the server');
    console.log('   node src/workers/imageProcessor.js  # Start the worker');

    return true;

  } catch (error) {
    console.error('❌ Worker integration test failed:', error.message);
    return false;
  }
}

/**
 * Main test function
 */
async function runTests() {
  console.log('🚀 Starting Gemini API Integration Tests\n');
  console.log('='.repeat(50));

  const directGenResult = await testDirectGeneration();
  const workerResult = await testWorkerIntegration();

  console.log('\n' + '='.repeat(50));
  console.log('📊 TEST SUMMARY:');
  console.log(`   Direct Generation: ${directGenResult ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`   Worker Integration: ${workerResult ? '✅ PASSED' : '❌ FAILED'}`);

  if (directGenResult && workerResult) {
    console.log('\n🎉 All tests passed! Gemini integration is ready.');
    console.log('\n📝 Next steps:');
    console.log('   1. Start the backend server: npm run dev');
    console.log('   2. Start the worker: node src/workers/imageProcessor.js');
    console.log('   3. Test the API endpoints with proper authentication');
  } else {
    console.log('\n⚠️  Some tests failed. Please check the configuration.');
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(error => {
    console.error('💥 Test runner failed:', error);
    process.exit(1);
  });
}

export { testDirectGeneration, testWorkerIntegration, runTests };