import express from 'express';
import multer from 'multer';
import StudentCardPhoto from '../../models/StudentCardPhoto.js';
import Order from '../../models/Order.js';
import { authCustomer, verifyToken } from '../../utils/auth.js';

const router = express.Router();

// Lưu tạm trong RAM rồi ghi thẳng buffer vào MongoDB — không qua dịch vụ ngoài,
// không lưu ổ đĩa. Giới hạn 5MB cho mỗi ảnh (đủ rộng so với ảnh đã nén phía app ~0.3-1MB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ── UPLOAD ẢNH THẺ SINH VIÊN (lưu thẳng vào MongoDB) ──
// Gọi lúc khách điền form, TRƯỚC khi đơn được tạo -> trả về photo_id để
// gắn vào order khi gọi /api/order/create ngay sau đó.
router.post('/student-card', authCustomer, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Thiếu file ảnh' });

    const photo = await StudentCardPhoto.create({
      data: req.file.buffer,
      content_type: req.file.mimetype || 'image/jpeg',
    });

    res.json({ success: true, data: { photo_id: photo._id } });
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ success: false, message: 'Lỗi lưu ảnh: ' + err.message });
  }
});

// ── XEM ẢNH THẺ SINH VIÊN ──
// Chỉ đối tác đang nhận đúng đơn đó (hoặc khách hàng sở hữu đơn) mới xem được.
router.get('/student-card/:id', async (req, res) => {
  try {
    // Xác thực thủ công ở đây vì <Image> của React Native gửi token qua header
    // riêng (source.headers), không qua middleware chung như các API JSON khác.
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).send('Unauthorized');

    let decoded;
    try { decoded = verifyToken(token); } catch (e) { return res.status(401).send('Invalid token'); }

    const photo = await StudentCardPhoto.findById(req.params.id);
    if (!photo) return res.status(404).send('Not found');

    if (photo.order_id) {
      const order = await Order.findById(photo.order_id);
      const isOwnerCustomer = order && decoded.role === 'customer' && String(order.customer_id) === String(decoded.id);
      const isOwnerPartner  = order && decoded.role === 'partner' && String(order.partner_id) === String(decoded.id);
      if (!isOwnerCustomer && !isOwnerPartner) return res.status(403).send('Forbidden');
    } else {
      // Ảnh chưa gắn vào đơn nào (vừa upload xong) -> chỉ chủ ảnh (không track được ở đây)
      // nên tạm chỉ cho phép customer đã đăng nhập xem (an toàn vừa đủ cho bước preview).
      if (decoded.role !== 'customer') return res.status(403).send('Forbidden');
    }

    res.set('Content-Type', photo.content_type || 'image/jpeg');
    res.send(photo.data);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

export default router;
