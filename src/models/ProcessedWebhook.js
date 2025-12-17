import mongoose from 'mongoose';

const ProcessedWebhookSchema = new mongoose.Schema(
  {
    webhookId: { type: String, unique: true, required: true },
  },
  { timestamps: true }
);

export default mongoose.model(
  'ProcessedWebhook',
  ProcessedWebhookSchema
);