import mongoose from 'mongoose';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('database');

// MongoDB connection options
const connectionOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  family: 4,
  maxPoolSize: 10,
  minPoolSize: 5,
  maxIdleTimeMS: 30000,
  connectTimeoutMS: 10000
};

// MongoDB connection state
let isConnected = false;
let connectionRetries = 0;
const MAX_RETRIES = 5;

// MongoDB event handlers
mongoose.connection.on('connected', () => {
  isConnected = true;
  connectionRetries = 0;
  logger.info('✅ MongoDB connected successfully');
});

mongoose.connection.on('error', (error) => {
  logger.error('❌ MongoDB connection error:', error);
  isConnected = false;
});

mongoose.connection.on('disconnected', () => {
  logger.warn('⚠️ MongoDB disconnected');
  isConnected = false;
});

mongoose.connection.on('reconnected', () => {
  logger.info('🔁 MongoDB reconnected');
  isConnected = true;
  connectionRetries = 0;
});

// Graceful shutdown handler
process.on('SIGINT', async () => {
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed through app termination');
    process.exit(0);
  } catch (error) {
    logger.error('Error closing MongoDB connection:', error);
    process.exit(1);
  }
});

/**
 * Connect to MongoDB database
 * @returns {Promise<void>}
 */
export async function connectDB() {
  const mongoUri = process.env.MONGO_URI;
  
  if (!mongoUri) {
    console.error('❌ MONGO_URI environment variable is required');
    throw new Error('MONGO_URI environment variable is required');
  }

  try {
    if (isConnected) {
      console.log('ℹ️ MongoDB already connected');
      return;
    }

    console.log('🔗 Connecting to MongoDB...');
    console.log(`📝 MongoDB URI: ${mongoUri.substring(0, 30)}...`);
    
    await mongoose.connect(mongoUri, connectionOptions);
    
    // Verify connection
    console.log('✅ MongoDB connected, verifying with ping...');
    await mongoose.connection.db.admin().ping();
    console.log('✅ MongoDB ping successful');
    
  } catch (error) {
    connectionRetries++;
    
    if (connectionRetries >= MAX_RETRIES) {
      console.error(`❌ Failed to connect to MongoDB after ${MAX_RETRIES} attempts:`, error);
      console.error('Stack trace:', error.stack);
      throw new Error(`MongoDB connection failed after ${MAX_RETRIES} retries`);
    }
    
    console.warn(`⚠️ MongoDB connection attempt ${connectionRetries} failed, retrying in 5 seconds...`);
    console.error('Error details:', error.message);
    
    // Wait before retrying with exponential backoff
    const backoffTime = Math.pow(2, connectionRetries) * 1000;
    await new Promise(resolve => setTimeout(resolve, backoffTime));
    
    return connectDB(); // Retry connection
  }
}

/**
 * Disconnect from MongoDB
 * @returns {Promise<void>}
 */
export async function disconnectDB() {
  try {
    if (isConnected) {
      await mongoose.connection.close();
      logger.info('MongoDB disconnected successfully');
    }
  } catch (error) {
    logger.error('Error disconnecting from MongoDB:', error);
    throw error;
  }
}

/**
 * Get database connection status
 * @returns {boolean}
 */
export function getDBStatus() {
  return isConnected;
}

/**
 * Get database statistics
 * @returns {Promise<Object>}
 */
export async function getDBStats() {
  try {
    if (!isConnected) {
      throw new Error('Database not connected');
    }

    const adminDb = mongoose.connection.db.admin();
    const serverStatus = await adminDb.serverStatus();
    const dbStats = await mongoose.connection.db.stats();
    
    return {
      connected: isConnected,
      host: mongoose.connection.host,
      port: mongoose.connection.port,
      name: mongoose.connection.name,
      readyState: mongoose.connection.readyState,
      collections: dbStats.collections,
      objects: dbStats.objects,
      avgObjSize: dbStats.avgObjSize,
      dataSize: dbStats.dataSize,
      storageSize: dbStats.storageSize,
      indexSize: dbStats.indexSize,
      indexes: dbStats.indexes,
      connections: serverStatus.connections || {}
    };
  } catch (error) {
    logger.error('Error getting database stats:', error);
    return {
      connected: isConnected,
      error: error.message
    };
  }
}

/**
 * Health check for database
 * @returns {Promise<{status: string, timestamp: Date, responseTime: number}>}
 */
export async function healthCheck() {
  const startTime = Date.now();
  
  try {
    if (!isConnected) {
      throw new Error('Database not connected');
    }
    
    await mongoose.connection.db.admin().ping();
    const responseTime = Date.now() - startTime;
    
    return {
      status: 'healthy',
      timestamp: new Date(),
      responseTime
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    return {
      status: 'unhealthy',
      timestamp: new Date(),
      responseTime,
      error: error.message
    };
  }
}

export default {
  connectDB,
  disconnectDB,
  getDBStatus,
  getDBStats,
  healthCheck
};