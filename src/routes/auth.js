import express from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';
import { generateJWTToken, verifyGoogleToken } from '../config/passport.js';
import { requireAuth } from '../config/passport.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

/**
 * @swagger
 * tags:
 *   name: Authentication
 *   description: User authentication and authorization endpoints
 */

const router = express.Router();
const logger = createLogger('auth-routes');

/**
 * @swagger
 * /api/v1/auth/google/url:
 *   get:
 *     summary: Get Google OAuth URL
 *     description: Returns the URL to redirect users to for Google OAuth authentication
 *     tags: [Authentication]
 *     responses:
 *       200:
 *         description: Google OAuth URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                   format: uri
 *                   description: Google OAuth authorization URL
 *                   example: "https://accounts.google.com/o/oauth2/v2/auth?client_id=..."
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/google/url', authRateLimiter, (req, res) => {
  const callbackURL = process.env.GOOGLE_CALLBACK_URL || '/api/v1/auth/google/callback';
  const authURL = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(`${process.env.APP_URL}${callbackURL}`)}&` +
    `response_type=code&` +
    `scope=profile email&` +
    `access_type=offline&` +
    `prompt=consent`;

  res.json({ url: authURL });
});

/**
 * @swagger
 * /api/v1/auth/google/callback:
 *   get:
 *     summary: Google OAuth callback
 *     description: Callback endpoint for Google OAuth authentication - handled by Passport.js
 *     tags: [Authentication]
 *     parameters:
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *         required: true
 *         description: Authorization code from Google
 *       - in: query
 *         name: error
 *         schema:
 *           type: string
 *         description: Error code if authentication failed
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: State parameter for CSRF protection
 *     responses:
 *       302:
 *         description: Redirects to frontend with token or error
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               format: uri
 *             description: Redirect URL to frontend
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/google/callback', authRateLimiter, (req, res, next) => {
  passport.authenticate('google', { session: false }, async (err, user, info) => {
    try {
      if (err) {
        logger.error('Google OAuth callback error', { error: err.message });
        return res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
      }

      if (!user) {
        logger.warn('Google OAuth callback - no user', { info });
        return res.redirect(`${process.env.FRONTEND_URL}/login?error=no_user`);
      }

      // Generate JWT token
      const token = generateJWTToken(user);

      // Log successful authentication
      await Audit.logUsage({
        userId: user.id,
        type: 'login',
        action: 'google_oauth_success',
        details: {
          method: 'GET',
          endpoint: '/auth/google/callback',
          statusCode: 200
        }
      });

      // Redirect to frontend with token
      res.redirect(`${process.env.FRONTEND_URL}/auth/success?token=${token}&userId=${user.id}`);
    } catch (error) {
      logger.error('Error in Google OAuth callback', { error: error.message });
      res.redirect(`${process.env.FRONTEND_URL}/login?error=server_error`);
    }
  })(req, res, next);
});

/**
 * @swagger
 * /api/v1/auth/google/token:
 *   post:
 *     summary: Authenticate with Google ID token
 *     description: Authenticate using Google ID token - for mobile apps and server-side auth
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - idToken
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Google ID token from client-side authentication
 *                 example: "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ..."
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT token for API authentication
 *                 user:
 *                   $ref: '#/components/schemas/UserProfile'
 *       400:
 *         description: Bad request - ID token is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Google authentication failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/google/token', authRateLimiter, asyncHandler(async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: 'Google ID token is required' });
  }

  try {
    // Verify Google token
    const googleUser = await verifyGoogleToken(idToken);

    // Find or create user
    const user = await User.findOneAndUpdate(
      { googleId: googleUser.googleId },
      {
        $set: {
          email: googleUser.email,
          name: googleUser.name,
          avatarUrl: googleUser.avatarUrl,
          lastLogin: new Date()
        },
        $setOnInsert: {
          googleId: googleUser.googleId,
          plan: 'free'
        }
      },
      { upsert: true, new: true }
    );

    // Generate JWT token
    const token = generateJWTToken(user);

    // Log successful authentication
    await Audit.logUsage({
      userId: user.id,
      type: 'login',
      action: 'google_token_success',
      details: {
        method: 'POST',
        endpoint: '/auth/google/token',
        statusCode: 200
      }
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        plan: user.plan,
        quota: user.quota
      }
    });
  } catch (error) {
    logger.error('Google token authentication failed', { error: error.message });
    
    await Audit.logUsage({
      type: 'login',
      action: 'google_token_failed',
      details: {
        method: 'POST',
        endpoint: '/auth/google/token',
        statusCode: 401,
        error: error.message
      },
      isSuccess: false
    });

    res.status(401).json({ error: 'Google authentication failed' });
  }
}));

/**
 * @swagger
 * /api/v1/auth/me:
 *   get:
 *     summary: Get current user profile
 *     description: Returns the authenticated user's profile information including quota details
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/UserProfile'
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
router.get('/me', requireAuth(), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      plan: user.plan,
      quota: user.quota,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt
    }
  });
}));

/**
 * @swagger
 * /api/v1/auth/refresh:
 *   post:
 *     summary: Refresh JWT token
 *     description: Generate a new JWT token using the current valid token
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: New JWT token
 *                 user:
 *                   $ref: '#/components/schemas/UserProfile'
 *       401:
 *         description: Unauthorized - invalid or expired token
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
router.post('/refresh', requireAuth(), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Generate new token
  const token = generateJWTToken(user);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      plan: user.plan
    }
  });
}));

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Logout user
 *     description: Logout endpoint - client should discard the token
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Logged out successfully"
 *       401:
 *         description: Unauthorized - invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/logout', requireAuth(), asyncHandler(async (req, res) => {
  // Log logout action
  await Audit.logUsage({
    userId: req.user.id,
    type: 'login',
    action: 'logout',
    details: {
      method: 'POST',
      endpoint: '/auth/logout',
      statusCode: 200
    }
  });

  res.json({ message: 'Logged out successfully' });
}));

/**
 * @swagger
 * /api/v1/auth/quota:
 *   get:
 *     summary: Get user quota information
 *     description: Returns the user's current usage quota and remaining requests
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Quota information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 monthlyRequests:
 *                   type: integer
 *                   description: Total monthly requests allowed
 *                   example: 100
 *                 usedThisMonth:
 *                   type: integer
 *                   description: Number of requests used this month
 *                   example: 25
 *                 remaining:
 *                   type: integer
 *                   description: Remaining requests this month
 *                   example: 75
 *                 resetDate:
 *                   type: string
 *                   format: date-time
 *                   description: Date when quota will reset
 *                 hasQuota:
 *                   type: boolean
 *                   description: Whether user has available quota
 *                   example: true
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
router.get('/quota', requireAuth(), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Check if quota needs reset (new month)
  const hasQuota = user.hasAvailableQuota();

  res.json({
    monthlyRequests: user.quota.monthlyRequests,
    usedThisMonth: user.quota.usedThisMonth,
    remaining: Math.max(0, user.quota.monthlyRequests - user.quota.usedThisMonth),
    resetDate: user.quota.resetDate,
    hasQuota
  });
}));

/**
 * @swagger
 * /api/v1/auth/test-token:
 *   post:
 *     summary: Test JWT token validity
 *     description: Validate a JWT token and return user information if valid
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *                 description: JWT token to validate
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: Token validation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                   description: Whether the token is valid
 *                   example: true
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: objectid
 *                     email:
 *                       type: string
 *                     name:
 *                       type: string
 *                     plan:
 *                       type: string
 *                       enum: [free, pro]
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                   description: Token expiration date
 *                 error:
 *                   type: string
 *                   description: Error message if token is invalid
 *       400:
 *         description: Bad request - token is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/test-token', authRateLimiter, asyncHandler(async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'swapmylook-api',
      audience: 'swapmylook-client'
    });

    // Check if user exists and is active
    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ valid: false, error: 'User not found or inactive' });
    }

    res.json({
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan
      },
      expiresAt: new Date(decoded.exp * 1000)
    });
  } catch (error) {
    res.json({
      valid: false,
      error: error.message
    });
  }
}));

/**
 * @swagger
 * /api/v1/auth/demo:
 *   post:
 *     summary: Demo authentication for testing
 *     description: Creates a demo user for testing without Google OAuth
 *     tags: [Authentication]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 description: Optional email for demo user
 *                 example: "demo@swapmylook.com"
 *     responses:
 *       200:
 *         description: Demo authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT token for API authentication
 *                 user:
 *                   $ref: '#/components/schemas/UserProfile'
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/demo', authRateLimiter, asyncHandler(async (req, res) => {
  const { email = 'demo@swapmylook.com' } = req.body;
  
  try {
    // Create or find demo user
    const demoUser = await User.findOneAndUpdate(
      { email },
      {
        $set: {
          name: 'Demo User',
          avatarUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&h=150&fit=crop&crop=face',
          lastLogin: new Date(),
          plan: 'free',
          isActive: true
        },
        $setOnInsert: {
          email,
          googleId: `demo-${Date.now()}`,
          quota: {
            monthlyRequests: 100,
            usedThisMonth: 0,
            resetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
          }
        }
      },
      { upsert: true, new: true }
    );

    // Generate JWT token
    const token = generateJWTToken(demoUser);

    // Log demo authentication
    await Audit.logUsage({
      userId: demoUser._id,
      type: 'login',
      action: 'demo_auth_success',
      details: {
        method: 'POST',
        endpoint: '/auth/demo',
        statusCode: 200
      }
    });

    res.json({
      token,
      user: {
        id: demoUser.id,
        email: demoUser.email,
        name: demoUser.name,
        avatarUrl: demoUser.avatarUrl,
        plan: demoUser.plan,
        quota: demoUser.quota
      }
    });
  } catch (error) {
    logger.error('Demo authentication failed', { error: error.message });
    
    await Audit.logUsage({
      type: 'login',
      action: 'demo_auth_failed',
      details: {
        method: 'POST',
        endpoint: '/auth/demo',
        statusCode: 500,
        error: error.message
      },
      isSuccess: false
    });

    res.status(500).json({ error: 'Demo authentication failed' });
  }
}));

export default router;