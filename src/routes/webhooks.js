import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('webhooks-routes');

/**
 * Verify Dodo webhook signature following Standard Webhooks specification
 * See: https://docs.dodopayments.com/developer-resources/webhooks
 */
const verifyDodoSignature = (payload, headers, secret) => {
  const webhookId = headers['webhook-id'];
  const webhookSignature = headers['webhook-signature'];
  const webhookTimestamp = headers['webhook-timestamp'];

  if (!webhookId || !webhookSignature || !webhookTimestamp || !secret) {
    logger.warn('Missing required webhook headers or secret');
    return false;
  }

  try {
    // Standard Webhooks format: webhook-id.webhook-timestamp.payload
    const signedPayload = `${webhookId}.${webhookTimestamp}.${payload}`;

    // Calculate expected signature using HMAC SHA256
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('base64');

    // The webhook-signature header contains signatures in format: v1,signature1 v1,signature2
    const signatures = webhookSignature.split(' ');
    
    for (const sig of signatures) {
      const [version, signature] = sig.split(',');
      
      if (version === 'v1') {
        try {
          const matches = crypto.timingSafeEqual(
            Buffer.from(expectedSignature),
            Buffer.from(signature)
          );
          
          if (matches) {
            return true;
          }
        } catch (error) {
          // Buffer lengths don't match, continue to next signature
          continue;
        }
      }
    }

    return false;
  } catch (error) {
    logger.error('Error verifying webhook signature', { error: error.message });
    return false;
  }
};

/**
 * @swagger
 * tags:
 *   name: Webhooks
 *   description: Webhook endpoints for external services
 */

/**
 * @swagger
 * /api/v1/webhooks/dodo:
 *   post:
 *     summary: Dodo Payments webhook handler
 *     description: Receive and process webhook events from Dodo Payments
 *     tags: [Webhooks]
 *     parameters:
 *       - in: header
 *         name: webhook-id
 *         required: true
 *       - in: header
 *         name: webhook-signature
 *         required: true
 *       - in: header
 *         name: webhook-timestamp
 *         required: true
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *       401:
 *         description: Invalid signature
 *       400:
 *         description: Invalid payload
 */
router.post('/dodo', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  console.log('=== DODO WEBHOOK RECEIVED ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  
  const payload = req.body.toString(); // Convert buffer to string
  const headers = {
    'webhook-id': req.headers['webhook-id'],
    'webhook-signature': req.headers['webhook-signature'],
    'webhook-timestamp': req.headers['webhook-timestamp']
  };
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;

  console.log('Payload length:', payload.length);
  console.log('Headers present:', {
    hasId: !!headers['webhook-id'],
    hasSignature: !!headers['webhook-signature'],
    hasTimestamp: !!headers['webhook-timestamp'],
    hasSecret: !!secret
  });

  // Verify signature
  const signatureValid = verifyDodoSignature(payload, headers, secret);

  if (!signatureValid) {
    logger.warn('Invalid webhook signature', { headers });
    console.log('❌ Signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  console.log('✅ Signature verified successfully');

  // Parse JSON
  let event;
  try {
    event = JSON.parse(payload);
  } catch (err) {
    logger.error('Failed to parse webhook payload', { error: err.message });
    console.log('❌ Failed to parse JSON:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  logger.info('Received Dodo webhook event', { 
    type: event.type, 
    webhookId: headers['webhook-id'] 
  });
  console.log('✅ Webhook event parsed:', event.type);

  // Acknowledge receipt immediately (before processing)
  res.status(200).json({ received: true });

  // Process webhook asynchronously
  processWebhookAsync(event).catch(err => {
    logger.error('Error processing webhook async', { 
      error: err.message,
      stack: err.stack 
    });
  });
}));

async function processWebhookAsync(event) {
  try {
    // Handle event types
    switch (event.type) {
      case 'subscription.active':
        // Subscription is successfully activated (initial activation or reactivation)
        await handleSubscriptionActive(event.data);
        break;

      case 'subscription.updated':
        // Any subscription field change - use this for real-time sync
        await handleSubscriptionUpdate(event.data);
        break;

      case 'subscription.on_hold':
        // Subscription is put on hold due to failed renewal
        await handleSubscriptionOnHold(event.data);
        break;

      case 'subscription.renewed':
        // Subscription is renewed for the next billing period
        await handleSubscriptionRenewed(event.data);
        break;

      case 'subscription.plan_changed':
        // Subscription plan was upgraded, downgraded, or modified
        await handleSubscriptionPlanChanged(event.data);
        break;

      case 'subscription.cancelled':
        // Subscription is cancelled
        await handleSubscriptionCancelled(event.data);
        break;

      case 'subscription.failed':
        // Subscription creation failed during mandate creation
        await handleSubscriptionFailed(event.data);
        break;

      case 'subscription.expired':
        // Subscription reached the end of its term
        await handleSubscriptionExpired(event.data);
        break;

      case 'payment.succeeded':
        // Payment succeeded
        await handlePaymentSucceeded(event.data);
        break;

      case 'payment.failed':
        // Payment failed
        await handlePaymentFailed(event.data);
        break;

      default:
        logger.debug('Unhandled Dodo webhook event', { type: event.type });
    }
  } catch (error) {
    logger.error('Error in processWebhookAsync', { 
      error: error.message,
      eventType: event.type,
      stack: error.stack
    });
  }
}

async function handleSubscriptionUpdate(subscription) {
  let user = null;
  
  // Extract data from the actual Dodo webhook structure
  const subscriptionId = subscription.subscription_id;
  const customerId = subscription.customer?.customer_id;
  const userId = subscription.metadata?.app_user_id;
  
  console.log('Processing subscription update:', {
    subscriptionId,
    customerId,
    userId,
    status: subscription.status,
    productId: subscription.product_id
  });
  
  // Try to find user by app_user_id in metadata first
  if (userId) {
    user = await User.findById(userId);
  }
  
  // If user not found by ID, try to find by subscription ID
  if (!user && subscriptionId) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
  }
  
  // If still not found, try to find by customer ID
  if (!user && customerId) {
    user = await User.findOne({ 'subscription.dodoCustomerId': customerId });
  }
  
  if (!user) {
    logger.warn('User not found for subscription', {
      subscriptionId,
      appUserId: userId,
      customerId
    });
    return;
  }
  
  // Update user fields
  user.subscription.status = subscription.status;
  user.subscription.dodoSubscriptionId = subscriptionId;
  user.subscription.dodoCustomerId = customerId;
  user.subscription.paymentProvider = 'dodo';
  
  // Convert next_billing_date to Date object
  if (subscription.next_billing_date) {
    user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
  }
  
  // Determine plan from product_id or metadata
  const productId = subscription.product_id;
  console.log('Product ID:', productId);
  console.log('Metadata plan:', subscription.metadata?.plan);
  
  // First, try to get plan from metadata (most reliable)
  if (subscription.metadata?.plan) {
    const metadataPlan = subscription.metadata.plan.toLowerCase();
    user.plan = metadataPlan;
    
    // Set quota based on plan
    switch (metadataPlan) {
      case 'basic':
        user.quota.monthlyRequests = 10;
        break;
      case 'premium':
        user.quota.monthlyRequests = 50;
        break;
      case 'pro':
        user.quota.monthlyRequests = 100;
        break;
    }
    console.log('Using plan from metadata:', metadataPlan);
  } 
  // Fallback to product_id mapping
  else if (productId === process.env.DODO_PRODUCT_BASIC || 
      productId === process.env.DODO_PRODUCT_BASIC_YEARLY) {
    user.plan = 'basic';
    user.quota.monthlyRequests = 10;
    console.log('Mapped to basic via product_id');
  } else if (productId === process.env.DODO_PRODUCT_PREMIUM || 
             productId === process.env.DODO_PRODUCT_PREMIUM_YEARLY) {
    user.plan = 'premium';
    user.quota.monthlyRequests = 50;
    console.log('Mapped to premium via product_id');
  } else if (productId === process.env.DODO_PRODUCT_PRO || 
             productId === process.env.DODO_PRODUCT_PRO_YEARLY) {
    user.plan = 'pro';
    user.quota.monthlyRequests = 100;
    console.log('Mapped to pro via product_id');
  }
  
  await user.save();

  await Audit.logUsage({
    userId: user.id,
    type: 'subscription_change',
    action: 'subscription_updated',
    resourceType: 'user',
    details: {
      subscriptionId,
      status: subscription.status,
      plan: user.plan,
      productId: subscription.product_id,
      nextBillingDate: subscription.next_billing_date,
      paymentFrequency: `${subscription.payment_frequency_count} ${subscription.payment_frequency_interval}`
    }
  });
  
  logger.info('Updated user subscription from webhook', { 
    userId: user.id, 
    plan: user.plan, 
    status: subscription.status,
    nextBillingDate: subscription.next_billing_date
  });
}

async function handlePaymentFailed(payment) {
  const subId = payment.subscription_id;
  const user = await User.findOne({ 'subscription.dodoSubscriptionId': subId });
  
  if (user) {
    user.subscription.status = 'past_due';
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'payment_failed',
      resourceType: 'user',
      details: {
        subscriptionId: subId,
        status: 'past_due'
      }
    });
    
    logger.info('Subscription marked as past_due due to payment failure', { 
      userId: user.id, 
      subscriptionId: subId 
    });
  } else {
    logger.warn('User not found for failed payment', { subscriptionId: subId });
  }
}

async function handleSubscriptionCancelled(subscription) {
  const userId = subscription.metadata?.app_user_id;
  const subscriptionId = subscription.subscription_id;
  
  if (!userId && !subscriptionId) return;
  
  let user = null;
  if (userId) {
    user = await User.findById(userId);
  }
  
  if (!user && subscriptionId) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
  }
  
  if (user) {
    user.subscription.status = 'canceled';
    user.plan = 'free';
    user.quota.monthlyRequests = 1;
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_cancelled',
      resourceType: 'user',
      details: {
        subscriptionId,
        downgradedTo: 'free'
      }
    });
    
    logger.info('Subscription cancelled via webhook', { userId: user.id, subscriptionId });
  }
}

async function handleSubscriptionActive(subscription) {
  const userId = subscription.metadata?.app_user_id;
  const subscriptionId = subscription.subscription_id;
  const customerId = subscription.customer?.customer_id;
  
  if (!userId && !subscriptionId) {
    logger.warn('No user ID or subscription ID in active subscription webhook');
    return;
  }
  
  let user = null;
  if (userId) {
    user = await User.findById(userId);
  }
  
  if (!user && subscriptionId) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
  }
  
  if (!user && customerId) {
    user = await User.findOne({ 'subscription.dodoCustomerId': customerId });
  }
  
  if (user) {
    user.subscription.status = 'active';
    user.subscription.dodoSubscriptionId = subscriptionId;
    user.subscription.dodoCustomerId = customerId;
    
    // Use next_billing_date instead of current_period_end
    if (subscription.next_billing_date) {
      user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
    }
    
    // Update plan based on metadata first, then product_id
    if (subscription.metadata?.plan) {
      const metadataPlan = subscription.metadata.plan.toLowerCase();
      user.plan = metadataPlan;
      
      switch (metadataPlan) {
        case 'basic':
          user.quota.monthlyRequests = 10;
          break;
        case 'premium':
          user.quota.monthlyRequests = 50;
          break;
        case 'pro':
          user.quota.monthlyRequests = 100;
          break;
      }
    } else {
      const productId = subscription.product_id;
      if (productId === process.env.DODO_PRODUCT_BASIC || 
          productId === process.env.DODO_PRODUCT_BASIC_YEARLY) {
        user.plan = 'basic';
        user.quota.monthlyRequests = 10;
      } else if (productId === process.env.DODO_PRODUCT_PREMIUM || 
                 productId === process.env.DODO_PRODUCT_PREMIUM_YEARLY) {
        user.plan = 'premium';
        user.quota.monthlyRequests = 50;
      } else if (productId === process.env.DODO_PRODUCT_PRO || 
                 productId === process.env.DODO_PRODUCT_PRO_YEARLY) {
        user.plan = 'pro';
        user.quota.monthlyRequests = 100;
      }
    }
    
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_activated',
      resourceType: 'user',
      details: {
        subscriptionId,
        status: 'active',
        plan: user.plan,
        nextBillingDate: subscription.next_billing_date
      }
    });
    
    logger.info('Subscription activated via webhook', { 
      userId: user.id, 
      subscriptionId, 
      plan: user.plan 
    });
  } else {
    logger.warn('User not found for active subscription', { userId, subscriptionId, customerId });
  }
}

async function handleSubscriptionOnHold(subscription) {
  const userId = subscription.metadata?.app_user_id;
  const subscriptionId = subscription.subscription_id;
  
  if (!userId && !subscriptionId) return;
  
  let user = null;
  if (userId) {
    user = await User.findById(userId);
  }
  
  if (!user && subscriptionId) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
  }
  
  if (user) {
    user.subscription.status = 'past_due';
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_on_hold',
      resourceType: 'user',
      details: {
        subscriptionId,
        status: 'past_due',
        reason: 'payment_failure'
      }
    });
    
    logger.info('Subscription placed on hold via webhook', { 
      userId: user.id, 
      subscriptionId 
    });
  }
}

async function handleSubscriptionFailed(subscription) {
  const userId = subscription.metadata?.app_user_id;
  const subscriptionId = subscription.subscription_id;
  
  if (!userId && !subscriptionId) return;
  
  let user = null;
  if (userId) {
    user = await User.findById(userId);
  }
  
  if (!user && subscriptionId) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
  }
  
  if (user) {
    user.subscription.status = 'canceled';
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_failed',
      resourceType: 'user',
      details: {
        subscriptionId,
        status: 'canceled',
        reason: 'creation_failed'
      }
    });
    
    logger.info('Subscription creation failed via webhook', { 
      userId: user.id, 
      subscriptionId 
    });
  }
}

async function handleSubscriptionRenewed(subscription) {
  const userId = subscription.metadata?.app_user_id;
  const subscriptionId = subscription.subscription_id;
  
  if (!userId && !subscriptionId) return;
  
  let user = null;
  if (userId) {
    user = await User.findById(userId);
  }
  
  if (!user && subscriptionId) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
  }
  
  if (user) {
    // Use next_billing_date for the renewed period end
    if (subscription.next_billing_date) {
      user.subscription.currentPeriodEnd = new Date(subscription.next_billing_date);
    }
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_renewed',
      resourceType: 'user',
      details: {
        subscriptionId,
        currentPeriodEnd: user.subscription.currentPeriodEnd,
        nextBillingDate: subscription.next_billing_date
      }
    });
    
    logger.info('Subscription renewed via webhook', { 
      userId: user.id, 
      subscriptionId 
    });
  }
}

async function handlePaymentSucceeded(payment) {
  const subId = payment.subscription_id;
  if (!subId) return;
  
  const user = await User.findOne({ 'subscription.dodoSubscriptionId': subId });
  if (user) {
    user.subscription.status = 'active';
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'payment_succeeded',
      resourceType: 'user',
      details: {
        subscriptionId: subId,
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: 'active'
      }
    });
    
    logger.info('Payment succeeded via webhook', { 
      userId: user.id, 
      subscriptionId: subId, 
      amount: payment.amount 
    });
  }
}

async function handleSubscriptionPlanChanged(subscription) {
  const userId = subscription.metadata?.app_user_id;
  const subscriptionId = subscription.subscription_id;
  
  if (!userId && !subscriptionId) return;
  
  let user = null;
  if (userId) {
    user = await User.findById(userId);
  }
  
  if (!user && subscriptionId) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
  }
  
  if (user) {
    // Store old plan for audit log
    const oldPlan = user.plan;
    
    // Update plan based on metadata first, then product_id
    if (subscription.metadata?.plan) {
      const metadataPlan = subscription.metadata.plan.toLowerCase();
      user.plan = metadataPlan;
      
      switch (metadataPlan) {
        case 'basic':
          user.quota.monthlyRequests = 10;
          break;
        case 'premium':
          user.quota.monthlyRequests = 50;
          break;
        case 'pro':
          user.quota.monthlyRequests = 100;
          break;
      }
    } else {
      const productId = subscription.product_id;
      if (productId === process.env.DODO_PRODUCT_BASIC || 
          productId === process.env.DODO_PRODUCT_BASIC_YEARLY) {
        user.plan = 'basic';
        user.quota.monthlyRequests = 10;
      } else if (productId === process.env.DODO_PRODUCT_PREMIUM || 
                 productId === process.env.DODO_PRODUCT_PREMIUM_YEARLY) {
        user.plan = 'premium';
        user.quota.monthlyRequests = 50;
      } else if (productId === process.env.DODO_PRODUCT_PRO || 
                 productId === process.env.DODO_PRODUCT_PRO_YEARLY) {
        user.plan = 'pro';
        user.quota.monthlyRequests = 100;
      }
    }
    
    // Update next billing date
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
        subscriptionId,
        oldPlan,
        newPlan: user.plan,
        productId: subscription.product_id,
        nextBillingDate: subscription.next_billing_date
      }
    });
    
    logger.info('Subscription plan changed via webhook', { 
      userId: user.id, 
      subscriptionId,
      oldPlan,
      newPlan: user.plan
    });
  }
}

async function handleSubscriptionExpired(subscription) {
  const userId = subscription.metadata?.app_user_id;
  const subscriptionId = subscription.subscription_id;
  
  if (!userId && !subscriptionId) return;
  
  let user = null;
  if (userId) {
    user = await User.findById(userId);
  }
  
  if (!user && subscriptionId) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscriptionId });
  }
  
  if (user) {
    user.subscription.status = 'expired';
    // Downgrade to free plan on expiration
    user.plan = 'free';
    user.quota.monthlyRequests = 1;
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_expired',
      resourceType: 'user',
      details: {
        subscriptionId,
        status: 'expired',
        downgradedTo: 'free'
      }
    });
    
    logger.info('Subscription expired via webhook', { 
      userId: user.id, 
      subscriptionId 
    });
  }
}

// CRITICAL: This export must be at the end of the file
export default router;