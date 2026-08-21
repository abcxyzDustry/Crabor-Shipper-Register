import express from 'express';
import Customer from '../../models/Customer.js';
import WalletTransaction from '../../models/WalletTransaction.js';
import { hashPassword, comparePassword, generateToken, authCustomer } from '../../utils/auth.js';

const router = express.Router();

const findByIdentifier = (identifier) => {
  const isEmail = identifier.includes('@');
  return Customer.findOne(isEmail ? { email: identifier.toLowerCase() } : { phone: identifier });
};

// ── BƯỚC 1: KIỂM TRA SĐT/EMAIL ĐÃ TỒN TẠI CHƯA ──
// App gọi cái này trước để biết hiện UI "nhập mật khẩu" (đã có) hay "tạo mật khẩu" (chưa có)
router.post('/auth/check', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ success: false, message: 'Thiếu SĐT hoặc email' });

    const customer = await findByIdentifier(identifier.trim());
    res.json({
      success: true,
      data: {
        exists: !!customer,
        hasPassword: !!customer?.password_hash,
        full_name: customer?.full_name || null,
      }
    });
  } catch (err) {
    console.error('❌ [routes/api/customer.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── ĐĂNG KÝ (chưa có tài khoản) HOẶC TẠO MẬT KHẨU LẦN ĐẦU (đã có tài khoản cũ chưa có mật khẩu) ──
router.post('/auth/register', async (req, res) => {
  try {
    const { identifier, full_name, password } = req.body;
    if (!identifier || !full_name || !password) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Mật khẩu phải có ít nhất 6 ký tự' });
    }

    const isEmail = identifier.includes('@');
    let customer = await findByIdentifier(identifier.trim());
    const password_hash = await hashPassword(password);

    if (customer) {
      // Tài khoản cũ chưa có mật khẩu -> set mật khẩu lần đầu
      if (customer.password_hash) {
        return res.status(409).json({ success: false, message: 'Tài khoản đã có mật khẩu, vui lòng đăng nhập' });
      }
      customer.password_hash = password_hash;
      customer.full_name = full_name;
      await customer.save();
    } else {
      customer = await Customer.create({
        full_name,
        phone: isEmail ? undefined : identifier.trim(),
        email: isEmail ? identifier.trim().toLowerCase() : undefined,
        password_hash,
      });
    }

    const token = generateToken({ id: customer._id, role: 'customer' });
    res.status(201).json({
      success: true,
      data: { token, customer: { id: customer._id, full_name: customer.full_name, wallet_balance: customer.wallet_balance } }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── ĐĂNG NHẬP (đã có mật khẩu) ──
router.post('/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin đăng nhập' });
    }

    const customer = await findByIdentifier(identifier.trim());
    if (!customer || !customer.password_hash) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' });
    }

    const ok = await comparePassword(password, customer.password_hash);
    if (!ok) return res.status(401).json({ success: false, message: 'Sai mật khẩu' });

    const token = generateToken({ id: customer._id, role: 'customer' });
    res.json({
      success: true,
      data: { token, customer: { id: customer._id, full_name: customer.full_name, wallet_balance: customer.wallet_balance } }
    });
  } catch (err) {
    console.error('❌ [routes/api/customer.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── THÔNG TIN TÀI KHOẢN ĐANG ĐĂNG NHẬP ──
router.get('/me', authCustomer, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId).select('full_name phone email wallet_balance push_token');
    if (!customer) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    res.json({ success: true, data: customer });
  } catch (err) {
    console.error('❌ [routes/api/customer.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── LƯU PUSH TOKEN (để nhận thông báo nhắc đặt đơn) ──
router.post('/push-token', authCustomer, async (req, res) => {
  try {
    const { push_token } = req.body;
    await Customer.findByIdAndUpdate(req.customerId, { push_token });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ [routes/api/customer.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── LỊCH SỬ VÍ HOCHO ──
router.get('/wallet/history', authCustomer, async (req, res) => {
  try {
    const history = await WalletTransaction.find({ customer_id: req.customerId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, data: history });
  } catch (err) {
    console.error('❌ [routes/api/customer.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

export default router;
