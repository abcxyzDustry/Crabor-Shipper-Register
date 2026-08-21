import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema({
  full_name:     { type: String, required: true, trim: true },
  phone:         { type: String, trim: true, sparse: true, unique: true },
  email:         { type: String, trim: true, lowercase: true, sparse: true, unique: true },
  password_hash: { type: String, required: true },

  // Ví hocho — chỉ dùng để thanh toán dịch vụ, KHÔNG rút được ra ngân hàng
  wallet_balance: { type: Number, default: 0 },

  push_token: { type: String },
}, { timestamps: true });

customerSchema.index({ phone: 1 });
customerSchema.index({ email: 1 });

export default mongoose.model('HCCustomer', customerSchema, 'hocho_customers');
