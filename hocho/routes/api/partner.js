import express from 'express';
import { createRequire } from 'module';
import Partner from '../../models/Partner.js';
import WithdrawRequest from '../../models/WithdrawRequest.js';
import { hashPassword, comparePassword, generateToken, authPartner } from '../../utils/auth.js';

const require = createRequire(import.meta.url);
const { nanoid } = require('nanoid');
const router = express.Router();

const findByIdentifier = (identifier) => {
  const isEmail = identifier.includes('@');
  return Partner.findOne(isEmail ? { email: identifier.toLowerCase() } : { phone: identifier });
};

// ── BƯỚC 1: KIỂM TRA SĐT/EMAIL ──
router.post('/auth/check', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ success: false, message: 'Thiếu SĐT hoặc email' });

    const partner = await findByIdentifier(identifier.trim());
    res.json({
      success: true,
      data: {
        exists: !!partner,
        hasPassword: !!partner?.password_hash,
        full_name: partner?.full_name || null,
        status: partner?.status || null,
      }
    });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── ĐĂNG KÝ MỚI (chưa có hồ sơ) ──
router.post('/auth/register', async (req, res) => {
  try {
    const { identifier, full_name, password, university, bio } = req.body;
    if (!identifier || !full_name || !password || !university) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Mật khẩu phải có ít nhất 6 ký tự' });
    }

    const isEmail = identifier.includes('@');
    const existing = await findByIdentifier(identifier.trim());
    if (existing) {
      return res.status(409).json({ success: false, message: 'SĐT/email đã đăng ký. Vui lòng đăng nhập.' });
    }

    const password_hash = await hashPassword(password);
    const registerId = 'HC-S-' + nanoid(6).toUpperCase();

    const partner = await Partner.create({
      full_name,
      phone: isEmail ? undefined : identifier.trim(),
      email: isEmail ? identifier.trim().toLowerCase() : undefined,
      password_hash,
      university,
      university_list: [university],
      bio,
      register_id: registerId,
      status: 'pending_payment',
    });

    const token = generateToken({ id: partner._id, role: 'partner' });
    res.status(201).json({
      success: true,
      message: 'Đăng ký thành công. Vui lòng thanh toán phí kích hoạt.',
      data: { token, partner: { id: partner._id, full_name: partner.full_name, status: partner.status, register_id: registerId } }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── TẠO MẬT KHẨU LẦN ĐẦU (hồ sơ cũ có sẵn nhưng chưa có mật khẩu) ──
router.post('/auth/set-password', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Mật khẩu phải có ít nhất 6 ký tự' });

    const partner = await findByIdentifier(identifier.trim());
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ' });
    if (partner.password_hash) return res.status(409).json({ success: false, message: 'Hồ sơ đã có mật khẩu, vui lòng đăng nhập' });

    partner.password_hash = await hashPassword(password);
    await partner.save();

    const token = generateToken({ id: partner._id, role: 'partner' });
    res.json({
      success: true,
      data: { token, partner: { id: partner._id, full_name: partner.full_name, status: partner.status } }
    });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── ĐĂNG NHẬP ──
router.post('/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin' });

    const partner = await findByIdentifier(identifier.trim());
    if (!partner || !partner.password_hash) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' });
    }

    const ok = await comparePassword(password, partner.password_hash);
    if (!ok) return res.status(401).json({ success: false, message: 'Sai mật khẩu' });

    const token = generateToken({ id: partner._id, role: 'partner' });
    res.json({
      success: true,
      data: {
        token,
        partner: {
          id: partner._id, full_name: partner.full_name, status: partner.status,
          payment_status: partner.payment_status, university: partner.university
        }
      }
    });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── THÔNG TIN + SỐ DƯ (yêu cầu đăng nhập) ──
router.get('/me', authPartner, async (req, res) => {
  try {
    const partner = await Partner.findById(req.partnerId).select(
      'full_name phone email university status payment_status is_online rating completed_orders total_orders earnings_total pending_balance balance withdrawn_total avatar_url personality_tags register_id'
    );
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    res.json({ success: true, data: partner });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── PAYMENT PLAN (cho màn hình SePay phí kích hoạt) ──
router.get('/payment-plan', authPartner, async (req, res) => {
  try {
    const partner = await Partner.findById(req.partnerId);
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ' });
    res.json({
      success: true,
      data: { registerId: partner.register_id, full_name: partner.full_name, fee: 200000 }
    });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── XÁC NHẬN ĐÃ THANH TOÁN PHÍ KÍCH HOẠT ──
router.post('/payment-confirm', authPartner, async (req, res) => {
  try {
    const partner = await Partner.findById(req.partnerId);
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ' });

    partner.payment_status = 'pending';
    partner.status = 'pending_approval';
    await partner.save();

    res.json({
      success: true,
      message: 'Đã ghi nhận. Admin sẽ xác nhận thanh toán và duyệt hồ sơ.',
      data: { status: partner.status }
    });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── BẬT / TẮT ONLINE + CẬP NHẬT VỊ TRÍ ──
router.post('/toggle-status', authPartner, async (req, res) => {
  try {
    const { is_online, latitude, longitude } = req.body;
    const partner = await Partner.findByIdAndUpdate(
      req.partnerId,
      { is_online, last_online_at: is_online ? new Date() : null, latitude, longitude },
      { new: true }
    );
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy đối tác' });
    res.json({ success: true, data: { is_online: partner.is_online } });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── LƯU PUSH TOKEN ──
router.post('/push-token', authPartner, async (req, res) => {
  try {
    const { push_token } = req.body;
    await Partner.findByIdAndUpdate(req.partnerId, { push_token });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── GỬI YÊU CẦU RÚT TIỀN ──
router.post('/withdraw', authPartner, async (req, res) => {
  try {
    const { amount, bank_name, bank_account, bank_owner } = req.body;

    if (!amount || !bank_name || !bank_account || !bank_owner) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin rút tiền' });
    }

    const partner = await Partner.findById(req.partnerId);
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy đối tác' });

    if (amount > partner.balance) {
      return res.status(400).json({
        success: false,
        message: `Số dư không đủ. Số dư hiện tại: ${partner.balance.toLocaleString('vi-VN')}đ`
      });
    }
    if (amount < 50000) {
      return res.status(400).json({ success: false, message: 'Số tiền rút tối thiểu là 50.000đ' });
    }

    await Partner.findByIdAndUpdate(req.partnerId, { $inc: { balance: -amount } });

    const request = await WithdrawRequest.create({
      partner_id: req.partnerId,
      partner_name:  partner.full_name,
      partner_phone: partner.phone,
      amount, bank_name, bank_account, bank_owner,
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Yêu cầu rút tiền đã được gửi. Sẽ được duyệt trong 1-2h.',
      data: { request_id: request._id, amount, remaining_balance: partner.balance - amount }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── LỊCH SỬ RÚT TIỀN ──
router.get('/withdraw-history', authPartner, async (req, res) => {
  try {
    const history = await WithdrawRequest.find({ partner_id: req.partnerId }).sort({ createdAt: -1 }).limit(20);
    res.json({ success: true, data: history });
  } catch (err) {
    console.error('❌ [routes/api/partner.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

export default router;
