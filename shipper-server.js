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

// Serve main registration form
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Serve admin panel
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// ══════════════════════════════════════
//   MONGODB CONNECTION
// ══════════════════════════════════════
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
    discountRate:    { type: Number, default: 10 },
    ordersCompleted: { type: Number, default: 0 },
    refundTarget:    { type: Number, default: 1000 },
    refunded:        { type: Boolean, default: false }
  },
  verifiedPhone: { type: Boolean, default: false },
  adminNotes:    String,
  registeredAt:  { type: Date, default: Date.now },
  approvedAt:    Date,
  updatedAt:     Date
});

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
  type:        { type: String, enum: ['gl', 'gv', 'cs'], required: true },
  phone:       { type: String, required: true, unique: true },
  firstName:   { type: String, required: true },
  lastName:    { type: String, required: true },
  fullName:    String,
  bizName:     String,
  email:       { type: String, required: true },
  dob:         String,
  address:     String,
  district:    String,
  source:      String,
  exp:         String,
  bizYear:     Number,
  services:    [String],
  pricePerKg:  Number,
  turnaround:  String,
  shifts:      [String],
  categories:  [String],
  commission:  { type: Number, default: 18 },
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
  password:  { type: String, required: true },
  role:      { type: String, enum: ['superadmin', 'admin', 'staff'], default: 'staff' },
  name:      String,
  lastLogin: Date,
  createdAt: { type: Date, default: Date.now }
});
const Admin = mongoose.model('Admin', adminSchema);

// ══════════════════════════════════════
//   HELPERS
// ══════════════════════════════════════

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendSMS(phone, message, options = {}) {
  const ESMS_URL = 'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/';
  
  const body = {
    ApiKey:    process.env.ESMS_API_KEY,
    SecretKey: process.env.ESMS_SECRET_KEY,
    Phone:     phone,
    Content:   message,
    SmsType:   '8',
    IsUnicode: 0,
    Sandbox:   process.env.NODE_ENV !== 'production' ? 1 : 0,
    RequestId: options.requestId || `CRB-${Date.now()}-${phone.slice(-4)}`,
    ...(process.env.ESMS_CALLBACK_URL && { CallbackUrl: process.env.ESMS_CALLBACK_URL }),
  };

  try {
    const res = await axios.post(ESMS_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    const data = res.data;
    console.log(`📱 ESMS response [${phone}]:`, data);

    if (data.CodeResult !== '100') {
      throw new Error(`ESMS lỗi ${data.CodeResult}: ${data.ErrorMessage}`);
    }

    return { success: true, smsId: data.SMSID, codeResult: data.CodeResult };
  } catch (err) {
    console.error('❌ sendSMS error:', err.message);
    throw new Error('Không thể gửi SMS: ' + err.message);
  }
}

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

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone, type = 'shipper_register' } = req.body;

    if (!/^0[0-9]{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Số điện thoại không hợp lệ' });
    }

    if (!rateLimit(`otp:${phone}`, 3)) {
      return res.status(429).json({ success: false, message: 'Quá nhiều yêu cầu. Thử lại sau 10 phút.' });
    }

    await OTP.deleteMany({ phone, type });

    const otp = generateOTP();
    await OTP.create({ phone, otp, type });

    const message = `[CRABOR] Ma xac minh: ${otp}. Hieu luc 10 phut. Khong chia se ma nay.`;
    const requestId = `CRB-${phone}-${Date.now()}`;

    try {
      await sendSMS(phone, message, { requestId });
    } catch (smsErr) {
      await OTP.deleteOne({ phone, type });
      return res.status(503).json({ success: false, message: 'Không thể gửi SMS. Thử lại sau.' });
    }

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

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp, type = 'shipper_register' } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin' });
    }

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

app.post('/api/shipper/register', async (req, res) => {
  try {
    const { phone, firstName, lastName, email, dob, district, vehicle, plan, fee } = req.body;

    if (!phone || !firstName || !lastName || !email) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });
    }

    const exists = await Shipper.findOne({ phone });
    if (exists) {
      return res.status(409).json({ success: false, message: 'Số điện thoại này đã đăng ký' });
    }

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

app.post('/api/partner/register', async (req, res) => {
  try {
    const { 
      type, phone, firstName, lastName, bizName, email, dob, 
      address, district, source, exp, bizYear, services, 
      pricePerKg, turnaround, shifts, categories 
    } = req.body;

    if (!type || !phone || !firstName || !lastName || !email || !district) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });
    }

    const exists = await Partner.findOne({ phone });
    if (exists) {
      return res.status(409).json({ success: false, message: 'Số điện thoại này đã đăng ký' });
    }

    let commission = 18;
    if (type === 'gv') commission = 15;
    if (type === 'cs') commission = 12;

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

// ══════════════════════════════════════
//   ROUTES: STATUS CHECK
// ══════════════════════════════════════

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

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== 'crabor-admin-secret-2025') {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/shippers', adminAuth, async (req, res) => {
  try {
    const { status, district, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (district && district !== 'all') filter.district = district;

    const total = await Shipper.countDocuments(filter);
    const shippers = await Shipper.find(filter)
      .sort({ registeredAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('-__v');

    res.json({
      success: true,
      data: shippers,
      total,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/partners', adminAuth, async (req, res) => {
  try {
    const { type, status, district, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (type && type !== 'all') filter.type = type;
    if (status && status !== 'all') filter.status = status;
    if (district && district !== 'all') filter.district = district;

    const total = await Partner.countDocuments(filter);
    const partners = await Partner.find(filter)
      .sort({ registeredAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('-__v');

    res.json({
      success: true,
      data: partners,
      total,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/registrations/search', adminAuth, async (req, res) => {
  try {
    const { q, type, status, district, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let shipperResults = [];
    let partnerResults = [];
    let total = 0;

    const searchFilter = {};
    if (q) {
      searchFilter.$or = [
        { registerId: new RegExp(q, 'i') },
        { phone: new RegExp(q, 'i') },
        { email: new RegExp(q, 'i') },
        { firstName: new RegExp(q, 'i') },
        { lastName: new RegExp(q, 'i') },
        { fullName: new RegExp(q, 'i') },
        { bizName: new RegExp(q, 'i') }
      ];
    }
    if (status && status !== 'all') searchFilter.status = status;
    if (district && district !== 'all') searchFilter.district = district;

    if (!type || type === 'all' || type === 'shipper') {
      shipperResults = await Shipper.find(searchFilter)
        .sort({ registeredAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean();
      
      const shipperCount = await Shipper.countDocuments(searchFilter);
      total += shipperCount;
    }

    if (!type || type === 'all' || ['gl', 'gv', 'cs'].includes(type)) {
      const partnerFilter = { ...searchFilter };
      if (type && type !== 'all' && ['gl', 'gv', 'cs'].includes(type)) {
        partnerFilter.type = type;
      }
      
      partnerResults = await Partner.find(partnerFilter)
        .sort({ registeredAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean();
      
      const partnerCount = await Partner.countDocuments(partnerFilter);
      total += partnerCount;
    }

    const allResults = [...shipperResults, ...partnerResults]
      .sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt))
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      data: allResults,
      total,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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

    const partnersByType = {
      gl: await Partner.countDocuments({ type: 'gl' }),
      gv: await Partner.countDocuments({ type: 'gv' }),
      cs: await Partner.countDocuments({ type: 'cs' })
    };

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
        password: 'Crabor@2025',
        role: 'superadmin',
        name: 'CRABOR Admin'
      });
      console.log('👑 Tài khoản admin mặc định đã được tạo');
      console.log('   Username: admin');
      console.log('   Password: Crabor@2025');
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
  console.log(`📋 Main form:     http://localhost:${PORT}/`);
  console.log(`👑 Admin panel:   http://localhost:${PORT}/admin.html`);
  console.log(`🔑 Admin API:     http://localhost:${PORT}/api/admin/`);
  console.log(`📊 Stats:         http://localhost:${PORT}/api/admin/stats`);
  console.log(`🌍 Environment:   ${process.env.NODE_ENV || 'development'}\n`);
  await setupDefaultAdmin();
});

module.exports = app;
