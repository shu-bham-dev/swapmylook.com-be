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
import { initRateLimiters } from './middleware/rateLimiter.js';

// Import middleware
import { errorHandler } from './middleware/errorHandler.js';
import { globalRateLimiter } from './middleware/rateLimiter.js';

// Import routes
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/uploads.js';
import assetRoutes from './routes/assets.js';
import generateRoutes from './routes/generate.js';
import galleryRoutes from './routes/gallery.js';
import outfitsRoutes from './routes/outfits.js';
import settingsRoutes from './routes/settings.js';
import subscriptionRoutes from './routes/subscription.js';
import adminRoutes from './routes/admin.js';
import healthRoutes from './routes/health.js';

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

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
app.use(globalRateLimiter);

// Initialize authentication
setupPassport(app);

// Setup Swagger documentation
if (process.env.NODE_ENV !== 'production') {
  setupSwagger(app);
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'SwapMyLook API Server',
    version: '1.0.0',
    status: 'healthy',
    documentation: process.env.NODE_ENV !== 'production' ? '/api-docs' : null
  });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/uploads', uploadRoutes);
app.use('/api/v1/assets', assetRoutes);
app.use('/api/v1/generate', generateRoutes);
app.use('/api/v1/gallery', galleryRoutes);
app.use('/api/v1/outfits', outfitsRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/subscription', subscriptionRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/health', healthRoutes);

// Global error handler
app.use(errorHandler);

// Initialize application
async function initializeApp() {
  try {
    // Connect to databases
    await connectDB();
    await connectRedis();

    // Initialize queues
    await initQueues();

    // Setup Bull Board dashboard
    try {
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
      
      console.log('📊 Bull Board dashboard available at /admin/queues');
    } catch (bullBoardError) {
      console.warn('⚠️ Bull Board setup failed, continuing without dashboard:', bullBoardError.message);
    }

    // 404 handler - must be registered after all other routes
    app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Route not found',
        message: `The requested route ${req.originalUrl} does not exist.`
      });
    });

    // Initialize rate limiters
    await initRateLimiters();

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV}`);
      console.log(`🔗 API Base URL: http://localhost:${PORT}/api/v1`);
    });
  } catch (error) {
    console.error('❌ Failed to initialize application:', error);
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