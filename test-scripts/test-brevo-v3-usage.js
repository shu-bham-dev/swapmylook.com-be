import brevo from '@getbrevo/brevo';

console.log('Testing Brevo v3 usage...\n');

// Check TransactionalEmailsApi
console.log('TransactionalEmailsApi:', brevo.TransactionalEmailsApi);
console.log('TransactionalEmailsApi constructor:', typeof brevo.TransactionalEmailsApi);

// Check if there's a default client configuration
console.log('\nChecking APIS array...');
console.log('APIS:', brevo.APIS);
console.log('APIS length:', brevo.APIS?.length);

// Look at the ApiKeyAuth
console.log('\nApiKeyAuth:', brevo.ApiKeyAuth);
console.log('ApiKeyAuth constructor:', typeof brevo.ApiKeyAuth);

// Try to create an instance with API key
const apiKey = process.env.BREVO_API_KEY || 'test-key';
console.log('\nAPI Key present:', !!apiKey);

// According to Brevo v3 documentation, we need to create an instance
// and set authentication on that instance
try {
  const apiInstance = new brevo.TransactionalEmailsApi();
  console.log('API instance created:', apiInstance);
  
  // Check authentication methods
  console.log('\nChecking instance properties...');
  console.log('Instance has apiKey?', 'apiKey' in apiInstance);
  console.log('Instance keys:', Object.keys(apiInstance).filter(k => !k.startsWith('_')));
  
  // Check the authentication property
  console.log('\nChecking authentication property...');
  if (apiInstance.authentications) {
    console.log('Authentications:', Object.keys(apiInstance.authentications));
    console.log('api-key auth:', apiInstance.authentications['api-key']);
  }
} catch (error) {
  console.error('Error creating instance:', error.message);
}