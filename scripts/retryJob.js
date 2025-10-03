import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { connectRedis, getRedisClient } from '../src/config/redis.js';
import { Queue } from '../src/config/queue.js';
import JobRecord from '../src/models/JobRecord.js';

dotenv.config();

async function retryJob(jobId) {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    
    console.log('Connecting to Redis...');
    await connectRedis();
    
    console.log('Getting job from database...');
    const jobRecord = await JobRecord.findById(jobId);
    
    if (!jobRecord) {
      console.error('Job not found in database');
      return;
    }
    
    console.log('Job found:', {
      id: jobRecord._id,
      status: jobRecord.status,
      userId: jobRecord.userId
    });
    
    // Reset job status to queued
    jobRecord.status = 'queued';
    jobRecord.attempts = 0;
    jobRecord.updatedAt = new Date();
    await jobRecord.save();
    
    console.log('Job reset to queued status');
    
    // Add job to queue again
    const queue = Queue;
    const newJob = await queue.add('generate', {
      jobId: jobRecord._id.toString(),
      userId: jobRecord.userId
    });
    
    console.log('Job added to queue:', newJob.id);
    console.log('Job should now be processed by the worker');
    
  } catch (error) {
    console.error('Error retrying job:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from databases');
  }
}

// Get job ID from command line argument
const jobId = process.argv[2];
if (!jobId) {
  console.error('Please provide a job ID as argument');
  console.log('Usage: node scripts/retryJob.js <jobId>');
  process.exit(1);
}

retryJob(jobId);