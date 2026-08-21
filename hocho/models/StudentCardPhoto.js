import mongoose from 'mongoose';

// Lưu ảnh thẻ sinh viên TRỰC TIẾP trong MongoDB (không qua dịch vụ ngoài).
// Document này CHỦ ĐỘNG bị xoá ngay khi đơn hàng kết thúc (hoàn thành hoặc huỷ)
// — xem order.js route /complete và /cancel. Ảnh không được giữ lại lâu dài
// vì là thông tin định danh nhạy cảm, chỉ cần tồn tại trong lúc xử lý đơn.
const studentCardPhotoSchema = new mongoose.Schema({
  order_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'HCOrder', sparse: true },
  data:         { type: Buffer, required: true },
  content_type: { type: String, default: 'image/jpeg' },
}, { timestamps: true });

studentCardPhotoSchema.index({ order_id: 1 });

export default mongoose.model('HCStudentCardPhoto', studentCardPhotoSchema, 'hocho_student_card_photos');
