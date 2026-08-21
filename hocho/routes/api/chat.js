import express from 'express';
import ChatMessage from '../../models/ChatMessage.js';
import Order from '../../models/Order.js';
import { authEither } from '../../utils/auth.js';

const router = express.Router();

// Helper: kiểm tra người gọi (customer/partner) có thuộc đơn này không
const ownsOrder = (order, userId, role) => {
  if (role === 'customer') return String(order.customer_id) === String(userId);
  if (role === 'partner') return String(order.partner_id) === String(userId);
  return false;
};

// ── GỬI TIN ──
router.post('/send', authEither, async (req, res) => {
  try {
    const { order_id, sender_name, message } = req.body;
    if (!order_id || !message) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin' });
    }

    const order = await Order.findById(order_id);
    if (!order || !order.chat_active) {
      return res.status(403).json({ success: false, message: 'Chat đã đóng' });
    }
    if (!ownsOrder(order, req.userId, req.userRole)) {
      return res.status(403).json({ success: false, message: 'Bạn không thuộc đơn này' });
    }

    const msg = await ChatMessage.create({
      order_id,
      sender_type: req.userRole,
      sender_id: String(req.userId),
      sender_name: sender_name || (req.userRole === 'customer' ? 'Khách' : 'Đối tác'),
      message,
      read: false
    });

    res.status(201).json({
      success: true,
      data: {
        id: msg._id, order_id: msg.order_id, sender_type: msg.sender_type,
        sender_name: msg.sender_name, message: msg.message, created_at: msg.created_at
      }
    });
  } catch (err) {
    console.error('❌ [routes/api/chat.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── LỊCH SỬ CHAT ──
router.get('/history', authEither, async (req, res) => {
  try {
    const { order_id } = req.query;
    if (!order_id) return res.status(400).json({ success: false, message: 'Thiếu order_id' });

    const order = await Order.findById(order_id);
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' });
    if (!ownsOrder(order, req.userId, req.userRole)) {
      return res.status(403).json({ success: false, message: 'Bạn không thuộc đơn này' });
    }

    const messages = await ChatMessage.find({ order_id }).sort({ created_at: 1 }).lean();
    res.json({ success: true, data: messages, total: messages.length });
  } catch (err) {
    console.error('❌ [routes/api/chat.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── ĐÁNH DẤU ĐÃ ĐỌC ──
router.post('/read', authEither, async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'Thiếu thông tin' });

    const result = await ChatMessage.updateMany(
      { order_id, sender_type: { $ne: req.userRole }, read: false },
      { read: true, read_at: new Date() }
    );

    res.json({ success: true, message: `Đã đọc ${result.modifiedCount} tin nhắn`, data: { marked_read: result.modifiedCount } });
  } catch (err) {
    console.error('❌ [routes/api/chat.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── SỐ TIN CHƯA ĐỌC ──
router.get('/unread', authEither, async (req, res) => {
  try {
    const { order_id } = req.query;
    const count = await ChatMessage.countDocuments({
      order_id, sender_type: { $ne: req.userRole }, read: false
    });
    res.json({ success: true, data: { unread_count: count } });
  } catch (err) {
    console.error('❌ [routes/api/chat.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

export default router;
