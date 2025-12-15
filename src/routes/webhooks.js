import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('webhooks-routes');

/**
 * Verify Dodo webhook signature.
 * According to Dodo documentation, webhook signature is HMAC SHA256 of timestamp + '.' + payload.
 * Header format: "t=timestamp,v1=signature"
 */
const verifyDodoSignature = (payload, signatureHeader, secret) => {
  if (!signatureHeader || !secret) {
    return false;
  }

  try {
    // Parse header: "t=1234567890,v1=signature"
    const parts = signatureHeader.split(',');
    let timestamp = '';
    let signature = '';

    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === 't') {
        timestamp = value;
      } else if (key === 'v1') {
        signature = value;
      }
    }

    if (!timestamp || !signature) {
      return false;
    }

    // Create signed payload: timestamp + '.' + payload
    const signedPayload = `${timestamp}.${payload}`;

    // Calculate expected signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');

    // Use timing-safe comparison
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature)
    );
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
 *     description: Receive and process webhook events from Dodo Payments (subscription created, payment failed, etc.)
 *     tags: [Webhooks]
 *     parameters:
 *       - in: header
 *         name: webhook-signature
 *         schema:
 *           type: string
 *         required: true
 *         description: HMAC SHA256 signature of the payload
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 description: Event type (e.g., subscription.created, payment.failed)
 *               data:
 *                 type: object
 *                 description: Event data
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid signature or malformed payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error processing webhook
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/dodo', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  console.log('=== DODO WEBHOOK RECEIVED ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  
  const sigHeader = req.headers['webhook-signature'] || req.headers['webhook_signature'];
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
  const payload = req.body; // raw buffer
  
  console.log('Payload length:', payload.length);
  console.log('Signature header present:', !!sigHeader);
  console.log('Webhook secret present:', !!secret);

  // Verify signature
  if (!verifyDodoSignature(payload, sigHeader, secret)) {
    logger.warn('Invalid webhook signature', { header: sigHeader });
    console.log('❌ Signature verification failed');
    return res.status(400).send('Invalid signature');
  }
  
  console.log('✅ Signature verified successfully');

  // Parse JSON
  let event;
  try {
    const payloadStr = payload.toString();
    console.log('Payload string (first 500 chars):', payloadStr.substring(0, 500));
    event = JSON.parse(payloadStr);
  } catch (err) {
    logger.error('Failed to parse webhook payload', { error: err.message });
    console.log('❌ Failed to parse JSON:', err.message);
    return res.status(400).send('Invalid JSON');
  }

  logger.info('Received Dodo webhook event', { type: event.type, id: event.id });
  console.log('✅ Webhook event parsed:', event.type, 'ID:', event.id);

  // Handle event types
  switch (event.type) {
    case 'subscription.created':
    case 'subscription.updated':
      // Update user subscription
      const subscription = event.data;
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
        break;
      }
      
      // Update user fields
      user.subscription.status = subscription.status;
      user.subscription.dodoSubscriptionId = subscription.id;
      user.subscription.dodoCustomerId = subscription.customer_id;
      user.subscription.paymentProvider = 'dodo';
      if (subscription.current_period_end) {
        user.subscription.currentPeriodEnd = new Date(subscription.current_period_end * 1000); // assuming Unix timestamp
      }
      
      // Determine plan from product_id
      const productId = subscription.product_id;
      console.log('Webhook received product ID:', productId);
      console.log('Env DODO_PRODUCT_BASIC:', process.env.DODO_PRODUCT_BASIC);
      console.log('Env DODO_PRODUCT_PREMIUM:', process.env.DODO_PRODUCT_PREMIUM);
      console.log('Env DODO_PRODUCT_PRO:', process.env.DODO_PRODUCT_PRO);
      
      // Map product ID to plan
      if (productId === process.env.DODO_PRODUCT_BASIC || productId === process.env.DODO_PRODUCT_BASIC_YEARLY) {
        user.plan = 'basic';
        user.quota.monthlyRequests = 10;
        console.log('Mapped to basic plan');
      } else if (productId === process.env.DODO_PRODUCT_PREMIUM || productId === process.env.DODO_PRODUCT_PREMIUM_YEARLY) {
        user.plan = 'premium';
        user.quota.monthlyRequests = 50;
        console.log('Mapped to premium plan');
      } else if (productId === process.env.DODO_PRODUCT_PRO || productId === process.env.DODO_PRODUCT_PRO_YEARLY) {
        user.plan = 'pro';
        user.quota.monthlyRequests = 100;
        console.log('Mapped to pro plan');
      } else {
        console.log('Unknown product ID:', productId);
        // Try to determine plan from metadata
        if (subscription.metadata?.plan) {
          user.plan = subscription.metadata.plan;
          console.log('Using plan from metadata:', user.plan);
        }
      }
      await user.save();

      await Audit.logUsage({
        userId: user.id,
        type: 'subscription_change',
        action: 'subscription_updated',
        resourceType: 'user',
        details: {
          event: event.type,
          subscriptionId: subscription.id,
          status: subscription.status,
          plan: user.plan
        }
      });
      logger.info('Updated user subscription from webhook', { userId: user.id, plan: user.plan, status: subscription.status });
      break;

    case 'payment.failed':
      // Mark subscription as past_due
      const payment = event.data;
      const subId = payment.subscription_id;
      const failedUser = await User.findOne({ 'subscription.dodoSubscriptionId': subId });
      if (failedUser) {
        failedUser.subscription.status = 'past_due';
        await failedUser.save();
        await Audit.logUsage({
          userId: failedUser.id,
          type: 'subscription_change',
          action: 'payment_failed',
          resourceType: 'user',
          details: {
            subscriptionId: subId,
            status: 'past_due'
          }
        });
        logger.info('Subscription marked as past_due due to payment failure', { userId: failedUser.id, subscriptionId: subId });
      } else {
        logger.warn('User not found for failed payment', { subscriptionId: subId });
      }
      break;

    case 'subscription.cancelled':
      const cancelledSub = event.data;
      const cancelledUserId = cancelledSub.metadata?.app_user_id;
      if (cancelledUserId) {
        const cancelledUser = await User.findById(cancelledUserId);
        if (cancelledUser) {
          cancelledUser.subscription.status = 'canceled';
          // Downgrade to free plan on cancellation
          cancelledUser.plan = 'free';
          cancelledUser.quota.monthlyRequests = 1;
          await cancelledUser.save();
          await Audit.logUsage({
            userId: cancelledUser.id,
            type: 'subscription_change',
            action: 'subscription_cancelled',
            resourceType: 'user',
            details: {
              subscriptionId: cancelledSub.id,
              downgradedTo: 'free'
            }
          });
          logger.info('Subscription cancelled via webhook', { userId: cancelledUserId });
        }
      }
      break;

    case 'subscription.active':
      // Handle reactivation or successful plan change
      const activeSub = event.data;
      const activeUserId = activeSub.metadata?.app_user_id;
      if (activeUserId) {
        const activeUser = await User.findById(activeUserId);
        if (activeUser) {
          activeUser.subscription.status = 'active';
          activeUser.subscription.currentPeriodEnd = new Date(activeSub.current_period_end * 1000);
          
          // Update plan based on product_id if available
          const productId = activeSub.product_id;
          if (productId) {
            // Map product ID to plan
            if (productId === process.env.DODO_PRODUCT_BASIC || productId === process.env.DODO_PRODUCT_BASIC_YEARLY) {
              activeUser.plan = 'basic';
              activeUser.quota.monthlyRequests = 10;
              console.log('Mapped to basic plan via subscription.active');
            } else if (productId === process.env.DODO_PRODUCT_PREMIUM || productId === process.env.DODO_PRODUCT_PREMIUM_YEARLY) {
              activeUser.plan = 'premium';
              activeUser.quota.monthlyRequests = 50;
              console.log('Mapped to premium plan via subscription.active');
            } else if (productId === process.env.DODO_PRODUCT_PRO || productId === process.env.DODO_PRODUCT_PRO_YEARLY) {
              activeUser.plan = 'pro';
              activeUser.quota.monthlyRequests = 100;
              console.log('Mapped to pro plan via subscription.active');
            } else {
              console.log('Unknown product ID in subscription.active:', productId);
            }
          }
          
          await activeUser.save();
          await Audit.logUsage({
            userId: activeUser.id,
            type: 'subscription_change',
            action: 'subscription_activated',
            resourceType: 'user',
            details: {
              subscriptionId: activeSub.id,
              status: 'active',
              currentPeriodEnd: activeUser.subscription.currentPeriodEnd,
              plan: activeUser.plan
            }
          });
          logger.info('Subscription activated via webhook', { userId: activeUserId, subscriptionId: activeSub.id, plan: activeUser.plan });
        }
      }
      break;

    case 'subscription.on_hold':
      // Subscription placed on hold due to payment failure
      const onHoldSub = event.data;
      const onHoldUserId = onHoldSub.metadata?.app_user_id;
      if (onHoldUserId) {
        const onHoldUser = await User.findById(onHoldUserId);
        if (onHoldUser) {
          onHoldUser.subscription.status = 'past_due';
          await onHoldUser.save();
          await Audit.logUsage({
            userId: onHoldUser.id,
            type: 'subscription_change',
            action: 'subscription_on_hold',
            resourceType: 'user',
            details: {
              subscriptionId: onHoldSub.id,
              status: 'past_due',
              reason: 'payment_failure'
            }
          });
          logger.info('Subscription placed on hold via webhook', { userId: onHoldUserId, subscriptionId: onHoldSub.id });
          // TODO: Send notification to user to update payment method
        }
      }
      break;

    case 'subscription.failed':
      // Subscription creation failed
      const failedSub = event.data;
      const failedSubUserId = failedSub.metadata?.app_user_id;
      if (failedSubUserId) {
        const failedSubUser = await User.findById(failedSubUserId);
        if (failedSubUser) {
          failedSubUser.subscription.status = 'canceled';
          await failedSubUser.save();
          await Audit.logUsage({
            userId: failedSubUser.id,
            type: 'subscription_change',
            action: 'subscription_failed',
            resourceType: 'user',
            details: {
              subscriptionId: failedSub.id,
              status: 'canceled',
              reason: 'creation_failed'
            }
          });
          logger.info('Subscription creation failed via webhook', { userId: failedSubUserId, subscriptionId: failedSub.id });
        }
      }
      break;

    case 'subscription.renewed':
      // Subscription renewed for next billing period
      const renewedSub = event.data;
      const renewedUserId = renewedSub.metadata?.app_user_id;
      if (renewedUserId) {
        const renewedUser = await User.findById(renewedUserId);
        if (renewedUser) {
          renewedUser.subscription.currentPeriodEnd = new Date(renewedSub.current_period_end * 1000);
          await renewedUser.save();
          await Audit.logUsage({
            userId: renewedUser.id,
            type: 'subscription_change',
            action: 'subscription_renewed',
            resourceType: 'user',
            details: {
              subscriptionId: renewedSub.id,
              currentPeriodEnd: renewedUser.subscription.currentPeriodEnd
            }
          });
          logger.info('Subscription renewed via webhook', { userId: renewedUserId, subscriptionId: renewedSub.id });
        }
      }
      break;

    case 'payment.succeeded':
      // Payment succeeded (could be initial payment or renewal)
      const succeededPayment = event.data;
      const paymentSubId = succeededPayment.subscription_id;
      if (paymentSubId) {
        const paymentUser = await User.findOne({ 'subscription.dodoSubscriptionId': paymentSubId });
        if (paymentUser) {
          // Update subscription status to active
          paymentUser.subscription.status = 'active';
          
          // If this is an initial payment, we should also update plan based on product_id
          // Try to get product_id from payment metadata or fetch subscription details
          // For now, we'll keep the existing plan but ensure quota is set correctly
          // The plan will be updated when subscription.created/updated events arrive
          
          await paymentUser.save();
          
          await Audit.logUsage({
            userId: paymentUser.id,
            type: 'subscription_change',
            action: 'payment_succeeded',
            resourceType: 'user',
            details: {
              subscriptionId: paymentSubId,
              paymentId: succeededPayment.id,
              amount: succeededPayment.amount,
              currency: succeededPayment.currency,
              status: 'active'
            }
          });
          logger.info('Payment succeeded via webhook', { userId: paymentUser.id, subscriptionId: paymentSubId, amount: succeededPayment.amount });
        }
      }
      break;

    default:
      logger.debug('Unhandled Dodo webhook event', { type: event.type });
  }

  res.status(200).send('OK');
}));

export default router;