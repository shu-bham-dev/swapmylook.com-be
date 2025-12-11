import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('MONGO_URI not found in environment');
    process.exit(1);
}

async function updateUser(email = 'singhaman@gmail.com', plan = 'pro') {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
        console.log('Connected to MongoDB');

        // Import User model
        const User = (await import('../src/models/User.js')).default;

        // or by _id: ObjectId('6935a647d258dbe17f1b65d1')
        const user = await User.findOne({ email });
        if (!user) {
            console.log(`User with email ${email} not found`);
            process.exit(1);
        }

        console.log('Current user:', JSON.stringify(user.toObject(), null, 2));

        // Update to paid plan
        user.plan = plan;
        user.subscription.status = 'active';
        // Set quota based on plan
        const planQuotas = {
            'free': 1,
            'basic': 10,
            'premium': 50,
            'pro': 100,
            'enterprise': 500
        };
        user.quota.monthlyRequests = planQuotas[plan] || 100;
        user.quota.usedThisMonth = 0; // reset usage
        user.subscription.trialUsed = false; // optional
        user.subscription.trialEndsAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // far future
        // Set current period end to 1 month from now
        const now = new Date();
        user.subscription.currentPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

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

// Parse command line arguments
const args = process.argv.slice(2);
let email = 'singhaman@gmail.com';
let plan = 'pro';
if (args.length > 0) {
    email = args[0];
    if (args.length > 1) {
        plan = args[1];
    }
}

console.log(`Updating user ${email} to ${plan} plan...`);
updateUser(email, plan);