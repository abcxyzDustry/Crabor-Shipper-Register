require("dotenv").config();

const express    = require("express");
const http       = require("http");
const socketIo   = require("socket.io");
const mongoose   = require("mongoose");
const cors       = require("cors");
const session    = require("express-session");
const MongoStore = require("connect-mongo");
const path       = require("path");
const crypto     = require("crypto");
const axios      = require("axios");

// App & Socket bootstrap ──
const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==========================================
//  1. MONGODB CONNECTION
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("[ERR] Thiếu MONGODB_URI trong .env");
  process.exit(1);
}

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("[OK] MongoDB Atlas connected — DB: crabor"))
  .catch(err => { console.error("[ERR] MongoDB error:", err.message); process.exit(1); });

// ==========================================
//  2. MIDDLEWARE
// ==========================================
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session (dùng cho app core: customer / shipper / partner interfaces)
app.use(session({
  secret: process.env.SESSION_SECRET || "crabor-session-secret-2025",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI, ttl: 24 * 60 * 60 }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Static files
app.use(express.static(path.join(__dirname, "public")));

// Đưa io vào req để dùng trong route handlers
app.use((req, res, next) => { req.io = io; next(); });

// ==========================================
//  3. SOCKET.IO — REAL-TIME
// ==========================================
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  // Vào phòng theo order / user / shipper / admin
  socket.on("joinRoom", (room) => {
    socket.join(room);
    console.log(`   ↳ ${socket.id} joined [${room}]`);
  });

  // Customer / shipper cập nhật trạng thái đơn
  socket.on("orderUpdate", (data) => {
    io.to(`order_${data.orderId}`).emit("orderStatusChanged", data);
    io.to("admin").emit("newOrderNotification", data);
    io.to(`customer_${data.customerId}`).emit("orderStatusChanged", data);
  });

  // Shipper gửi vị trí GPS
  socket.on("shipperLocation", (data) => {
    io.to(`order_${data.orderId}`).emit("shipperTracking", data);
    io.to("admin").emit("shipperLocationUpdate", data);
  });

  // Đối tác giặt là / giúp việc cập nhật trạng thái
  socket.on("partnerUpdate", (data) => {
    io.to(`order_${data.orderId}`).emit("partnerStatusChanged", data);
    io.to("admin").emit("partnerNotification", data);
  });

  socket.on("disconnect", () => {
    console.log("🔌 Client disconnected:", socket.id);
  });
});

// ==========================================
//  4. SCHEMAS & MODELS
// ==========================================

// OTP — Twilio Verify quản lý, không lưu DB ──────

// USER (khách hàng app) ──────────────
// ==========================================
//  3. DATABASE SCHEMAS + INDEXES
// ==========================================

// ── Helpers ──────────────────────────────
const PHONE_RE = /^0[0-9]{9}$/;
const normalizePhone = (p) => (p || "").toString().trim().replace(/\s/g, "");

// ── USER (khách hàng) ─────────────────────
const userSchema = new mongoose.Schema({
  phone:           { type: String, required: true, unique: true, trim: true,
                     validate: { validator: v => PHONE_RE.test(v), message: "SĐT không hợp lệ (0xxxxxxxxx)" } },
  fullName:        { type: String, trim: true, maxlength: 100 },
  refCode:         { type: String, trim: true, uppercase: true },
  email:           { type: String, trim: true, lowercase: true,
                     validate: { validator: v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), message: "Email không hợp lệ" } },
  avatar:          String,
  address:         { type: String, trim: true, maxlength: 300 },
  district:        { type: String, trim: true },
  role:            { type: String, enum: ["customer","admin","staff"], default: "customer" },
  status:          { type: String, enum: ["active","banned"], default: "active" },
  totalOrders:     { type: Number, default: 0, min: 0 },
  totalSpent:      { type: Number, default: 0, min: 0 },
  loyaltyPts:      { type: Number, default: 0, min: 0 },
  fcmToken:        String,
  profileComplete: { type: Boolean, default: false },
  dob:             { type: String, trim: true },
  gender:          { type: String, enum: ["male","female","other"] },
}, { timestamps: true });

// Indexes
userSchema.index({ phone: 1 });                        // login lookup
userSchema.index({ status: 1 });                       // admin filter
userSchema.index({ createdAt: -1 });                   // sort mới nhất
userSchema.index({ fullName: "text", phone: "text" }); // search

userSchema.pre("save", function(next) {
  this.phone = normalizePhone(this.phone);
  next();
});
const User = mongoose.model("User", userSchema);

// ── PRODUCT ───────────────────────────────
const productSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, minlength: 2, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 1000 },
  price:       { type: Number, required: true, min: 0 },
  image:       String,
  category:    { type: String, trim: true },
  partnerId:   { type: mongoose.Schema.Types.ObjectId, ref: "FoodPartner", required: true },
  available:   { type: Boolean, default: true },
  sold:        { type: Number, default: 0, min: 0 },
  rating:      { type: Number, default: 0, min: 0, max: 5 },
}, { timestamps: true });

productSchema.index({ partnerId: 1, available: 1 });   // menu query
productSchema.index({ category: 1 });                  // filter by category
productSchema.index({ sold: -1 });                     // best seller
productSchema.index({ name: "text", description: "text" }); // search
const Product = mongoose.model("Product", productSchema);

// ── ORDER ─────────────────────────────────
const orderSchema = new mongoose.Schema({
  orderId:      { type: String, unique: true },
  module:       { type: String, enum: ["food","laundry","cleaning","china_shop","ride"], required: true },
  customerId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  shipperId:    { type: mongoose.Schema.Types.ObjectId, ref: "Shipper" },
  partnerId:    { type: mongoose.Schema.Types.ObjectId },
  items:        [{
    productId:  mongoose.Schema.Types.ObjectId,
    name:       { type: String, required: true },
    qty:        { type: Number, required: true, min: 1 },
    price:      { type: Number, required: true, min: 0 },
  }],
  address:      { type: String, required: true, trim: true },
  district:     { type: String, trim: true },
  total:        { type: Number, required: true, min: 0 },
  serviceFee:   { type: Number, default: 0, min: 0 },
  shipFee:      { type: Number, default: 0, min: 0 },
  discount:     { type: Number, default: 0, min: 0 },
  finalTotal:   { type: Number, min: 0 },
  status:       { type: String, enum: ["pending","confirmed","preparing","picked_up","delivering","delivered","cancelled","refunded"], default: "pending" },
  paymentMethod:{ type: String, enum: ["cash","momo","zalopay","bank"], default: "cash" },
  paymentStatus:{ type: String, enum: ["unpaid","paid","refunded"], default: "unpaid" },
  note:         { type: String, trim: true, maxlength: 500 },
  cancelReason: { type: String, trim: true },
  statusHistory:[ { status: String, time: { type: Date, default: Date.now }, by: String } ],
  confirmedAt:  Date,
  deliveredAt:  Date,
}, { timestamps: true });

orderSchema.index({ customerId: 1, createdAt: -1 });   // customer history
orderSchema.index({ shipperId: 1, status: 1 });        // shipper active orders
orderSchema.index({ partnerId: 1, status: 1 });        // partner dashboard
orderSchema.index({ status: 1, createdAt: -1 });       // admin filter
orderSchema.index({ orderId: 1 });                     // order lookup
orderSchema.index({ module: 1, createdAt: -1 });       // analytics

orderSchema.pre("save", function(next) {
  if (!this.orderId) {
    this.orderId = "ORD-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substr(2,4).toUpperCase();
  }
  this.finalTotal = Math.max(0, (this.total||0) + (this.shipFee||0) + (this.serviceFee||0) - (this.discount||0));
  next();
});
const Order = mongoose.model("Order", orderSchema);

// ── SHIPPER ───────────────────────────────
const shipperSchema = new mongoose.Schema({
  registerId:  { type: String, unique: true, sparse: true },
  phone:       { type: String, required: true, unique: true, trim: true,
                 validate: { validator: v => PHONE_RE.test(v), message: "SĐT không hợp lệ" } },
  firstName:   { type: String, required: true, trim: true, maxlength: 50 },
  lastName:    { type: String, required: true, trim: true, maxlength: 50 },
  fullName:    { type: String, trim: true },
  refCode:     { type: String, trim: true, uppercase: true },
  email:       { type: String, trim: true, lowercase: true },
  dob:         { type: String, trim: true },
  cccd:        { type: String, trim: true },
  address:     { type: String, trim: true, maxlength: 300 },
  district:    { type: String, trim: true },
  vehicle:     { type: String, enum: ["motorbike","bicycle","car",""], default: "motorbike" },
  vehiclePlate:{ type: String, trim: true, uppercase: true },
  plan:        { type: String, enum: ["early_bird","standard"], default: "early_bird" },
  fee:         { type: Number, default: 500000, min: 0 },
  feeStatus:   { type: String, enum: ["unpaid","paid"], default: "unpaid" },
  status:      { type: String, enum: ["pending","reviewing","approved","rejected","active","suspended"], default: "pending" },
  online:      { type: Boolean, default: false },
  location:    { lat: { type: Number }, lng: { type: Number } },
  totalOrders: { type: Number, default: 0, min: 0 },
  totalEarned: { type: Number, default: 0, min: 0 },
  rating:      { type: Number, default: 0, min: 0, max: 5 },
  ratingCount: { type: Number, default: 0, min: 0 },
  documents:   { cccdFront: String, cccdBack: String, selfie: String, vehicleImg: String },
  earlyBird:   {
    discountRate:     { type: Number, default: 9 },
    ordersCompleted:  { type: Number, default: 0 },
    refunded:         { type: Boolean, default: false },
  },
  adminNotes:  String,
  totalOrders:      { type: Number, default: 0, min: 0 },
  ordersCompleted:  { type: Number, default: 0, min: 0 },
  ordersCancelled:  { type: Number, default: 0, min: 0 },
  rating:           { type: Number, default: 5.0, min: 1, max: 5 },
  totalEarnings:    { type: Number, default: 0, min: 0 },
  approvedAt:  Date,
}, { timestamps: true });

shipperSchema.index({ phone: 1 });
shipperSchema.index({ status: 1, createdAt: -1 });
shipperSchema.index({ district: 1, status: 1, online: 1 }); // dispatch query
shipperSchema.index({ plan: 1 });

shipperSchema.pre("save", function(next) {
  this.phone = normalizePhone(this.phone);
  if (!this.registerId) this.registerId = "CRB-S-" + Math.random().toString(36).substr(2,6).toUpperCase();
  this.fullName = `${(this.lastName||"")} ${(this.firstName||"")}`.trim();
  next();
});
const Shipper = mongoose.model("Shipper", shipperSchema);

// ── PARTNER BASE ──────────────────────────
const partnerBase = {
  registerId:   { type: String, unique: true, sparse: true },
  phone:        { type: String, required: true, unique: true, trim: true,
                  validate: { validator: v => PHONE_RE.test(v), message: "SĐT không hợp lệ" } },
  refCode:     { type: String, trim: true, uppercase: true },
  firstName:    { type: String, required: true, trim: true, maxlength: 50 },
  lastName:     { type: String, required: true, trim: true, maxlength: 50 },
  fullName:     { type: String, trim: true },
  email:        { type: String, required: true, trim: true, lowercase: true,
                  validate: { validator: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), message: "Email không hợp lệ" } },
  address:      { type: String, required: true, trim: true, maxlength: 300 },
  district:     { type: String, required: true, trim: true },
  commission:   { type: Number, min: 0, max: 100 },
  status:       { type: String, enum: ["pending","reviewing","approved","rejected","active","suspended"], default: "pending" },
  adminNotes:   { type: String, trim: true },
  approvedAt:   Date,
};

// ── GIẶT LÀ ──────────────────────────────
const giatLaSchema = new mongoose.Schema({
  ...partnerBase,
  bizName:    { type: String, required: true, trim: true, maxlength: 200 },
  bizYear:    { type: Number, min: 1990, max: new Date().getFullYear() },
  services:   [{ type: String, trim: true }],
  pricePerKg: { type: Number, min: 0 },
  capacity:   { type: Number, min: 0 },
  turnaround: { type: String, trim: true },
  openTime:   { type: String, trim: true },
  closeTime:  { type: String, trim: true },
  documents:  { cccdFront: String, cccdBack: String, shopFront: String, shopInside: String },
}, { timestamps: true });

giatLaSchema.index({ phone: 1 });
giatLaSchema.index({ status: 1, district: 1 });
giatLaSchema.pre("save", function(next) {
  this.phone = normalizePhone(this.phone);
  if (!this.registerId) this.registerId = "CRB-GL-" + Math.random().toString(36).substr(2,6).toUpperCase();
  this.fullName = `${this.lastName||""} ${this.firstName||""}`.trim();
  if (!this.commission) this.commission = 18;
  next();
});
const GiatLa = mongoose.model("GiatLaPartner", giatLaSchema, "giatla_partners");

// ── GIÚP VIỆC ─────────────────────────────
const giupViecSchema = new mongoose.Schema({
  ...partnerBase,
  dob:             { type: String, trim: true },
  experience:      { type: String, trim: true },
  skills:          [{ type: String, trim: true }],
  availableShifts: [{ type: String, trim: true }],
  maxShiftsPerWeek:{ type: Number, default: 7, min: 0, max: 7 },
  transport:       { type: String, trim: true },
  totalEarnings:   { type: Number, default: 0, min: 0 },
  completedShifts: { type: Number, default: 0, min: 0 },
  rating:          { type: Number, default: 0, min: 0, max: 5 },
  documents:       { cccdFront: String, cccdBack: String, selfie: String },
}, { timestamps: true });

giupViecSchema.index({ phone: 1 });
giupViecSchema.index({ status: 1, district: 1 });
giupViecSchema.pre("save", function(next) {
  this.phone = normalizePhone(this.phone);
  if (!this.registerId) this.registerId = "CRB-GV-" + Math.random().toString(36).substr(2,6).toUpperCase();
  this.fullName = `${this.lastName||""} ${this.firstName||""}`.trim();
  if (!this.commission) this.commission = 15;
  next();
});
const GiupViec = mongoose.model("GiupViecPartner", giupViecSchema, "giupviec_partners");

// ── CHINA SHOP ────────────────────────────
const chinaShopSchema = new mongoose.Schema({
  ...partnerBase,
  bizName:       { type: String, required: true, trim: true, maxlength: 200 },
  sourceType:    { type: String, trim: true },
  categories:    [{ type: String, trim: true }],
  skuCount:      { type: Number, min: 0 },
  avgOrderValue: { type: Number, min: 0 },
  shippingDays:  { type: Number, min: 0, max: 60 },
  description:   { type: String, trim: true, maxlength: 1000 },
  shopFee:       { type: Number, default: 500000, min: 0 },
  shopFeeStatus: { type: String, enum: ["unpaid","paid"], default: "unpaid" },
  totalSales:    { type: Number, default: 0, min: 0 },
  sampleSubmitted:{ type: Boolean, default: false },
  documents:     { cccdFront: String, cccdBack: String, productSample: String, importDoc: String },
}, { timestamps: true });

chinaShopSchema.index({ phone: 1 });
chinaShopSchema.index({ status: 1 });
chinaShopSchema.pre("save", function(next) {
  this.phone = normalizePhone(this.phone);
  if (!this.registerId) this.registerId = "CRB-CS-" + Math.random().toString(36).substr(2,6).toUpperCase();
  this.fullName = `${this.lastName||""} ${this.firstName||""}`.trim();
  if (!this.commission) this.commission = 12;
  next();
});
const ChinaShop = mongoose.model("ChinaShopPartner", chinaShopSchema, "chinashop_partners");

// ── FOOD PARTNER ─────────────────────────
const foodPartnerSchema = new mongoose.Schema({
  registerId:  { type: String, unique: true, sparse: true },
  phone:       { type: String, required: true, unique: true, trim: true,
                 validate: { validator: v => PHONE_RE.test(v), message: "SĐT không hợp lệ" } },
  firstName:   { type: String, trim: true, maxlength: 50 },
  lastName:    { type: String, trim: true, maxlength: 50 },
  email:       { type: String, trim: true, lowercase: true },
  bizName:     { type: String, required: true, trim: true, maxlength: 200 },
  address:     { type: String, required: true, trim: true, maxlength: 300 },
  district:    { type: String, trim: true },
  categories:  [{ type: String, trim: true }],
  openTime:    { type: String, trim: true },
  closeTime:   { type: String, trim: true },
  priceRange:  { type: String, trim: true },
  description: { type: String, trim: true, maxlength: 1000 },
  avatar:      String,
  coverImage:  String,
  rating:      { type: Number, default: 0, min: 0, max: 5 },
  ratingCount: { type: Number, default: 0, min: 0 },
  totalOrders: { type: Number, default: 0, min: 0 },
  commission:  { type: Number, default: 20, min: 0, max: 100 },
  status:      { type: String, enum: ["pending","approved","rejected","suspended"], default: "pending" },
  adminNotes:  { type: String, trim: true },
  approvedAt:  Date,
}, { timestamps: true });

foodPartnerSchema.index({ phone: 1 });
foodPartnerSchema.index({ status: 1, district: 1 });
foodPartnerSchema.index({ district: 1, rating: -1 });  // customer listing
foodPartnerSchema.index({ bizName: "text", description: "text" }); // search
foodPartnerSchema.pre("save", function(next) {
  this.phone = normalizePhone(this.phone);
  if (!this.registerId) this.registerId = "CRB-FP-" + Date.now().toString(36).toUpperCase();
  next();
});
const FoodPartner = mongoose.model("FoodPartner", foodPartnerSchema, "food_partners");

// ── RIDE DRIVER ───────────────────────────
const rideDriverSchema = new mongoose.Schema({
  registerId:   { type: String, unique: true, sparse: true },
  phone:        { type: String, required: true, unique: true, trim: true,
                  validate: { validator: v => PHONE_RE.test(v), message: "SĐT không hợp lệ" } },
  firstName:    { type: String, trim: true, maxlength: 50 },
  lastName:     { type: String, trim: true, maxlength: 50 },
  fullName:     { type: String, trim: true },
  email:        { type: String, trim: true, lowercase: true },
  address:      { type: String, trim: true, maxlength: 300 },
  district:     { type: String, trim: true },
  dob:          { type: String, trim: true },
  cccd:         { type: String, trim: true },
  vehicleType:  { type: String, enum: ["motorbike","car",""], default: "motorbike" },
  vehicleBrand: { type: String, trim: true },
  vehiclePlate: { type: String, trim: true, uppercase: true },
  vehicleYear:  { type: Number, min: 1990 },
  licenseClass: { type: String, enum: ["A1","A2","B1","B2",""], trim: true },
  status:       { type: String, enum: ["pending","approved","rejected","suspended"], default: "pending" },
  online:       { type: Boolean, default: false },
  totalTrips:   { type: Number, default: 0, min: 0 },
  totalEarned:  { type: Number, default: 0, min: 0 },
  rating:       { type: Number, default: 0, min: 0, max: 5 },
  adminNotes:   { type: String, trim: true },
  approvedAt:   Date,
  documents:    { cccdFront: String, cccdBack: String, selfie: String, licenseImg: String, vehicleImg: String },
}, { timestamps: true });

rideDriverSchema.index({ phone: 1 });
rideDriverSchema.index({ status: 1 });
rideDriverSchema.index({ district: 1, status: 1, online: 1 });
rideDriverSchema.pre("save", function(next) {
  this.phone = normalizePhone(this.phone);
  if (!this.registerId) this.registerId = "CRB-RX-" + Date.now().toString(36).toUpperCase();
  this.fullName = `${this.lastName||""} ${this.firstName||""}`.trim();
  next();
});
const RideDriver = mongoose.model("RideDriver", rideDriverSchema, "ride_drivers");

// ── ADMIN ─────────────────────────────────
const adminSchema = new mongoose.Schema({
  username:  { type: String, unique: true, required: true, trim: true, lowercase: true, minlength: 3, maxlength: 50 },
  password:  { type: String, required: true },
  role:      { type: String, enum: ["superadmin","admin","staff"], default: "admin" },
  name:      { type: String, trim: true },
  lastLogin: Date,
}, { timestamps: true });

const Admin = mongoose.model("Admin", adminSchema);
// ── SALES ─────────────────────────────
const salesSchema = new mongoose.Schema({
  phone:       { type: String, required: true, unique: true, trim: true,
                 validate: { validator: v => PHONE_RE.test(v), message: "SĐT không hợp lệ" } },
  fullName:    { type: String, required: true, trim: true, maxlength: 100 },
  email:       { type: String, trim: true, lowercase: true },
  refCode:     { type: String, unique: true, sparse: true, uppercase: true },
  walletBalance: { type: Number, default: 0, min: 0 },
  totalEarned:   { type: Number, default: 0, min: 0 },
  status:      { type: String, enum: ["active","suspended"], default: "active" },
  notes:       { type: String, trim: true, maxlength: 500 },
}, { timestamps: true });
salesSchema.index({ phone: 1 });
salesSchema.index({ refCode: 1 });
const Sales = mongoose.model("Sales", salesSchema, "sales");

// ── REFERRAL ──────────────────────────
const referralSchema = new mongoose.Schema({
  salesId:     { type: mongoose.Schema.Types.ObjectId, ref: "Sales", required: true },
  refCode:     { type: String, required: true, uppercase: true },
  targetType:  { type: String, enum: ["user","shipper","partner"], required: true },
  targetId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  targetPhone: { type: String, trim: true },
  targetName:  { type: String, trim: true },
  module:      { type: String, trim: true },             // partner module
  status:      { type: String, enum: ["pending","earned"], default: "pending" },
  earnedAt:    { type: Date },
  orderId:     { type: mongoose.Schema.Types.ObjectId }, // triggering order
  amount:      { type: Number, default: 2000 },
}, { timestamps: true });
referralSchema.index({ salesId: 1, createdAt: -1 });
referralSchema.index({ refCode: 1 });
referralSchema.index({ targetId: 1 });
const Referral = mongoose.model("Referral", referralSchema, "referrals");


// ── APP CONFIG ────────────────────────
const configSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });
const Config = mongoose.model("Config", configSchema);

// Default config helper
async function getConfig(key, defaultVal) {
  const doc = await Config.findOne({ key }).lean();
  return doc ? doc.value : defaultVal;
}
async function setConfig(key, value) {
  await Config.findOneAndUpdate({ key }, { value }, { upsert: true });
}





// ==========================================
//  5. HELPERS
// ==========================================

function getPartnerModel(mod) {
  const slug = {
    gl: GiatLa, gv: GiupViec, cs: ChinaShop, fd: FoodPartner, rx: RideDriver,
    giat_la: GiatLa, giup_viec: GiupViec, china_shop: ChinaShop,
    food_partner: FoodPartner, ride_driver: RideDriver
  };
  return slug[mod] || null;
}

function slugify(fe) {
  return { gl: "giat_la", gv: "giup_viec", cs: "china_shop", fd: "food_partner", rx: "ride_driver" }[fe] || fe;
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

// ==========================================
//  TWILIO HELPERS
// ==========================================

// Chuyển SĐT VN sang E.164: 0912345678 → +84912345678
function toE164(phone) {
  const p = phone.toString().trim();
  if (p.startsWith("+")) return p;
  if (p.startsWith("84")) return "+" + p;
  if (p.startsWith("0")) return "+84" + p.slice(1);
  return "+84" + p;
}

const TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY  = process.env.TWILIO_VERIFY_SID;
const TWILIO_FROM    = process.env.TWILIO_PHONE_FROM; // cho SMS thông báo

// Gửi OTP qua Twilio Verify
async function twilioSendOtp(phone) {
  const to = toE164(phone);
  if (!TWILIO_SID || TWILIO_SID === "your_twilio_sid") {
    console.log(` [DEV-OTP] ${to}: <sẽ gửi qua Twilio Verify>`);
    return { success: true, dev: true };
  }
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY}/Verifications`;
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
  const r = await axios.post(url,
    new URLSearchParams({ To: to, Channel: "sms" }).toString(),
    { headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000 }
  );
  if (!["pending","approved"].includes(r.data.status))
    throw new Error("Twilio Verify: " + r.data.status);
  return { success: true };
}

// Kiểm tra OTP qua Twilio Verify
async function twilioCheckOtp(phone, code) {
  const to = toE164(phone);
  if (!TWILIO_SID || TWILIO_SID === "your_twilio_sid") {
    // Dev mode: chấp nhận bất kỳ 6 số
    return /^[0-9]{6}$/.test(code);
  }
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY}/VerificationChecks`;
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
  try {
    const r = await axios.post(url,
      new URLSearchParams({ To: to, Code: code }).toString(),
      { headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000 }
    );
    return r.data.status === "approved";
  } catch (err) {
    // Twilio trả 404 nếu code sai / hết hạn
    return false;
  }
}

// Gửi SMS thông báo qua Twilio Messaging (không phải OTP)
async function sendSms(phone, message) {
  const to = toE164(phone);
  if (!TWILIO_SID || TWILIO_SID === "your_twilio_sid" || !TWILIO_FROM) {
    console.log(` [DEV-SMS] ${to}: ${message}`);
    return true;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
  await axios.post(url,
    new URLSearchParams({ To: to, From: TWILIO_FROM, Body: message }).toString(),
    { headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 12000 }
  );
  return true;
}

// ==========================================
//  6. ROUTES: HTML PAGES
// ==========================================


// ── SALES HELPER ──────────────────────
function generateRefCode(phone) {
  const suffix = phone.slice(-4);
  const rand = Math.random().toString(36).substring(2,5).toUpperCase();
  return "CR" + rand + suffix;
}

async function createUniqueRefCode(phone) {
  let code, exists = true;
  while (exists) {
    code = generateRefCode(phone);
    exists = await Sales.exists({ refCode: code });
  }
  return code;
}

// Process referral when order completes
async function processReferralReward(targetId, targetType, io) {
  try {
    const ref = await Referral.findOne({ targetId, targetType, status: "pending" });
    if (!ref) return;
    // Mark earned
    ref.status = "earned";
    ref.earnedAt = new Date();
    await ref.save();
    // Add to sales wallet
    await Sales.findByIdAndUpdate(ref.salesId, {
      $inc: { walletBalance: ref.amount, totalEarned: ref.amount }
    });
    // Notify admin
    if (io) io.to("admin").emit("salesReward", { salesId: ref.salesId, refCode: ref.refCode, amount: ref.amount, targetType });
  } catch(e) {
    console.error("Referral reward error:", e.message);
  }
}


// ══════════════════════════════════════
//  SALES ENDPOINTS
// ══════════════════════════════════════

// POST /api/sales/register — tạo tài khoản sales
app.post("/api/sales/register", async (req, res) => {
  try {
    const { phone, fullName, email, otp } = req.body;
    if (!phone || !fullName) return res.status(400).json({ success: false, message: "Thiếu SĐT hoặc họ tên" });
    const norm = normalizePhone(phone);
    if (!PHONE_RE.test(norm)) return res.status(400).json({ success: false, message: "SĐT không hợp lệ" });

    // Verify OTP
    const verified = await verifyOtp(norm, otp);
    if (!verified) return res.status(400).json({ success: false, message: "Mã OTP không đúng hoặc đã hết hạn" });

    const exists = await Sales.findOne({ phone: norm });
    if (exists) return res.status(409).json({ success: false, message: "SĐT này đã có tài khoản Sales" });

    const refCode = await createUniqueRefCode(norm);
    const agent = await Sales.create({ phone: norm, fullName, email, refCode });
    req.io.to("admin").emit("newSales", { id: agent._id, phone: norm, fullName, refCode });
    res.json({ success: true, data: { refCode, fullName, phone: norm, id: agent._id } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/sales/login — đăng nhập bằng OTP
app.post("/api/sales/login", async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const norm = normalizePhone(phone);
    const verified = await verifyOtp(norm, otp);
    if (!verified) return res.status(400).json({ success: false, message: "OTP không đúng" });
    const agent = await Sales.findOne({ phone: norm });
    if (!agent) return res.status(404).json({ success: false, message: "Tài khoản không tồn tại" });
    if (agent.status === "suspended") return res.status(403).json({ success: false, message: "Tài khoản bị tạm khóa" });
    req.session.salesId = agent._id.toString();
    req.session.role = "sales";
    res.json({ success: true, data: { refCode: agent.refCode, fullName: agent.fullName, walletBalance: agent.walletBalance } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/sales/me — thông tin + danh sách referrals
app.get("/api/sales/me", async (req, res) => {
  try {
    if (!req.session.salesId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const agent = await Sales.findById(req.session.salesId);
    if (!agent) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    const referrals = await Referral.find({ salesId: agent._id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, data: { ...agent.toObject(), referrals } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/validate-ref/:code — validate referral code (public)
app.get("/api/validate-ref/:code", async (req, res) => {
  try {
    const agent = await Sales.findOne({ refCode: req.params.code.toUpperCase(), status: "active" });
    if (!agent) return res.status(404).json({ success: false, message: "Mã giới thiệu không hợp lệ" });
    res.json({ success: true, salesName: agent.fullName });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/sales — danh sách sales (admin)
app.get("/api/admin/sales", adminAuth, async (req, res) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    const filter = q ? { $or: [
      { phone: { $regex: q } }, { fullName: { $regex: q, $options: "i" } }, { refCode: { $regex: q, $options: "i" } }
    ]} : {};
    const [agents, total] = await Promise.all([
      Sales.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(Number(limit)).lean(),
      Sales.countDocuments(filter)
    ]);
    // Attach referral counts per agent
    const ids = agents.map(a => a._id);
    const counts = await Referral.aggregate([
      { $match: { salesId: { $in: ids } } },
      { $group: { _id: "$salesId", total: { $sum: 1 }, earned: { $sum: { $cond: [{ $eq: ["$status","earned"] }, 1, 0] } } } }
    ]);
    const countMap = Object.fromEntries(counts.map(c => [c._id.toString(), c]));
    const result = agents.map(a => ({
      ...a,
      referralTotal: countMap[a._id.toString()]?.total || 0,
      referralEarned: countMap[a._id.toString()]?.earned || 0,
    }));
    res.json({ success: true, data: result, total });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/sales/:id/referrals — referrals của 1 sales (admin)
app.get("/api/admin/sales/:id/referrals", adminAuth, async (req, res) => {
  try {
    const refs = await Referral.find({ salesId: req.params.id }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, data: refs });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/sales/:id — cập nhật status sales (admin)
app.patch("/api/admin/sales/:id", adminAuth, async (req, res) => {
  try {
    const { status, walletBalance } = req.body;
    const update = {};
    if (status) update.status = status;
    if (walletBalance !== undefined) update.walletBalance = walletBalance;
    const agent = await Sales.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!agent) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    res.json({ success: true, data: agent });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/sales/:id — xóa tài khoản sales (admin)
app.delete("/api/admin/sales/:id", adminAuth, async (req, res) => {
  try {
    await Sales.findByIdAndDelete(req.params.id);
    await Referral.deleteMany({ salesId: req.params.id });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// DELETE /api/admin/registrations/:type/:id — Xóa hồ sơ vĩnh viễn
app.delete("/api/admin/registrations/:type/:id", adminAuth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const Model = type === "shipper" ? Shipper
                : type === "ride_driver" ? RideDriver
                : getPartnerModel(type);
    if (!Model) return res.status(400).json({ success: false, message: "Type không hợp lệ" });
    const doc = await Model.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ" });
    req.io.to("admin").emit("recordDeleted", { id, type, registerId: doc.registerId });
    res.json({ success: true, message: `Đã xóa hồ sơ ${doc.registerId}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/customers/:id — Xóa tài khoản khách hàng
app.delete("/api/admin/customers/:id", adminAuth, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy tài khoản" });
    res.json({ success: true, message: `Đã xóa tài khoản ${user.phone}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ══════════════════════════════════════
//  PAYMENT ENDPOINTS
// ══════════════════════════════════════

// GET /api/public/earlybird — public endpoint (no auth) để check slots
app.get("/api/public/earlybird", async (req, res) => {
  try {
    const ebMax  = await getConfig("earlyBirdMax", 50);
    const ebUsed = await Shipper.countDocuments({ plan: "early_bird" });
    const slotsLeft = Math.max(0, ebMax - ebUsed);
    res.json({ success: true, slotsLeft, ebMax, ebUsed, isEarlyBird: slotsLeft > 0 });
  } catch(err) {
    res.status(500).json({ success: false, slotsLeft: 0 });
  }
});


// GET /api/payment/plan — lấy thông tin gói thanh toán
app.get("/api/payment/plan", async (req, res) => {
  try {
    const { phone, id } = req.query;
    if (!phone && !id) return res.status(400).json({ success: false, message: "Thiếu phone hoặc mã hồ sơ" });

    // Find shipper
    const filter = phone ? { phone: normalizePhone(phone) } : { registerId: id };
    const shipper = await Shipper.findOne(filter).select("phone registerId plan fee feeStatus status");
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ Shipper" });

    // Get earlyBird max from config
    const ebMax = await getConfig("earlyBirdMax", 50);
    const ebUsed = await Shipper.countDocuments({ plan: "early_bird" });
    const slotsLeft = Math.max(0, ebMax - ebUsed);

    res.json({ success: true, data: {
      registerId: shipper.registerId,
      phone: shipper.phone,
      plan: shipper.plan,
      fee: shipper.fee,
      feeStatus: shipper.feeStatus,
      slotsLeft,
      ebMax,
    }});
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/payment/confirm — xác nhận thanh toán
app.post("/api/payment/confirm", async (req, res) => {
  try {
    const { phone, id } = req.query;
    const { paid } = req.body;
    if (!phone && !id) return res.status(400).json({ success: false, message: "Thiếu thông tin" });

    const filter = phone ? { phone: normalizePhone(phone) } : { registerId: id };
    const shipper = await Shipper.findOneAndUpdate(
      filter,
      { feeStatus: paid ? "paid" : "unpaid" },
      { new: true }
    ).select("registerId phone plan feeStatus");
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ" });

    // Notify admin
    req.io.to("admin").emit("paymentConfirmed", {
      registerId: shipper.registerId,
      phone: shipper.phone,
      plan: shipper.plan,
      paid,
    });

    res.json({ success: true, data: { registerId: shipper.registerId, paid } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/config/earlybird — lấy cấu hình early bird
app.get("/api/admin/config/earlybird", adminAuth, async (req, res) => {
  try {
    const ebMax  = await getConfig("earlyBirdMax", 50);
    const ebUsed = await Shipper.countDocuments({ plan: "early_bird" });
    res.json({ success: true, data: { ebMax, ebUsed, slotsLeft: Math.max(0, ebMax - ebUsed) } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/config/earlybird — cập nhật số suất early bird
app.patch("/api/admin/config/earlybird", adminAuth, async (req, res) => {
  try {
    const { ebMax } = req.body;
    if (typeof ebMax !== "number" || ebMax < 0) return res.status(400).json({ success: false, message: "Giá trị không hợp lệ" });
    await setConfig("earlyBirdMax", ebMax);
    res.json({ success: true, data: { ebMax } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// GET /api/register/lookup — Tra cứu hồ sơ bằng SĐT hoặc mã registerId
app.get("/api/register/lookup", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 6) return res.status(400).json({ success: false, message: "Nhập ít nhất 6 ký tự" });

    const query = q.trim();
    const isPhone = /^0[0-9]{8,9}$/.test(query);
    const filter = isPhone ? { phone: query } : { registerId: { $regex: query, $options: "i" } };

    const models = [
      { model: Shipper,     module: "shipper" },
      { model: GiatLa,      module: "giat_la" },
      { model: GiupViec,    module: "giup_viec" },
      { model: ChinaShop,   module: "china_shop" },
      { model: FoodPartner, module: "food_partner" },
      { model: RideDriver,  module: "ride_driver" },
    ];

    for (const { model, module } of models) {
      const doc = await model.findOne(filter).select("registerId phone fullName status registeredAt createdAt");
      if (doc) {
        return res.json({
          success: true,
          data: {
            registerId: doc.registerId,
            phone: doc.phone,
            fullName: doc.fullName,
            status: doc.status,
            module,
            registeredAt: doc.registeredAt || doc.createdAt,
          }
        });
      }
    }
    res.json({ success: false, message: "Không tìm thấy hồ sơ" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    const dbState = ["disconnected","connected","connecting","disconnecting"][mongoose.connection.readyState] || "unknown";
    const [users, shippers, gl, gv, cs, fp, rx, orders] = await Promise.all([
      User.estimatedDocumentCount(),
      Shipper.estimatedDocumentCount(),
      GiatLa.estimatedDocumentCount(),
      GiupViec.estimatedDocumentCount(),
      ChinaShop.estimatedDocumentCount(),
      FoodPartner.estimatedDocumentCount(),
      RideDriver.estimatedDocumentCount(),
      Order.estimatedDocumentCount(),
    ]);
    res.json({ status: "ok", db: dbState,
      counts: { users, shippers, partners: gl+gv+cs+fp+rx, orders },
      uptime: Math.floor(process.uptime()) + "s" });
  } catch(e) { res.status(500).json({ status: "error", message: e.message }); }
});

// Landing (root) — Màn hình chọn vai trò
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// 4 giao diện app chính (Capacitor wrapper sẽ trỏ vào đây)
app.get("/customer",  (req, res) => res.sendFile(path.join(__dirname, "public", "customer.html")));
app.get("/shipper",   (req, res) => res.sendFile(path.join(__dirname, "public", "shipper.html")));
app.get("/partner",   (req, res) => res.sendFile(path.join(__dirname, "public", "partner.html")));
app.get("/admin",     (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/sales",    (req, res) => res.sendFile(path.join(__dirname, "public", "sales.html")));
app.get("/payment",  (req, res) => res.sendFile(path.join(__dirname, "public", "payment.html")));

// Form đăng ký unified (public)
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
// Legacy routes (backward compat)
app.get("/shipper/register", (req, res) => res.redirect("/register"));
app.get("/partner/register", (req, res) => res.redirect("/register"));

// ==========================================
//  7. API: OTP (dùng chung toàn bộ)
// ==========================================

// POST /api/auth/send-otp
app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { phone, type = "auth" } = req.body;
    if (!/^0[0-9]{9}$/.test(phone))
      return res.status(400).json({ success: false, message: "Số điện thoại không hợp lệ" });

    if (!rateLimit(`otp:${phone}`, 3))
      return res.status(429).json({ success: false, message: "Gửi quá nhiều OTP. Thử lại sau 10 phút." });

    const result = await twilioSendOtp(phone);

    res.json({
      success: true, message: "OTP đã gửi qua Twilio",
      // Dev mode: không cần devOtp vì Twilio Verify xử lý hoặc chấp nhận bất kỳ 6 số
      ...(result.dev && { devOtp: "(any 6-digit)" })
    });
  } catch (err) {
    console.error("send-otp:", err.message);
    res.status(500).json({ success: false, message: "Không gửi được OTP: " + err.message });
  }
});

// POST /api/auth/verify-otp
app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { phone, otp, type = "auth" } = req.body;
    if (!phone || !otp)
      return res.status(400).json({ success: false, message: "Thiếu phone hoặc otp" });

    if (!rateLimit(`verify:${phone}`, 5))
      return res.status(429).json({ success: false, message: "Sai quá nhiều lần. Yêu cầu OTP mới." });

    const approved = await twilioCheckOtp(phone, otp);
    if (!approved)
      return res.status(400).json({ success: false, message: "Mã OTP không đúng hoặc đã hết hạn" });

    res.json({ success: true, message: "Xác minh thành công", phone });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/login — Customer login bằng OTP
app.post("/api/auth/login", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!/^0[0-9]{9}$/.test(phone))
      return res.status(400).json({ success: false, message: "Số điện thoại không hợp lệ" });

    let user = await User.findOne({ phone });
    const isNewUser = !user || !user.fullName || user.fullName === "Khách hàng CRABOR";

    if (!user) {
      user = await User.create({ phone });
    }
    user.lastLogin = new Date();
    await user.save();

    req.session.userId    = user._id;
    req.session.userPhone = user.phone;
    req.session.role      = user.role;

    res.json({
      success: true,
      isNewUser,
      user: { _id: user._id, phone: user.phone, fullName: user.fullName, email: user.email, district: user.district, role: user.role, totalOrders: user.totalOrders, loyaltyPts: user.loyaltyPts, totalSpent: user.totalSpent }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/complete-profile — Hoàn tất hồ sơ khách hàng sau OTP
app.post("/api/auth/complete-profile", async (req, res) => {
  try {
    if (!req.session.userId)
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { fullName, email, district, dob, gender, refCode } = req.body;
    if (!fullName || fullName.trim().length < 2)
      return res.status(400).json({ success: false, message: "Vui lòng nhập họ tên (ít nhất 2 ký tự)" });
    const updateData = { fullName: fullName.trim(), email, district, dob, gender, profileComplete: true };
    if (refCode) updateData.refCode = refCode.trim().toUpperCase();
    const user = await User.findByIdAndUpdate(req.session.userId, updateData, { new: true });
    // Save referral if refCode valid
    if (refCode) {
      const agent = await Sales.findOne({ refCode: refCode.trim().toUpperCase(), status: "active" });
      if (agent && user) {
        const alreadyRef = await Referral.exists({ targetId: user._id, targetType: "user" });
        if (!alreadyRef) {
          await Referral.create({
            salesId: agent._id, refCode: agent.refCode,
            targetType: "user", targetId: user._id,
            targetPhone: user.phone, targetName: fullName.trim()
          });
        }
      }
    }
    res.json({ success: true, user: { _id: user._id, phone: user.phone, fullName: user.fullName, email: user.email, district: user.district, role: user.role, totalOrders: user.totalOrders, loyaltyPts: user.loyaltyPts } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/shipper/me — Shipper tìm profile theo session phone
app.get("/api/shipper/me", async (req, res) => {
  try {
    const phone = req.session.userPhone;
    if (!phone) return res.status(401).json({ success: false, message: "Chưa xác thực" });
    const shipper = await Shipper.findOne({ phone });
    if (!shipper) return res.status(404).json({ success: false, message: "Chưa đăng ký shipper", notRegistered: true });
    res.json({ success: true, shipper });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/shipper/session — Tạo session cho shipper sau OTP
app.post("/api/shipper/session", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false });
    const shipper = await Shipper.findOne({ phone });
    if (!shipper) return res.status(404).json({ success: false, notRegistered: true });
    req.session.userPhone = phone;
    req.session.shipperId = shipper._id;
    req.session.role = "shipper";
    res.json({ success: true, shipper });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/partner/me — Partner tìm profile theo session phone
app.get("/api/partner/me", async (req, res) => {
  try {
    const phone = req.session.userPhone;
    if (!phone) return res.status(401).json({ success: false, message: "Chưa xác thực" });
    const models = [
      { model: GiatLa, module: "giat_la", name: "Giặt Là" },
      { model: GiupViec, module: "giup_viec", name: "Giúp Việc" },
      { model: ChinaShop, module: "china_shop", name: "China Shop" },
      { model: FoodPartner, module: "food_partner", name: "Nhà hàng" },
    ];
    for (const { model, module, name } of models) {
      const p = await model.findOne({ phone });
      if (p) return res.json({ success: true, partner: p, module, moduleName: name });
    }
    return res.status(404).json({ success: false, notRegistered: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/partner/session — Tạo session cho partner sau OTP
app.post("/api/partner/session", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false });
    const models = [
      { model: GiatLa, module: "giat_la" },
      { model: GiupViec, module: "giup_viec" },
      { model: ChinaShop, module: "china_shop" },
      { model: FoodPartner, module: "food_partner" },
    ];
    for (const { model, module } of models) {
      const p = await model.findOne({ phone });
      if (p) {
        req.session.userPhone = phone;
        req.session.partnerId = p._id;
        req.session.partnerModule = module;
        req.session.role = "partner";
        return res.json({ success: true, partner: p, module });
      }
    }
    return res.status(404).json({ success: false, notRegistered: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/logout
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// POST /api/auth/admin-login
app.post("/api/auth/admin-login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin) return res.status(401).json({ success: false, message: "Sai tên đăng nhập" });
    const bcrypt = require("bcryptjs");
    // Support both plain text (dev) and bcrypt hash (prod)
    const ok = admin.password === password ||
      await bcrypt.compare(password, admin.password).catch(() => false);
    if (!ok) return res.status(401).json({ success: false, message: "Sai mật khẩu" });
    req.session.adminId   = admin._id;
    req.session.adminUser = admin.username;
    req.session.role      = "admin";
    res.json({ success: true, admin: { username: admin.username, role: admin.role } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me
app.get("/api/auth/me", async (req, res) => {
  if (req.session.role === "shipper" && req.session.shipperId) {
    const shipper = await Shipper.findById(req.session.shipperId);
    return res.json({ success: true, role: "shipper", shipper });
  }
  if (req.session.role === "partner" && req.session.partnerId) {
    const model = getPartnerModel(req.session.partnerModule);
    if (model) {
      const partner = await model.findById(req.session.partnerId);
      return res.json({ success: true, role: "partner", partner, module: req.session.partnerModule });
    }
  }
  if (!req.session.userId) return res.status(401).json({ success: false });
  const user = await User.findById(req.session.userId).select("-__v");
  if (!user) return res.status(401).json({ success: false });
  res.json({ success: true, user });
});

// ==========================================
//  8. API: USERS
// ==========================================

// GET /api/users/profile
app.get("/api/users/profile", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
  const user = await User.findById(req.session.userId).select("-__v");
  res.json({ success: true, data: user });
});

// PATCH /api/users/profile
app.patch("/api/users/profile", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  const { fullName, email, address, district, fcmToken } = req.body;
  const user = await User.findByIdAndUpdate(
    req.session.userId,
    { fullName, email, address, district, fcmToken },
    { new: true, select: "-__v" }
  );
  res.json({ success: true, data: user });
});

// GET /api/users/:id/orders — lịch sử đơn
app.get("/api/users/:id/orders", async (req, res) => {
  try {
    const orders = await Order.find({ customerId: req.params.id })
      .sort({ createdAt: -1 }).limit(50).select("-__v");
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
//  9. API: PRODUCTS
// ==========================================

// GET /api/products
app.get("/api/products", async (req, res) => {
  try {
    const { category, partnerId, available = true, page = 1, limit = 30, q } = req.query;
    const filter = {};
    if (category)  filter.category  = category;
    if (partnerId) filter.partnerId = partnerId;
    if (available !== "all") filter.available = available === "true";
    if (q) filter.name = new RegExp(q, "i");

    const [data, total] = await Promise.all([
      Product.find(filter).sort({ sold: -1 }).skip((page-1)*limit).limit(Number(limit)),
      Product.countDocuments(filter)
    ]);
    res.json({ success: true, total, page: Number(page), data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/products/:id
app.get("/api/products/:id", async (req, res) => {
  const p = await Product.findById(req.params.id);
  if (!p) return res.status(404).json({ success: false, message: "Không tìm thấy sản phẩm" });
  res.json({ success: true, data: p });
});

// POST /api/products (admin)
app.post("/api/products", adminAuth, async (req, res) => {
  try {
    const p = await Product.create(req.body);
    res.status(201).json({ success: true, data: p });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/products/:id (admin)
app.patch("/api/products/:id", adminAuth, async (req, res) => {
  try {
    const p = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: p });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
//  10. API: ORDERS
// ==========================================

// POST /api/orders — Tạo đơn mới
app.post("/api/orders", async (req, res) => {
  try {
    const { module = "food", items, address, district, paymentMethod, note, customerId } = req.body;

    const uid = customerId || req.session.userId;
    if (!uid) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });

    // Tính tổng
    const total = (items || []).reduce((s, i) => s + i.price * i.qty, 0);
    const shipFee = total >= 150000 ? 0 : 15000;
    const serviceFee = Math.round(total * 0.02);

    const order = await Order.create({
      module, customerId: uid, items, address, district,
      total, shipFee, serviceFee,
      paymentMethod: paymentMethod || "cash",
      note,
      statusHistory: [{ status: "pending", time: new Date(), by: "system" }]
    });

    // Realtime: thông báo admin và shipper
    req.io.to("admin").emit("newOrder", { orderId: order.orderId, module, total: order.finalTotal });
    req.io.to("shippers").emit("newOrderAvailable", { orderId: order.orderId, district, total: order.finalTotal });

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    console.error("create order:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/orders — list (admin/shipper)
app.get("/api/orders", async (req, res) => {
  try {
    const { module, status, page = 1, limit = 20, shipperId, customerId } = req.query;
    const filter = {};
    if (module)     filter.module     = module;
    if (status)     filter.status     = status;
    if (shipperId)  filter.shipperId  = shipperId;
    if (customerId) filter.customerId = customerId;

    const [data, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(Number(limit)),
      Order.countDocuments(filter)
    ]);
    res.json({ success: true, total, page: Number(page), data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/orders/:id
app.get("/api/orders/:id", async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.id });
  if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });
  res.json({ success: true, data: order });
});

// PATCH /api/orders/:id/status
app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const { status, by = "system", shipperId } = req.body;
    const update = { status, $push: { statusHistory: { status, time: new Date(), by } } };
    if (shipperId) update.shipperId = shipperId;
    if (status === "delivered") update.deliveredAt = new Date();
    if (status === "confirmed") update.confirmedAt = new Date();

    const order = await Order.findOneAndUpdate({ orderId: req.params.id }, update, { new: true });
    if (!order) return res.status(404).json({ success: false });

    // Realtime
    req.io.to(`order_${order.orderId}`).emit("orderStatusChanged", { orderId: order.orderId, status });
    req.io.to(`customer_${order.customerId}`).emit("orderStatusChanged", { orderId: order.orderId, status });
    req.io.to("admin").emit("orderUpdated", { orderId: order.orderId, status });

    // When delivered → credit referral rewards + update shipper stats
    if (status === "delivered") {
      // Reward sales referral for customer
      if (order.customerId) {
        await processReferralReward(order.customerId, "user", req.io);
      }
      // Update shipper order stats
      if (order.shipperId || shipperId) {
        const sid = order.shipperId || shipperId;
        await Shipper.findByIdAndUpdate(sid, {
          $inc: { "earlyBird.ordersCompleted": 1, totalOrders: 1, ordersCompleted: 1 }
        }).catch(() => {});
      }
    }

    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
//  11. API: SHIPPER REGISTRATION
// ==========================================

// GET /api/shipper/earnings — thu nhập shipper theo kỳ
app.get("/api/shipper/earnings", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { period = "today" } = req.query;

    // Find shipper by session phone or userId
    const user = await User.findById(req.session.userId).select("phone");
    if (!user) return res.status(404).json({ success: false });
    const shipper = await Shipper.findOne({ phone: user.phone });
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ shipper" });

    // Date range
    const now = new Date();
    let since = new Date(0);
    if (period === "today") { since = new Date(); since.setHours(0,0,0,0); }
    else if (period === "week") { since = new Date(now - 7*24*3600*1000); }
    else if (period === "month") { since = new Date(now.getFullYear(), now.getMonth(), 1); }

    const matchBase = { shipperId: shipper._id };
    const matchPeriod = { ...matchBase, deliveredAt: { $gte: since } };

    const [allOrders, periodOrders, todayOrders] = await Promise.all([
      Order.find(matchBase).select("orderId deliveryFee finalTotal status deliveredAt createdAt").lean(),
      Order.find({ ...matchPeriod, status: "delivered" }).select("orderId deliveryFee finalTotal deliveredAt").lean(),
      Order.find({ ...matchBase, status: "delivered", deliveredAt: { $gte: (() => { const d=new Date(); d.setHours(0,0,0,0); return d; })() } }).select("deliveryFee").lean(),
    ]);

    const shipperCut = 0.85; // shipper gets 85% of delivery fee
    const totalEarnings   = allOrders.filter(o=>o.status==="delivered").reduce((s,o) => s + Math.round((o.deliveryFee||15000)*shipperCut), 0);
    const periodEarnings  = periodOrders.reduce((s,o) => s + Math.round((o.deliveryFee||15000)*shipperCut), 0);
    const todayEarnings   = todayOrders.reduce((s,o) => s + Math.round((o.deliveryFee||15000)*shipperCut), 0);
    const allDone         = allOrders.filter(o=>o.status==="delivered").length;
    const allCancelled    = allOrders.filter(o=>o.status==="cancelled").length;

    const transactions = periodOrders.map(o => ({
      type: "delivery",
      label: "Phí giao hàng",
      orderId: o.orderId,
      amount: Math.round((o.deliveryFee||15000)*shipperCut),
      createdAt: o.deliveredAt || o.createdAt,
    })).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ success: true, data: {
      totalEarnings, periodEarnings, todayEarnings,
      totalOrders: allOrders.length,
      periodOrders: periodOrders.length,
      avgPerOrder: periodOrders.length ? Math.round(periodEarnings / periodOrders.length) : 0,
      completionRate: allOrders.length ? Math.round(allDone / allOrders.length * 100) : 0,
      transactions,
    }});
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/shipper/profile — chi tiết hồ sơ shipper đăng nhập
app.get("/api/shipper/profile", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const user = await User.findById(req.session.userId).select("phone");
    if (!user) return res.status(404).json({ success: false });
    const shipper = await Shipper.findOne({ phone: user.phone }).lean();
    if (!shipper) return res.status(404).json({ success: false });
    res.json({ success: true, data: shipper });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// POST /api/shipper/register
app.post("/api/shipper/register", async (req, res) => {
  try {
    const { phone, firstName, lastName, email, dob, address, district, vehicle } = req.body;
    if (!phone || !firstName || !lastName || !email)
      return res.status(400).json({ success: false, message: "Thiếu thông tin bắt buộc" });

    const exists = await Shipper.findOne({ phone });
    if (exists) return res.status(409).json({ success: false, message: `SĐT đã đăng ký. Mã: ${exists.registerId}` });

    // Kiểm tra còn suất Early Bird
    // Early Bird: check dynamic max from Config
    const ebMax  = await getConfig("earlyBirdMax", 50);
    const ebCount = await Shipper.countDocuments({ plan: "early_bird" });
    const plan = ebCount < ebMax ? "early_bird" : "standard";

    const documents = req.body.documents || {};
    const shipper = await Shipper.create({
      phone, firstName, lastName, email, dob, address, district, vehicle,
      plan, fee: plan === "early_bird" ? 500000 : 700000,
      status: "pending", documents,
    });

    // Save referral if refCode provided
    const refCode = req.body.refCode;
    if (refCode) {
      const agent = await Sales.findOne({ refCode: refCode.toUpperCase(), status: "active" });
      if (agent) {
        await Referral.create({
          salesId: agent._id, refCode: agent.refCode,
          targetType: "shipper", targetId: shipper._id,
          targetPhone: phone, targetName: `${lastName} ${firstName}`.trim(),
          module: "shipper"
        });
      }
    }

    // SMS xác nhận
    await sendSms(phone,
      `CRABOR: Ho so Shipper cua ban (${shipper.registerId}) da duoc tiep nhan. Chung toi se lien he trong 24-48h.`).catch(() => {});

    req.io.to("admin").emit("newShipperApplication", { registerId: shipper.registerId, phone, district });
    console.log(` Shipper mới: ${shipper.registerId} — ${phone}`);
    res.json({ success: true, message: "Đăng ký thành công!", registerId: shipper.registerId, plan });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
//  12. API: PARTNER REGISTRATION (3 modules)
// ==========================================

// POST /api/partner/register
app.post("/api/partner/register", async (req, res) => {
  try {
    const {
      module: modFe, phone, firstName, lastName, email, address, district,
      bizName, nickname,
      bizYear, services, pricePerKg, capacity, turnaround, openTime, closeTime,
      dob, experience, skills, availableShifts, maxShiftsPerWeek, transport,
      sourceType, categories, skuCount, avgOrderValue, shippingDays, description,
      refCode,
    } = req.body;

    const mod   = slugify(modFe);
    const Model = getPartnerModel(mod);
    if (!Model) return res.status(400).json({ success: false, message: "Module không hợp lệ" });

    const exists = await Model.findOne({ phone });
    if (exists) return res.status(409).json({ success: false, message: `SĐT đã đăng ký. Mã: ${exists.registerId}` });

    const base = { phone, firstName, lastName, email, address, district, refCode: refCode?.toUpperCase(), documents: req.body.documents || {} };
    let data = { ...base };

    if (mod === "giat_la") {
      Object.assign(data, {
        bizName, bizYear, services, pricePerKg: Number(pricePerKg) || 0,
        capacity: Number(capacity) || 0, turnaround, openTime, closeTime,
      });
    } else if (mod === "giup_viec") {
      Object.assign(data, {
        nickname: nickname || `${lastName} ${firstName}`.trim(),
        dob, experience, skills, availableShifts,
        maxShiftsPerWeek: Number(maxShiftsPerWeek) || 7, transport,
      });
    } else if (mod === "china_shop") {
      Object.assign(data, {
        bizName, sourceType, categories,
        skuCount: Number(skuCount) || 0,
        avgOrderValue: Number(avgOrderValue) || 0,
        shippingDays: Number(shippingDays) || 10,
        description,
      });
    } else if (mod === "food_partner") {
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
      giat_la: "Giat La", giup_viec: "Giup Viec",
      china_shop: "China Shop", food_partner: "Nha hang"
    }[mod] || mod;

    // Referral tracking
    if (refCode) {
      const agent = await Sales.findOne({ refCode: refCode.toUpperCase(), status: "active" });
      if (agent) {
        await Referral.create({
          salesId: agent._id, refCode: agent.refCode,
          targetType: "partner", targetId: partner._id,
          targetPhone: phone, targetName: partner.bizName || `${firstName} ${lastName}`.trim(),
          module: mod
        });
      }
    }

    await sendSms(phone,
      `CRABOR: Ho so doi tac ${modName} (${partner.registerId}) da duoc tiep nhan. Chung toi se lien he trong 24-48h.`).catch(() => {});

    req.io.to("admin").emit("newPartnerApplication", { registerId: partner.registerId, module: mod, phone, district });
    console.log(` Partner mới [${mod}]: ${partner.registerId} — ${phone}`);
    res.json({ success: true, message: "Đăng ký thành công!", registerId: partner.registerId, module: mod });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: "SĐT hoặc email đã tồn tại" });
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/ride/register — Đăng ký tài xế công nghệ
app.post("/api/ride/register", async (req, res) => {
  try {
    const { phone, firstName, lastName, email, address, district,
            dob, vehicleType, vehicleBrand, vehiclePlate, vehicleYear, licenseClass } = req.body;
    if (!phone || !firstName || !lastName)
      return res.status(400).json({ success: false, message: "Thiếu thông tin bắt buộc" });
    const exists = await RideDriver.findOne({ phone });
    if (exists) return res.status(409).json({ success: false, message: `SĐT đã đăng ký. Mã: ${exists.registerId}` });
    const driver = await RideDriver.create({ phone, firstName, lastName, email, address, district,
      dob, vehicleType, vehicleBrand, vehiclePlate, vehicleYear: Number(vehicleYear)||0, licenseClass });
    await sendSms(phone,
      `CRABOR: Ho so tai xe cong nghe (${driver.registerId}) da duoc tiep nhan. Chung toi se lien he trong 24-48h.`
    ).catch(() => {});
    req.io.to("admin").emit("newRideDriverApplication", { registerId: driver.registerId, phone, district });
    console.log(`🚗 Tài xế mới: ${driver.registerId} — ${phone}`);
    res.json({ success: true, message: "Đăng ký thành công! Chúng tôi sẽ liên hệ trong 24–48h.", registerId: driver.registerId });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: "SĐT đã tồn tại" });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/food-partners — Danh sách nhà hàng (public, chỉ approved)
app.get("/api/food-partners", async (req, res) => {
  try {
    const { district, category, search, limit = 20, skip = 0 } = req.query;
    const q = { status: "approved" };
    if (district) q.district = district;
    if (category) q.categories = category;
    if (search) q.bizName = { $regex: search, $options: "i" };
    const partners = await FoodPartner.find(q)
      .select("_id registerId bizName address district categories openTime closeTime avatar coverImage rating totalOrders description")
      .sort({ rating: -1, totalOrders: -1 })
      .limit(Number(limit)).skip(Number(skip));
    res.json({ success: true, partners });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/food-partners/:id/products — Menu của một tiệm
app.get("/api/food-partners/:id/products", async (req, res) => {
  try {
    const products = await Product.find({ partnerId: req.params.id, available: true })
      .sort({ sold: -1 });
    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
//  13. API: ANALYTICS
// ==========================================

// GET /api/analytics/overview
app.get("/api/analytics/overview", adminAuth, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const week  = new Date(Date.now() - 7 * 24 * 3600e3);
    const month = new Date(Date.now() - 30 * 24 * 3600e3);

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
      Order.aggregate([{ $match: { status: "delivered" } }, { $group: { _id: null, total: { $sum: "$finalTotal" } } }]),
      Order.aggregate([{ $match: { status: "delivered", deliveredAt: { $gte: today } } }, { $group: { _id: null, total: { $sum: "$finalTotal" } } }]),
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: week } }),
      Shipper.countDocuments(),
      Shipper.countDocuments({ status: "active" }),
      GiatLa.countDocuments(),
      GiupViec.countDocuments(),
      ChinaShop.countDocuments(),
      Shipper.countDocuments({ status: "pending" }) +
        await GiatLa.countDocuments({ status: "pending" }) +
        await GiupViec.countDocuments({ status: "pending" }) +
        await ChinaShop.countDocuments({ status: "pending" }),
    ]);

    res.json({ success: true, data: {
      orders:   { total: totalOrders, today: todayOrders, week: weekOrders },
      revenue:  { total: totalRevenue[0]?.total || 0, today: todayRevenue[0]?.total || 0 },
      users:    { total: totalUsers, newThisWeek: newUsersWeek },
      shippers: { total: shipperCount, active: activeShippers },
      partners: { giatLa: glCount, giupViec: gvCount, chinaShop: csCount },
      pendingReview: pendingAll,
    }});
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/analytics/orders-by-module
app.get("/api/analytics/orders-by-module", adminAuth, async (req, res) => {
  try {
    const result = await Order.aggregate([
      { $group: { _id: "$module", count: { $sum: 1 }, revenue: { $sum: "$finalTotal" } } }
    ]);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
//  14. API: ADMIN
// ==========================================

function adminAuth(req, res, next) {
  // Chấp nhận: x-admin-key header HOẶC session admin đã đăng nhập
  const key = req.headers["x-admin-key"];
  const validKey = process.env.ADMIN_SECRET_KEY || "crabor-admin-secret-2025";
  if (key === validKey) return next();
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ success: false, message: "Unauthorized — Sai ADMIN_SECRET_KEY hoặc chưa đăng nhập" });
}

// GET /api/admin/stats — dashboard stats
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);

    const [
      totalUsers, totalUsersToday, activeUsers,
      totalS, totalGL, totalGV, totalCS, totalFP, totalRX,
      pendingS, pendingGL, pendingGV, pendingCS, pendingFP, pendingRX,
      todayS, todayGL, todayGV, todayCS, todayFP, todayRX,
      earlyBird,
      totalOrders, todayOrders, totalRevenue,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ status: "active" }),
      Shipper.countDocuments(),
      GiatLa.countDocuments(),
      GiupViec.countDocuments(),
      ChinaShop.countDocuments(),
      FoodPartner.countDocuments(),
      RideDriver.countDocuments(),
      Shipper.countDocuments({ status: "pending" }),
      GiatLa.countDocuments({ status: "pending" }),
      GiupViec.countDocuments({ status: "pending" }),
      ChinaShop.countDocuments({ status: "pending" }),
      FoodPartner.countDocuments({ status: "pending" }),
      RideDriver.countDocuments({ status: "pending" }),
      Shipper.countDocuments({ registeredAt: { $gte: today } }),
      GiatLa.countDocuments({ registeredAt: { $gte: today } }),
      GiupViec.countDocuments({ registeredAt: { $gte: today } }),
      ChinaShop.countDocuments({ registeredAt: { $gte: today } }),
      FoodPartner.countDocuments({ createdAt: { $gte: today } }),
      RideDriver.countDocuments({ createdAt: { $gte: today } }),
      Shipper.countDocuments({ plan: "early_bird" }),
      Order.countDocuments(),
      Order.countDocuments({ createdAt: { $gte: today } }),
      Order.aggregate([{ $group: { _id: null, total: { $sum: "$finalTotal" } } }]),
    ]);

    const revenue = totalRevenue[0]?.total || 0;

    res.json({ success: true, data: {
      // Khách hàng
      customers: totalUsers,
      customersToday: totalUsersToday,
      activeCustomers: activeUsers,
      // Đối tác / shipper
      total:   totalS + totalGL + totalGV + totalCS + totalFP + totalRX,
      shippers: totalS,
      partners: { gl: totalGL, gv: totalGV, cs: totalCS, fp: totalFP, rx: totalRX },
      pending: pendingS + pendingGL + pendingGV + pendingCS + pendingFP + pendingRX,
      approved: await Shipper.countDocuments({ status: "approved" }) +
                await GiatLa.countDocuments({ status: "approved" }) +
                await GiupViec.countDocuments({ status: "approved" }) +
                await ChinaShop.countDocuments({ status: "approved" }) +
                await FoodPartner.countDocuments({ status: "approved" }) +
                await RideDriver.countDocuments({ status: "approved" }),
      active: await Shipper.countDocuments({ status: "active" }),
      todayRegistrations: todayS + todayGL + todayGV + todayCS + todayFP + todayRX,
      earlyBirdUsed: earlyBird,
      earlyBirdMax:  await getConfig("earlyBirdMax", 50),
      earlyBirdLeft: Math.max(0, await getConfig("earlyBirdMax", 50) - earlyBird),
      earlyBirdRevenue: earlyBird * 500000,
      // Sales
      salesTotal: await Sales.countDocuments(),
      salesActive: await Sales.countDocuments({ status: "active" }),
      salesRevenue: (await Referral.aggregate([{ $match: { status: "earned" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]))[0]?.total || 0,
      // Đơn hàng
      totalOrders,
      todayOrders,
      revenue,
    }});
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/shippers
app.get("/api/admin/shippers", adminAuth, async (req, res) => {
  try {
    const { status, district, page = 1, limit = 20, q } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (district && district !== "all") filter.district = district;
    if (q) filter.$or = [
      { phone: new RegExp(q,"i") }, { fullName: new RegExp(q,"i") }, { registerId: new RegExp(q,"i") }
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

// GET /api/admin/shippers/:id — Chi tiết 1 shipper
app.get("/api/admin/shippers/:id", adminAuth, async (req, res) => {
  try {
    const doc = await Shipper.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/partners/:module/:id — Chi tiết 1 đối tác
app.get("/api/admin/partners/:module/:id", adminAuth, async (req, res) => {
  try {
    const model = getPartnerModel(req.params.module);
    if (!model) return res.status(400).json({ success: false, message: "Module không hợp lệ" });
    const doc = await model.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/ride-drivers/:id — Chi tiết 1 tài xế
app.get("/api/admin/ride-drivers/:id", adminAuth, async (req, res) => {
  try {
    const doc = await RideDriver.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// GET /api/admin/partners?module=giat_la
app.get("/api/admin/partners", adminAuth, async (req, res) => {
  try {
    const { module: mod, status, district, page = 1, limit = 20, q } = req.query;
    const Model = getPartnerModel(mod);
    if (!Model) return res.status(400).json({ success: false, message: "Module không hợp lệ. Dùng: giat_la | giup_viec | china_shop" });

    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (district && district !== "all") filter.district = district;
    if (q) filter.$or = [
      { phone: new RegExp(q,"i") }, { fullName: new RegExp(q,"i") },
      { registerId: new RegExp(q,"i") }, { bizName: new RegExp(q,"i") }
    ];
    const [data, total] = await Promise.all([
      Model.find(filter).sort({ registeredAt: -1 }).skip((page-1)*limit).limit(Number(limit)),
      Model.countDocuments(filter)
    ]);
    res.json({ success: true, total, page: Number(page), data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// GET /api/admin/ride-drivers
app.get("/api/admin/ride-drivers", adminAuth, async (req, res) => {
  try {
    const { status, district, page = 1, limit = 20, q, vehicleType } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (district && district !== "all") filter.district = district;
    if (vehicleType && vehicleType !== "all") filter.vehicleType = vehicleType;
    if (q) filter.$or = [
      { phone: new RegExp(q,"i") }, { firstName: new RegExp(q,"i") },
      { lastName: new RegExp(q,"i") }, { registerId: new RegExp(q,"i") },
      { vehiclePlate: new RegExp(q,"i") }
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
app.get("/api/admin/registrations/search", adminAuth, async (req, res) => {
  try {
    const { q, type, status, district, page = 1, limit = 20 } = req.query;
    const buildFilter = () => {
      const f = {};
      if (status && status !== "all") f.status = status;
      if (district && district !== "all") f.district = district;
      if (q) f.$or = [
        { phone: new RegExp(q,"i") }, { fullName: new RegExp(q,"i") },
        { registerId: new RegExp(q,"i") }, { bizName: new RegExp(q,"i") }
      ];
      return f;
    };
    const filter = buildFilter();
    const models = type && type !== "all"
      ? (type === "shipper" ? [{ m: Shipper, t: "shipper" }]
        : type === "ride_driver" ? [{ m: RideDriver, t: "ride_driver" }]
        : [{ m: getPartnerModel(type), t: type }])
      : [
          { m: Shipper, t: "shipper" },
          { m: GiatLa, t: "giat_la" },
          { m: GiupViec, t: "giup_viec" },
          { m: ChinaShop, t: "china_shop" },
          { m: FoodPartner, t: "food_partner" },
          { m: RideDriver, t: "ride_driver" },
        ];

    const results = await Promise.all(models.map(({ m, t }) =>
      m.find(filter).sort({ registeredAt: -1 }).limit(Number(limit)).lean().then(rows => rows.map(r => ({ ...r, _type: t })))
    ));
    const flat = results.flat().sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt)).slice(0, Number(limit));
    res.json({ success: true, total: flat.length, data: flat });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/registrations/:type/:id/status
app.patch("/api/admin/registrations/:type/:id/status", adminAuth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const { status, adminNotes } = req.body;

    const Model = type === "shipper" ? Shipper
                : type === "ride_driver" ? RideDriver
                : getPartnerModel(type);
    if (!Model) return res.status(400).json({ success: false, message: "Type không hợp lệ" });

    const valid = ["pending","reviewing","approved","rejected","active","suspended"];
    if (!valid.includes(status)) return res.status(400).json({ success: false, message: "Status không hợp lệ" });

    const update = { status, adminNotes };
    if (status === "approved") update.approvedAt = new Date();

    const record = await Model.findByIdAndUpdate(id, update, { new: true });
    if (!record) return res.status(404).json({ success: false, message: "Không tìm thấy" });

    // SMS thông báo kết quả
    const smsMap = {
      approved: `CRABOR: Ho so ${record.registerId} da duoc DUYET. Chung toi se lien he huong dan buoc tiep theo.`,
      rejected: `CRABOR: Ho so ${record.registerId} chua du dieu kien. Vui long lien he hotline de biet them.`,
      active:   `CRABOR: Tai khoan cua ban da duoc kich hoat. Hay tai app CRABOR va bat dau ngay!`,
    };
    if (smsMap[status]) await sendSms(record.phone,
      smsMap[status]).catch(()=>{});

    req.io.to("admin").emit("registrationStatusUpdated", { id, type, status, registerId: record.registerId });
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
//  15. SETUP DEFAULT ADMIN
// ==========================================
async function setupDefaultAdmin() {
  const count = await Admin.countDocuments().catch(() => 0);
  if (count === 0) {
    const pass = process.env.ADMIN_DEFAULT_PASS || "Crabor@2025";
    await Admin.create({ username: "admin", password: pass, role: "superadmin", name: "CRABOR Admin" }).catch(()=>{});
    console.log(" Admin mặc định: admin / " + pass);
    console.log("   [WARN]  Đổi mật khẩu sau lần đăng nhập đầu!");
  }
}

// ==========================================
//  16. START SERVER
// ==========================================

// ==========================================
//  GLOBAL ERROR HANDLER
// ==========================================
app.use((err, req, res, next) => {
  // Mongoose validation errors
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({ success: false, message: messages.join("; "), errors: messages });
  }
  // Duplicate key (unique constraint)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "phone";
    const fieldNames = { phone: "Số điện thoại", email: "Email", registerId: "Mã đăng ký" };
    const label = fieldNames[field] || field;
    return res.status(409).json({ success: false, message: `${label} đã được đăng ký trước đó` });
  }
  console.error("[ERR]", err.message);
  res.status(500).json({ success: false, message: "Lỗi server nội bộ" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  const env = process.env.NODE_ENV || "development";
  console.log(`
╔════════════════════════════════════════╗
|   🦀  CRABOR Super App — Server       |
╠════════════════════════════════════════╣
|  🚀  Port        : ${PORT}                 |
|  🌍  Environment : ${env.padEnd(12)}      |
|  📦  DB          : crabor (Atlas)      |
╠════════════════════════════════════════╣
|  🏠  Landing     : /                  |
|  👤  Customer    : /customer           |
|    Shipper     : /shipper            |
|    Partner     : /partner            |
|    Admin       : /admin              |
╠════════════════════════════════════════╣
|    Shipper reg : /shipper/register   |
|    Partner reg : /partner/register   |
╠════════════════════════════════════════╣
|  🔑  Admin API   : /api/admin/stats    |
|  📊  Analytics   : /api/analytics/     |
╚════════════════════════════════════════╝`);
  await setupDefaultAdmin();
});

module.exports = { app, server, io };


// GET /api/admin/customers — Danh sách khách hàng
app.get("/api/admin/customers", adminAuth, async (req, res) => {
  try {
    const { q, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (q) filter.$or = [
      { phone: { $regex: q, $options: "i" } },
      { fullName: { $regex: q, $options: "i" } },
      { email: { $regex: q, $options: "i" } },
    ];
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("-__v")
      .sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(Number(limit));
    res.json({ success: true, customers: users, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/customers/:id/status — Khóa/mở khóa tài khoản
app.patch("/api/admin/customers/:id/status", adminAuth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy user" });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
