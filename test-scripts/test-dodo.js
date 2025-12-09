import DodoPayments from 'dodopayments';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.DODO_PAYMENTS_API_KEY;
if (!apiKey) {
  console.error('DODO_PAYMENTS_API_KEY missing');
  process.exit(1);
}

const client = new DodoPayments({ bearerToken: apiKey });

async function test() {
  try {
    // Try to create a checkout session with a dummy product
    const productId = process.env.DODO_PRODUCT_BASIC;
    console.log('Using product ID:', productId);
    const session = await client.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      return_url: 'http://localhost:3001/billing/return',
      metadata: { test: true }
    });
    console.log('Success! Session:', session);
    console.log('URL:', session.url);
  } catch (error) {
    console.error('Dodo API error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

test();