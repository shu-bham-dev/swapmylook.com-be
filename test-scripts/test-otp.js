import mongoose from 'mongoose';
import dotenv from 'dotenv';
import OTP from '../src/models/OTP.js';

// Load environment variables
dotenv.config();

async function testOTPModel() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/swapmylook');
    console.log('Connected to MongoDB');

    // Test OTP generation
    console.log('\n1. Testing OTP generation...');
    const testEmail = 'test@example.com';
    const testPurpose = 'signup';
    
    // Create OTP
    const otp = await OTP.createOTP(testEmail, testPurpose, { name: 'Test User' });
    console.log('OTP created:', {
      email: otp.email,
      code: otp.code,
      purpose: otp.purpose,
      expiresAt: otp.expiresAt
    });

    // Test OTP verification
    console.log('\n2. Testing OTP verification...');
    try {
      await otp.verify(otp.code);
      console.log('✓ OTP verification successful');
    } catch (error) {
      console.log('✗ OTP verification failed:', error.message);
    }

    // Test invalid OTP
    console.log('\n3. Testing invalid OTP...');
    try {
      await otp.verify('000000');
      console.log('✗ Should have failed with invalid OTP');
    } catch (error) {
      console.log('✓ Invalid OTP correctly rejected:', error.message);
    }

    // Test getValidOTP
    console.log('\n4. Testing getValidOTP...');
    const validOTP = await OTP.getValidOTP(testEmail, testPurpose);
    if (validOTP) {
      console.log('✓ Valid OTP found:', validOTP.code);
    } else {
      console.log('✗ No valid OTP found (might be expired or verified)');
    }

    // Clean up
    console.log('\n5. Cleaning up test data...');
    await OTP.deleteMany({ email: testEmail });
    console.log('✓ Test data cleaned up');

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
    process.exit(0);
  }
}

// Run test
testOTPModel();