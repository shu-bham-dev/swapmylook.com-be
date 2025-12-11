import express from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../config/passport.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Audit from '../models/Audit.js';
import { createLogger } from '../utils/logger.js';

/**
 * @swagger
 * tags:
 *   name: Settings
 *   description: User settings and preferences management
 */

const router = express.Router();
const logger = createLogger('settings-routes');

/**
 * @swagger
 * /api/v1/settings/profile:
 *   get:
 *     summary: Get user profile settings
 *     description: Returns the authenticated user's profile settings including preferences
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile settings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 profile:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     email:
 *                       type: string
 *                     gender:
 *                       type: string
 *                       enum: [male, female, other, prefer-not-to-say]
 *                     profilePicture:
 *                       type: string
 *                     preferences:
 *                       type: object
 *                       properties:
 *                         defaultOutfitStyle:
 *                           type: string
 *                           enum: [casual, formal, street, business, athletic]
 *                         theme:
 *                           type: string
 *                           enum: [light, dark, auto]
 *                         language:
 *                           type: string
 *                         notifications:
 *                           type: boolean
 *                         emailUpdates:
 *                           type: boolean
 *                     linkedAccounts:
 *                       type: object
 *                       properties:
 *                         google:
 *                           type: boolean
 *                         facebook:
 *                           type: boolean
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
router.get('/profile', requireAuth(), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    profile: {
      name: user.name,
      email: user.email,
      gender: user.gender,
      profilePicture: user.profilePicture,
      preferences: user.preferences
    }
  });
}));

/**
 * @swagger
 * /api/v1/settings/profile:
 *   put:
 *     summary: Update user profile settings
 *     description: Update the authenticated user's profile settings
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: User's full name
 *               gender:
 *                 type: string
 *                 enum: [male, female, other, prefer-not-to-say]
 *                 description: User's gender
 *               profilePicture:
 *                 type: string
 *                 description: URL to user's profile picture
 *               preferences:
 *                 type: object
 *                 properties:
 *                   defaultOutfitStyle:
 *                     type: string
 *                     enum: [casual, formal, street, business, athletic]
 *                   theme:
 *                     type: string
 *                     enum: [light, dark, auto]
 *                   language:
 *                     type: string
 *                   notifications:
 *                     type: boolean
 *                   emailUpdates:
 *                     type: boolean
 *     responses:
 *       200:
 *         description: Profile settings updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 profile:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     email:
 *                       type: string
 *                     gender:
 *                       type: string
 *                     profilePicture:
 *                       type: string
 *                     preferences:
 *                       type: object
 *       400:
 *         description: Bad request - invalid data
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
router.put('/profile', requireAuth(), asyncHandler(async (req, res) => {
  const { name, gender, profilePicture, preferences } = req.body;
  
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Update fields if provided
  if (name !== undefined) user.name = name;
  if (gender !== undefined) user.gender = gender;
  if (profilePicture !== undefined) user.profilePicture = profilePicture;
  
  // Update preferences if provided
  if (preferences) {
    if (preferences.defaultOutfitStyle !== undefined) {
      user.preferences.defaultOutfitStyle = preferences.defaultOutfitStyle;
    }
    if (preferences.theme !== undefined) {
      user.preferences.theme = preferences.theme;
    }
    if (preferences.notifications !== undefined) {
      user.preferences.notifications = preferences.notifications;
    }
    if (preferences.emailUpdates !== undefined) {
      user.preferences.emailUpdates = preferences.emailUpdates;
    }
  }

  await user.save();

  // Log profile update
  await Audit.logUsage({
    userId: user.id,
    type: 'settings',
    action: 'profile_updated',
    details: {
      method: 'PUT',
      endpoint: '/settings/profile',
      statusCode: 200
    }
  });

  res.json({
    message: 'Profile updated successfully',
    profile: {
      name: user.name,
      email: user.email,
      gender: user.gender,
      profilePicture: user.profilePicture,
      preferences: user.preferences
    }
  });
}));

/**
 * @swagger
 * /api/v1/settings/password:
 *   put:
 *     summary: Change user password
 *     description: Change the authenticated user's password
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 format: password
 *                 description: Current password for verification
 *               newPassword:
 *                 type: string
 *                 format: password
 *                 description: New password (min 6 characters)
 *     responses:
 *       200:
 *         description: Password changed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request - invalid data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - invalid current password
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
router.put('/password', requireAuth(), asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }

  // New password validation (same as signup)
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long' });
  }

  const hasUpperCase = /[A-Z]/.test(newPassword);
  const hasLowerCase = /[a-z]/.test(newPassword);
  const hasNumbers = /\d/.test(newPassword);
  const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword);

  if (!hasUpperCase || !hasLowerCase || !hasNumbers || !hasSpecialChar) {
    return res.status(400).json({
      error: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'
    });
  }

  // Common password check
  const commonPasswords = ['password', '123456', 'qwerty', 'letmein', 'welcome'];
  if (commonPasswords.includes(newPassword.toLowerCase())) {
    return res.status(400).json({ error: 'Password is too common, please choose a stronger password' });
  }

  // Fetch user with passwordHash
  const user = await User.findById(req.user.id).select('+passwordHash');
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Verify current password
  const isValidPassword = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isValidPassword) {
    // Log failed attempt
    await Audit.logUsage({
      userId: user.id,
      type: 'settings',
      action: 'password_change_failed',
      details: {
        method: 'PUT',
        endpoint: '/settings/password',
        statusCode: 401,
        error: 'Invalid current password'
      },
      isSuccess: false
    });
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  // Hash new password
  const saltRounds = 12;
  user.passwordHash = await bcrypt.hash(newPassword, saltRounds);
  await user.save();

  // Log successful password change
  await Audit.logUsage({
    userId: user.id,
    type: 'settings',
    action: 'password_changed',
    details: {
      method: 'PUT',
      endpoint: '/settings/password',
      statusCode: 200
    }
  });

  res.json({ message: 'Password changed successfully' });
}));

/**
 * @swagger
 * /api/v1/settings/account:
 *   delete:
 *     summary: Delete user account
 *     description: Permanently delete the authenticated user's account and all associated data
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - confirmation
 *             properties:
 *               confirmation:
 *                 type: string
 *                 description: Must be "DELETE MY ACCOUNT" to confirm deletion
 *                 example: "DELETE MY ACCOUNT"
 *     responses:
 *       200:
 *         description: Account deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request - invalid confirmation
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
router.delete('/account', requireAuth(), asyncHandler(async (req, res) => {
  const { confirmation } = req.body;
  
  if (confirmation !== 'DELETE MY ACCOUNT') {
    return res.status(400).json({ error: 'Confirmation text must be exactly "DELETE MY ACCOUNT"' });
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Soft delete by marking as inactive
  user.isActive = false;
  await user.save();

  // Log account deletion
  await Audit.logUsage({
    userId: user.id,
    type: 'settings',
    action: 'account_deleted',
    details: {
      method: 'DELETE',
      endpoint: '/settings/account',
      statusCode: 200
    }
  });

  res.json({ message: 'Account has been deactivated successfully' });
}));


export default router;