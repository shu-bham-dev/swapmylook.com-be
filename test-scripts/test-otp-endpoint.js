import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function testOTP() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/swapmylook');
    console.log('✅ Connected to MongoDB');

    // Test OTP model
    const OTP = (await import('../src/models/OTP.js')).default;
    
    // Create a test OTP
    const testOTP = new OTP({
      email: 'test@example.com',
      purpose: 'signup',
      code: '123456',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
      verified: false,
      metadata: { name: 'Test User' }
    });

    await testOTP.save();
    console.log('✅ OTP created successfully:', testOTP._id);

    // Find the OTP
    const foundOTP = await OTP.findOne({ email: 'test@example.com', purpose: 'signup' });
    console.log('✅ OTP found:', foundOTP ? 'Yes' : 'No');

    // Clean up
    await OTP.deleteOne({ _id: testOTP._id });
    console.log('✅ Test OTP cleaned up');

    // Test email service
    const { emailService } = await import('../src/services/emailService.js');
    
    console.log('Testing email service...');
    try {
      await emailService.sendOTP('test@example.com', '123456', 'Test User');
      console.log('✅ Email service test passed (mock mode)');
    } catch (emailError) {
      console.error('❌ Email service error:', emailError.message);
    }

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testOTP();