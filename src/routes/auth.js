import express from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { generateJWTToken, verifyGoogleToken } from '../config/passport.js';
import { requireAuth } from '../config/passport.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import User from '../models/User.js';
import OTP from '../models/OTP.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';
import { emailService } from '../services/emailService.js';

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
  // Determine the full redirect URI
  let redirectUri;
  if (callbackURL.startsWith('http://') || callbackURL.startsWith('https://')) {
    // Already a full URL
    redirectUri = callbackURL;
  } else {
    // Relative path, prepend APP_URL
    redirectUri = `${process.env.APP_URL}${callbackURL}`;
  }
  const authURL = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
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
 * /api/v1/auth/signup:
 *   post:
 *     summary: Initiate signup process by sending OTP
 *     description: Register a new user by sending OTP to email for verification
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - name
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email address
 *                 example: "user@example.com"
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User's password (min 8 characters with complexity)
 *                 example: "SecurePass123!"
 *               name:
 *                 type: string
 *                 description: User's full name
 *                 example: "John Doe"
 *     responses:
 *       200:
 *         description: OTP sent successfully for email verification
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "OTP sent successfully"
 *                 expiresIn:
 *                   type: integer
 *                   description: OTP expiration time in minutes
 *                   example: 10
 *       400:
 *         description: Bad request - missing or invalid fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: User already exists
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
router.post('/signup', authRateLimiter, asyncHandler(async (req, res) => {
  const { email, password, name } = req.body;

  // Validate required fields
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' });
  }

  // Password validation
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  // Password strength validation
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

  if (!hasUpperCase || !hasLowerCase || !hasNumbers || !hasSpecialChar) {
    return res.status(400).json({
      error: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'
    });
  }

  // Common password check (basic)
  const commonPasswords = ['password', '123456', 'qwerty', 'letmein', 'welcome'];
  if (commonPasswords.includes(password.toLowerCase())) {
    return res.status(400).json({ error: 'Password is too common, please choose a stronger password' });
  }

  try {
    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Create or update OTP record
    await OTP.findOneAndUpdate(
      { email: email.toLowerCase(), purpose: 'signup' },
      {
        code: otp,
        expiresAt,
        attempts: 0,
        verified: false,
        metadata: { name, password }
      },
      { upsert: true, new: true }
    );

    // Send OTP via email
    await emailService.sendOTPEmail(email, otp, 'signup', name);

    // Log OTP sent
    await Audit.logUsage({
      type: 'signup',
      action: 'otp_signup_initiated',
      details: {
        method: 'POST',
        endpoint: '/auth/signup',
        statusCode: 200,
        email
      }
    });

    res.json({
      message: 'OTP sent successfully',
      expiresIn: 10
    });
  } catch (error) {
    logger.error('Signup OTP sending failed', { error: error.message, email });
    res.status(500).json({ error: 'Failed to send OTP for signup' });
  }
}));

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Login with email and password
 *     description: Authenticate user with email and password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email address
 *                 example: "user@example.com"
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User's password
 *                 example: "password123"
 *               rememberMe:
 *                 type: boolean
 *                 description: Whether to remember the user across sessions (longer token expiration)
 *                 example: false
 *     responses:
 *       200:
 *         description: Login successful
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
 *         description: Bad request - missing email or password
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid credentials
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
router.post('/login', authRateLimiter, asyncHandler(async (req, res) => {
  const { email, password, rememberMe = false } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Find existing user by email, include passwordHash
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password hash
    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      // Log failed login attempt
      await Audit.logUsage({
        type: 'login',
        action: 'email_login_failed',
        details: {
          method: 'POST',
          endpoint: '/auth/login',
          statusCode: 401,
          error: 'Invalid password'
        },
        isSuccess: false
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate JWT token with rememberMe
    const token = generateJWTToken(user, rememberMe);

    // Log successful login
    await Audit.logUsage({
      userId: user._id,
      type: 'login',
      action: 'email_login_success',
      details: {
        method: 'POST',
        endpoint: '/auth/login',
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
    logger.error('Login failed', { error: error.message, email });
    
    // For login failures, we don't have a userId to log audit
    // Just log to the regular logger
    logger.error('Login failed', { error: error.message, email });

    res.status(401).json({ error: 'Invalid email or password' });
  }
}));

export default router;