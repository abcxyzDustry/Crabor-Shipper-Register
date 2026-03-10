require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

// ══════════════════════════════════════
//   MIDDLEWARE
// ══════════════════════════════════════
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve shipper registration form
app.get('/shipper/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/shipper-register.html'));
});

// ══════════════════════════════════════
//   MONGODB CONNECTION
// ══════════════════════════════════════
// Sử dụng MongoDB URI trực tiếp từ database của bạn
const MONGODB_URI = 'mongodb+srv://123456789a:haideptre@cluster0.fs703g5.mongodb.net/crabor?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Atlas connected successfully'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// ══════════════════════════════════════
//   SCHEMAS & MODELS
// ══════════════════════════════════════

// OTP Schema (tự xóa sau 10 phút)
const otpSchema = new mongoose.Schema({
  phone:     { type: String, required: true, index: true },
  otp:       { type: String, required: true },
  type:      { type: String, default: 'shipper_register' },
  attempts:  { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 600 } // TTL 10 phút
});
const OTP = mongoose.model('OTP', otpSchema);

// Shipper Schema
const shipperSchema = new mongoose.Schema({
  registerId:  { type: String, unique: true },
  phone:       { type: String, required: true, unique: true },
  firstName:   { type: String, required: true },
  lastName:    { type: String, required: true },
  fullName:    String,
  email:       { type: String, required: true },
  dob:         String,
  district:    String,
  vehicle:     String,
  plan:        { type: String, default: 'early_bird' },
  fee:         { type: Number, default: 500000 },
  status:      {
    type: String,
    enum: ['pending', 'reviewing', 'approved', 'rejected', 'active', 'suspended'],
    default: 'pending'
  },
  documents: {
    cccdFront:  String,
    cccdBack:   String,
    selfie:     String,
    vehicleImg: String
  },
  earlyBird: {
    discountRate:    { type: Number, default: 10 },  // 10% giảm phí
    ordersCompleted: { type: Number, default: 0 },   // đơn đã hoàn thành
    refundTarget:    { type: Number, default: 1000 }, // hoàn tiền sau 1000 đơn
    refunded:        { type: Boolean, default: false }
  },
  verifiedPhone: { type: Boolean, default: false },
  adminNotes:    String,
  registeredAt:  { type: Date, default: Date.now },
  approvedAt:    Date,
  updatedAt:     Date
});

// Auto-generate registerId
shipperSchema.pre('save', async function(next) {
  if (!this.registerId) {
    const prefix = 'CRB';
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    this.registerId = `${prefix}-${rand}`;
  }
  this.fullName = `${this.lastName} ${this.firstName}`;
  this.updatedAt = new Date();
  next();
});

const Shipper = mongoose.model('Shipper', shipperSchema);

// Partner Schema (Giặt Là, Giúp Việc, China Shop)
const partnerSchema = new mongoose.Schema({
  registerId:  { type: String, unique: true },
  type:        { type: String, enum: ['gl', 'gv', 'cs'], required: true }, // gl: giặt là, gv: giúp việc, cs: china shop
  phone:       { type: String, required: true, unique: true },
  firstName:   { type: String, required: true },
  lastName:    { type: String, required: true },
  fullName:    String,
  bizName:     String, // Tên cơ sở / thương hiệu
  email:       { type: String, required: true },
  dob:         String, // Cho giúp việc
  address:     String,
  district:    String,
  source:      String, // Nguồn hàng (cho China Shop)
  exp:         String, // Kinh nghiệm (cho giúp việc)
  bizYear:     Number, // Năm thành lập (cho giặt là)
  services:    [String], // Dịch vụ cung cấp
  pricePerKg:  Number, // Giá giặt (cho giặt là)
  turnaround:  String, // Thời gian hoàn thành
  shifts:      [String], // Ca làm việc (cho giúp việc)
  categories:  [String], // Danh mục sản phẩm (cho China Shop)
  commission:  { type: Number, default: 18 }, // Hoa hồng %
  status:      {
    type: String,
    enum: ['pending', 'reviewing', 'approved', 'rejected', 'active', 'suspended'],
    default: 'pending'
  },
  documents: {
    cccdFront:   String,
    cccdBack:    String,
    shopFront:   String,
    shopInside:  String,
    selfie:      String,
    productSample: String,
    importDoc:   String
  },
  verifiedPhone: { type: Boolean, default: false },
  adminNotes:    String,
  registeredAt:  { type: Date, default: Date.now },
  approvedAt:    Date,
  updatedAt:     Date
});

partnerSchema.pre('save', async function(next) {
  if (!this.registerId) {
    const prefix = this.type === 'cs' ? 'CRB-CS' : (this.type === 'gv' ? 'CRB-GV' : 'CRB-GL');
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    this.registerId = `${prefix}-${rand}`;
  }
  this.fullName = `${this.lastName} ${this.firstName}`;
  this.updatedAt = new Date();
  next();
});

const Partner = mongoose.model('Partner', partnerSchema);

// Admin User Schema
const adminSchema = new mongoose.Schema({
  username:  { type: String, unique: true, required: true },
  password:  { type: String, required: true }, // đã hash bcrypt
  role:      { type: String, enum: ['superadmin', 'admin', 'staff'], default: 'staff' },
  name:      String,
  lastLogin: Date,
  createdAt: { type: Date, default: Date.now }
});
const Admin = mongoose.model('Admin', adminSchema);

// ══════════════════════════════════════
//   HELPERS
// ══════════════════════════════════════

// Tạo OTP 6 số
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Gửi SMS OTP qua ESMS.vn
// Docs: https://developers.esms.vn
// SmsType 8 = Tin Cố định giá rẻ (OTP)
async function sendSMS(phone, message, options = {}) {
  const ESMS_URL = 'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/';
  
  const body = {
    ApiKey:    process.env.ESMS_API_KEY,
    SecretKey: process.env.ESMS_SECRET_KEY,
    Phone:     phone,
    Content:   message,
    SmsType:   '8',          // Tin cố định giá rẻ — dùng cho OTP
    IsUnicode: 0,            // 0 = không dấu (OTP không cần dấu, rẻ hơn)
    Sandbox:   process.env.NODE_ENV !== 'production' ? 1 : 0,
    // RequestId giúp chặn gửi trùng trong 24h
    RequestId: options.requestId || `CRB-${Date.now()}-${phone.slice(-4)}`,
    // CallbackUrl nếu bạn muốn nhận kết quả gửi tin (tuỳ chọn)
    ...(process.env.ESMS_CALLBACK_URL && { CallbackUrl: process.env.ESMS_CALLBACK_URL }),
  };

  try {
    const res = await axios.post(ESMS_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000 // 10 giây timeout
    });

    const data = res.data;
    console.log(`📱 ESMS response [${phone}]:`, data);

    // CodeResult '100' = thành công
    if (data.CodeResult !== '100') {
      throw new Error(`ESMS lỗi ${data.CodeResult}: ${data.ErrorMessage}`);
    }

    return {
      success: true,
      smsId: data.SMSID,
      codeResult: data.CodeResult
    };
  } catch (err) {
    console.error('❌ sendSMS error:', err.message);
    throw new Error('Không thể gửi SMS: ' + err.message);
  }
}

// Rate limiter đơn giản (in-memory, dùng Redis nếu production)
const rateLimitMap = new Map();
function rateLimit(key, maxAttempts = 3, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + windowMs; }
  record.count++;
  rateLimitMap.set(key, record);
  return record.count <= maxAttempts;
}

// ══════════════════════════════════════
//   ROUTES: OTP
// ══════════════════════════════════════

// POST /api/auth/send-otp
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone, type = 'shipper_register' } = req.body;

    // Validate phone
    if (!/^0[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Số điện thoại không hợp lệ' });
    }

    // Rate limit: tối đa 3 lần/10 phút
    if (!rateLimit(`otp:${phone}`, 3)) {
      return res.status(429).json({ success: false, message: 'Quá nhiều yêu cầu. Thử lại sau 10 phút.' });
    }

    // Xóa OTP cũ
    await OTP.deleteMany({ phone, type });

    // Tạo OTP mới
    const otp = generateOTP();
    await OTP.create({ phone, otp, type });

    // Nội dung OTP không dấu để dùng SmsType 8 (giá rẻ)
    const message = `[CRABOR] Ma xac minh: ${otp}. Hieu luc 10 phut. Khong chia se ma nay.`;
    // RequestId chặn ESMS gửi trùng trong 24h
    const requestId = `CRB-${phone}-${Date.now()}`;

    try {
      await sendSMS(phone, message, { requestId });
    } catch (smsErr) {
      await OTP.deleteOne({ phone, type });
      return res.status(503).json({ success: false, message: 'Không thể gửi SMS. Thử lại sau.' });
    }

    // Dev mode: Sandbox=1 nên không tốn tiền SMS thật
    if (process.env.NODE_ENV !== 'production') {
      console.log(`📱 [DEV] OTP cho ${phone}: ${otp}`);
    }

    res.json({
      success: true,
      message: 'Đã gửi OTP',
      ...(process.env.NODE_ENV !== 'production' && { devOtp: otp })
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp, type = 'shipper_register' } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin' });
    }

    // Giới hạn 5 lần nhập sai
    if (!rateLimit(`verify:${phone}`, 5)) {
      return res.status(429).json({ success: false, message: 'Quá nhiều lần thử. Yêu cầu OTP mới.' });
    }

    const record = await OTP.findOne({ phone, type });

    if (!record) {
      return res.status(400).json({ success: false, message: 'OTP đã hết hạn. Vui lòng yêu cầu mã mới.' });
    }

    if (record.otp !== otp) {
      await OTP.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
      return res.status(400).json({ success: false, message: 'Mã OTP không đúng' });
    }

    // OTP hợp lệ → xóa đi
    await OTP.deleteOne({ _id: record._id });

    res.json({ success: true, message: 'Xác minh thành công', phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ══════════════════════════════════════
//   ROUTES: SHIPPER REGISTRATION
// ══════════════════════════════════════

// POST /api/shipper/register
app.post('/api/shipper/register', async (req, res) => {
  try {
    const { phone, firstName, lastName, email, dob, district, vehicle, plan, fee } = req.body;

    // Validate required fields
    if (!phone || !firstName || !lastName || !email) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });
    }

    // Check duplicate phone
    const exists = await Shipper.findOne({ phone });
    if (exists) {
      return res.status(409).json({ success: false, message: 'Số điện thoại này đã đăng ký' });
    }

    // Tạo shipper mới
    const shipper = await Shipper.create({
      phone, firstName, lastName, email, dob, district, vehicle,
      plan: plan || 'early_bird',
      fee: fee || 500000,
      verifiedPhone: true,
      status: 'pending'
    });

    console.log(`🆕 Shipper mới: ${shipper.registerId} - ${shipper.fullName} - ${phone}`);

    res.json({
      success: true,
      message: 'Đăng ký thành công',
      registerId: shipper.registerId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// ══════════════════════════════════════
//   ROUTES: PARTNER REGISTRATION
// ══════════════════════════════════════

// POST /api/partner/register
app.post('/api/partner/register', async (req, res) => {
  try {
    const { 
      type, phone, firstName, lastName, bizName, email, dob, 
      address, district, source, exp, bizYear, services, 
      pricePerKg, turnaround, shifts, categories 
    } = req.body;

    // Validate required fields
    if (!type || !phone || !firstName || !lastName || !email || !district) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });
    }

    // Check duplicate phone
    const exists = await Partner.findOne({ phone });
    if (exists) {
      return res.status(409).json({ success: false, message: 'Số điện thoại này đã đăng ký' });
    }

    // Xác định hoa hồng theo loại đối tác
    let commission = 18; // Mặc định giặt là 18%
    if (type === 'gv') commission = 15; // Giúp việc 15%
    if (type === 'cs') commission = 12; // China Shop 12%

    // Tạo partner mới
    const partner = await Partner.create({
      type, phone, firstName, lastName, bizName, email, dob,
      address, district, source, exp, bizYear, services,
      pricePerKg, turnaround, shifts, categories,
      commission,
      verifiedPhone: true,
      status: 'pending'
    });

    console.log(`🆕 Partner mới: ${partner.registerId} - ${partner.fullName} - ${phone} - Loại: ${type}`);

    res.json({
      success: true,
      message: 'Đăng ký thành công',
      registerId: partner.registerId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// GET /api/status/:registerId
app.get('/api/status/:registerId', async (req, res) => {
  try {
    let record = await Shipper.findOne({ registerId: req.params.registerId });
    if (!record) {
      record = await Partner.findOne({ registerId: req.params.registerId });
    }
    
    if (!record) return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ' });

    res.json({
      success: true,
      data: {
        registerId: record.registerId,
        status: record.status,
        fullName: record.fullName,
        type: record.type || 'shipper',
        district: record.district,
        registeredAt: record.registeredAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ══════════════════════════════════════
//   ROUTES: ADMIN
// ══════════════════════════════════════

// Middleware xác thực admin đơn giản (dùng API key)
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// GET /api/admin/shippers — Danh sách shipper
app.get('/api/admin/shippers', adminAuth, async (req, res) => {
  try {
    const { status, district, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (district) filter.district = district;

    const total = await Shipper.countDocuments(filter);
    const shippers = await Shipper.find(filter)
      .sort({ registeredAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('-__v');

    res.json({
      success: true,
      total, page: Number(page), limit: Number(limit),
      data: shippers
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/partners — Danh sách partner
app.get('/api/admin/partners', adminAuth, async (req, res) => {
  try {
    const { type, status, district, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (district) filter.district = district;

    const total = await Partner.countDocuments(filter);
    const partners = await Partner.find(filter)
      .sort({ registeredAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('-__v');

    res.json({
      success: true,
      total, page: Number(page), limit: Number(limit),
      data: partners
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/registrations/:id — Chi tiết 1 registration
app.get('/api/admin/registrations/:id', adminAuth, async (req, res) => {
  try {
    let record = await Shipper.findById(req.params.id);
    if (!record) {
      record = await Partner.findById(req.params.id);
    }
    if (!record) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/registrations/:id/status — Cập nhật trạng thái
app.patch('/api/admin/registrations/:id/status', adminAuth, async (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    const validStatuses = ['pending', 'reviewing', 'approved', 'rejected', 'active', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Trạng thái không hợp lệ' });
    }

    let record = await Shipper.findById(req.params.id);
    let model = Shipper;
    if (!record) {
      record = await Partner.findById(req.params.id);
      model = Partner;
    }
    
    if (!record) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    const update = { status, updatedAt: new Date() };
    if (adminNotes) update.adminNotes = adminNotes;
    if (status === 'approved') update.approvedAt = new Date();

    const updated = await model.findByIdAndUpdate(req.params.id, update, { new: true });

    // Gửi SMS thông báo
    if (updated && process.env.ESMS_API_KEY) {
      const notifId = `CRB-NOTIF-${updated._id}-${status}-${Date.now()}`;
      if (status === 'approved') {
        await sendSMS(
          updated.phone,
          `[CRABOR] Chuc mung! Ho so ${updated.registerId} da duoc DUYET. Chung toi se lien he trong 24h.`,
          { requestId: notifId }
        ).catch(e => console.error('SMS notify failed:', e.message));
      } else if (status === 'rejected') {
        await sendSMS(
          updated.phone,
          `[CRABOR] Ho so ${updated.registerId} chua du dieu kien. Vui long lien he hotline de biet them.`,
          { requestId: notifId }
        ).catch(e => console.error('SMS notify failed:', e.message));
      }
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/stats — Thống kê tổng quan
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [totalShippers, totalPartners, pending, approved, active, todayCount] = await Promise.all([
      Shipper.countDocuments(),
      Partner.countDocuments(),
      Shipper.countDocuments({ status: 'pending' }) + Partner.countDocuments({ status: 'pending' }),
      Shipper.countDocuments({ status: 'approved' }) + Partner.countDocuments({ status: 'approved' }),
      Shipper.countDocuments({ status: 'active' }) + Partner.countDocuments({ status: 'active' }),
      Shipper.countDocuments({
        registeredAt: { $gte: new Date(new Date().setHours(0,0,0,0)) }
      }) + Partner.countDocuments({
        registeredAt: { $gte: new Date(new Date().setHours(0,0,0,0)) }
      })
    ]);

    // Thống kê theo loại partner
    const partnersByType = {
      gl: await Partner.countDocuments({ type: 'gl' }),
      gv: await Partner.countDocuments({ type: 'gv' }),
      cs: await Partner.countDocuments({ type: 'cs' })
    };

    // Đếm Early Bird còn lại
    const earlyBirdUsed = await Shipper.countDocuments({ plan: 'early_bird' });
    const earlyBirdLeft = Math.max(0, 50 - earlyBirdUsed);

    res.json({
      success: true,
      data: {
        total: totalShippers + totalPartners,
        shippers: totalShippers,
        partners: totalPartners,
        partnersByType,
        pending, approved, active,
        todayRegistrations: todayCount,
        earlyBirdUsed, earlyBirdLeft,
        earlyBirdRevenue: earlyBirdUsed * 500000
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════
//   SETUP ADMIN MẶC ĐỊNH
// ══════════════════════════════════════
async function setupDefaultAdmin() {
  try {
    const count = await Admin.countDocuments();
    if (count === 0) {
      await Admin.create({
        username: 'admin',
        password: process.env.ADMIN_DEFAULT_PASS || 'Crabor@2025',
        role: 'superadmin',
        name: 'CRABOR Admin'
      });
      console.log('👑 Tài khoản admin mặc định đã được tạo');
      console.log('   Username: admin');
      console.log('   Password: ' + (process.env.ADMIN_DEFAULT_PASS || 'Crabor@2025'));
      console.log('   ⚠️  Vui lòng đổi mật khẩu ngay sau lần đăng nhập đầu tiên!');
    }
  } catch (err) {
    // Bỏ qua nếu admin đã tồn tại
  }
}

// ══════════════════════════════════════
//   START SERVER
// ══════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n🦀 CRABOR Registration Server`);
  console.log(`🚀 Running on port ${PORT}`);
  console.log(`📦 Database: MongoDB Atlas (crabor)`);
  console.log(`📋 Shipper form:  http://localhost:${PORT}/shipper/register`);
  console.log(`🔑 Admin API:     http://localhost:${PORT}/api/admin/`);
  console.log(`📊 Stats:         http://localhost:${PORT}/api/admin/stats`);
  console.log(`🌍 Environment:   ${process.env.NODE_ENV || 'development'}\n`);
  await setupDefaultAdmin();
});

module.exports = app;
