import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const WEBHOOK_URL = 'http://localhost:3001/api/v1/webhooks/dodo'; // Adjust port if needed
const WEBHOOK_SECRET = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;

// Test webhook payload for subscription.active
const testPayload = {
  id: 'evt_test_123',
  type: 'subscription.active',
  timestamp: Math.floor(Date.now() / 1000),
  business_id: 'test_business',
  data: {
    id: 'sub_rWLjtcbslIUCMcIcymyHB', // Use the actual subscription ID from your test
    customer_id: 'cus_test_123',
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days from now
    product_id: process.env.DODO_PRODUCT_BASIC,
    metadata: {
      app_user_id: '507f1f77bcf86cd799439011' // Replace with actual user ID
    }
  }
};

async function testWebhook() {
  try {
    const payloadString = JSON.stringify(testPayload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${payloadString}`;
    
    const signature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(signedPayload)
      .digest('hex');
    
    const headers = {
      'Content-Type': 'application/json',
      'webhook-signature': `t=${timestamp},v1=${signature}`
    };

    console.log('Sending test webhook...');
    console.log('URL:', WEBHOOK_URL);
    console.log('Payload:', JSON.stringify(testPayload, null, 2));
    console.log('Headers:', headers);

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: payloadString
    });

    console.log('Response status:', response.status);
    const responseText = await response.text();
    console.log('Response body:', responseText);

  } catch (error) {
    console.error('Error testing webhook:', error.message);
  }
}

testWebhook();
