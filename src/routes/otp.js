import express from 'express';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import OTP from '../models/OTP.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';
import { emailService } from '../services/emailService.js';
import { generateJWTToken } from '../config/passport.js';
import bcrypt from 'bcryptjs';

const router = express.Router();
const logger = createLogger('otp-routes');

/**
 * @swagger
 * /api/v1/auth/otp/send:
 *   post:
 *     summary: Send OTP for email verification
 *     description: Send a one-time password (OTP) to the user's email for signup verification
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - purpose
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email address
 *                 example: "user@example.com"
 *               purpose:
 *                 type: string
 *                 enum: [signup]
 *                 description: Purpose of OTP (currently only signup is supported)
 *                 example: "signup"
 *               name:
 *                 type: string
 *                 description: User's name (required for signup)
 *                 example: "John Doe"
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User's password (optional, can be provided during OTP verification instead)
 *                 example: "SecurePass123!"
 *     responses:
 *       200:
 *         description: OTP sent successfully
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
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Failed to send OTP
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/send', authRateLimiter, asyncHandler(async (req, res) => {
  const { email, purpose, name, password } = req.body;

  // Validate required fields
  if (!email || !purpose) {
    return res.status(400).json({ error: 'Email and purpose are required' });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Validate purpose
  if (purpose !== 'signup') {
    return res.status(400).json({ error: 'Invalid purpose. Only "signup" is supported' });
  }

  // For signup, name is required
  if (purpose === 'signup' && !name) {
    return res.status(400).json({ error: 'Name is required for signup' });
  }

  try {
    // Check if user already exists for signup
    if (purpose === 'signup') {
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ error: 'User with this email already exists' });
      }
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Create or update OTP record with password in metadata if provided
    const metadata = { name };
    if (password) {
      metadata.password = password;
    }

    await OTP.findOneAndUpdate(
      { email: email.toLowerCase(), purpose },
      {
        code: otp,
        expiresAt,
        attempts: 0,
        verified: false,
        metadata
      },
      { upsert: true, new: true }
    );

    // Send OTP via email
    await emailService.sendOTPEmail(email, otp, purpose, name);

    // Log OTP sent (commented out due to Audit model validation issues)
    // await Audit.logUsage({
    //   type: 'otp',
    //   action: 'otp_sent',
    //   details: {
    //     method: 'POST',
    //     endpoint: '/auth/otp/send',
    //     statusCode: 200,
    //     email,
    //     purpose
    //   }
    // });

    res.json({
      message: 'OTP sent successfully',
      expiresIn: 10
    });
  } catch (error) {
    logger.error('Failed to send OTP', { error: error.message, email });

    // Log OTP send failure (commented out due to Audit model validation issues)
    // await Audit.logUsage({
    //   type: 'otp',
    //   action: 'otp_send_failed',
    //   details: {
    //     method: 'POST',
    //     endpoint: '/auth/otp/send',
    //     statusCode: 500,
    //     email,
    //     error: error.message
    //   },
    //   isSuccess: false
    // });

    res.status(500).json({ error: 'Failed to send OTP', details: error.message });
  }
}));

/**
 * @swagger
 * /api/v1/auth/otp/verify:
 *   post:
 *     summary: Verify OTP and complete signup
 *     description: Verify the OTP code and create user account if verification is successful
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - code
 *               - purpose
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email address
 *                 example: "user@example.com"
 *               code:
 *                 type: string
 *                 description: 6-digit OTP code
 *                 example: "123456"
 *               purpose:
 *                 type: string
 *                 enum: [signup]
 *                 description: Purpose of OTP verification
 *                 example: "signup"
 *               name:
 *                 type: string
 *                 description: User's name (required for signup)
 *                 example: "John Doe"
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User's password for account creation
 *                 example: "SecurePass123!"
 *     responses:
 *       200:
 *         description: OTP verified and user created successfully
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
 *         description: Bad request - missing or invalid fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid or expired OTP
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: OTP not found
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
router.post('/verify', authRateLimiter, asyncHandler(async (req, res) => {
  const { email, code, purpose, name, password } = req.body;

  // Validate required fields
  if (!email || !code || !purpose || !password) {
    return res.status(400).json({ error: 'Email, code, purpose, and password are required' });
  }

  // For signup, name is required
  if (purpose === 'signup' && !name) {
    return res.status(400).json({ error: 'Name is required for signup' });
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

  try {
    // Find OTP record
    const otpRecord = await OTP.findOne({
      email: email.toLowerCase(),
      purpose,
      verified: false
    });

    if (!otpRecord) {
      return res.status(404).json({ error: 'OTP not found or already verified' });
    }

    // Check if OTP has expired
    if (otpRecord.expiresAt < new Date()) {
      // Log OTP expired (commented out due to Audit model validation issues)
      // await Audit.logUsage({
      //   type: 'otp',
      //   action: 'otp_expired',
      //   details: {
      //     method: 'POST',
      //     endpoint: '/auth/otp/verify',
      //     statusCode: 401,
      //     email,
      //     purpose
      //   },
      //   isSuccess: false
      // });
      return res.status(401).json({ error: 'OTP has expired' });
    }

    // Check attempt limit
    if (otpRecord.attempts >= 5) {
      // Log max attempts (commented out due to Audit model validation issues)
      // await Audit.logUsage({
      //   type: 'otp',
      //   action: 'otp_max_attempts',
      //   details: {
      //     method: 'POST',
      //     endpoint: '/auth/otp/verify',
      //     statusCode: 401,
      //     email,
      //     purpose
      //   },
      //   isSuccess: false
      // });
      return res.status(401).json({ error: 'Maximum verification attempts exceeded' });
    }

    // Verify OTP code
    if (otpRecord.code !== code) {
      // Increment attempt count
      otpRecord.attempts += 1;
      await otpRecord.save();

      // Log verification failed (commented out due to Audit model validation issues)
      // await Audit.logUsage({
      //   type: 'otp',
      //   action: 'otp_verification_failed',
      //   details: {
      //     method: 'POST',
      //     endpoint: '/auth/otp/verify',
      //     statusCode: 401,
      //     email,
      //     purpose,
      //     attempts: otpRecord.attempts
      //   },
      //   isSuccess: false
      // });

      return res.status(401).json({ error: 'Invalid OTP code' });
    }

    // Mark OTP as verified
    otpRecord.verified = true;
    otpRecord.verifiedAt = new Date();
    await otpRecord.save();

    // For signup purpose, create user account
    if (purpose === 'signup') {
      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // Create new user with emailVerified set to true
      const user = new User({
        email: email.toLowerCase(),
        name: name.trim(),
        passwordHash,
        emailVerified: true,
        plan: 'free',
        isActive: true
      });

      await user.save();

      // Generate JWT token
      const token = generateJWTToken(user);

      // Log successful signup (commented out due to Audit model validation issues)
      // await Audit.logUsage({
      //   userId: user._id,
      //   type: 'signup',
      //   action: 'otp_signup_success',
      //   details: {
      //     method: 'POST',
      //     endpoint: '/auth/otp/verify',
      //     statusCode: 200
      //   }
      // });

      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          plan: user.plan,
          quota: user.quota,
          emailVerified: user.emailVerified
        }
      });
    }
  } catch (error) {
    logger.error('OTP verification failed', { error: error.message, email });

    // Log verification error (commented out due to Audit model validation issues)
    // await Audit.logUsage({
    //   type: 'otp',
    //   action: 'otp_verification_error',
    //   details: {
    //     method: 'POST',
    //     endpoint: '/auth/otp/verify',
    //     statusCode: 500,
    //     email,
    //     error: error.message
    //   },
    //   isSuccess: false
    // });

    res.status(500).json({ error: 'Failed to verify OTP' });
  }
}));

/**
 * @swagger
 * /api/v1/auth/otp/resend:
 *   post:
 *     summary: Resend OTP
 *     description: Resend OTP to the user's email
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - purpose
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email address
 *                 example: "user@example.com"
 *               purpose:
 *                 type: string
 *                 enum: [signup]
 *                 description: Purpose of OTP
 *                 example: "signup"
 *     responses:
 *       200:
 *         description: OTP resent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "OTP resent successfully"
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
 *       404:
 *         description: OTP not found
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
 *       500:
 *         description: Failed to resend OTP
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/resend', authRateLimiter, asyncHandler(async (req, res) => {
  const { email, purpose } = req.body;

  // Validate required fields
  if (!email || !purpose) {
    return res.status(400).json({ error: 'Email and purpose are required' });
  }

  try {
    // Find existing OTP record
    const otpRecord = await OTP.findOne({
      email: email.toLowerCase(),
      purpose,
      verified: false
    });

    if (!otpRecord) {
      return res.status(404).json({ error: 'OTP not found or already verified' });
    }

    // Check if we can resend (rate limiting)
    const now = new Date();
    const lastSent = otpRecord.updatedAt || otpRecord.createdAt;
    const timeSinceLastSent = now - lastSent;
    const minResendInterval = 60 * 1000; // 1 minute

    if (timeSinceLastSent < minResendInterval) {
      return res.status(429).json({
        error: 'Please wait before requesting another OTP',
        retryAfter: Math.ceil((minResendInterval - timeSinceLastSent) / 1000)
      });
    }

    // Generate new OTP
    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Update OTP record
    otpRecord.code = newOtp;
    otpRecord.expiresAt = expiresAt;
    otpRecord.attempts = 0;
    await otpRecord.save();

    // Get name from metadata
    const name = otpRecord.metadata?.name || 'User';

    // Send OTP via email
    await emailService.sendOTPEmail(email, newOtp, purpose, name);

    // Log OTP resent (commented out due to Audit model validation issues)
    // await Audit.logUsage({
    //   type: 'otp',
    //   action: 'otp_resent',
    //   details: {
    //     method: 'POST',
    //     endpoint: '/auth/otp/resend',
    //     statusCode: 200,
    //     email,
    //     purpose
    //   }
    // });

    res.json({
      message: 'OTP resent successfully',
      expiresIn: 10
    });
  } catch (error) {
    logger.error('Failed to resend OTP', { error: error.message, email });

    // Log resend failed (commented out due to Audit model validation issues)
    // await Audit.logUsage({
    //   type: 'otp',
    //   action: 'otp_resend_failed',
    //   details: {
    //     method: 'POST',
    //     endpoint: '/auth/otp/resend',
    //     statusCode: 500,
    //     email,
    //     error: error.message
    //   },
    //   isSuccess: false
    // });

    res.status(500).json({ error: 'Failed to resend OTP' });
  }
}));

export default router;