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
    enum: ['free', 'basic', 'premium', 'pro'],
    default: 'free'
  },
  subscription: {
    status: {
      type: String,
      enum: ['active', 'canceled', 'past_due', 'trialing'],
      default: 'trialing'
    },
    trialEndsAt: {
      type: Date,
      default: function() {
        const now = new Date();
        return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
      }
    },
    trialUsed: {
      type: Boolean,
      default: false
    },
    currentPeriodEnd: {
      type: Date
    },
    stripeCustomerId: {
      type: String
    },
    stripeSubscriptionId: {
      type: String
    }
  },
  quota: {
    monthlyRequests: {
      type: Number,
      default: function() {
        // Set default quota based on plan
        const planQuotas = {
          'free': 1, // Only 1 free trial image
          'basic': 10,
          'premium': 50,
          'pro': 100
        };
        return planQuotas[this.plan] || 1;
      }
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
  generationAttempts: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other', 'prefer-not-to-say'],
    default: 'prefer-not-to-say'
  },
  preferences: {
    notifications: {
      type: Boolean,
      default: true
    },
    emailUpdates: {
      type: Boolean,
      default: false
    },
    defaultOutfitStyle: {
      type: String,
      enum: ['casual', 'formal', 'street', 'business', 'athletic'],
      default: 'casual'
    },
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'light'
    }
  },
  linkedAccounts: {
    google: {
      type: Boolean,
      default: false
    },
    facebook: {
      type: Boolean,
      default: false
    }
  },
  profilePicture: {
    type: String,
    trim: true
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
  
  // For free users, check trial status
  if (this.plan === 'free') {
    // Check if trial period is still active
    if (now > this.subscription.trialEndsAt) {
      return false; // Trial expired
    }
    
    // Check if trial has been used
    if (this.subscription.trialUsed) {
      return false; // Trial already used
    }
    
    return this.quota.usedThisMonth < this.quota.monthlyRequests;
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
  
  // For free users, mark trial as used after first usage
  if (this.plan === 'free' && !this.subscription.trialUsed) {
    this.subscription.trialUsed = true;
    this.subscription.status = 'canceled'; // Trial ends after first use
  }
  
  this.quota.usedThisMonth += 1;
  return this.save();
};
// Method to increment generation attempts
userSchema.methods.incrementGenerationAttempts = function() {
  this.generationAttempts += 1;
  return this.save();
};

// Method to check trial status
userSchema.methods.getTrialStatus = function() {
  const now = new Date();
  const trialEndsAt = this.subscription.trialEndsAt;
  const trialUsed = this.subscription.trialUsed;
  
  return {
    hasTrialRemaining: !trialUsed && now <= trialEndsAt,
    trialUsed: trialUsed,
    trialEndsAt: trialEndsAt,
    daysRemaining: Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24))
  };
};

// Method to get subscription details
userSchema.methods.getSubscriptionDetails = function() {
  const trialStatus = this.getTrialStatus();
  
  return {
    plan: this.plan,
    status: this.subscription.status,
    trialStatus: trialStatus,
    usage: {
      used: this.quota.usedThisMonth,
      limit: this.quota.monthlyRequests,
      remaining: Math.max(0, this.quota.monthlyRequests - this.quota.usedThisMonth)
    },
    resetDate: this.quota.resetDate,
    currentPeriodEnd: this.subscription.currentPeriodEnd
  };
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