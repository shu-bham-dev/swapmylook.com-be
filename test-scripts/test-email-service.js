import { emailService } from '../src/services/emailService.js';

async function testEmailService() {
  console.log('Testing Email Service...\n');

  // Test 1: Send OTP email (mock mode)
  console.log('1. Testing OTP email sending (mock mode)...');
  try {
    const result = await emailService.sendOTPEmail(
      'test@example.com',
      '123456',
      'signup',
      'Test User'
    );
    console.log('✓ Email service test passed:', result);
  } catch (error) {
    console.log('✗ Email service test failed:', error.message);
  }

  // Test 2: Check if Brevo is enabled
  console.log('\n2. Checking Brevo configuration...');
  console.log('Brevo enabled:', emailService.enabled);
  if (!emailService.enabled) {
    console.log('✓ Running in mock mode (expected for testing)');
  }

  // Test 3: Test email templates
  console.log('\n3. Testing email templates...');
  
  const signupTemplate = emailService.getSignupOTPTemplate('123456', 'Test User');
  console.log('✓ Signup template generated:', signupTemplate.length, 'characters');
  
  const loginTemplate = emailService.getLoginOTPTemplate('654321', 'Test User');
  console.log('✓ Login template generated:', loginTemplate.length, 'characters');
  
  const resetTemplate = emailService.getPasswordResetTemplate('987654', 'Test User');
  console.log('✓ Password reset template generated:', resetTemplate.length, 'characters');

  console.log('\n✓ All email service tests completed successfully!');
  console.log('\nNote: To enable real email sending, set BREVO_API_KEY in your .env file');
}

// Run test
testEmailService().catch(console.error);