import mongoose from 'mongoose';

const jobRecordSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  inputModelImageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImageAsset',
    required: true
  },
  inputOutfitImageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImageAsset',
    required: true
  },
  prompt: {
    type: String,
    trim: true,
    maxlength: 1000
  },
  options: {
    strength: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.9
    },
    preserveFace: {
      type: Boolean,
      default: true
    },
    background: {
      type: String,
      enum: ['transparent', 'original', 'white', 'black'],
      default: 'transparent'
    },
    style: {
      type: String,
      trim: true
    },
    seed: {
      type: Number,
      default: null
    }
  },
  nanobananaJobId: {
    type: String,
    trim: true
  },
  nanobananaRequestPayload: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['queued', 'processing', 'succeeded', 'failed', 'cancelled'],
    default: 'queued'
  },
  attempts: {
    type: Number,
    default: 0,
    min: 0
  },
  maxAttempts: {
    type: Number,
    default: 3
  },
  outputImageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImageAsset',
    default: null
  },
  error: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  errorDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  processingTime: {
    type: Number, // in milliseconds
    default: 0
  },
  queueTime: {
    type: Number, // in milliseconds
    default: 0
  },
  estimatedTime: {
    type: Number, // in seconds
    default: 45
  },
  priority: {
    type: Number,
    min: 1,
    max: 10,
    default: 5
  },
  callbackUrl: {
    type: String,
    trim: true
  },
  webhookSent: {
    type: Boolean,
    default: false
  },
  retryAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
});

// Indexes for better query performance
jobRecordSchema.index({ userId: 1, status: 1 });
jobRecordSchema.index({ status: 1 });
jobRecordSchema.index({ createdAt: -1 });
jobRecordSchema.index({ updatedAt: -1 });
jobRecordSchema.index({ retryAt: 1 });
jobRecordSchema.index({ userId: 1, createdAt: -1 });
jobRecordSchema.index({ nanobananaJobId: 1 });

// Virtual for job duration
jobRecordSchema.virtual('duration').get(function() {
  if (this.completedAt && this.createdAt) {
    return this.completedAt - this.createdAt;
  }
  return null;
});

// Virtual for current status with timestamps
jobRecordSchema.virtual('statusWithTime').get(function() {
  const statusInfo = {
    status: this.status,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };

  if (this.completedAt) {
    statusInfo.completedAt = this.completedAt;
  }

  if (this.processingTime > 0) {
    statusInfo.processingTime = this.processingTime;
  }

  return statusInfo;
});

// Method to mark as processing
jobRecordSchema.methods.markProcessing = function() {
  this.status = 'processing';
  this.attempts += 1;
  this.queueTime = Date.now() - this.createdAt;
  return this.save();
};

// Method to mark as succeeded
jobRecordSchema.methods.markSucceeded = function(outputImageId, processingTime) {
  this.status = 'succeeded';
  this.outputImageId = outputImageId;
  this.processingTime = processingTime;
  this.completedAt = new Date();
  this.error = null;
  this.errorDetails = {};
  return this.save();
};

// Method to mark as failed
jobRecordSchema.methods.markFailed = function(error, errorDetails = {}) {
  this.status = 'failed';
  this.error = error;
  this.errorDetails = errorDetails;
  this.completedAt = new Date();
  
  if (this.attempts >= this.maxAttempts) {
    this.retryAt = null;
  } else {
    // Exponential backoff: 2^attempts * 30 seconds
    const backoffMs = Math.pow(2, this.attempts) * 30000;
    this.retryAt = new Date(Date.now() + backoffMs);
  }
  
  return this.save();
};

// Method to cancel job
jobRecordSchema.methods.cancel = function() {
  if (this.status === 'queued') {
    this.status = 'cancelled';
    this.completedAt = new Date();
    return this.save();
  }
  return Promise.resolve(this);
};

// Static method to get user's job statistics
jobRecordSchema.statics.getUserStats = async function(userId) {
  const stats = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId)
      }
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalProcessingTime: { $sum: '$processingTime' }
      }
    }
  ]);

  const result = {
    total: 0,
    byStatus: {},
    averageProcessingTime: 0
  };

  let totalJobs = 0;
  let totalProcessingTime = 0;

  stats.forEach(stat => {
    result.byStatus[stat._id] = stat.count;
    result.total += stat.count;
    
    if (stat._id === 'succeeded') {
      totalJobs += stat.count;
      totalProcessingTime += stat.totalProcessingTime;
    }
  });

  if (totalJobs > 0) {
    result.averageProcessingTime = Math.round(totalProcessingTime / totalJobs);
  }

  return result;
};

// Static method to cleanup old jobs
jobRecordSchema.statics.cleanupOldJobs = async function(days = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  return this.deleteMany({
    createdAt: { $lt: cutoffDate },
    status: { $in: ['succeeded', 'failed', 'cancelled'] }
  });
};

export default mongoose.model('JobRecord', jobRecordSchema);