import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema({
  order_code:     { type: String, unique: true, sparse: true },

  // Customer — lưu cả customer_id (tài khoản) + snapshot thông tin lúc đặt đơn
  // (snapshot để đối tác luôn thấy đúng thông tin đã điền form, dù sau này KH đổi tên/SĐT)
  customer_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'HCCustomer' },
  customer_name:  { type: String, required: true },
  customer_phone: { type: String, required: true },
  customer_email: { type: String },
  customer_address:{ type: String },
  gender_needed:  { type: String, enum: ['male','female','any'], default: 'any' },

  // Thông tin học hộ
  university:  { type: String, required: true },
  class_name:  { type: String },              // lớp
  building:    { type: String },
  floor:       { type: String },
  room_number: { type: String, required: true },
  requirements:      { type: String },
  personality_needed:[String],

  // Ảnh thẻ sinh viên — lưu trong collection riêng StudentCardPhoto (binary trong MongoDB),
  // tự xoá ngay khi đơn hoàn thành/huỷ. Field này chỉ là tham chiếu, không lưu URL ngoài.
  student_card_photo_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HCStudentCardPhoto' },

  // Vị trí GPS của khách lúc đặt đơn — dùng để auto-match đối tác trong bán kính
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: undefined } // [lng, lat]
  },

  // Partner
  partner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HCPartner', sparse: true },

  status: {
    type: String,
    enum: [
      'waiting',       // vừa tạo, chưa thanh toán
      'matching',      // đã thanh toán, đang tìm đối tác
      'accepted',      // đối tác đã nhận đơn
      'heading',       // đối tác đang đến địa chỉ
      'arrived',       // đối tác đã đến nơi
      'in_progress',   // đối tác đang học
      'completed',     // đã hoàn thành
      'cancelled',
      'rejected'
    ],
    default: 'waiting'
  },

  // Pricing
  price:          { type: Number, default: 200000 },
  platform_fee:   { type: Number, default: 60000 },   // 30%
  partner_earning:{ type: Number, default: 140000 },  // 70%

  // Payment
  payment_method: { type: String, enum: ['sepay'], default: 'sepay' },
  payment_status: {
    type: String,
    enum: ['unpaid','pending','paid'],
    default: 'unpaid'
  },
  payment_confirmed_at: { type: Date }, // lúc ADMIN xác nhận thật đã nhận tiền
  payment_claimed_at: { type: Date },   // lúc KHÁCH tự khai đã chuyển khoản (chưa xác minh)
  wallet_applied: { type: Number, default: 0 }, // phần đã trừ từ ví hocho của khách

  // true khi admin đã duyệt tiền 140k của đối tác từ pending_balance -> balance
  earning_approved: { type: Boolean, default: false },

  // Chat
  chat_active: { type: Boolean, default: false },

  // Timestamps theo từng mốc trạng thái
  matched_at:   { type: Date },
  heading_at:   { type: Date },
  arrived_at:   { type: Date },
  started_at:   { type: Date },
  completed_at: { type: Date },
  cancelled_at: { type: Date },

  // Rating
  rating: { type: Number, min: 1, max: 5 },
  review: { type: String },

  // Cancel
  cancel_reason: { type: String },
  cancelled_by:  { type: String, enum: ['customer','partner','system'] }
}, { timestamps: true });

orderSchema.index({ customer_id: 1, status: 1 });
orderSchema.index({ customer_phone: 1, status: 1 });
orderSchema.index({ partner_id: 1, status: 1 });
orderSchema.index({ university: 1, status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ location: '2dsphere' });

export default mongoose.model('HCOrder', orderSchema, 'hocho_orders');
