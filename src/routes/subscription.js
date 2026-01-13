import express from 'express';
import DodoPayments from 'dodopayments';
import { requireAuth } from '../config/passport.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

/**
 * @swagger
 * tags:
 *   name: Subscription
 *   description: User subscription and plan management
 */

const router = express.Router();
const logger = createLogger('subscription-routes');

// Initialize Dodo Payments client lazily
let dodoClient = null;
function getDodoClient() {
  if (!dodoClient) {
    const apiKey = process.env.DODO_PAYMENTS_API_KEY;
    if (!apiKey) {
      throw new Error('DODO_PAYMENTS_API_KEY environment variable is missing');
    }
    const environment = process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode';
    dodoClient = new DodoPayments({ bearerToken: apiKey, environment });
  }
  return dodoClient;
}

/**
 * @swagger
 * /api/v1/subscription/details:
 *   get:
 *     summary: Get user subscription details
 *     description: Returns the authenticated user's subscription plan, trial status, and usage information
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscription:
 *                   type: object
 *                   properties:
 *                     plan:
 *                       type: string
 *                       enum: [free, basic, premium, pro]
 *                     status:
 *                       type: string
 *                       enum: [active, canceled, past_due, trialing]
 *                     trialStatus:
 *                       type: object
 *                       properties:
 *                         hasTrialRemaining:
 *                           type: boolean
 *                         trialUsed:
 *                           type: boolean
 *                         trialEndsAt:
 *                           type: string
 *                           format: date-time
 *                         daysRemaining:
 *                           type: number
 *                     usage:
 *                       type: object
 *                       properties:
 *                         used:
 *                           type: number
 *                         limit:
 *                           type: number
 *                         remaining:
 *                           type: number
 *                     resetDate:
 *                       type: string
 *                       format: date-time
 *                     currentPeriodEnd:
 *                       type: string
 *                       format: date-time
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/details', requireAuth(), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const subscriptionDetails = user.getSubscriptionDetails();

  res.json({
    subscription: subscriptionDetails
  });
}));

/**
 * @swagger
 * /api/v1/subscription/plans:
 *   get:
 *     summary: Get available subscription plans
 *     description: Returns all available subscription plans with pricing and features
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Plans retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 plans:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         enum: [free, basic, premium, pro]
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       price:
 *                         type: object
 *                         properties:
 *                           monthly:
 *                             type: number
 *                           yearly:
 *                             type: number
 *                       features:
 *                         type: array
 *                         items:
 *                           type: string
 *                       monthlyRequests:
 *                         type: number
 *                       popular:
 *                         type: boolean
 */
router.get('/plans', requireAuth(), asyncHandler(async (req, res) => {
  const plans = [
    {
      id: 'free',
      name: 'Free',
      description: 'Perfect for trying out SwapMyLook with 1 free trial image',
      price: { monthly: 0, yearly: 0 },
      features: [
        '1 free outfit visualization',
        'Basic model selection',
        'Standard quality renders',
        'Community support',
        'Watermarked downloads'
      ],
      monthlyRequests: 1,
      popular: false
    },
    {
      id: 'basic',
      name: 'Basic',
      description: 'For casual users who want more flexibility',
      price: { monthly: 9, yearly: 90 },
      features: [
        '10 outfit visualizations per month',
        'Full outfit library access',
        'HD quality renders',
        'Basic editing tools',
        'Watermark-free downloads',
        'Email support'
      ],
      monthlyRequests: 10,
      popular: false
    },
    {
      id: 'premium',
      name: 'Premium',
      description: 'For fashion enthusiasts and influencers',
      price: { monthly: 19, yearly: 190 },
      features: [
        '50 outfit visualizations per month',
        'Full outfit library access',
        'HD quality renders',
        'Advanced editing tools',
        'Watermark-free downloads',
        'Priority customer support',
        'Style trend insights',
        'Custom model uploads'
      ],
      monthlyRequests: 50,
      popular: true
    },
    {
      id: 'pro',
      name: 'Pro',
      description: 'For professional fashion creators and businesses',
      price: { monthly: 49, yearly: 490 },
      features: [
        '100 outfit visualizations per month',
        'Full outfit library access',
        '4K quality renders',
        'Advanced editing tools',
        'Watermark-free downloads',
        'Priority customer support',
        'Style trend insights',
        'Custom model uploads',
        'API access',
        'Advanced analytics'
      ],
      monthlyRequests: 100,
      popular: false
    }
  ];

  res.json({ plans });
}));

/**
 * @swagger
 * /api/v1/subscription/upgrade:
 *   post:
 *     summary: Upgrade user subscription plan
 *     description: Upgrade the authenticated user's subscription to a new plan
 *     tags: [Subscription]
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
 *             properties:
 *               plan:
 *                 type: string
 *                 enum: [basic, premium, pro]
 *                 description: The plan to upgrade to
 *               billingCycle:
 *                 type: string
 *                 enum: [monthly, yearly]
 *                 default: monthly
 *                 description: Billing cycle for the subscription
 *     responses:
 *       200:
 *         description: Subscription upgraded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 subscription:
 *                   type: object
 *                   properties:
 *                     plan:
 *                       type: string
 *                     status:
 *                       type: string
 *                     usage:
 *                       type: object
 *       400:
 *         description: Bad request - invalid plan or already on this plan
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
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/upgrade', requireAuth(), asyncHandler(async (req, res) => {
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

  // Update user plan and subscription status
  user.plan = plan;
  user.subscription.status = 'active';
  
  // Set current period end based on billing cycle
  const now = new Date();
  if (billingCycle === 'yearly') {
    user.subscription.currentPeriodEnd = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  } else {
    user.subscription.currentPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  // Update quota based on new plan
  const planQuotas = {
    'basic': 10,
    'premium': 50,
    'pro': 100
  };
  user.quota.monthlyRequests = planQuotas[plan];

  await user.save();

  // Log subscription upgrade
  await Audit.logUsage({
    userId: user.id,
    type: 'subscription',
    action: 'plan_upgraded',
    resourceType: 'subscription',
    details: {
      fromPlan: req.user.plan,
      toPlan: plan,
      billingCycle,
      newQuota: user.quota.monthlyRequests
    }
  });

  logger.info('Subscription upgraded', {
    userId: user.id,
    fromPlan: req.user.plan,
    toPlan: plan,
    billingCycle
  });

  const subscriptionDetails = user.getSubscriptionDetails();

  res.json({
    message: `Successfully upgraded to ${plan} plan`,
    subscription: subscriptionDetails
  });
}));

/**
 * @swagger
 * /api/v1/subscription/cancel:
 *   post:
 *     summary: Cancel user subscription
 *     description: Cancel the authenticated user's subscription and downgrade to free plan
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 subscription:
 *                   type: object
 *                   properties:
 *                     plan:
 *                       type: string
 *                     status:
 *                       type: string
 *       400:
 *         description: Bad request - already on free plan
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
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/cancel', requireAuth(), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Check if user is already on free plan
  if (user.plan === 'free') {
    throw new ValidationError('You are already on the free plan');
  }

  const previousPlan = user.plan;
  
  // Downgrade to free plan
  user.plan = 'free';
  user.subscription.status = 'canceled';
  user.quota.monthlyRequests = 1;
  user.quota.usedThisMonth = 0; // Reset usage for free plan

  await user.save();

  // Log subscription cancellation
  await Audit.logUsage({
    userId: user.id,
    type: 'subscription',
    action: 'plan_cancelled',
    resourceType: 'subscription',
    details: {
      fromPlan: previousPlan,
      toPlan: 'free'
    }
  });

  logger.info('Subscription cancelled', {
    userId: user.id,
    fromPlan: previousPlan,
    toPlan: 'free'
  });

  const subscriptionDetails = user.getSubscriptionDetails();

  res.json({
    message: 'Subscription cancelled successfully. You have been downgraded to the free plan.',
    subscription: subscriptionDetails
  });
}));

/**
 * @swagger
 * /api/v1/subscription/usage:
 *   get:
 *     summary: Get current usage statistics
 *     description: Returns the authenticated user's current usage statistics and quota information
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Usage statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 usage:
 *                   type: object
 *                   properties:
 *                     used:
 *                       type: number
 *                     limit:
 *                       type: number
 *                     remaining:
 *                       type: number
 *                     percentageUsed:
 *                       type: number
 *                 trialStatus:
 *                   type: object
 *                   properties:
 *                     hasTrialRemaining:
 *                       type: boolean
 *                     trialUsed:
 *                       type: boolean
 *                     trialEndsAt:
 *                       type: string
 *                       format: date-time
 *                     daysRemaining:
 *                       type: number
 *                 resetDate:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/usage', requireAuth(), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const subscriptionDetails = user.getSubscriptionDetails();
  const percentageUsed = (subscriptionDetails.usage.used / subscriptionDetails.usage.limit) * 100;

  res.json({
    usage: {
      ...subscriptionDetails.usage,
      percentageUsed: Math.round(percentageUsed)
    },
    trialStatus: subscriptionDetails.trialStatus,
    resetDate: subscriptionDetails.resetDate
  });
}));

export default router;
/**
 * @swagger
 * /api/v1/subscription/change-plan:
 *   post:
 *     summary: Change user subscription plan
 *     description: Change the authenticated user's subscription to a different plan with proration
 *     tags: [Subscription]
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
 *             properties:
 *               plan:
 *                 type: string
 *                 enum: [basic, premium, pro]
 *                 description: The plan to change to
 *               prorationOption:
 *                 type: string
 *                 enum: [prorated_immediately, full_immediately, difference_immediately]
 *                 default: prorated_immediately
 *                 description: How to handle proration for the plan change
 *     responses:
 *       200:
 *         description: Plan changed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 subscription:
 *                   type: object
 *       400:
 *         description: Bad request - invalid plan or no active subscription
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
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error changing plan
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/change-plan', requireAuth(), asyncHandler(async (req, res) => {
  const { plan, prorationOption = 'prorated_immediately' } = req.body;

  if (!plan || !['basic', 'premium', 'pro'].includes(plan)) {
    throw new ValidationError('Valid plan (basic, premium, or pro) is required');
  }

  if (!['prorated_immediately', 'full_immediately', 'difference_immediately'].includes(prorationOption)) {
    throw new ValidationError('Valid proration option is required');
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Check if user has an active Dodo subscription
  if (!user.subscription.dodoSubscriptionId || user.subscription.status !== 'active') {
    throw new ValidationError('No active subscription found to change');
  }

  // Check if user is already on this plan
  if (user.plan === plan) {
    throw new ValidationError(`You are already on the ${plan} plan`);
  }

  // Map plan to Dodo product ID
  const getProductId = (plan) => {
    const envVar = `DODO_PRODUCT_${plan.toUpperCase()}`;
    const productId = process.env[envVar];
    if (!productId) {
      throw new ValidationError(`Product not configured for ${plan}`);
    }
    return productId;
  };

  const newProductId = getProductId(plan);

  try {
    // Call Dodo change plan API
    const changeResult = await getDodoClient().subscriptions.changePlan(user.subscription.dodoSubscriptionId, {
      product_id: newProductId,
      proration: prorationOption
    });

    // Update user plan locally (will be confirmed via webhook)
    const oldPlan = user.plan;
    user.plan = plan;

    // Update quota based on new plan
    const planQuotas = {
      'basic': 10,
      'premium': 50,
      'pro': 100
    };
    user.quota.monthlyRequests = planQuotas[plan];

    await user.save();

    // Log plan change
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription',
      action: 'plan_changed',
      resourceType: 'subscription',
      details: {
        fromPlan: oldPlan,
        toPlan: plan,
        prorationOption,
        dodoSubscriptionId: user.subscription.dodoSubscriptionId
      }
    });

    logger.info('Plan change initiated', {
      userId: user.id,
      fromPlan: oldPlan,
      toPlan: plan,
      prorationOption,
      dodoSubscriptionId: user.subscription.dodoSubscriptionId
    });

    const subscriptionDetails = user.getSubscriptionDetails();

    res.json({
      message: `Plan change to ${plan} initiated successfully. Changes will be applied once payment is processed.`,
      subscription: subscriptionDetails
    });
  } catch (error) {
    logger.error('Failed to change plan', {
      userId: user.id,
      error: error.message,
      stack: error.stack
    });
    throw new Error(`Unable to change plan: ${error.message}`);
  }
}));


/**
 * @swagger
 * /api/v1/subscription/reactivate:
 *   post:
 *     summary: Reactivate a cancelled subscription
 *     description: Reactivate the authenticated user's cancelled subscription
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription reactivation initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 subscription:
 *                   type: object
 *       400:
 *         description: Bad request - no cancelled subscription found
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
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error reactivating subscription
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/reactivate', requireAuth(), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Check if user has a cancelled Dodo subscription
  if (!user.subscription.dodoSubscriptionId || user.subscription.status !== 'canceled') {
    throw new ValidationError('No cancelled subscription found to reactivate');
  }

  try {
    // Call Dodo to reactivate the subscription
    const reactivationResult = await getDodoClient().subscriptions.reactivate(user.subscription.dodoSubscriptionId);

    // Update user subscription status locally (will be confirmed via webhook)
    user.subscription.status = 'active';

    await user.save();

    // Log reactivation
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription',
      action: 'subscription_reactivated',
      resourceType: 'subscription',
      details: {
        dodoSubscriptionId: user.subscription.dodoSubscriptionId
      }
    });

    logger.info('Subscription reactivation initiated', {
      userId: user.id,
      dodoSubscriptionId: user.subscription.dodoSubscriptionId
    });

    const subscriptionDetails = user.getSubscriptionDetails();

    res.json({
      message: 'Subscription reactivation initiated successfully. Your subscription will be restored once payment is processed.',
      subscription: subscriptionDetails
    });
  } catch (error) {
    logger.error('Failed to reactivate subscription', {
      userId: user.id,
      error: error.message,
      stack: error.stack
    });
    throw new Error(`Unable to reactivate subscription: ${error.message}`);
  }
}));

/**
 * @swagger
 * /api/v1/subscription/update-payment-method:
 *   post:
 *     summary: Update payment method for on_hold subscription
 *     description: Update payment method for a subscription that is on hold due to payment failure
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [new, existing]
 *                 default: new
 *                 description: Type of payment method update - 'new' for new payment method, 'existing' for existing payment method ID
 *               payment_method_id:
 *                 type: string
 *                 description: Existing payment method ID (required if type is 'existing')
 *               return_url:
 *                 type: string
 *                 description: URL to redirect after payment method update (required if type is 'new')
 *     responses:
 *       200:
 *         description: Payment method update initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 payment_link:
 *                   type: string
 *                   description: URL to redirect user to complete payment method update
 *                 payment_id:
 *                   type: string
 *                   description: ID of the charge created for remaining dues
 *       400:
 *         description: Bad request - subscription not on hold or missing parameters
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
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error updating payment method
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/update-payment-method', requireAuth(), asyncHandler(async (req, res) => {
  const { type = 'new', payment_method_id, return_url } = req.body;
  
  if (!['new', 'existing'].includes(type)) {
    throw new ValidationError('Type must be either "new" or "existing"');
  }
  
  if (type === 'existing' && !payment_method_id) {
    throw new ValidationError('payment_method_id is required when type is "existing"');
  }
  
  if (type === 'new' && !return_url) {
    throw new ValidationError('return_url is required when type is "new"');
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Check if user has a subscription on hold
  if (!user.subscription.dodoSubscriptionId || user.subscription.status !== 'past_due') {
    throw new ValidationError('No subscription on hold found to update payment method');
  }

  try {
    // Prepare update payload based on type
    const updatePayload = { type };
    if (type === 'existing') {
      updatePayload.payment_method_id = payment_method_id;
    } else {
      updatePayload.return_url = return_url;
    }

    // Call Dodo Update Payment Method API
    const updateResult = await getDodoClient().subscriptions.updatePaymentMethod(
      user.subscription.dodoSubscriptionId,
      updatePayload
    );

    // Log payment method update
    await Audit.logUsage({
      userId: user.id,
      type: 'subscription',
      action: 'payment_method_update_initiated',
      resourceType: 'subscription',
      details: {
        dodoSubscriptionId: user.subscription.dodoSubscriptionId,
        type,
        paymentId: updateResult.payment_id,
        paymentLink: updateResult.payment_link
      }
    });

    logger.info('Payment method update initiated', {
      userId: user.id,
      subscriptionId: user.subscription.dodoSubscriptionId,
      type
    });

    // Return response with payment link if available
    const response = {
      message: 'Payment method update initiated successfully.',
      payment_id: updateResult.payment_id
    };
    
    if (updateResult.payment_link) {
      response.payment_link = updateResult.payment_link;
      response.message += ' Redirect user to the payment link to complete the update.';
    }

    res.json(response);
  } catch (error) {
    logger.error('Failed to update payment method', {
      userId: user.id,
      error: error.message,
      stack: error.stack
    });
    throw new Error(`Unable to update payment method: ${error.message}`);
  }
}));
