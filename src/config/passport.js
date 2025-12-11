import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('auth');

// Google OAuth2 client for token verification
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

/**
 * Setup Passport authentication strategies
 * @param {Object} app - Express app instance
 */
export function setupPassport(app) {
  // Serialize user for session
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // Deserialize user from session
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });

  // Google OAuth Strategy
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/v1/auth/google/callback',
    scope: ['profile', 'email'],
    state: false
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      logger.info('Google OAuth authentication attempt', {
        googleId: profile.id,
        email: profile.emails[0].value
      });

      const user = await User.findOrCreate(profile);
      
      logger.info('Google OAuth authentication successful', {
        userId: user.id,
        email: user.email
      });

      done(null, user);
    } catch (error) {
      logger.error('Google OAuth authentication failed', {
        error: error.message,
        profile: profile.id
      });
      done(error, null);
    }
  }));

  // Initialize Passport
  app.use(passport.initialize());
  
  // Use session if needed (for traditional web apps)
  if (process.env.USE_SESSIONS === 'true') {
    app.use(passport.session());
  }

  logger.info('Passport authentication configured');
}

/**
 * Verify Google ID token (for mobile apps or alternative flows)
 * @param {string} idToken - Google ID token
 * @returns {Promise<Object>} - User information
 */
export async function verifyGoogleToken(idToken) {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    
    if (!payload.email_verified) {
      throw new Error('Google email not verified');
    }

    return {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.picture,
      emailVerified: payload.email_verified
    };
  } catch (error) {
    logger.error('Google token verification failed', {
      error: error.message
    });
    throw new Error('Invalid Google token');
  }
}

/**
 * Middleware to require authentication
 * @returns {Function} - Express middleware
 */
export function requireAuth() {
  return (req, res, next) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return next();
    }
    
    // Check for JWT token in Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return verifyJWTToken(authHeader.slice(7))
        .then(user => {
          req.user = user;
          next();
        })
        .catch(error => {
          logger.warn('JWT authentication failed', {
            error: error.message,
            ip: req.ip
          });
          res.status(401).json({ error: 'Authentication required' });
        });
    }
    
    logger.warn('Unauthenticated access attempt', {
      path: req.path,
      method: req.method,
      ip: req.ip
    });
    
    res.status(401).json({ error: 'Authentication required' });
  };
}

/**
 * Middleware to require admin privileges
 * @returns {Function} - Express middleware
 */
export function requireAdmin() {
  return [
    requireAuth(),
    (req, res, next) => {
      // Check if user has admin role (you can implement role-based access)
      if (req.user && req.user.plan === 'enterprise') {
        return next();
      }
      
      logger.warn('Admin access denied', {
        userId: req.user?.id,
        path: req.path
      });
      
      res.status(403).json({ error: 'Admin privileges required' });
    }
  ];
}

/**
 * Generate JWT token for user
 * @param {Object} user - User object
 * @param {boolean} rememberMe - Whether to remember the user (longer expiration)
 * @returns {string} - JWT token
 */
export function generateJWTToken(user, rememberMe = false) {
  const payload = {
    id: user.id,
    email: user.email,
    plan: user.plan
  };

  const expiresIn = rememberMe
    ? process.env.JWT_REMEMBER_ME_EXPIRES_IN || '7d'
    : process.env.JWT_EXPIRES_IN || '1h';

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn,
    issuer: 'swapmylook-api',
    audience: 'swapmylook-client'
  });
}

/**
 * Verify JWT token
 * @param {string} token - JWT token
 * @returns {Promise<Object>} - Decoded token payload
 */
export async function verifyJWTToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'swapmylook-api',
      audience: 'swapmylook-client'
    });

    // Verify user still exists and is active
    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      throw new Error('User not found or inactive');
    }

    return user;
  } catch (error) {
    logger.error('JWT verification failed', {
      error: error.message
    });
    throw new Error('Invalid token');
  }
}

/**
 * Get current user from request
 * @param {Object} req - Express request
 * @returns {Object|null} - User object or null
 */
export function getCurrentUser(req) {
  if (req.user) {
    return req.user;
  }

  // Check for JWT in Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const decoded = jwt.decode(token);
      return decoded ? { id: decoded.id, email: decoded.email } : null;
    } catch {
      return null;
    }
  }

  return null;
}

export default {
  setupPassport,
  verifyGoogleToken,
  requireAuth,
  requireAdmin,
  generateJWTToken,
  verifyJWTToken,
  getCurrentUser
};