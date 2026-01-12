import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  code: {
    type: String,
    required: true,
    length: 6
  },
  purpose: {
    type: String,
    enum: ['signup', 'login', 'password_reset', 'email_change'],
    default: 'signup'
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: '10m' } // Auto delete after 10 minutes
  },
  verified: {
    type: Boolean,
    default: false
  },
  attempts: {
    type: Number,
    default: 0,
    max: 5
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    name: String // Store name for signup purposes
  }
}, {
  timestamps: true
});

// Index for faster queries
otpSchema.index({ email: 1, purpose: 1, verified: 1 });
otpSchema.index({ createdAt: 1 });

// Static method to generate a 6-digit OTP
otpSchema.statics.generateOTP = function() {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Static method to create and save OTP
otpSchema.statics.createOTP = async function(email, purpose, metadata = {}) {
  const OTP = mongoose.model('OTP');
  
  // Invalidate any existing OTPs for this email and purpose
  await OTP.updateMany(
    { email, purpose, verified: false },
    { $set: { verified: true } } // Mark as verified to prevent reuse
  );
  
  const code = OTP.generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
  
  const otp = new OTP({
    email,
    code,
    purpose,
    expiresAt,
    metadata
  });
  
  await otp.save();
  return otp;
};

// Method to verify OTP
otpSchema.methods.verify = async function(inputCode) {
  if (this.verified) {
    throw new Error('OTP already verified');
  }
  
  if (this.expiresAt < new Date()) {
    throw new Error('OTP has expired');
  }
  
  if (this.attempts >= 5) {
    throw new Error('Maximum verification attempts exceeded');
  }
  
  this.attempts += 1;
  
  if (this.code !== inputCode) {
    await this.save();
    throw new Error('Invalid OTP code');
  }
  
  this.verified = true;
  await this.save();
  return true;
};

// Static method to get valid OTP for email
otpSchema.statics.getValidOTP = async function(email, purpose) {
  const otp = await this.findOne({
    email,
    purpose,
    verified: false,
    expiresAt: { $gt: new Date() },
    attempts: { $lt: 5 }
  }).sort({ createdAt: -1 });
  
  return otp;
};

export default mongoose.model('OTP', otpSchema);