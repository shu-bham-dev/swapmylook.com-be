import crypto from 'crypto';
import fetch from 'node-fetch';

const WEBHOOK_SECRET = 'whsec_nQ6ZbeSIvDxo1F35Mmv6UvGKPkWIs9v7';
const WEBHOOK_URL = 'http://localhost:3001/api/v1/webhooks/dodo';

// Generate signature as per Dodo's spec: HMAC SHA256 of timestamp + '.' + payload
function generateSignature(payload, timestamp, secret) {
  const signedPayload = `${timestamp}.${payload}`;
  return crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
}

async function sendTestWebhook() {
  const event = {
    id: 'evt_test_' + Date.now(),
    type: 'subscription.created',
    data: {
      id: 'sub_test123',
      customer_id: 'cus_test456',
      product_id: 'pdt_tK4MN15ItH8WH5csCY96b', // basic monthly
      status: 'active',
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days from now
      metadata: {
        app_user_id: '67890abcde12345', // test user ID
        plan: 'basic'
      }
    }
  };

  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(payload, timestamp, WEBHOOK_SECRET);
  const signatureHeader = `t=${timestamp},v1=${signature}`;

  console.log('Sending webhook to:', WEBHOOK_URL);
  console.log('Payload:', payload);
  console.log('Timestamp:', timestamp);
  console.log('Signature header:', signatureHeader);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-signature': signatureHeader,
      },
      body: payload,
    });

    const text = await response.text();
    console.log(`Response status: ${response.status}`);
    console.log(`Response body: ${text}`);
  } catch (error) {
    console.error('Error sending webhook:', error.message);
  }
}

sendTestWebhook();