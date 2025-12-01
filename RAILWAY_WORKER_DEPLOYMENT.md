# Railway.com Worker Deployment Guide

This guide provides step-by-step instructions for deploying your BullMQ worker on Railway.com.

## Prerequisites

- Railway.com account
- Existing backend deployed on Railway
- MongoDB database (same as backend)
- Redis instance (required for BullMQ queues)

## Step 1: Create New Railway Service

### Option A: Deploy from GitHub Repository

1. **Go to Railway Dashboard**
   - Navigate to [Railway](https://railway.app)
   - Click "New Project"

2. **Connect Repository**
   - Select "Deploy from GitHub repo"
   - Choose your `swapmylook-be` repository
   - Select the branch (usually `main` or `master`)

3. **Configure Service**
   - Service Name: `swapmylook-worker` (or similar)
   - Root Directory: Leave as `/` (root of repository)

### Option B: Deploy from Local Directory

1. **Install Railway CLI**
   ```bash
   npm install -g @railway/cli
   ```

2. **Login and Initialize**
   ```bash
   railway login
   railway init
   ```

3. **Deploy Worker**
   ```bash
   railway up
   ```

## Step 2: Configure Environment Variables

1. **In Railway Dashboard**
   - Go to your worker service
   - Click "Variables" tab
   - Add all required environment variables from `worker-env.example`

2. **Required Variables**
   ```
   MONGO_URI=your_mongodb_connection_string
   REDIS_URL=your_redis_connection_string
   GEMINI_API_KEY=your_gemini_api_key
   CLOUDINARY_URL=your_cloudinary_url
   WORKER_CONCURRENCY=2
   NODE_ENV=production
   ```

3. **Shared Variables** (if backend is on Railway)
   - You can use Railway's shared environment variables
   - Or copy from your existing backend service

## Step 3: Configure Service Settings

1. **Start Command**
   - Ensure start command is set to: `npm run worker`
   - This runs the dedicated worker script

2. **Health Checks**
   - Railway automatically monitors `/health` endpoint
   - Worker includes built-in health check on port 3001

3. **Resource Allocation**
   - **CPU**: At least 1 vCPU for image processing
   - **Memory**: 1GB minimum (2GB recommended for image processing)
   - **Disk**: 1GB should be sufficient

## Step 4: Connect to Backend Services

### Shared Database (MongoDB)
- Use the same MongoDB connection string as your backend
- Worker needs read/write access to job records and image assets

### Redis Instance
- **Option 1**: Railway Redis Plugin
  - Add Redis plugin to your project
  - Use the provided `REDIS_URL`

- **Option 2**: External Redis
  - Redis Cloud, AWS ElastiCache, etc.
  - Add connection string to environment variables

### Backend API
- Worker connects to backend for job status updates
- Ensure `BACKEND_URL` points to your deployed backend

## Step 5: Deploy and Monitor

1. **Initial Deployment**
   ```bash
   railway deploy
   ```

2. **Monitor Logs**
   ```bash
   railway logs
   ```

3. **Check Health**
   - Visit: `https://your-worker-service.up.railway.app/health`
   - Should return JSON with status: "healthy"

## Step 6: Testing the Worker

1. **Create Test Job**
   - Use your frontend to upload images and create a generation job
   - Worker should automatically pick up the job

2. **Monitor Queue**
   - Check Railway logs for worker activity
   - Look for "Job started processing" and "Job completed" messages

3. **Verify Output**
   - Check if output image is generated and stored
   - Verify job status is updated in database

## Troubleshooting

### Common Issues

1. **Worker Not Starting**
   - Check environment variables are set correctly
   - Verify MongoDB and Redis connections
   - Check Railway logs for startup errors

2. **Jobs Not Processing**
   - Ensure Redis connection is working
   - Check if jobs are being added to the queue
   - Verify worker concurrency settings

3. **Memory Issues**
   - Increase memory allocation in Railway
   - Monitor memory usage in logs
   - Consider reducing concurrency

### Log Analysis

Look for these key log messages:
- `✅ MongoDB connected successfully`
- `✅ Redis connected successfully`
- `✅ Queues initialized`
- `Job started processing`
- `Job completed`
- `Job failed` (investigate errors)

## Cost Optimization

1. **Auto-scaling**
   - Railway automatically scales based on traffic
   - Worker runs continuously but only uses resources when processing jobs

2. **Resource Limits**
   - Set appropriate CPU and memory limits
   - Monitor usage and adjust as needed

3. **Alternative: Combined Service**
   - Consider running worker in same service as backend
   - Use `npm run worker` as a background process
   - May be more cost-effective for low traffic

## Maintenance

1. **Updates**
   - Push changes to GitHub for automatic deployments
   - Or use `railway deploy` for manual updates

2. **Monitoring**
   - Set up Railway alerts for service failures
   - Monitor queue backlog and processing times

3. **Backups**
   - Ensure MongoDB backups are configured
   - Redis data is ephemeral (job queue only)

## Support

- Railway Documentation: https://docs.railway.app
- BullMQ Documentation: https://docs.bullmq.io
- Project Issues: Check GitHub repository issues