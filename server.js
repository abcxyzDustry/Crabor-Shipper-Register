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
const nodemailer = require("nodemailer");
const cocoEngine = require("./coco-engine");
const { CocoKnowledge, CocoMemory, CocoLearnLog, CocoTools, cocoRespond, processLearnQueue, seedCocoKnowledge } = cocoEngine;
const cocoOps   = require("./coco-ops");
const cocoBrain = require("./coco-brain");
const { cocoThink, CocoReasoning, checkBrainStatus, printBrainSetupGuide } = cocoBrain;
const novaAgent = require("./nova-agent");
const { SLAMonitor, RevenueIntel, DispatchIntel, InventoryIntel,
        SystemHealth, OnboardingFlow,
        NovaSLA, NovaMetric, NovaDecision,
        NOVA_SYSTEM_PROMPT, startNovaCrons } = novaAgent;
const { DispatchAI, PricingAI, FraudAI, GrowthAI, LearningEngine, AutoApproveAI,
        CocoPattern, CocoDecision, CocoNotif, CocoCampaign,
        dispatchPendingNotifications, startOpsCrons } = cocoOps;

// App & Socket bootstrap ──
const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==========================================
//  1. MONGODB CONNECTION
// ==========================================
let MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("[ERR] Thiếu MONGODB_URI trong .env");
  process.exit(1);
}

// ── Normalize MONGODB_URI (bulletproof version) ──────────────
try {
  let uri = MONGODB_URI;
  // 1. Nếu URI có dạng user@domain:pass@host (username chứa @), encode @ trong user
  const atCount = (uri.match(/@/g) || []).length;
  if (atCount >= 2) {
    const schemeEnd = uri.indexOf('://') + 3;
    const scheme    = uri.substring(0, schemeEnd);
    const rest      = uri.substring(schemeEnd);
    const lastAt    = rest.lastIndexOf('@');
    const creds     = rest.substring(0, lastAt);
    const hostPart  = rest.substring(lastAt + 1);
    const colonIdx  = creds.lastIndexOf(':');
    const rawUser   = creds.substring(0, colonIdx);
    const rawPass   = creds.substring(colonIdx + 1);
    const safeUser  = rawUser.replace(/@/g, '%40');
    const safePass  = encodeURIComponent(decodeURIComponent(rawPass.replace(/%/g,'%25')));
    uri = scheme + safeUser + ':' + rawPass + '@' + hostPart;
  }
  // 2. Tách query string
  const qIdx   = uri.indexOf('?');
  const uriNoQ = qIdx >= 0 ? uri.substring(0, qIdx) : uri;
  const uriQ   = qIdx >= 0 ? uri.substring(qIdx + 1) : '';
  // 3. Strip trailing slash(es) từ path
  const uriClean = uriNoQ.replace(/\/+$/, '');
  // 4. Đảm bảo có /crabor database name
  const pathPart = uriClean.replace(/^mongodb(?:\+srv)?:\/\/[^/]+/, '');
  const hasDb    = pathPart.length > 1 && !pathPart.startsWith('/?');
  const uriFinal = (hasDb ? uriClean : uriClean + '/crabor')
    + '?' + (uriQ || 'retryWrites=true&w=majority&appName=Cluster0');
  MONGODB_URI = uriFinal;
  console.log('[DB] URI db:', MONGODB_URI.match(/\/([^/?]+)\?/)?.[1] || 'crabor');
} catch(e) {
  console.log('[DB] URI parse skipped:', e.message);
}

console.log("[DB] Connecting to MongoDB...");

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log("[OK] MongoDB Atlas connected — DB: crabor");
    // Coco AI: seed knowledge + start ops crons
    seedCocoKnowledge().catch(e => console.log("[Coco] Seed:", e.message));
    setTimeout(() => startOpsCrons(io), 3000); // delay 3s để DB ổn định
    // Auto-seed admin nếu chưa có
    try {
      const existingAdmin = await Admin.findOne({ username: "admin" });
      if (!existingAdmin) {
        const bcrypt = require("bcryptjs");
        const defaultPass = process.env.ADMIN_DEFAULT_PASS || "admin123";
        const hash = await bcrypt.hash(defaultPass, 10);
        await Admin.create({ username: "admin", password: hash, role: "admin", name: "CRABOR Admin" });
        console.log("[OK] Admin mặc định đã được tạo: admin / " + defaultPass);
      }
    } catch(e) { console.error("[WARN] Không thể tạo admin seed:", e.message); }
  })
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
  store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'crabor', collectionName: 'sessions', ttl: 24 * 60 * 60 }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Track requests for Nova SystemHealth
app.use((req,res,next)=>{ res.on("finish",()=>SystemHealth.recordRequest(res.statusCode>=500)); next(); });

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
  // Customer joins broadcast room for realtime banner updates
  socket.on("join_customer_broadcast", () => {
    socket.join("customer_broadcast");
  });

  socket.on("joinRoom", (room) => {
    socket.join(room);
    console.log(`   ↳ ${socket.id} joined [${room}]`);
  });

  // Customer join order room để nhận tracking
  socket.on("join_order", (orderId) => {
    socket.join(`order_${orderId}`);
    console.log(`   ↳ ${socket.id} tracking order [${orderId}]`);
  });

  // Customer / shipper cập nhật trạng thái đơn
  socket.on("orderUpdate", (data) => {
    io.to(`order_${data.orderId}`).emit("orderStatusChanged", data);
    io.to("admin").emit("newOrderNotification", data);
    io.to(`customer_${data.customerId}`).emit("orderStatusChanged", data);
  });

  // Shipper gửi vị trí GPS — relay đến order room cho customer
  socket.on("shipperLocation", (data) => {
    // Relay tới customer đang theo dõi đơn này
    io.to(`order_${data.orderId}`).emit("shipperLocation", {
      orderId: data.orderId,
      lng:     data.lng,
      lat:     data.lat,
      heading: data.heading || 0,
    });
    io.to("admin").emit("shipperLocationUpdate", data);
  });

  // Đối tác giặt là / giúp việc cập nhật trạng thái
  socket.on("partnerUpdate", (data) => {
    io.to(`order_${data.orderId}`).emit("partnerStatusChanged", data);
    io.to("admin").emit("partnerNotification", data);
  });

  // Chat relay: customer ↔ shipper
  socket.on("sendChatMessage", async (data) => {
    const { orderId, from, text } = data;
    if (!orderId || !from || !text) return;
    const msg = { from, text, time: new Date(), type: "text" };
    await Order.findOneAndUpdate({ orderId }, { $push: { chatMessages: msg } }).catch(()=>{});
    io.to(`order_${orderId}`).emit("chatMessage", { orderId, ...msg });
  });

  socket.on("disconnect", () => {
    console.log("🔌 Client disconnected:", socket.id);
  });
});

// ==========================================
//  4. SCHEMAS & MODELS
// ==========================================

// OTP — SpeedSMS (tự quản lý OTP store in-memory) ──────

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
  walletBalance:   { type: Number, default: 0, min: 0 },
  walletEarned:    { type: Number, default: 0, min: 0 },   // tổng tiền đã nhận vào ví
  fcmToken:        String,
  profileComplete: { type: Boolean, default: false },
  dob:             { type: String, trim: true },
  gender:          { type: String, enum: ["male","female","other"] },
  savedAddresses:  [{
    label:   { type: String, trim: true, maxlength: 30 }, // "Nhà", "Cơ quan"
    address: { type: String, trim: true, maxlength: 300 },
    icon:    { type: String, default: "📍" },
  }],
  searchHistory:   [{ type: String, trim: true }], // last 10 searches
  bankAccount:     { bankName: String, accountNo: String, accountName: String },
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
  prepTime:     { type: Number, default: 15 }, // minutos de preparación estimado
  cancelReason: { type: String, trim: true },
  statusHistory:[ { status: String, time: { type: Date, default: Date.now }, by: String } ],
  confirmedAt:  Date,
  deliveredAt:  Date,
  // Rating
  ratingShipper:  { type: Number, min: 1, max: 5 },
  ratingPartner:  { type: Number, min: 1, max: 5 },
  ratingComment:  { type: String, trim: true, maxlength: 300 },
  ratedAt:        Date,
  scheduledAt:    Date,         // đặt trước theo giờ
  zone:           { type: String, trim: true }, // khu vực giao hàng
  isScheduled:    { type: Boolean, default: false },
  // Delivery photo (shipper chụp khi giao)
  deliveryPhoto:  { type: String },   // base64 hoặc URL
  // Voucher
  voucherCode:    { type: String, trim: true, uppercase: true },
  voucherDiscount:{ type: Number, default: 0, min: 0 },
  // Chat messages (inline, không cần collection riêng)
  chatMessages: [{
    from:    { type: String, enum: ['customer','shipper'], required: true },
    text:    { type: String, trim: true, maxlength: 500 },
    time:    { type: Date, default: Date.now },
    type:    { type: String, enum: ['text','image'], default: 'text' },
  }],
  // Reorder
  reorderFrom: { type: String },   // orderId của đơn gốc
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
  refCode:      { type: String, trim: true, uppercase: true },
  isAccepting:  { type: Boolean, default: true },
  walletBalance: { type: Number, default: 0, min: 0 },
  walletEarned:  { type: Number, default: 0, min: 0 },
  featured:     { type: Boolean, default: false }, // spotlight trên app
  featuredUntil:{ type: Date }, // pause/resume orders
  totalSales:   { type: Number, default: 0, min: 0 },
  rating:       { type: Number, default: 0, min: 0, max: 5 },
  ratingCount:  { type: Number, default: 0, min: 0 },
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
  walletBalance: { type: Number, default: 0, min: 0 },
  walletEarned:  { type: Number, default: 0, min: 0 },
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
  refCode:      { type: String, trim: true, uppercase: true },
  isAccepting:  { type: Boolean, default: true },
  walletBalance: { type: Number, default: 0, min: 0 },
  walletEarned:  { type: Number, default: 0, min: 0 },
  featured:     { type: Boolean, default: false }, // spotlight trên app
  featuredUntil:{ type: Date }, // pause/resume orders
  totalSales:   { type: Number, default: 0, min: 0 },
  rating:       { type: Number, default: 0, min: 0, max: 5 },
  ratingCount:  { type: Number, default: 0, min: 0 },
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
  walletBalance: { type: Number, default: 0, min: 0 },
  walletEarned:  { type: Number, default: 0, min: 0 },
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
  fee:          { type: Number, default: 700000, min: 0 },
  feeStatus:    { type: String, enum: ["unpaid","paid"], default: "unpaid" },
  plan:         { type: String, enum: ["standard","early_bird"], default: "standard" },
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
// ── VOUCHER ──────────────────────────────────
const voucherSchema = new mongoose.Schema({
  code:        { type: String, required: true, unique: true, trim: true, uppercase: true },
  type:        { type: String, enum: ['percent','fixed'], default: 'percent' },
  value:       { type: Number, required: true, min: 0 },  // % hoặc VNĐ
  minOrder:    { type: Number, default: 0 },               // đơn tối thiểu
  maxDiscount: { type: Number, default: 0 },               // giảm tối đa (cho percent)
  usageLimit:  { type: Number, default: 100 },             // tổng số lượt dùng
  usedCount:   { type: Number, default: 0 },
  usedBy:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  module:      { type: String, default: 'all' },           // 'all','food','laundry'...
  active:      { type: Boolean, default: true },
  expiresAt:   { type: Date, required: true },
  description: { type: String, trim: true },
  createdBy:   { type: String, default: 'admin' },
}, { timestamps: true });
const Voucher = mongoose.model('Voucher', voucherSchema);


// ── AI BANNER ─────────────────────────────────
const aiBannerSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  subtitle:    { type: String, trim: true },
  badge:       { type: String, trim: true },
  gradient:    { type: String, default: "linear-gradient(135deg,#E8504A,#c93d37)" },
  emoji:       { type: String, default: "🦀" },
  ctaText:     { type: String, default: "Đặt ngay" },
  ctaLink:     { type: String, default: "/customer" },
  htmlContent: { type: String },       // full custom HTML nếu muốn
  prompt:      { type: String },       // prompt admin đã dùng
  active:      { type: Boolean, default: true },
  order:       { type: Number, default: 0 },
  clicks:      { type: Number, default: 0 },
  impressions: { type: Number, default: 0 },
  expiresAt:   Date,
}, { timestamps: true });
const AIBanner = mongoose.model("AIBanner", aiBannerSchema);


// ── SUPPORT TICKET ────────────────────────────
const supportTicketSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone:      { type: String, trim: true },
  role:       { type: String, enum: ['customer','shipper','partner'], default: 'customer' },
  orderId:    { type: String, trim: true },
  type:       { type: String, enum: ['order_issue','payment','complaint','sos','other'], default: 'other' },
  message:    { type: String, required: true, trim: true, maxlength: 1000 },
  status:     { type: String, enum: ['open','in_progress','resolved'], default: 'open' },
  priority:   { type: String, enum: ['low','medium','high','urgent'], default: 'medium' },
  adminNote:  { type: String, trim: true },
  resolvedAt: Date,
}, { timestamps: true });
const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);


// ── WALLET TRANSACTION ────────────────────────────────────
const walletTxSchema = new mongoose.Schema({
  ownerId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  ownerType: { type: String, enum: ['user','shipper','partner','sales'], required: true },
  type:      { type: String, enum: ['credit','debit','refund','withdraw','loan_receive','loan_repay','bnpl_pay'], required: true },
  amount:    { type: Number, required: true, min: 0 },
  balance:   { type: Number, required: true },        // số dư sau giao dịch
  ref:       { type: String, trim: true },             // orderId, loanId...
  note:      { type: String, trim: true, maxlength: 200 },
  status:    { type: String, enum: ['completed','pending','failed'], default: 'completed' },
}, { timestamps: true });
walletTxSchema.index({ ownerId: 1, createdAt: -1 });
const WalletTx = mongoose.model('WalletTx', walletTxSchema);

// ── LOAN (Vay nhanh) ──────────────────────────────────────
const loanSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount:       { type: Number, required: true, min: 1000000, max: 50000000 },
  interestRate: { type: Number, default: 1.5 },         // % / tháng
  termMonths:   { type: Number, default: 3, min: 1, max: 12 },
  totalRepay:   { type: Number },
  paidAmount:   { type: Number, default: 0 },
  status:       { type: String, enum: ['pending','approved','active','repaid','rejected','overdue'], default: 'pending' },
  disbursedAt:  Date,
  dueAt:        Date,
  note:         { type: String, trim: true },
}, { timestamps: true });
const Loan = mongoose.model('Loan', loanSchema);

// ── BNPL TRANSACTION (từng giao dịch mua trả sau) ───────────
const bnplTxSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId:      { type: String, trim: true },
  serviceType:  { type: String, default: 'food' },  // food, laundry, cleaning...
  amount:       { type: Number, required: true },
  billingMonth: { type: String, required: true },   // "2026-07" — tháng tính vào hóa đơn
  status:       { type: String, enum: ['pending_bill','billed','paid'], default: 'pending_bill' },
  invoiceId:    { type: mongoose.Schema.Types.ObjectId }, // thuộc hóa đơn nào
}, { timestamps: true });
const BNPLTx = mongoose.model('BNPLTx', bnplTxSchema);

// ── BNPL INVOICE (hóa đơn hàng tháng) ────────────────────
const bnplInvoiceSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  billingMonth:   { type: String, required: true },  // "2026-07"
  totalAmount:    { type: Number, required: true },   // tổng tiền gốc tháng đó
  lateFee:        { type: Number, default: 0 },       // phí 30k nếu trễ
  installFee:     { type: Number, default: 0 },       // phí 10% nếu trả góp
  finalAmount:    { type: Number, required: true },   // totalAmount + fees
  isInstallment:  { type: Boolean, default: false },
  installTerms:   { type: Number, default: 1 },       // số kỳ
  installPaid:    { type: Number, default: 0 },       // số kỳ đã trả
  issuedAt:       { type: Date, required: true },     // ngày 1 tháng tiếp
  dueDate:        { type: Date, required: true },     // ngày 15 tháng tiếp
  paidAt:         Date,
  status:         { type: String, enum: ['draft','issued','paid','overdue','installment'], default: 'draft' },
  sePayRef:       { type: String },   // mã chuyển khoản SePay
}, { timestamps: true });
bnplInvoiceSchema.index({ userId: 1, billingMonth: 1 }, { unique: true });
const BNPLInvoice = mongoose.model('BNPLInvoice', bnplInvoiceSchema);

// ── BNPL CREDIT LIMIT ─────────────────────────────────────
// (calculated dynamically from totalSpent, no separate schema needed)
function getBnplLimit(totalSpent) {
  if (totalSpent <  2000000)  return 0;
  if (totalSpent <  5000000)  return 2000000;
  if (totalSpent < 10000000)  return 5000000;
  if (totalSpent < 20000000)  return 10000000;
  return 20000000;
}
function getCurrentBillingMonth() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
}
function getNextBillingDates() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth()+1, 1);
  const due  = new Date(now.getFullYear(), now.getMonth()+1, 15, 15, 0, 0);
  return { issuedAt: next, dueDate: due };
}


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
//  SPEEDSMS HELPERS (thay Twilio)
// ==========================================

const SPEEDSMS_TOKEN = process.env.SPEEDSMS_ACCESS_TOKEN;

// Chuyển SĐT VN: 0912345678 → 84912345678 (SpeedSMS format, không có dấu +)
function toSpeedPhone(phone) {
  const p = phone.toString().trim().replace(/\s/g, "");
  if (p.startsWith("84")) return p;
  if (p.startsWith("0"))  return "84" + p.slice(1);
  if (p.startsWith("+84")) return p.slice(1);
  return "84" + p;
}

// OTP store in-memory: phone → { code, expiry }
const otpStore      = new Map();
const emailOtpStore = new Map(); // { email → { code, expiry } }

// Dọn expired OTPs mỗi 10 phút
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore) { if (v.expiry < now) otpStore.delete(k); }
}, 10 * 60 * 1000);

// Gửi OTP qua SpeedSMS

// ══════════════════════════════════════════════════════════════
//  EMAIL OTP — Phương án 2 (fallback khi SMS chưa dùng được)
// ══════════════════════════════════════════════════════════════
function createEmailTransporter() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

async function sendEmailOtp(email) {
  const code   = String(Math.floor(100000 + Math.random() * 900000));
  const expiry = Date.now() + 5 * 60 * 1000;
  emailOtpStore.set(email.toLowerCase(), { code, expiry });

  const transporter = createEmailTransporter();
  if (!transporter) {
    throw new Error("Email chưa được cấu hình. Vui lòng liên hệ admin.");
  }
  const html = '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">'
    + '<div style="background:linear-gradient(135deg,#E8504A,#c93d37);border-radius:16px;padding:24px;text-align:center;margin-bottom:20px">'
    + '<div style="font-size:2.5rem">🦀</div>'
    + '<div style="color:#fff;font-size:1.4rem;font-weight:900;margin-top:8px">CRABOR</div>'
    + '<div style="color:rgba(255,255,255,.8);font-size:.85rem">Mã xác thực OTP</div></div>'
    + '<div style="background:#f8f8f8;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">'
    + '<div style="color:#666;font-size:.85rem;margin-bottom:10px">Mã OTP của bạn là:</div>'
    + '<div style="font-size:2.5rem;font-weight:900;letter-spacing:12px;color:#E8504A;font-family:monospace">' + code + '</div>'
    + '<div style="color:#999;font-size:.75rem;margin-top:10px">Hết hạn sau 5 phút</div></div>'
    + '<div style="color:#aaa;font-size:.75rem;text-align:center">Không chia sẻ mã này với bất kỳ ai.</div></div>';

  await transporter.sendMail({
    from: '"CRABOR 🦀" <' + process.env.EMAIL_USER + '>',
    to: email,
    subject: "[CRABOR] Mã OTP: " + code,
    html,
    text: "Ma OTP CRABOR: " + code + ". Het han sau 5 phut.",
  });
  console.log(" [EMAIL-OTP] Sent to " + email);
  return { success: true };
}

function verifyEmailOtp(email, code) {
  const key   = email.toLowerCase();
  const entry = emailOtpStore.get(key);
  if (!entry)                    return { ok: false, reason: "Chưa gửi OTP cho email này" };
  if (Date.now() > entry.expiry) { emailOtpStore.delete(key); return { ok: false, reason: "OTP đã hết hạn" }; }
  if (entry.code !== String(code)) return { ok: false, reason: "Mã OTP không đúng" };
  emailOtpStore.delete(key);
  return { ok: true };
}

// Dọn email OTPs hết hạn
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of emailOtpStore) { if (v.expiry < now) emailOtpStore.delete(k); }
}, 10 * 60 * 1000);

async function speedSmsSendOtp(phone) {
  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const expiry = Date.now() + 5 * 60 * 1000; // 5 phút
  otpStore.set(phone, { code, expiry });

  const to = toSpeedPhone(phone);

  if (!SPEEDSMS_TOKEN) {
    console.log(` [DEV-OTP] ${phone}: ${code}`);
    return { success: true, dev: true };
  }

  const body = JSON.stringify({
    to: [to],
    content: `Ma OTP CRABOR: ${code}. Het han sau 5 phut. Khong chia se ma nay cho bat ky ai.`,
    sms_type: 2,  // đầu số ngẫu nhiên — không cần đăng ký brandname
  });

  const auth = Buffer.from(`${SPEEDSMS_TOKEN}:x`).toString("base64");
  const r = await axios.post("https://api.speedsms.vn/index.php/sms/send", body, {
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  if (r.data.status !== "success") {
    throw new Error("SpeedSMS error: " + (r.data.message || JSON.stringify(r.data)));
  }
  console.log(` [OTP] Gửi tới ${phone} — tranId: ${r.data.data?.tranId}`);
  return { success: true };
}

// Kiểm tra OTP
function speedSmsCheckOtp(phone, code) {
  const entry = otpStore.get(phone);
  if (!entry) return false;
  if (Date.now() > entry.expiry) { otpStore.delete(phone); return false; }
  if (entry.code !== String(code).trim()) return false;
  otpStore.delete(phone); // xóa sau khi dùng
  return true;
}

// Gửi SMS thông báo (không phải OTP) qua SpeedSMS
async function sendSms(phone, message) {
  const to = toSpeedPhone(phone);
  if (!SPEEDSMS_TOKEN) {
    console.log(` [DEV-SMS] ${phone}: ${message}`);
    return true;
  }
  try {
    const auth = Buffer.from(`${SPEEDSMS_TOKEN}:x`).toString("base64");
    await axios.post("https://api.speedsms.vn/index.php/sms/send", JSON.stringify({
      to: [to],
      content: message,
      sms_type: 2,
    }), {
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
      timeout: 12000,
    });
  } catch(e) {
    console.error(" [SMS] Lỗi gửi SMS:", e.message);
  }
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
    const verified = speedSmsCheckOtp(norm, otp);
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
    const verified = speedSmsCheckOtp(norm, otp);
    if (!verified) return res.status(400).json({ success: false, message: "OTP không đúng hoặc đã hết hạn" });
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
      const doc = await model.findOne(filter).select("registerId phone fullName status feeStatus fee plan registeredAt createdAt");
      if (doc) {
        return res.json({
          success: true,
          data: {
            registerId: doc.registerId,
            phone: doc.phone,
            fullName: doc.fullName,
            status: doc.status,
            feeStatus: doc.feeStatus || null,
            fee: doc.fee || null,
            plan: doc.plan || null,
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

// ══════════════════════════════════════════════════════
//  AUTO-APPROVE BOT
//  - Partner (giat_la, giup_viec, china_shop, food_partner):
//    tự động duyệt sau 1 giờ kể từ khi tạo hồ sơ
//  - Shipper + RideDriver:
//    tự động duyệt nếu đã thanh toán phí (feeStatus="paid")
//    giữ nguyên pending nếu chưa thanh toán
// ══════════════════════════════════════════════════════
async function runAutoApproveBot() {
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  let approved = 0;

  try {
    // ── 1. PARTNER: auto-approve sau 1 giờ ──
    const partnerModels = [
      { model: GiatLa,      name: "GiatLa"      },
      { model: GiupViec,    name: "GiupViec"    },
      { model: ChinaShop,   name: "ChinaShop"   },
      { model: FoodPartner, name: "FoodPartner" },
    ];

    for (const { model, name } of partnerModels) {
      const docs = await model.find({
        status: "pending",
        createdAt: { $lte: oneHourAgo },
      });
      for (const doc of docs) {
        await model.findByIdAndUpdate(doc._id, {
          status: "approved",
          $push: { statusHistory: { status: "approved", time: now, by: "auto-bot" } }
        });
        // Gửi SMS thông báo
        await sendSms(doc.phone,
          `CRABOR: Ho so doi tac ${doc.registerId} da duoc DUYET tu dong. Chao mung ban gia nhap CRABOR!`
        ).catch(() => {});
        // Emit realtime cho admin
        io.to("admin").emit("recordStatusChanged", {
          type: "partner", id: doc._id, status: "approved", by: "auto-bot"
        });
        approved++;
        console.log(` [Bot] Auto-approved partner: ${doc.registerId} (${name})`);
      }
    }

    // ── 2. SHIPPER: auto-approve nếu đã trả phí ──
    const paidShippers = await Shipper.find({
      status: "pending",
      feeStatus: "paid",
    });
    for (const doc of paidShippers) {
      await Shipper.findByIdAndUpdate(doc._id, {
        status: "approved",
        $push: { statusHistory: { status: "approved", time: now, by: "auto-bot" } }
      });
      await sendSms(doc.phone,
        `CRABOR: Ho so Shipper ${doc.registerId} da duoc DUYET! Ban co the bat dau nhan don ngay. Chao mung!`
      ).catch(() => {});
      io.to("admin").emit("recordStatusChanged", {
        type: "shipper", id: doc._id, status: "approved", by: "auto-bot"
      });
      approved++;
      console.log(` [Bot] Auto-approved shipper: ${doc.registerId}`);
    }

    // ── 3. RIDE DRIVER: auto-approve nếu đã trả phí ──
    const paidDrivers = await RideDriver.find({
      status: "pending",
      feeStatus: "paid",
    });
    for (const doc of paidDrivers) {
      await RideDriver.findByIdAndUpdate(doc._id, {
        status: "approved",
        $push: { statusHistory: { status: "approved", time: now, by: "auto-bot" } }
      });
      await sendSms(doc.phone,
        `CRABOR: Ho so Tai xe CN ${doc.registerId} da duoc DUYET! Chao mung ban gia nhap doi ngu tai xe CRABOR!`
      ).catch(() => {});
      io.to("admin").emit("recordStatusChanged", {
        type: "ride_driver", id: doc._id, status: "approved", by: "auto-bot"
      });
      approved++;
      console.log(` [Bot] Auto-approved ride driver: ${doc.registerId}`);
    }

    if (approved > 0) {
      console.log(` [Bot] Auto-approve cycle: ${approved} hồ sơ được duyệt`);
    }
  } catch(err) {
    console.error(" [Bot] Auto-approve error:", err.message);
  }
}

// Chạy bot mỗi 5 phút
setInterval(runAutoApproveBot, 5 * 60 * 1000);
// Chạy lần đầu sau 30 giây khi server khởi động
setTimeout(runAutoApproveBot, 30 * 1000);
console.log(" [Bot] Auto-approve bot scheduled (partners: 1h, shipper/driver: on payment)");


// ── WALLET HELPER ─────────────────────────────────────────
async function walletCredit(ownerId, ownerType, amount, ref, note) {
  const Model = ownerType==='user' ? User : ownerType==='shipper' ? Shipper : ownerType==='sales' ? Sales : FoodPartner;
  const doc = await Model.findByIdAndUpdate(ownerId, { $inc: { walletBalance: amount, walletEarned: amount } }, { new: true });
  await WalletTx.create({ ownerId, ownerType, type:'credit', amount, balance: doc.walletBalance, ref, note });
  return doc.walletBalance;
}
async function walletDebit(ownerId, ownerType, amount, type='debit', ref, note) {
  const Model = ownerType==='user' ? User : ownerType==='shipper' ? Shipper : ownerType==='sales' ? Sales : FoodPartner;
  const doc = await Model.findById(ownerId);
  if (!doc || (doc.walletBalance||0) < amount) throw new Error('Số dư không đủ');
  const updated = await Model.findByIdAndUpdate(ownerId, { $inc: { walletBalance: -amount } }, { new: true });
  await WalletTx.create({ ownerId, ownerType, type, amount, balance: updated.walletBalance, ref, note });
  return updated.walletBalance;
}


// ══════════════════════════════════════════════════════════════
//  TIER 1 FEATURES: Rating · Chat · Voucher · Delivery Photo
// ══════════════════════════════════════════════════════════════

// POST /api/orders/:id/rate — Khách đánh giá shipper + partner
app.post("/api/orders/:id/rate", async (req, res) => {
  try {
    const { ratingShipper, ratingPartner, ratingComment, userId } = req.body;
    const order = await Order.findOne({ orderId: req.params.id });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });
    if (order.ratedAt) return res.status(400).json({ success: false, message: "Đơn này đã được đánh giá" });
    if (order.status !== "delivered") return res.status(400).json({ success: false, message: "Chỉ đánh giá đơn đã giao" });

    await Order.findByIdAndUpdate(order._id, {
      ratingShipper: ratingShipper || null,
      ratingPartner: ratingPartner || null,
      ratingComment: ratingComment || "",
      ratedAt: new Date(),
    });

    // Update shipper avg rating
    if (ratingShipper && order.shipperId) {
      const shipper = await Shipper.findById(order.shipperId);
      if (shipper) {
        const newCount = (shipper.ratingCount || 0) + 1;
        const newRating = (((shipper.rating || 0) * (shipper.ratingCount || 0)) + ratingShipper) / newCount;
        await Shipper.findByIdAndUpdate(order.shipperId, {
          rating: Math.round(newRating * 10) / 10,
          ratingCount: newCount,
        });
      }
    }

    // Update partner avg rating
    if (ratingPartner && order.partnerId) {
      for (const M of [GiatLa, GiupViec, ChinaShop, FoodPartner]) {
        const p = await M.findById(order.partnerId);
        if (p) {
          const nc = (p.ratingCount || 0) + 1;
          const nr = (((p.rating || 0) * (p.ratingCount || 0)) + ratingPartner) / nc;
          await M.findByIdAndUpdate(order.partnerId, {
            rating: Math.round(nr * 10) / 10,
            ratingCount: nc,
          });
          break;
        }
      }
    }

    res.json({ success: true, message: "Cảm ơn bạn đã đánh giá! 🙏" });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/orders/:id/chat — Lấy lịch sử chat
app.get("/api/orders/:id/chat", async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id }).select("chatMessages");
    if (!order) return res.status(404).json({ success: false });
    res.json({ success: true, messages: order.chatMessages || [] });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/orders/:id/chat — Gửi tin nhắn
app.post("/api/orders/:id/chat", async (req, res) => {
  try {
    const { from, text, type = "text" } = req.body;
    if (!from || !text) return res.status(400).json({ success: false });
    const msg = { from, text, type, time: new Date() };
    const order = await Order.findOneAndUpdate(
      { orderId: req.params.id },
      { $push: { chatMessages: msg } },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false });
    // Broadcast via socket
    req.io.to(`order_${req.params.id}`).emit("chatMessage", { orderId: req.params.id, ...msg });
    res.json({ success: true, message: msg });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/orders/:id/delivery-photo — Shipper upload ảnh xác nhận
app.post("/api/orders/:id/delivery-photo", async (req, res) => {
  try {
    const { photo } = req.body; // base64
    if (!photo) return res.status(400).json({ success: false, message: "Thiếu ảnh" });
    const order = await Order.findOneAndUpdate(
      { orderId: req.params.id },
      { deliveryPhoto: photo, status: "delivered", deliveredAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false });
    // Broadcast
    req.io.to(`order_${order.orderId}`).emit("orderStatusChanged", { orderId: order.orderId, status: "delivered", photo });
    req.io.to(`customer_${order.customerId}`).emit("orderStatusChanged", { orderId: order.orderId, status: "delivered", photo });
    req.io.to("admin").emit("orderUpdated", { orderId: order.orderId, status: "delivered" });
    // processReferralReward
    if (order.customerId) await processReferralReward(order.customerId, "user", req.io).catch(()=>{});
    res.json({ success: true, message: "Đã xác nhận giao thành công!" });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/vouchers/validate — Validate mã voucher
app.get("/api/vouchers/validate", async (req, res) => {
  try {
    const { code, total, userId, module: mod } = req.query;
    if (!code) return res.status(400).json({ success: false });
    const v = await Voucher.findOne({ code: code.toUpperCase().trim(), active: true });
    if (!v) return res.status(404).json({ success: false, message: "Mã không tồn tại hoặc đã hết hạn" });
    if (new Date() > v.expiresAt) return res.status(400).json({ success: false, message: "Mã đã hết hạn" });
    if (v.usedCount >= v.usageLimit) return res.status(400).json({ success: false, message: "Mã đã dùng hết lượt" });
    if (userId && v.usedBy.map(String).includes(String(userId))) return res.status(400).json({ success: false, message: "Bạn đã dùng mã này rồi" });
    if (Number(total) < v.minOrder) return res.status(400).json({ success: false, message: `Đơn tối thiểu ${v.minOrder.toLocaleString()}đ` });
    if (v.module !== "all" && v.module !== mod) return res.status(400).json({ success: false, message: "Mã không áp dụng cho đơn này" });
    const discount = v.type === "percent"
      ? Math.min(Math.round(Number(total) * v.value / 100), v.maxDiscount || Infinity)
      : v.value;
    res.json({ success: true, discount, description: v.description || `Giảm ${v.type==='percent'?v.value+'%':v.value.toLocaleString()+'đ'}` });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/vouchers — Admin tạo voucher mới
app.post("/api/vouchers", adminAuth, async (req, res) => {
  try {
    const v = await Voucher.create({ ...req.body, code: (req.body.code||"").toUpperCase() });
    res.json({ success: true, data: v });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/vouchers — Admin list vouchers
app.get("/api/vouchers", adminAuth, async (req, res) => {
  try {
    const vs = await Voucher.find().sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, data: vs });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/orders/:id/reorder — Đặt lại đơn cũ
app.post("/api/orders/:id/reorder", async (req, res) => {
  try {
    const orig = await Order.findOne({ orderId: req.params.id });
    if (!orig) return res.status(404).json({ success: false });
    const newOrder = await Order.create({
      module: orig.module,
      customerId: orig.customerId,
      partnerId: orig.partnerId,
      items: orig.items,
      address: orig.address,
      district: orig.district,
      total: orig.total,
      shipFee: orig.shipFee,
      serviceFee: orig.serviceFee,
      paymentMethod: orig.paymentMethod,
      note: orig.note,
      reorderFrom: orig.orderId,
      status: "pending",
    });
    req.io.to("admin").emit("newOrder", { orderId: newOrder.orderId, module: newOrder.module });
    res.json({ success: true, data: { orderId: newOrder.orderId } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/shipper/missions — Nhiệm vụ ngày của shipper
app.get("/api/shipper/missions", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const user = await User.findById(req.session.userId).select("phone");
    if (!user) return res.status(404).json({ success: false });
    const shipper = await Shipper.findOne({ phone: user.phone });
    if (!shipper) return res.status(404).json({ success: false });

    const today = new Date(); today.setHours(0,0,0,0);
    const todayOrders = await Order.countDocuments({
      shipperId: shipper._id, status: "delivered",
      deliveredAt: { $gte: today }
    });

    const missions = [
      { id:'m1', title:'Giao 3 đơn hôm nay', target:3, current: Math.min(todayOrders,3), reward:5000, icon:'🛵' },
      { id:'m2', title:'Giao 8 đơn hôm nay', target:8, current: Math.min(todayOrders,8), reward:15000, icon:'⚡' },
      { id:'m3', title:'Duy trì 4.8⭐ trong ngày', target:1, current: shipper.rating>=4.8?1:0, reward:10000, icon:'⭐' },
      { id:'m4', title:'Online 4 tiếng liên tục', target:4, current: 0, reward:8000, icon:'🕐' },
    ];
    res.json({ success: true, missions, todayOrders, rating: shipper.rating || 0 });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/shipper/tier — Hạng tài xế
app.get("/api/shipper/tier", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const user = await User.findById(req.session.userId).select("phone");
    const shipper = await Shipper.findOne({ phone: user?.phone });
    if (!shipper) return res.status(404).json({ success: false });
    const orders = shipper.ordersCompleted || 0;
    const rating = shipper.rating || 5;
    const tiers = [
      { name:'Đồng', icon:'🥉', minOrders:0,   minRating:0,   color:'#cd7f32', perks:['Nhận đơn cơ bản'] },
      { name:'Bạc',  icon:'🥈', minOrders:50,  minRating:4.5, color:'#aaa',    perks:['Ưu tiên đơn cao','Hỗ trợ 24/7'] },
      { name:'Vàng', icon:'🥇', minOrders:200, minRating:4.7, color:'#FFD700', perks:['Phí thấp hơn 5%','Badge đặc biệt','Đơn ưu tiên'] },
      { name:'Kim Cương', icon:'💎', minOrders:500, minRating:4.9, color:'#b9f2ff', perks:['0% phí dịch vụ','Hỗ trợ VIP','Bonus x1.5'] },
    ];
    let currentTier = tiers[0], nextTier = tiers[1];
    for (let i = tiers.length-1; i >= 0; i--) {
      if (orders >= tiers[i].minOrders && rating >= tiers[i].minRating) {
        currentTier = tiers[i];
        nextTier = tiers[i+1] || null;
        break;
      }
    }
    res.json({ success: true, currentTier, nextTier, orders, rating, tiers });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/partner/revenue-chart — Biểu đồ doanh thu 7 ngày
app.get("/api/partner/revenue-chart", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false });
    const days = [];
    const labels = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate()-i); d.setHours(0,0,0,0);
      const end = new Date(d); end.setHours(23,59,59,999);
      const agg = await Order.aggregate([
        { $match: { partnerId: req.session.partnerId, status:"delivered", deliveredAt:{$gte:d,$lte:end} }},
        { $group: { _id:null, total:{$sum:"$finalTotal"}, count:{$sum:1} }}
      ]);
      days.push({ revenue: agg[0]?.total||0, orders: agg[0]?.count||0 });
      labels.push(d.toLocaleDateString('vi-VN',{weekday:'short'}));
    }
    res.json({ success:true, labels, days });
  } catch(err) {
    res.status(500).json({ success:false, message:err.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  TIER 2 FEATURES: Addresses · Search · Flash deals · Bank
// ══════════════════════════════════════════════════════════════

// GET /api/users/addresses — Lấy địa chỉ đã lưu
app.get("/api/users/addresses", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const user = await User.findById(req.session.userId).select("savedAddresses");
    res.json({ success: true, addresses: user?.savedAddresses || [] });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/users/addresses — Thêm/cập nhật địa chỉ
app.post("/api/users/addresses", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const { label, address, icon } = req.body;
    if (!label || !address) return res.status(400).json({ success: false, message: "Thiếu thông tin" });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ success: false });
    // Replace if same label exists, else push (max 5 addresses)
    const existing = user.savedAddresses.findIndex(a => a.label === label);
    if (existing >= 0) user.savedAddresses[existing] = { label, address, icon: icon || "📍" };
    else {
      if (user.savedAddresses.length >= 5) user.savedAddresses.shift();
      user.savedAddresses.push({ label, address, icon: icon || "📍" });
    }
    await user.save();
    res.json({ success: true, addresses: user.savedAddresses });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/users/addresses/:label — Xóa địa chỉ
app.delete("/api/users/addresses/:label", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    await User.findByIdAndUpdate(req.session.userId, {
      $pull: { savedAddresses: { label: req.params.label } }
    });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/users/search-history — Lưu lịch sử tìm kiếm
app.post("/api/users/search-history", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(200).json({ success: true }); // silent fail for guests
    const { query } = req.body;
    if (!query || query.trim().length < 2) return res.status(200).json({ success: true });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(200).json({ success: true });
    // Remove duplicate + push to front + keep 10
    user.searchHistory = [query, ...user.searchHistory.filter(h => h !== query)].slice(0, 10);
    await user.save();
    res.json({ success: true });
  } catch(err) { res.status(200).json({ success: true }); }
});

// GET /api/users/search-history — Lấy lịch sử tìm kiếm
app.get("/api/users/search-history", async (req, res) => {
  try {
    if (!req.session.userId) return res.json({ success: true, history: [] });
    const user = await User.findById(req.session.userId).select("searchHistory");
    res.json({ success: true, history: user?.searchHistory || [] });
  } catch(err) { res.json({ success: true, history: [] }); }
});

// GET /api/flash-deals — Flash deals (lấy từ voucher có tag flash)
app.get("/api/flash-deals", async (req, res) => {
  try {
    if (!Voucher) return res.json({ success: true, deals: [], partners: [] });
    const now = new Date();
    const deals = await Voucher.find({
      active: true,
      expiresAt: { $gt: now },
      description: { $regex: /flash|deal|hot/i }
    }).limit(5).select("code type value minOrder maxDiscount description expiresAt");
    // Also include partner flash promos
    const partners = await FoodPartner.find({
      status: { $in: ["approved","active"] },
      isAccepting: true,
    }).limit(8).select("bizName emoji district categories rating");
    res.json({ success: true, deals, partners });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/partner/accepting — Partner bật/tắt nhận đơn
app.patch("/api/partner/accepting", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false });
    const { isAccepting } = req.body;
    const mod = req.session.partnerModule;
    const Model = getPartnerModel(mod);
    if (!Model) return res.status(400).json({ success: false });
    await Model.findByIdAndUpdate(req.session.partnerId, { isAccepting: !!isAccepting });
    req.io.to("admin").emit("partnerStatusChanged", {
      partnerId: req.session.partnerId, isAccepting, module: mod
    });
    res.json({ success: true, isAccepting: !!isAccepting });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/users/bank — Lưu thông tin ngân hàng (shipper rút tiền)
app.patch("/api/users/bank", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const { bankName, accountNo, accountName } = req.body;
    await User.findByIdAndUpdate(req.session.userId, {
      bankAccount: { bankName, accountNo: accountNo?.trim(), accountName: accountName?.trim() }
    });
    res.json({ success: true, message: "Đã lưu thông tin ngân hàng" });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/shipper/heatmap — Giờ cao điểm theo giờ trong ngày
app.get("/api/shipper/heatmap", async (req, res) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now - 7*24*3600*1000);
    const agg = await Order.aggregate([
      { $match: { status: "delivered", deliveredAt: { $gte: weekAgo } }},
      { $group: { _id: { $hour: "$deliveredAt" }, count: { $sum: 1 } }}
    ]);
    const hours = Array(24).fill(0);
    agg.forEach(({ _id: h, count }) => { hours[h] = count; });
    const max = Math.max(...hours, 1);
    res.json({ success: true, hours: hours.map(c => ({ count: c, pct: Math.round(c/max*100) })) });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// Admin: GET /api/admin/vouchers — voucher management
app.get("/api/admin/vouchers", adminAuth, async (req, res) => {
  try {
    const vs = await Voucher.find().sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, data: vs, total: vs.length });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});
app.delete("/api/admin/vouchers/:id", adminAuth, async (req, res) => {
  try {
    await Voucher.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});
app.patch("/api/admin/vouchers/:id", adminAuth, async (req, res) => {
  try {
    const v = await Voucher.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: v });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});


// ══════════════════════════════════════════════════════════════
//  TIER 3: Loyalty · Schedule · Analytics · Leaderboard · SOS
// ══════════════════════════════════════════════════════════════

// POST /api/orders/:id/schedule — Đặt trước theo giờ
app.patch("/api/orders/:id/schedule", async (req, res) => {
  try {
    const { scheduledAt } = req.body;
    if (!scheduledAt) return res.status(400).json({ success: false });
    const d = new Date(scheduledAt);
    if (d <= new Date()) return res.status(400).json({ success: false, message: "Thời gian phải trong tương lai" });
    const order = await Order.findOneAndUpdate(
      { orderId: req.params.id },
      { scheduledAt: d, isScheduled: true, status: "pending" },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false });
    res.json({ success: true, message: `Đã đặt lịch giao lúc ${d.toLocaleString('vi-VN')}` });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/loyalty/earn — Cộng điểm sau đơn delivered (gọi sau processReferralReward)
async function earnLoyaltyPoints(userId, orderTotal) {
  try {
    if (!userId || !orderTotal) return;
    const pts = Math.floor(orderTotal / 10000); // 1 điểm / 10k chi tiêu
    if (pts <= 0) return;
    await User.findByIdAndUpdate(userId, {
      $inc: { loyaltyPts: pts, totalSpent: orderTotal }
    });
    console.log(` [Loyalty] +${pts} pts for user ${userId}`);
  } catch(e) {}
}

// GET /api/loyalty/me — Điểm tích lũy của user
app.get("/api/loyalty/me", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const user = await User.findById(req.session.userId).select("loyaltyPts totalSpent totalOrders");
    if (!user) return res.status(404).json({ success: false });
    const pts = user.loyaltyPts || 0;
    const tiers = [
      { name:'Thành viên', icon:'🥉', min:0,    color:'#cd7f32', perks:['Tích 1đ/10k'] },
      { name:'Bạc',        icon:'🥈', min:100,  color:'#aaa',    perks:['Tích 1.2đ/10k','Voucher sinh nhật'] },
      { name:'Vàng',       icon:'🥇', min:500,  color:'#FFD700', perks:['Tích 1.5đ/10k','Freeship 2 đơn/tháng'] },
      { name:'VIP',        icon:'💎', min:2000, color:'#b9f2ff', perks:['Tích 2đ/10k','Freeship không giới hạn','Ưu tiên shipper'] },
    ];
    let currentTier = tiers[0];
    for (let i = tiers.length-1; i >= 0; i--) {
      if (pts >= tiers[i].min) { currentTier = tiers[i]; break; }
    }
    const nextTier = tiers[tiers.indexOf(currentTier)+1] || null;
    res.json({ success: true, pts, currentTier, nextTier, totalOrders: user.totalOrders || 0, totalSpent: user.totalSpent || 0 });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/loyalty/redeem — Đổi điểm lấy voucher
app.post("/api/loyalty/redeem", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const { pts } = req.body; // số điểm muốn đổi
    if (!pts || pts < 50) return res.status(400).json({ success: false, message: "Tối thiểu 50 điểm để đổi" });
    const user = await User.findById(req.session.userId);
    if (!user || (user.loyaltyPts || 0) < pts) return res.status(400).json({ success: false, message: "Không đủ điểm" });
    const discount = pts * 200; // 1 điểm = 200đ
    // Create one-time voucher
    const code = "LYL" + Date.now().toString(36).toUpperCase();
    const expiry = new Date(Date.now() + 7*24*3600*1000); // 7 ngày
    await Voucher.create({ code, type:"fixed", value:discount, minOrder:0, usageLimit:1, expiresAt:expiry, description:`Đổi ${pts} điểm`, module:"all", active:true });
    await User.findByIdAndUpdate(req.session.userId, { $inc: { loyaltyPts: -pts } });
    res.json({ success: true, code, discount, message: `Đã đổi ${pts} điểm thành voucher ${code} (giảm ${discount.toLocaleString('vi-VN')}đ)` });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/analytics/advanced — Advanced analytics cho admin
app.get("/api/analytics/advanced", adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const days = Number(req.query.days) || 30;
    const since = new Date(now - days*24*3600*1000);

    const [
      ordersByStatus, ordersByModule, revenueByDay,
      topPartners, topShippers, newUsersPerDay
    ] = await Promise.all([
      Order.aggregate([{ $group: { _id:"$status", count:{$sum:1} } }]),
      Order.aggregate([
        { $match:{ createdAt:{$gte:since} } },
        { $group:{ _id:"$module", count:{$sum:1}, revenue:{$sum:"$finalTotal"} } }
      ]),
      Order.aggregate([
        { $match:{ status:"delivered", deliveredAt:{$gte:since} } },
        { $group:{ _id:{ $dateToString:{format:"%Y-%m-%d",date:"$deliveredAt"} }, revenue:{$sum:"$finalTotal"}, orders:{$sum:1} } },
        { $sort:{ _id:1 } }
      ]),
      FoodPartner.find({ status:{$in:["approved","active"]} }).sort({ totalSales:-1 }).limit(5).select("bizName totalSales rating"),
      Shipper.find({ status:{$in:["approved","active"]} }).sort({ ordersCompleted:-1 }).limit(5).select("fullName ordersCompleted rating"),
      User.aggregate([
        { $match:{ createdAt:{$gte:since} } },
        { $group:{ _id:{ $dateToString:{format:"%Y-%m-%d",date:"$createdAt"} }, count:{$sum:1} } },
        { $sort:{ _id:1 } }
      ]),
    ]);

    res.json({ success:true, data:{ ordersByStatus, ordersByModule, revenueByDay, topPartners, topShippers, newUsersPerDay, period:days } });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/analytics/zones — Heatmap khu vực đặt đơn
app.get("/api/analytics/zones", adminAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7*24*3600*1000);
    const zones = await Order.aggregate([
      { $match:{ createdAt:{$gte:since} } },
      { $group:{ _id:"$district", count:{$sum:1}, revenue:{$sum:"$finalTotal"} } },
      { $sort:{ count:-1 } }, { $limit:20 }
    ]);
    res.json({ success:true, zones });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/sales/leaderboard — Top Sales CTV tháng này
app.get("/api/sales/leaderboard", async (req, res) => {
  try {
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
    const top = await Sales.find({ status:"active" })
      .sort({ totalEarned:-1 }).limit(10)
      .select("fullName refCode walletBalance totalEarned phone");
    const leaderboard = top.map((s, i) => ({
      rank: i+1, name: s.fullName, refCode: s.refCode,
      earned: s.totalEarned, phone: s.phone.slice(0,4)+"****"+s.phone.slice(-3),
    }));
    res.json({ success:true, leaderboard });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/support — Gửi ticket hỗ trợ / SOS
app.post("/api/support", async (req, res) => {
  try {
    const { message, type, orderId, role, phone } = req.body;
    if (!message) return res.status(400).json({ success:false, message:"Thiếu nội dung" });
    const ticket = await SupportTicket.create({
      userId: req.session.userId || null, phone, role: role||"customer",
      orderId, type: type||"other", message,
      priority: type === "sos" ? "urgent" : "medium",
    });
    // Notify admin realtime
    req.io.to("admin").emit("newSupportTicket", {
      id: ticket._id, type, role, message: message.slice(0,80), priority: ticket.priority
    });
    if (type === "sos") {
      req.io.to("admin").emit("SOS_ALERT", { ticketId: ticket._id, phone, orderId, message });
    }
    res.json({ success:true, ticketId: ticket._id, message:"Đã gửi yêu cầu hỗ trợ. Chúng tôi sẽ phản hồi trong 30 phút." });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/admin/support — Admin list tickets
app.get("/api/admin/support", adminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const tickets = await SupportTicket.find(filter).sort({ createdAt:-1 }).limit(100);
    res.json({ success:true, data:tickets, total:tickets.length });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// PATCH /api/admin/support/:id — Resolve ticket
app.patch("/api/admin/support/:id", adminAuth, async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const t = await SupportTicket.findByIdAndUpdate(req.params.id,
      { status, adminNote, ...(status==="resolved"?{resolvedAt:new Date()}:{}) },
      { new:true }
    );
    res.json({ success:true, data:t });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/food-partners/featured — Spotlight partners
app.get("/api/food-partners/featured", async (req, res) => {
  try {
    const now = new Date();
    const featured = await FoodPartner.find({
      featured: true, featuredUntil: { $gt: now },
      status: { $in:["approved","active"] }
    }).limit(6).select("bizName emoji district categories rating coverImage");
    res.json({ success:true, data:featured });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});


// ══════════════════════════════════════════════
//  AI BANNER ENDPOINTS
// ══════════════════════════════════════════════

// GET /api/banners — Public: lấy banner active để hiển thị cho customer
app.get("/api/banners", async (req, res) => {
  try {
    if (!AIBanner) return res.json({ success: true, data: [] });
    const now = new Date();
    const banners = await AIBanner.find({
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    }).sort({ order: -1, createdAt: -1 }).limit(10);
    // Track impressions
    const ids = banners.map(b => b._id);
    AIBanner.updateMany({ _id: { $in: ids } }, { $inc: { impressions: 1 } }).catch(()=>{});
    res.json({ success: true, data: banners });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/banners/:id/click — Track click
app.post("/api/banners/:id/click", async (req, res) => {
  try {
    await AIBanner.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
    res.json({ success: true });
  } catch(err) { res.status(200).json({ success: true }); }
});

// GET /api/admin/banners — Admin: list all banners
app.get("/api/admin/banners", adminAuth, async (req, res) => {
  try {
    const banners = await AIBanner.find().sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, data: banners, total: banners.length });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/banners — Admin: tạo banner mới (từ AI hoặc thủ công)
app.post("/api/admin/banners", adminAuth, async (req, res) => {
  try {
    const banner = await AIBanner.create(req.body);
    // Broadcast realtime tới tất cả customer
    req.io.to("customer_broadcast").emit("bannersUpdated", { action: "add", bannerId: banner._id });
    res.json({ success: true, data: banner });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/admin/banners/:id — Admin: cập nhật banner
app.patch("/api/admin/banners/:id", adminAuth, async (req, res) => {
  try {
    const banner = await AIBanner.findByIdAndUpdate(req.params.id, req.body, { new: true });
    req.io.to("customer_broadcast").emit("bannersUpdated", { action: "update", bannerId: banner._id });
    res.json({ success: true, data: banner });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/admin/banners/:id — Admin: xóa banner
app.delete("/api/admin/banners/:id", adminAuth, async (req, res) => {
  try {
    await AIBanner.findByIdAndDelete(req.params.id);
    req.io.to("customer_broadcast").emit("bannersUpdated", { action: "delete" });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});


// POST /api/claude — Proxy Anthropic API (tránh CORS)
app.post("/api/claude", async (req, res) => {
  try {
    const { messages, system, max_tokens = 1000 } = req.body;
    if (!messages) return res.status(400).json({ success: false });
    const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || "";
    if (!CLAUDE_KEY) return res.status(500).json({ success: false, message: "Chưa cấu hình API key" });
    const r = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514",
      max_tokens,
      system,
      messages,
    }, {
      headers: {
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 30000,
    });
    res.json(r.data);
  } catch(err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: msg });
  }
});


// ── EMAIL OTP ENDPOINTS ──────────────────────────────────────

// POST /api/auth/send-otp-email
app.post("/api/auth/send-otp-email", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, message: "Email không hợp lệ" });

    const key = `email-otp:${email}`;
    if (!rateLimit(key, 3))
      return res.status(429).json({ success: false, message: "Gửi quá nhiều lần. Thử lại sau 10 phút." });

    const result = await sendEmailOtp(email);
    res.json({ success: true, message: "OTP đã gửi về email" });
  } catch(err) {
    console.error("[EMAIL-OTP]", err.message);
    res.status(500).json({ success: false, message: "Không gửi được email: " + err.message });
  }
});

// POST /api/auth/verify-otp-email — xác minh OTP email → tạo session
app.post("/api/auth/verify-otp-email", async (req, res) => {
  try {
    const { email, code, type = "auth" } = req.body;
    if (!email || !code)
      return res.status(400).json({ success: false, message: "Thiếu email hoặc OTP" });

    const check = verifyEmailOtp(email, code);
    if (!check.ok) return res.status(400).json({ success: false, message: check.reason });

    // Tìm hoặc tạo user theo email
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Tạo mới với email, phone để trống (user cần complete profile sau)
      user = await User.create({
        phone:   "email_" + Date.now(), // placeholder
        email:   email.toLowerCase(),
        status:  "active",
        profileComplete: false,
      });
    }

    req.session.userId   = user._id;
    req.session.userPhone = user.phone;
    await new Promise((res, rej) => req.session.save(e => e ? rej(e) : res()));

    res.json({
      success: true,
      message: "Đăng nhập thành công qua email",
      user: {
        _id:             user._id,
        email:           user.email,
        phone:           user.phone.startsWith("email_") ? "" : user.phone,
        fullName:        user.fullName || "",
        profileComplete: user.profileComplete || false,
        loyaltyPts:      user.loyaltyPts || 0,
      },
    });
  } catch(err) {
    console.error("[VERIFY-EMAIL-OTP]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/send-otp-email/partner — partner dùng email OTP
app.post("/api/auth/send-otp-email/partner", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, message: "Email không hợp lệ" });
    if (!rateLimit(`email-otp:${email}`, 3))
      return res.status(429).json({ success: false, message: "Thử lại sau 10 phút." });
    const result = await sendEmailOtp(email);
    res.json({ success: true, message: "OTP đã gửi về email" });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/verify-otp-email/partner
app.post("/api/auth/verify-otp-email/partner", async (req, res) => {
  try {
    const { email, code } = req.body;
    const check = verifyEmailOtp(email, code);
    if (!check.ok) return res.status(400).json({ success: false, message: check.reason });
    // Tìm partner theo email
    let found = null, module = null;
    for (const [Model, mod] of [
      [FoodPartner,'food_partner'],[GiatLa,'giat_la'],[GiupViec,'giup_viec'],
      [ChinaShop,'china_shop'],
    ]) {
      const p = await Model.findOne({ email: email.toLowerCase(), status: { $ne: "rejected" } });
      if (p) { found = p; module = mod; break; }
    }
    if (!found) return res.status(404).json({ success: false, message: "Email chưa đăng ký đối tác" });
    req.session.partnerId     = found._id;
    req.session.partnerModule = module;
    await new Promise((res, rej) => req.session.save(e => e ? rej(e) : res()));
    res.json({ success: true, partner: { _id: found._id, bizName: found.bizName, module } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/send-otp-email/shipper
app.post("/api/auth/send-otp-email/shipper", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, message: "Email không hợp lệ" });
    if (!rateLimit(`email-otp:${email}`, 3))
      return res.status(429).json({ success: false, message: "Thử lại sau 10 phút." });
    const result = await sendEmailOtp(email);
    res.json({ success: true, message: "OTP đã gửi về email" });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/verify-otp-email/shipper
app.post("/api/auth/verify-otp-email/shipper", async (req, res) => {
  try {
    const { email, code } = req.body;
    const check = verifyEmailOtp(email, code);
    if (!check.ok) return res.status(400).json({ success: false, message: check.reason });
    const shipper = await Shipper.findOne({ email: email.toLowerCase() });
    if (!shipper) return res.status(404).json({ success: false, message: "Email chưa đăng ký shipper" });
    req.session.userId    = shipper._id;
    req.session.userPhone = shipper.phone;
    await new Promise((res, rej) => req.session.save(e => e ? rej(e) : res()));
    res.json({ success: true, shipper: { _id: shipper._id, fullName: shipper.fullName, status: shipper.status } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});




// ══════════════════════════════════════════════════════════════
//  VÍ CRABOR — WALLET ENDPOINTS
// ══════════════════════════════════════════════════════════════

// Determine owner from session
function getWalletOwner(req) {
  if (req.session.userId)    return { id: req.session.userId,    type: 'user' };
  if (req.session.partnerId) return { id: req.session.partnerId, type: 'partner' };
  return null;
}

// GET /api/wallet — số dư + lịch sử
app.get("/api/wallet", async (req, res) => {
  try {
    const owner = getWalletOwner(req);
    if (!owner) return res.status(401).json({ success:false });
    const Model = owner.type==='user' ? User : owner.type==='shipper' ? Shipper
               : owner.type==='sales' ? Sales : FoodPartner;
    const doc = await Model.findById(owner.id).select('walletBalance walletEarned fullName phone');
    if (!doc) return res.status(404).json({ success:false });
    const txs = await WalletTx.find({ ownerId: owner.id }).sort({ createdAt:-1 }).limit(50);
    res.json({ success:true, balance: doc.walletBalance||0, earned: doc.walletEarned||0, transactions: txs });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/wallet/shipper — shipper dùng session khác
app.get("/api/wallet/shipper", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const shipper = await Shipper.findOne({ _id: req.session.userId }).select('walletBalance walletEarned');
    if (!shipper) {
      // Fallback: find by phone
      const user = await User.findById(req.session.userId).select('phone');
      const s = user ? await Shipper.findOne({ phone: user.phone }).select('walletBalance walletEarned _id') : null;
      if (!s) return res.status(404).json({ success:false });
      const txs = await WalletTx.find({ ownerId: s._id }).sort({ createdAt:-1 }).limit(50);
      return res.json({ success:true, balance: s.walletBalance||0, earned: s.walletEarned||0, transactions: txs });
    }
    const txs = await WalletTx.find({ ownerId: shipper._id }).sort({ createdAt:-1 }).limit(50);
    res.json({ success:true, balance: shipper.walletBalance||0, earned: shipper.walletEarned||0, transactions: txs });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/wallet/withdraw — rút tiền (200k–50tr)
app.post("/api/wallet/withdraw", async (req, res) => {
  try {
    const owner = getWalletOwner(req);
    if (!owner) return res.status(401).json({ success:false });
    const { amount, bankName, accountNo, accountName } = req.body;
    const amt = Number(amount);
    if (!amt || amt < 200000)  return res.status(400).json({ success:false, message:'Số tiền rút tối thiểu 200.000đ' });
    if (amt > 50000000)        return res.status(400).json({ success:false, message:'Số tiền rút tối đa 50.000.000đ' });
    if (!bankName || !accountNo || !accountName) return res.status(400).json({ success:false, message:'Thiếu thông tin ngân hàng' });
    const newBal = await walletDebit(owner.id, owner.type, amt, 'withdraw', null, `Rút tiền → ${bankName} ${accountNo}`);
    // Notify admin
    req.io.to('admin').emit('withdrawRequest', { ownerId: owner.id, ownerType: owner.type, amount: amt, bankName, accountNo, accountName });
    res.json({ success:true, newBalance: newBal, message:`Yêu cầu rút ${amt.toLocaleString('vi-VN')}đ đã ghi nhận. Xử lý trong 1–3 ngày làm việc.` });
  } catch(err) { res.status(400).json({ success:false, message:err.message }); }
});

// POST /api/wallet/exchange-voucher — đổi điểm/tiền ví lấy voucher
app.post("/api/wallet/exchange-voucher", async (req, res) => {
  try {
    const owner = getWalletOwner(req);
    if (!owner) return res.status(401).json({ success:false });
    const { amount } = req.body; // số tiền từ ví muốn đổi thành voucher
    const amt = Number(amount);
    if (!amt || amt < 10000) return res.status(400).json({ success:false, message:'Tối thiểu 10.000đ để đổi voucher' });
    await walletDebit(owner.id, owner.type, amt, 'debit', null, 'Đổi voucher');
    const code = 'WLT' + Date.now().toString(36).toUpperCase();
    const expiry = new Date(Date.now() + 30*24*3600*1000);
    const voucher = await Voucher.create({ code, type:'fixed', value:amt, minOrder:0, usageLimit:1, expiresAt:expiry, description:`Đổi từ ví CRABOR`, module:'all', active:true });
    res.json({ success:true, code, value:amt, message:`Đã đổi thành công! Mã voucher: ${code}` });
  } catch(err) { res.status(400).json({ success:false, message:err.message }); }
});

// ══════════════════════════════════════════════════════════════
//  VÍ TRẢ SAU CRABOR — BNPL
// ══════════════════════════════════════════════════════════════

function getBillingMonth(d=new Date()){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
function getNextBillDate(from=new Date()){const d=new Date(from);d.setDate(24);if(from.getDate()>=24)d.setMonth(d.getMonth()+1);d.setHours(23,59,59,999);return d;}
function getCreditLimit(totalSpent=0){if(totalSpent>=20000000)return 10000000;if(totalSpent>=10000000)return 5000000;if(totalSpent>=5000000)return 3000000;if(totalSpent>=2000000)return 1000000;return 0;}

// ══════════════════════════════════════════════════════════════
//  VÍ TRẢ SAU — BNPL (chuẩn SPayLater + CRABOR rules)
// Chu kỳ: dùng bao nhiêu tháng đó trả bấy nhiêu (trước ngày 15)
// Trễ hạn: +30.000đ cố định | Trả góp: +10% phí chuyển đổi
// Thanh toán: SePay QR (VIB 068394585)
// ══════════════════════════════════════════════════════════════

// GET /api/bnpl/eligibility
app.get("/api/bnpl/eligibility", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const user = await User.findById(req.session.userId).select('totalSpent');
    if (!user) return res.status(404).json({ success:false });
    const spent = user.totalSpent||0;
    const limit = getBnplLimit(spent);
    const month = getCurrentBillingMonth();
    const txs = await BNPLTx.find({ userId:req.session.userId, billingMonth:month, status:{$in:['pending_bill','billed']} });
    const usedThisMonth = txs.reduce((s,t)=>s+t.amount,0);
    const available = Math.max(0, limit-usedThisMonth);
    const unpaid = await BNPLInvoice.find({ userId:req.session.userId, status:{$in:['issued','overdue','installment']} }).sort({dueDate:1});
    res.json({ success:true, eligible:limit>0, limit, spent, usedThisMonth, available,
      message: limit>0
        ? `Hạn mức: ${limit.toLocaleString('vi-VN')}đ | Còn: ${available.toLocaleString('vi-VN')}đ`
        : `Cần giao dịch thêm ${(2000000-spent).toLocaleString('vi-VN')}đ để mở Ví Trả Sau`,
      unpaidInvoices: unpaid });
  } catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// POST /api/bnpl/use — ghi nhận giao dịch trả sau
app.post("/api/bnpl/use", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({success:false});
    const {orderId, amount, serviceType='food'} = req.body;
    const amt = Number(amount);
    if (!amt||amt<=0) return res.status(400).json({success:false,message:'Số tiền không hợp lệ'});
    const user = await User.findById(req.session.userId).select('totalSpent');
    const limit = getBnplLimit(user?.totalSpent||0);
    if (!limit) return res.status(403).json({success:false,message:'Chưa đủ điều kiện (cần giao dịch từ 2.000.000đ)'});
    const month = getCurrentBillingMonth();
    const txs = await BNPLTx.find({userId:req.session.userId, billingMonth:month, status:{$in:['pending_bill','billed']}});
    const used = txs.reduce((s,t)=>s+t.amount,0);
    if (used+amt>limit) return res.status(400).json({success:false,message:`Vượt hạn mức (còn ${(limit-used).toLocaleString('vi-VN')}đ)`});
    const tx = await BNPLTx.create({userId:req.session.userId, orderId, amount:amt, serviceType, billingMonth:month});
    res.json({success:true, data:tx, message:`Trả sau ${amt.toLocaleString('vi-VN')}đ. Thanh toán trước ngày 15/${month.slice(5)}/${month.slice(0,4)}`});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// GET /api/bnpl/summary — tổng kết tháng + hóa đơn
app.get("/api/bnpl/summary", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({success:false});
    const month = getCurrentBillingMonth();
    const pending = await BNPLTx.find({userId:req.session.userId, billingMonth:month, status:'pending_bill'}).sort({createdAt:-1});
    const total = pending.reduce((s,t)=>s+t.amount,0);
    const invoices = await BNPLInvoice.find({userId:req.session.userId}).sort({createdAt:-1}).limit(12);
    res.json({success:true, currentMonth:month, pendingTotal:total, pendingTxs:pending, invoices});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// POST /api/bnpl/invoice/:id/prepare-pay — tạo QR SePay để thanh toán
app.post("/api/bnpl/invoice/:id/prepare-pay", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({success:false});
    const inv = await BNPLInvoice.findOne({_id:req.params.id, userId:req.session.userId});
    if (!inv) return res.status(404).json({success:false,message:'Không tìm thấy hóa đơn'});
    if (inv.status==='paid') return res.status(400).json({success:false,message:'Đã thanh toán'});
    const now = new Date();
    const late = now > inv.dueDate && inv.status!=='installment';
    const lateFee = late ? 30000 : 0;
    const finalAmount = inv.totalAmount + inv.installFee + lateFee;
    const sePayRef = 'BNPL'+inv._id.toString().slice(-8).toUpperCase();
    await BNPLInvoice.findByIdAndUpdate(inv._id,{lateFee,finalAmount,sePayRef});
    res.json({
      success:true, finalAmount, lateFee, sePayRef,
      qrUrl:`https://qr.sepay.vn/img?bank=VIB&acc=068394585&template=compact&amount=${finalAmount}&des=${encodeURIComponent(sePayRef)}`,
      bankName:'VIB', accountNo:'068394585', accountName:'CRABOR TECH CO LTD',
      message:`Chuyển khoản ${finalAmount.toLocaleString('vi-VN')}đ · Nội dung: ${sePayRef}`,
      note: late ? `⚠️ Quá hạn: +30.000đ phí trễ` : `✅ Thanh toán đúng hạn`,
    });
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// POST /api/bnpl/invoice/:id/installment — chuyển trả góp (+10%)
app.post("/api/bnpl/invoice/:id/installment", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({success:false});
    const {terms=3} = req.body;
    if (![2,3,6,12].includes(Number(terms)))
      return res.status(400).json({success:false,message:'Kỳ hạn: 2, 3, 6 hoặc 12 tháng'});
    const inv = await BNPLInvoice.findOne({_id:req.params.id, userId:req.session.userId, status:{$in:['issued','overdue']}});
    if (!inv) return res.status(404).json({success:false,message:'Không tìm thấy hoặc không đủ điều kiện'});
    const installFee = Math.round(inv.totalAmount*0.10);
    const finalAmount = inv.totalAmount+installFee;
    const perTerm = Math.ceil(finalAmount/Number(terms));
    await BNPLInvoice.findByIdAndUpdate(inv._id,{isInstallment:true,installTerms:Number(terms),installFee,finalAmount,status:'installment'});
    res.json({success:true, installFee, finalAmount, perTerm, terms:Number(terms),
      message:`Trả góp ${terms} kỳ. Phí 10%: ${installFee.toLocaleString('vi-VN')}đ. Mỗi kỳ: ${perTerm.toLocaleString('vi-VN')}đ`});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// POST /api/bnpl/invoice/:id/confirm-paid — admin xác nhận đã nhận tiền
app.post("/api/bnpl/invoice/:id/confirm-paid", adminAuth, async (req,res) => {
  try {
    const inv = await BNPLInvoice.findByIdAndUpdate(req.params.id,{status:'paid',paidAt:new Date()},{new:true});
    if (!inv) return res.status(404).json({success:false});
    await BNPLTx.updateMany({invoiceId:inv._id},{status:'paid'});
    await User.findByIdAndUpdate(inv.userId,{$inc:{loyaltyPts:Math.floor(inv.totalAmount/10000)}});
    req.io.to('admin').emit('bnplPaid',{invoiceId:inv._id,amount:inv.finalAmount});
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// CRON: auto-overdue check mỗi 6h
setInterval(async()=>{
  try {
    await BNPLInvoice.updateMany({status:'issued',dueDate:{$lt:new Date()}},{$set:{status:'overdue',lateFee:30000}});
  } catch(e){}
}, 6*60*60*1000);


// ── VAY NHANH ────────────────────────────────────────────

// GET /api/loan/eligibility
app.get("/api/loan/eligibility", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const user = await User.findById(req.session.userId).select('totalSpent');
    const eligible = (user?.totalSpent||0) >= 2000000;
    const activeLoan = await Loan.findOne({ userId: req.session.userId, status:{$in:['approved','active']} });
    res.json({ success:true, eligible, totalSpent: user?.totalSpent||0, hasActiveLoan: !!activeLoan, activeLoan,
      message: eligible ? 'Đủ điều kiện vay nhanh' : `Cần giao dịch thêm ${(2000000-(user?.totalSpent||0)).toLocaleString('vi-VN')}đ` });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/loan/apply — đăng ký vay
app.post("/api/loan/apply", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const user = await User.findById(req.session.userId).select('totalSpent fullName');
    if (!user || (user.totalSpent||0) < 2000000)
      return res.status(403).json({ success:false, message:'Chưa đủ điều kiện (cần giao dịch từ 2.000.000đ)' });
    const existing = await Loan.findOne({ userId: req.session.userId, status:{$in:['pending','approved','active']} });
    if (existing) return res.status(400).json({ success:false, message:'Bạn đang có khoản vay chưa tất toán' });
    const { amount, termMonths=3 } = req.body;
    const amt = Number(amount);
    if (amt < 1000000)  return res.status(400).json({ success:false, message:'Tối thiểu 1.000.000đ' });
    if (amt > 50000000) return res.status(400).json({ success:false, message:'Tối đa 50.000.000đ' });
    const rate = 1.5; // %/tháng
    const totalRepay = Math.round(amt * (1 + rate/100 * termMonths));
    const loan = await Loan.create({ userId: req.session.userId, amount:amt, termMonths, interestRate:rate, totalRepay, status:'pending' });
    req.io.to('admin').emit('newLoanApplication', { loanId:loan._id, userId: req.session.userId, amount:amt, userName: user.fullName });
    res.json({ success:true, data:loan, message:`Đã gửi đơn vay ${amt.toLocaleString('vi-VN')}đ. Admin sẽ xét duyệt trong 24h.` });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/loan/my — lịch sử vay
app.get("/api/loan/my", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const loans = await Loan.find({ userId: req.session.userId }).sort({ createdAt:-1 }).limit(10);
    res.json({ success:true, data:loans });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// PATCH /api/admin/loan/:id — Admin duyệt/từ chối khoản vay
app.patch("/api/admin/loan/:id", adminAuth, async (req, res) => {
  try {
    const { status, note } = req.body;
    const loan = await Loan.findById(req.params.id);
    if (!loan) return res.status(404).json({ success:false });
    const updates = { status, note };
    if (status === 'approved') {
      updates.disbursedAt = new Date();
      updates.dueAt = new Date(Date.now() + loan.termMonths * 30 * 24 * 3600 * 1000);
      // Cộng tiền vào ví user
      await walletCredit(loan.userId, 'user', loan.amount, loan._id.toString(), `Giải ngân khoản vay`);
    }
    await Loan.findByIdAndUpdate(loan._id, updates);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});


// ══════════════════════════════════════════════════════════════
//  SEPAY WEBHOOK — Auto-confirm mọi thanh toán
//  Setup: SePay dashboard → Webhook URL → POST /api/webhook/sepay
//  Khi có tài khoản DN + payment 1 chạm: không cần admin confirm
// ══════════════════════════════════════════════════════════════

// POST /api/webhook/sepay — SePay gọi về khi có GD vào TK
app.post("/api/webhook/sepay", async (req, res) => {
  try {
    // SePay gửi: { id, gateway, transactionDate, accountNumber,
    //              code, content, transferType, transferAmount,
    //              accumulated, subAccount, referenceCode, description }
    const { content, transferAmount, transferType, referenceCode } = req.body;

    // Chỉ xử lý tiền vào
    if (transferType !== 'in') return res.json({ success: true });

    const amount    = Number(transferAmount);
    const rawRef    = (content || referenceCode || '').toUpperCase().trim();

    console.log(`[SEPAY] Webhook: ${rawRef} · ${amount.toLocaleString('vi-VN')}đ`);

    let handled = false;

    // ── 1. BNPL Invoice payment ──────────────────────────────
    const bnplMatch = rawRef.match(/BNPL([A-Z0-9]{6,8})/);
    if (bnplMatch) {
      const suffix = bnplMatch[1];
      const inv = await BNPLInvoice.findOne({ sePayRef: { $regex: suffix, $options:'i' }, status:{$in:['issued','overdue','installment']} });
      if (inv && amount >= (inv.finalAmount - 1000)) { // tolerance 1k
        await BNPLInvoice.findByIdAndUpdate(inv._id, { status:'paid', paidAt: new Date() });
        await BNPLTx.updateMany({ invoiceId: inv._id }, { status:'paid' });
        await User.findByIdAndUpdate(inv.userId, { $inc: { loyaltyPts: Math.floor(inv.totalAmount/10000) } });
        req.io?.to('admin').emit('bnplPaid', { invoiceId:inv._id, amount:inv.finalAmount });
        req.io?.to(inv.userId.toString()).emit('bnplConfirmed', { invoiceId:inv._id });
        console.log(`[SEPAY] BNPL confirmed: ${inv._id}`);
        handled = true;
      }
    }

    // ── 2. Shipper registration fee ──────────────────────────
    const shipMatch = rawRef.match(/CRSHIP([A-Z0-9]+)/);
    if (shipMatch && !handled) {
      const appId = shipMatch[1];
      const app_ = await Shipper.findOne({ appId: { $regex: appId, $options:'i' }, status:'pending_payment' });
      if (app_) {
        await Shipper.findByIdAndUpdate(app_._id, { status:'pending_review', paidAt: new Date(), feePaid: amount });
        req.io?.to('admin').emit('shipperFeePaid', { shipperId: app_._id });
        console.log(`[SEPAY] Shipper fee confirmed: ${app_._id}`);
        handled = true;
      }
    }

    // ── 3. Partner registration fee ─────────────────────────
    const partnerMatch = rawRef.match(/CRPART([A-Z0-9]+)/);
    if (partnerMatch && !handled) {
      const appId = partnerMatch[1];
      for (const Model of [FoodPartner, GiatLa, GiupViec, ChinaShop]) {
        const p = await Model.findOne({ appId: { $regex: appId, $options:'i' }, status:'pending_payment' });
        if (p) {
          await Model.findByIdAndUpdate(p._id, { status:'pending_review', paidAt:new Date(), feePaid:amount });
          req.io?.to('admin').emit('partnerFeePaid', { partnerId:p._id });
          handled = true; break;
        }
      }
    }

    // ── 4. Wallet top-up (CRTOPUP + userId) ─────────────────
    const topupMatch = rawRef.match(/CRTOPUP([A-Z0-9]+)/);
    if (topupMatch && !handled) {
      const uid = topupMatch[1];
      // Try to match userId (last 8 chars)
      const user = await User.findOne({ _id: { $regex: uid, $options:'i' } }).catch(()=>null);
      if (user && amount >= 10000) {
        await walletCredit(user._id, 'user', amount, rawRef, 'Nạp ví CRABOR');
        req.io?.to(user._id.toString()).emit('walletCredited', { amount });
        handled = true;
      }
    }

    // ── 5. Loan repayment ────────────────────────────────────
    const loanMatch = rawRef.match(/CRLOAN([A-Z0-9]+)/);
    if (loanMatch && !handled) {
      const suffix = loanMatch[1];
      const loan = await Loan.findOne({ _id: { $regex: suffix, $options:'i' }, status:{$in:['approved','active']} });
      if (loan && amount > 0) {
        const remaining = loan.totalRepay - loan.paidAmount - amount;
        const newStatus = remaining <= 0 ? 'repaid' : 'active';
        await Loan.findByIdAndUpdate(loan._id, { $inc:{paidAmount:amount}, status:newStatus });
        if (newStatus==='repaid') {
          req.io?.to(loan.userId.toString()).emit('loanRepaid', { loanId:loan._id });
        }
        handled = true;
      }
    }

    if (!handled) {
      console.log(`[SEPAY] Unmatched webhook: ${rawRef} ${amount}đ — logged only`);
    }

    res.json({ success: true }); // Always 200 — SePay retries on non-200
  } catch(err) {
    console.error('[SEPAY Webhook Error]', err.message);
    res.json({ success: true }); // Still 200 to prevent SePay retry loop
  }
});

// ── PAYMENT 1 CHẠM — chuẩn bị (khi có tài khoản DN) ─────────
// Các API này để trống đến khi tích hợp MoMo/ZaloPay/VNPay thật
// Cấu trúc đã sẵn sàng — chỉ cần điền credentials

app.post("/api/payment/momo/create", async (req, res) => {
  // TODO: Tích hợp khi có tài khoản DN MoMo
  res.status(503).json({ success:false, message:'Thanh toán 1 chạm MoMo sẽ ra mắt sau khi đăng ký doanh nghiệp T5/2025. Vui lòng dùng QR SePay.' });
});

app.post("/api/payment/zalopay/create", async (req, res) => {
  // TODO: Tích hợp khi có tài khoản DN ZaloPay
  res.status(503).json({ success:false, message:'ZaloPay 1 chạm sẽ ra mắt sau khi đăng ký doanh nghiệp T5/2025.' });
});

// GET /api/payment/methods — trả về danh sách phương thức khả dụng
app.get("/api/payment/methods", (req, res) => {
  res.json({
    success: true,
    available: [
      { id:'sepay_qr', name:'QR SePay', icon:'📱', status:'active', note:'Chuyển khoản VIB — xác nhận trong 5–30 phút' },
      { id:'momo',     name:'MoMo',     icon:'💜', status:'coming_soon', note:'Ra mắt sau đăng ký doanh nghiệp T5/2025' },
      { id:'zalopay',  name:'ZaloPay',  icon:'🔵', status:'coming_soon', note:'Ra mắt sau đăng ký doanh nghiệp T5/2025' },
      { id:'vnpay',    name:'VNPay',    icon:'🔴', status:'coming_soon', note:'Ra mắt sau đăng ký doanh nghiệp T5/2025' },
    ]
  });
});


// ══════════════════════════════════════════════════════════════
//  AI PERSONALIZED — Claude với context tài khoản thật
//  Dùng cho: chatbot cá nhân, tổng đài AI, auto-email reply
// ══════════════════════════════════════════════════════════════

// Helper: lấy context đầy đủ của user cho AI
async function buildUserContext(userId) {
  if (!userId) return null;
  try {
    const [user, orders, wallet, bnplElig, loan] = await Promise.all([
      User.findById(userId).select('fullName phone email totalSpent loyaltyPts walletBalance'),
      // 3 đơn gần nhất
      mongoose.model('Order') ? mongoose.model('Order').find({customerId:userId}).sort({createdAt:-1}).limit(3).select('orderId status totalAmount createdAt') : Promise.resolve([]),
      WalletTx.find({ownerId:userId}).sort({createdAt:-1}).limit(5),
      BNPLInvoice.find({userId, status:{$in:['issued','overdue','installment']}}).limit(3),
      Loan.findOne({userId, status:{$in:['approved','active','pending']}}).select('amount status totalRepay paidAmount'),
    ]);
    if (!user) return null;
    return {
      name:        user.fullName || 'Khách hàng',
      phone:       user.phone,
      totalSpent:  user.totalSpent||0,
      loyaltyPts:  user.loyaltyPts||0,
      walletBal:   user.walletBalance||0,
      bnplLimit:   getBnplLimit(user.totalSpent||0),
      recentOrders: orders,
      recentTx:    wallet,
      unpaidInvoices: bnplElig,
      activeLoan:  loan,
    };
  } catch(e) { return null; }
}

// POST /api/claude/personalized — AI với full user context
// DEPRECATED: /api/claude/personalized → redirect to Coco
app.post("/api/claude/personalized", async (req, res) => { req.body.text = req.body.messages?.slice(-1)[0]?.content||""; return res.redirect(307,"/api/coco/chat"); }); //old:
app.post("/api/claude/personalized_old", async (req, res) => {
  try {
    const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || "";
    if (!CLAUDE_KEY) return res.status(500).json({ success:false, message:"Chưa cấu hình API key" });

    const { messages, page='customer' } = req.body;
    if (!messages) return res.status(400).json({ success:false });

    // Build user context
    const ctx = await buildUserContext(req.session.userId);

    const systemPrompt = `Bạn là CRABOR AI Assistant — trợ lý cá nhân hoá cho từng người dùng CRABOR.

${ctx ? `THÔNG TIN TÀI KHOẢN NGƯỜI DÙNG:
- Tên: ${ctx.name}
- Số điện thoại: ${ctx.phone}
- Tổng chi tiêu: ${ctx.totalSpent.toLocaleString('vi-VN')}đ
- Điểm loyalty: ${ctx.loyaltyPts} điểm
- Số dư ví: ${ctx.walletBal.toLocaleString('vi-VN')}đ
- Hạn mức Ví Trả Sau: ${ctx.bnplLimit.toLocaleString('vi-VN')}đ
${ctx.recentOrders?.length ? `- Đơn gần nhất: ${ctx.recentOrders.map(o=>`#${o.orderId||o._id} (${o.status} - ${(o.totalAmount||0).toLocaleString('vi-VN')}đ)`).join(', ')}` : ''}
${ctx.unpaidInvoices?.length ? `- ⚠️ Có ${ctx.unpaidInvoices.length} hóa đơn Ví Trả Sau chưa thanh toán` : ''}
${ctx.activeLoan ? `- Đang có khoản vay ${ctx.activeLoan.amount.toLocaleString('vi-VN')}đ (${ctx.activeLoan.status})` : ''}` : 'Người dùng chưa đăng nhập — chỉ tư vấn chung.'}

VỀ CRABOR:
- Super app giao đồ ăn, giặt là, giúp việc, China Shop, xe công nghệ tại Hà Nội
- Founder: Kiều Thanh Hải — sinh viên năm 2, Đại học Đại Nam, tự học code
- Ra mắt: T7/2025

CÁCH TRẢ LỜI:
- Xưng "em", gọi người dùng là "${ctx?.name||'bạn'}"
- Tham chiếu đúng thông tin tài khoản khi được hỏi
- Ngắn gọn, thân thiện, tối đa 180 từ
- Nếu hỏi về số dư, đơn hàng, hóa đơn → trả lời dựa trên dữ liệu thật ở trên
- Không bịa thông tin không có trong context`;

    const r = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: systemPrompt,
      messages,
    }, {
      headers: {
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 15000,
    });
    res.json({ success:true, content: r.data.content });
  } catch(err) {
    console.error("[AI Personalized]", err.message);
    res.status(500).json({ success:false, message:"AI tạm thời không khả dụng" });
  }
});

// ── AI HOTLINE (Tổng đài AI) ──────────────────────────────────
// POST /api/support/hotline-ai — chat với tổng đài AI
// POST /api/support/hotline-ai — redirect to Coco engine (no Anthropic)
app.post("/api/support/hotline-ai", async (req, res) => {
  // Redirect to Coco engine
  req.body.sessionId = req.body.sessionId || ('hotline_' + (req.session.userId||'anon') + '_' + Date.now());
  req.url = '/api/coco/hotline';
  return app._router.handle(Object.assign(req, { url:'/api/coco/hotline' }), res, ()=>{});
});


app.post("/api/support/email", async (req, res) => {
  try {
    const { subject, message, replyTo } = req.body;
    if (!message || !replyTo) return res.status(400).json({ success:false, message:"Thiếu nội dung hoặc email" });

    const ctx = await buildUserContext(req.session.userId);
    const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || "";
    const transporter = createEmailTransporter();

    // Gửi ticket xác nhận cho user
    if (transporter) {
      await transporter.sendMail({
        from: '"CRABOR Support 🦀" <' + process.env.EMAIL_USER + '>',
        to: replyTo,
        subject: "[CRABOR] Đã nhận yêu cầu hỗ trợ của bạn",
        html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">'
          + '<div style="background:#E8504A;padding:20px;border-radius:16px 16px 0 0;text-align:center">'
          + '<div style="font-size:2rem">🦀</div>'
          + '<div style="color:#fff;font-weight:900;font-size:1.1rem">CRABOR Support</div></div>'
          + '<div style="padding:20px;background:#f9f9f9">'
          + '<p style="color:#333">Xin chào <b>' + (ctx?.name||'bạn') + '</b>,</p>'
          + '<p>Chúng mình đã nhận được yêu cầu hỗ trợ của bạn:</p>'
          + '<div style="background:#fff;border-left:4px solid #E8504A;padding:12px;border-radius:4px;margin:12px 0;font-style:italic;color:#555">'
          + '"' + message.substring(0,200) + (message.length>200?'...':'') + '"</div>'
          + '<p>Đội hỗ trợ CRABOR sẽ phản hồi trong vòng <b>30 phút</b> (8h–22h hàng ngày).</p>'
          + '<p style="color:#888;font-size:.85rem">— CRABOR Tech Co., Ltd</p></div></div>',
      });
    }

    // AI tự động soạn reply nếu có API key
    let aiReply = null;
    if (CLAUDE_KEY) {
      try {
        const aiR = await axios.post("https://api.anthropic.com/v1/messages", {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          system: `Bạn là nhân viên hỗ trợ CRABOR. Soạn email trả lời khách hàng.
${ctx ? `Khách: ${ctx.name} | Chi tiêu: ${ctx.totalSpent.toLocaleString('vi-VN')}đ | Ví: ${ctx.walletBal.toLocaleString('vi-VN')}đ` : ''}
Quy tắc: lịch sự, xưng "CRABOR Support", giải quyết vấn đề cụ thể, tối đa 200 từ, viết bằng tiếng Việt.
Nếu không đủ thông tin để giải quyết → hẹn liên hệ lại trong 30 phút.`,
          messages: [{ role:'user', content:`Tiêu đề: ${subject||'Hỗ trợ'}
Nội dung: ${message}` }],
        }, { headers:{ "x-api-key":CLAUDE_KEY, "anthropic-version":"2023-06-01", "content-type":"application/json" }, timeout:12000 });
        aiReply = aiR.data.content?.[0]?.text;
      } catch(e) {}
    }

    // Gửi AI reply nếu soạn được
    if (aiReply && transporter) {
      await transporter.sendMail({
        from: '"Coco - CRABOR Support 🦀" <' + process.env.EMAIL_USER + '>',
        to: replyTo,
        subject: "Re: " + (subject||"Yêu cầu hỗ trợ"),
        html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">'
          + '<div style="background:#E8504A;padding:20px;border-radius:16px 16px 0 0;text-align:center">'
          + '<div style="font-size:2rem">🦀</div>'
          + '<div style="color:#fff;font-weight:900">CRABOR Support — Coco</div></div>'
          + '<div style="padding:20px;background:#f9f9f9">'
          + aiReply.split('\n').join('<br>')
          + '<br><br><hr><p style="color:#888;font-size:.8rem">Email này được soạn tự động bởi CRABOR AI. '
          + 'Nếu cần hỗ trợ thêm: support@crabor.vn</p></div></div>',
      });
    }

    // Notify admin
    req.io?.to('admin').emit('newSupportEmail', { from: replyTo, subject: subject||'Hỗ trợ', preview: message.substring(0,100), userId: req.session.userId });

    // Save ticket
    await SupportTicket.create({ userId: req.session.userId||null, phone: ctx?.phone, message: `[EMAIL] ${subject}: ${message}`, type:'general', status:'open' });

    res.json({ success:true, aiReply, message: aiReply ? "Đã phản hồi tự động qua email" : "Đã gửi email xác nhận. Đội hỗ trợ sẽ liên hệ sớm." });
  } catch(err) {
    console.error("[AI Email Support]", err.message);
    res.status(500).json({ success:false, message:err.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  COCO AI ENGINE ENDPOINTS
//  Không dùng Anthropic API — tất cả chạy nội bộ
// ══════════════════════════════════════════════════════════════

// POST /api/coco/chat — chat với Coco
app.post("/api/coco/chat", async (req, res) => {
  try {
    const { text, sessionId = "anon_"+Date.now() } = req.body;
    if (!text?.trim()) return res.status(400).json({ success:false });

    // Lấy user context
    let userCtx = {};
    if (req.session.userId) {
      const user = await User.findById(req.session.userId)
        .select('fullName phone totalSpent loyaltyPts walletBalance');
      if (user) userCtx = {
        name:       user.fullName || 'bạn',
        walletBal:  user.walletBalance||0,
        loyaltyPts: user.loyaltyPts||0,
        totalSpent: user.totalSpent||0,
        phone:      user.phone,
      };
    }

    // Get/create session memory
    let memory = await CocoMemory.findOne({ sessionId });
    if (!memory) memory = await CocoMemory.create({ sessionId, userId: req.session.userId||null });

    // Coco responds — dùng brain nếu có, fallback về rule-based
    let response;
    const brainResult = await cocoThink(
      [{ role:'user', content:text }],
      { userContext: userCtx, task:'chat', maxTokens:500 }
    );
    if (brainResult.canReason && brainResult.text) {
      response = { text: brainResult.text, intent: 'ai_reasoning', confidence: 0.95, backend: brainResult.backend };
    } else {
      response = await cocoRespond({ text, sessionId, userId: req.session.userId, userCtx });
    }

    // Save to memory
    memory.messages.push({ role:'user', text, intent: response.intent });
    memory.messages.push({ role:'coco', text: response.text, intent: response.intent });
    memory.turnCount++;
    memory.lastActive = new Date();
    if (memory.messages.length > 40) memory.messages = memory.messages.slice(-40);
    await memory.save();

    res.json({
      success: true,
      text: response.text,
      intent: response.intent,
      confidence: response.confidence,
    });
  } catch(err) {
    console.error("[Coco Chat]", err.message);
    res.status(500).json({ success:false, message:"Coco tạm thời gián đoạn" });
  }
});

// POST /api/coco/hotline — Tổng đài AI Coco (multi-turn với memory)
app.post("/api/coco/hotline", async (req, res) => {
  try {
    const { text, sessionId } = req.body;
    if (!text?.trim()) return res.status(400).json({ success:false });

    let userCtx = {};
    if (req.session.userId) {
      const user = await User.findById(req.session.userId).select('fullName phone totalSpent loyaltyPts walletBalance');
      if (user) userCtx = { name:user.fullName||'anh/chị', walletBal:user.walletBalance||0, loyaltyPts:user.loyaltyPts||0, phone:user.phone };
    }

    // Coco hotline — full reasoning mode nếu có
    let response;
    const hotlineBrain = await cocoThink(
      [{ role:'user', content:text }],
      { userContext:userCtx, task:'chat', temperature:0.7,
        systemPrompt: `Bạn là Coco, nhân viên tổng đài AI của CRABOR. Xưng "Coco" hoặc "em". Lịch sự, chuyên nghiệp, giải quyết vấn đề cụ thể. Tối đa 120 từ mỗi câu.${userCtx.name ? ' Khách hàng tên: '+userCtx.name+'.' : ''}${userCtx.walletBal !== undefined ? ' Số dư ví: '+userCtx.walletBal.toLocaleString('vi-VN')+'đ.' : ''}` }
    );
    if (hotlineBrain.canReason && hotlineBrain.text) {
      response = { text: hotlineBrain.text, intent: 'hotline_ai' };
    } else {
      response = await cocoRespond({ text, sessionId, userId:req.session.userId, userCtx });
    }

    // Thêm tông giọng tổng đài
    let finalText = response.text;
    if (response.intent === 'unknown') {
      finalText = `Em đã ghi nhận yêu cầu của ${userCtx.name||'anh/chị'} ạ. Đội kỹ thuật sẽ phản hồi trong 30 phút. Anh/chị có cần hỗ trợ thêm gì không ạ?`;
    }

    res.json({ success:true, text:finalText, intent:response.intent });
  } catch(err) {
    res.status(500).json({ success:false, message:"Tổng đài Coco tạm thời gián đoạn ạ" });
  }
});

// POST /api/coco/learn/url — Coco học từ URL
app.post("/api/coco/learn/url", adminAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success:false });
    // Queue URL for learning
    const log = await CocoLearnLog.create({ type:'web', source:url, content:'', status:'pending' });
    // Process immediately
    const fetched = await CocoTools.webFetch(url);
    if (!fetched.success) return res.status(400).json({ success:false, message:"Không tải được: "+fetched.error });

    const extracted = CocoTools.extractKnowledge(fetched.content, 'web:'+url);
    const ids = [];
    for (const fact of extracted.slice(0, 15)) {
      const r = await CocoTools.learnFact({ ...fact, category:'web' });
      ids.push(r.id);
    }
    await CocoLearnLog.findByIdAndUpdate(log._id, { status:'processed', content:fetched.content.substring(0,500), knowledgeIds:ids });
    res.json({ success:true, url, title:fetched.title, extracted:extracted.length, saved:ids.length });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/coco/learn/document — Coco học từ văn bản/tài liệu
app.post("/api/coco/learn/document", adminAuth, async (req, res) => {
  try {
    const { content, title, category='document' } = req.body;
    if (!content) return res.status(400).json({ success:false });
    const extracted = CocoTools.extractKnowledge(content, 'doc:'+title);
    const ids = [];
    for (const fact of extracted.slice(0,20)) {
      const r = await CocoTools.learnFact({ ...fact, category });
      ids.push(r.id);
    }
    const log = await CocoLearnLog.create({ type:'document', source:title||'unknown', content:content.substring(0,500), extracted, knowledgeIds:ids, status:'processed' });
    res.json({ success:true, extracted:extracted.length, saved:ids.length });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/coco/learn/fact — Thêm knowledge thủ công
app.post("/api/coco/learn/fact", adminAuth, async (req, res) => {
  try {
    const { intent, keywords, answer, category='faq', confidence=1.0 } = req.body;
    if (!intent||!answer) return res.status(400).json({ success:false, message:'Cần intent + answer' });
    const kws = Array.isArray(keywords) ? keywords : (keywords||'').split(',').map(k=>k.trim().toLowerCase());
    const r = await CocoTools.learnFact({ intent, keywords:kws, answer, category, confidence, source:'manual' });
    res.json({ success:true, ...r });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/coco/feedback — User đánh giá câu trả lời
app.post("/api/coco/feedback", async (req, res) => {
  try {
    const { knowledgeId, helpful } = req.body;
    if (!knowledgeId) return res.status(400).json({ success:false });
    await CocoKnowledge.findByIdAndUpdate(knowledgeId, {
      $inc: helpful ? { helpful:1 } : { notHelpful:1 }
    });
    // Nếu nhiều feedback xấu → giảm confidence
    const k = await CocoKnowledge.findById(knowledgeId);
    if (k && k.notHelpful > k.helpful + 3) {
      await CocoKnowledge.findByIdAndUpdate(knowledgeId, { $inc:{ confidence:-0.1 }, $min:{ confidence:0.1 } });
    }
    res.json({ success:true });
  } catch(err) { res.status(500).json({ success:false }); }
});

// GET /api/coco/knowledge — xem toàn bộ knowledge (admin)
app.get("/api/coco/knowledge", adminAuth, async (req, res) => {
  try {
    const { category, search, page=1 } = req.query;
    const filter = { active:true };
    if (category) filter.category = category;
    if (search) filter.$text = { $search: search };
    const total = await CocoKnowledge.countDocuments(filter);
    const docs  = await CocoKnowledge.find(filter).sort({ useCount:-1, confidence:-1 }).skip((page-1)*20).limit(20);
    res.json({ success:true, total, page:Number(page), data:docs });
  } catch(err) { res.status(500).json({ success:false }); }
});

// GET /api/coco/stats — thống kê brain
app.get("/api/coco/stats", adminAuth, async (req, res) => {
  try {
    const [total, byCategory, topUsed, unanswered, learnLogs] = await Promise.all([
      CocoKnowledge.countDocuments({ active:true }),
      CocoKnowledge.aggregate([{ $group:{ _id:'$category', count:{$sum:1} } }]),
      CocoKnowledge.find({ active:true }).sort({ useCount:-1 }).limit(5).select('intent answer useCount'),
      CocoLearnLog.countDocuments({ status:'pending' }),
      CocoLearnLog.countDocuments({ type:'web', status:'processed' }),
    ]);
    const memories = await CocoMemory.countDocuments();
    const totalTurns = await CocoMemory.aggregate([{ $group:{ _id:null, total:{$sum:'$turnCount'} } }]);
    res.json({ success:true, brain:{ total, byCategory, topUsed }, sessions:{ memories, turns:totalTurns[0]?.total||0 }, pending:{ unanswered, learnLogs } });
  } catch(err) { res.status(500).json({ success:false }); }
});

// DELETE /api/coco/knowledge/:id — xóa knowledge
app.delete("/api/coco/knowledge/:id", adminAuth, async (req, res) => {
  try {
    await CocoKnowledge.findByIdAndUpdate(req.params.id, { active:false });
    res.json({ success:true });
  } catch(err) { res.status(500).json({ success:false }); }
});


// ══════════════════════════════════════════════════════════════
//  COCO OPS ENDPOINTS — Admin & System
// ══════════════════════════════════════════════════════════════

// GET /api/coco/ops/stats — brain ops stats
app.get("/api/coco/ops/stats", adminAuth, async (req,res) => {
  try {
    const [patterns, decisions, notifs, campaigns] = await Promise.all([
      CocoPattern.countDocuments(),
      CocoDecision.countDocuments({ createdAt:{ $gt: new Date(Date.now()-24*3600*1000) } }),
      CocoNotif.countDocuments({ status:'pending' }),
      CocoCampaign.countDocuments({ status:'active' }),
    ]);
    const insights = await LearningEngine.analyzePatterns();
    const marginData = await PricingAI.analyzeMargin(7);
    res.json({ success:true, patterns, decisions24h:decisions, pendingNotifs:notifs, activeCampaigns:campaigns, insights, marginData });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/coco/ops/pricing — giá ship theo giờ hiện tại
app.get("/api/coco/ops/pricing", async (req,res) => {
  try {
    const { distance=3, total=0 } = req.query;
    const result = await PricingAI.calcShipFee({ distanceKm:Number(distance), orderTotal:Number(total) });
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ success:false }); }
});

// POST /api/coco/ops/dispatch — chọn shipper cho đơn
app.post("/api/coco/ops/dispatch", adminAuth, async (req,res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success:false });
    const availableShippers = await Shipper.find({ isOnline:true, status:'approved' }).select('_id fullName rating tier currentDistrict todayOrders');
    const best = await DispatchAI.selectShipper(order, availableShippers);
    res.json({ success:true, selectedShipper:best, candidates:availableShippers.length });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/coco/ops/fraud/check — kiểm tra đơn hàng
app.post("/api/coco/ops/fraud/check", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    const user  = await User.findById(req.session.userId).select('createdAt totalSpent');
    if (!order || !user) return res.status(404).json({ success:false });
    const result = await FraudAI.analyzeOrder(order, user);
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ success:false }); }
});

// POST /api/coco/ops/voucher/check — kiểm tra abuse voucher
app.post("/api/coco/ops/voucher/check", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const { code } = req.body;
    const result = await FraudAI.checkVoucherAbuse(req.session.userId, code);
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ success:false }); }
});

// GET /api/coco/ops/growth/recommend — gợi ý cho user
app.get("/api/coco/ops/growth/recommend", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const recs = await GrowthAI.recommendFood(req.session.userId);
    res.json({ success:true, ...recs });
  } catch(e) { res.status(500).json({ success:false }); }
});

// POST /api/coco/ops/campaign/plan — Coco lên kế hoạch voucher
app.post("/api/coco/ops/campaign/plan", adminAuth, async (req,res) => {
  try {
    const { budget = 5000000 } = req.body;
    const plan = await GrowthAI.planVoucherCampaign(Number(budget));
    res.json({ success:true, ...plan });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/coco/ops/campaign/activate — kích hoạt campaign Coco đề xuất
app.post("/api/coco/ops/campaign/activate", adminAuth, async (req,res) => {
  try {
    const campaigns = req.body.campaigns || [];
    const created = [];
    for (const c of campaigns) {
      const campaign = await CocoCampaign.create({ ...c, status:'active' });
      // Tạo vouchers thật theo config
      const batchSize = Math.floor(c.budget / (c.voucherConfig?.value||20000));
      for (let i=0; i<Math.min(batchSize,100); i++) {
        const code = 'COCO'+Date.now().toString(36).toUpperCase()+i;
        await Voucher.create({
          code, type:c.voucherConfig.type, value:c.voucherConfig.value,
          minOrder: c.voucherConfig.minOrder||0,
          maxDiscount: c.voucherConfig.maxDiscount,
          usageLimit:1, expiresAt:c.endAt, active:true,
          description:`[Coco Campaign] ${c.name}`,
        });
      }
      created.push(campaign._id);
    }
    res.json({ success:true, created:created.length });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/coco/ops/notify/broadcast — Coco broadcast tới tất cả users
app.post("/api/coco/ops/notify/broadcast", adminAuth, async (req,res) => {
  try {
    const { title, body, targetType='broadcast', segment } = req.body;
    const notif = await CocoNotif.create({
      targetType: targetType==='broadcast'?'broadcast':'user',
      title, body, scheduledAt:new Date(), source:'admin_via_coco',
    });
    // Emit ngay
    req.io.emit('cocoNotification', { title, body, data:{ type:'broadcast' } });
    res.json({ success:true, notifId:notif._id, message:'Đã gửi thông báo tới tất cả user online' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/coco/ops/approve/queue — xem hàng chờ duyệt
app.get("/api/coco/ops/approve/queue", adminAuth, async (req,res) => {
  try {
    const [partners, shippers] = await Promise.all([
      FoodPartner.find({ status:'pending' }).limit(20).select('bizName phone createdAt'),
      Shipper.find({ status:{$in:['pending','pending_review']} }).limit(20).select('fullName phone feePaid createdAt'),
    ]);
    res.json({ success:true, partners, shippers, total:partners.length+shippers.length });
  } catch(e) { res.status(500).json({ success:false }); }
});

// POST /api/coco/ops/approve/run — chạy batch approve ngay
app.post("/api/coco/ops/approve/run", adminAuth, async (req,res) => {
  try {
    const result = await AutoApproveAI.batchReview(req.io);
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/coco/ops/feedback/decision — feedback cho decision AI
app.post("/api/coco/ops/feedback/decision", adminAuth, async (req,res) => {
  try {
    const { decisionId, feedback } = req.body;
    await LearningEngine.feedbackDecision(decisionId, feedback);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false }); }
});


// ══════════════════════════════════════════════════════════════
//  COCO BRAIN ENDPOINTS
// ══════════════════════════════════════════════════════════════

// GET /api/coco/brain/status — kiểm tra brain backend
app.get("/api/coco/brain/status", adminAuth, async (req,res) => {
  try {
    const status = await checkBrainStatus();
    res.json({ success:true, ...status });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/coco/brain/reason — gọi reasoning engine trực tiếp (admin/dev)
app.post("/api/coco/brain/reason", adminAuth, async (req,res) => {
  try {
    const { messages, task, systemPrompt, temperature, maxTokens } = req.body;
    if (!messages?.length) return res.status(400).json({ success:false });
    const result = await cocoThink(messages, { task, systemPrompt, temperature, maxTokens });
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/coco/brain/analyze-complaint — phân tích khiếu nại
app.post("/api/coco/brain/analyze-complaint", async (req,res) => {
  try {
    const { complaint } = req.body;
    if (!complaint) return res.status(400).json({ success:false });
    let userCtx = {};
    if (req.session.userId) {
      const user = await User.findById(req.session.userId).select('fullName totalSpent loyaltyPts walletBalance');
      if (user) userCtx = { name:user.fullName, totalSpent:user.totalSpent||0, walletBal:user.walletBalance||0 };
    }
    const result = await CocoReasoning.handleComplaint(complaint, [], userCtx);
    res.json({ success:true, analysis: result.text || "Đã ghi nhận khiếu nại, sẽ xử lý trong 30 phút.", backend: result.backend });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/coco/brain/document — Coco đọc và học từ tài liệu dài (với reasoning)
app.post("/api/coco/brain/document", adminAuth, async (req,res) => {
  try {
    const { content, title } = req.body;
    if (!content) return res.status(400).json({ success:false });
    // Dùng reasoning để tóm tắt thay vì chỉ extract keywords
    const summary = await CocoReasoning.summarizeDocument(content);
    // Lưu summary vào knowledge base
    if (summary.text) {
      const { CocoTools } = require('./coco-engine');
      const facts = summary.text.split('\n').filter(l=>l.trim().startsWith('-')||l.trim().startsWith('•'));
      for (const fact of facts.slice(0,10)) {
        const clean = fact.replace(/^[-•]\s*/,'').trim();
        if (clean.length > 20) {
          await CocoTools.learnFact({ intent:'general', keywords:clean.toLowerCase().split(' ').filter(w=>w.length>3).slice(0,6), answer:clean, category:'document', source:'ai_summary:'+title, confidence:0.8 });
        }
      }
    }
    res.json({ success:true, summary:summary.text, backend:summary.backend });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/coco/brain/campaign-plan — AI lên kế hoạch campaign thông minh
app.post("/api/coco/brain/campaign-plan", adminAuth, async (req,res) => {
  try {
    const { budget=5000000 } = req.body;
    const { PricingAI, GrowthAI } = cocoOps;
    const [metrics, segments] = await Promise.all([
      PricingAI.analyzeMargin(7),
      GrowthAI.segmentUsers(),
    ]);
    // Kết hợp: rule-based plan + AI reasoning
    const rulePlan = await GrowthAI.planVoucherCampaign(Number(budget));
    const aiReason = await CocoReasoning.planCampaign(metrics, Number(budget), segments.stats);
    res.json({ success:true, rulePlan, aiInsight: aiReason.text || null, backend: aiReason.backend });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});


// ══════════════════════════════════════════════════════════════
//  NOVA OPERATIONS ENDPOINTS
// ══════════════════════════════════════════════════════════════

// GET /api/nova/health — system health report
app.get("/api/nova/health", adminAuth, async (req,res) => {
  try {
    const report = await SystemHealth.fullReport();
    res.json({ success:true, ...report });
  } catch(e) { res.status(500).json({ success:false }); }
});

// GET /api/nova/revenue — revenue intelligence
app.get("/api/nova/revenue", adminAuth, async (req,res) => {
  try {
    const days = Number(req.query.days) || 7;
    const summary = await RevenueIntel.summary(days);
    const anomalies = await RevenueIntel.detectAnomalies();
    res.json({ success:true, summary, anomalies });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/nova/metrics — metrics snapshot lịch sử
app.get("/api/nova/metrics", adminAuth, async (req,res) => {
  try {
    const metrics = await NovaMetric.find({ type:'hourly' }).sort({createdAt:-1}).limit(24);
    res.json({ success:true, data:metrics });
  } catch(e) { res.status(500).json({ success:false }); }
});

// GET /api/nova/sla — SLA status
app.get("/api/nova/sla", adminAuth, async (req,res) => {
  try {
    const now = new Date();
    const [active, breached, ok] = await Promise.all([
      NovaSLA.countDocuments({ completedAt:{$exists:false}, breached:false }),
      NovaSLA.countDocuments({ breached:true, completedAt:{$exists:false} }),
      NovaSLA.countDocuments({ completedAt:{$exists:true}, breached:false, createdAt:{$gt:new Date(Date.now()-86400000)} }),
    ]);
    const atRisk = await NovaSLA.find({
      expectedAt: { $lt: new Date(Date.now() + 10*60000), $gt: now },
      completedAt: { $exists:false },
      breached: false,
    }).limit(10).select('orderId module expectedAt');
    res.json({ success:true, active, breached, completedToday:ok, atRisk });
  } catch(e) { res.status(500).json({ success:false }); }
});

// POST /api/nova/dispatch/run — trigger manual auto-dispatch
app.post("/api/nova/dispatch/run", adminAuth, async (req,res) => {
  try {
    const assigned = await DispatchIntel.runAutoDispatch(req.io);
    res.json({ success:true, assigned, message:`Nova đã gán ${assigned} đơn cho shipper` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/nova/partner/:id/status — check partner load + ETA
app.get("/api/nova/partner/:id/status", async (req,res) => {
  try {
    const status = await InventoryIntel.checkPartnerStatus(req.params.id);
    res.json({ success:true, ...status });
  } catch(e) { res.status(500).json({ success:false }); }
});

// GET /api/nova/onboarding/:type/:id — xem tiến độ onboarding
app.get("/api/nova/onboarding/:type/:id", async (req,res) => {
  try {
    const step = await OnboardingFlow.getNextStep(req.params.id, req.params.type);
    res.json({ success:true, ...step });
  } catch(e) { res.status(500).json({ success:false }); }
});

// POST /api/nova/chat — Nova chat với admin (business insights)
app.post("/api/nova/chat", adminAuth, async (req,res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ success:false });
    // Get business context for Nova
    const [revenue, health, sla] = await Promise.all([
      RevenueIntel.summary(7),
      SystemHealth.getSnapshot(),
      NovaSLA.countDocuments({ breached:true, completedAt:{$exists:false} }),
    ]);
    const context = `Revenue 7 ngày: ${revenue.totalRevenue?.toLocaleString('vi-VN')}đ (${revenue.totalOrders} đơn). Health: ${health.status}. SLA breach đang xử lý: ${sla}.`;
    const result = await cocoThink(
      [{ role:'user', content:text }],
      {
        task: 'dispatch',
        systemPrompt: NOVA_SYSTEM_PROMPT + '\n\nDỮ LIỆU HIỆN TẠI:\n' + context,
        maxTokens: 500,
      }
    );
    res.json({ success:true, text: result.text || "Nova đang ở mode rule-based. Set COCO_BRAIN=groq để bật AI.", backend: result.backend });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/nova/decisions — lịch sử quyết định của Nova
app.get("/api/nova/decisions", adminAuth, async (req,res) => {
  try {
    const decisions = await NovaDecision.find().sort({createdAt:-1}).limit(50);
    res.json({ success:true, data:decisions });
  } catch(e) { res.status(500).json({ success:false }); }
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

    const result = await speedSmsSendOtp(phone);

    res.json({
      success: true, message: "OTP đã gửi",
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

    const approved = speedSmsCheckOtp(phone, otp);
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

    // When delivered → credit referral rewards + loyalty points + update shipper stats
    if (status === "delivered") {
      // Reward sales referral for customer
      if (order.customerId) {
        await processReferralReward(order.customerId, "user", req.io);
        // Earn loyalty points (1pt per 10k spent)
        await earnLoyaltyPoints(order.customerId, order.finalTotal || order.total || 0);
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

// GET /api/map/directions — proxy Goong Directions (ẩn API key)
app.get("/api/map/directions", async (req, res) => {
  try {
    const { origin, destination, vehicle = "motorbike" } = req.query;
    if (!origin || !destination)
      return res.status(400).json({ success: false, message: "Thiếu origin hoặc destination" });
    const key = GOONG_API_KEY || process.env.GOONG_API_KEY;
    if (!key) return res.status(500).json({ success: false, message: "Chưa cấu hình GOONG_API_KEY" });
    const url = `https://rsapi.goong.io/Direction?origin=${origin}&destination=${destination}&vehicle=${vehicle}&api_key=${key}`;
    const r = await axios.get(url, { timeout: 10000 });
    res.json(r.data);
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/map/geocode — proxy Goong Geocoding
app.get("/api/map/geocode", async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ success: false });
    const key = GOONG_API_KEY || process.env.GOONG_API_KEY;
    const url = `https://rsapi.goong.io/geocode?address=${encodeURIComponent(address)}&api_key=${key}`;
    const r = await axios.get(url, { timeout: 8000 });
    res.json(r.data);
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/map/places — proxy Goong Autocomplete (tìm địa chỉ)
app.get("/api/map/places", async (req, res) => {
  try {
    const { input, location } = req.query;
    if (!input) return res.status(400).json({ success: false });
    const key = GOONG_API_KEY || process.env.GOONG_API_KEY;
    let url = `https://rsapi.goong.io/Place/AutoComplete?input=${encodeURIComponent(input)}&api_key=${key}`;
    if (location) url += `&location=${location}`;
    const r = await axios.get(url, { timeout: 8000 });
    res.json(r.data);
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


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
    const pass = process.env.ADMIN_DEFAULT_PASS || "admin123";
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
