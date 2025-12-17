import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import ProcessedWebhook from '../models/ProcessedWebhook.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('dodo-webhooks');

/* ------------------------------------------------------------------ */
/* SIGNATURE VERIFICATION                                              */
/* ------------------------------------------------------------------ */

function verifyDodoSignature(rawPayload, headers, secret) {
  const webhookId = headers['webhook-id'];
  const webhookSignature = headers['webhook-signature'];
  const webhookTimestamp = headers['webhook-timestamp'];

  console.log('🔐 Verifying Dodo webhook signature...');
  console.log('Headers:', {
    webhookId,
    webhookTimestamp,
    hasSignature: !!webhookSignature,
    hasSecret: !!secret,
  });

  if (!webhookId || !webhookSignature || !webhookTimestamp || !secret) {
    console.log('❌ Missing required webhook headers or secret');
    return false;
  }

  // ⏱ Timestamp tolerance (5 min)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(webhookTimestamp)) > 5 * 60) {
    console.log('❌ Webhook timestamp outside tolerance');
    return false;
  }

  try {
    const signedPayload = `${webhookId}.${webhookTimestamp}.${rawPayload}`;

    console.log('Signed payload preview:', signedPayload.slice(0, 100));
    console.log('Payload length:', rawPayload.length);

    // ✅ IMPORTANT: STANDARD BASE64 (Svix requirement)
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('base64');

    console.log('Expected signature:', expectedSignature);

    const signatures = webhookSignature.split(' ');

    for (const sig of signatures) {
      const [version, signature] = sig.split(',');
      if (version !== 'v1' || !signature) continue;

      console.log('Comparing signatures:', {
        expected: expectedSignature,
        received: signature,
      });

      const expectedBuf = Buffer.from(expectedSignature);
      const receivedBuf = Buffer.from(signature);

      if (
        expectedBuf.length === receivedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, receivedBuf)
      ) {
        console.log('✅ Signature match found');
        return true;
      }
    }

    console.log('❌ No matching signature found');
    return false;
  } catch (error) {
    console.log('❌ Signature verification error:', error.message);
    return false;
  }
}


/* ------------------------------------------------------------------ */
/* WEBHOOK ENDPOINT                                                    */
/* ------------------------------------------------------------------ */

router.post(
  '/dodo',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    console.log('\n================ DODO WEBHOOK RECEIVED ================');

    console.log('Incoming headers:', JSON.stringify(req.headers, null, 2));

    const rawPayload = req.body.toString();
    console.log('Raw payload length:', rawPayload.length);

    const headers = {
      'webhook-id': req.headers['webhook-id'],
      'webhook-signature': req.headers['webhook-signature'],
      'webhook-timestamp': req.headers['webhook-timestamp'],
    };

    const secret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;

    /* Verify signature */
    const isValid = verifyDodoSignature(rawPayload, headers, secret);
    if (!isValid) {
      console.log('❌ Webhook signature verification FAILED');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('✅ Webhook signature verified');

    /* Parse payload */
    let event;
    try {
      event = JSON.parse(rawPayload);
      console.log('Parsed webhook event:', event.type);
    } catch (err) {
      console.log('❌ JSON parse error:', err.message);
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    /* Idempotency */
    const webhookId = headers['webhook-id'];
    const exists = await ProcessedWebhook.findOne({ webhookId });

    if (exists) {
      console.log('🔁 Duplicate webhook received, skipping processing:', webhookId);
      return res.status(200).json({ received: true });
    }

    await ProcessedWebhook.create({ webhookId });
    console.log('🧾 Webhook ID stored for idempotency:', webhookId);

    /* ACK immediately */
    res.status(200).json({ received: true });
    console.log('✅ Webhook acknowledged (200)');

    /* Async processing */
    processWebhookAsync(event).catch(err => {
      console.log('❌ Async processing error:', err.message);
      logger.error('Async webhook error', { error: err.message });
    });
  })
);

/* ------------------------------------------------------------------ */
/* EVENT ROUTER                                                        */
/* ------------------------------------------------------------------ */

async function processWebhookAsync(event) {
  console.log('⚙️ Processing webhook event async:', event.type);

  if (!event?.type || !event?.data) {
    console.log('❌ Invalid webhook structure');
    return;
  }

  switch (event.type) {
    case 'subscription.created':
    case 'subscription.active':
      return handleSubscriptionActive(event.data);

    case 'subscription.updated':
      return handleSubscriptionUpdated(event.data);

    case 'subscription.plan_changed':
      return handleSubscriptionPlanChanged(event.data);

    case 'subscription.renewed':
      return handleSubscriptionRenewed(event.data);

    case 'subscription.on_hold':
      return handleSubscriptionOnHold(event.data);

    case 'subscription.cancelled':
      return handleSubscriptionCancelled(event.data);

    case 'subscription.expired':
      return handleSubscriptionExpired(event.data);

    case 'payment.succeeded':
      return handlePaymentSucceeded(event.data);

    case 'payment.failed':
      return handlePaymentFailed(event.data);

    default:
      console.log('ℹ️ Unhandled event type:', event.type);
  }
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

async function findUser({ userId, subscriptionId, customerId }) {
  console.log('🔎 Finding user:', { userId, subscriptionId, customerId });

  if (userId) {
    const u = await User.findById(userId);
    if (u) return u;
  }

  if (subscriptionId) {
    const u = await User.findOne({
      'subscription.dodoSubscriptionId': subscriptionId,
    });
    if (u) return u;
  }

  if (customerId) {
    return User.findOne({
      'subscription.dodoCustomerId': customerId,
    });
  }

  return null;
}

function applyPlan(user, plan) {
  console.log('📦 Applying plan:', plan);

  user.plan = plan;

  switch (plan) {
    case 'basic':
      user.quota.monthlyRequests = 10;
      break;
    case 'premium':
      user.quota.monthlyRequests = 50;
      break;
    case 'pro':
      user.quota.monthlyRequests = 100;
      break;
    default:
      user.plan = 'free';
      user.quota.monthlyRequests = 1;
  }
}

/* ------------------------------------------------------------------ */
/* HANDLERS                                                            */
/* ------------------------------------------------------------------ */

async function handleSubscriptionActive(subscription) {
  console.log('🟢 Subscription active:', subscription.subscription_id);

  const user = await findUser({
    userId: subscription.metadata?.app_user_id,
    subscriptionId: subscription.subscription_id,
    customerId: subscription.customer?.customer_id,
  });

  if (!user) {
    console.log('❌ User not found for subscription.active');
    return;
  }

  user.subscription.status = 'active';
  user.subscription.dodoSubscriptionId = subscription.subscription_id;
  user.subscription.dodoCustomerId = subscription.customer?.customer_id;

  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
  }

  if (subscription.metadata?.plan) {
    applyPlan(user, subscription.metadata.plan.toLowerCase());
  }

  await user.save();
  console.log('✅ User subscription activated:', user.id);
}

async function handleSubscriptionUpdated(subscription) {
  console.log('🔄 Subscription updated:', subscription.subscription_id);
  return handleSubscriptionActive(subscription);
}

async function handleSubscriptionPlanChanged(subscription) {
  console.log('🔁 Subscription plan changed:', subscription.subscription_id);

  const user = await findUser({
    subscriptionId: subscription.subscription_id,
  });

  if (!user) return;

  const oldPlan = user.plan;

  if (subscription.metadata?.plan) {
    applyPlan(user, subscription.metadata.plan.toLowerCase());
  }

  await user.save();
  console.log(`✅ Plan changed from ${oldPlan} → ${user.plan}`);
}

async function handleSubscriptionRenewed(subscription) {
  console.log('♻️ Subscription renewed:', subscription.subscription_id);

  const user = await findUser({
    subscriptionId: subscription.subscription_id,
  });

  if (!user) return;

  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
  }

  await user.save();
}

async function handleSubscriptionOnHold(subscription) {
  console.log('⏸ Subscription on hold:', subscription.subscription_id);

  const user = await findUser({
    subscriptionId: subscription.subscription_id,
  });

  if (!user) return;

  user.subscription.status = 'past_due';
  await user.save();
}

async function handleSubscriptionCancelled(subscription) {
  console.log('❌ Subscription cancelled:', subscription.subscription_id);

  const user = await findUser({
    subscriptionId: subscription.subscription_id,
  });

  if (!user) return;

  user.subscription.status = 'canceled';
  applyPlan(user, 'free');

  await user.save();
}

async function handleSubscriptionExpired(subscription) {
  console.log('⌛ Subscription expired:', subscription.subscription_id);
  return handleSubscriptionCancelled(subscription);
}

async function handlePaymentSucceeded(payment) {
  console.log('💰 Payment succeeded:', payment.id);

  const user = await User.findOne({
    'subscription.dodoSubscriptionId': payment.subscription_id,
  });

  if (!user) return;

  user.subscription.status = 'active';
  await user.save();
}

async function handlePaymentFailed(payment) {
  console.log('💥 Payment failed:', payment.id);

  const user = await User.findOne({
    'subscription.dodoSubscriptionId': payment.subscription_id,
  });

  if (!user) return;

  user.subscription.status = 'past_due';
  await user.save();
}

/* ------------------------------------------------------------------ */

export default router;
