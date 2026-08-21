import mongoose from 'mongoose';

const partnerSchema = new mongoose.Schema({
  full_name:    { type: String, required: true, trim: true },
  phone:        { type: String, trim: true, sparse: true, unique: true },
  email:        { type: String, trim: true, lowercase: true, sparse: true, unique: true },

  // password_hash KHÔNG required vì các tài khoản cũ (tạo trước khi có mật khẩu)
  // sẽ được dẫn qua bước "tạo mật khẩu" ở lần đăng nhập đầu tiên sau khi nâng cấp.
  password_hash: { type: String },
  push_token:    { type: String },

  register_id:  { type: String, unique: true, sparse: true },
  status: {
    type: String,
    enum: ['pending_payment','pending_approval','active','rejected','suspended'],
    default: 'pending_payment'
  },
  payment_status: {
    type: String,
    enum: ['unpaid','pending','paid'],
    default: 'unpaid'
  },
  payment_confirmed_at: { type: Date },

  plan:             { type: String, default: 'standard' },
  university:       { type: String },
  university_list:  [String],
  bio:              { type: String },
  personality_tags: [String],

  latitude:     { type: Number },
  longitude:    { type: Number },
  is_online:    { type: Boolean, default: false },
  last_online_at: { type: Date },

  avatar_url:   { type: String },
  device_token: { type: String },

  rating:           { type: Number, default: 5, min: 1, max: 5 },
  total_orders:     { type: Number, default: 0 },
  completed_orders: { type: Number, default: 0 },
  earnings_total:   { type: Number, default: 0 },   // tổng đã kiếm mọi thời gian
  pending_balance:  { type: Number, default: 0 },   // tiền chờ admin duyệt sau khi hoàn thành đơn
  balance:          { type: Number, default: 0 },   // số dư đã duyệt, có thể rút
  withdrawn_total:  { type: Number, default: 0 }     // tổng đã rút
}, { timestamps: true });

partnerSchema.index({ university: 1, is_online: 1, status: 1 });
partnerSchema.index({ phone: 1 });
partnerSchema.index({ email: 1 });

export default mongoose.model('HCPartner', partnerSchema, 'hocho_partners');
