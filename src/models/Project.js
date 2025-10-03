import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  coverImageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImageAsset',
    default: null
  },
  tags: [{
    type: String,
    trim: true
  }],
  isPublic: {
    type: Boolean,
    default: false
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  stats: {
    totalImages: {
      type: Number,
      default: 0
    },
    totalJobs: {
      type: Number,
      default: 0
    },
    successfulJobs: {
      type: Number,
      default: 0
    },
    lastActivity: {
      type: Date,
      default: Date.now
    }
  },
  settings: {
    defaultOptions: {
      strength: {
        type: Number,
        default: 0.9
      },
      preserveFace: {
        type: Boolean,
        default: true
      },
      background: {
        type: String,
        default: 'transparent'
      }
    },
    autoSave: {
      type: Boolean,
      default: true
    },
    notificationOnComplete: {
      type: Boolean,
      default: true
    }
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
projectSchema.index({ userId: 1 });
projectSchema.index({ userId: 1, isArchived: 1 });
projectSchema.index({ name: 'text', description: 'text' });
projectSchema.index({ createdAt: -1 });
projectSchema.index({ 'stats.lastActivity': -1 });

// Method to update last activity
projectSchema.methods.updateLastActivity = function() {
  this.stats.lastActivity = new Date();
  return this.save();
};

// Method to archive project
projectSchema.methods.archive = function() {
  this.isArchived = true;
  return this.save();
};

// Method to unarchive project
projectSchema.methods.unarchive = function() {
  this.isArchived = false;
  return this.save();
};

// Static method to get user's project statistics
projectSchema.statics.getUserProjectStats = async function(userId) {
  const stats = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        isArchived: false
      }
    },
    {
      $group: {
        _id: null,
        totalProjects: { $sum: 1 },
        totalImages: { $sum: '$stats.totalImages' },
        totalJobs: { $sum: '$stats.totalJobs' },
        successfulJobs: { $sum: '$stats.successfulJobs' }
      }
    }
  ]);

  if (stats.length === 0) {
    return {
      totalProjects: 0,
      totalImages: 0,
      totalJobs: 0,
      successfulJobs: 0,
      successRate: 0
    };
  }

  const successRate = stats[0].totalJobs > 0 
    ? (stats[0].successfulJobs / stats[0].totalJobs) * 100 
    : 0;

  return {
    totalProjects: stats[0].totalProjects,
    totalImages: stats[0].totalImages,
    totalJobs: stats[0].totalJobs,
    successfulJobs: stats[0].successfulJobs,
    successRate: Math.round(successRate * 100) / 100
  };
};

export default mongoose.model('Project', projectSchema);