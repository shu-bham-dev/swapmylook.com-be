import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = 3003;

// Middleware to log all requests
app.use(express.json());
app.use((req, res, next) => {
  console.log('=== WEBHOOK RECEIVED ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('=======================');
  next();
});

// Simple webhook endpoint
app.post('/test-webhook', (req, res) => {
  console.log('Test webhook body:', JSON.stringify(req.body, null, 2));
  
  // Check if it's a Dodo webhook
  if (req.body.type) {
    console.log('Dodo event type:', req.body.type);
    console.log('Event data:', JSON.stringify(req.body.data, null, 2));
    
    // Check for subscription events
    if (req.body.type.includes('subscription')) {
      const subscription = req.body.data;
      console.log('Subscription ID:', subscription.id);
      console.log('Product ID:', subscription.product_id);
      console.log('Status:', subscription.status);
      console.log('Metadata:', subscription.metadata);
      console.log('Customer ID:', subscription.customer_id);
    }
  }
  
  res.status(200).send('OK');
});

// Health check
app.get('/', (req, res) => {
  res.send('Webhook test server running');
});

app.listen(PORT, () => {
  console.log(`Webhook test server listening on port ${PORT}`);
  console.log(`Test endpoint: http://localhost:${PORT}/test-webhook`);
});
