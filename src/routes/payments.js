import express from 'express';
import DodoPayments from 'dodopayments';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('payments-routes');

// Initialize Dodo Payments client lazily
let client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.DODO_PAYMENTS_API_KEY;
    if (!apiKey) {
      throw new Error('DODO_PAYMENTS_API_KEY environment variable is missing');
    }
    client = new DodoPayments({ bearerToken: apiKey });
  }
  return client;
}

/**
 * @swagger
 * tags:
 *   name: Payments
 *   description: Payment and checkout session management
 */

/**
 * @swagger
 * /api/v1/payments/create-checkout-session:
 *   post:
 *     summary: Create a checkout session for subscription upgrade
 *     description: Creates a Dodo Payments checkout session for the specified plan and redirects user to hosted checkout.
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - plan
 *               - billingCycle
 *             properties:
 *               plan:
 *                 type: string
 *                 enum: [basic, premium, pro]
 *                 description: The plan to subscribe to
 *               billingCycle:
 *                 type: string
 *                 enum: [monthly, yearly]
 *                 default: monthly
 *                 description: Billing cycle for the subscription
 *     responses:
 *       200:
 *         description: Checkout session created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                   description: The URL to redirect the user to for payment
 *       400:
 *         description: Invalid plan or missing parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error creating checkout session
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/create-checkout-session', requireAuth(), asyncHandler(async (req, res) => {
  const { plan, billingCycle = 'monthly' } = req.body;

  if (!plan || !['basic', 'premium', 'pro'].includes(plan)) {
    throw new ValidationError('Valid plan (basic, premium, or pro) is required');
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Check if user is already on this plan
  if (user.plan === plan) {
    throw new ValidationError(`You are already on the ${plan} plan`);
  }

  // Map plan and billing cycle to Dodo product ID
  const getProductId = (plan, billingCycle) => {
    const suffix = billingCycle === 'yearly' ? '_YEARLY' : '';
    const envVar = `DODO_PRODUCT_${plan.toUpperCase()}${suffix}`;
    const productId = process.env[envVar];
    if (!productId) {
      throw new ValidationError(`Product not configured for ${plan} (${billingCycle})`);
    }
    return productId;
  };

  const productId = getProductId(plan, billingCycle);

  // Determine return URL (where Dodo redirects after checkout)
  const returnUrl = `${process.env.APP_URL}/api/v1/payments/billing/return`;
  // You can also set a success/cancel URL via Dodo's checkout session parameters if needed

  try {
    const session = await getClient().checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      return_url: returnUrl,
      subscription_data: {
        // Optionally set trial_period_days if you want to override
      },
      metadata: {
        app_user_id: String(user.id),
        plan,
        billingCycle
      }
    });

    // Log the checkout session creation
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription_change',
      action: 'checkout_session_created',
      resourceType: 'user',
      details: {
        plan,
        billingCycle,
        sessionId: session.session_id,
        url: session.checkout_url
      }
    });

    logger.info('Checkout session created', {
      userId: user.id,
      plan,
      billingCycle,
      sessionId: session.session_id
    });

    res.json({ url: session.checkout_url });
  } catch (error) {
    logger.error('Failed to create checkout session', {
      userId: user.id,
      error: error.message,
      stack: error.stack
    });
    // Include error details in development for debugging
    const isDev = process.env.NODE_ENV === 'development';
    const message = isDev ? `Unable to create checkout session: ${error.message}` : 'Unable to create checkout session';
    res.status(500).json({ error: message });
  }
}));

/**
* @swagger
* /billing/return:
*   get:
*     summary: Handle Dodo Payments return URL
*     description: Redirects user back to frontend after payment completion with subscription status.
*     tags: [Payments]
*     parameters:
*       - in: query
*         name: subscription_id
*         schema:
*           type: string
*         description: Dodo subscription ID
*       - in: query
*         name: status
*         schema:
*           type: string
*           enum: [pending, active, canceled, past_due]
*         description: Subscription status after payment
*     responses:
*       302:
*         description: Redirects to frontend subscription page with status
*         headers:
*           Location:
*             schema:
*               type: string
*               format: uri
*             description: Redirect URL to frontend
*/
router.get('/billing/return', asyncHandler(async (req, res) => {
const { subscription_id: subscriptionId, status = 'pending' } = req.query;

logger.info('Payment return URL called', { subscriptionId, status });

// Optionally fetch subscription details from Dodo to verify
// For now, just redirect to frontend with the same parameters
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
const params = new URLSearchParams();
if (subscriptionId) params.append('subscription_id', subscriptionId);
params.append('status', status);
const redirectUrl = `${frontendUrl}/subscription?${params.toString()}`;

// Log the redirect for auditing
await Audit.logUsage({
  type: 'subscription_change',
  action: 'payment_return_redirect',
  details: {
    subscriptionId,
    status,
    redirectUrl
  }
});

res.redirect(redirectUrl);
}));

export default router;