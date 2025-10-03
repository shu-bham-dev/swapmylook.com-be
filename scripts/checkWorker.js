import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { connectRedis, getRedisClient } from '../src/config/redis.js';
import { getQueue } from '../src/config/queue.js';

dotenv.config();

async function checkWorker() {
  try {
    console.log('Checking worker status...');
    
    // Connect to databases
    await mongoose.connect(process.env.MONGO_URI);
    await connectRedis();
    
    console.log('✅ Databases connected');
    
    // Get the queue
    const queue = getQueue('generate');
    console.log('Queue name:', queue.name);
    
    // Check if worker is processing jobs
    const worker = await import('../src/workers/imageProcessor.js');
    console.log('Worker imported successfully');
    
    // Check queue status
    const metrics = await queue.getJobCounts();
    console.log('Queue metrics:', metrics);
    
    // Check if there are any stalled jobs
    const stalledJobs = await queue.getStalled();
    console.log('Stalled jobs:', stalledJobs.length);
    
    // Try to manually process the first waiting job
    const waitingJobs = await queue.getWaiting();
    if (waitingJobs.length > 0) {
      console.log('Found waiting job:', waitingJobs[0].id);
      
      // Try to manually move the job to active state
      const job = waitingJobs[0];
      console.log('Job data:', job.data);
      
      // Check if job can be processed
      const canProcess = await job.isActive();
      console.log('Job can be processed:', canProcess);
    }
    
  } catch (error) {
    console.error('Error checking worker:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from databases');
  }
}

checkWorker();