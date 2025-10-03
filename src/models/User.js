import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  googleId: {
    type: String,
    unique: true,
    sparse: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  avatarUrl: {
    type: String,
    trim: true
  },
  plan: {
    type: String,
    enum: ['free', 'pro', 'enterprise'],
    default: 'free'
  },
  quota: {
    monthlyRequests: {
      type: Number,
      default: 100
    },
    usedThisMonth: {
      type: Number,
      default: 0
    },
    resetDate: {
      type: Date,
      default: function() {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth() + 1, 1);
      }
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  preferences: {
    notifications: {
      type: Boolean,
      default: true
    },
    emailUpdates: {
      type: Boolean,
      default: false
    }
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      delete ret.googleId;
      return ret;
    }
  }
});

// Index for better query performance
userSchema.index({ email: 1 });
userSchema.index({ googleId: 1 });
userSchema.index({ createdAt: -1 });

// Method to check if user has available quota
userSchema.methods.hasAvailableQuota = function() {
  const now = new Date();
  
  // Reset quota if it's a new month
  if (now > this.quota.resetDate) {
    this.quota.usedThisMonth = 0;
    this.quota.resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  
  return this.quota.usedThisMonth < this.quota.monthlyRequests;
};

// Method to increment usage
userSchema.methods.incrementUsage = function() {
  const now = new Date();
  
  // Reset quota if it's a new month
  if (now > this.quota.resetDate) {
    this.quota.usedThisMonth = 0;
    this.quota.resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  
  this.quota.usedThisMonth += 1;
  return this.save();
};

// Static method to find or create user from Google profile
userSchema.statics.findOrCreate = async function(profile) {
  let user = await this.findOne({ googleId: profile.id });
  
  if (!user) {
    user = await this.findOne({ email: profile.emails[0].value });
    
    if (!user) {
      // Create new user
      user = new this({
        googleId: profile.id,
        email: profile.emails[0].value,
        name: profile.displayName,
        avatarUrl: profile.photos?.[0]?.value
      });
      await user.save();
    } else {
      // Update existing user with Google ID
      user.googleId = profile.id;
      user.avatarUrl = profile.photos?.[0]?.value;
      await user.save();
    }
  }
  
  // Update last login
  user.lastLogin = new Date();
  await user.save();
  
  return user;
};

export default mongoose.model('User', userSchema);