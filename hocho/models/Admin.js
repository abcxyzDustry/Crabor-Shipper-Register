import mongoose from 'mongoose';

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password_hash: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  role: { type: String, enum: ['admin', 'moderator', 'support'], default: 'admin' },
  permissions: [String],
  is_active: { type: Boolean, default: true },
  last_login_at: { type: Date },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.model('HCAdmin', adminSchema, 'hocho_admins');
