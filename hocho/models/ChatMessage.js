import mongoose from 'mongoose';

const chatMessageSchema = new mongoose.Schema({
  order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HCOrder', required: true },
  sender_type: { type: String, enum: ['customer', 'partner'], required: true },
  sender_id: { type: String },
  sender_name: { type: String },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
  read_at: { type: Date, sparse: true },
  created_at: { type: Date, default: Date.now }
}, { timestamps: true });

chatMessageSchema.index({ order_id: 1, created_at: 1 });
chatMessageSchema.index({ order_id: 1, read: 1 });

export default mongoose.model('HCChatMessage', chatMessageSchema, 'hocho_chat_messages');
