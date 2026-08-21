import mongoose from 'mongoose';

// Sổ ghi log mọi biến động của ví hocho (khách hàng) — để minh bạch, đối soát
const walletTransactionSchema = new mongoose.Schema({
  customer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HCCustomer', required: true },
  type:        { type: String, enum: ['refund', 'payment', 'admin_adjust'], required: true },
  amount:      { type: Number, required: true }, // dương = cộng vào ví, âm = trừ khỏi ví
  order_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'HCOrder' },
  note:        { type: String },
}, { timestamps: true });

walletTransactionSchema.index({ customer_id: 1, createdAt: -1 });

export default mongoose.model('HCWalletTransaction', walletTransactionSchema, 'hocho_wallet_transactions');
