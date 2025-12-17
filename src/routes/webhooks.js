import express from 'express';
import DodoPayments from 'dodopayments';

const router = express.Router();

/* ---------------------------------------------------- */
/* RAW BODY ONLY — NO JSON PARSER HERE                   */
/* ---------------------------------------------------- */
router.post(
  '/dodo',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    console.log('\n================ DODO WEBHOOK RECEIVED ================');
    console.log('Headers:', req.headers);
    console.log('Raw payload length:', req.body.length);

    const client = new DodoPayments({
      bearerToken: process.env.DODO_PAYMENTS_API_KEY,
      environment: "live", // "test" | "live"
      webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,   // whsec_...
    });

    let event;

    try {
      /* ------------------------------------------------ */
      /* OFFICIAL VERIFICATION (Svix-safe)                */
      /* ------------------------------------------------ */
      event = client.webhooks.unwrap(req.body.toString(), {
        headers: {
          'webhook-id': req.headers['webhook-id'],
          'webhook-signature': req.headers['webhook-signature'],
          'webhook-timestamp': req.headers['webhook-timestamp'],
        },
      });

      console.log('✅ Webhook signature verified');
      console.log('Event type:', event.type);

      /* ACK IMMEDIATELY */
      res.status(200).json({ received: true });

    } catch (error) {
      console.error('❌ Webhook verification failed:', error.message);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    /* ------------------------------------------------ */
    /* PROCESS ASYNC (AFTER ACK)                        */
    /* ------------------------------------------------ */
    processWebhookAsync(event).catch(err => {
      console.error('❌ Async webhook processing error:', err.message);
    });
  }
);

export default router;
