import dotenv from 'dotenv';
import brevo from '@getbrevo/brevo';

dotenv.config();

async function testBrevoEmail() {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@swapmylook.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'SwapMyLook';

  console.log('Testing Brevo Email Service...');
  console.log('API Key present:', !!apiKey);
  console.log('Sender Email:', senderEmail);
  console.log('Sender Name:', senderName);

  if (!apiKey) {
    console.error('ERROR: BREVO_API_KEY is not set in environment variables');
    return;
  }

  // Configure Brevo API client for v3
  const transactionalEmailsApi = new brevo.TransactionalEmailsApi();
  
  // Set API key authentication
  transactionalEmailsApi.authentications.apiKey.apiKey = apiKey;
  transactionalEmailsApi.authentications.partnerKey.apiKey = apiKey;

  const sendSmtpEmail = new brevo.SendSmtpEmail();
  sendSmtpEmail.subject = 'Test Email from SwapMyLook';
  sendSmtpEmail.to = [{ email: 'shubhamsahu@yopmail.com', name: 'Test User' }];
  sendSmtpEmail.sender = { name: senderName, email: senderEmail };
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Test Email</title>
    </head>
    <body>
      <h1>Test Email from SwapMyLook</h1>
      <p>This is a test email to verify Brevo integration is working.</p>
      <p>If you receive this email, the OTP system should work correctly.</p>
    </body>
    </html>
  `;

  try {
    console.log('Sending test email...');
    const data = await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    console.log('SUCCESS: Email sent via Brevo SDK');
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('ERROR: Failed to send email via Brevo SDK');
    console.error('Error message:', error.message);
    console.error('Status code:', error.statusCode);
    console.error('Response body:', error.response?.body);
    
    // Try with fetch API as fallback
    console.log('\nTrying with fetch API as fallback...');
    await testBrevoWithFetch();
  }
}

async function testBrevoWithFetch() {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@swapmylook.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'SwapMyLook';

  const url = 'https://api.brevo.com/v3/smtp/email';
  
  const payload = {
    sender: {
      email: senderEmail,
      name: senderName
    },
    to: [{
      email: 'test@example.com',
      name: 'Test User'
    }],
    subject: 'Test Email from SwapMyLook (Fetch API)',
    htmlContent: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Test Email</title>
      </head>
      <body>
        <h1>Test Email from SwapMyLook</h1>
        <p>This is a test email sent via fetch API.</p>
      </body>
      </html>
    `
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Fetch API error:', response.status, errorText);
    } else {
      const result = await response.json();
      console.log('SUCCESS: Email sent via fetch API');
      console.log('Response:', JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('Fetch API failed:', error.message);
  }
}

// Run the test
testBrevoEmail().catch(console.error);