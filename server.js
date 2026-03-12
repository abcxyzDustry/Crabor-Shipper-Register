/**

- ==========================================================
- CRABOR TECH CO., LTD – Unified Server
- Super App: Food Delivery, Laundry, Cleaning, China Shop, Ride
- 
- DB:  MongoDB Atlas - cluster0.fs703g5.mongodb.net/crabor
- Port: 3001 (default)
- 
- ENV required (.env):
- ```
  MONGODB_URI, SESSION_SECRET, ADMIN_SECRET_KEY,
  ```
- ```
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID
  ```
- ==========================================================
  */

‘use strict’;
require(‘dotenv’).config();

const express    = require(‘express’);
const http       = require(‘http’);
const socketIo   = require(‘socket.io’);
const mongoose   = require(‘mongoose’);
const cors       = require(‘cors’);
const session    = require(‘express-session’);
const MongoStore = require(‘connect-mongo’);
const path       = require(‘path’);
const crypto     = require(‘crypto’);
const axios      = require(‘axios’);

// ── App & Socket bootstrap ──
const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
cors: { origin: ‘*’, methods: [‘GET’, ‘POST’] }
});

// ══════════════════════════════════════
//  1. MONGODB CONNECTION
// ══════════════════════════════════════
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
console.error(‘❌ Thiếu MONGODB_URI trong .env’);
process.exit(1);
}

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
.then(() => console.log(‘✅ MongoDB Atlas connected — DB: crabor’))
.catch(err => { console.error(‘❌ MongoDB error:’, err.message); process.exit(1); });

// ══════════════════════════════════════
//  2. MIDDLEWARE
// ══════════════════════════════════════
app.use(cors({ origin: ‘*’, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session (dùng cho app core: customer / shipper / partner interfaces)
app.use(session({
secret: process.env.SESSION_SECRET || ‘crabor-session-secret-2025’,
resave: false,
saveUninitialized: false,
store: MongoStore.create({ mongoUrl: MONGODB_URI, ttl: 24 * 60 * 60 }),
cookie: {
secure: process.env.NODE_ENV === ‘production’,
maxAge: 24 * 60 * 60 * 1000
}
}));

// Static files
app.use(express.static(path.join(__dirname, ‘public’)));

// Đưa io vào req để dùng trong route handlers
app.use((req, res, next) => { req.io = io; next(); });

// ══════════════════════════════════════
//  3. SOCKET.IO — REAL-TIME
// ══════════════════════════════════════
io.on(‘connection’, (socket) => {
console.log(‘🔌 Client connected:’, socket.id);

// Vào phòng theo order / user / shipper / admin
socket.on(‘joinRoom’, (room) => {
socket.join(room);
console.log(`   ↳ ${socket.id} joined [${room}]`);
});

// Customer / shipper cập nhật trạng thái đơn
socket.on(‘orderUpdate’, (data) => {
io.to(`order_${data.orderId}`).emit(‘orderStatusChanged’, data);
io.to(‘admin’).emit(‘newOrderNotification’, data);
io.to(`customer_${data.customerId}`).emit(‘orderStatusChanged’, data);
});

// Shipper gửi vị trí GPS
socket.on(‘shipperLocation’, (data) => {
io.to(`order_${data.orderId}`).emit(‘shipperTracking’, data);
io.to(‘admin’).emit(‘shipperLocationUpdate’, data);
});

// Đối tác giặt là / giúp việc cập nhật trạng thái
socket.on(‘partnerUpdate’, (data) => {
io.to(`order_${data.orderId}`).emit(‘partnerStatusChanged’, data);
io.to(‘admin’).emit(‘partnerNotification’, data);
});

socket.on(‘disconnect’, () => {
console.log(‘🔌 Client disconnected:’, socket.id);
});
});

// ══════════════════════════════════════
//  4. SCHEMAS & MODELS
// ══════════════════════════════════════

// ── OTP — Twilio Verify quản lý, không lưu DB ──────

// ── USER (khách hàng app) ──────────────
const userSchema = new mongoose.Schema({
phone:       { type: String, required: true, unique: true },
fullName:    String,
email:       String,
avatar:      String,
address:     String,
district:    String,
role:        { type: String, enum: [‘customer’, ‘admin’, ‘staff’], default: ‘customer’ },
status:      { type: String, enum: [‘active’, ‘banned’], default: ‘active’ },
totalOrders: { type: Number, default: 0 },
totalSpent:  { type: Number, default: 0 },
loyaltyPts:  { type: Number, default: 0 },
fcmToken:    String,
createdAt:   { type: Date, default: Date.now },
lastLogin:   Date,
});
const User = mongoose.model(‘User’, userSchema);

// ── PRODUCT (menu đồ ăn) ─────────────
const productSchema = new mongoose.Schema({
name:        { type: String, required: true },
description: String,
price:       { type: Number, required: true },
image:       String,
category:    String,
partnerId:   { type: mongoose.Schema.Types.ObjectId, ref: ‘FoodPartner’ },
available:   { type: Boolean, default: true },
sold:        { type: Number, default: 0 },
rating:      { type: Number, default: 0 },
createdAt:   { type: Date, default: Date.now },
});
const Product = mongoose.model(‘Product’, productSchema);

// ── ORDER (đơn đa module) ─────────────
const orderSchema = new mongoose.Schema({
orderId:     { type: String, unique: true },
module:      { type: String, enum: [‘food’, ‘laundry’, ‘cleaning’, ‘china_shop’, ‘ride’], required: true },
customerId:  { type: mongoose.Schema.Types.ObjectId, ref: ‘User’, required: true },
shipperId:   { type: mongoose.Schema.Types.ObjectId, ref: ‘Shipper’ },
partnerId:   mongoose.Schema.Types.ObjectId,
items:       [{ productId: mongoose.Schema.Types.ObjectId, name: String, qty: Number, price: Number }],
address:     { type: String, required: true },
district:    String,
total:       { type: Number, required: true },
serviceFee:  { type: Number, default: 0 },
shipFee:     { type: Number, default: 0 },
discount:    { type: Number, default: 0 },
finalTotal:  Number,
status:      {
type: String,
enum: [‘pending’,‘confirmed’,‘preparing’,‘picked_up’,‘delivering’,‘delivered’,‘cancelled’,‘refunded’],
default: ‘pending’
},
paymentMethod:  { type: String, enum: [‘cash’, ‘momo’, ‘zalopay’, ‘bank’], default: ‘cash’ },
paymentStatus:  { type: String, enum: [‘unpaid’, ‘paid’, ‘refunded’], default: ‘unpaid’ },
note:           String,
cancelReason:   String,
statusHistory:  [{ status: String, time: Date, by: String }],
createdAt:      { type: Date, default: Date.now },
confirmedAt:    Date,
deliveredAt:    Date,
});
orderSchema.pre(‘save’, function(next) {
if (!this.orderId) {
this.orderId = ‘ORD-’ + Date.now().toString(36).toUpperCase() + ‘-’ + Math.random().toString(36).substr(2,4).toUpperCase();
}
this.finalTotal = (this.total || 0) + (this.shipFee || 0) + (this.serviceFee || 0) - (this.discount || 0);
next();
});
const Order = mongoose.model(‘Order’, orderSchema);

// ── SHIPPER ───────────────────────────
const shipperSchema = new mongoose.Schema({
registerId:  { type: String, unique: true },
phone:       { type: String, required: true, unique: true },
firstName:   String,
lastName:    String,
fullName:    String,
email:       String,
dob:         String,
address:     String,
district:    String,
vehicle:     String,
plan:        { type: String, default: ‘early_bird’ },
fee:         { type: Number, default: 500000 },
feeStatus:   { type: String, enum: [‘unpaid’,‘paid’], default: ‘unpaid’ },
status:      { type: String, enum: [‘pending’,‘reviewing’,‘approved’,‘rejected’,‘active’,‘suspended’], default: ‘pending’ },
online:      { type: Boolean, default: false },
location:    { lat: Number, lng: Number },
totalOrders: { type: Number, default: 0 },
totalEarned: { type: Number, default: 0 },
rating:      { type: Number, default: 0 },
ratingCount: { type: Number, default: 0 },
documents:   { cccdFront: String, cccdBack: String, selfie: String, vehicleImg: String },
earlyBird:   { discountRate: { type: Number, default: 9 }, ordersCompleted: { type: Number, default: 0 }, refunded: { type: Boolean, default: false } },
adminNotes:  String,
registeredAt: { type: Date, default: Date.now },
approvedAt:   Date,
});
shipperSchema.pre(‘save’, function(next) {
if (!this.registerId) this.registerId = ‘CRB-’ + Math.random().toString(36).substr(2,6).toUpperCase();
this.fullName = `${this.lastName || ''} ${this.firstName || ''}`.trim();
next();
});
const Shipper = mongoose.model(‘Shipper’, shipperSchema);

// ── PARTNER BASE FIELDS ───────────────
const partnerBase = {
registerId:   { type: String, unique: true },
phone:        { type: String, required: true, unique: true },
firstName:    { type: String, required: true },
lastName:     { type: String, required: true },
fullName:     String,
email:        { type: String, required: true },
address:      { type: String, required: true },
district:     { type: String, required: true },
commission:   Number,
status:       { type: String, enum: [‘pending’,‘reviewing’,‘approved’,‘rejected’,‘active’,‘suspended’], default: ‘pending’ },
adminNotes:   String,
registeredAt: { type: Date, default: Date.now },
approvedAt:   Date,
};

// Giặt Là
const giatLaSchema = new mongoose.Schema({
…partnerBase,
bizName:      { type: String, required: true },
bizYear:      Number,
services:     [String],
pricePerKg:   Number,
capacity:     Number,
turnaround:   String,
openTime:     String,
closeTime:    String,
documents:    { cccdFront: String, cccdBack: String, shopFront: String, shopInside: String },
});
giatLaSchema.pre(‘save’, function(next) {
if (!this.registerId) this.registerId = ‘CRB-GL-’ + Math.random().toString(36).substr(2,6).toUpperCase();
this.fullName = `${this.lastName} ${this.firstName}`.trim();
if (!this.commission) this.commission = 18;
next();
});
const GiatLa = mongoose.model(‘GiatLaPartner’, giatLaSchema, ‘giatla_partners’);

// Giúp Việc
const giupViecSchema = new mongoose.Schema({
…partnerBase,
nickname:        String,
dob:             String,
experience:      String,
skills:          [String],
availableShifts: [String],
maxShiftsPerWeek: { type: Number, default: 7 },
transport:       String,
totalEarnings:   { type: Number, default: 0 },
completedShifts: { type: Number, default: 0 },
rating:          { type: Number, default: 0 },
documents:       { cccdFront: String, cccdBack: String, selfie: String },
});
giupViecSchema.pre(‘save’, function(next) {
if (!this.registerId) this.registerId = ‘CRB-GV-’ + Math.random().toString(36).substr(2,6).toUpperCase();
this.fullName = `${this.lastName} ${this.firstName}`.trim();
if (!this.commission) this.commission = 15;
next();
});
const GiupViec = mongoose.model(‘GiupViecPartner’, giupViecSchema, ‘giupviec_partners’);

// China Shop
const chinaShopSchema = new mongoose.Schema({
…partnerBase,
bizName:         { type: String, required: true },
sourceType:      String,
categories:      [String],
skuCount:        Number,
avgOrderValue:   Number,
shippingDays:    Number,
description:     String,
shopFee:         { type: Number, default: 500000 },
shopFeeStatus:   { type: String, enum: [‘unpaid’,‘paid’], default: ‘unpaid’ },
totalSales:      { type: Number, default: 0 },
sampleSubmitted: { type: Boolean, default: false },
documents:       { cccdFront: String, cccdBack: String, productSample: String, importDoc: String },
});
chinaShopSchema.pre(‘save’, function(next) {
if (!this.registerId) this.registerId = ‘CRB-CS-’ + Math.random().toString(36).substr(2,6).toUpperCase();
this.fullName = `${this.lastName} ${this.firstName}`.trim();
if (!this.commission) this.commission = 12;
next();
});
const ChinaShop = mongoose.model(‘ChinaShopPartner’, chinaShopSchema, ‘chinashop_partners’);

// Admin User
const adminSchema = new mongoose.Schema({
username:  { type: String, unique: true, required: true },
password:  { type: String, required: true },
role:      { type: String, enum: [‘superadmin’,‘admin’,‘staff’], default: ‘staff’ },
name:      String,
lastLogin: Date,
createdAt: { type: Date, default: Date.now },
});
// ── FOOD PARTNER (nhà hàng / quán ăn) ──
const foodPartnerSchema = new mongoose.Schema({
registerId:   { type: String, unique: true },
phone:        { type: String, required: true, unique: true },
firstName:    String,
lastName:     String,
email:        String,
bizName:      { type: String, required: true },   // Tên quán
address:      { type: String, required: true },
district:     String,
categories:   [String],   // Cơm, Bún/Phở, Đồ uống…
openTime:     String,
closeTime:    String,
bizYear:      Number,
description:  String,
avatar:       String,     // ảnh logo quán
coverImage:   String,     // ảnh bìa quán
rating:       { type: Number, default: 0 },
totalOrders:  { type: Number, default: 0 },
status:       { type: String, enum: [‘pending’,‘approved’,‘rejected’,‘suspended’], default: ‘pending’ },
adminNotes:   String,
createdAt:    { type: Date, default: Date.now },
});
foodPartnerSchema.pre(‘save’, function(next) {
if (!this.registerId) this.registerId = ‘CRB-FP-’ + Date.now().toString(36).toUpperCase();
next();
});
const FoodPartner = mongoose.model(‘FoodPartner’, foodPartnerSchema, ‘food_partners’);

// ── RIDE DRIVER (tài xế công nghệ) ──
const rideDriverSchema = new mongoose.Schema({
registerId:   { type: String, unique: true },
phone:        { type: String, required: true, unique: true },
firstName:    String,
lastName:     String,
email:        String,
address:      String,
district:     String,
dob:          String,
vehicleType:  String,   // motorbike | car
vehicleBrand: String,   // Honda, Yamaha…
vehiclePlate: String,
vehicleYear:  Number,
licenseClass: String,   // A1, A2, B1, B2
status:       { type: String, enum: [‘pending’,‘approved’,‘rejected’,‘suspended’], default: ‘pending’ },
adminNotes:   String,
online:       { type: Boolean, default: false },
totalTrips:   { type: Number, default: 0 },
rating:       { type: Number, default: 0 },
createdAt:    { type: Date, default: Date.now },
});
rideDriverSchema.pre(‘save’, function(next) {
if (!this.registerId) this.registerId = ‘CRB-RX-’ + Date.now().toString(36).toUpperCase();
next();
});
const RideDriver = mongoose.model(‘RideDriver’, rideDriverSchema, ‘ride_drivers’);

const Admin = mongoose.model(‘Admin’, adminSchema);

// ══════════════════════════════════════
//  5. HELPERS
// ══════════════════════════════════════

function getPartnerModel(mod) {
const slug = {
gl: GiatLa, gv: GiupViec, cs: ChinaShop, fd: FoodPartner, rx: RideDriver,
giat_la: GiatLa, giup_viec: GiupViec, china_shop: ChinaShop,
food_partner: FoodPartner, ride_driver: RideDriver
};
return slug[mod] || null;
}

function slugify(fe) {
return { gl: ‘giat_la’, gv: ‘giup_viec’, cs: ‘china_shop’, fd: ‘food_partner’, rx: ‘ride_driver’ }[fe] || fe;
}

// Rate limiting đơn giản (in-memory)
const _rlMap = new Map();
function rateLimit(key, max = 3, windowMs = 10 * 60 * 1000) {
const now = Date.now();
const rec = _rlMap.get(key) || { count: 0, resetAt: now + windowMs };
if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
rec.count++;
_rlMap.set(key, rec);
return rec.count <= max;
}

// ══════════════════════════════════════
//  TWILIO HELPERS
// ══════════════════════════════════════

// Chuyển SĐT VN sang E.164: 0912345678 → +84912345678
function toE164(phone) {
const p = phone.toString().trim();
if (p.startsWith(’+’)) return p;
if (p.startsWith(‘84’)) return ‘+’ + p;
if (p.startsWith(‘0’)) return ‘+84’ + p.slice(1);
return ‘+84’ + p;
}

const TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY  = process.env.TWILIO_VERIFY_SID;
const TWILIO_FROM    = process.env.TWILIO_PHONE_FROM; // cho SMS thông báo

// Gửi OTP qua Twilio Verify
async function twilioSendOtp(phone) {
const to = toE164(phone);
if (!TWILIO_SID || TWILIO_SID === ‘your_twilio_sid’) {
console.log(`📱 [DEV-OTP] ${to}: <sẽ gửi qua Twilio Verify>`);
return { success: true, dev: true };
}
const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY}/Verifications`;
const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString(‘base64’);
const r = await axios.post(url,
new URLSearchParams({ To: to, Channel: ‘sms’ }).toString(),
{ headers: { ‘Authorization’: `Basic ${auth}`, ‘Content-Type’: ‘application/x-www-form-urlencoded’ }, timeout: 12000 }
);
if (![‘pending’,‘approved’].includes(r.data.status))
throw new Error(’Twilio Verify: ’ + r.data.status);
return { success: true };
}

// Kiểm tra OTP qua Twilio Verify
async function twilioCheckOtp(phone, code) {
const to = toE164(phone);
if (!TWILIO_SID || TWILIO_SID === ‘your_twilio_sid’) {
// Dev mode: chấp nhận bất kỳ 6 số
return /^[0-9]{6}$/.test(code);
}
const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY}/VerificationChecks`;
const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString(‘base64’);
try {
const r = await axios.post(url,
new URLSearchParams({ To: to, Code: code }).toString(),
{ headers: { ‘Authorization’: `Basic ${auth}`, ‘Content-Type’: ‘application/x-www-form-urlencoded’ }, timeout: 12000 }
);
return r.data.status === ‘approved’;
} catch (err) {
// Twilio trả 404 nếu code sai / hết hạn
return false;
}
}

// Gửi SMS thông báo qua Twilio Messaging (không phải OTP)
async function sendSms(phone, message) {
const to = toE164(phone);
if (!TWILIO_SID || TWILIO_SID === ‘your_twilio_sid’ || !TWILIO_FROM) {
console.log(`📱 [DEV-SMS] ${to}: ${message}`);
return true;
}
const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString(‘base64’);
await axios.post(url,
new URLSearchParams({ To: to, From: TWILIO_FROM, Body: message }).toString(),
{ headers: { ‘Authorization’: `Basic ${auth}`, ‘Content-Type’: ‘application/x-www-form-urlencoded’ }, timeout: 12000 }
);
return true;
}

// ══════════════════════════════════════
//  6. ROUTES: HTML PAGES
// ══════════════════════════════════════

// Landing (root) — Màn hình chọn vai trò
app.get(’/’, (req, res) => res.sendFile(path.join(__dirname, ‘public’, ‘index.html’)));

// 4 giao diện app chính (Capacitor wrapper sẽ trỏ vào đây)
app.get(’/customer’,  (req, res) => res.sendFile(path.join(__dirname, ‘public’, ‘customer.html’)));
app.get(’/shipper’,   (req, res) => res.sendFile(path.join(__dirname, ‘public’, ‘shipper.html’)));
app.get(’/partner’,   (req, res) => res.sendFile(path.join(__dirname, ‘public’, ‘partner.html’)));
app.get(’/admin’,     (req, res) => res.sendFile(path.join(__dirname, ‘public’, ‘admin.html’)));

// Form đăng ký unified (public)
app.get(’/register’, (req, res) => res.sendFile(path.join(__dirname, ‘public’, ‘register.html’)));
// Legacy routes (backward compat)
app.get(’/shipper/register’, (req, res) => res.redirect(’/register’));
app.get(’/partner/register’, (req, res) => res.redirect(’/register’));

// ══════════════════════════════════════
//  7. API: OTP (dùng chung toàn bộ)
// ══════════════════════════════════════

// POST /api/auth/send-otp
app.post(’/api/auth/send-otp’, async (req, res) => {
try {
const { phone, type = ‘auth’ } = req.body;
if (!/^0[0-9]{9}$/.test(phone))
return res.status(400).json({ success: false, message: ‘Số điện thoại không hợp lệ’ });

```
if (!rateLimit(`otp:${phone}`, 3))
  return res.status(429).json({ success: false, message: 'Gửi quá nhiều OTP. Thử lại sau 10 phút.' });

const result = await twilioSendOtp(phone);

res.json({
  success: true, message: 'OTP đã gửi qua Twilio',
  // Dev mode: không cần devOtp vì Twilio Verify xử lý hoặc chấp nhận bất kỳ 6 số
  ...(result.dev && { devOtp: '(any 6-digit)' })
});
```

} catch (err) {
console.error(‘send-otp:’, err.message);
res.status(500).json({ success: false, message: ’Không gửi được OTP: ’ + err.message });
}
});

// POST /api/auth/verify-otp
app.post(’/api/auth/verify-otp’, async (req, res) => {
try {
const { phone, otp, type = ‘auth’ } = req.body;
if (!phone || !otp)
return res.status(400).json({ success: false, message: ‘Thiếu phone hoặc otp’ });

```
if (!rateLimit(`verify:${phone}`, 5))
  return res.status(429).json({ success: false, message: 'Sai quá nhiều lần. Yêu cầu OTP mới.' });

const approved = await twilioCheckOtp(phone, otp);
if (!approved)
  return res.status(400).json({ success: false, message: 'Mã OTP không đúng hoặc đã hết hạn' });

res.json({ success: true, message: 'Xác minh thành công', phone });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// POST /api/auth/login — Customer login bằng OTP
app.post(’/api/auth/login’, async (req, res) => {
try {
const { phone, fullName } = req.body;
if (!/^0[0-9]{9}$/.test(phone))
return res.status(400).json({ success: false, message: ‘Số điện thoại không hợp lệ’ });

```
let user = await User.findOne({ phone });
if (!user) {
  user = await User.create({ phone, fullName: fullName || 'Khách hàng CRABOR' });
} else if (fullName && !user.fullName) {
  user.fullName = fullName;
  await user.save();
}
user.lastLogin = new Date();
await user.save();

req.session.userId   = user._id;
req.session.userPhone= user.phone;
req.session.role     = user.role;

res.json({ success: true, user: { id: user._id, phone: user.phone, fullName: user.fullName, role: user.role } });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// POST /api/auth/logout
app.post(’/api/auth/logout’, (req, res) => {
req.session.destroy(() => res.json({ success: true }));
});

// POST /api/auth/admin-login
app.post(’/api/auth/admin-login’, async (req, res) => {
try {
const { username, password } = req.body;
const admin = await Admin.findOne({ username });
if (!admin) return res.status(401).json({ success: false, message: ‘Sai tên đăng nhập’ });
const bcrypt = require(‘bcryptjs’);
// Support both plain text (dev) and bcrypt hash (prod)
const ok = admin.password === password ||
await bcrypt.compare(password, admin.password).catch(() => false);
if (!ok) return res.status(401).json({ success: false, message: ‘Sai mật khẩu’ });
req.session.adminId   = admin._id;
req.session.adminUser = admin.username;
req.session.role      = ‘admin’;
res.json({ success: true, admin: { username: admin.username, role: admin.role } });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/auth/me
app.get(’/api/auth/me’, async (req, res) => {
if (!req.session.userId) return res.status(401).json({ success: false });
const user = await User.findById(req.session.userId).select(’-__v’);
if (!user) return res.status(401).json({ success: false });
res.json({ success: true, user });
});

// ══════════════════════════════════════
//  8. API: USERS
// ══════════════════════════════════════

// GET /api/users/profile
app.get(’/api/users/profile’, async (req, res) => {
if (!req.session.userId) return res.status(401).json({ success: false, message: ‘Chưa đăng nhập’ });
const user = await User.findById(req.session.userId).select(’-__v’);
res.json({ success: true, data: user });
});

// PATCH /api/users/profile
app.patch(’/api/users/profile’, async (req, res) => {
if (!req.session.userId) return res.status(401).json({ success: false });
const { fullName, email, address, district, fcmToken } = req.body;
const user = await User.findByIdAndUpdate(
req.session.userId,
{ fullName, email, address, district, fcmToken },
{ new: true, select: ‘-__v’ }
);
res.json({ success: true, data: user });
});

// GET /api/users/:id/orders — lịch sử đơn
app.get(’/api/users/:id/orders’, async (req, res) => {
try {
const orders = await Order.find({ customerId: req.params.id })
.sort({ createdAt: -1 }).limit(50).select(’-__v’);
res.json({ success: true, data: orders });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// ══════════════════════════════════════
//  9. API: PRODUCTS
// ══════════════════════════════════════

// GET /api/products
app.get(’/api/products’, async (req, res) => {
try {
const { category, partnerId, available = true, page = 1, limit = 30, q } = req.query;
const filter = {};
if (category)  filter.category  = category;
if (partnerId) filter.partnerId = partnerId;
if (available !== ‘all’) filter.available = available === ‘true’;
if (q) filter.name = new RegExp(q, ‘i’);

```
const [data, total] = await Promise.all([
  Product.find(filter).sort({ sold: -1 }).skip((page-1)*limit).limit(Number(limit)),
  Product.countDocuments(filter)
]);
res.json({ success: true, total, page: Number(page), data });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/products/:id
app.get(’/api/products/:id’, async (req, res) => {
const p = await Product.findById(req.params.id);
if (!p) return res.status(404).json({ success: false, message: ‘Không tìm thấy sản phẩm’ });
res.json({ success: true, data: p });
});

// POST /api/products (admin)
app.post(’/api/products’, adminAuth, async (req, res) => {
try {
const p = await Product.create(req.body);
res.status(201).json({ success: true, data: p });
} catch (err) {
res.status(400).json({ success: false, message: err.message });
}
});

// PATCH /api/products/:id (admin)
app.patch(’/api/products/:id’, adminAuth, async (req, res) => {
try {
const p = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
res.json({ success: true, data: p });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// ══════════════════════════════════════
//  10. API: ORDERS
// ══════════════════════════════════════

// POST /api/orders — Tạo đơn mới
app.post(’/api/orders’, async (req, res) => {
try {
const { module = ‘food’, items, address, district, paymentMethod, note, customerId } = req.body;

```
const uid = customerId || req.session.userId;
if (!uid) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

// Tính tổng
const total = (items || []).reduce((s, i) => s + i.price * i.qty, 0);
const shipFee = total >= 150000 ? 0 : 15000;
const serviceFee = Math.round(total * 0.02);

const order = await Order.create({
  module, customerId: uid, items, address, district,
  total, shipFee, serviceFee,
  paymentMethod: paymentMethod || 'cash',
  note,
  statusHistory: [{ status: 'pending', time: new Date(), by: 'system' }]
});

// Realtime: thông báo admin và shipper
req.io.to('admin').emit('newOrder', { orderId: order.orderId, module, total: order.finalTotal });
req.io.to('shippers').emit('newOrderAvailable', { orderId: order.orderId, district, total: order.finalTotal });

res.status(201).json({ success: true, data: order });
```

} catch (err) {
console.error(‘create order:’, err);
res.status(400).json({ success: false, message: err.message });
}
});

// GET /api/orders — list (admin/shipper)
app.get(’/api/orders’, async (req, res) => {
try {
const { module, status, page = 1, limit = 20, shipperId, customerId } = req.query;
const filter = {};
if (module)     filter.module     = module;
if (status)     filter.status     = status;
if (shipperId)  filter.shipperId  = shipperId;
if (customerId) filter.customerId = customerId;

```
const [data, total] = await Promise.all([
  Order.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(Number(limit)),
  Order.countDocuments(filter)
]);
res.json({ success: true, total, page: Number(page), data });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/orders/:id
app.get(’/api/orders/:id’, async (req, res) => {
const order = await Order.findOne({ orderId: req.params.id });
if (!order) return res.status(404).json({ success: false, message: ‘Không tìm thấy đơn’ });
res.json({ success: true, data: order });
});

// PATCH /api/orders/:id/status
app.patch(’/api/orders/:id/status’, async (req, res) => {
try {
const { status, by = ‘system’, shipperId } = req.body;
const update = { status, $push: { statusHistory: { status, time: new Date(), by } } };
if (shipperId) update.shipperId = shipperId;
if (status === ‘delivered’) update.deliveredAt = new Date();
if (status === ‘confirmed’) update.confirmedAt = new Date();

```
const order = await Order.findOneAndUpdate({ orderId: req.params.id }, update, { new: true });
if (!order) return res.status(404).json({ success: false });

// Realtime
req.io.to(`order_${order.orderId}`).emit('orderStatusChanged', { orderId: order.orderId, status });
req.io.to(`customer_${order.customerId}`).emit('orderStatusChanged', { orderId: order.orderId, status });
req.io.to('admin').emit('orderUpdated', { orderId: order.orderId, status });

res.json({ success: true, data: order });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// ══════════════════════════════════════
//  11. API: SHIPPER REGISTRATION
// ══════════════════════════════════════

// POST /api/shipper/register
app.post(’/api/shipper/register’, async (req, res) => {
try {
const { phone, firstName, lastName, email, dob, address, district, vehicle } = req.body;
if (!phone || !firstName || !lastName || !email)
return res.status(400).json({ success: false, message: ‘Thiếu thông tin bắt buộc’ });

```
const exists = await Shipper.findOne({ phone });
if (exists) return res.status(409).json({ success: false, message: `SĐT đã đăng ký. Mã: ${exists.registerId}` });

// Kiểm tra còn suất Early Bird
const ebCount = await Shipper.countDocuments({ plan: 'early_bird' });
const plan = ebCount < 50 ? 'early_bird' : 'standard';

const shipper = await Shipper.create({
  phone, firstName, lastName, email, dob, address, district, vehicle,
  plan, fee: plan === 'early_bird' ? 500000 : 700000,
  status: 'pending'
});

// SMS xác nhận
await sendSms(phone,
  `CRABOR: Ho so Shipper cua ban (${shipper.registerId}) da duoc tiep nhan. Chung toi se lien he trong 24-48h.`).catch(() => {});

req.io.to('admin').emit('newShipperApplication', { registerId: shipper.registerId, phone, district });
console.log(`🛵 Shipper mới: ${shipper.registerId} — ${phone}`);
res.json({ success: true, message: 'Đăng ký thành công!', registerId: shipper.registerId, plan });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// ══════════════════════════════════════
//  12. API: PARTNER REGISTRATION (3 modules)
// ══════════════════════════════════════

// POST /api/partner/register
app.post(’/api/partner/register’, async (req, res) => {
try {
const {
module: modFe, phone, firstName, lastName, email, address, district,
bizName, nickname,
bizYear, services, pricePerKg, capacity, turnaround, openTime, closeTime,
dob, experience, skills, availableShifts, maxShiftsPerWeek, transport,
sourceType, categories, skuCount, avgOrderValue, shippingDays, description,
} = req.body;

```
const mod   = slugify(modFe);
const Model = getPartnerModel(mod);
if (!Model) return res.status(400).json({ success: false, message: 'Module không hợp lệ' });

const exists = await Model.findOne({ phone });
if (exists) return res.status(409).json({ success: false, message: `SĐT đã đăng ký. Mã: ${exists.registerId}` });

const base = { phone, firstName, lastName, email, address, district };
let data = { ...base };

if (mod === 'giat_la') {
  Object.assign(data, {
    bizName, bizYear, services, pricePerKg: Number(pricePerKg) || 0,
    capacity: Number(capacity) || 0, turnaround, openTime, closeTime,
  });
} else if (mod === 'giup_viec') {
  Object.assign(data, {
    nickname: nickname || `${lastName} ${firstName}`.trim(),
    dob, experience, skills, availableShifts,
    maxShiftsPerWeek: Number(maxShiftsPerWeek) || 7, transport,
  });
} else if (mod === 'china_shop') {
  Object.assign(data, {
    bizName, sourceType, categories,
    skuCount: Number(skuCount) || 0,
    avgOrderValue: Number(avgOrderValue) || 0,
    shippingDays: Number(shippingDays) || 10,
    description,
  });
} else if (mod === 'food_partner') {
  Object.assign(data, {
    bizName: req.body.bizName,
    bizYear: Number(req.body.bizYear) || 0,
    categories: req.body.categories,
    description: req.body.description,
    openTime: req.body.openTime,
    closeTime: req.body.closeTime,
    priceRange: req.body.priceRange,
  });
}

const partner = await Model.create(data);
const modName = {
  giat_la: 'Giat La', giup_viec: 'Giup Viec',
  china_shop: 'China Shop', food_partner: 'Nha hang'
}[mod] || mod;

await sendSms(phone,
  `CRABOR: Ho so doi tac ${modName} (${partner.registerId}) da duoc tiep nhan. Chung toi se lien he trong 24-48h.`).catch(() => {});

req.io.to('admin').emit('newPartnerApplication', { registerId: partner.registerId, module: mod, phone, district });
console.log(`🤝 Partner mới [${mod}]: ${partner.registerId} — ${phone}`);
res.json({ success: true, message: 'Đăng ký thành công!', registerId: partner.registerId, module: mod });
```

} catch (err) {
if (err.code === 11000) return res.status(409).json({ success: false, message: ‘SĐT hoặc email đã tồn tại’ });
res.status(500).json({ success: false, message: err.message });
}
});

// POST /api/ride/register — Đăng ký tài xế công nghệ
app.post(’/api/ride/register’, async (req, res) => {
try {
const { phone, firstName, lastName, email, address, district,
dob, vehicleType, vehicleBrand, vehiclePlate, vehicleYear, licenseClass } = req.body;
if (!phone || !firstName || !lastName)
return res.status(400).json({ success: false, message: ‘Thiếu thông tin bắt buộc’ });
const exists = await RideDriver.findOne({ phone });
if (exists) return res.status(409).json({ success: false, message: `SĐT đã đăng ký. Mã: ${exists.registerId}` });
const driver = await RideDriver.create({ phone, firstName, lastName, email, address, district,
dob, vehicleType, vehicleBrand, vehiclePlate, vehicleYear: Number(vehicleYear)||0, licenseClass });
await sendSms(phone,
`CRABOR: Ho so tai xe cong nghe (${driver.registerId}) da duoc tiep nhan. Chung toi se lien he trong 24-48h.`
).catch(() => {});
req.io.to(‘admin’).emit(‘newRideDriverApplication’, { registerId: driver.registerId, phone, district });
console.log(`🚗 Tài xế mới: ${driver.registerId} — ${phone}`);
res.json({ success: true, message: ‘Đăng ký thành công! Chúng tôi sẽ liên hệ trong 24–48h.’, registerId: driver.registerId });
} catch (err) {
if (err.code === 11000) return res.status(409).json({ success: false, message: ‘SĐT đã tồn tại’ });
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/food-partners — Danh sách nhà hàng (public, chỉ approved)
app.get(’/api/food-partners’, async (req, res) => {
try {
const { district, category, search, limit = 20, skip = 0 } = req.query;
const q = { status: ‘approved’ };
if (district) q.district = district;
if (category) q.categories = category;
if (search) q.bizName = { $regex: search, $options: ‘i’ };
const partners = await FoodPartner.find(q)
.select(’_id registerId bizName address district categories openTime closeTime avatar coverImage rating totalOrders description’)
.sort({ rating: -1, totalOrders: -1 })
.limit(Number(limit)).skip(Number(skip));
res.json({ success: true, partners });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/food-partners/:id/products — Menu của một tiệm
app.get(’/api/food-partners/:id/products’, async (req, res) => {
try {
const products = await Product.find({ partnerId: req.params.id, available: true })
.sort({ sold: -1 });
res.json({ success: true, products });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// ══════════════════════════════════════
//  13. API: ANALYTICS
// ══════════════════════════════════════

// GET /api/analytics/overview
app.get(’/api/analytics/overview’, adminAuth, async (req, res) => {
try {
const today = new Date(); today.setHours(0,0,0,0);
const week  = new Date(Date.now() - 7 * 24 * 3600e3);
const month = new Date(Date.now() - 30 * 24 * 3600e3);

```
const [
  totalOrders, todayOrders, weekOrders,
  totalRevenue, todayRevenue,
  totalUsers, newUsersWeek,
  shipperCount, activeShippers,
  glCount, gvCount, csCount,
  pendingAll
] = await Promise.all([
  Order.countDocuments(),
  Order.countDocuments({ createdAt: { $gte: today } }),
  Order.countDocuments({ createdAt: { $gte: week } }),
  Order.aggregate([{ $match: { status: 'delivered' } }, { $group: { _id: null, total: { $sum: '$finalTotal' } } }]),
  Order.aggregate([{ $match: { status: 'delivered', deliveredAt: { $gte: today } } }, { $group: { _id: null, total: { $sum: '$finalTotal' } } }]),
  User.countDocuments(),
  User.countDocuments({ createdAt: { $gte: week } }),
  Shipper.countDocuments(),
  Shipper.countDocuments({ status: 'active' }),
  GiatLa.countDocuments(),
  GiupViec.countDocuments(),
  ChinaShop.countDocuments(),
  Shipper.countDocuments({ status: 'pending' }) +
    await GiatLa.countDocuments({ status: 'pending' }) +
    await GiupViec.countDocuments({ status: 'pending' }) +
    await ChinaShop.countDocuments({ status: 'pending' }),
]);

res.json({ success: true, data: {
  orders:   { total: totalOrders, today: todayOrders, week: weekOrders },
  revenue:  { total: totalRevenue[0]?.total || 0, today: todayRevenue[0]?.total || 0 },
  users:    { total: totalUsers, newThisWeek: newUsersWeek },
  shippers: { total: shipperCount, active: activeShippers },
  partners: { giatLa: glCount, giupViec: gvCount, chinaShop: csCount },
  pendingReview: pendingAll,
}});
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/analytics/orders-by-module
app.get(’/api/analytics/orders-by-module’, adminAuth, async (req, res) => {
try {
const result = await Order.aggregate([
{ $group: { _id: ‘$module’, count: { $sum: 1 }, revenue: { $sum: ‘$finalTotal’ } } }
]);
res.json({ success: true, data: result });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// ══════════════════════════════════════
//  14. API: ADMIN
// ══════════════════════════════════════

function adminAuth(req, res, next) {
const key = req.headers[‘x-admin-key’];
if (key !== process.env.ADMIN_SECRET_KEY)
return res.status(401).json({ success: false, message: ‘Unauthorized’ });
next();
}

// GET /api/admin/stats — dashboard stats
app.get(’/api/admin/stats’, adminAuth, async (req, res) => {
try {
const today = new Date(); today.setHours(0,0,0,0);

```
const [totalS, totalGL, totalGV, totalCS, totalFP, totalRX,
       pendingS, pendingGL, pendingGV, pendingCS, pendingFP, pendingRX,
       todayS, todayGL, todayGV, todayCS, todayFP, todayRX,
       earlyBird] = await Promise.all([
  Shipper.countDocuments(),
  GiatLa.countDocuments(),
  GiupViec.countDocuments(),
  ChinaShop.countDocuments(),
  FoodPartner.countDocuments(),
  RideDriver.countDocuments(),
  Shipper.countDocuments({ status: 'pending' }),
  GiatLa.countDocuments({ status: 'pending' }),
  GiupViec.countDocuments({ status: 'pending' }),
  ChinaShop.countDocuments({ status: 'pending' }),
  FoodPartner.countDocuments({ status: 'pending' }),
  RideDriver.countDocuments({ status: 'pending' }),
  Shipper.countDocuments({ registeredAt: { $gte: today } }),
  GiatLa.countDocuments({ registeredAt: { $gte: today } }),
  GiupViec.countDocuments({ registeredAt: { $gte: today } }),
  ChinaShop.countDocuments({ registeredAt: { $gte: today } }),
  FoodPartner.countDocuments({ createdAt: { $gte: today } }),
  RideDriver.countDocuments({ createdAt: { $gte: today } }),
  Shipper.countDocuments({ plan: 'early_bird' }),
]);

res.json({ success: true, data: {
  total:   totalS + totalGL + totalGV + totalCS + totalFP + totalRX,
  shippers: totalS,
  partners: { gl: totalGL, gv: totalGV, cs: totalCS, fp: totalFP, rx: totalRX },
  pending: pendingS + pendingGL + pendingGV + pendingCS + pendingFP + pendingRX,
  approved: await Shipper.countDocuments({ status: 'approved' }) +
            await GiatLa.countDocuments({ status: 'approved' }) +
            await GiupViec.countDocuments({ status: 'approved' }) +
            await ChinaShop.countDocuments({ status: 'approved' }) +
            await FoodPartner.countDocuments({ status: 'approved' }) +
            await RideDriver.countDocuments({ status: 'approved' }),
  active: await Shipper.countDocuments({ status: 'active' }),
  todayRegistrations: todayS + todayGL + todayGV + todayCS + todayFP + todayRX,
  earlyBirdUsed: earlyBird,
  earlyBirdLeft: Math.max(0, 50 - earlyBird),
  earlyBirdRevenue: earlyBird * 500000,
}});
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/admin/shippers
app.get(’/api/admin/shippers’, adminAuth, async (req, res) => {
try {
const { status, district, page = 1, limit = 20, q } = req.query;
const filter = {};
if (status && status !== ‘all’) filter.status = status;
if (district && district !== ‘all’) filter.district = district;
if (q) filter.$or = [
{ phone: new RegExp(q,‘i’) }, { fullName: new RegExp(q,‘i’) }, { registerId: new RegExp(q,‘i’) }
];
const [data, total] = await Promise.all([
Shipper.find(filter).sort({ registeredAt: -1 }).skip((page-1)*limit).limit(Number(limit)),
Shipper.countDocuments(filter)
]);
res.json({ success: true, total, page: Number(page), data });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/admin/partners?module=giat_la
app.get(’/api/admin/partners’, adminAuth, async (req, res) => {
try {
const { module: mod, status, district, page = 1, limit = 20, q } = req.query;
const Model = getPartnerModel(mod);
if (!Model) return res.status(400).json({ success: false, message: ‘Module không hợp lệ. Dùng: giat_la | giup_viec | china_shop’ });

```
const filter = {};
if (status && status !== 'all') filter.status = status;
if (district && district !== 'all') filter.district = district;
if (q) filter.$or = [
  { phone: new RegExp(q,'i') }, { fullName: new RegExp(q,'i') },
  { registerId: new RegExp(q,'i') }, { bizName: new RegExp(q,'i') }
];
const [data, total] = await Promise.all([
  Model.find(filter).sort({ registeredAt: -1 }).skip((page-1)*limit).limit(Number(limit)),
  Model.countDocuments(filter)
]);
res.json({ success: true, total, page: Number(page), data });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/admin/ride-drivers
app.get(’/api/admin/ride-drivers’, adminAuth, async (req, res) => {
try {
const { status, district, page = 1, limit = 20, q, vehicleType } = req.query;
const filter = {};
if (status && status !== ‘all’) filter.status = status;
if (district && district !== ‘all’) filter.district = district;
if (vehicleType && vehicleType !== ‘all’) filter.vehicleType = vehicleType;
if (q) filter.$or = [
{ phone: new RegExp(q,‘i’) }, { firstName: new RegExp(q,‘i’) },
{ lastName: new RegExp(q,‘i’) }, { registerId: new RegExp(q,‘i’) },
{ vehiclePlate: new RegExp(q,‘i’) }
];
const [data, total] = await Promise.all([
RideDriver.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(Number(limit)),
RideDriver.countDocuments(filter)
]);
res.json({ success: true, total, page: Number(page), data });
} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// GET /api/admin/registrations/search — tìm kiếm toàn bộ
app.get(’/api/admin/registrations/search’, adminAuth, async (req, res) => {
try {
const { q, type, status, district, page = 1, limit = 20 } = req.query;
const buildFilter = () => {
const f = {};
if (status && status !== ‘all’) f.status = status;
if (district && district !== ‘all’) f.district = district;
if (q) f.$or = [
{ phone: new RegExp(q,‘i’) }, { fullName: new RegExp(q,‘i’) },
{ registerId: new RegExp(q,‘i’) }, { bizName: new RegExp(q,‘i’) }
];
return f;
};
const filter = buildFilter();
const models = type && type !== ‘all’
? (type === ‘shipper’ ? [{ m: Shipper, t: ‘shipper’ }]
: type === ‘ride_driver’ ? [{ m: RideDriver, t: ‘ride_driver’ }]
: [{ m: getPartnerModel(type), t: type }])
: [
{ m: Shipper, t: ‘shipper’ },
{ m: GiatLa, t: ‘giat_la’ },
{ m: GiupViec, t: ‘giup_viec’ },
{ m: ChinaShop, t: ‘china_shop’ },
{ m: FoodPartner, t: ‘food_partner’ },
{ m: RideDriver, t: ‘ride_driver’ },
];

```
const results = await Promise.all(models.map(({ m, t }) =>
  m.find(filter).sort({ registeredAt: -1 }).limit(Number(limit)).lean().then(rows => rows.map(r => ({ ...r, _type: t })))
));
const flat = results.flat().sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt)).slice(0, Number(limit));
res.json({ success: true, total: flat.length, data: flat });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// PATCH /api/admin/registrations/:type/:id/status
app.patch(’/api/admin/registrations/:type/:id/status’, adminAuth, async (req, res) => {
try {
const { type, id } = req.params;
const { status, adminNotes } = req.body;

```
const Model = type === 'shipper' ? Shipper
            : type === 'ride_driver' ? RideDriver
            : getPartnerModel(type);
if (!Model) return res.status(400).json({ success: false, message: 'Type không hợp lệ' });

const valid = ['pending','reviewing','approved','rejected','active','suspended'];
if (!valid.includes(status)) return res.status(400).json({ success: false, message: 'Status không hợp lệ' });

const update = { status, adminNotes };
if (status === 'approved') update.approvedAt = new Date();

const record = await Model.findByIdAndUpdate(id, update, { new: true });
if (!record) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

// SMS thông báo kết quả
const smsMap = {
  approved: `CRABOR: Ho so ${record.registerId} da duoc DUYET. Chung toi se lien he huong dan buoc tiep theo.`,
  rejected: `CRABOR: Ho so ${record.registerId} chua du dieu kien. Vui long lien he hotline de biet them.`,
  active:   `CRABOR: Tai khoan cua ban da duoc kich hoat. Hay tai app CRABOR va bat dau ngay!`,
};
if (smsMap[status]) await sendSms(record.phone,
  smsMap[status]).catch(()=>{});

req.io.to('admin').emit('registrationStatusUpdated', { id, type, status, registerId: record.registerId });
res.json({ success: true, data: record });
```

} catch (err) {
res.status(500).json({ success: false, message: err.message });
}
});

// ══════════════════════════════════════
//  15. SETUP DEFAULT ADMIN
// ══════════════════════════════════════
async function setupDefaultAdmin() {
const count = await Admin.countDocuments().catch(() => 0);
if (count === 0) {
const pass = process.env.ADMIN_DEFAULT_PASS || ‘Crabor@2025’;
await Admin.create({ username: ‘admin’, password: pass, role: ‘superadmin’, name: ‘CRABOR Admin’ }).catch(()=>{});
console.log(‘👑 Admin mặc định: admin / ’ + pass);
console.log(’   ⚠️  Đổi mật khẩu sau lần đăng nhập đầu!’);
}
}

// ══════════════════════════════════════
//  16. START SERVER
// ══════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
const env = process.env.NODE_ENV || ‘development’;
console.log(` ╔════════════════════════════════════════╗ ║   🦀  CRABOR Super App — Server       ║ ╠════════════════════════════════════════╣ ║  🚀  Port        : ${PORT}                 ║ ║  🌍  Environment : ${env.padEnd(12)}      ║ ║  📦  DB          : crabor (Atlas)      ║ ╠════════════════════════════════════════╣ ║  🏠  Landing     : /                  ║ ║  👤  Customer    : /customer           ║ ║  🛵  Shipper     : /shipper            ║ ║  🤝  Partner     : /partner            ║ ║  👑  Admin       : /admin              ║ ╠════════════════════════════════════════╣ ║  📝  Shipper reg : /shipper/register   ║ ║  📝  Partner reg : /partner/register   ║ ╠════════════════════════════════════════╣ ║  🔑  Admin API   : /api/admin/stats    ║ ║  📊  Analytics   : /api/analytics/     ║ ╚════════════════════════════════════════╝`);
await setupDefaultAdmin();
});

module.exports = { app, server, io };
