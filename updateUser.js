import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('MONGO_URI not found in environment');
    process.exit(1);
}

async function updateUser() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
        console.log('Connected to MongoDB');

        // Import User model
        const User = (await import('./src/models/User.js')).default;

        const email = 'singhaman5@gmail.com';
        // or by _id: ObjectId('6935a647d258dbe17f1b65d1')
        const user = await User.findOne({ email });
        if (!user) {
            console.log(`User with email ${email} not found`);
            process.exit(1);
        }

        console.log('Current user:', JSON.stringify(user.toObject(), null, 2));

        // Update to paid plan
        user.plan = 'pro';
        user.subscription.status = 'active';
        user.quota.monthlyRequests = 100; // pro plan quota
        user.quota.usedThisMonth = 0; // reset usage
        user.subscription.trialUsed = false; // optional
        user.subscription.trialEndsAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // far future

        await user.save();
        console.log('User updated successfully');
        console.log('Updated user:', JSON.stringify(user.toObject(), null, 2));
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    }
}

updateUser();