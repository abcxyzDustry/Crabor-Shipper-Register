import mongoose from 'mongoose';

const withdrawSchema = new mongoose.Schema({
  partner_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'HCPartner', required: true },
  partner_name: { type: String },
  partner_phone:{ type: String },
  amount:       { type: Number, required: true },
  bank_name:    { type: String, required: true },
  bank_account: { type: String, required: true },
  bank_owner:   { type: String, required: true },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  admin_note:   { type: String },
  processed_at: { type: Date }
}, { timestamps: true });

withdrawSchema.index({ partner_id: 1, status: 1 });
withdrawSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('HCWithdrawRequest', withdrawSchema, 'hocho_withdraw_requests');
