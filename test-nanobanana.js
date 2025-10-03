import axios from 'axios';
import https from 'https';

const API_KEY = 'ef0d5c82f3db6a1f3c6b7f20143e026f';
const BASE_URL = 'https://api.nanobananaapi.ai/api/v1';

async function testNanobananaAPI() {
  console.log('Testing nanobanana API connectivity...');
  
  // Skip basic connectivity test since the API might not have a root endpoint
  console.log('1. Skipping basic connectivity test (API might not have root endpoint)');

  try {
    // Test the actual generate endpoint
    console.log('2. Testing generate endpoint...');
    const testPayload = {
      numImages: 1,
      prompt: "Test prompt",
      type: "IMAGETOIAMGE", // Corrected type value
      callBackUrl: "http://localhost:3001/api/v1/generate/webhook",
      imageUrls: ["https://example.com/image1.jpg", "https://example.com/image2.jpg"]
    };

    const response = await axios.post(
      `${BASE_URL}/nanobanana/generate`,
      testPayload,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      }
    );
    
    console.log('✅ Generate endpoint OK');
    console.log('Response status:', response.status);
    console.log('Response headers:', response.headers);
    console.log('Response data:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    if (error.response) {
      console.log('❌ Generate endpoint failed with status:', error.response.status);
      console.log('Response headers:', error.response.headers);
      console.log('Response data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.log('❌ Generate endpoint failed - no response received');
      console.log('Error details:', error.message);
    } else {
      console.log('❌ Generate endpoint failed:', error.message);
    }
  }
}

testNanobananaAPI();