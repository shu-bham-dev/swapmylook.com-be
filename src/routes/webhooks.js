import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import ProcessedWebhook from '../models/ProcessedWebhook.js'; // ✅ REQUIRED
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('dodo-webhooks');

/* ------------------------------------------------------------------ */
/* SIGNATURE VERIFICATION (STANDARD WEBHOOKS)                          */
/* ------------------------------------------------------------------ */

function verifyDodoSignature(rawPayload, headers, secret) {
  const webhookId = headers['webhook-id'];
  const webhookSignature = headers['webhook-signature'];
  const webhookTimestamp = headers['webhook-timestamp'];

  if (!webhookId || !webhookSignature || !webhookTimestamp || !secret) {
    logger.warn('Missing webhook headers or secret');
    return false;
  }

  /* -------------------------------------------------- */
  /* Timestamp tolerance (5 minutes)                    */
  /* -------------------------------------------------- */
  const now = Math.floor(Date.now() / 1000);
  const tolerance = 5 * 60;

  if (Math.abs(now - Number(webhookTimestamp)) > tolerance) {
    logger.warn('Webhook timestamp outside tolerance', {
      webhookTimestamp,
      now,
    });
    return false;
  }

  try {
    // Standard Webhooks signed payload
    const signedPayload = `${webhookId}.${webhookTimestamp}.${rawPayload}`;

    // IMPORTANT: base64url (NOT base64)
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('base64url');

    // webhook-signature can contain multiple signatures
    const signatures = webhookSignature.split(' ');

    for (const sig of signatures) {
      const [version, signature] = sig.split(',');
      if (version !== 'v1' || !signature) continue;

      try {
        if (
          crypto.timingSafeEqual(
            Buffer.from(expectedSignature),
            Buffer.from(signature)
          )
        ) {
          return true;
        }
      } catch {
        // Fallback (length mismatch)
        if (expectedSignature === signature) return true;
      }
    }

    return false;
  } catch (err) {
    logger.error('Webhook signature verification failed', {
      error: err.message,
    });
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
    const rawPayload = req.body.toString();
    const headers = {
      'webhook-id': req.headers['webhook-id'],
      'webhook-signature': req.headers['webhook-signature'],
      'webhook-timestamp': req.headers['webhook-timestamp'],
    };

    const secret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;

    /* -------------------------------------------------- */
    /* Verify signature                                   */
    /* -------------------------------------------------- */
    const isValid = verifyDodoSignature(rawPayload, headers, secret);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    /* -------------------------------------------------- */
    /* Parse payload                                      */
    /* -------------------------------------------------- */
    let event;
    try {
      event = JSON.parse(rawPayload);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    /* -------------------------------------------------- */
    /* Idempotency check                                  */
    /* -------------------------------------------------- */
    const webhookId = headers['webhook-id'];
    const alreadyProcessed = await ProcessedWebhook.findOne({ webhookId });

    if (alreadyProcessed) {
      return res.status(200).json({ received: true });
    }

    await ProcessedWebhook.create({ webhookId });

    /* -------------------------------------------------- */
    /* ACK immediately                                    */
    /* -------------------------------------------------- */
    res.status(200).json({ received: true });

    /* -------------------------------------------------- */
    /* Process asynchronously                             */
    /* -------------------------------------------------- */
    processWebhookAsync(event).catch(err => {
      logger.error('Async webhook processing failed', {
        error: err.message,
        type: event.type,
      });
    });
  })
);

/* ------------------------------------------------------------------ */
/* EVENT ROUTER                                                        */
/* ------------------------------------------------------------------ */

async function processWebhookAsync(event) {
  if (!event?.type || !event?.data) return;

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
      logger.info('Unhandled webhook event', { type: event.type });
  }
}

/* ------------------------------------------------------------------ */
/* HANDLERS                                                            */
/* ------------------------------------------------------------------ */

async function findUser({ userId, subscriptionId, customerId }) {
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

/* ---------------- SUBSCRIPTIONS ---------------- */

async function handleSubscriptionActive(subscription) {
  const user = await findUser({
    userId: subscription.metadata?.app_user_id,
    subscriptionId: subscription.subscription_id,
    customerId: subscription.customer?.customer_id,
  });

  if (!user) return;

  user.subscription.status = 'active';
  user.subscription.dodoSubscriptionId = subscription.subscription_id;
  user.subscription.dodoCustomerId = subscription.customer?.customer_id;

  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(
      subscription.next_billing_date
    );
  }

  if (subscription.metadata?.plan) {
    applyPlan(user, subscription.metadata.plan.toLowerCase());
  }

  await user.save();

  await Audit.logUsage({
    userId: user.id,
    type: 'subscription_change',
    action: 'activated',
    details: {
      subscriptionId: subscription.subscription_id,
      plan: user.plan,
    },
  });
}

async function handleSubscriptionUpdated(subscription) {
  return handleSubscriptionActive(subscription);
}

async function handleSubscriptionPlanChanged(subscription) {
  const user = await findUser({
    userId: subscription.metadata?.app_user_id,
    subscriptionId: subscription.subscription_id,
  });

  if (!user) return;

  const oldPlan = user.plan;

  if (subscription.metadata?.plan) {
    applyPlan(user, subscription.metadata.plan.toLowerCase());
  }

  await user.save();

  await Audit.logUsage({
    userId: user.id,
    type: 'subscription_change',
    action: 'plan_changed',
    details: {
      oldPlan,
      newPlan: user.plan,
    },
  });
}

async function handleSubscriptionRenewed(subscription) {
  const user = await findUser({
    subscriptionId: subscription.subscription_id,
  });

  if (!user) return;

  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(
      subscription.next_billing_date
    );
  }

  await user.save();
}

async function handleSubscriptionOnHold(subscription) {
  const user = await findUser({
    subscriptionId: subscription.subscription_id,
  });

  if (!user) return;

  user.subscription.status = 'past_due';
  await user.save();
}

async function handleSubscriptionCancelled(subscription) {
  const user = await findUser({
    subscriptionId: subscription.subscription_id,
  });

  if (!user) return;

  user.subscription.status = 'canceled';
  applyPlan(user, 'free');

  await user.save();
}

async function handleSubscriptionExpired(subscription) {
  return handleSubscriptionCancelled(subscription);
}

/* ---------------- PAYMENTS ---------------- */

async function handlePaymentSucceeded(payment) {
  const user = await User.findOne({
    'subscription.dodoSubscriptionId': payment.subscription_id,
  });

  if (!user) return;

  user.subscription.status = 'active';
  await user.save();
}

async function handlePaymentFailed(payment) {
  const user = await User.findOne({
    'subscription.dodoSubscriptionId': payment.subscription_id,
  });

  if (!user) return;

  user.subscription.status = 'past_due';
  await user.save();
}

/* ------------------------------------------------------------------ */

export default router;
