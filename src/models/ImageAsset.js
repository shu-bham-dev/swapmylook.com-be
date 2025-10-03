import mongoose from 'mongoose';

const imageAssetSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    default: null
  },
  type: {
    type: String,
    enum: ['model', 'outfit', 'output', 'thumbnail'],
    required: true
  },
  storageKey: {
    type: String,
    required: true,
    trim: true
  },
  url: {
    type: String,
    trim: true
  },
  width: {
    type: Number,
    min: 1
  },
  height: {
    type: Number,
    min: 1
  },
  mimeType: {
    type: String,
    required: true,
    enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  },
  sizeBytes: {
    type: Number,
    required: true,
    min: 0
  },
  metadata: {
    filename: String,
    originalName: String,
    uploadDate: {
      type: Date,
      default: Date.now
    },
    exif: mongoose.Schema.Types.Mixed,
    processingTime: Number,
    aiModel: String,
    prompt: String,
    options: mongoose.Schema.Types.Mixed
  },
  originalImageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImageAsset',
    default: null
  },
  nanobananaJobId: {
    type: String,
    default: null
  },
  isPublic: {
    type: Boolean,
    default: false
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
  },
  tags: [{
    type: String,
    trim: true
  }],
  favorite: {
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
      delete ret.storageKey;
      return ret;
    }
  }
});

// Indexes for better query performance
imageAssetSchema.index({ userId: 1, type: 1 });
imageAssetSchema.index({ userId: 1, createdAt: -1 });
imageAssetSchema.index({ type: 1 });
imageAssetSchema.index({ projectId: 1 });
imageAssetSchema.index({ nanobananaJobId: 1 });
imageAssetSchema.index({ isDeleted: 1 });
imageAssetSchema.index({ favorite: 1 });

// Virtual for file extension
imageAssetSchema.virtual('extension').get(function() {
  const mimeToExt = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
  };
  return mimeToExt[this.mimeType] || 'bin';
});

// Virtual for human-readable file size
imageAssetSchema.virtual('sizeFormatted').get(function() {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (this.sizeBytes === 0) return '0 Byte';
  const i = Math.floor(Math.log(this.sizeBytes) / Math.log(1024));
  return Math.round(this.sizeBytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
});

// Virtual for dimensions
imageAssetSchema.virtual('dimensions').get(function() {
  return this.width && this.height ? `${this.width}x${this.height}` : 'Unknown';
});

// Method to soft delete
imageAssetSchema.methods.softDelete = function() {
  this.isDeleted = true;
  this.deletedAt = new Date();
  return this.save();
};

// Method to restore
imageAssetSchema.methods.restore = function() {
  this.isDeleted = false;
  this.deletedAt = null;
  return this.save();
};

// Static method to get user's storage usage
imageAssetSchema.statics.getStorageUsage = async function(userId) {
  const result = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        isDeleted: false
      }
    },
    {
      $group: {
        _id: null,
        totalBytes: { $sum: '$sizeBytes' },
        totalFiles: { $sum: 1 },
        byType: {
          $push: {
            type: '$type',
            size: '$sizeBytes'
          }
        }
      }
    }
  ]);

  if (result.length === 0) {
    return {
      totalBytes: 0,
      totalFiles: 0,
      byType: {}
    };
  }

  const byType = {};
  result[0].byType.forEach(item => {
    if (!byType[item.type]) {
      byType[item.type] = { count: 0, size: 0 };
    }
    byType[item.type].count += 1;
    byType[item.type].size += item.size;
  });

  return {
    totalBytes: result[0].totalBytes,
    totalFiles: result[0].totalFiles,
    byType
  };
};

export default mongoose.model('ImageAsset', imageAssetSchema);