import brevo from '@getbrevo/brevo';

console.log('Testing Brevo v3 authentication...\n');

// Create instance
const apiInstance = new brevo.TransactionalEmailsApi();
console.log('Instance created');

// Check authentications structure
console.log('\nAuthentications object:');
console.log('- apiKey:', apiInstance.authentications.apiKey);
console.log('- partnerKey:', apiInstance.authentications.partnerKey);
console.log('- default:', apiInstance.authentications.default);

// Set API key
const apiKey = 'test-api-key-123';
apiInstance.authentications.apiKey.apiKey = apiKey;
console.log('\nAfter setting API key:');
console.log('- apiKey.apiKey:', apiInstance.authentications.apiKey.apiKey);
console.log('- apiKey.location:', apiInstance.authentications.apiKey.location);
console.log('- apiKey.paramName:', apiInstance.authentications.apiKey.paramName);

// Also check if we need to set partnerKey
apiInstance.authentications.partnerKey.apiKey = apiKey;
console.log('\nAfter setting partnerKey:');
console.log('- partnerKey.apiKey:', apiInstance.authentications.partnerKey.apiKey);

// Test creating SendSmtpEmail
console.log('\nTesting SendSmtpEmail creation:');
const SendSmtpEmail = brevo.SendSmtpEmail;
console.log('SendSmtpEmail constructor:', typeof SendSmtpEmail);

const email = new SendSmtpEmail();
email.subject = 'Test Subject';
email.to = [{ email: 'test@example.com', name: 'Test User' }];
email.sender = { name: 'Test Sender', email: 'sender@example.com' };
email.htmlContent = '<h1>Test</h1>';

console.log('Email object created:', email);
console.log('Email properties:', Object.keys(email).filter(k => !k.startsWith('_')));