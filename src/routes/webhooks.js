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
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY;

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
      case 'subscription.created':
      case 'subscription.updated':
        await handleSubscriptionUpdate(event.data);
        break;

      case 'payment.failed':
        await handlePaymentFailed(event.data);
        break;

      case 'subscription.cancelled':
        await handleSubscriptionCancelled(event.data);
        break;

      case 'subscription.active':
        await handleSubscriptionActive(event.data);
        break;

      case 'subscription.on_hold':
        await handleSubscriptionOnHold(event.data);
        break;

      case 'subscription.failed':
        await handleSubscriptionFailed(event.data);
        break;

      case 'subscription.renewed':
        await handleSubscriptionRenewed(event.data);
        break;

      case 'payment.succeeded':
        await handlePaymentSucceeded(event.data);
        break;

      default:
        logger.debug('Unhandled Dodo webhook event', { type: event.type });
    }
  } catch (error) {
    logger.error('Error in processWebhookAsync', { 
      error: error.message,
      eventType: event.type 
    });
  }
}

async function handleSubscriptionUpdate(subscription) {
  let user = null;
  
  // Try to find user by app_user_id in metadata first
  const userId = subscription.metadata?.app_user_id;
  if (userId) {
    user = await User.findById(userId);
  }
  
  // If user not found by ID, try to find by subscription ID
  if (!user && subscription.id) {
    user = await User.findOne({ 'subscription.dodoSubscriptionId': subscription.id });
  }
  
  // If still not found, try to find by customer ID
  if (!user && subscription.customer_id) {
    user = await User.findOne({ 'subscription.dodoCustomerId': subscription.customer_id });
  }
  
  if (!user) {
    logger.warn('User not found for subscription', {
      subscriptionId: subscription.id,
      appUserId: userId,
      customerId: subscription.customer_id
    });
    return;
  }
  
  // Update user fields
  user.subscription.status = subscription.status;
  user.subscription.dodoSubscriptionId = subscription.id;
  user.subscription.dodoCustomerId = subscription.customer_id;
  user.subscription.paymentProvider = 'dodo';
  
  if (subscription.current_period_end) {
    user.subscription.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
  }
  
  // Determine plan from product_id
  const productId = subscription.product_id;
  console.log('Product ID:', productId);
  
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
  } else if (subscription.metadata?.plan) {
    user.plan = subscription.metadata.plan;
  }
  
  await user.save();

  await Audit.logUsage({
    userId: user.id,
    type: 'subscription_change',
    action: 'subscription_updated',
    resourceType: 'user',
    details: {
      subscriptionId: subscription.id,
      status: subscription.status,
      plan: user.plan
    }
  });
  
  logger.info('Updated user subscription from webhook', { 
    userId: user.id, 
    plan: user.plan, 
    status: subscription.status 
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
  if (!userId) return;
  
  const user = await User.findById(userId);
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
        subscriptionId: subscription.id,
        downgradedTo: 'free'
      }
    });
    
    logger.info('Subscription cancelled via webhook', { userId });
  }
}

async function handleSubscriptionActive(subscription) {
  const userId = subscription.metadata?.app_user_id;
  if (!userId) return;
  
  const user = await User.findById(userId);
  if (user) {
    user.subscription.status = 'active';
    user.subscription.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
    
    // Update plan based on product_id
    const productId = subscription.product_id;
    if (productId) {
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
        subscriptionId: subscription.id,
        status: 'active',
        plan: user.plan
      }
    });
    
    logger.info('Subscription activated via webhook', { 
      userId, 
      subscriptionId: subscription.id, 
      plan: user.plan 
    });
  }
}

async function handleSubscriptionOnHold(subscription) {
  const userId = subscription.metadata?.app_user_id;
  if (!userId) return;
  
  const user = await User.findById(userId);
  if (user) {
    user.subscription.status = 'past_due';
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_on_hold',
      resourceType: 'user',
      details: {
        subscriptionId: subscription.id,
        status: 'past_due',
        reason: 'payment_failure'
      }
    });
    
    logger.info('Subscription placed on hold via webhook', { 
      userId, 
      subscriptionId: subscription.id 
    });
  }
}

async function handleSubscriptionFailed(subscription) {
  const userId = subscription.metadata?.app_user_id;
  if (!userId) return;
  
  const user = await User.findById(userId);
  if (user) {
    user.subscription.status = 'canceled';
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_failed',
      resourceType: 'user',
      details: {
        subscriptionId: subscription.id,
        status: 'canceled',
        reason: 'creation_failed'
      }
    });
    
    logger.info('Subscription creation failed via webhook', { 
      userId, 
      subscriptionId: subscription.id 
    });
  }
}

async function handleSubscriptionRenewed(subscription) {
  const userId = subscription.metadata?.app_user_id;
  if (!userId) return;
  
  const user = await User.findById(userId);
  if (user) {
    user.subscription.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
    await user.save();
    
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'subscription_renewed',
      resourceType: 'user',
      details: {
        subscriptionId: subscription.id,
        currentPeriodEnd: user.subscription.currentPeriodEnd
      }
    });
    
    logger.info('Subscription renewed via webhook', { 
      userId, 
      subscriptionId: subscription.id 
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

// CRITICAL: This export must be at the end of the file
export default router;