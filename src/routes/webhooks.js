import express from 'express';
import DodoPayments from 'dodopayments';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('dodo-webhooks');

/**
 * 🚨 IMPORTANT
 * - This route MUST be mounted BEFORE express.json()
 * - Raw body is REQUIRED for signature verification
 */
router.post(
  '/dodo',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    console.log('\n================ DODO WEBHOOK RECEIVED ================');
    console.log('Headers:', req.headers);
    console.log('Raw payload length:', req.body.length);

    const client = new DodoPayments({
      bearerToken: process.env.DODO_PAYMENTS_API_KEY,
      environment: process.env.DODO_PAYMENTS_ENVIRONMENT, // test | live
      webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,   // whsec_...
    });

    let event;

    try {
      // ✅ OFFICIAL VERIFICATION (Svix handled internally)
      event = client.webhooks.unwrap(req.body.toString(), {
        headers: {
          'webhook-id': req.headers['webhook-id'],
          'webhook-signature': req.headers['webhook-signature'],
          'webhook-timestamp': req.headers['webhook-timestamp'],
        },
      });

      console.log('✅ Webhook signature verified');
      console.log('Event type:', event.type);

      // ACK IMMEDIATELY (CRITICAL)
      res.status(200).json({ received: true });

    } catch (error) {
      console.error('❌ Webhook verification failed:', error.message);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Process asynchronously
    processWebhookAsync(event).catch(err => {
      logger.error('Async webhook processing failed', {
        error: err.message,
        stack: err.stack,
      });
    });
  })
);

export default router;

/* ================================================================= */
/* ====================== EVENT PROCESSOR =========================== */
/* ================================================================= */

async function processWebhookAsync(event) {
  if (!event?.type || !event?.data) {
    logger.warn('Invalid webhook payload');
    return;
  }

  logger.info('Processing webhook event', { type: event.type });

  switch (event.type) {
    case 'subscription.active':
      await handleSubscriptionActive(event.data);
      break;

    case 'subscription.updated':
      await handleSubscriptionUpdate(event.data);
      break;

    case 'subscription.plan_changed':
      await handleSubscriptionPlanChanged(event.data);
      break;

    case 'subscription.renewed':
      await handleSubscriptionRenewed(event.data);
      break;

    case 'subscription.on_hold':
      await handleSubscriptionOnHold(event.data);
      break;

    case 'subscription.cancelled':
      await handleSubscriptionCancelled(event.data);
      break;

    case 'subscription.failed':
      await handleSubscriptionFailed(event.data);
      break;

    case 'subscription.expired':
      await handleSubscriptionExpired(event.data);
      break;

    case 'payment.succeeded':
      await handlePaymentSucceeded(event.data);
      break;

    case 'payment.failed':
      await handlePaymentFailed(event.data);
      break;

    default:
      logger.debug('Unhandled webhook event', { type: event.type });
  }
}

/* ================================================================= */
/* ====================== DB HELPERS ================================ */
/* ================================================================= */

async function findUserFromSubscription(subscription) {
  const userId = subscription.metadata?.app_user_id;
  const subscriptionId = subscription.subscription_id;
  const customerId = subscription.customer?.customer_id;

  if (userId) {
    const user = await User.findById(userId);
    if (user) return user;
  }

  if (subscriptionId) {
    const user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
    if (user) return user;
  }

  if (customerId) {
    const user = await User.findOne({ 'subscription.dodoCustomerId': customerId });
    if (user) return user;
  }

  return null;
}

function applyPlan(user, subscription) {
  const plan =
    subscription.metadata?.plan?.toLowerCase() ||
    mapProductToPlan(subscription.product_id);

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

function mapProductToPlan(productId) {
  if ([process.env.DODO_PRODUCT_BASIC, process.env.DODO_PRODUCT_BASIC_YEARLY].includes(productId))
    return 'basic';
  if ([process.env.DODO_PRODUCT_PREMIUM, process.env.DODO_PRODUCT_PREMIUM_YEARLY].includes(productId))
    return 'premium';
  if ([process.env.DODO_PRODUCT_PRO, process.env.DODO_PRODUCT_PRO_YEARLY].includes(productId))
    return 'pro';
  return 'free';
}

/* ================================================================= */
/* ====================== EVENT HANDLERS ============================ */
/* ================================================================= */

async function handleSubscriptionActive(subscription) {
  const user = await findUserFromSubscription(subscription);
  if (!user) return;

  user.subscription.status = 'active';
  user.subscription.dodoSubscriptionId = subscription.subscription_id;
  user.subscription.dodoCustomerId = subscription.customer?.customer_id;
  user.subscription.paymentProvider = 'dodo';

  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
  }

  applyPlan(user, subscription);
  await user.save();

  await Audit.logUsage({
    userId: user.id,
    type: 'subscription_change',
    action: 'subscription_activated',
    resourceType: 'user',
    details: {
      subscriptionId: subscription.subscription_id,
      plan: user.plan,
      nextBillingDate: subscription.next_billing_date,
    },
  });
}

async function handleSubscriptionUpdate(subscription) {
  const user = await findUserFromSubscription(subscription);
  if (!user) return;

  user.subscription.status = subscription.status;
  applyPlan(user, subscription);

  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
  }

  await user.save();

  await Audit.logUsage({
    userId: user.id,
    type: 'subscription_change',
    action: 'subscription_updated',
    resourceType: 'user',
    details: {
      subscriptionId: subscription.subscription_id,
      status: subscription.status,
      plan: user.plan,
    },
  });
}

async function handleSubscriptionPlanChanged(subscription) {
  const user = await findUserFromSubscription(subscription);
  if (!user) return;

  const oldPlan = user.plan;
  applyPlan(user, subscription);

  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
  }

  await user.save();

  await Audit.logUsage({
    userId: user.id,
    type: 'subscription_change',
    action: 'subscription_plan_changed',
    resourceType: 'user',
    details: {
      subscriptionId: subscription.subscription_id,
      oldPlan,
      newPlan: user.plan,
    },
  });
}

async function handleSubscriptionRenewed(subscription) {
  const user = await findUserFromSubscription(subscription);
  if (!user) return;

  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
  }

  await user.save();
}

async function handleSubscriptionOnHold(subscription) {
  const user = await findUserFromSubscription(subscription);
  if (!user) return;

  user.subscription.status = 'past_due';
  await user.save();
}

async function handleSubscriptionCancelled(subscription) {
  const user = await findUserFromSubscription(subscription);
  if (!user) return;

  user.subscription.status = 'canceled';
  user.plan = 'free';
  user.quota.monthlyRequests = 1;
  await user.save();
}

async function handleSubscriptionFailed(subscription) {
  const user = await findUserFromSubscription(subscription);
  if (!user) return;

  user.subscription.status = 'canceled';
  await user.save();
}

async function handleSubscriptionExpired(subscription) {
  const user = await findUserFromSubscription(subscription);
  if (!user) return;

  user.subscription.status = 'expired';
  user.plan = 'free';
  user.quota.monthlyRequests = 1;
  await user.save();
}

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
