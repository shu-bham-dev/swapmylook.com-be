import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { connectRedis, getRedisClient } from '../src/config/redis.js';
import { Queue } from '../src/config/queue.js';

dotenv.config();

async function testWorker() {
  try {
    console.log('Testing worker functionality...');
    
    // Connect to databases
    await mongoose.connect(process.env.MONGO_URI);
    await connectRedis();
    
    console.log('✅ Databases connected');
    
    // Check queue status
    const queue = Queue;
    const metrics = await queue.getJobCounts();
    console.log('Queue metrics:', metrics);
    
    // Get the actual queue instance to access more methods
    const { getQueue } = await import('../src/config/queue.js');
    const actualQueue = getQueue('generate');
    
    // Check if there are any active jobs
    const activeJobs = await actualQueue.getActive();
    console.log('Active jobs:', activeJobs.length);
    
    const waitingJobs = await actualQueue.getWaiting();
    console.log('Waiting jobs:', waitingJobs.length);
    
    if (waitingJobs.length > 0) {
      console.log('First waiting job:', waitingJobs[0].id, waitingJobs[0].data);
    }
    
    console.log('Worker test completed');
    
  } catch (error) {
    console.error('Error testing worker:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from databases');
  }
}

testWorker();