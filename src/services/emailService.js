import { createLogger } from '../utils/logger.js';
import brevo from '@getbrevo/brevo';

const logger = createLogger('email-service');

class EmailService {
  constructor() {
    this.brevoApiKey = process.env.BREVO_API_KEY;
    this.brevoSenderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@swapmylook.com';
    this.brevoSenderName = process.env.BREVO_SENDER_NAME || 'SwapMyLook';
    this.enabled = !!this.brevoApiKey;
    
    logger.debug('Email service constructor', {
      hasApiKey: !!this.brevoApiKey,
      apiKeyLength: this.brevoApiKey ? this.brevoApiKey.length : 0,
      apiKeyPreview: this.brevoApiKey ? this.brevoApiKey.substring(0, 10) + '...' : 'none',
      envValue: process.env.BREVO_API_KEY ? 'present' : 'missing'
    });
    
    if (!this.enabled) {
      logger.warn('Brevo API key not found. Email service will use mock mode.');
      logger.warn('Check .env file and ensure dotenv.config() is called before importing email service.');
    } else {
      this.initializeBrevoClient();
    }
  }

  /**
   * Initialize Brevo client (can be called again if API key becomes available)
   */
  initializeBrevoClient() {
    try {
      // Configure Brevo API client for v3
      this.transactionalEmailsApi = new brevo.TransactionalEmailsApi();
      
      // Set API key authentication
      this.transactionalEmailsApi.authentications.apiKey.apiKey = this.brevoApiKey;
      this.transactionalEmailsApi.authentications.partnerKey.apiKey = this.brevoApiKey;
      
      logger.info('Brevo email service initialized successfully');
      this.enabled = true;
    } catch (error) {
      logger.error('Failed to initialize Brevo client', { error: error.message });
      this.enabled = false;
    }
  }

  /**
   * Check if email service is enabled, re-initialize if needed
   */
  checkAndEnableService() {
    // Re-check environment variable in case it was set after constructor
    const currentApiKey = process.env.BREVO_API_KEY;
    if (!this.enabled && currentApiKey) {
      logger.info('API key now available, re-initializing email service');
      this.brevoApiKey = currentApiKey;
      this.initializeBrevoClient();
    }
    return this.enabled;
  }

  /**
   * Send OTP email using Brevo API
   */
  async sendOTPEmail(email, otpCode, purpose = 'signup', name = 'User') {
    try {
      let subject, htmlContent;
      
      switch (purpose) {
        case 'signup':
          subject = `Verify your email for SwapMyLook - Your OTP is ${otpCode}`;
          htmlContent = this.getSignupOTPTemplate(otpCode, name);
          break;
        case 'login':
          subject = `Login to SwapMyLook - Your OTP is ${otpCode}`;
          htmlContent = this.getLoginOTPTemplate(otpCode, name);
          break;
        case 'password_reset':
          subject = `Reset your SwapMyLook password - Your OTP is ${otpCode}`;
          htmlContent = this.getPasswordResetTemplate(otpCode, name);
          break;
        default:
          subject = `Your SwapMyLook verification code is ${otpCode}`;
          htmlContent = this.getGenericOTPTemplate(otpCode, name);
      }

      // Check if service should be enabled (in case API key was set after constructor)
      this.checkAndEnableService();
      
      if (this.enabled) {
        return await this.sendViaBrevoSDK(email, subject, htmlContent);
      } else {
        // Mock mode for development
        logger.info(`Mock email sent to ${email}: OTP ${otpCode} for ${purpose}`);
        return { success: true, message: 'Mock email sent' };
      }
    } catch (error) {
      logger.error('Failed to send OTP email', { error: error.message, email });
      throw new Error('Failed to send verification email');
    }
  }

  /**
   * Send email using Brevo SDK
   */
  async sendViaBrevoSDK(email, subject, htmlContent) {
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.to = [{ email: email, name: email.split('@')[0] }];
    sendSmtpEmail.sender = {
      name: this.brevoSenderName,
      email: this.brevoSenderEmail
    };
    sendSmtpEmail.htmlContent = htmlContent;

    try {
      const data = await this.transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
      // Brevo v3 SDK returns response with body.messageId structure
      const messageId = data.body?.messageId || data.messageId;
      logger.info('Email sent via Brevo SDK', { messageId, email });
      return { success: true, messageId };
    } catch (error) {
      logger.error('Brevo SDK error', {
        error: error.message,
        statusCode: error.statusCode,
        responseBody: error.response?.body
      });
      throw new Error(`Brevo API error: ${error.statusCode || 'Unknown error'}`);
    }
  }

  /**
   * Email templates
   */
  getSignupOTPTemplate(otpCode, name) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify Your Email - SwapMyLook</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.6;
          color: #1f2937;
          background: linear-gradient(to bottom right, #fdf2f8, #ffffff, #faf5ff);
          min-height: 100vh;
          padding: 40px 20px;
        }
        .email-wrapper {
          max-width: 600px;
          margin: 0 auto;
        }
        .card {
          background: white;
          border-radius: 16px;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05);
          overflow: hidden;
          margin-bottom: 20px;
          border: 1px solid #f3e8ff;
        }
        .header-card {
          text-align: center;
          padding: 40px 30px;
        }
        .logo-wrapper {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 64px;
          height: 64px;
          background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
          border-radius: 16px;
          margin-bottom: 20px;
        }
        .logo-wrapper svg {
          width: 32px;
          height: 32px;
          color: white;
        }
        .header-card h1 {
          font-size: 28px;
          font-weight: 700;
          background: linear-gradient(to right, #ec4899, #8b5cf6);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          margin-bottom: 10px;
          letter-spacing: -0.5px;
        }
        .header-card p {
          font-size: 16px;
          color: #6b7280;
        }
        .content-card {
          padding: 30px;
        }
        .greeting {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 20px;
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 20px;
          padding: 12px;
          background: #fdf2f8;
          border-radius: 8px;
        }
        .greeting svg {
          color: #ec4899;
          flex-shrink: 0;
        }
        .text-content {
          font-size: 16px;
          color: #4b5563;
          margin-bottom: 20px;
        }
        .brand-name {
          color: #8b5cf6;
          font-weight: 600;
        }
        .otp-card {
          background: linear-gradient(135deg, #fdf2f8 0%, #faf5ff 100%);
          border: 2px solid #f3e8ff;
          border-radius: 12px;
          padding: 30px;
          text-align: center;
          margin: 30px 0;
          position: relative;
          overflow: hidden;
        }
        .otp-card::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 4px;
          background: linear-gradient(90deg, #ec4899, #8b5cf6);
        }
        .otp-label {
          display: block;
          font-size: 12px;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 1px;
          font-weight: 600;
          margin-bottom: 15px;
        }
        .otp-code {
          font-size: 48px;
          font-weight: 800;
          letter-spacing: 12px;
          color: #8b5cf6;
          margin: 10px 0;
          text-align: center;
        }
        .expiry-note {
          font-size: 14px;
          color: #9ca3af;
          font-style: italic;
          margin-top: 10px;
        }
        .info-card {
          background: #eff6ff;
          border: 1px solid #dbeafe;
          border-radius: 10px;
          padding: 20px;
          margin: 20px 0;
        }
        .info-card-title {
          font-size: 16px;
          font-weight: 600;
          color: #1e40af;
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .info-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .info-list li {
          padding: 10px 0 10px 30px;
          position: relative;
          color: #1e40af;
          font-size: 14px;
          border-bottom: 1px solid #dbeafe;
        }
        .info-list li:last-child {
          border-bottom: none;
        }
        .info-list li::before {
          position: absolute;
          left: 0;
          top: 50%;
          transform: translateY(-50%);
          font-size: 16px;
        }
        .info-list li:nth-child(1)::before { content: '👗'; }
        .info-list li:nth-child(2)::before { content: '✨'; }
        .info-list li:nth-child(3)::before { content: '💾'; }
        .info-list li:nth-child(4)::before { content: '🎯'; }
        .footer-card {
          text-align: center;
          padding: 25px 30px;
          background: #f9fafb;
          color: #6b7280;
          font-size: 13px;
          border-top: 1px solid #f3f4f6;
        }
        .footer-card p {
          margin: 8px 0;
          line-height: 1.5;
        }
        .separator {
          height: 1px;
          background: #e5e7eb;
          margin: 25px 0;
        }
        @media (max-width: 480px) {
          body {
            padding: 20px 10px;
          }
          .header-card {
            padding: 30px 20px;
          }
          .header-card h1 {
            font-size: 24px;
          }
          .content-card {
            padding: 25px 20px;
          }
          .otp-code {
            font-size: 40px;
            letter-spacing: 8px;
          }
        }
      </style>
    </head>
    <body>
      <div class="email-wrapper">
        <!-- Header Card -->
        <div class="card">
          <div class="header-card">
            <div class="logo-wrapper">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
              </svg>
            </div>
            <h1>Welcome to SwapMyLook!</h1>
            <p>Transform your style with AI-powered fashion</p>
          </div>
        </div>

        <!-- Content Card -->
        <div class="card">
          <div class="content-card">
            <div class="greeting">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              <span>Hi ${name},</span>
            </div>

            <p class="text-content">
              Thank you for signing up for <strong class="brand-name">SwapMyLook</strong>! To complete your registration and start creating amazing fashion combinations, please verify your email address.
            </p>

            <!-- OTP Card -->
            <div class="otp-card">
              <span class="otp-label">Your Verification Code</span>
              <div class="otp-code">${otpCode}</div>
              <p class="expiry-note">This code will expire in 10 minutes</p>
            </div>

            <p class="text-content">
              If you didn't request this code, please ignore this email.
            </p>

            <div class="separator"></div>

            <!-- Features Info Card -->
            <div class="info-card">
              <div class="info-card-title">
                <span>✨</span>
                <span>Once verified, you'll be able to:</span>
              </div>
              <ul class="info-list">
                <li>Upload your photos and outfit images</li>
                <li>Generate AI-powered fashion combinations</li>
                <li>Save and organize your favorite looks</li>
                <li>Get personalized style recommendations</li>
              </ul>
            </div>

            <p class="text-content">
              If you have any questions, feel free to reply to this email.
            </p>

            <p class="text-content">
              Best regards,<br>
              <strong>The SwapMyLook Team</strong>
            </p>
          </div>

          <!-- Footer Card -->
          <div class="footer-card">
            <p>© ${new Date().getFullYear()} SwapMyLook. All rights reserved.</p>
            <p>If you didn't sign up for SwapMyLook, please ignore this email.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

  getLoginOTPTemplate(otpCode, name) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Login Verification - SwapMyLook</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #1f2937;
            background: linear-gradient(to bottom right, #fdf2f8, #ffffff, #faf5ff);
            min-height: 100vh;
            padding: 40px 20px;
          }
          .email-wrapper {
            max-width: 600px;
            margin: 0 auto;
          }
          .card {
            background: white;
            border-radius: 16px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05);
            overflow: hidden;
            margin-bottom: 20px;
            border: 1px solid #f3e8ff;
          }
          .header-card {
            text-align: center;
            padding: 40px 30px;
          }
          .logo-wrapper {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 64px;
            height: 64px;
            background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
            border-radius: 16px;
            margin-bottom: 20px;
          }
          .logo-wrapper svg {
            width: 32px;
            height: 32px;
            color: white;
          }
          .header-card h1 {
            font-size: 28px;
            font-weight: 700;
            background: linear-gradient(to right, #ec4899, #8b5cf6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 10px;
            letter-spacing: -0.5px;
          }
          .header-card p {
            font-size: 16px;
            color: #6b7280;
          }
          .content-card {
            padding: 30px;
          }
          .greeting {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 20px;
            font-weight: 600;
            color: #1f2937;
            margin-bottom: 20px;
            padding: 12px;
            background: #fdf2f8;
            border-radius: 8px;
          }
          .greeting svg {
            color: #ec4899;
            flex-shrink: 0;
          }
          .text-content {
            font-size: 16px;
            color: #4b5563;
            margin-bottom: 20px;
          }
          .brand-name {
            color: #8b5cf6;
            font-weight: 600;
          }
          .otp-card {
            background: linear-gradient(135deg, #fdf2f8 0%, #faf5ff 100%);
            border: 2px solid #f3e8ff;
            border-radius: 12px;
            padding: 30px;
            text-align: center;
            margin: 30px 0;
            position: relative;
            overflow: hidden;
          }
          .otp-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #ec4899, #8b5cf6);
          }
          .otp-label {
            display: block;
            font-size: 12px;
            color: #6b7280;
            text-transform: uppercase;
            letter-spacing: 1px;
            font-weight: 600;
            margin-bottom: 15px;
          }
          .otp-code {
            font-size: 48px;
            font-weight: 800;
            letter-spacing: 12px;
            color: #8b5cf6;
            margin: 10px 0;
            text-align: center;
          }
          .expiry-note {
            font-size: 14px;
            color: #9ca3af;
            font-style: italic;
            margin-top: 10px;
          }
          .warning-card {
            background: #fef2f2;
            border: 1px solid #fecaca;
            border-radius: 10px;
            padding: 16px;
            margin: 20px 0;
            display: flex;
            align-items: start;
            gap: 12px;
          }
          .warning-card svg {
            color: #dc2626;
            flex-shrink: 0;
            margin-top: 2px;
          }
          .warning-card p {
            color: #991b1b;
            font-size: 14px;
            margin: 0;
          }
          .security-card {
            background: #fef3c7;
            border: 1px solid #fde68a;
            border-radius: 10px;
            padding: 20px;
            margin: 20px 0;
          }
          .security-card-title {
            font-size: 16px;
            font-weight: 600;
            color: #92400e;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .security-list {
            list-style: none;
            padding: 0;
            margin: 0;
          }
          .security-list li {
            padding: 10px 0 10px 30px;
            position: relative;
            color: #92400e;
            font-size: 14px;
            border-bottom: 1px solid #fde68a;
          }
          .security-list li:last-child {
            border-bottom: none;
          }
          .security-list li::before {
            position: absolute;
            left: 0;
            top: 50%;
            transform: translateY(-50%);
            font-size: 16px;
          }
          .security-list li:nth-child(1)::before { content: '🔒'; }
          .security-list li:nth-child(2)::before { content: '📱'; }
          .security-list li:nth-child(3)::before { content: '🔑'; }
          .footer-card {
            text-align: center;
            padding: 25px 30px;
            background: #f9fafb;
            color: #6b7280;
            font-size: 13px;
            border-top: 1px solid #f3f4f6;
          }
          .footer-card p {
            margin: 8px 0;
            line-height: 1.5;
          }
          .separator {
            height: 1px;
            background: #e5e7eb;
            margin: 25px 0;
          }
          @media (max-width: 480px) {
            body {
              padding: 20px 10px;
            }
            .header-card {
              padding: 30px 20px;
            }
            .header-card h1 {
              font-size: 24px;
            }
            .content-card {
              padding: 25px 20px;
            }
            .otp-code {
              font-size: 40px;
              letter-spacing: 8px;
            }
          }
        </style>
      </head>
      <body>
        <div class="email-wrapper">
          <!-- Header Card -->
          <div class="card">
            <div class="header-card">
              <div class="logo-wrapper">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
                </svg>
              </div>
              <h1>Login Verification</h1>
              <p>Secure access to your SwapMyLook account</p>
            </div>
          </div>

          <!-- Content Card -->
          <div class="card">
            <div class="content-card">
              <div class="greeting">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
                <span>Hi ${name},</span>
              </div>

              <p class="text-content">
                We received a login attempt for your <strong class="brand-name">SwapMyLook</strong> account. To complete the login, please use the verification code below:
              </p>

              <!-- OTP Card -->
              <div class="otp-card">
                <span class="otp-label">Your Verification Code</span>
                <div class="otp-code">${otpCode}</div>
                <p class="expiry-note">This code will expire in 10 minutes</p>
              </div>

              <!-- Warning Card -->
              <div class="warning-card">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 9v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
                </svg>
                <p>If you didn't attempt to log in, please secure your account immediately.</p>
              </div>

              <div class="separator"></div>

              <!-- Security Tips Card -->
              <div class="security-card">
                <div class="security-card-title">
                  <span>🔒</span>
                  <span>Security Tips:</span>
                </div>
                <ul class="security-list">
                  <li>Never share your verification codes with anyone</li>
                  <li>Make sure you're logging in from a trusted device</li>
                  <li>Use a strong, unique password for your account</li>
                </ul>
              </div>

              <p class="text-content">
                If you have any concerns about your account security, please contact our support team.
              </p>

              <p class="text-content">
                Best regards,<br>
                <strong>The SwapMyLook Team</strong>
              </p>
            </div>

            <!-- Footer Card -->
            <div class="footer-card">
              <p>© ${new Date().getFullYear()} SwapMyLook. All rights reserved.</p>
              <p>This email was sent for security verification.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  getPasswordResetTemplate(otpCode, name) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset - SwapMyLook</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #374151;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #fef2f2;
          }
          .container {
            background: white;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05);
            border: 1px solid #fee2e2;
          }
          .header {
            background: linear-gradient(135deg, #ef4444 0%, #f97316 100%);
            color: white;
            padding: 40px 30px 30px;
            text-align: center;
            position: relative;
            overflow: hidden;
          }
          .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M30,30 L70,30 L70,70 L30,70 Z" fill="rgba(255,255,255,0.1)"/><circle cx="50" cy="50" r="15" fill="rgba(255,255,255,0.1)"/></svg>');
            background-size: 200px;
            opacity: 0.3;
          }
          .logo-container {
            display: inline-block;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 50%;
            padding: 15px;
            margin-bottom: 20px;
          }
          .header h1 {
            font-size: 28px;
            font-weight: 700;
            margin: 0 0 10px;
            letter-spacing: -0.5px;
          }
          .header p {
            font-size: 16px;
            margin: 0;
            opacity: 0.9;
          }
          .content {
            background: white;
            padding: 40px 30px;
          }
          .greeting {
            font-size: 20px;
            font-weight: 600;
            color: #1f2937;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .content p {
            font-size: 16px;
            margin-bottom: 20px;
            color: #4b5563;
          }
          .otp-container {
            text-align: center;
            margin: 30px 0;
          }
          .otp-label {
            display: block;
            font-size: 14px;
            color: #6b7280;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
            font-weight: 600;
          }
          .otp-code {
            font-size: 42px;
            font-weight: 800;
            letter-spacing: 15px;
            text-align: center;
            color: #ef4444;
            background: linear-gradient(135deg, #fef2f2 0%, #fffbeb 100%);
            padding: 25px 20px;
            border-radius: 12px;
            margin: 10px auto;
            border: 2px dashed #fca5a5;
            display: inline-block;
            min-width: 320px;
            box-shadow: 0 4px 12px rgba(239, 68, 68, 0.08);
            position: relative;
            overflow: hidden;
          }
          .otp-code::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #ef4444, #f97316);
          }
          .expiry-note {
            font-size: 14px;
            color: #9ca3af;
            margin-top: 10px;
            font-style: italic;
          }
          .warning-box {
            margin: 30px 0;
            padding: 0;
            background: #fef3c7;
            border-radius: 10px;
            padding: 20px;
            border-left: 4px solid #f59e0b;
          }
          .warning-box h3 {
            font-size: 18px;
            font-weight: 600;
            color: #92400e;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .warning-box ul {
            list-style: none;
            padding: 0;
            margin: 0;
          }
          .warning-box li {
            padding: 10px 0 10px 35px;
            position: relative;
            border-bottom: 1px solid #fde68a;
          }
          .warning-box li:last-child {
            border-bottom: none;
          }
          .warning-box li::before {
            content: '';
            position: absolute;
            left: 0;
            top: 10px;
            width: 20px;
            height: 20px;
            background-color: #fbbf24;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 12px;
          }
          .warning-box li:nth-child(1)::before { content: '⚠️'; }
          .warning-box li:nth-child(2)::before { content: '🔒'; }
          .warning-box li:nth-child(3)::before { content: '⏱️'; }
          .footer {
            text-align: center;
            padding: 25px 30px;
            background: #f9fafb;
            color: #6b7280;
            font-size: 13px;
            border-top: 1px solid #f3f4f6;
          }
          .footer p {
            margin: 8px 0;
            line-height: 1.5;
          }
          .brand-name {
            color: #ef4444;
            font-weight: 600;
          }
          .security-alert {
            background: #fef2f2;
            border: 1px solid #fecaca;
            color: #991b1b;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          @media (max-width: 480px) {
            .container { margin: 10px; }
            .header { padding: 30px 20px 25px; }
            .header h1 { font-size: 24px; }
            .content { padding: 30px 20px; }
            .otp-code {
              font-size: 36px;
              letter-spacing: 10px;
              min-width: 280px;
              padding: 20px 15px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 15V18M12 21H12.01M17 7C17 9.76142 14.7614 12 12 12C9.23858 12 7 9.76142 7 7C7 4.23858 9.23858 2 12 2C14.7614 2 17 4.23858 17 7Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h1>Password Reset Request</h1>
            <p>Reset your SwapMyLook account password</p>
          </div>
          
          <div class="content">
            <div class="greeting">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M12 11C14.2091 11 16 9.20914 16 7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7C8 9.20914 9.79086 11 12 11Z" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>Hi ${name},</span>
            </div>
            
            <p>We received a request to reset the password for your <strong class="brand-name">SwapMyLook</strong> account. To proceed with the password reset, please use the verification code below:</p>
            
            <div class="otp-container">
              <span class="otp-label">Your Verification Code</span>
              <div class="otp-code">${otpCode}</div>
              <p class="expiry-note">This code will expire in 10 minutes.</p>
            </div>
            
            <div class="security-alert">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 9V12M12 15H12.01M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="#991b1b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>If you didn't request a password reset, please ignore this email and ensure your account is secure.</span>
            </div>
            
            <div class="warning-box">
              <h3>⚠️ Important Security Notes:</h3>
              <ul>
                <li>This code can only be used to reset your password</li>
                <li>Do not share this code with anyone</li>
                <li>The code expires in 10 minutes for security</li>
              </ul>
            </div>
            
            <p>If you have any questions or need assistance, please contact our support team.</p>
            
            <p>Best regards,<br><strong>The SwapMyLook Team</strong></p>
          </div>
          
          <div class="footer">
            <p>© ${new Date().getFullYear()} SwapMyLook. All rights reserved.</p>
            <p>This email was sent for password reset verification.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  getGenericOTPTemplate(otpCode, name) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verification Code - SwapMyLook</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #374151;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f0fdf4;
          }
          .container {
            background: white;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05);
            border: 1px solid #dcfce7;
          }
          .header {
            background: linear-gradient(135deg, #10b981 0%, #3b82f6 100%);
            color: white;
            padding: 40px 30px 30px;
            text-align: center;
            position: relative;
            overflow: hidden;
          }
          .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M50,20 Q70,10 90,20 T100,50 Q90,80 70,90 T50,80 Q30,70 20,50 T30,20 Q40,10 50,20 Z" fill="rgba(255,255,255,0.1)"/><circle cx="40" cy="40" r="8" fill="rgba(255,255,255,0.1)"/><circle cx="60" cy="60" r="6" fill="rgba(255,255,255,0.1)"/></svg>');
            background-size: 200px;
            opacity: 0.3;
          }
          .logo-container {
            display: inline-block;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 50%;
            padding: 15px;
            margin-bottom: 20px;
          }
          .header h1 {
            font-size: 28px;
            font-weight: 700;
            margin: 0 0 10px;
            letter-spacing: -0.5px;
          }
          .header p {
            font-size: 16px;
            margin: 0;
            opacity: 0.9;
          }
          .content {
            background: white;
            padding: 40px 30px;
          }
          .greeting {
            font-size: 20px;
            font-weight: 600;
            color: #1f2937;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .content p {
            font-size: 16px;
            margin-bottom: 20px;
            color: #4b5563;
          }
          .otp-container {
            text-align: center;
            margin: 30px 0;
          }
          .otp-label {
            display: block;
            font-size: 14px;
            color: #6b7280;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
            font-weight: 600;
          }
          .otp-code {
            font-size: 42px;
            font-weight: 800;
            letter-spacing: 15px;
            text-align: center;
            color: #10b981;
            background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%);
            padding: 25px 20px;
            border-radius: 12px;
            margin: 10px auto;
            border: 2px dashed #a7f3d0;
            display: inline-block;
            min-width: 320px;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.08);
            position: relative;
            overflow: hidden;
          }
          .otp-code::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #10b981, #3b82f6);
          }
          .expiry-note {
            font-size: 14px;
            color: #9ca3af;
            margin-top: 10px;
            font-style: italic;
          }
          .security-note {
            margin: 30px 0;
            padding: 0;
            background: #fef3c7;
            border-radius: 10px;
            padding: 20px;
            border-left: 4px solid #f59e0b;
          }
          .security-note h3 {
            font-size: 18px;
            font-weight: 600;
            color: #92400e;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .security-note ul {
            list-style: none;
            padding: 0;
            margin: 0;
          }
          .security-note li {
            padding: 10px 0 10px 35px;
            position: relative;
            border-bottom: 1px solid #fde68a;
          }
          .security-note li:last-child {
            border-bottom: none;
          }
          .security-note li::before {
            content: '';
            position: absolute;
            left: 0;
            top: 10px;
            width: 20px;
            height: 20px;
            background-color: #fbbf24;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 12px;
          }
          .security-note li:nth-child(1)::before { content: '🔒'; }
          .security-note li:nth-child(2)::before { content: '⏱️'; }
          .security-note li:nth-child(3)::before { content: '👁️'; }
          .footer {
            text-align: center;
            padding: 25px 30px;
            background: #f9fafb;
            color: #6b7280;
            font-size: 13px;
            border-top: 1px solid #f3f4f6;
          }
          .footer p {
            margin: 8px 0;
            line-height: 1.5;
          }
          .brand-name {
            color: #10b981;
            font-weight: 600;
          }
          .info-box {
            background: #eff6ff;
            border: 1px solid #dbeafe;
            color: #1e40af;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          @media (max-width: 480px) {
            .container { margin: 10px; }
            .header { padding: 30px 20px 25px; }
            .header h1 { font-size: 24px; }
            .content { padding: 30px 20px; }
            .otp-code {
              font-size: 36px;
              letter-spacing: 10px;
              min-width: 280px;
              padding: 20px 15px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h1>Verification Code</h1>
            <p>Your SwapMyLook verification code</p>
          </div>
          
          <div class="content">
            <div class="greeting">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M12 11C14.2091 11 16 9.20914 16 7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7C8 9.20914 9.79086 11 12 11Z" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>Hi ${name},</span>
            </div>
            
            <p>Please use the following verification code to complete your action on <strong class="brand-name">SwapMyLook</strong>:</p>
            
            <div class="otp-container">
              <span class="otp-label">Your Verification Code</span>
              <div class="otp-code">${otpCode}</div>
              <p class="expiry-note">This code will expire in 10 minutes.</p>
            </div>
            
            <div class="info-box">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 16V12M12 8H12.01M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z" stroke="#1e40af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>If you didn't request this code, please ignore this email.</span>
            </div>
            
            <div class="security-note">
              <h3>🔒 Security Guidelines:</h3>
              <ul>
                <li>For security reasons, do not share this code with anyone</li>
                <li>The code expires in 10 minutes for your protection</li>
                <li>Keep your verification codes confidential at all times</li>
              </ul>
            </div>
            
            <p>If you have any questions or need assistance, please contact our support team.</p>
            
            <p>Best regards,<br><strong>The SwapMyLook Team</strong></p>
          </div>
          
          <div class="footer">
            <p>© ${new Date().getFullYear()} SwapMyLook. All rights reserved.</p>
            <p>This email was sent for verification purposes.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

export const emailService = new EmailService();