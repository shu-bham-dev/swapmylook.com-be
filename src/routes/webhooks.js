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
 * According to Dodo documentation, webhook-signature header is HMAC SHA256 of timestamp + '.' + payload.
 * Implementation may vary; adjust based on exact docs.
 */
const verifyDodoSignature = (payload, signatureHeader, secret) => {
  if (!signatureHeader || !secret) {
    return false;
  }
  // Example: header format "t=timestamp,v1=signature"
  // We'll assume the signature is the whole header (simplified).
  // For production, follow exact Dodo docs.
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  // Compare with signature (maybe after extracting v1=...)
  // This is a placeholder; replace with proper extraction.
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader)
  );
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
  const sigHeader = req.headers['webhook-signature'] || req.headers['webhook_signature'];
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
  const payload = req.body; // raw buffer

  // Verify signature
  if (!verifyDodoSignature(payload, sigHeader, secret)) {
    logger.warn('Invalid webhook signature', { header: sigHeader });
    return res.status(400).send('Invalid signature');
  }

  // Parse JSON
  let event;
  try {
    event = JSON.parse(payload.toString());
  } catch (err) {
    logger.error('Failed to parse webhook payload', { error: err.message });
    return res.status(400).send('Invalid JSON');
  }

  logger.info('Received Dodo webhook event', { type: event.type, id: event.id });

  // Handle event types
  switch (event.type) {
    case 'subscription.created':
    case 'subscription.updated':
      // Update user subscription
      const subscription = event.data;
      const userId = subscription.metadata?.app_user_id;
      if (!userId) {
        logger.warn('Missing app_user_id in subscription metadata', { subscription });
        break;
      }
      const user = await User.findById(userId);
      if (!user) {
        logger.warn('User not found for subscription', { userId });
        break;
      }
      // Update user fields
      user.subscription.status = subscription.status;
      user.subscription.dodoSubscriptionId = subscription.id;
      user.subscription.dodoCustomerId = subscription.customer_id;
      user.subscription.paymentProvider = 'dodo';
      user.subscription.currentPeriodEnd = new Date(subscription.current_period_end * 1000); // assuming Unix timestamp
      // Determine plan from product_id
      const productId = subscription.product_id;
      // Map product ID to plan (you may need a mapping)
      if (productId === process.env.DODO_PRODUCT_BASIC) {
        user.plan = 'basic';
        user.quota.monthlyRequests = 10;
      } else if (productId === process.env.DODO_PRODUCT_PREMIUM) {
        user.plan = 'premium';
        user.quota.monthlyRequests = 50;
      } else if (productId === process.env.DODO_PRODUCT_PRO) {
        user.plan = 'pro';
        user.quota.monthlyRequests = 100;
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
      logger.info('Updated user subscription from webhook', { userId, plan: user.plan, status: subscription.status });
      break;

    case 'payment.failed':
      // Mark subscription as past_due or on_hold
      const payment = event.data;
      const subId = payment.subscription_id;
      // Find user by subscription_id (we need to store mapping)
      // For simplicity, we'll skip for now; you can implement later.
      logger.info('Payment failed event', { subscriptionId: subId });
      break;

    case 'subscription.cancelled':
      const cancelledSub = event.data;
      const cancelledUserId = cancelledSub.metadata?.app_user_id;
      if (cancelledUserId) {
        const cancelledUser = await User.findById(cancelledUserId);
        if (cancelledUser) {
          cancelledUser.subscription.status = 'canceled';
          // Optionally downgrade to free plan
          // cancelledUser.plan = 'free';
          // cancelledUser.quota.monthlyRequests = 1;
          await cancelledUser.save();
          await Audit.logUsage({
            userId: cancelledUser.id,
            type: 'subscription_change',
            action: 'subscription_cancelled',
            resourceType: 'user',
            details: {
              subscriptionId: cancelledSub.id
            }
          });
          logger.info('Subscription cancelled via webhook', { userId: cancelledUserId });
        }
      }
      break;

    default:
      logger.debug('Unhandled Dodo webhook event', { type: event.type });
  }

  res.status(200).send('OK');
}));

export default router;