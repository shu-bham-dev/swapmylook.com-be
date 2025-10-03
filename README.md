# SwapMyLook Backend

A Node.js + Express backend for AI-powered outfit changing application. This service handles user authentication, file uploads, AI image generation, and job processing.

## Features

- **User Authentication**: Google OAuth2 with JWT tokens
- **File Management**: Secure upload/download with object storage (S3-compatible)
- **AI Image Generation**: Integration with nanobanana API for outfit changing
- **Job Queue**: Redis-based job processing with BullMQ
- **Rate Limiting**: Per-user rate limiting and quota management
- **RESTful API**: Comprehensive API for frontend integration
- **Admin Dashboard**: Administrative functions and system monitoring

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Cache/Queue**: Redis with BullMQ
- **Storage**: S3-compatible object storage (Backblaze B2, DigitalOcean Spaces, AWS S3)
- **Authentication**: Passport.js with Google OAuth2
- **Image Processing**: Sharp for thumbnails
- **Logging**: Winston with daily rotation
- **Validation**: Joi for request validation

## Quick Start

### Prerequisites

- Node.js 18+
- MongoDB 5+
- Redis 6+
- Object storage account (Backblaze B2, DigitalOcean Spaces, or AWS S3)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd swapmylook-be
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment configuration**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your configuration:
   ```env
   # Server
   NODE_ENV=development
   PORT=3001
   APP_URL=http://localhost:3001
   FRONTEND_URL=http://localhost:3000

   # Database
   MONGO_URI=mongodb://localhost:27017/swapmylook

   # Redis
   REDIS_URL=redis://localhost:6379

   # JWT
   JWT_SECRET=your-super-secret-jwt-key-here
   JWT_EXPIRES_IN=1h

   # Google OAuth
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   GOOGLE_CALLBACK_URL=http://localhost:3001/api/v1/auth/google/callback

   # Object Storage (Backblaze B2 example)
   STORAGE_PROVIDER=b2
   B2_KEY_ID=your-b2-key-id
   B2_APP_KEY=your-b2-application-key
   B2_BUCKET=your-bucket-name
   B2_ENDPOINT=your-b2-endpoint

   # nanobanana API
   NANOBANANA_API_KEY=your-nanobanana-api-key
   NANOBANANA_BASE_URL=https://api.nanobanana.ai

   # Rate Limiting
   RATE_LIMIT_PER_HOUR=100
   ```

4. **Start the development server**
   ```bash
   npm run dev
   ```

5. **Start the worker process** (in separate terminal)
   ```bash
   npm run worker
   ```

## API Documentation

### Authentication Endpoints

- `GET /api/v1/auth/google/url` - Get Google OAuth URL
- `GET /api/v1/auth/google/callback` - OAuth callback
- `POST /api/v1/auth/google/token` - Authenticate with Google ID token
- `GET /api/v1/auth/me` - Get current user profile
- `POST /api/v1/auth/refresh` - Refresh JWT token
- `POST /api/v1/auth/logout` - Logout user

### File Upload Endpoints

- `POST /api/v1/uploads/signed-url` - Generate signed upload URL
- `POST /api/v1/uploads/complete` - Complete upload process
- `POST /api/v1/uploads/direct` - Direct file upload
- `POST /api/v1/uploads/thumbnail` - Generate thumbnails

### Asset Management Endpoints

- `GET /api/v1/assets/:id` - Get asset metadata and URL
- `DELETE /api/v1/assets/:id` - Delete asset
- `GET /api/v1/assets` - List user assets
- `PATCH /api/v1/assets/:id/favorite` - Toggle favorite status

### Generation Endpoints

- `POST /api/v1/generate` - Create new generation job
- `GET /api/v1/generate/:jobId/status` - Get job status
- `POST /api/v1/generate/:jobId/cancel` - Cancel job
- `GET /api/v1/generate` - List user jobs

### Gallery Endpoints

- `GET /api/v1/gallery` - Get user's gallery
- `GET /api/v1/gallery/:id` - Get gallery item details
- `POST /api/v1/gallery/:id/share` - Generate shareable link
- `GET /api/v1/gallery/stats` - Get gallery statistics

### Admin Endpoints

- `GET /api/v1/admin/users` - List all users
- `POST /api/v1/admin/users/:id/quota` - Adjust user quota
- `GET /api/v1/admin/jobs` - List all jobs
- `POST /api/v1/admin/cleanup` - Cleanup old data

### Health Endpoints

- `GET /api/v1/health` - Comprehensive health check
- `GET /api/v1/health/liveness` - Liveness probe
- `GET /api/v1/health/readiness` - Readiness probe
- `GET /api/v1/health/metrics` - Service metrics

## Deployment

### Environment Variables for Production

```env
NODE_ENV=production
PORT=3001
APP_URL=https://api.yourdomain.com
FRONTEND_URL=https://yourdomain.com

# Database
MONGO_URI=mongodb://username:password@host:port/database

# Redis
REDIS_URL=redis://username:password@host:port

# Security
JWT_SECRET=very-long-random-secret-key
```

## Worker Process

The image processing worker runs separately from the main API server:

```bash
# Start worker
npm run worker
```

## Monitoring and Logging

- Logs are stored in `logs/` directory with daily rotation
- Health endpoints provide service status
- Admin endpoints for system monitoring
- Audit logs for all user actions

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For support and questions, please open an issue in the GitHub repository or contact the development team.