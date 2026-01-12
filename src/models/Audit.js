import mongoose from 'mongoose';

const auditSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function() {
      // userId is required for all types except 'otp'
      return this.type !== 'otp';
    }
  },
  type: {
    type: String,
    enum: ['generation', 'download', 'upload', 'login', 'signup', 'quota_adjustment', 'subscription_change', 'outfits', 'settings', 'otp'],
    required: true
  },
  action: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    default: 1
  },
  resourceId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  resourceType: {
    type: String,
    enum: ['image', 'job', 'project', 'user', 'outfits'],
    default: null
  },
  details: {
    ipAddress: String,
    userAgent: String,
    method: String,
    endpoint: String,
    statusCode: Number,
    responseTime: Number,
    fileSize: Number,
    imageType: String,
    jobStatus: String,
    error: String,
    quotaBefore: Number,
    quotaAfter: Number,
    planBefore: String,
    planAfter: String,
    cost: Number,
    currency: String
  },
  metadata: {
    appVersion: String,
    deviceId: String,
    sessionId: String,
    referrer: String
  },
  isSuccess: {
    type: Boolean,
    default: true
  },
  processed: {
    type: Boolean,
    default: false
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

// Indexes for analytics and reporting
auditSchema.index({ userId: 1, type: 1 });
auditSchema.index({ type: 1, createdAt: -1 });
auditSchema.index({ userId: 1, createdAt: -1 });
auditSchema.index({ resourceType: 1, resourceId: 1 });
auditSchema.index({ isSuccess: 1 });
auditSchema.index({ processed: 1 });

// Compound index for time-based queries
auditSchema.index({ type: 1, createdAt: 1 });

// Static method to log usage
auditSchema.statics.logUsage = async function(data) {
  const audit = new this({
    userId: data.userId,
    type: data.type,
    action: data.action,
    amount: data.amount || 1,
    resourceId: data.resourceId,
    resourceType: data.resourceType,
    details: data.details || {},
    metadata: data.metadata || {},
    isSuccess: data.isSuccess !== false
  });

  return audit.save();
};

// Static method to get user usage summary
auditSchema.statics.getUserUsageSummary = async function(userId, startDate, endDate) {
  const matchStage = {
    userId: new mongoose.Types.ObjectId(userId),
    createdAt: {
      $gte: startDate,
      $lte: endDate
    }
  };

  const summary = await this.aggregate([
    {
      $match: matchStage
    },
    {
      $group: {
        _id: '$type',
        totalCount: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        successCount: {
          $sum: { $cond: [{ $eq: ['$isSuccess', true] }, 1, 0] }
        },
        failedCount: {
          $sum: { $cond: [{ $eq: ['$isSuccess', false] }, 1, 0] }
        }
      }
    },
    {
      $project: {
        type: '$_id',
        totalCount: 1,
        totalAmount: 1,
        successCount: 1,
        failedCount: 1,
        successRate: {
          $cond: [
            { $eq: ['$totalCount', 0] },
            0,
            { $multiply: [{ $divide: ['$successCount', '$totalCount'] }, 100] }
          ]
        }
      }
    }
  ]);

  // Get total usage across all types
  const totalUsage = await this.aggregate([
    {
      $match: matchStage
    },
    {
      $group: {
        _id: null,
        totalEvents: { $sum: 1 },
        totalAmount: { $sum: '$amount' }
      }
    }
  ]);

  return {
    byType: summary.reduce((acc, item) => {
      acc[item.type] = item;
      return acc;
    }, {}),
    totals: totalUsage[0] || { totalEvents: 0, totalAmount: 0 }
  };
};

// Static method to get system-wide usage statistics
auditSchema.statics.getSystemUsage = async function(startDate, endDate) {
  const matchStage = {
    createdAt: {
      $gte: startDate,
      $lte: endDate
    }
  };

  const results = await this.aggregate([
    {
      $match: matchStage
    },
    {
      $group: {
        _id: {
          type: '$type',
          date: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$createdAt'
            }
          }
        },
        count: { $sum: 1 },
        amount: { $sum: '$amount' }
      }
    },
    {
      $group: {
        _id: '$_id.type',
        dailyBreakdown: {
          $push: {
            date: '$_id.date',
            count: '$count',
            amount: '$amount'
          }
        },
        totalCount: { $sum: '$count' },
        totalAmount: { $sum: '$amount' }
      }
    }
  ]);

  return results.reduce((acc, item) => {
    acc[item._id] = {
      totalCount: item.totalCount,
      totalAmount: item.totalAmount,
      dailyBreakdown: item.dailyBreakdown
    };
    return acc;
  }, {});
};

// Static method to cleanup old audit records
auditSchema.statics.cleanupOldRecords = async function(days = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  return this.deleteMany({
    createdAt: { $lt: cutoffDate },
    processed: true
  });
};

export default mongoose.model('Audit', auditSchema);