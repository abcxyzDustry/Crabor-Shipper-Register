import express from 'express';
import Admin from '../../models/Admin.js';
import Partner from '../../models/Partner.js';
import Order from '../../models/Order.js';
import Customer from '../../models/Customer.js';
import WithdrawRequest from '../../models/WithdrawRequest.js';
import { authAdmin, comparePassword, hashPassword, generateToken } from '../../utils/auth.js';

const router = express.Router();

// ── ĐĂNG NHẬP ADMIN (JWT thật, không còn dùng secret tĩnh) ──
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin đăng nhập' });

    const admin = await Admin.findOne({ username, is_active: true });
    if (!admin) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản admin' });

    const ok = await comparePassword(password, admin.password_hash);
    if (!ok) return res.status(401).json({ success: false, message: 'Sai mật khẩu' });

    admin.last_login_at = new Date();
    await admin.save();

    const token = generateToken({ id: admin._id, role: 'admin' });
    res.json({ success: true, data: { token, admin: { id: admin._id, username: admin.username, role: admin.role } } });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── ĐỔI MẬT KHẨU ──
router.post('/auth/change-password', authAdmin, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password || new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Mật khẩu mới cần ít nhất 6 ký tự' });
    }
    const admin = await Admin.findById(req.adminId);
    if (!admin) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    const ok = await comparePassword(old_password, admin.password_hash);
    if (!ok) return res.status(401).json({ success: false, message: 'Mật khẩu cũ không đúng' });

    admin.password_hash = await hashPassword(new_password);
    await admin.save();
    res.json({ success: true, message: 'Đã đổi mật khẩu' });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DASHBOARD ──
router.get('/dashboard', authAdmin, async (req, res) => {
  try {
    const [partners, orders, pendingWithdraw, customerCount] = await Promise.all([
      Partner.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      WithdrawRequest.aggregate([
        { $match: { status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Customer.countDocuments()
    ]);

    const partnerStats = { total:0, active:0, pending_payment:0, pending_approval:0, online_now:0 };
    partners.forEach(p => { partnerStats.total += p.count; if (p._id) partnerStats[p._id] = p.count; });
    partnerStats.online_now = await Partner.countDocuments({ is_online: true });

    const orderStats = { total:0, waiting:0, matching:0, accepted:0, heading:0, arrived:0, in_progress:0, completed:0, cancelled:0 };
    orders.forEach(o => { orderStats.total += o.count; if (o._id) orderStats[o._id] = o.count; });

    const completedOrders = await Order.find({ status: 'completed' });
    const platformRevenue = completedOrders.reduce((s, o) => s + o.platform_fee, 0);
    const partnerEarnings = completedOrders.reduce((s, o) => s + o.partner_earning, 0);
    const paidCount       = await Partner.countDocuments({ payment_status: 'paid' });
    const registrationFee = paidCount * 200000;

    const balanceAgg = await Partner.aggregate([
      { $group: { _id: null, totalBalance: { $sum: '$balance' }, totalPending: { $sum: '$pending_balance' }, totalWithdrawn: { $sum: '$withdrawn_total' } } }
    ]);
    const walletAgg = await Customer.aggregate([
      { $group: { _id: null, totalWallet: { $sum: '$wallet_balance' } } }
    ]);

    res.json({
      success: true,
      data: {
        customers: { total: customerCount },
        partners:  partnerStats,
        orders:    orderStats,
        revenue: {
          platform_orders: platformRevenue,
          registration:    registrationFee,
          total:           platformRevenue + registrationFee,
          partner_earnings: partnerEarnings
        },
        withdrawals: {
          pending_count:  pendingWithdraw[0]?.count || 0,
          pending_amount: pendingWithdraw[0]?.total || 0,
          total_balance:  balanceAgg[0]?.totalBalance || 0,
          total_pending_earning: balanceAgg[0]?.totalPending || 0,
          total_withdrawn: balanceAgg[0]?.totalWithdrawn || 0
        },
        wallets: { total_customer_wallet: walletAgg[0]?.totalWallet || 0 }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DANH SÁCH ĐỐI TÁC ──
router.get('/partners', authAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const q = status ? { status } : {};
    const partners = await Partner.find(q)
      .select('full_name phone email university status payment_status plan rating completed_orders total_orders earnings_total pending_balance balance withdrawn_total is_online register_id createdAt')
      .sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, data: partners });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DANH SÁCH KHÁCH HÀNG ──
router.get('/customers', authAdmin, async (req, res) => {
  try {
    const customers = await Customer.find()
      .select('full_name phone email wallet_balance createdAt')
      .sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, data: customers });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DANH SÁCH ĐƠN HÀNG ──
router.get('/orders', authAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const q = status ? { status } : {};
    const orders = await Order.find(q)
      .populate('partner_id', 'full_name phone')
      .select('order_code customer_name customer_phone university building floor room_number status payment_status price earning_approved createdAt partner_id')
      .sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, data: orders });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DUYỆT ĐỐI TÁC (hồ sơ) ──
router.post('/approve-partner', authAdmin, async (req, res) => {
  try {
    const { partner_id } = req.body;
    const partner = await Partner.findByIdAndUpdate(partner_id, { status: 'active' }, { new: true });
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    res.json({ success: true, message: `Đã duyệt ${partner.full_name}`, data: partner });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── TỪ CHỐI ĐỐI TÁC ──
router.post('/reject-partner', authAdmin, async (req, res) => {
  try {
    const { partner_id } = req.body;
    const partner = await Partner.findByIdAndUpdate(partner_id, { status: 'rejected' }, { new: true });
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    res.json({ success: true, message: `Đã từ chối ${partner.full_name}` });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── XÁC NHẬN THANH TOÁN PHÍ ĐĂNG KÝ ĐỐI TÁC ──
router.post('/confirm-payment', authAdmin, async (req, res) => {
  try {
    const { partner_id } = req.body;
    const partner = await Partner.findByIdAndUpdate(
      partner_id,
      { payment_status: 'paid', payment_confirmed_at: new Date(), status: 'pending_approval' },
      { new: true }
    );
    if (!partner) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    res.json({ success: true, message: `Đã xác nhận TT của ${partner.full_name}` });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DANH SÁCH ĐƠN CHỜ XÁC NHẬN THANH TOÁN (khách đã tự khai CK, chưa xác minh) ──
router.get('/pending-order-payments', authAdmin, async (req, res) => {
  try {
    const orders = await Order.find({ payment_status: 'pending', status: 'waiting' })
      .select('order_code customer_name customer_phone university room_number price wallet_applied payment_claimed_at createdAt')
      .sort({ payment_claimed_at: -1 }).limit(200);
    res.json({ success: true, data: orders });
  } catch (err) {
    console.error('❌ [pending-order-payments]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── XÁC NHẬN ĐÃ NHẬN TIỀN CHO 1 ĐƠN HÀNG -> mở cho đối tác thấy & nhận đơn ──
router.post('/confirm-order-payment', authAdmin, async (req, res) => {
  try {
    const { order_id } = req.body;
    const order = await Order.findOne({ _id: order_id, status: 'waiting' });
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hoặc đơn đã được xử lý' });

    order.payment_status = 'paid';
    order.status = 'matching';
    order.payment_confirmed_at = new Date();
    await order.save();

    res.json({ success: true, message: `Đã xác nhận thanh toán đơn ${order.order_code} — đối tác có thể nhận đơn ngay.` });
  } catch (err) {
    console.error('❌ [confirm-order-payment]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DUYỆT TẤT CẢ THANH TOÁN ĐƠN ĐANG CHỜ (tiện xử lý nhanh khi check sao kê) ──
router.post('/confirm-all-order-payments', authAdmin, async (req, res) => {
  try {
    const orders = await Order.find({ payment_status: 'pending', status: 'waiting' });
    for (const order of orders) {
      order.payment_status = 'paid';
      order.status = 'matching';
      order.payment_confirmed_at = new Date();
      await order.save();
    }
    res.json({ success: true, message: `Đã xác nhận ${orders.length} đơn` });
  } catch (err) {
    console.error('❌ [confirm-all-order-payments]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DANH SÁCH THU NHẬP ĐANG CHỜ DUYỆT ──
router.get('/pending-earnings', authAdmin, async (req, res) => {
  try {
    const orders = await Order.find({ status: 'completed', earning_approved: false })
      .populate('partner_id', 'full_name phone pending_balance balance')
      .select('order_code partner_earning completed_at partner_id')
      .sort({ completed_at: -1 }).limit(200);
    res.json({ success: true, data: orders });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DUYỆT THU NHẬP: chuyển pending_balance -> balance cho 1 đơn ──
router.post('/approve-earning', authAdmin, async (req, res) => {
  try {
    const { order_id } = req.body;
    const order = await Order.findOne({ _id: order_id, status: 'completed', earning_approved: false });
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hoặc đã được duyệt' });

    await Partner.findByIdAndUpdate(order.partner_id, {
      $inc: { pending_balance: -order.partner_earning, balance: order.partner_earning }
    });
    order.earning_approved = true;
    await order.save();

    res.json({ success: true, message: `Đã duyệt ${order.partner_earning.toLocaleString('vi-VN')}đ cho đơn ${order.order_code}` });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DUYỆT TẤT CẢ THU NHẬP ĐANG CHỜ ──
router.post('/approve-all-earnings', authAdmin, async (req, res) => {
  try {
    const orders = await Order.find({ status: 'completed', earning_approved: false });
    for (const order of orders) {
      await Partner.findByIdAndUpdate(order.partner_id, {
        $inc: { pending_balance: -order.partner_earning, balance: order.partner_earning }
      });
      order.earning_approved = true;
      await order.save();
    }
    res.json({ success: true, message: `Đã duyệt ${orders.length} đơn` });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DANH SÁCH YÊU CẦU RÚT TIỀN ──
router.get('/withdrawals', authAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const q = status ? { status } : {};
    const list = await WithdrawRequest.find(q).populate('partner_id', 'full_name phone balance').sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, data: list });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── DUYỆT RÚT TIỀN ──
router.post('/approve-withdrawal', authAdmin, async (req, res) => {
  try {
    const { request_id, admin_note } = req.body;
    const request = await WithdrawRequest.findByIdAndUpdate(
      request_id, { status: 'approved', admin_note: admin_note || '', processed_at: new Date() }, { new: true }
    );
    if (!request) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    await Partner.findByIdAndUpdate(request.partner_id, { $inc: { withdrawn_total: request.amount } });
    res.json({ success: true, message: `Đã duyệt rút ${request.amount.toLocaleString('vi-VN')}đ cho ${request.partner_name}` });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ── TỪ CHỐI RÚT TIỀN (hoàn lại số dư) ──
router.post('/reject-withdrawal', authAdmin, async (req, res) => {
  try {
    const { request_id, admin_note } = req.body;
    const request = await WithdrawRequest.findByIdAndUpdate(
      request_id, { status: 'rejected', admin_note: admin_note || 'Từ chối bởi admin', processed_at: new Date() }, { new: true }
    );
    if (!request) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    await Partner.findByIdAndUpdate(request.partner_id, { $inc: { balance: request.amount } });
    res.json({ success: true, message: 'Đã từ chối và hoàn lại số dư' });
  } catch (err) {
    console.error('❌ [routes/api/admin.js]', err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

export default router;
