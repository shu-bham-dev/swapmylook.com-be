// Increase max listeners to avoid warning
process.setMaxListeners(20);

// Global error handlers for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
  process.exit(1);
});

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

// Load environment variables
dotenv.config();

// Import configurations
import { connectDB } from './config/database.js';
import { connectRedis } from './config/redis.js';
import { setupPassport } from './config/passport.js';
import { setupSwagger } from './config/swagger.js';
import { initQueues, getQueue } from './config/queue.js';

// Import middleware
import { errorHandler } from './middleware/errorHandler.js';

// Import routes
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/uploads.js';
import assetRoutes from './routes/assets.js';
import generateRoutes from './routes/generate.js';
import galleryRoutes from './routes/gallery.js';
import outfitsRoutes from './routes/outfits.js';
import settingsRoutes from './routes/settings.js';
import subscriptionRoutes from './routes/subscription.js';
import paymentsRoutes from './routes/payments.js';
import webhooksRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Compression
app.use(compression());

// Logging
app.use(morgan('combined'));

// ============================================
// CRITICAL: Webhook route MUST come BEFORE express.json()
// Webhooks need raw body for signature verification
// ============================================
app.use('/api/v1/webhooks', webhooksRoutes);

// Body parsing middleware (for all OTHER routes)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialize authentication
setupPassport(app);

// Setup Swagger documentation
if (process.env.NODE_ENV !== 'production') {
  setupSwagger(app);
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'SwapMyLook API Server',
    version: '1.0.0',
    documentation: process.env.NODE_ENV !== 'production' ? '/api-docs' : null
  });
});

// Legacy billing return URL (for pending payments)
app.get('/billing/return', (req, res) => {
  const { subscription_id, status } = req.query;
  // Redirect to the new API route which will handle logging and frontend redirect
  const params = new URLSearchParams();
  if (subscription_id) params.append('subscription_id', subscription_id);
  params.append('status', status || 'pending');
  const newUrl = `/api/v1/payments/billing/return?${params.toString()}`;
  res.redirect(newUrl);
});

// API routes (after express.json() since they need parsed JSON)
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/uploads', uploadRoutes);
app.use('/api/v1/assets', assetRoutes);
app.use('/api/v1/generate', generateRoutes);
app.use('/api/v1/gallery', galleryRoutes);
app.use('/api/v1/outfits', outfitsRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/subscription', subscriptionRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/public', publicRoutes);

// Initialize application
async function initializeApp() {
  try {
    console.log('🚀 Starting application initialization...');
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    console.log(`🔧 PORT: ${process.env.PORT}`);
    
    // Connect to databases
    console.log('🔗 Connecting to MongoDB...');
    await connectDB();
    console.log('✅ MongoDB connected successfully');
    
    // Connect to Redis (with graceful failure handling)
    console.log('🔗 Connecting to Redis...');
    try {
      await connectRedis();
      console.log('✅ Redis connected successfully');
    } catch (redisError) {
      console.warn('⚠️ Redis connection failed, continuing without Redis:', redisError.message);
    }

    // Initialize queues (only if Redis is available)
    try {
      console.log('📋 Initializing queues...');
      await initQueues();
      console.log('✅ Queues initialized');
    } catch (queueError) {
      console.warn('⚠️ Queue initialization failed, continuing without queues:', queueError.message);
    }

    // Setup Bull Board dashboard (only if queues are available)
    try {
      console.log('📊 Setting up Bull Board dashboard...');
      const serverAdapter = new ExpressAdapter();
      serverAdapter.setBasePath('/admin/queues');

      const { addQueue } = createBullBoard({
        queues: [
          new BullMQAdapter(getQueue('generate'))
        ],
        serverAdapter: serverAdapter,
      });

      // Bull Board dashboard - register route before 404 handler
      app.use('/admin/queues', serverAdapter.getRouter());
      
      console.log('✅ Bull Board dashboard available at /admin/queues');
    } catch (bullBoardError) {
      console.warn('⚠️ Bull Board setup failed, continuing without dashboard:', bullBoardError.message);
    }

    // Global error handler (must be after all routes)
    app.use(errorHandler);

    // 404 handler - must be registered after all other routes
    app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Route not found',
        message: `The requested route ${req.originalUrl} does not exist.`
      });
    });

    // Start server
    console.log(`🌐 Starting server on 0.0.0.0:${PORT}...`);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV}`);
      console.log(`🔗 API Base URL: http://localhost:${PORT}/api/v1`);
      console.log(`🪝 Webhook URL: http://localhost:${PORT}/api/v1/webhooks/dodo`);
      console.log(`🔴 Redis Status: ${process.env.REDIS_URL || process.env.RAILWAY_REDIS_URL ? 'Configured' : 'Not Configured'}`);
    });
  } catch (error) {
    console.error('❌ Failed to initialize application:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the application
initializeApp();

export default app;