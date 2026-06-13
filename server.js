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
const nodemailer  = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");
const cron = require("node-cron");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
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

// ── Helper: build signed session cookie (đúng format express-session) ──────
// express-session dùng cookie-signature: s:<id>.<base64url(hmac-sha256(id,secret))>
// Thiếu signature → server reject cookie → 401 ngay sau login
function buildSignedSessionCookie(sessionId) {
  try {
    const crypto = require('crypto');
    const secret = process.env.SESSION_SECRET || 'crabor-session-secret-2025';
    // FIX: phải hash 's:' + sessionId (đúng theo cookie-signature module)
    // Sai cũ: hmac(sessionId) → signature không khớp → session bị reject → 401
    const val = 's:' + sessionId;
    const sig = crypto.createHmac('sha256', secret).update(val).digest('base64').replace(/=+$/g, '');
    const signed = val + '.' + sig;
    return 'connect.sid=' + encodeURIComponent(signed);
  } catch(e) {
    console.error('[buildSignedSessionCookie] Error:', e);
    return '';
  }
}

// ── Helper: load session từ MongoDB bằng X-Session-ID (dùng khi cookie signature fail) ──
async function loadSessionFromHeader(req) {
  if (req.session?.shipperId || req.session?.userId || req.session?.adminId) return; // đã có session
  const xSid = req.headers['x-session-id'];
  if (!xSid || xSid.length < 10) return;
  try {
    const sessionDoc = await mongoose.connection.db
      .collection('sessions').findOne({ _id: xSid });
    if (!sessionDoc) return;
    const sess = typeof sessionDoc.session === 'string'
      ? JSON.parse(sessionDoc.session) : sessionDoc.session;
    if (sess.shipperId) { req.session.shipperId = sess.shipperId; req.session.userPhone = sess.userPhone; req.session.role = 'shipper'; }
    else if (sess.userId) { req.session.userId = sess.userId; req.session.role = sess.role; }
    else if (sess.adminId) { req.session.adminId = sess.adminId; req.session.role = 'admin'; }
    console.log('[SessionFallback] Loaded from X-Session-ID:', xSid.substring(0,8) + '... role:', req.session.role);
  } catch(e) { console.error('[SessionFallback] Error:', e.message); }
}

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
    startCronJobs();
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

    // ── Seed test accounts cho 3 apps ─────────────────────────
    try {
      const bcrypt = require("bcryptjs");
      const hash   = await bcrypt.hash("Crabor@2025", 10);

      // 1. Customer admin test account
      const existCust = await User.findOne({ phone: "0999999999" });
      if (!existCust) {
        await User.create({
          phone: "0999999999", email: "admin@crabor.vn",
          fullName: "CRABOR Admin", password: hash,
          role: "admin", isAdmin: true, status: "active",
          totalOrders: 999, totalSpent: 99000000,
          walletBalance: 10000000,
          profileComplete: true,
        });
        console.log("[OK] Customer test account: 0999999999 / Crabor@2025");
      }

      // 2. Shipper admin test account
      const existShipper = await Shipper.findOne({ phone: "0888888888" });
      if (!existShipper) {
        await Shipper.create({
          phone: "0888888888", fullName: "CRABOR Shipper Test",
          email: "shipper@crabor.vn", password: hash,
          idCard: "079099999999", vehicleType: "bike", vehiclePlate: "51G-999.99",
          status: "approved", online: true, isAccepting: true,
          walletBalance: 5000000, totalEarnings: 50000000,
          district: "Quận 1",
        });
        console.log("[OK] Shipper test account: 0888888888 / Crabor@2025");
      }

      // 3. Partner (FoodPartner) admin test account
      const existPartner = await FoodPartner.findOne({ phone: "0777777777" });
      if (!existPartner) {
        await FoodPartner.create({
          phone: "0777777777", bizName: "CRABOR Test Restaurant",
          email: "partner@crabor.vn", password: hash,
          address: "123 Nguyễn Huệ, Q1, TP.HCM",
          district: "Quận 1", status: "approved",
          isAccepting: true, walletBalance: 5000000,
        });
        console.log("[OK] Partner test account: 0777777777 / Crabor@2025");
      }
    } catch(e) { console.error("[WARN] Seed test accounts:", e.message); }
  })
  .catch(err => { console.error("[ERR] MongoDB error:", err.message); process.exit(1); });

// ==========================================
//  2. MIDDLEWARE
// ==========================================
app.use(cors({
  origin: true,              // reflect origin thay vì * để credentials hoạt động
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Cookie','X-Session-ID'],
  exposedHeaders: ['Set-Cookie'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Middleware: mobile client gửi X-Session-ID header → inject vào cookie ──
// Giải pháp bền vững: không phụ thuộc vào client tự build signed cookie
app.use((req, res, next) => {
  const xSessionId = req.headers['x-session-id'];
  if (xSessionId && xSessionId.length > 10 && !req.headers.cookie?.includes('connect.sid')) {
    try {
      const crypto = require('crypto');
      const secret = process.env.SESSION_SECRET || 'crabor-session-secret-2025';
      const val = 's:' + xSessionId;
      const sig = crypto.createHmac('sha256', secret).update(val).digest('base64').replace(/=+$/g, '');
      const signed = val + '.' + sig;
      const cookieStr = 'connect.sid=' + encodeURIComponent(signed);
      req.headers.cookie = (req.headers.cookie ? req.headers.cookie + '; ' : '') + cookieStr;
      console.log('[XSession] Injected session from X-Session-ID:', xSessionId.substring(0, 8) + '...');
    } catch(e) {
      console.error('[XSession] Error:', e.message);
    }
  }
  next();
});

// Session (dùng cho app core: customer / shipper / partner interfaces)
app.use(session({
  secret: process.env.SESSION_SECRET || "crabor-session-secret-2025",
  resave: true,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'crabor', collectionName: 'sessions', ttl: 7 * 24 * 60 * 60 }),
  cookie: {
    secure: false,          // mobile app không dùng HTTPS proxy
    httpOnly: true,
    sameSite: 'lax',        // cross-origin requests từ mobile
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 ngày
  }
}));

// Session logging middleware (for debugging shipper auth)
app.use((req, res, next) => {
  if (req.path.includes('/api/shipper/')) {
    console.log('[Session Debug] Path:', req.path);
    console.log('[Session Debug] Session ID:', req.session?.id);
    console.log('[Session Debug] ShipperId:', req.session?.shipperId);
    console.log('[Session Debug] Role:', req.session?.role);
  }
  next();
});

// Track requests for Nova SystemHealth
app.use((req,res,next)=>{ res.on("finish",()=>SystemHealth.recordRequest(res.statusCode>=500)); next(); });

// Static files
app.use(express.static(path.join(__dirname, "public")));

// Đưa io vào req để dùng trong route handlers
app.use((req, res, next) => { req.io = io; next(); });
global._io = io; // cho cron job dùng

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


  // Shipper join room riêng
  socket.on("join_shipper", (shipperId) => {
    if (shipperId) {
      socket.join(`shipper_${shipperId}`);
      console.log(`🛵 Shipper ${shipperId} joined room`);
    }
  });

  // Shipper join broadcast room (nhận ride requests)
  socket.on("join_shipper_broadcast", () => {
    socket.join("shipper_broadcast");
  });

  // Partner join room riêng
  socket.on("join_partner", (partnerId) => {
    if (partnerId) {
      socket.join(`partner_${partnerId}`);
      console.log(`🏪 Partner ${partnerId} joined room`);
    }
  });

  // Customer join room riêng
  socket.on("join_customer", (customerId) => {
    if (customerId) {
      socket.join(`customer_${customerId}`);
    }
  });

  // Shipper cập nhật vị trí realtime qua socket
  socket.on("shipper_location_update", async ({ shipperId, lat, lng, orderId }) => {
    if (!shipperId) return;
    try {
      await Shipper.findByIdAndUpdate(shipperId, { location: { lat, lng }, lastLocationAt: new Date() });
      if (orderId) {
        io.to(`order_${orderId}`).emit("shipperLocation", { lat, lng, orderId, shipperId });
      }
    } catch (e) {}
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
  isAdmin:         { type: Boolean, default: false },
  password:        { type: String },   // hashed — cho form login
  status:          { type: String, enum: ["active","banned"], default: "active" },
  totalOrders:     { type: Number, default: 0, min: 0 },
  totalSpent:      { type: Number, default: 0, min: 0 },
  loyaltyPts:      { type: Number, default: 0, min: 0 },
  walletBalance:   { type: Number, default: 0, min: 0 },
  googleId:        { type: String, unique: true, sparse: true },
  avatar:          { type: String },
  authMethod:      { type: String, enum: ["otp","google","form"], default: "otp" },
  password:        { type: String },            // bcrypt hash — form auth
  emailVerified:   { type: Boolean, default: false },
  walletEarned:    { type: Number, default: 0, min: 0 },   // tổng tiền đã nhận vào ví
  fcmToken:        String,
  pushToken:       { type: String, default: null },
  pushPlatform:    { type: String, default: null },  // 'ios' | 'android'
  pushUpdatedAt:   { type: Date,   default: null },
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
  paymentMethod:{ type: String, enum: ["cash","momo","zalopay","bank","payos","sepay","bank_transfer","wallet","vnpay"], default: "cash" },
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
  location:        { lat: { type: Number }, lng: { type: Number } },
  lastLocationAt:  Date,
  heading:         { type: Number, default: 0 },
  speed:           { type: Number, default: 0 },
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
  password:    { type: String },   // bcrypt hash — form login
  pushToken:   { type: String },
  pushPlatform:{ type: String },
  pushUpdatedAt: Date,
  fcmToken:    { type: String },
  tier:        { type: String, default: 'bronze' },
  preferences: { type: mongoose.Schema.Types.Mixed, default: {} },
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
  password:     { type: String },   // bcrypt hash — password login
};

// ── GIẶT LÀ ──────────────────────────────
const giatLaSchema = new mongoose.Schema({
  ...partnerBase,
  bizName:     { type: String, required: true, trim: true, maxlength: 200 },
  bizYear:     { type: Number, min: 1990, max: new Date().getFullYear() },
  services:    [{ type: String, trim: true }],
  pricePerKg:  { type: Number, min: 0 },
  capacity:    { type: Number, min: 0 },
  turnaround:  { type: String, trim: true },
  openTime:    { type: String, trim: true },
  closeTime:   { type: String, trim: true },
  documents:   { cccdFront: String, cccdBack: String, shopFront: String, shopInside: String },
  isAccepting: { type: Boolean, default: true },
  pushToken:   String, pushPlatform: String,
  walletBalance: { type: Number, default: 0 },
  walletHistory: [{ type: Object }],
  totalSales:  { type: Number, default: 0 },
  lastLat: Number, lastLng: Number, lastLocationAt: Date,
  // Gói giặt là do partner tự thiết lập
  packages: [{
    id:          String,
    name:        String,   // VD: "Giặt + Sấy nhanh 5h"
    description: String,
    pricePerKg:  Number,   // giá/kg
    minKg:       Number,   // kg tối thiểu
    turnaround:  String,   // "5h" | "10h" | "24h"
    available:   { type: Boolean, default: true },
  }],
  rating:     { type: Number, default: 5.0 },
  totalOrders:{ type: Number, default: 0 },
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
  isAccepting: { type: Boolean, default: true },
  lastLat:     Number,
  lastLng:     Number,
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
  const MAP = {
    // short codes từ backend cũ
    gl: "giat_la", gv: "giup_viec", cs: "china_shop", fd: "food_partner", rx: "ride_driver",
    // hash values từ register.html
    laundry: "giat_la", cleaning: "giup_viec", shop: "china_shop",
    food: "food_partner", partner: "food_partner",
    shipper: "ride_driver", rider: "ride_driver",
  };
  return MAP[fe] || MAP[String(fe).toLowerCase()] || fe;
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
const resetTokenStore = new Map(); // { token → { userId, userType, expiry } }

// Dọn expired OTPs mỗi 10 phút
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore) { if (v.expiry < now) otpStore.delete(k); }
}, 10 * 60 * 1000);

// Gửi OTP qua SpeedSMS

// ══════════════════════════════════════════════════════════════
//  SURGE PRICING & PUSH NOTIFICATION HELPERS
//  (tích hợp từ cron.js + push_route.js)
// ══════════════════════════════════════════════════════════════

const SURGE_PERIODS = [
  { startH: 11, endH: 12, label: 'trưa' },
  { startH: 19, endH: 20, label: 'tối'  },
];
const SURGE_MULTIPLIER = 1.5;

function getSurgeMultiplier() {
  const h = new Date().getHours();
  const isSurge = SURGE_PERIODS.some(p => h >= p.startH && h < p.endH);
  return { multiplier: isSurge ? SURGE_MULTIPLIER : 1.0, isSurge };
}

function calcDeliveryFee(baseFee) {
  const { multiplier } = getSurgeMultiplier();
  return Math.round(baseFee * multiplier);
}

async function getAllPushTokens() {
  const users = await User.find({ pushToken: { $ne: null } }, { pushToken: 1 });
  return users.map(u => u.pushToken).filter(t => t && Expo.isExpoPushToken(t));
}

async function sendPushToUsers(tokens, title, body, data = {}) {
  const valid = tokens.filter(t => Expo.isExpoPushToken(t));
  if (!valid.length) return 0;
  const messages = valid.map(to => ({ to, title, body, data, sound: 'default', badge: 1 }));
  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  for (const chunk of chunks) {
    try {
      const res = await expo.sendPushNotificationsAsync(chunk);
      sent += chunk.length;
    } catch(e) { console.error('[Push]', e.message); }
  }
  console.log('[Push] Sent ' + sent + '/' + valid.length + ': "' + title + '"');
  return sent;
}

// ══════════════════════════════════════════════════════════════
//  CRON JOBS — Surge notifications + Promos (Asia/Ho_Chi_Minh)
// ══════════════════════════════════════════════════════════════

function startCronJobs() {
  // 10:45 — Cảnh báo trước giờ cao điểm trưa 15 phút
  cron.schedule("45 10 * * 1-7", async () => {
    try {
      const tokens = await getAllPushTokens();
      await sendPushToUsers(tokens, "⚡ Sắp vào giờ cao điểm!", "Đặt đồ ăn ngay trước 11h để được phí ship bình thường nhé! 🍜", { type: "surge_warning", screen: "Food" });
    } catch(e) { console.error("[Cron] 10:45", e.message); }
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 11:00 — Giờ cao điểm trưa bắt đầu
  cron.schedule("0 11 * * 1-7", async () => {
    try {
      const tokens = await getAllPushTokens();
      await sendPushToUsers(tokens, "🔥 Giờ cao điểm trưa!", "Phí ship tăng 50% từ 11h-12h. Đặt ngay kẻo lỡ! 🍜", { type: "surge_start", screen: "Food" });
    } catch(e) { console.error("[Cron] 11:00", e.message); }
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 18:45 — Cảnh báo trước giờ cao điểm tối
  cron.schedule("45 18 * * 1-7", async () => {
    try {
      const tokens = await getAllPushTokens();
      await sendPushToUsers(tokens, "⚡ Sắp vào giờ cao điểm tối!", "Đặt bữa tối trước 19h để tiết kiệm phí ship! 🌙", { type: "surge_warning", screen: "Food" });
    } catch(e) { console.error("[Cron] 18:45", e.message); }
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 19:00 — Giờ cao điểm tối bắt đầu
  cron.schedule("0 19 * * 1-7", async () => {
    try {
      const tokens = await getAllPushTokens();
      await sendPushToUsers(tokens, "🌙 Giờ cao điểm tối bắt đầu!", "Phí ship tăng 50% từ 19h-20h. Đặt ngay! 🍜", { type: "surge_start", screen: "Food" });
    } catch(e) { console.error("[Cron] 19:00", e.message); }
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 20:00 — Hết giờ cao điểm
  cron.schedule("0 20 * * 1-7", async () => {
    try {
      const tokens = await getAllPushTokens();
      await sendPushToUsers(tokens, "✅ Hết giờ cao điểm!", "Phí ship đã về bình thường. Đặt đồ ăn tối ngay! 🍽️", { type: "surge_end", screen: "Food" });
    } catch(e) { console.error("[Cron] 20:00", e.message); }
  }, { timezone: "Asia/Ho_Chi_Minh" });

  // 09:00 Thứ 2 — Promo đầu tuần
  cron.schedule("0 9 * * 1", async () => {
    try {
      const tokens = await getAllPushTokens();
      await sendPushToUsers(tokens, "🎉 Khuyến mãi đầu tuần!", "Giảm 20% phí ship cho đơn từ 50k! Đặt ngay 🦀", { type: "weekly_promo", screen: "Food" });
    } catch(e) { console.error("[Cron] Monday promo", e.message); }
  }, { timezone: "Asia/Ho_Chi_Minh" });

  console.log("[Cron] 6 jobs registered ✓ (Asia/Ho_Chi_Minh)");
}



async function sendPushToUser(userId, title, body, data = {}) {
  const user = await User.findById(userId).select('pushToken');
  if (!user?.pushToken || !Expo.isExpoPushToken(user.pushToken)) return 0;
  return sendPushToUsers([user.pushToken], title, body, data);
}


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

// GET /api/orders/my — lấy đơn hàng của customer (FIXED)
app.get("/api/orders/my", async (req, res) => {
  try {
    await loadSessionFromHeader(req);
    if (!req.session.userId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    
    // FIX: Sửa "userId" thành "customerId" (đúng với schema)
    const orders = await Order.find({ customerId: req.session.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    
    // Thêm tên nhà hàng cho mỗi đơn
    const enrichedOrders = await Promise.all(orders.map(async (order) => {
      if (order.partnerId) {
        const partner = await FoodPartner.findById(order.partnerId).select('bizName');
        if (partner) {
          order.partnerName = partner.bizName;
        }
      }
      return order;
    }));
    
    res.json({ 
      success: true, 
      orders: enrichedOrders,  // Frontend đọc "orders"
      data: enrichedOrders,
      total: enrichedOrders.length 
    });
  } catch (err) {
    console.error('[GET /api/orders/my] Error:', err);
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
    // Broadcast voucher mới đến tất cả customer đang online
    req.io.emit("new_voucher", {
      _id:         v._id,
      code:        v.code,
      type:        v.type,
      value:       v.value,
      minOrder:    v.minOrder,
      maxDiscount: v.maxDiscount,
      description: v.description,
      expiresAt:   v.expiresAt,
      module:      v.module,
    });
    res.json({ success: true, data: v });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/vouchers/public — Public list vouchers cho customer app
app.get("/api/vouchers/public", async (req, res) => {
  try {
    const now = new Date();
    const vs = await Voucher.find({
      active: true,
      expiresAt: { $gt: now },
    }).sort({ createdAt: -1 }).limit(50).select("-__v");
    res.json({ success: true, vouchers: vs });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/vouchers/my — Customer lấy danh sách voucher (alias public)
app.get("/api/vouchers/my", async (req, res) => {
  try {
    const now = new Date();
    const vs = await Voucher.find({ active: true, expiresAt: { $gt: now } })
      .sort({ createdAt: -1 }).limit(50).select("-__v");
    res.json({ success: true, vouchers: vs });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
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
    if (!req.session.shipperId && !req.session.userId) return res.status(401).json({ success: false });
    let shipper = null;
    if (req.session.shipperId) {
      shipper = await Shipper.findById(req.session.shipperId);
    } else {
      const user = await User.findById(req.session.userId).select("phone");
      if (user) shipper = await Shipper.findOne({ phone: user.phone });
    }
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
    if (!req.session.shipperId && !req.session.userId) return res.status(401).json({ success: false });
    let shipper = null;
    if (req.session.shipperId) {
      shipper = await Shipper.findById(req.session.shipperId);
    } else {
      const user = await User.findById(req.session.userId).select("phone");
      if (user) shipper = await Shipper.findOne({ phone: user.phone });
    }
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

// DELETE /api/users/addresses/:id — Xóa địa chỉ (theo _id hoặc label)
app.delete("/api/users/addresses/:id", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const { id } = req.params;
    // Thử xoá theo _id trước, nếu không phải ObjectId thì xoá theo label
    const isObjectId = /^[a-f\d]{24}$/i.test(id);
    const pullQuery = isObjectId
      ? { $pull: { savedAddresses: { _id: id } } }
      : { $pull: { savedAddresses: { label: id } } };
    await User.findByIdAndUpdate(req.session.userId, pullQuery);
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
    if (!req.session.partnerId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const isAccepting = req.body.isAccepting ?? req.body.accepting;
    let mod = req.session.partnerModule;
    // Auto-detect module nếu session không có
    if (!mod) {
      const pModels = [
        { model: FoodPartner, key: "food_partner" },
        { model: GiatLa,      key: "giat_la" },
        { model: GiupViec,    key: "giup_viec" },
        { model: ChinaShop,   key: "china_shop" },
      ];
      for (const { model, key } of pModels) {
        const found = await model.findById(req.session.partnerId);
        if (found) { mod = key; req.session.partnerModule = key; break; }
      }
    }
    const Model = getPartnerModel(mod);
    if (!Model) return res.status(400).json({ success: false, message: "Không xác định loại partner. Đăng xuất và đăng nhập lại." });
    await Model.findByIdAndUpdate(req.session.partnerId, { isAccepting: !!isAccepting });
    req.io.to("admin").emit("partnerStatusChanged", {
      partnerId: req.session.partnerId, isAccepting, module: mod
    });
    // Notify shipper broadcast room
    if (!!isAccepting) req.io.to("shipper_broadcast").emit("partner_online", { partnerId: req.session.partnerId });
    res.json({ success: true, isAccepting: !!isAccepting });
  } catch(err) {
    console.error('[PATCH /api/partner/accepting] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
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
      sessionId: req.sessionID,
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
  if (req.session.shipperId) return { id: req.session.shipperId, type: 'shipper' };
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
    await loadSessionFromHeader(req);
    if (!req.session.shipperId && !req.session.userId) return res.status(401).json({ success:false });
    let shipper = null;
    if (req.session.shipperId) {
      shipper = await Shipper.findById(req.session.shipperId).select('walletBalance walletEarned _id');
    } else {
      // Legacy: tìm qua userId
      shipper = await Shipper.findOne({ _id: req.session.userId }).select('walletBalance walletEarned _id');
      if (!shipper) {
        const user = await User.findById(req.session.userId).select('phone');
        if (user) shipper = await Shipper.findOne({ phone: user.phone }).select('walletBalance walletEarned _id');
      }
    }
    if (!shipper) return res.status(404).json({ success:false });
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
    const user = await User.findById(req.session.userId).select('totalSpent totalOrders isAdmin');
    if (!user) return res.status(404).json({ success:false });
    // Admin luôn đủ điều kiện
    const orderCount = user.totalOrders || 0;
    const eligible   = user.isAdmin || orderCount >= 10;
    const spent      = user.totalSpent || 0;
    const limit      = eligible ? getBnplLimit(Math.max(spent, 2000000)) : 0;
    const month      = getCurrentBillingMonth();
    const txs        = await BNPLTx.find({ userId:req.session.userId, billingMonth:month, status:{$in:['pending_bill','billed']} });
    const usedThisMonth = txs.reduce((s,t)=>s+t.amount,0);
    const available  = Math.max(0, limit - usedThisMonth);
    const unpaid     = await BNPLInvoice.find({ userId:req.session.userId, status:{$in:['issued','overdue','installment']} }).sort({dueDate:1});
    res.json({ success:true, eligible, limit, spent, orderCount, usedThisMonth, available,
      message: eligible
        ? `Hạn mức: ${limit.toLocaleString('vi-VN')}đ | Còn: ${available.toLocaleString('vi-VN')}đ`
        : `Cần thêm ${Math.max(0, 10 - orderCount)} đơn hàng để mở Ví Trả Sau (cần tối thiểu 10 đơn)`,
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
    const user = await User.findById(req.session.userId).select('totalSpent totalOrders isAdmin');
    const orderCount = user?.totalOrders || 0;
    const eligible   = user?.isAdmin || orderCount >= 10;
    const activeLoan = await Loan.findOne({ userId: req.session.userId, status:{$in:['approved','active']} });
    res.json({ success:true, eligible, orderCount, totalSpent: user?.totalSpent||0,
      hasActiveLoan: !!activeLoan, activeLoan,
      message: eligible
        ? 'Đủ điều kiện vay nhanh'
        : `Cần thêm ${Math.max(0, 10 - orderCount)} đơn hàng để mở Vay nhanh (cần tối thiểu 10 đơn)` });
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

    // ── 6. Order delivery payment (CRORD) ───────────────────
    const orderMatch = rawRef.match(/CRORD([A-Z0-9]{6,10})/);
    if (orderMatch && !handled) {
      const suffix = orderMatch[1];
      const order = await Order.findOne({
        sePayRef: { $regex: suffix, $options: "i" },
        paymentStatus: { $in: ["unpaid", "pending_review"] },
      });
      if (order && amount >= (order.finalTotal || order.total) - 1000) {
        order.paymentStatus = "paid";
        order.paidAt = new Date();
        order.statusHistory.push({ status: "payment_confirmed_sepay", by: "system" });
        await order.save();

        // Tính tiền shipper + partner
        const { shipperEarn, partnerEarn } = calcEarnings(order);

        // Xoá wallet queue cũ (nếu đã add lúc confirm thủ công) và tạo lại với status pending
        await WalletQueue.deleteMany({ orderId: order.orderId, status: "pending" });

        if (order.shipperId) {
          await WalletQueue.create({
            orderId: order.orderId, recipientId: order.shipperId,
            recipientType: "shipper", amount: shipperEarn,
            paymentMethod: "bank_transfer",
            note: `Đơn ${order.orderId} — SePay confirmed`,
            status: "pending",
          });
        }
        if (order.partnerId) {
          await WalletQueue.create({
            orderId: order.orderId, recipientId: order.partnerId,
            recipientType: "partner", amount: partnerEarn,
            paymentMethod: "bank_transfer",
            note: `Đơn ${order.orderId} — SePay confirmed`,
            status: "pending",
          });
        }

        // Notify shipper qua socket
        if (order.shipperId) {
          req.io.to(`shipper_${order.shipperId}`).emit("sepay_payment_confirmed", {
            orderId: order.orderId,
            amount,
            message: `Khách đã thanh toán ${amount.toLocaleString("vi-VN")}đ qua SePay!`,
          });
        }
        // Notify customer
        req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
          orderId: order.orderId, status: "payment_confirmed",
          message: "Thanh toán thành công! Cảm ơn bạn đã dùng CRABOR 🦀",
        });
        // Notify admin
        req.io.to("admin").emit("wallet_pending_approval", {
          orderId: order.orderId, shipperEarn, partnerEarn,
          paymentMethod: "bank_transfer", source: "sepay_auto",
        });

        console.log(`[SEPAY] Order payment confirmed: ${order.orderId} — ${amount.toLocaleString("vi-VN")}đ`);
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
    const { message, text: textField, sessionId } = req.body;
    const text = (textField || message || '').trim();
    if (!text) return res.status(400).json({ success:false });

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


// ══════════════════════════════════════════════════════════════
//  AUTH MỚI — Google OAuth + Form (thay thế OTP SMS)
// ══════════════════════════════════════════════════════════════

// POST /api/auth/google — xác thực Google ID token từ client
app.post("/api/auth/google", async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success:false, message:"Thiếu idToken" });

    // Verify token với Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Tìm hoặc tạo user
    let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
    if (!user) {
      user = await User.create({
        googleId,
        email:        email.toLowerCase(),
        fullName:     name,
        avatar:       picture,
        authMethod:   "google",
        emailVerified: true,
        phone:        "google_" + googleId.slice(-8),
        status:       "active",
      });
    } else if (!user.googleId) {
      // Merge existing account với Google
      await User.findByIdAndUpdate(user._id, { googleId, avatar: picture, emailVerified: true, authMethod: "google" });
    }

    req.session.userId    = user._id;
    req.session.userPhone = user.phone;
    await new Promise((res, rej) => req.session.save(e => e ? rej(e) : res()));

    res.json({
      success: true,
      user: {
        _id:      user._id,
        fullName: user.fullName || name,
        email:    user.email,
        avatar:   user.avatar || picture,
        loyaltyPts: user.loyaltyPts || 0,
        walletBalance: user.walletBalance || 0,
        isNew:    !user.totalSpent,
      },
    });
  } catch(err) {
    console.error("[Google Auth]", err.message);
    res.status(401).json({ success:false, message:"Xác thực Google thất bại. Thử lại nhé!" });
  }
});

// POST /api/auth/register — đăng ký chuẩn (từ register_route.js)
// Hỗ trợ: name/fullName, phone hoặc email, password
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, fullName, phone, email, password } = req.body;
    const displayName = (fullName || name || "").trim();

    // Validate
    if (!displayName)
      return res.status(400).json({ success:false, message:"Vui lòng nhập họ tên" });
    if (!phone && !email)
      return res.status(400).json({ success:false, message:"Vui lòng nhập số điện thoại hoặc email" });
    if (!password || password.length < 6)
      return res.status(400).json({ success:false, message:"Mật khẩu tối thiểu 6 ký tự" });

    const cleanPhone = phone ? phone.replace(/\D/g, "") : null;
    const cleanEmail = email ? email.trim().toLowerCase() : null;

    // Kiểm tra trùng
    const query = [];
    if (cleanPhone) query.push({ phone: cleanPhone });
    if (cleanEmail) query.push({ email: cleanEmail });
    const existing = await User.findOne({ $or: query });
    if (existing) {
      const field = (existing.phone === cleanPhone) ? "Số điện thoại" : "Email";
      return res.status(409).json({ success:false, message: field + " này đã được đăng ký" });
    }

    // Hash password
    const bcrypt = require("bcryptjs");
    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      fullName:        displayName,
      phone:           cleanPhone || ("form_" + Date.now().toString(36)),
      email:           cleanEmail,
      password:        hashed,
      authMethod:      "form",
      status:          "active",
      profileComplete: true,
      totalOrders:     0,
      totalSpent:      0,
      walletBalance:   0,
      loyaltyPts:      0,
    });

    // Tạo session
    req.session.userId    = user._id;
    req.session.userPhone = user.phone;
    await new Promise((res, rej) => req.session.save(e => e ? rej(e) : res()));

    // Lấy cookie string để trả về app
    const cookieStr = buildSignedSessionCookie(req.session.id);

    return res.status(201).json({
      success: true,
      cookie:  cookieStr,
      user: {
        _id:      user._id,
        fullName: user.fullName,
        phone:    cleanPhone || "",
        email:    cleanEmail || "",
        role:     "customer",
      },
    });
  } catch(err) {
    console.error("[Auth/Register]", err.message);
    return res.status(500).json({ success:false, message:"Lỗi server khi đăng ký" });
  }
});


// POST /api/auth/register-form — đăng ký bằng form thường (email + password)
app.post("/api/auth/register-form", async (req, res) => {
  try {
    const { fullName, email, password, phone } = req.body;
    if (!fullName || !email || !password)
      return res.status(400).json({ success:false, message:"Nhập đủ họ tên, email và mật khẩu" });
    if (password.length < 6)
      return res.status(400).json({ success:false, message:"Mật khẩu tối thiểu 6 ký tự" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success:false, message:"Email không hợp lệ" });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(400).json({ success:false, message:"Email này đã được đăng ký" });

    const bcrypt = require("bcryptjs");
    const hash   = await bcrypt.hash(password, 10);

    const user = await User.create({
      fullName,
      email:      email.toLowerCase(),
      phone:      phone || "form_" + Date.now().toString(36),
      password:   hash,
      authMethod: "form",
      status:     "active",
    });

    req.session.userId    = user._id;
    req.session.userPhone = user.phone;
    await new Promise((res, rej) => req.session.save(e => e ? rej(e) : res()));

    res.json({
      success: true,
      message: "Đăng ký thành công!",
      user: { _id:user._id, fullName:user.fullName, email:user.email },
    });
  } catch(err) {
    res.status(500).json({ success:false, message:err.message });
  }
});

// POST /api/auth/login-form — đăng nhập bằng SĐT hoặc email + password
app.post("/api/auth/login-form", async (req, res) => {
  try {
    // App gửi lên field thứ nhất là email (có thể là SĐT hoặc email)
    const identifier = (req.body.email || req.body.identifier || "").trim();
    const password   = req.body.password;
    if (!identifier || !password)
      return res.status(400).json({ success:false, message:"Nhập số điện thoại/email và mật khẩu" });

    // Tìm theo phone hoặc email
    const cleanPhone = identifier.replace(/\D/g, "");
    const isPhone    = /^\d{9,11}$/.test(cleanPhone);
    const query      = isPhone
      ? { phone: cleanPhone }
      : { email: identifier.toLowerCase() };

    const user = await User.findOne(query);
    if (!user)
      return res.status(400).json({ success:false, message:"Số điện thoại hoặc email chưa được đăng ký" });
    if (!user.password)
      return res.status(400).json({ success:false, message:"Tài khoản này đăng nhập qua Google, không có mật khẩu" });

    const bcrypt  = require("bcryptjs");
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ success:false, message:"Mật khẩu không đúng" });

    req.session.userId    = user._id;
    req.session.userPhone = user.phone;
    await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));

    // Trả cookie để app lưu session (giống register)
    const cookieStr = buildSignedSessionCookie(req.session.id);

    res.json({
      success: true,
      cookie:  cookieStr,
      user: {
        _id:          user._id,
        fullName:     user.fullName,
        phone:        user.phone || "",
        email:        user.email || "",
        role:         user.role  || "customer",
        isAdmin:      user.isAdmin || user.role === "admin",
        loyaltyPts:   user.loyaltyPts || 0,
        walletBalance: user.walletBalance || 0,
        totalOrders:  user.totalOrders || 0,
        profileComplete: user.profileComplete || true,
      },
    });
  } catch(err) {
    res.status(500).json({ success:false, message:err.message });
  }
});

// POST /api/auth/check-account — kiểm tra SĐT/email đã tồn tại chưa & có password không
app.post("/api/auth/check-account", async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier)
      return res.status(400).json({ success: false, message: "Thieu identifier" });
    const user = await User.findOne({
      $or: [
        { phone: identifier.replace(/\D/g, "") },
        { email: identifier.toLowerCase() },
      ],
    });
    res.json({
      success: true,
      exists: !!user,
      hasPassword: !!(user?.password),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/forgot-password — gửi email reset
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    // Luôn trả 200 để không lộ email tồn tại
    if (!user || !createEmailTransporter()) {
      return res.json({ success:true, message:"Nếu email tồn tại, link đặt lại đã được gửi" });
    }
    const token   = require("crypto").randomBytes(32).toString("hex");
    const expiry  = Date.now() + 3600000; // 1h
    await User.findByIdAndUpdate(user._id, { resetToken:token, resetExpiry:expiry });

    const resetUrl = (process.env.BASE_URL || "https://crabor-shipper-register.onrender.com")
      + "/reset-password?token=" + token;

    const transporter = createEmailTransporter();
    await transporter.sendMail({
      from: '"CRABOR 🦀" <' + process.env.EMAIL_USER + '>',
      to:   email,
      subject: "[CRABOR] Đặt lại mật khẩu",
      html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">'
        + '<div style="background:#E8504A;padding:20px;border-radius:16px 16px 0 0;text-align:center">'
        + '<div style="font-size:2rem">🦀</div><div style="color:#fff;font-weight:900">CRABOR</div></div>'
        + '<div style="padding:20px;background:#f9f9f9">'
        + '<p>Nhấn link bên dưới để đặt lại mật khẩu (hết hạn sau 1 giờ):</p>'
        + '<a href="' + resetUrl + '" style="display:block;background:#E8504A;color:#fff;padding:14px;border-radius:12px;text-align:center;text-decoration:none;font-weight:900;margin:16px 0">Đặt lại mật khẩu</a>'
        + '<p style="color:#888;font-size:.8rem">Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>'
        + '</div></div>',
    });
    res.json({ success:true, message:"Link đặt lại mật khẩu đã gửi về email" });
  } catch(err) {
    res.status(500).json({ success:false, message:err.message });
  }
});

// POST /api/auth/reset-password
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || newPassword.length < 6)
      return res.status(400).json({ success:false, message:"Mật khẩu tối thiểu 6 ký tự" });

    const user = await User.findOne({ resetToken:token, resetExpiry:{ $gt: Date.now() } });
    if (!user)
      return res.status(400).json({ success:false, message:"Link hết hạn hoặc không hợp lệ" });

    const bcrypt = require("bcryptjs");
    const hash   = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(user._id, { password:hash, resetToken:null, resetExpiry:null });
    res.json({ success:true, message:"Đặt lại mật khẩu thành công! Đăng nhập lại nhé." });
  } catch(err) {
    res.status(500).json({ success:false, message:err.message });
  }
});


// ── PUSH TOKEN ENDPOINTS (từ push_route.js) ──────────────────

// POST /api/users/push-token — lưu Expo push token
app.post("/api/users/push-token", async (req, res) => {
  try {
    if (!req.session?.userId)
      return res.json({ success: false, reason: "not_logged_in" });
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ message: "Thiếu token" });
    await User.findByIdAndUpdate(req.session.userId, {
      pushToken:      token,
      pushPlatform:   platform || "unknown",
      pushUpdatedAt:  new Date(),
      fcmToken:       token, // backwards compat
    });
    res.json({ success: true });
  } catch(e) {
    console.error("[Push/Register]", e);
    res.status(500).json({ message: "Lỗi lưu push token" });
  }
});

// DELETE /api/users/push-token — xóa token khi logout
app.delete("/api/users/push-token", async (req, res) => {
  try {
    if (!req.session?.userId) return res.json({ success: false });
    await User.findByIdAndUpdate(req.session.userId, {
      pushToken: null, pushPlatform: null, fcmToken: null,
    });
    res.json({ success: true });
  } catch(e) {
    console.error("[Push/Unregister]", e);
    res.status(500).json({ message: "Lỗi xóa push token" });
  }
});

// GET /api/surge — surge info cho app (Coco/Nova dùng)
app.get("/api/surge", (req, res) => {
  const { multiplier, isSurge } = getSurgeMultiplier();
  const h = new Date().getHours();
  const period = SURGE_PERIODS.find(p => h >= p.startH && h < p.endH);
  res.json({
    success: true,
    isSurge,
    multiplier,
    message: isSurge ? `⚡ Giờ cao điểm \${period?.label||''} — phí ship tăng 50%` : null,
    nextSurge: SURGE_PERIODS.find(p => h < p.startH)?.startH || null,
  });
});

// POST /api/admin/notify — admin gửi thông báo thủ công
app.post("/api/admin/notify", adminAuth, async (req, res) => {
  try {
    const { title, body, target = "all", data = {} } = req.body;
    if (!title || !body) return res.status(400).json({ success:false, message:"Thiếu title/body" });
    const tokens = await getAllPushTokens();
    const sent = await sendPushToUsers(tokens, title, body, { type:"admin_broadcast", ...data });
    // Emit socket broadcast
    req.io.emit("cocoNotification", { title, body, data });
    res.json({ success:true, sent, total: tokens.length });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
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
    await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));

    res.json({
      success: true,
      isNewUser,
      sessionId: req.sessionID,
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

// GET /api/shipper/me — Shipper tìm profile theo session
app.get("/api/shipper/me", async (req, res) => {
  try {
    console.log('[GetMe] Session ID:', req.session?.id);
    console.log('[GetMe] ShipperId:', req.session?.shipperId);

    let shipperId = req.session?.shipperId;
    let userPhone = req.session?.userPhone;

    // FALLBACK: nếu session empty → thử load từ MongoDB sessions collection
    // dùng X-Session-ID header (session ID thuần, không cần signature)
    if (!shipperId && !userPhone) {
      const xSid = req.headers['x-session-id'];
      if (xSid && xSid.length > 10) {
        try {
          const sessionDoc = await mongoose.connection.db
            .collection('sessions')
            .findOne({ _id: xSid });
          if (sessionDoc && sessionDoc.session) {
            const sess = typeof sessionDoc.session === 'string'
              ? JSON.parse(sessionDoc.session) : sessionDoc.session;
            shipperId = sess.shipperId;
            userPhone = sess.userPhone;
            // Re-populate req.session cho các middleware sau
            if (shipperId) {
              req.session.shipperId = shipperId;
              req.session.userPhone = userPhone;
              req.session.role = sess.role || 'shipper';
              console.log('[GetMe] Session loaded from MongoDB via X-Session-ID:', xSid.substring(0,8));
            }
          }
        } catch(e) {
          console.error('[GetMe] MongoDB session fallback error:', e.message);
        }
      }
    }

    let shipper = null;
    if (shipperId) {
      shipper = await Shipper.findById(shipperId);
    } else if (userPhone) {
      shipper = await Shipper.findOne({ phone: userPhone });
    }

    if (!shipper) {
      if (shipperId || userPhone) {
        return res.status(401).json({ success: false, message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", expired: true });
      }
      return res.status(401).json({ success: false, message: "Chưa đăng nhập", notRegistered: true });
    }

    res.json({ success: true, shipper });
  } catch (err) {
    console.error('[GetMe] Error:', err);
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
    await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
    const cookieStr = buildSignedSessionCookie(req.session.id);
    res.json({ success: true, shipper, cookie: cookieStr, sessionId: req.session.id });
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

// POST /api/partner/check-account - Kiểm tra tài khoản đã có mật khẩu chưa
app.post("/api/partner/check-account", async (req, res) => {
  try {
    const { phone, email } = req.body;
    const query = phone ? { phone: normalizePhone(phone) } : { email: email?.toLowerCase().trim() };
    const models = [
      { model: mongoose.models.FoodPartner, module: "food_partner" },
      { model: mongoose.models.GiatLa,      module: "giat_la" },
      { model: mongoose.models.GiupViec,    module: "giup_viec" },
      { model: mongoose.models.ChinaShop,   module: "china_shop" },
    ].filter(m => m.model);
    for (const { model, module } of models) {
      const p = await model.findOne(query).select("_id password status rejectReason");
      if (p) {
        console.log('[Partner CheckAccount] Found:', p._id, 'module:', module);
        return res.json({
          success: true, exists: true, hasPassword: !!(p.password),
          status: p.status, rejectReason: p.rejectReason || null, module
        });
      }
    }
    res.json({ success: true, exists: false });
  } catch(err) {
    console.error('[Partner CheckAccount] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/partner/set-password - Đặt mật khẩu lần đầu → tạo session
app.post("/api/partner/set-password", async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: "Mật khẩu tối thiểu 6 ký tự" });
    }
    const query = phone ? { phone: normalizePhone(phone) } : { email: email?.toLowerCase().trim() };
    const models = [
      { model: mongoose.models.FoodPartner, key: "food_partner" },
      { model: mongoose.models.GiatLa,      key: "giat_la" },
      { model: mongoose.models.GiupViec,    key: "giup_viec" },
      { model: mongoose.models.ChinaShop,   key: "china_shop" },
    ].filter(m => m.model);
    const bcrypt = require("bcryptjs");
    let foundPartner = null, foundModule = null;
    for (const { model, key } of models) {
      const p = await model.findOne(query);
      if (p) {
        p.password = await bcrypt.hash(password, 10);
        await p.save();
        foundPartner = p; foundModule = key; break;
      }
    }
    if (!foundPartner) return res.status(404).json({ success: false, message: "Không tìm thấy tài khoản" });
    req.session.partnerId = foundPartner._id;
    req.session.userPhone = foundPartner.phone;
    req.session.partnerModule = foundModule;
    req.session.role = "partner";
    await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
    const cookieStr = buildSignedSessionCookie(req.session.id);
    console.log('[Partner SetPassword] Success:', foundPartner.phone, 'module:', foundModule);
    res.json({
      success: true,
      partner: { _id: foundPartner._id, name: foundPartner.bizName || foundPartner.fullName,
        phone: foundPartner.phone, email: foundPartner.email, status: foundPartner.status },
      module: foundModule, cookie: cookieStr, sessionId: req.session.id
    });
  } catch(err) {
    console.error('[Partner SetPassword] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/partner/login ───────────────────────────────────
// Đăng nhập bằng mật khẩu
app.post("/api/partner/login", async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: "Thiếu mật khẩu" });
    const query = phone ? { phone: normalizePhone(phone) } : { email: email?.toLowerCase().trim() };
    const models = [
      { model: GiatLa, module: "giat_la" },
      { model: GiupViec, module: "giup_viec" },
      { model: ChinaShop, module: "china_shop" },
      { model: FoodPartner, module: "food_partner" },
      { model: RideDriver, module: "ride_driver" },
    ];
    const bcrypt = require("bcryptjs");
    for (const { model, module } of models) {
      const p = await model.findOne(query);
      if (p) {
        if (!p.password) return res.status(400).json({ success: false, message: "Tài khoản chưa có mật khẩu. Vui lòng đặt mật khẩu." });
        const ok = await bcrypt.compare(password, p.password);
        if (!ok) return res.status(401).json({ success: false, message: "Mật khẩu không đúng" });
        req.session.userPhone = p.phone;
        req.session.partnerId = p._id;
        req.session.partnerModule = module;
        req.session.role = "partner";
        await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
        // Trả cookie để app lưu session
        const cookieStr = buildSignedSessionCookie(req.session.id);
        return res.json({
          success: true,
          partner: p,
          module,
          cookie: cookieStr,
          sessionId: req.session.id,
        });
      }
    }
    return res.status(404).json({ success: false, message: "Không tìm thấy tài khoản" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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
        await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
        const cookieStr = buildSignedSessionCookie(req.session.id);
        return res.json({ success: true, partner: p, module, cookie: cookieStr, sessionId: req.session.id });
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
  try { await loadSessionFromHeader(req); } catch(_) {}
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
  try { await loadSessionFromHeader(req); } catch(_) {}
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
    if (!req.session.shipperId && !req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { period = "today" } = req.query;

    // Find shipper by shipperId (preferred) or userId
    let shipper = null;
    if (req.session.shipperId) {
      shipper = await Shipper.findById(req.session.shipperId);
    } else {
      const user = await User.findById(req.session.userId).select("phone");
      if (user) shipper = await Shipper.findOne({ phone: user.phone });
    }
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

// ══ PARTNER MENU ENDPOINTS ════════════════════════════════════

// GET /api/partner/menu
app.get("/api/partner/menu", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const products = await Product.find({ partnerId: req.session.partnerId }).sort({ createdAt: -1 });
    res.json({ success: true, items: products });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// POST /api/partner/menu — thêm món
app.post("/api/partner/menu", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const { name, price, category, description, available, image } = req.body;
    if (!name || !price) return res.status(400).json({ success:false, message:"Thiếu tên hoặc giá" });
    const item = await Product.create({
      partnerId: req.session.partnerId,
      name: name.trim(), price: Number(price),
      category: category?.trim() || "Khác",
      description: description?.trim() || "",
      available: available !== false,
      image: image || "",
    });
    res.json({ success: true, item });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// PATCH /api/partner/menu/:id — sửa món
app.patch("/api/partner/menu/:id", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const item = await Product.findOneAndUpdate(
      { _id: req.params.id, partnerId: req.session.partnerId },
      req.body, { new: true }
    );
    if (!item) return res.status(404).json({ success:false, message:"Không tìm thấy món" });
    res.json({ success: true, item });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// DELETE /api/partner/menu/:id — xóa món
app.delete("/api/partner/menu/:id", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    await Product.findOneAndDelete({ _id: req.params.id, partnerId: req.session.partnerId });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// GET /api/partner/orders — lấy đơn hàng của partner
app.get("/api/partner/orders", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const orders = await Order.find({ partnerId: req.session.partnerId })
      .sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, orders });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});


// PATCH /api/partner/orders/:id — Partner xác nhận / từ chối đơn hàng
// Partner app gọi { action: 'accept' | 'reject' }
app.patch("/api/partner/orders/:id", async (req, res) => {
  try {
    if (!req.session.partnerId)
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });

    const { action, note } = req.body;
    if (!action || !["accept", "reject"].includes(action))
      return res.status(400).json({ success: false, message: "action phải là accept hoặc reject" });

    const order = await Order.findOne({
      $or: [
        { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null },
        { orderId: req.params.id },
      ]
    });

    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    // Chỉ cho phép partner sở hữu đơn này
    if (order.partnerId && order.partnerId.toString() !== req.session.partnerId.toString())
      return res.status(403).json({ success: false, message: "Bạn không có quyền thao tác đơn này" });

    if (action === "accept") {
      order.status = "confirmed";
      order.confirmedAt = new Date();
      order.statusHistory.push({ status: "confirmed", by: "partner", time: new Date() });
      if (note) order.partnerNote = note;

      // Thông báo customer
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId || order._id,
        status: "confirmed",
        message: "Quán đã xác nhận đơn hàng của bạn! 🎉",
      });

      await order.save();

      // Ngay lập tức dispatch đến shipper (không đợi cron 30s)
      setImmediate(async () => {
        try {
          let pickupLat, pickupLng;
          if (order.partnerId) {
            const p = await FoodPartner.findById(order.partnerId).select("lastLat lastLng location address");
            if (p?.lastLat) { pickupLat = p.lastLat; pickupLng = p.lastLng; }
            else if (p?.location?.lat) { pickupLat = p.location.lat; pickupLng = p.location.lng; }
          }
          if (!pickupLat) { pickupLat = 10.7769; pickupLng = 106.7009; } // TP.HCM default

          const nearbyShippers = await findNearbyShippers(pickupLat, pickupLng, 10, 10);
          if (nearbyShippers.length > 0) {
            const payload = {
              type: "order_request",
              orderId: order.orderId,
              order: {
                _id: order._id,
                orderId: order.orderId,
                items: order.items,
                total: order.finalTotal || order.total,
                shipFee: order.shipFee || 0,
                pickupAddress: order.partnerAddress || "Địa chỉ quán",
                pickupLat, pickupLng,
                deliveryAddress: order.address,
                note: order.note,
                customerName: order.customerName,
                module: order.module || 'food',
              },
              timeout: 30,
            };
            for (const shipper of nearbyShippers) {
              req.io.to(`shipper_${shipper._id}`).emit("order_request", payload);
              console.log(`[PartnerConfirm] Dispatched order ${order.orderId} to shipper ${shipper._id}`);
            }
            await Order.findByIdAndUpdate(order._id, {
              $set: { dispatchedTo: nearbyShippers.map(s => s._id), dispatchedAt: new Date() }
            });
          } else {
            console.log(`[PartnerConfirm] No nearby shippers for order ${order.orderId}`);
          }
        } catch(e) {
          console.error('[PartnerConfirm] Dispatch error:', e.message);
        }
      });

      return res.json({ success: true, status: "confirmed", message: "Đã xác nhận đơn" });
    }

    if (action === "reject") {
      order.status = "cancelled";
      order.cancelledAt = new Date();
      order.statusHistory.push({ status: "cancelled", by: "partner", time: new Date() });
      if (note) order.partnerNote = note;

      // Thông báo customer
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId || order._id,
        status: "cancelled",
        message: "Rất tiếc, quán đã từ chối đơn hàng của bạn.",
      });

      await order.save();
      return res.json({ success: true, status: "cancelled", message: "Đã từ chối đơn" });
    }
  } catch (err) {
    console.error("[PATCH /api/partner/orders/:id] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/partner/stats
app.get("/api/partner/stats", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const pid = req.session.partnerId;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [todayOrders, monthOrders, allOrders] = await Promise.all([
      Order.find({ partnerId:pid, createdAt:{$gte:todayStart}, status:"delivered" }),
      Order.find({ partnerId:pid, createdAt:{$gte:monthStart}, status:"delivered" }),
      Order.find({ partnerId:pid, status:"delivered" }).limit(500),
    ]);
    const cancelled = await Order.countDocuments({ partnerId:pid, status:"cancelled" });
    const todayRevenue = todayOrders.reduce((s,o)=>s+(o.partnerRevenue||o.total*0.8||0),0);
    const monthRevenue = monthOrders.reduce((s,o)=>s+(o.partnerRevenue||o.total*0.8||0),0);
    const avgOrderValue = allOrders.length ? allOrders.reduce((s,o)=>s+(o.total||0),0)/allOrders.length : 0;
    res.json({ success:true, todayRevenue, monthRevenue, todayOrders:todayOrders.length, cancelledOrders:cancelled, avgOrderValue, avgRating:"5.0" });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

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
    if (!Model) return res.status(400).json({ success: false, message: `Module không hợp lệ: "${modFe}"` });

    const normPhone = normalizePhone(phone);
    const exists = await Model.findOne({ phone: normPhone });
    if (exists) return res.status(409).json({ success: false, message: `SĐT đã đăng ký. Mã: ${exists.registerId}` });

    // Fallback: district và email không bắt buộc từ form mobile
    const safeDistrict = district || req.body.city || "Chưa cập nhật";
    const safeEmail    = email || req.body.email || `partner_${normPhone}@crabor.vn`;
    const safeLastName = lastName || req.body.lastName || "Partner";
    const safeFirstName = firstName || req.body.firstName || "CRABOR";
    const base = {
      phone: normPhone, firstName: safeFirstName, lastName: safeLastName,
      email: safeEmail, address: address || req.body.address || "Chưa cập nhật",
      district: safeDistrict,
      refCode: refCode?.toUpperCase(), documents: req.body.documents || {},
    };
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
    // Chi tiết lỗi validation Mongoose
    if (err.name === 'ValidationError') {
      const fields = Object.keys(err.errors).map(k => `${k}: ${err.errors[k].message}`).join('; ');
      console.error('[Register Validation]', fields);
      return res.status(400).json({ success: false, message: `Thiếu thông tin: ${fields}` });
    }
    console.error('[Register Error]', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  RIDE — Customer endpoints
// ══════════════════════════════════════════════════════════════

// GET /api/ride/geocode
app.get("/api/ride/geocode", async (req, res) => {
  try {
    const { lat, lng, address } = req.query;
    if (address) {
      // Forward geocode — dùng Nominatim free
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=vn`;
      const r = await fetch(url, { headers: { 'User-Agent': 'CRABOR/1.0' } });
      const data = await r.json();
      if (!data.length) return res.json({ success: false, message: "Không tìm thấy địa chỉ" });
      return res.json({ success: true, address: data[0].display_name, lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) });
    }
    if (lat && lng) {
      // Reverse geocode
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
      const r = await fetch(url, { headers: { 'User-Agent': 'CRABOR/1.0' } });
      const data = await r.json();
      return res.json({ success: true, address: data.display_name || `${lat}, ${lng}` });
    }
    res.status(400).json({ success: false, message: "Thiếu tham số" });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/ride/estimate
app.get("/api/ride/estimate", async (req, res) => {
  try {
    const { fromLat, fromLng, toLat, toLng } = req.query;
    if (!fromLat || !fromLng || !toLat || !toLng)
      return res.status(400).json({ success: false, message: "Thiếu toạ độ" });
    // Haversine distance
    const R = 6371;
    const dLat = (parseFloat(toLat) - parseFloat(fromLat)) * Math.PI / 180;
    const dLng = (parseFloat(toLng) - parseFloat(fromLng)) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(parseFloat(fromLat)*Math.PI/180) * Math.cos(parseFloat(toLat)*Math.PI/180) * Math.sin(dLng/2)**2;
    const distanceKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const h = new Date().getHours();
    const isSurge = (h >= 11 && h < 12) || (h >= 19 && h < 20);
    const surge = isSurge ? 1.5 : 1.0;
    const bikeRate = 5000; const carRate = 15000; const minBike = 15000; const minCar = 30000;
    res.json({
      success: true,
      distanceKm: Math.round(distanceKm * 10) / 10,
      isSurge,
      surgeMultiplier: surge,
      estimates: {
        bike: { fee: Math.max(minBike, Math.round(distanceKm * bikeRate * surge / 1000) * 1000), vehicle: 'bike' },
        car:  { fee: Math.max(minCar,  Math.round(distanceKm * carRate  * surge / 1000) * 1000), vehicle: 'car' },
      },
    });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/ride/surge
app.get("/api/ride/surge", (req, res) => {
  const h = new Date().getHours();
  const isSurge = (h >= 11 && h < 12) || (h >= 19 && h < 20);
  res.json({ success: true, isSurge, multiplier: isSurge ? 1.5 : 1.0 });
});

// POST /api/ride/book
// GET /api/ride/my
app.get("/api/ride/my", async (req, res) => {
  try {
    if (!req.session?.userId && !req.session?.customerId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    const customerId = req.session.userId || req.session.customerId;
    const rides = await Order.find({
      customerId,
      module: "ride",
    }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, rides });
  } catch (err) {
    console.error('[My Rides] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/ride/:id
app.get("/api/ride/:id", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    res.json({ success: true, ride: { _id: req.params.id, status: "finding_driver" } });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/ride/:id/cancel
app.patch("/api/ride/:id/cancel", async (req, res) => {
  try {
    if (!req.session?.userId && !req.session?.customerId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    const customerId = req.session.userId || req.session.customerId;
    const order = await Order.findOne({ orderId: req.params.id, module: "ride", customerId });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy chuyến" });

    if (!["pending", "shipper_accepted"].includes(order.status)) {
      return res.status(400).json({ success: false, message: "Không thể huỷ chuyến ở trạng thái hiện tại" });
    }

    order.status = "cancelled";
    order.cancelReason = req.body.reason || "Khách hàng huỷ";
    order.statusHistory.push({ status: "cancelled", by: "customer", time: new Date() });
    await order.save();

    if (order.shipperId) {
      req.io.to(`shipper_${order.shipperId}`).emit("ride_cancelled", {
        orderId: order.orderId,
        message: "Khách hàng đã huỷ chuyến",
      });
    }

    res.json({ success: true, message: "Đã huỷ chuyến thành công" });
  } catch (err) {
    console.error('[Cancel Ride] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  LAUNDRY — Giặt là
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  CLEANING — Giúp việc / Dọn dẹp
// ══════════════════════════════════════════════════════════════

app.get("/api/cleaning/providers", async (req, res) => {
  res.json({ success: true, providers: [] });
});
app.get("/api/cleaning/providers/:id", async (req, res) => {
  res.json({ success: true, provider: null });
});
app.get("/api/cleaning/providers/:id/services", async (req, res) => {
  res.json({ success: true, services: [] });
});

// POST /api/cleaning/order - Customer đặt dọn nhà
app.post("/api/cleaning/order", async (req, res) => {
  try {
    if (!req.session.userId && !req.session.customerId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    const customerId = req.session.userId || req.session.customerId;
    const { serviceId, serviceName, price, duration, address, addressLat, addressLng, bookingDate, bookingTime, note } = req.body;
    if (!serviceId || !address || !bookingDate) {
      return res.status(400).json({ success: false, message: "Thiếu thông tin" });
    }
    const user = await User.findById(customerId).select("fullName phone");
    const order = new CleaningOrder({
      customerId,
      customerName: user?.fullName || "Khách hàng",
      customerPhone: user?.phone,
      address,
      addressLat: addressLat || null,
      addressLng: addressLng || null,
      serviceType: serviceId,
      serviceName,
      price: price || 200000,
      duration: duration || "2-3 tiếng",
      note,
      bookingDate: new Date(bookingDate),
      bookingTime: bookingTime || "08:00",
      status: "pending",
      statusHistory: [{ status: "pending", by: "customer", time: new Date() }],
    });
    await order.save();
    let nearbyShippers = [];
    if (addressLat && addressLng) {
      try { nearbyShippers = await findNearbyShippers(addressLat, addressLng, 5, 10); } catch(e) {}
    }
    const payload = {
      type: "cleaning_request",
      orderId: order.orderId,
      order: {
        _id: order._id, orderId: order.orderId, serviceName: order.serviceName,
        price: order.price, duration: order.duration, address: order.address,
        addressLat: order.addressLat, addressLng: order.addressLng,
        bookingDate: order.bookingDate, bookingTime: order.bookingTime,
        note: order.note, customerName: order.customerName,
      },
      timeout: 30,
    };
    for (const shipper of nearbyShippers) {
      req.io.to(`shipper_${shipper._id}`).emit("order_request", payload);
      console.log(`[Cleaning] Dispatched to shipper ${shipper._id}`);
    }
    res.status(201).json({ success: true, orderId: order.orderId });
  } catch (err) {
    console.error('[Cleaning Order] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cleaning/orders/my - Customer lấy đơn dọn nhà
app.get("/api/cleaning/orders/my", async (req, res) => {
  try {
    if (!req.session.userId && !req.session.customerId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    const customerId = req.session.userId || req.session.customerId;
    const orders = await CleaningOrder.find({ customerId }).sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cleaning/orders/:id - Chi tiết đơn
app.get("/api/cleaning/orders/:id", async (req, res) => {
  try {
    const order = await CleaningOrder.findOne({ orderId: req.params.id });
    if (!order) return res.status(404).json({ success: false });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cleaning/orders/:id/cancel - Hủy đơn
app.patch("/api/cleaning/orders/:id/cancel", async (req, res) => {
  try {
    if (!req.session.userId && !req.session.customerId) return res.status(401).json({ success: false });
    const order = await CleaningOrder.findOne({ orderId: req.params.id });
    if (!order) return res.status(404).json({ success: false });
    order.status = "cancelled";
    order.statusHistory.push({ status: "cancelled", by: "customer", time: new Date() });
    await order.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cleaning/orders/:id/status - Shipper cập nhật trạng thái
app.patch("/api/cleaning/orders/:id/status", async (req, res) => {
  try {
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    const shipperId = req.session.shipperId;
    const { status } = req.body;
    const order = await CleaningOrder.findOne({ orderId: req.params.id });
    if (!order) return res.status(404).json({ success: false });
    if (order.shipperId && order.shipperId.toString() !== shipperId.toString()) {
      return res.status(403).json({ success: false, message: "Không phải shipper của đơn này" });
    }
    if (!order.shipperId) order.shipperId = shipperId;
    order.status = status;
    order.statusHistory.push({ status, by: "shipper", time: new Date() });
    if (status === "completed") {
      order.completedAt = new Date();
      const shipperEarn = Math.round(order.price * 0.85);
      const WalletQueue = mongoose.models.WalletQueue;
      if (WalletQueue) {
        await WalletQueue.create({
          orderId: order.orderId, recipientId: shipperId, recipientType: "shipper",
          amount: shipperEarn, note: `Dọn nhà ${order.orderId}`, status: "pending",
          releaseAt: new Date(Date.now() + 30 * 60 * 1000),
        });
      }
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "completed",
        message: "Dọn nhà hoàn thành! Cảm ơn bạn đã dùng CRABOR 🧹",
      });
    }
    await order.save();
    res.json({ success: true, order });
  } catch (err) {
    console.error('[Cleaning Status] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cleaning/orders/:id/rate - Đánh giá
app.post("/api/cleaning/orders/:id/rate", async (req, res) => {
  try {
    if (!req.session.userId && !req.session.customerId) return res.status(401).json({ success: false });
    const { rating, comment } = req.body;
    const order = await CleaningOrder.findOne({ orderId: req.params.id });
    if (!order) return res.status(404).json({ success: false });
    order.rating = rating;
    order.ratingComment = comment;
    await order.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PARTNER — Wallet, Push Token, Location, Stats extras
// ══════════════════════════════════════════════════════════════

// GET /api/partner/wallet — alias /api/wallet với partner session
app.get("/api/partner/wallet", async (req, res) => {
  try {
    if (!req.session.partnerId && !req.session.userPhone)
      return res.status(401).json({ success: false });
    // Dùng partnerId hoặc userPhone để lấy wallet
    const wallet = await (async () => {
      // Thử wallet từ partner document
      const models = [
        require("mongoose").models.GiatLa,
        require("mongoose").models.GiupViec,
        require("mongoose").models.ChinaShop,
        require("mongoose").models.FoodPartner,
      ].filter(Boolean);
      for (const model of models) {
        if (!model) continue;
        const p = req.session.partnerId
          ? await model.findById(req.session.partnerId).select("walletBalance walletHistory")
          : await model.findOne({ phone: req.session.userPhone }).select("walletBalance walletHistory");
        if (p) return { balance: p.walletBalance || 0, history: p.walletHistory || [] };
      }
      return { balance: 0, history: [] };
    })();
    res.json({ success: true, wallet });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/partner/stats/payment-methods
app.get("/api/partner/stats/payment-methods", async (req, res) => {
  try {
    if (!req.session.partnerId && !req.session.userPhone)
      return res.status(401).json({ success: false });
    // Aggregate orders theo paymentMethod
    const Order = require("mongoose").models.Order;
    if (!Order) return res.json({ success: true, stats: [] });
    const match = req.session.partnerId ? { partnerId: req.session.partnerId } : {};
    const stats = await Order.aggregate([
      { $match: { ...match, status: { $in: ["delivered", "completed"] } } },
      { $group: { _id: "$paymentMethod", count: { $sum: 1 }, total: { $sum: "$total" } } },
    ]);
    res.json({ success: true, stats });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/partner/push-token
app.post("/api/partner/push-token", async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token || (!req.session.partnerId && !req.session.userPhone))
      return res.status(400).json({ success: false });
    const models = [
      require("mongoose").models.GiatLa,
      require("mongoose").models.GiupViec,
      require("mongoose").models.ChinaShop,
      require("mongoose").models.FoodPartner,
    ].filter(Boolean);
    for (const model of models) {
      const query = req.session.partnerId ? { _id: req.session.partnerId } : { phone: req.session.userPhone };
      const upd = await model.findOneAndUpdate(query, { pushToken: token, pushPlatform: platform });
      if (upd) break;
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/push-token
app.post("/api/shipper/push-token", async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token || !req.session.userPhone) return res.status(400).json({ success: false });
    await Shipper.findOneAndUpdate({ phone: req.session.userPhone }, { pushToken: token, pushPlatform: platform });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/partner/location — Partner chia sẻ vị trí
app.post("/api/partner/location", async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!req.session.partnerId && !req.session.userPhone)
      return res.status(401).json({ success: false });
    // Lưu vị trí vào partner document (không bắt buộc phải có field này)
    const models = [
      require("mongoose").models.GiatLa,
      require("mongoose").models.GiupViec,
      require("mongoose").models.ChinaShop,
      require("mongoose").models.FoodPartner,
    ].filter(Boolean);
    for (const model of models) {
      const query = req.session.partnerId ? { _id: req.session.partnerId } : { phone: req.session.userPhone };
      const upd = await model.findOneAndUpdate(query, { lastLat: lat, lastLng: lng, lastLocationAt: new Date() });
      if (upd) break;
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/location — Shipper cập nhật vị trí
// ══════════════════════════════════════════════════════════════
//  ORDER DELIVERY PAYMENT — QR SePay & Confirm
// ══════════════════════════════════════════════════════════════

// POST /api/orders/:orderId/delivery-qr — Shipper lấy QR để thu tiền
app.post("/api/orders/:orderId/delivery-qr", async (req, res) => {
  try {
    if (!req.session.shipperId) return res.status(401).json({ success: false });

    const order = await Order.findOne({
      orderId: req.params.orderId,
      shipperId: req.session.shipperId,
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    const amount   = order.finalTotal || order.total || 0;
    const sePayRef = "CRORD" + order.orderId.replace(/[^A-Z0-9]/gi, "").slice(-8).toUpperCase();

    // Lưu sePayRef vào order để webhook match
    await Order.findByIdAndUpdate(order._id, { sePayRef });

    const qrUrl = `https://qr.sepay.vn/img?bank=VIB&acc=068394585&template=compact&amount=${amount}&des=${encodeURIComponent(sePayRef)}`;

    res.json({
      success: true,
      qrUrl,
      sePayRef,
      amount,
      bankName:    "VIB",
      accountNo:   "068394585",
      accountName: "CRABOR TECH CO LTD",
      message:     `Chuyển khoản ${amount.toLocaleString("vi-VN")}đ · Nội dung: ${sePayRef}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/orders/:orderId/confirm-payment — Shipper xác nhận thủ công
app.post("/api/orders/:orderId/confirm-payment", async (req, res) => {
  try {
    if (!req.session.shipperId) return res.status(401).json({ success: false });

    const order = await Order.findOne({
      orderId: req.params.orderId,
      shipperId: req.session.shipperId,
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });
    if (order.paymentStatus === "paid")
      return res.status(400).json({ success: false, message: "Đơn đã thanh toán rồi" });

    // Đánh dấu pending review thay vì paid ngay
    order.paymentStatus = "pending_review";
    order.paymentConfirmedAt = new Date();
    order.paymentNote = req.body.note || "Shipper xác nhận";
    order.statusHistory.push({ status: "payment_pending_review", by: "shipper" });
    await order.save();

    // Tính tiền và đưa vào wallet queue với delay 30 phút
    const { shipperEarn, partnerEarn } = calcEarnings(order);
    const releaseAt = new Date(Date.now() + 30 * 60 * 1000); // 30 phút

    // Lưu wallet queue với timestamp để cron job hoặc admin duyệt
    if (order.shipperId) {
      await WalletQueue.create({
        orderId:       order.orderId,
        recipientId:   order.shipperId,
        recipientType: "shipper",
        amount:        shipperEarn,
        paymentMethod: order.paymentMethod,
        note:          `Đơn ${order.orderId} — phí ship (xác nhận thủ công)`,
        status:        "pending",
        releaseAt,
      });
    }
    if (order.partnerId) {
      await WalletQueue.create({
        orderId:       order.orderId,
        recipientId:   order.partnerId,
        recipientType: "partner",
        amount:        partnerEarn,
        paymentMethod: order.paymentMethod,
        note:          `Đơn ${order.orderId} — tiền hàng (xác nhận thủ công)`,
        status:        "pending",
        releaseAt,
      });
    }

    // Thông báo admin
    req.io.to("admin").emit("wallet_pending_approval", {
      orderId:      order.orderId,
      type:         "manual_confirm",
      shipperEarn,
      partnerEarn,
      releaseAt,
      message:      `Đơn ${order.orderId} — Shipper xác nhận thanh toán. Duyệt sau 30 phút.`,
    });

    res.json({
      success:  true,
      message:  `Thu nhập ${shipperEarn.toLocaleString("vi-VN")}đ sẽ được duyệt sau 30 phút`,
      releaseAt,
      shipperEarn,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  LAUNDRY — Workflow đầy đủ
// ══════════════════════════════════════════════════════════════

// ── Laundry Order Schema ──────────────────────────────────────
const laundryOrderSchema = new mongoose.Schema({
  orderId:       { type: String, unique: true },
  customerId:    mongoose.Schema.Types.ObjectId,
  partnerId:     mongoose.Schema.Types.ObjectId,
  shipperId:     mongoose.Schema.Types.ObjectId,   // shipper lấy đồ
  shipperReturnId: mongoose.Schema.Types.ObjectId, // shipper trả đồ
  customerName:  String,
  customerPhone: String,
  partnerName:   String,
  // Địa chỉ khách
  pickupAddress: String,
  pickupLat:     Number,
  pickupLng:     Number,
  // Gói giặt
  packageId:     String,
  packageName:   String,
  turnaround:    String,   // "5h"|"10h"|"24h"
  estimatedKg:   Number,
  pricePerKg:    Number,
  estimatedTotal: Number,
  finalTotal:    Number,
  shipFee:       Number,
  discount:      Number,
  voucherCode:   String,
  // Payment
  paymentMethod: { type: String, default: "cash" },
  paymentStatus: { type: String, default: "unpaid" },
  // Timing
  pickupTime:    Date,     // thời điểm lấy đồ
  deadline:      Date,     // deadline hoàn thành
  deliveredAt:   Date,
  // Countdown
  countdownStarted: Date,  // khi partner bắt đầu đếm ngược
  // Status
  status: {
    type: String,
    enum: ["pending","partner_accepted","shipper_picking","picked_up_by_shipper",
           "at_partner","washing","countdown","ready_return","shipper_returning",
           "delivered","cancelled"],
    default: "pending",
  },
  statusHistory: [{ status: String, by: String, time: { type: Date, default: Date.now } }],
  sePayRef:      String,
  note:          String,
}, { timestamps: true });

laundryOrderSchema.pre("save", function(next) {
  if (!this.orderId) this.orderId = "LAU-" + Date.now().toString(36).toUpperCase();
  next();
});
const LaundryOrder = mongoose.models.LaundryOrder || mongoose.model("LaundryOrder", laundryOrderSchema);

// GET /api/laundry/providers — Danh sách cửa hàng giặt là active
app.get("/api/laundry/providers", async (req, res) => {
  try {
    const providers = await GiatLa.find({ status: "approved", isAccepting: true })
      .select("bizName address district rating totalOrders packages pricePerKg openTime closeTime lastLat lastLng")
      .sort({ rating: -1 });
    res.json({ success: true, providers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/providers/:id — Chi tiết provider + packages
app.get("/api/laundry/providers/:id", async (req, res) => {
  try {
    const p = await GiatLa.findById(req.params.id)
      .select("bizName address district rating packages pricePerKg openTime closeTime lastLat lastLng isAccepting");
    if (!p) return res.status(404).json({ success: false });
    res.json({ success: true, provider: p });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/providers/:id/services — Packages của provider
app.get("/api/laundry/providers/:id/services", async (req, res) => {
  try {
    const p = await GiatLa.findById(req.params.id).select("packages pricePerKg bizName");
    if (!p) return res.status(404).json({ success: false });
    // Nếu chưa có packages, dùng default
    const defaultPackages = [
      { id:"fast5",  name:"Giặt + Sấy nhanh 5h",  description:"Hoàn thành trong 5 tiếng", pricePerKg: p.pricePerKg||30000, minKg:2, turnaround:"5h",  available:true },
      { id:"std10",  name:"Giặt tiêu chuẩn 10h",  description:"Giặt sạch, sấy khô, gấp gọn", pricePerKg: (p.pricePerKg||30000)*0.8, minKg:2, turnaround:"10h", available:true },
      { id:"eco24",  name:"Giặt tiết kiệm 24h",   description:"Giá tốt nhất, hoàn thành trong 24h", pricePerKg: (p.pricePerKg||30000)*0.65, minKg:3, turnaround:"24h", available:true },
      { id:"dry",    name:"Giặt khô chuyên dụng", description:"Vest, áo dài, đồ len", pricePerKg: (p.pricePerKg||30000)*2, minKg:1, turnaround:"24h", available:true },
    ];
    const services = p.packages?.length ? p.packages.filter(pk => pk.available) : defaultPackages;
    res.json({ success: true, services, provider: { bizName: p.bizName } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/laundry/order — Khách đặt đơn giặt
app.post("/api/laundry/order", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { providerId, packageId, packageName, turnaround, estimatedKg, pricePerKg,
            pickupAddress, pickupLat, pickupLng, paymentMethod, voucherCode, note } = req.body;
    if (!providerId || !packageId || !turnaround || !pickupAddress)
      return res.status(400).json({ success: false, message: "Thiếu thông tin đặt đơn" });

    const user     = await User.findById(req.session.userId).select("fullName phone");
    const provider = await GiatLa.findById(providerId).select("bizName isAccepting lastLat lastLng");
    if (!provider) return res.status(404).json({ success: false, message: "Không tìm thấy cửa hàng" });
    if (!provider.isAccepting) return res.status(400).json({ success: false, message: "Cửa hàng đang tạm nghỉ" });

    const kg           = estimatedKg || 2;
    const price        = pricePerKg  || 30000;
    const estimatedTotal = kg * price;
    // Phí ship: 5000đ/km, tính từ địa chỉ khách đến partner
    const R = 6371;
    let distKm = 3; // default 3km nếu chưa có tọa độ partner
    if (provider.lastLat && pickupLat) {
      const dLat = (parseFloat(pickupLat) - provider.lastLat) * Math.PI / 180;
      const dLng = (parseFloat(pickupLng) - provider.lastLng) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(provider.lastLat*Math.PI/180)*Math.cos(parseFloat(pickupLat)*Math.PI/180)*Math.sin(dLng/2)**2;
      distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    const shipFee = Math.round(distKm * 5000 / 1000) * 1000 * 2; // đi + về

    // Validate voucher
    let discount = 0;
    if (voucherCode) {
      const v = await Voucher.findOne({ code: voucherCode.toUpperCase(), active: true, expiresAt: { $gt: new Date() } });
      if (v) {
        discount = v.type === "percent"
          ? Math.min(Math.round(estimatedTotal * v.value / 100), v.maxDiscount || Infinity)
          : v.value;
      }
    }

    // Deadline
    const turnaroundMap = { "5h": 5*3600000, "10h": 10*3600000, "24h": 24*3600000 };
    const deadline = new Date(Date.now() + (turnaroundMap[turnaround] || 24*3600000));

    const order = new LaundryOrder({
      customerId:    req.session.userId,
      partnerId:     providerId,
      customerName:  user?.fullName || "Khách hàng",
      customerPhone: user?.phone,
      partnerName:   provider.bizName,
      pickupAddress, pickupLat, pickupLng,
      packageId, packageName, turnaround,
      estimatedKg: kg, pricePerKg: price,
      estimatedTotal, shipFee, discount,
      finalTotal:  estimatedTotal + shipFee - discount,
      voucherCode, paymentMethod: paymentMethod || "cash",
      deadline, note,
      statusHistory: [{ status: "pending", by: "customer" }],
    });
    await order.save();

    // Thông báo partner
    req.io.to(`partner_${providerId}`).emit("new_laundry_order", {
      order: {
        _id: order._id, orderId: order.orderId,
        customerName: order.customerName, pickupAddress: order.pickupAddress,
        packageName: order.packageName, turnaround: order.turnaround,
        estimatedKg: order.estimatedKg, estimatedTotal: order.estimatedTotal,
        deadline: order.deadline, note: order.note,
      }
    });

    res.status(201).json({ success: true, order, orderId: order.orderId });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/orders/my — Customer lấy đơn của mình
app.get("/api/laundry/orders/my", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const orders = await LaundryOrder.find({ customerId: req.session.userId }).sort({ createdAt: -1 }).limit(30);
    res.json({ success: true, orders });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/orders/:id
app.get("/api/laundry/orders/:id", async (req, res) => {
  try {
    const order = await LaundryOrder.findOne({ $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }] });
    if (!order) return res.status(404).json({ success: false });
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/laundry/orders/:id/status — Cập nhật trạng thái đơn giặt
app.patch("/api/laundry/orders/:id/status", async (req, res) => {
  try {
    const { status, finalKg, note } = req.body;
    const isPartner  = !!req.session.partnerId;
    const isShipper  = !!req.session.shipperId;
    const isCustomer = !!req.session.userId;

    const order = await LaundryOrder.findOne({
      $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }]
    });
    if (!order) return res.status(404).json({ success: false });

    order.status = status;
    order.statusHistory.push({ status, by: isPartner?"partner":isShipper?"shipper":"customer", time: new Date() });

    if (status === "partner_accepted") {
      // Partner nhận đơn → tìm shipper gần nhất đến địa chỉ khách
      if (order.pickupLat && order.pickupLng) {
        const nearby = await findNearbyShippers(order.pickupLat, order.pickupLng, 8, 5);
        if (nearby.length) {
          const pickupPayload = {
            type: "laundry_pickup_request",
            orderId: order.orderId,
            pickupAddress: order.pickupAddress,
            pickupLat: order.pickupLat, pickupLng: order.pickupLng,
            partnerAddress: `${order.partnerName}`,
            partnerLat: null, partnerLng: null,
            customerName: order.customerName,
            packageName: order.packageName,
            shipFee: order.shipFee,
            timeout: 30,
          };
          for (const s of nearby) req.io.to(`shipper_${s._id}`).emit("order_request", pickupPayload);
        }
      }
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "partner_accepted",
        message: "Cửa hàng đã xác nhận đơn! Đang tìm shipper đến lấy đồ...",
      });
    }

    if (status === "at_partner") {
      // Shipper đã đưa đồ đến partner → partner bắt đầu countdown
      order.countdownStarted = new Date();
      req.io.to(`partner_${order.partnerId}`).emit("laundry_order_arrived", {
        orderId: order.orderId, packageName: order.packageName,
        turnaround: order.turnaround, deadline: order.deadline,
      });
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "at_partner",
        message: `Đồ đã đến cửa hàng! Đang giặt — deadline: ${order.deadline?.toLocaleString("vi-VN")}`,
      });
    }

    if (status === "countdown") {
      // Partner bắt đầu giặt → emit countdown cho customer
      req.io.to(`customer_${order.customerId}`).emit("laundry_countdown", {
        orderId: order.orderId,
        deadline: order.deadline,
        message: `Đang giặt! Xong trước ${order.deadline?.toLocaleString("vi-VN")}`,
      });
    }

    if (status === "ready_return") {
      // Partner done → cân đồ, tính tiền, tìm shipper trả
      if (finalKg) {
        order.finalTotal = Math.round(finalKg * order.pricePerKg + order.shipFee - order.discount);
        order.estimatedKg = finalKg;
      }
      // Tìm shipper đến lấy ở partner
      const nearby = await findNearbyShippers(
        order.pickupLat || 21.0285, order.pickupLng || 105.8542, 8, 5
      );
      const returnPayload = {
        type: "laundry_return_request",
        orderId: order.orderId,
        pickupAddress: `${order.partnerName} — Lấy đồ đã giặt`,
        deliveryAddress: order.pickupAddress,
        customerName: order.customerName,
        packageName: order.packageName,
        shipFee: Math.round(order.shipFee / 2), // shipper về nhận 1 chiều
        timeout: 30,
      };
      for (const s of nearby) req.io.to(`shipper_${s._id}`).emit("order_request", returnPayload);
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "ready_return",
        message: "Đồ đã sạch! Đang tìm shipper trả đồ về cho bạn...",
      });
    }

    if (status === "delivered") {
      order.deliveredAt = new Date();
      order.paymentStatus = order.paymentMethod === "cash" ? "paid" : order.paymentStatus;
      // Tính phân chia: shipper 100% shipfee, partner 82% tiền giặt (CRABOR giữ 18%)
      const partnerEarn = Math.round((order.finalTotal - order.shipFee) * 0.82);
      const shipperEarn = order.shipFee;
      if (order.shipperId)  await addToWalletQueue(order.orderId, order.shipperId,  "shipper",  shipperEarn, order.paymentMethod, `Giặt là ${order.orderId}`);
      if (order.partnerId)  await addToWalletQueue(order.orderId, order.partnerId,  "partner",  partnerEarn, order.paymentMethod, `Giặt là ${order.orderId}`);
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "delivered",
        message: "Đồ đã được trả! Cảm ơn bạn đã dùng CRABOR Giặt là 👕",
      });
    }

    await order.save();
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/partner/orders — Partner xem đơn giặt của mình
app.get("/api/laundry/partner/orders", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false });
    const { status } = req.query;
    const filter = { partnerId: req.session.partnerId };
    if (status) filter.status = status;
    const orders = await LaundryOrder.find(filter).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, orders });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/laundry/partner/packages — Partner cập nhật gói giặt
app.patch("/api/laundry/partner/packages", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false });
    const { packages } = req.body;
    if (!Array.isArray(packages)) return res.status(400).json({ success: false, message: "packages phải là array" });
    const updated = await GiatLa.findByIdAndUpdate(req.session.partnerId, { packages }, { new: true });
    res.json({ success: true, packages: updated.packages });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/laundry/partner/accepting — Partner bật/tắt nhận đơn
app.patch("/api/laundry/partner/accepting", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false });
    const { accepting } = req.body;
    await GiatLa.findByIdAndUpdate(req.session.partnerId, { isAccepting: accepting });
    res.json({ success: true, isAccepting: accepting });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/partner/me — Partner xem thông tin của mình
app.get("/api/laundry/partner/me", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false });
    const p = await GiatLa.findById(req.session.partnerId);
    res.json({ success: true, partner: p });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════════════════════════
//  SHIPPER AUTH — No OTP (check-account + password)
// ══════════════════════════════════════════════════════════════

// POST /api/shipper/check-account
app.post("/api/shipper/check-account", async (req, res) => {
  try {
    const { phone, email } = req.body;
    const query = phone ? { phone: normalizePhone(phone) } : { email: email?.toLowerCase().trim() };
    const shipper = await Shipper.findOne(query).select("_id password status rejectReason");
    if (!shipper) return res.json({ success: true, exists: false });
    
    console.log('[CheckAccount] Found:', shipper._id, 'hasPassword:', !!shipper.password, 'status:', shipper.status);
    
    res.json({ 
      success: true, 
      exists: true, 
      hasPassword: !!(shipper.password),
      status: shipper.status,
      rejectReason: shipper.rejectReason || null
    });
  } catch(err) { 
    console.error('[CheckAccount] Error:', err);
    res.status(500).json({ success: false, message: err.message }); 
  }
});

// POST /api/shipper/login — đăng nhập bằng password
app.post("/api/shipper/login", async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: "Thiếu mật khẩu" });
    const query = phone ? { phone: normalizePhone(phone) } : { email: email?.toLowerCase().trim() };
    const shipper = await Shipper.findOne(query);
    if (!shipper) return res.status(404).json({ success: false, message: "Tài khoản không tồn tại" });
    if (!shipper.password) return res.status(400).json({ success: false, message: "Chưa thiết lập mật khẩu" });
    const bcrypt  = require("bcryptjs");
    const isMatch = await bcrypt.compare(password, shipper.password);
    if (!isMatch) return res.status(401).json({ success: false, message: "Mật khẩu không đúng" });

    if (shipper.status === 'rejected') {
      return res.status(403).json({ success: false, status: 'rejected', message: "Tài khoản bị từ chối" });
    }

    req.session.shipperId = shipper._id;
    req.session.userPhone = shipper.phone;
    req.session.role = "shipper";
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // FIX: build signed cookie đúng format (có HMAC signature)
    const sessionCookieValue = buildSignedSessionCookie(req.session.id);

    console.log('[Login] Success:', shipper.phone, 'Session:', req.session.id);
    res.json({
      success: true,
      shipper: { _id: shipper._id, fullName: shipper.fullName, phone: shipper.phone, status: shipper.status },
      cookie: sessionCookieValue,
      sessionId: req.session.id,
      status: shipper.status
    });
  } catch(err) {
    console.error('[Login] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/shipper/set-password — tạo mật khẩu lần đầu
app.post("/api/shipper/set-password", async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    console.log('[SetPassword] Request:', { phone, email, passwordLength: password?.length });
    
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: "Mật khẩu tối thiểu 6 ký tự" });
    }
    
    const query = phone ? { phone: normalizePhone(phone) } : { email: email?.toLowerCase().trim() };
    console.log('[SetPassword] Query:', query);
    
    const shipper = await Shipper.findOne(query);
    if (!shipper) {
      return res.status(404).json({ success: false, message: "Tài khoản không tồn tại" });
    }
    
    console.log('[SetPassword] Found shipper:', shipper._id, shipper.phone);
    
    const bcrypt = require("bcryptjs");
    const hashedPw = await bcrypt.hash(password, 10);
    await Shipper.findByIdAndUpdate(shipper._id, { password: hashedPw });
    
    console.log('[SetPassword] Password saved for:', shipper.phone);
    
    // Tạo session
    req.session.shipperId = shipper._id;
    req.session.userPhone = shipper.phone;
    req.session.role = "shipper";
    
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // FIX: build signed cookie đúng format (có HMAC signature)
    const sessionCookieValue = buildSignedSessionCookie(req.session.id);
    
    console.log('[SetPassword] Session created:', req.session.id);
    
    res.json({ 
      success: true, 
      shipper: { 
        _id: shipper._id, 
        fullName: shipper.fullName, 
        phone: shipper.phone, 
        status: shipper.status 
      }, 
      cookie: sessionCookieValue,
      sessionId: req.session.id 
    });
  } catch(err) { 
    console.error('[SetPassword] Error:', err);
    res.status(500).json({ success: false, message: err.message }); 
  }
});


// ══════════════════════════════════════════════════════════════
//  PAYOS INTEGRATION
// ══════════════════════════════════════════════════════════════
let payOS = null;
try {
  let PayOSLib = require("@payos/node");
  // v1.x exports class directly; v2.x exports { default: PayOS }
  const PayOSClass = PayOSLib.default || PayOSLib;
  payOS = new PayOSClass({
    clientId:    process.env.PAYOS_CLIENT_ID    || "94156c0e-dd25-45e0-aac9-75148eed142e",
    apiKey:      process.env.PAYOS_API_KEY      || "89cdfbd7-5a3b-46b2-99d7-1395d3d14840",
    checksumKey: process.env.PAYOS_CHECKSUM_KEY || "0940b669da1439031c9f179309674890cb8aaebfa81777da0756b7f870467168",
  });
  console.log("[OK] PayOS initialized");
} catch(e) {
  console.warn("[WARN] PayOS not available:", e.message);
}

// POST /api/payment/payos/create — Tạo link thanh toán PayOS
app.post("/api/payment/payos/create", async (req, res) => {
  try {
    const { orderId, amount, description, returnUrl, cancelUrl, items, buyerName, buyerPhone, buyerEmail } = req.body;
    if (!orderId || !amount || !description)
      return res.status(400).json({ success: false, message: "Thiếu thông tin thanh toán" });

    // orderCode phải là số nguyên dương
    const orderCode = parseInt(Date.now().toString().slice(-9));

    // Nếu PayOS chưa khởi tạo, fallback sang QR VietQR/SePay
    if (!payOS) {
      const bankCode = process.env.SEPAY_BANK_CODE || "MB";
      const accountNo = process.env.SEPAY_ACCOUNT || "";
      const safeDesc = description.replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 25);
      const qrUrl = `https://img.vietqr.io/image/${bankCode}-${accountNo}-print.png?amount=${Math.round(amount)}&addInfo=${encodeURIComponent(safeDesc)}`;
      return res.json({
        success: true,
        checkoutUrl: qrUrl,
        qrCode: qrUrl,
        orderCode,
        paymentLinkId: null,
        isFallback: true,
      });
    }

    const paymentData = {
      orderCode,
      amount:      Math.round(amount),
      description: description.slice(0, 25), // PayOS giới hạn 25 ký tự
      returnUrl:   returnUrl  || `${process.env.BASE_URL || "https://crabor-shipper-register.onrender.com"}/payment/success?orderId=${orderId}`,
      cancelUrl:   cancelUrl  || `${process.env.BASE_URL || "https://crabor-shipper-register.onrender.com"}/payment/cancel?orderId=${orderId}`,
      ...(items && { items }),
      ...(buyerName  && { buyerName }),
      ...(buyerPhone && { buyerPhone }),
      ...(buyerEmail && { buyerEmail }),
    };

    // PayOS SDK: dùng createPaymentLink() (v2.x) với fallback paymentRequests.create() (v1.x)
    let paymentLink;
    if (typeof payOS.createPaymentLink === 'function') {
      paymentLink = await payOS.createPaymentLink(paymentData);
    } else if (payOS.paymentRequests?.create) {
      paymentLink = await payOS.paymentRequests.create(paymentData);
    } else {
      throw new Error('PayOS SDK không hợp lệ - không tìm thấy createPaymentLink');
    }

    // Lưu mapping orderCode <-> orderId để webhook match
    await require("mongoose").models.Order?.findOneAndUpdate(
      { orderId },
      { payosOrderCode: orderCode, payosCheckoutUrl: paymentLink.checkoutUrl },
    );

    res.json({
      success:     true,
      checkoutUrl: paymentLink.checkoutUrl,
      paymentLinkId: paymentLink.paymentLinkId,
      orderCode,
      qrCode:      paymentLink.qrCode,
    });
  } catch(err) {
    console.error("[PayOS create]", err);
    res.status(500).json({ success: false, message: err.message || "Tạo link thanh toán thất bại" });
  }
});

// GET /api/payment/payos/:orderCode — Kiểm tra trạng thái thanh toán
app.get("/api/payment/payos/:orderCode", async (req, res) => {
  try {
    if (!payOS) return res.status(503).json({ success: false });
    // PayOS v2.x: getPaymentLinkInformation(orderCode)
    // PayOS v1.x: paymentRequests.getById({ id })
    let info;
    if (typeof payOS.getPaymentLinkInformation === 'function') {
      info = await payOS.getPaymentLinkInformation(req.params.orderCode);
    } else {
      info = await payOS.paymentRequests?.getById?.({ id: req.params.orderCode });
    }
    res.json({ success: true, payment: info });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/payment/payos/:orderCode/cancel — Huỷ link thanh toán
app.delete("/api/payment/payos/:orderCode/cancel", async (req, res) => {
  try {
    if (!payOS) return res.status(503).json({ success: false });
    if (typeof payOS.cancelPaymentLink === 'function') {
      await payOS.cancelPaymentLink(req.params.orderCode);
    } else {
      await payOS.paymentRequests?.cancel?.({ id: req.params.orderCode });
    }
    res.json({ success: true, message: "Đã huỷ link thanh toán" });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/payment/payos/webhook — Webhook nhận kết quả từ PayOS
app.post("/api/payment/payos/webhook", async (req, res) => {
  try {
    const webhookData = req.body;
    // Verify webhook signature
    let verified = false;
    try {
      verified = payOS?.webhook?.verifySignature?.(webhookData) ?? true;
    } catch(_) { verified = true; } // skip nếu verify method không tồn tại

    if (!verified) return res.status(400).json({ success: false, message: "Invalid signature" });

    const { orderCode, status, amount } = webhookData.data || webhookData;

    if (status === "PAID" || status === "00") {
      // Tìm order theo payosOrderCode
      const Order = require("mongoose").models.Order;
      const order = Order ? await Order.findOne({ payosOrderCode: String(orderCode) }) : null;

      if (order && order.paymentStatus !== "paid") {
        order.paymentStatus = "paid";
        order.paidAt        = new Date();
        order.statusHistory.push({ status: "payment_confirmed_payos", by: "system" });
        await order.save();

        // Tính tiền và add vào wallet queue
        const { shipperEarn, partnerEarn } = calcEarnings(order);
        if (order.shipperId) await addToWalletQueue(order.orderId, order.shipperId, "shipper", shipperEarn, "payos", `Đơn ${order.orderId} — PayOS`);
        if (order.partnerId) await addToWalletQueue(order.orderId, order.partnerId, "partner", partnerEarn, "payos", `Đơn ${order.orderId} — PayOS`);

        // Notify qua socket
        global._io?.to(`customer_${order.customerId}`).emit("order_status_update", {
          orderId: order.orderId, status: "payment_confirmed",
          message: "Thanh toán thành công qua PayOS! 🎉",
        });
        if (order.shipperId) {
          global._io?.to(`shipper_${order.shipperId}`).emit("sepay_payment_confirmed", {
            orderId: order.orderId, amount,
            message: `Khách đã thanh toán ${amount?.toLocaleString("vi-VN")}đ qua PayOS!`,
          });
        }
        global._io?.to("admin").emit("wallet_pending_approval", {
          orderId: order.orderId, shipperEarn, partnerEarn, paymentMethod: "payos",
        });
        console.log(`[PayOS Webhook] Order ${order.orderId} PAID — ${amount?.toLocaleString("vi-VN")}đ`);
      }
    }
    res.json({ success: true });
  } catch(err) {
    console.error("[PayOS Webhook]", err);
    res.status(500).json({ success: false });
  }
});

// GET /payment/success — Trang redirect sau thanh toán thành công (web)
app.get("/payment/success", (req, res) => {
  const { orderId, orderCode } = req.query;
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Thanh toán thành công</title>
  <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#f0fff4}
  .icon{font-size:80px}.title{font-size:28px;font-weight:900;color:#27AE60;margin:16px 0}
  .sub{color:#666;font-size:16px}.btn{display:inline-block;margin-top:24px;padding:14px 36px;
  background:#E8504A;color:#fff;border-radius:12px;text-decoration:none;font-weight:800;font-size:15px}</style></head>
  <body><div class="icon">✅</div>
  <div class="title">Thanh toán thành công!</div>
  <div class="sub">Đơn hàng #${orderId || orderCode} đã được thanh toán.<br>Bạn có thể đóng trang này.</div>
  <a href="craborcustomer://payment/success?orderId=${orderId}" class="btn">Quay về app →</a>
  <script>setTimeout(()=>{window.location="craborcustomer://payment/success?orderId=${orderId}"},1000)</script>
  </body></html>`);
});

// GET /payment/cancel — Trang redirect sau khi huỷ
app.get("/payment/cancel", (req, res) => {
  const { orderId } = req.query;
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Thanh toán bị huỷ</title>
  <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#fff5f5}
  .icon{font-size:80px}.title{font-size:28px;font-weight:900;color:#E8504A;margin:16px 0}
  .sub{color:#666;font-size:16px}.btn{display:inline-block;margin-top:24px;padding:14px 36px;
  background:#E8504A;color:#fff;border-radius:12px;text-decoration:none;font-weight:800;font-size:15px}</style></head>
  <body><div class="icon">❌</div>
  <div class="title">Thanh toán bị huỷ</div>
  <div class="sub">Bạn đã huỷ giao dịch cho đơn #${orderId}.<br>Đơn hàng vẫn được giữ nguyên.</div>
  <a href="craborcustomer://payment/cancel?orderId=${orderId}" class="btn">Quay về app →</a>
  </body></html>`);
});

// POST /api/auth/test-login — Đăng nhập nhanh bằng test account admin
app.post("/api/auth/test-login", async (req, res) => {
  try {
    const { role } = req.body; // "customer" | "shipper" | "partner"
    const bcrypt = require("bcryptjs");
    const TEST_PASS = "Crabor@2025";

    if (role === "customer" || !role) {
      const user = await User.findOne({ phone: "0999999999" });
      if (!user) return res.status(404).json({ success: false, message: "Test account chưa được tạo. Restart server." });
      req.session.userId = user._id;
      req.session.userPhone = user.phone;
      await new Promise((r, j) => req.session.save(e => e ? j(e) : r()));
      const cookieStr = buildSignedSessionCookie(req.session.id);
      return res.json({ success: true, role: "customer", cookie: cookieStr,
        user: { _id: user._id, fullName: user.fullName, phone: user.phone, isAdmin: true, totalOrders: user.totalOrders, walletBalance: user.walletBalance } });
    }

    if (role === "shipper") {
      const shipper = await Shipper.findOne({ phone: "0888888888" });
      if (!shipper) return res.status(404).json({ success: false, message: "Test account shipper chưa được tạo. Restart server." });
      req.session.shipperId = shipper._id;
      req.session.userPhone = shipper.phone;
      req.session.role = "shipper";
      await new Promise((r, j) => req.session.save(e => e ? j(e) : r()));
      const cookieStr = buildSignedSessionCookie(req.session.id);
      return res.json({ success: true, role: "shipper", cookie: cookieStr,
        shipper: { _id: shipper._id, fullName: shipper.fullName, phone: shipper.phone, status: shipper.status } });
    }

    if (role === "partner") {
      const partner = await FoodPartner.findOne({ phone: "0777777777" });
      if (!partner) return res.status(404).json({ success: false, message: "Test account partner chưa được tạo. Restart server." });
      req.session.partnerId = partner._id;
      req.session.userPhone = partner.phone;
      req.session.partnerModule = "food_partner";
      req.session.role = "partner";
      await new Promise((r, j) => req.session.save(e => e ? j(e) : r()));
      const cookieStr = buildSignedSessionCookie(req.session.id);
      return res.json({ success: true, role: "partner", cookie: cookieStr,
        partner: { _id: partner._id, bizName: partner.bizName, phone: partner.phone }, module: "food_partner" });
    }

    res.status(400).json({ success: false, message: "role không hợp lệ" });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
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

// ══════════════════════════════════════════════════════════════
//  WALLET PENDING QUEUE SCHEMA
// ══════════════════════════════════════════════════════════════
const walletQueueSchema = new mongoose.Schema({
  orderId:        { type: String, required: true },
  recipientId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  recipientType:  { type: String, enum: ["shipper","partner"], required: true },
  amount:         { type: Number, required: true, min: 0 },
  note:           { type: String },
  paymentMethod:  { type: String },
  status:         { type: String, enum: ["pending","approved","rejected"], default: "pending" },
  approvedBy:     String,
  approvedAt:     Date,
  rejectedReason: String,
  releaseAt:      { type: Date, default: null }, // null = cần admin duyệt thủ công; có date = auto-approve
}, { timestamps: true });
const WalletQueue = mongoose.models.WalletQueue || mongoose.model("WalletQueue", walletQueueSchema);

// ── Cron: Auto-approve wallet queue sau 30 phút (mỗi phút check) ──
setInterval(async () => {
  try {
    const now = new Date();
    const readyItems = await WalletQueue.find({
      status: "pending",
      releaseAt: { $lte: now, $ne: null },
    });
    for (const item of readyItems) {
      // Cộng tiền vào ví
      if (item.recipientType === "shipper") {
        await Shipper.findByIdAndUpdate(item.recipientId, {
          $inc: { walletBalance: item.amount, totalEarnings: item.amount }
        });
      } else {
        const pModels = [
          mongoose.models.FoodPartner, mongoose.models.GiatLa,
          mongoose.models.GiupViec,   mongoose.models.ChinaShop,
        ].filter(Boolean);
        for (const m of pModels) {
          const upd = await m.findByIdAndUpdate(item.recipientId, {
            $inc: { walletBalance: item.amount, totalSales: item.amount }
          });
          if (upd) break;
        }
      }
      item.status     = "approved";
      item.approvedBy = "auto_cron";
      item.approvedAt = now;
      await item.save();

      // Notify qua socket
      const roomKey = item.recipientType === "shipper"
        ? `shipper_${item.recipientId}`
        : `partner_${item.recipientId}`;
      // io có thể chưa sẵn sàng lúc module load — dùng global io
      try {
        global._io?.to(roomKey).emit("wallet_credited", {
          amount:  item.amount,
          orderId: item.orderId,
          message: `+${item.amount.toLocaleString("vi-VN")}đ đã vào ví (tự động duyệt sau 30 phút)!`,
        });
      } catch (_) {}
    }
    if (readyItems.length > 0) {
      console.log(`[CRON] Auto-approved ${readyItems.length} wallet queue items`);
    }
  } catch (e) {
    console.error("[CRON wallet-queue]", e.message);
  }
}, 60 * 1000); // check mỗi 60 giây

// ── Helper: tính commission shipper & partner ─────────────────
function calcEarnings(order) {
  const total = order.finalTotal || order.total || 0;
  const shipFee = order.shipFee || 0;
  // Shipper nhận toàn bộ phí ship
  const shipperEarn = shipFee;
  // Partner nhận total trừ ship, trừ 15% commission CRABOR
  const partnerEarn = Math.round((total - shipFee) * 0.85);
  return { shipperEarn, partnerEarn };
}

// ── Helper: thêm vào wallet pending queue ─────────────────────
async function addToWalletQueue(orderId, recipientId, recipientType, amount, paymentMethod, note) {
  if (amount <= 0) return;
  await WalletQueue.create({ orderId, recipientId, recipientType, amount, paymentMethod, note });
}

// ══════════════════════════════════════════════════════════════
//  SOCKET ROOMS — join shipper/partner room khi connect
// ══════════════════════════════════════════════════════════════
// Đã có io.on("connection") ở trên — extend thêm events
// Thêm vào trong connection handler qua middleware
io.use((socket, next) => {
  // Parse cookie để lấy session (socket không có req.session)
  socket.data.rooms = [];
  next();
});

// ── Helper: find nearby shippers ─────────────────────────────
async function findNearbyShippers(lat, lng, radiusKm = 5, limit = 5) {
  // Lấy shipper online + isAccepting, có hoặc không có location
  const shippers = await Shipper.find({
    status: { $in: ["approved", "active"] },
    online: true,
    isAccepting: true,
  }).select("_id phone fullName location pushToken walletBalance rating totalOrders");

  const R = 6371;
  const withDistance = shippers.map(s => {
    // Nếu shipper có location → tính khoảng cách thực
    if (s.location?.lat && s.location?.lng) {
      const dLat = (s.location.lat - lat) * Math.PI / 180;
      const dLng = (s.location.lng - lng) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 +
        Math.cos(lat * Math.PI/180) * Math.cos(s.location.lat * Math.PI/180) * Math.sin(dLng/2)**2;
      const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return { ...s.toObject(), distKm: Math.round(dist * 10) / 10 };
    }
    // Shipper không có GPS location → fallback distance = 0 (ưu tiên nhận đơn)
    return { ...s.toObject(), distKm: 0, noLocation: true };
  });

  // Nếu có shipper với location trong radius → chỉ lấy họ
  const inRadius = withDistance.filter(s => !s.noLocation && s.distKm <= radiusKm);
  if (inRadius.length > 0) {
    return inRadius.sort((a, b) => a.distKm - b.distKm).slice(0, limit);
  }
  
  // Fallback: không có shipper trong radius → lấy tất cả shipper online (kể cả không có GPS)
  console.log(`[findNearbyShippers] No shipper in ${radiusKm}km radius, using all online shippers`);
  return withDistance.sort((a, b) => a.distKm - b.distKm).slice(0, limit);
}

// ── Helper: dispatch order đến shipper online gần nhất ────────
async function dispatchToShippers(order, io) {
  try {
    // Lấy địa chỉ partner để biết lat/lng pickup
    let pickupLat, pickupLng;
    const FoodPartner = mongoose.models.FoodPartner;
    if (FoodPartner && order.partnerId) {
      const p = await FoodPartner.findById(order.partnerId).select("lastLat lastLng");
      if (p?.lastLat) { pickupLat = p.lastLat; pickupLng = p.lastLng; }
    }
    // Fallback: dùng vị trí customer
    if (!pickupLat) { pickupLat = 21.0285; pickupLng = 105.8542; } // Hà Nội default

    const nearby = await findNearbyShippers(pickupLat, pickupLng, 8, 10);
    if (!nearby.length) return false;

    const payload = {
      type: "new_order_request",
      orderId: order.orderId,
      order: {
        _id: order._id,
        orderId: order.orderId,
        items: order.items,
        total: order.finalTotal || order.total,
        shipFee: order.shipFee,
        pickupAddress: order.partnerAddress || "Địa chỉ quán",
        pickupLat, pickupLng,
        deliveryAddress: order.address,
        note: order.note,
        customerName: order.customerName,
        module: order.module,
      },
      timeout: 30, // giây để shipper phản hồi
    };

    // Gửi đến từng shipper qua socket room
    for (const s of nearby) {
      io.to(`shipper_${s._id}`).emit("order_request", payload);
    }

    // Lưu danh sách shipper đã được gửi vào order để tracking
    await Order.findByIdAndUpdate(order._id, {
      $set: { dispatchedTo: nearby.map(s => s._id), dispatchedAt: new Date() }
    });

    return nearby.length;
  } catch (e) {
    console.error("dispatchToShippers error:", e.message);
    return false;
  }
}

// ── Helper: dispatch order đến shipper online gần nhất (v2 - hỗ trợ ride + food) ─
async function dispatchOrderToNearbyShippers(order, io) {
  try {
    let pickupLat, pickupLng;

    if (order.module === 'food' && order.partnerId) {
      const FoodPartner = mongoose.models.FoodPartner;
      if (FoodPartner) {
        const partner = await FoodPartner.findById(order.partnerId).select("lastLat lastLng location");
        if (partner?.lastLat) {
          pickupLat = partner.lastLat;
          pickupLng = partner.lastLng;
        } else if (partner?.location?.lat) {
          pickupLat = partner.location.lat;
          pickupLng = partner.location.lng;
        }
      }
    } else if (order.module === 'ride') {
      pickupLat = order.pickupLat;
      pickupLng = order.pickupLng;
    }

    // Fallback về Hà Nội center
    if (!pickupLat) { pickupLat = 21.0285; pickupLng = 105.8542; }

    console.log('[Dispatch] Looking for shippers near:', pickupLat, pickupLng);

    const nearbyShippers = await findNearbyShippers(pickupLat, pickupLng, 5, 10);

    if (!nearbyShippers.length) {
      console.log('[Dispatch] No nearby shippers found');
      return 0;
    }

    console.log('[Dispatch] Found', nearbyShippers.length, 'nearby shippers');

    const payload = {
      type: "order_request",
      orderId: order.orderId,
      order: {
        _id: order._id,
        orderId: order.orderId,
        items: order.items,
        total: order.finalTotal || order.total,
        shipFee: order.shipFee,
        pickupAddress: order.partnerAddress || "Địa chỉ quán",
        pickupLat,
        pickupLng,
        deliveryAddress: order.address,
        note: order.note,
        customerName: order.customerName,
        module: order.module,
      },
      timeout: 30,
    };

    for (const shipper of nearbyShippers) {
      io.to(`shipper_${shipper._id}`).emit("order_request", payload);
      console.log('[Dispatch] Sent to shipper:', shipper._id, 'distance:', shipper.distKm, 'km');
    }

    await Order.findByIdAndUpdate(order._id, {
      $set: { dispatchedTo: nearbyShippers.map(s => s._id), dispatchedAt: new Date() }
    });

    return nearbyShippers.length;
  } catch (error) {
    console.error('[dispatchOrderToNearbyShippers] Error:', error);
    return 0;
  }
}

// ══════════════════════════════════════════════════════════════
//  FOOD ORDER WORKFLOW
// ══════════════════════════════════════════════════════════════

// POST /api/order — Khách đặt đồ ăn (override endpoint cũ)
app.post("/api/order", async (req, res) => {
  try {
    await loadSessionFromHeader(req);
    if (!req.session.userId)
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });

    const { partnerId, items, address, note, paymentMethod, voucherCode, shipFee, fromAddress, fromLat, fromLng, toAddress, toLat, toLng, vehicleType } = req.body;
    
    if (!items?.length && !fromAddress) 
      return res.status(400).json({ success: false, message: "Thiếu thông tin đơn hàng" });

    const user = await User.findById(req.session.userId).select("fullName phone");
    
    let order;
    
    // Xử lý đơn ride
    if (fromAddress && toAddress) {
      const total = shipFee || 30000;
      order = new Order({
        module: "ride",
        customerId: req.session.userId,
        items: [{ name: `Xe ${vehicleType || 'bike'} — ${fromAddress} → ${toAddress}`, qty: 1, price: total }],
        address: toAddress,
        fromAddress, fromLat, fromLng,
        toAddress, toLat, toLng,
        total,
        shipFee: 0,
        serviceFee: Math.round(total * 0.1),
        paymentMethod: paymentMethod || "cash",
        note,
        customerName: user?.fullName || "Khách hàng",
        pickupLat: parseFloat(fromLat),
        pickupLng: parseFloat(fromLng),
        statusHistory: [{ status: "pending", by: "customer" }],
      });
    } else {
      // Xử lý đơn food
      const FoodPartner = mongoose.models.FoodPartner;
      const partner = FoodPartner ? await FoodPartner.findById(partnerId).lean() : null;

      // FIX: dùng .lean() để lấy raw object, tránh Mongoose bỏ sót field isAccepting
      // Chỉ block nếu isAccepting EXPLICITLY là false (không block khi undefined/null)
      if (partner && partner.isAccepting === false) {
        console.log('[POST /api/order] Partner isAccepting=false, blocking order. partnerId:', partnerId);
        return res.status(400).json({ success: false, message: "Quán đang tạm dừng nhận đơn" });
      }

      const total = items.reduce((s, i) => s + (i.price * (i.qty || i.quantity || 1)), 0);
      const fShipFee = shipFee || 20000;
      const serviceFee = Math.round(total * 0.05);

      // Validate voucher nếu có
      let discount = 0;
      if (voucherCode) {
        const Voucher = mongoose.models.Voucher;
        if (Voucher) {
          const v = await Voucher.findOne({ code: voucherCode.toUpperCase(), active: true });
          if (v) discount = v.discount || 0;
        }
      }

      order = new Order({
        module: "food",
        customerId: req.session.userId,
        partnerId,
        items: items.map(i => ({
          productId: i._id || i.productId,
          name: i.name,
          qty: i.qty || i.quantity || 1,
          price: i.price,
        })),
        address,
        note,
        total,
        shipFee: fShipFee,
        serviceFee,
        discount,
        paymentMethod: paymentMethod || "cash",
        paymentStatus: paymentMethod === "cash" ? "unpaid" : "unpaid",
        voucherCode,
        customerName: user?.fullName || "Khách hàng",
        partnerAddress: partner?.address,
        statusHistory: [{ status: "pending", by: "customer" }],
      });

      // Thông báo partner có đơn mới
      if (partnerId) {
        req.io.to(`partner_${partnerId}`).emit("new_order", {
          order: {
            _id: order._id,
            orderId: order.orderId,
            items: order.items,
            total: order.finalTotal,
            address: order.address,
            note: order.note,
            customerName: order.customerName,
            paymentMethod: order.paymentMethod,
            createdAt: order.createdAt,
          }
        });
      }
    }
    
    await order.save();
    
    // GỬI ĐƠN ĐẾN SHIPPER NGAY LẬP TỨC
    let pickupLat, pickupLng;
    
    if (order.module === 'food' && order.partnerId) {
      const FoodPartner = mongoose.models.FoodPartner;
      const partner = await FoodPartner.findById(order.partnerId).select("lastLat lastLng location");
      if (partner?.lastLat) {
        pickupLat = partner.lastLat;
        pickupLng = partner.lastLng;
      } else if (partner?.location?.lat) {
        pickupLat = partner.location.lat;
        pickupLng = partner.location.lng;
      }
    } else if (order.module === 'ride') {
      pickupLat = order.pickupLat;
      pickupLng = order.pickupLng;
    }
    
    if (!pickupLat) {
      pickupLat = 21.0285;
      pickupLng = 105.8542;
    }
    
    const nearbyShippers = await findNearbyShippers(pickupLat, pickupLng, 5, 10);
    
    if (nearbyShippers.length > 0) {
      const payload = {
        type: "order_request",
        orderId: order.orderId,
        order: {
          _id: order._id,
          orderId: order.orderId,
          items: order.items,
          total: order.finalTotal || order.total,
          shipFee: order.shipFee,
          pickupAddress: order.partnerAddress || "Địa chỉ quán",
          pickupLat,
          pickupLng,
          deliveryAddress: order.address,
          note: order.note,
          customerName: order.customerName,
          module: order.module,
        },
        timeout: 30,
      };
      
      for (const shipper of nearbyShippers) {
        req.io.to(`shipper_${shipper._id}`).emit("order_request", payload);
        console.log(`[Order] Dispatched to shipper ${shipper._id} (distance: ${shipper.distanceKm}km)`);
      }
      
      await Order.findByIdAndUpdate(order._id, {
        $set: { dispatchedTo: nearbyShippers.map(s => s._id), dispatchedAt: new Date() }
      });
    } else {
      console.log(`[Order] No nearby shipper for order ${order.orderId}`);
    }
    
    req.io.to("admin").emit("newOrderNotification", { orderId: order.orderId, module: order.module, total: order.finalTotal });

    res.status(201).json({ success: true, order, orderId: order.orderId });
  } catch (err) {
    console.error('[Create Order] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/orders/:id/status — Cập nhật trạng thái đơn (partner/shipper)
// Đây là endpoint trung tâm xử lý toàn bộ workflow
app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const { status, partnerNote, shipperNote } = req.body;
    const isShipper = !!req.session.shipperId;
    const isPartner = !!req.session.partnerId;
    const isCustomer = !!req.session.userId;

    const order = await Order.findOne({ $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }] });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    const allowed = {
      // Partner actions
      confirmed:   isPartner,   // Partner xác nhận đơn
      preparing:   isPartner,   // Partner đang chuẩn bị
      ready:       isPartner,   // Partner đã chuẩn bị xong, gọi shipper
      // Shipper actions
      shipper_accepted: isShipper, // Shipper nhận cuốc
      picking_up:  isShipper,   // Shipper đang đến lấy
      picked_up:   isShipper,   // Shipper đã lấy đồ (partner xác nhận)
      delivering:  isShipper,   // Shipper đang giao
      delivered:   isShipper,   // Shipper đã giao xong
      // Customer
      cancelled:   isCustomer && order.status === "pending",
    };

    if (!allowed[status] && !req.session.adminId)
      return res.status(403).json({ success: false, message: `Không có quyền set status ${status}` });

    order.status = status;
    order.statusHistory.push({ status, by: isShipper ? "shipper" : isPartner ? "partner" : "customer", time: new Date() });

    // ── Khi partner xác nhận → dispatch shipper ──
    if (status === "confirmed" || status === "ready") {
      order.confirmedAt = new Date();
      if (status === "ready") {
        // Gọi shipper gần nhất
        const count = await dispatchToShippers(order, req.io);
        if (!count) {
          // Không có shipper → thông báo partner
          req.io.to(`partner_${order.partnerId}`).emit("no_shipper_available", { orderId: order.orderId });
        }
      }
    }

    // ── Khi shipper nhận cuốc ──
    if (status === "shipper_accepted") {
      order.shipperId = req.session.shipperId;
      // Thông báo customer
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId,
        status: "shipper_accepted",
        message: "Shipper đã nhận đơn và đang đến lấy hàng!",
      });
      // Thông báo partner
      req.io.to(`partner_${order.partnerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "shipper_accepted",
      });
    }

    // ── Khi shipper đã lấy hàng (picked_up) → partner + customer biết ──
    if (status === "picked_up") {
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "picked_up",
        message: "Shipper đã lấy hàng và đang trên đường giao đến bạn!",
      });
      req.io.to(`partner_${order.partnerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "picked_up",
      });
    }

    // ── Khi giao thành công (delivered) → xử lý thanh toán ──
    if (status === "delivered") {
      order.deliveredAt = new Date();
      order.paymentStatus = order.paymentMethod === "cash" ? "paid" : order.paymentStatus;

      // Tính tiền cho shipper và partner
      const { shipperEarn, partnerEarn } = calcEarnings(order);

      // Thêm vào pending queue (chờ admin duyệt)
      if (order.shipperId) {
        await addToWalletQueue(
          order.orderId, order.shipperId, "shipper", shipperEarn,
          order.paymentMethod, `Đơn ${order.orderId} — phí ship`
        );
      }
      if (order.partnerId) {
        await addToWalletQueue(
          order.orderId, order.partnerId, "partner", partnerEarn,
          order.paymentMethod, `Đơn ${order.orderId} — tiền hàng`
        );
      }

      // Thông báo customer
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "delivered",
        message: "Đơn hàng đã được giao thành công! Cảm ơn bạn đã dùng CRABOR 🦀",
      });

      // Thông báo admin để duyệt wallet
      req.io.to("admin").emit("wallet_pending_approval", {
        orderId: order.orderId,
        shipperEarn, partnerEarn,
        paymentMethod: order.paymentMethod,
      });
    }

    await order.save();

    // Broadcast cho tất cả room đang track đơn này
    req.io.to(`order_${order.orderId}`).emit("orderStatusChanged", {
      orderId: order.orderId, status, order,
    });

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  RIDE WORKFLOW — Đặt xe công nghệ
// ══════════════════════════════════════════════════════════════

// POST /api/ride/book — Override: tìm shipper gần nhất, broadcast cuốc
app.post("/api/ride/book", async (req, res) => {
  try {
    if (!req.session.userId)
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });

    const { vehicleType, fromAddress, fromLat, fromLng, toAddress, toLat, toLng, fee, note } = req.body;
    if (!vehicleType || !fromAddress || !toAddress || !fee)
      return res.status(400).json({ success: false, message: "Thiếu thông tin đặt xe" });

    const user = await User.findById(req.session.userId).select("fullName phone");

    // Tạo ride order
    const rideOrder = new Order({
      module: "ride",
      customerId: req.session.userId,
      items: [{ name: `Xe ${vehicleType} — ${fromAddress} → ${toAddress}`, qty: 1, price: fee }],
      address: toAddress,
      total: fee,
      shipFee: 0,
      serviceFee: Math.round(fee * 0.1),
      paymentMethod: "cash",
      note,
      customerName: user?.fullName || "Khách hàng",
      statusHistory: [{ status: "pending", by: "customer" }],
    });
    await rideOrder.save();

    // Tìm shipper gần nhất (dùng fromLat/fromLng của customer)
    const nearby = await findNearbyShippers(
      parseFloat(fromLat), parseFloat(fromLng), 5, 10
    );

    if (!nearby.length) {
      return res.json({
        success: true,
        booking: { orderId: rideOrder.orderId, status: "no_driver" },
        message: "Hiện tại không có tài xế gần bạn. Vui lòng thử lại sau.",
        noDriver: true,
      });
    }

    // Gửi ride request đến các shipper gần nhất
    const ridePayload = {
      type: "ride_request",
      orderId: rideOrder.orderId,
      vehicleType,
      fromAddress, fromLat, fromLng,
      toAddress, toLat, toLng,
      fee,
      note,
      customerName: user?.fullName || "Khách hàng",
      customerPhone: user?.phone,
      timeout: 30,
    };

    for (const s of nearby) {
      req.io.to(`shipper_${s._id}`).emit("ride_request", ridePayload);
    }

    // Lưu danh sách shipper đã gửi
    await Order.findByIdAndUpdate(rideOrder._id, {
      $set: { dispatchedTo: nearby.map(s => s._id), dispatchedAt: new Date() }
    });

    res.json({
      success: true,
      booking: {
        _id: rideOrder._id,
        orderId: rideOrder.orderId,
        status: "finding_driver",
        vehicleType, fromAddress, toAddress, fee,
      },
      driversNotified: nearby.length,
      message: `Đang tìm tài xế... (${nearby.length} tài xế gần bạn)`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/ride/:orderId/accept — Shipper nhận cuốc xe
app.post("/api/ride/:orderId/accept", async (req, res) => {
  try {
    if (!req.session.shipperId)
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });

    const order = await Order.findOne({ orderId: req.params.orderId, module: "ride" });
    if (!order) return res.status(404).json({ success: false });
    if (order.shipperId) return res.status(409).json({ success: false, message: "Cuốc đã được tài xế khác nhận" });

    const shipper = await Shipper.findById(req.session.shipperId).select("fullName phone vehiclePlate location");

    order.shipperId = req.session.shipperId;
    order.status = "shipper_accepted";
    order.statusHistory.push({ status: "shipper_accepted", by: "shipper" });
    await order.save();

    // Thông báo customer shipper đã nhận
    req.io.to(`customer_${order.customerId}`).emit("ride_accepted", {
      orderId: order.orderId,
      shipper: {
        name: shipper?.fullName,
        phone: shipper?.phone,
        vehiclePlate: shipper?.vehiclePlate,
        lat: shipper?.location?.lat,
        lng: shipper?.location?.lng,
      },
    });

    // Thông báo các shipper khác đã có người nhận
    req.io.to("shipper_broadcast").emit("ride_taken", { orderId: order.orderId });

    res.json({ success: true, order, message: "Đã nhận cuốc!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/ride/:orderId/complete — Shipper hoàn thành chuyến
app.post("/api/ride/:orderId/complete", async (req, res) => {
  try {
    if (!req.session.shipperId) return res.status(401).json({ success: false });

    const order = await Order.findOne({ orderId: req.params.orderId, module: "ride", shipperId: req.session.shipperId });
    if (!order) return res.status(404).json({ success: false });

    order.status = "delivered";
    order.deliveredAt = new Date();
    order.paymentStatus = "paid";
    order.statusHistory.push({ status: "delivered", by: "shipper" });
    await order.save();

    // Tính tiền shipper (90% fee, CRABOR giữ 10%)
    const shipperEarn = Math.round((order.total || 0) * 0.9);
    await addToWalletQueue(order.orderId, order.shipperId, "shipper", shipperEarn, order.paymentMethod, `Cuốc xe ${order.orderId}`);

    req.io.to(`customer_${order.customerId}`).emit("ride_completed", {
      orderId: order.orderId,
      message: "Chuyến đi hoàn thành! Cảm ơn bạn đã dùng CRABOR 🦀",
    });
    req.io.to("admin").emit("wallet_pending_approval", { orderId: order.orderId, shipperEarn, paymentMethod: order.paymentMethod });

    res.json({ success: true, message: "Hoàn thành chuyến!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/ride/:orderId/decline — Shipper từ chối cuốc
app.post("/api/ride/:orderId/decline", async (req, res) => {
  try {
    if (!req.session.shipperId) return res.status(401).json({ success: false });
    // Chỉ ghi nhận shipper này từ chối, không thay đổi order
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  SHIPPER — Online/Offline + Socket Room Registration
// ══════════════════════════════════════════════════════════════

// POST /api/shipper/online — Shipper bật nhận đơn
app.post("/api/shipper/online", async (req, res) => {
  try {
    await loadSessionFromHeader(req);
    console.log('[Online] Session shipperId:', req.session?.shipperId);
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    const { lat, lng } = req.body;
    const updateData = { online: true, isAccepting: true, lastSeen: new Date() };
    if (lat && lng) {
      updateData.location = { lat, lng };
      updateData.lastLocationAt = new Date();
    }
    const shipper = await Shipper.findByIdAndUpdate(req.session.shipperId, updateData, { new: true });
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy tài khoản shipper" });
    req.io.to("admin").emit("shipperOnline", { shipperId: req.session.shipperId });
    console.log('[Online] Shipper', req.session.shipperId, 'is now ONLINE');
    res.json({ success: true, online: true, shipper: { _id: shipper._id, fullName: shipper.fullName, status: shipper.status } });
  } catch (err) { 
    console.error('[Online] Error:', err);
    res.status(500).json({ success: false, message: err.message }); 
  }
});

// POST /api/shipper/offline — Shipper tắt nhận đơn
app.post("/api/shipper/offline", async (req, res) => {
  try {
    await loadSessionFromHeader(req);
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    await Shipper.findByIdAndUpdate(req.session.shipperId, { online: false, isAccepting: false });
    req.io.to("admin").emit("shipperOffline", { shipperId: req.session.shipperId });
    console.log('[Offline] Shipper', req.session.shipperId, 'is now OFFLINE');
    res.json({ success: true, online: false });
  } catch (err) { 
    console.error('[Offline] Error:', err);
    res.status(500).json({ success: false, message: err.message }); 
  }
});

// POST /api/shipper/location — Override: lưu cả vào Shipper.location
app.post("/api/shipper/location", async (req, res) => {
  try {
    await loadSessionFromHeader(req);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const { lat, lng, heading, speed, orderId } = req.body;
    if (!lat || !lng) return res.status(400).json({ success: false, message: "Thiếu tọa độ" });

    await Shipper.findByIdAndUpdate(req.session.shipperId, {
      location: { lat, lng },
      lastLocationAt: new Date(),
      heading: heading || 0,
      speed: speed || 0
    });

    // Broadcast vị trí cho room của đơn nếu đang giao
    if (orderId) {
      req.io.to(`order_${orderId}`).emit("shipperLocation", { lat, lng, orderId });
    }
    console.log('[Location] Updated for shipper:', req.session.shipperId, 'lat:', lat, 'lng:', lng);
    res.json({ success: true });
  } catch (err) {
    console.error('[Location] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/shipper/active-orders — Đơn đang active của shipper
app.get("/api/shipper/active-orders", async (req, res) => {
  try {
    await loadSessionFromHeader(req);
    if (!req.session.shipperId) return res.status(401).json({ success: false });
    const orders = await Order.find({
      shipperId: req.session.shipperId,
      status: { $in: ["shipper_accepted", "picking_up", "picked_up", "delivering"] }
    }).sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════════════════════════
//  WALLET PENDING QUEUE — Admin duyệt
// ══════════════════════════════════════════════════════════════

// GET /api/admin/wallet-queue — Xem danh sách pending với filter
app.get("/api/admin/wallet-queue", async (req, res) => {
  try {
    if (!req.session.adminId) return res.status(401).json({ success: false });
    const { status = "pending", page = 1, limit = 30, recipientType } = req.query;
    const filter = { status };
    if (recipientType) filter.recipientType = recipientType;
    const [queue, total] = await Promise.all([
      WalletQueue.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit)),
      WalletQueue.countDocuments(filter),
    ]);
    res.json({ success: true, queue, total });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/wallet-queue/:id/approve — Admin duyệt → cộng vào ví
app.post("/api/admin/wallet-queue/:id/approve", async (req, res) => {
  try {
    if (!req.session.adminId) return res.status(401).json({ success: false });

    const item = await WalletQueue.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false });
    if (item.status !== "pending") return res.status(400).json({ success: false, message: "Đã xử lý rồi" });

    // Cộng tiền vào ví khả dụng
    if (item.recipientType === "shipper") {
      await Shipper.findByIdAndUpdate(item.recipientId, {
        $inc: { walletBalance: item.amount, totalEarnings: item.amount }
      });
    } else {
      // Partner — thử tất cả model
      const pModels = [
        mongoose.models.FoodPartner,
        mongoose.models.GiatLa,
        mongoose.models.GiupViec,
        mongoose.models.ChinaShop,
      ].filter(Boolean);
      for (const m of pModels) {
        const upd = await m.findByIdAndUpdate(item.recipientId, {
          $inc: { walletBalance: item.amount, totalSales: item.amount }
        });
        if (upd) break;
      }
    }

    item.status = "approved";
    item.approvedBy = req.session.adminId;
    item.approvedAt = new Date();
    await item.save();

    // Notify shipper/partner qua socket
    const roomKey = item.recipientType === "shipper"
      ? `shipper_${item.recipientId}`
      : `partner_${item.recipientId}`;
    req.io.to(roomKey).emit("wallet_credited", {
      amount: item.amount,
      orderId: item.orderId,
      message: `+${item.amount.toLocaleString("vi-VN")}đ đã được duyệt vào ví!`,
    });

    res.json({ success: true, message: `Đã duyệt ${item.amount.toLocaleString("vi-VN")}đ` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/wallet-queue/:id/reject — Admin từ chối
app.post("/api/admin/wallet-queue/:id/reject", async (req, res) => {
  try {
    if (!req.session.adminId) return res.status(401).json({ success: false });
    const { reason } = req.body;
    const item = await WalletQueue.findById(req.params.id);
    if (!item || item.status !== "pending")
      return res.status(400).json({ success: false, message: "Không tìm thấy hoặc đã xử lý" });
    item.status = "rejected";
    item.rejectedReason = reason || "Admin từ chối";
    await item.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/admin/wallet-queue/stats — Thống kê mở rộng
app.get("/api/admin/wallet-queue/stats", async (req, res) => {
  try {
    if (!req.session.adminId) return res.status(401).json({ success: false });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);

    const [pending, approved, totalPendingAgg, approvedTodayAgg, customerWalletAgg, partnerWalletAggs] = await Promise.all([
      WalletQueue.countDocuments({ status: "pending" }),
      WalletQueue.countDocuments({ status: "approved" }),
      WalletQueue.aggregate([{ $match: { status: "pending" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      WalletQueue.aggregate([
        { $match: { status: "approved", approvedAt: { $gte: todayStart } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$amount" } } }
      ]),
      User.aggregate([{ $group: { _id: null, total: { $sum: "$walletBalance" } } }]),
      Promise.all([
        mongoose.models.FoodPartner?.aggregate([{ $group: { _id: null, total: { $sum: "$walletBalance" } } }]) || [],
        mongoose.models.GiatLa?.aggregate([{ $group: { _id: null, total: { $sum: "$walletBalance" } } }]) || [],
        mongoose.models.GiupViec?.aggregate([{ $group: { _id: null, total: { $sum: "$walletBalance" } } }]) || [],
        mongoose.models.ChinaShop?.aggregate([{ $group: { _id: null, total: { $sum: "$walletBalance" } } }]) || [],
      ]),
    ]);

    const totalPartnerWallet = partnerWalletAggs.flat()
      .reduce((sum, r) => sum + (r[0]?.total || 0), 0);

    res.json({
      success: true,
      pending,
      approved,
      totalPendingAmount:  totalPendingAgg[0]?.total || 0,
      approvedToday:       approvedTodayAgg[0]?.count || 0,
      approvedTodayAmount: approvedTodayAgg[0]?.total || 0,
      totalCustomerWallet: customerWalletAgg[0]?.total || 0,
      totalPartnerWallet,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/wallet-queue/approve-all — Duyệt tất cả pending
app.post("/api/admin/wallet-queue/approve-all", async (req, res) => {
  try {
    if (!req.session.adminId) return res.status(401).json({ success: false });
    const items = await WalletQueue.find({ status: "pending" });
    let approved = 0, totalAmount = 0;
    for (const item of items) {
      if (item.recipientType === "shipper") {
        await Shipper.findByIdAndUpdate(item.recipientId, { $inc: { walletBalance: item.amount, totalEarnings: item.amount } });
      } else {
        const pModels = [mongoose.models.FoodPartner, mongoose.models.GiatLa, mongoose.models.GiupViec, mongoose.models.ChinaShop].filter(Boolean);
        for (const m of pModels) {
          const upd = await m.findByIdAndUpdate(item.recipientId, { $inc: { walletBalance: item.amount, totalSales: item.amount } });
          if (upd) break;
        }
      }
      item.status = "approved"; item.approvedBy = "admin_bulk"; item.approvedAt = new Date();
      await item.save();
      // Notify
      const roomKey = `${item.recipientType}_${item.recipientId}`;
      global._io?.to(roomKey).emit("wallet_credited", { amount: item.amount, orderId: item.orderId, message: `+${item.amount.toLocaleString("vi-VN")}đ đã được duyệt vào ví!` });
      approved++; totalAmount += item.amount;
    }
    res.json({ success: true, approved, totalAmount });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════════════════════════
//  SOCKET — Register shipper/partner vào room khi login
// ══════════════════════════════════════════════════════════════
// Extend socket connection handler
const originalHandler = io.listeners("connection")[0];
io.removeAllListeners("connection");


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


// CRON: Tự động dispatch đơn pending mỗi 30 giây
setInterval(async () => {
  try {
    const pendingOrders = await Order.find({
      status: { $in: ["pending", "confirmed"] }, // confirmed = partner đã xác nhận
      shipperId: { $exists: false },             // chưa có shipper
      dispatchedAt: { $exists: false },
      module: { $in: ["food", "ride"] }
    }).limit(10);
    
    if (pendingOrders.length === 0) return;
    
    console.log(`[AutoDispatch] Found ${pendingOrders.length} pending orders`);
    
    for (const order of pendingOrders) {
      if (order.dispatchedAt) continue;
      
      let pickupLat, pickupLng;
      
      if (order.module === 'food' && order.partnerId) {
        const partner = await FoodPartner.findById(order.partnerId).select("lastLat lastLng location");
        if (partner?.lastLat) {
          pickupLat = partner.lastLat;
          pickupLng = partner.lastLng;
        } else if (partner?.location?.lat) {
          pickupLat = partner.location.lat;
          pickupLng = partner.location.lng;
        }
      } else if (order.module === 'ride') {
        pickupLat = order.pickupLat;
        pickupLng = order.pickupLng;
      }
      
      if (!pickupLat) {
        pickupLat = 21.0285;
        pickupLng = 105.8542;
      }
      
      const nearbyShippers = await findNearbyShippers(pickupLat, pickupLng, 5, 10);
      
      if (nearbyShippers.length > 0) {
        const payload = {
          type: "order_request",
          orderId: order.orderId,
          order: {
            _id: order._id,
            orderId: order.orderId,
            items: order.items,
            total: order.finalTotal || order.total,
            shipFee: order.shipFee,
            pickupAddress: order.partnerAddress || "Địa chỉ quán",
            pickupLat,
            pickupLng,
            deliveryAddress: order.address,
            note: order.note,
            customerName: order.customerName,
            module: order.module,
          },
          timeout: 30,
        };
        
        for (const shipper of nearbyShippers) {
          global._io?.to(`shipper_${shipper._id}`).emit("order_request", payload);
          console.log(`[AutoDispatch] Sent order ${order.orderId} to shipper ${shipper._id} (distance: ${shipper.distanceKm}km)`);
        }
        
        await Order.findByIdAndUpdate(order._id, {
          $set: { dispatchedTo: nearbyShippers.map(s => s._id), dispatchedAt: new Date() }
        });
      } else {
        console.log(`[AutoDispatch] No nearby shipper for order ${order.orderId}`);
      }
    }
  } catch (error) {
    console.error('[AutoDispatch] Error:', error);
  }
}, 30000);

console.log('[AutoDispatch] Cron job started - checking pending orders every 30s');


// ══════════════════════════════════════════════════════════════
//  RIDE — Tracking & Status APIs (bổ sung)
// ══════════════════════════════════════════════════════════════

// GET /api/ride/active - Lấy đơn đang active của shipper
app.get("/api/ride/active", async (req, res) => {
  try {
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    const order = await Order.findOne({
      shipperId: req.session.shipperId,
      module: "ride",
      status: { $in: ["shipper_accepted", "picking_up", "delivering"] }
    }).sort({ createdAt: -1 });

    if (!order) return res.json({ success: true, activeRide: null });

    res.json({
      success: true,
      activeRide: {
        _id: order._id,
        orderId: order.orderId,
        status: order.status,
        fromAddress: order.fromAddress,
        toAddress: order.toAddress,
        fromLat: order.fromLat,
        fromLng: order.fromLng,
        toLat: order.toLat,
        toLng: order.toLng,
        fee: order.total,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
      }
    });
  } catch (err) {
    console.error('[Active Ride] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/ride/:id/tracking - Customer theo dõi chuyến đi
app.get("/api/ride/:id/tracking", async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id, module: "ride" });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy chuyến" });

    let shipper = null;
    if (order.shipperId) {
      shipper = await Shipper.findById(order.shipperId)
        .select("fullName phone vehiclePlate rating location lastLocationAt");
    }

    res.json({
      success: true,
      ride: {
        _id: order._id,
        orderId: order.orderId,
        status: order.status,
        fromAddress: order.fromAddress,
        toAddress: order.toAddress,
        fromLat: order.fromLat,
        fromLng: order.fromLng,
        toLat: order.toLat,
        toLng: order.toLng,
        fee: order.total,
        createdAt: order.createdAt,
        deliveredAt: order.deliveredAt,
      },
      shipper: shipper ? {
        _id: shipper._id,
        fullName: shipper.fullName,
        phone: shipper.phone,
        vehiclePlate: shipper.vehiclePlate,
        rating: shipper.rating || 5,
        location: shipper.location,
        lastLocationAt: shipper.lastLocationAt,
      } : null,
    });
  } catch (err) {
    console.error('[Tracking] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/ride/:id/arrived - Shipper xác nhận đã đến điểm đón
app.patch("/api/ride/:id/arrived", async (req, res) => {
  try {
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    const order = await Order.findOne({
      orderId: req.params.id, module: "ride", shipperId: req.session.shipperId
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy chuyến" });

    if (order.status !== "shipper_accepted") {
      return res.status(400).json({ success: false, message: "Trạng thái không hợp lệ" });
    }

    order.status = "picking_up";
    order.statusHistory.push({ status: "picking_up", by: "shipper", time: new Date() });
    await order.save();

    req.io.to(`customer_${order.customerId}`).emit("ride_status_update", {
      orderId: order.orderId,
      status: "picking_up",
      message: "Tài xế đã đến điểm đón!",
    });

    res.json({ success: true, message: "Đã xác nhận đến điểm đón" });
  } catch (err) {
    console.error('[Arrived] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/ride/:id/start - Shipper bắt đầu chuyến
app.patch("/api/ride/:id/start", async (req, res) => {
  try {
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    const order = await Order.findOne({
      orderId: req.params.id, module: "ride", shipperId: req.session.shipperId
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy chuyến" });

    if (order.status !== "picking_up") {
      return res.status(400).json({ success: false, message: "Trạng thái không hợp lệ" });
    }

    order.status = "delivering";
    order.statusHistory.push({ status: "delivering", by: "shipper", time: new Date() });
    await order.save();

    req.io.to(`customer_${order.customerId}`).emit("ride_status_update", {
      orderId: order.orderId,
      status: "delivering",
      message: "Chuyến đi đã bắt đầu!",
    });

    res.json({ success: true, message: "Đã bắt đầu chuyến đi" });
  } catch (err) {
    console.error('[Start Ride] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/ride/:id/rate - Đánh giá tài xế sau chuyến
app.post("/api/ride/:id/rate", async (req, res) => {
  try {
    if (!req.session?.userId && !req.session?.customerId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    const customerId = req.session.userId || req.session.customerId;
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: "Đánh giá từ 1-5 sao" });
    }

    const order = await Order.findOne({ orderId: req.params.id, module: "ride", customerId });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy chuyến" });

    if (order.status !== "delivered") {
      return res.status(400).json({ success: false, message: "Chỉ đánh giá chuyến đã hoàn thành" });
    }
    if (order.ratedAt) {
      return res.status(400).json({ success: false, message: "Đã đánh giá chuyến này rồi" });
    }

    order.ratingShipper = rating;
    order.ratingComment = comment || "";
    order.ratedAt = new Date();
    await order.save();

    if (order.shipperId) {
      const shipper = await Shipper.findById(order.shipperId);
      if (shipper) {
        const newCount = (shipper.ratingCount || 0) + 1;
        const newRating = (((shipper.rating || 0) * (shipper.ratingCount || 0)) + rating) / newCount;
        await Shipper.findByIdAndUpdate(order.shipperId, {
          rating: Math.round(newRating * 10) / 10,
          ratingCount: newCount,
        });
      }
    }

    res.json({ success: true, message: "Cảm ơn bạn đã đánh giá!" });
  } catch (err) {
    console.error('[Rate Ride] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  ROUTING — Vẽ đường đi (OSRM)
// ══════════════════════════════════════════════════════════════

// GET /api/route/directions - Lấy đường đi giữa 2 điểm
app.get("/api/route/directions", async (req, res) => {
  try {
    const { fromLat, fromLng, toLat, toLng, profile = "driving" } = req.query;

    if (!fromLat || !fromLng || !toLat || !toLng) {
      return res.status(400).json({ success: false, message: "Thiếu tọa độ" });
    }

    const url = `https://router.project-osrm.org/route/v1/${profile}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=true`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({ success: false, message: "Không tìm thấy đường đi" });
    }

    const route = data.routes[0];
    const coordinates = route.geometry.coordinates.map(coord => ({
      latitude: coord[1],
      longitude: coord[0],
    }));

    res.json({
      success: true,
      route: {
        coordinates,
        distance: (route.distance / 1000).toFixed(1), // km
        duration: Math.round(route.duration / 60),    // phút
        legs: route.legs,
      }
    });
  } catch (err) {
    console.error('[Directions] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/ride/:id/route - Lấy đường đi cho chuyến ride
app.get("/api/ride/:id/route", async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id, module: "ride" });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy chuyến" });

    const { type = "full" } = req.query; // full | to_pickup | to_destination

    let fromLat, fromLng, toLat, toLng;

    let shipperLocation = null;
    if (order.shipperId) {
      const shipper = await Shipper.findById(order.shipperId).select("location");
      if (shipper?.location) shipperLocation = shipper.location;
    }

    if (type === "to_pickup" && shipperLocation) {
      fromLat = shipperLocation.lat;  fromLng = shipperLocation.lng;
      toLat   = order.fromLat;        toLng   = order.fromLng;
    } else if (type === "to_destination") {
      fromLat = shipperLocation?.lat || order.fromLat;
      fromLng = shipperLocation?.lng || order.fromLng;
      toLat   = order.toLat;          toLng   = order.toLng;
    } else {
      // full: điểm đón → điểm đến
      fromLat = order.fromLat;  fromLng = order.fromLng;
      toLat   = order.toLat;    toLng   = order.toLng;
    }

    if (!fromLat || !fromLng || !toLat || !toLng) {
      return res.status(400).json({ success: false, message: "Thiếu tọa độ" });
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({ success: false, message: "Không tìm thấy đường đi" });
    }

    const route = data.routes[0];
    const coordinates = route.geometry.coordinates.map(coord => ({
      latitude: coord[1],
      longitude: coord[0],
    }));

    res.json({
      success: true,
      route: {
        coordinates,
        distance: (route.distance / 1000).toFixed(1),
        duration: Math.round(route.duration / 60),
      }
    });
  } catch (err) {
    console.error('[Ride Route] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});


// ── CLEANING ORDER SCHEMA (Dọn nhà) ─────────────────────────
const cleaningOrderSchema = new mongoose.Schema({
  orderId:       { type: String, unique: true },
  customerId:    mongoose.Schema.Types.ObjectId,
  shipperId:     mongoose.Schema.Types.ObjectId,
  customerName:  String,
  customerPhone: String,
  address:       String,
  addressLat:    Number,
  addressLng:    Number,
  serviceType:   { type: String, enum: ["basic","medium","deep"], default: "basic" },
  serviceName:   String,
  price:         Number,
  duration:      String,
  note:          String,
  bookingDate:   Date,
  bookingTime:   String,
  status: {
    type: String,
    enum: ["pending","shipper_accepted","picking_up","working","completed","cancelled"],
    default: "pending",
  },
  statusHistory: [{ status: String, by: String, time: Date }],
  completedAt:   Date,
  rating:        { type: Number, min: 1, max: 5 },
  ratingComment: String,
}, { timestamps: true });

cleaningOrderSchema.pre("save", function(next) {
  if (!this.orderId) this.orderId = "CLN-" + Date.now().toString(36).toUpperCase();
  next();
});
const CleaningOrder = mongoose.models.CleaningOrder || mongoose.model("CleaningOrder", cleaningOrderSchema);

// Socket: Shipper bật/tắt module nhận đơn
io.on("connection", (socket) => {
  socket.on("shipper_toggle_module", async (data) => {
    const { shipperId, module, enabled } = data;
    if (!shipperId) return;
    try {
      const update = {};
      update[`preferences.modules.${module}`] = enabled;
      await Shipper.findByIdAndUpdate(shipperId, update);
      console.log(`[Shipper] ${shipperId} toggled ${module}: ${enabled}`);
    } catch(e) { console.error('[toggle_module]', e.message); }
  });
});


// POST /api/coco/partner - Chat riêng cho Partner (có context doanh thu)
app.post("/api/coco/partner", async (req, res) => {
  try {
    if (!req.session?.partnerId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    
    const { message, sessionId } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: "Thiếu tin nhắn" });
    }
    
    // Lấy thông tin partner
    let partner = null;
    let module = null;
    const models = [
      { model: mongoose.models.FoodPartner, key: "food_partner" },
      { model: mongoose.models.GiatLa,      key: "giat_la" },
      { model: mongoose.models.GiupViec,    key: "giup_viec" },
      { model: mongoose.models.ChinaShop,   key: "china_shop" },
    ].filter(m => m.model);
    
    for (const { model, key } of models) {
      const p = await model.findById(req.session.partnerId);
      if (p) {
        partner = p;
        module = key;
        break;
      }
    }
    
    if (!partner) {
      return res.status(404).json({ success: false, message: "Không tìm thấy partner" });
    }
    
    // Lấy thống kê nhanh cho context
    const Order = mongoose.models.Order;
    const today = new Date(); today.setHours(0,0,0,0);
    const todayOrders = await Order.countDocuments({ partnerId: partner._id, createdAt: { $gte: today } });
    const todayRevenue = await Order.aggregate([
      { $match: { partnerId: partner._id, status: "delivered", deliveredAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: "$finalTotal" } } }
    ]);
    
    const userContext = {
      userType: "partner",
      bizName: partner.bizName || partner.fullName,
      walletBalance: partner.walletBalance || 0,
      totalOrders: partner.totalOrders || 0,
      todayOrders: todayOrders,
      todayRevenue: todayRevenue[0]?.total || 0,
      isAccepting: partner.isAccepting !== false,
      module: module,
    };
    
    // Gọi Coco engine
    const { cocoRespondSmart } = require('./coco-engine');
    const sid = sessionId || `partner_${partner._id}_${Date.now()}`;
    
    const result = await cocoRespondSmart({
      text: message,
      sessionId: sid,
      userId: partner._id,
      userCtx: userContext,
    });
    
    res.json({
      success: true,
      sessionId: sid,
      message: result.text,
      intent: result.intent,
      backend: result.backend || 'rule',
    });
  } catch (err) {
    console.error('[Coco Partner] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/coco/shipper - Chat riêng cho Shipper (có context thu nhập)
app.post("/api/coco/shipper", async (req, res) => {
  try {
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    
    const { message, sessionId } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: "Thiếu tin nhắn" });
    }
    
    // Lấy thông tin shipper
    const shipper = await Shipper.findById(req.session.shipperId);
    if (!shipper) {
      return res.status(404).json({ success: false, message: "Không tìm thấy shipper" });
    }
    
    // Lấy thống kê nhanh
    const Order = mongoose.models.Order;
    const today = new Date(); today.setHours(0,0,0,0);
    const todayOrders = await Order.countDocuments({ 
      shipperId: shipper._id, 
      status: "delivered", 
      deliveredAt: { $gte: today } 
    });
    const todayEarnings = await Order.aggregate([
      { $match: { shipperId: shipper._id, status: "delivered", deliveredAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: "$shipFee" } } }
    ]);
    
    const userContext = {
      userType: "shipper",
      name: shipper.fullName,
      walletBalance: shipper.walletBalance || 0,
      totalOrders: shipper.totalOrders || 0,
      todayOrders: todayOrders,
      todayEarnings: todayEarnings[0]?.total || 0,
      rating: shipper.rating || 5,
      tier: shipper.tier || "bronze",
      online: shipper.online || false,
    };
    
    // Gọi Coco engine
    const { cocoRespondSmart } = require('./coco-engine');
    const sid = sessionId || `shipper_${shipper._id}_${Date.now()}`;
    
    const result = await cocoRespondSmart({
      text: message,
      sessionId: sid,
      userId: shipper._id,
      userCtx: userContext,
    });
    
    res.json({
      success: true,
      sessionId: sid,
      message: result.text,
      intent: result.intent,
      backend: result.backend || 'rule',
    });
  } catch (err) {
    console.error('[Coco Shipper] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/coco/history - Lấy lịch sử chat của user
app.get("/api/coco/history", async (req, res) => {
  try {
    const { sessionId, userType, userId } = req.query;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "Thiếu sessionId" });
    }
    
    // Kiểm tra quyền truy cập
    if (userType === 'shipper' && req.session?.shipperId?.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Không có quyền" });
    }
    if (userType === 'partner' && req.session?.partnerId?.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Không có quyền" });
    }
    
    const { CocoChat } = require('./coco-brain');
    const chat = await CocoChat.findOne({ sessionId }).lean();
    
    if (!chat) {
      return res.json({ success: true, messages: [] });
    }
    
    res.json({
      success: true,
      sessionId: chat.sessionId,
      title: chat.title,
      messages: chat.messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
    });
  } catch (err) {
    console.error('[Coco History] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/coco/session - Xoá session chat
app.delete("/api/coco/session", async (req, res) => {
  try {
    const { sessionId, userType, userId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "Thiếu sessionId" });
    }
    
    const { CocoChat } = require('./coco-brain');
    const chat = await CocoChat.findOne({ sessionId });
    
    if (!chat) {
      return res.json({ success: true });
    }
    
    // Kiểm tra quyền
    if (userType === 'shipper' && chat.userId?.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Không có quyền" });
    }
    if (userType === 'partner' && chat.userId?.toString() !== userId) {
      return res.status(403).json({ success: false, message: "Không có quyền" });
    }
    
    await CocoChat.findOneAndDelete({ sessionId });
    
    res.json({ success: true, message: "Đã xoá lịch sử chat" });
  } catch (err) {
    console.error('[Coco Delete Session] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});



// ══════════════════════════════════════════════════════════════
//  FORGOT PASSWORD — OTP EMAIL FLOW (Shipper / Customer / Partner)
// ══════════════════════════════════════════════════════════════

// Helper: tìm user theo type
async function findUserByIdentifier(userType, phone, email) {
  const norm = phone ? normalizePhone(phone) : null;
  if (userType === 'shipper') {
    return await Shipper.findOne(norm ? { phone: norm } : { email: email?.toLowerCase().trim() })
      .select('_id email phone fullName status');
  }
  if (userType === 'customer') {
    return await User.findOne(norm ? { phone: norm } : { email: email?.toLowerCase().trim() })
      .select('_id email phone fullName');
  }
  if (userType === 'partner') {
    const partnerModels = [
      mongoose.models.FoodPartner,
      mongoose.models.GiatLa,
      mongoose.models.GiupViec,
      mongoose.models.ChinaShop,
    ].filter(Boolean);
    for (const model of partnerModels) {
      const p = await model.findOne(norm ? { phone: norm } : { email: email?.toLowerCase().trim() })
        .select('_id email phone fullName bizName status');
      if (p) return p;
    }
    return null;
  }
  return null;
}

// 1. POST /api/auth/otp/send — Gửi OTP quên mật khẩu
//    Body: { userType: "shipper"|"customer"|"partner", phone?, email? }
app.post("/api/auth/otp/send", async (req, res) => {
  try {
    const { userType, phone, email } = req.body;

    if (!['shipper', 'customer', 'partner'].includes(userType)) {
      return res.status(400).json({ success: false, message: "userType không hợp lệ" });
    }
    if (!phone && !email) {
      return res.status(400).json({ success: false, message: "Vui lòng nhập số điện thoại hoặc email" });
    }

    const user = await findUserByIdentifier(userType, phone, email);
    if (!user) {
      return res.status(404).json({ success: false, message: "Tài khoản không tồn tại" });
    }
    if (!user.email) {
      return res.status(400).json({ success: false, message: "Tài khoản chưa liên kết email, vui lòng liên hệ admin" });
    }

    await sendEmailOtp(user.email);

    console.log(`[OTP/Send] ${userType} → ${user.email}`);

    res.json({
      success: true,
      message: "Đã gửi mã OTP về email",
      email: user.email.replace(/(.{2}).+(@.+)/, "$1***$2"),
    });
  } catch (err) {
    console.error("[OTP/Send] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. POST /api/auth/otp/verify — Xác minh OTP, nhận resetToken
//    Body: { userType, phone?, email?, otp }
app.post("/api/auth/otp/verify", async (req, res) => {
  try {
    const { userType, phone, email, otp } = req.body;

    if (!['shipper', 'customer', 'partner'].includes(userType)) {
      return res.status(400).json({ success: false, message: "userType không hợp lệ" });
    }
    if (!otp) {
      return res.status(400).json({ success: false, message: "Vui lòng nhập mã OTP" });
    }

    const user = await findUserByIdentifier(userType, phone, email);
    if (!user || !user.email) {
      return res.status(404).json({ success: false, message: "Tài khoản không tồn tại" });
    }

    const result = verifyEmailOtp(user.email, otp);
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.reason });
    }

    // Cấp resetToken (10 phút)
    const resetToken = require("crypto").randomBytes(32).toString("hex");
    resetTokenStore.set(resetToken, {
      userId: user._id.toString(),
      userType,
      expiry: Date.now() + 10 * 60 * 1000,
    });

    console.log(`[OTP/Verify] OK → ${userType} ${user._id}`);

    res.json({
      success: true,
      message: "Xác minh thành công",
      resetToken,
    });
  } catch (err) {
    console.error("[OTP/Verify] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. POST /api/auth/otp/reset-password — Đổi mật khẩu bằng resetToken
//    Body: { resetToken, newPassword }
app.post("/api/auth/otp/reset-password", async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken) {
      return res.status(400).json({ success: false, message: "Thiếu reset token" });
    }
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Mật khẩu tối thiểu 6 ký tự" });
    }

    const tokenData = resetTokenStore.get(resetToken);
    if (!tokenData) {
      return res.status(400).json({ success: false, message: "Token không hợp lệ hoặc đã được dùng" });
    }
    if (Date.now() > tokenData.expiry) {
      resetTokenStore.delete(resetToken);
      return res.status(400).json({ success: false, message: "Token đã hết hạn, vui lòng thực hiện lại từ đầu" });
    }

    const bcrypt = require("bcryptjs");
    const hashed = await bcrypt.hash(newPassword, 10);
    const { userId, userType } = tokenData;

    let updatedUser = null;

    if (userType === 'shipper') {
      updatedUser = await Shipper.findByIdAndUpdate(userId, { password: hashed }, { new: true })
        .select('_id fullName phone status');
    } else if (userType === 'customer') {
      updatedUser = await User.findByIdAndUpdate(userId, { password: hashed }, { new: true })
        .select('_id fullName phone email');
    } else if (userType === 'partner') {
      const partnerModels = [
        mongoose.models.FoodPartner,
        mongoose.models.GiatLa,
        mongoose.models.GiupViec,
        mongoose.models.ChinaShop,
      ].filter(Boolean);
      for (const model of partnerModels) {
        const p = await model.findByIdAndUpdate(userId, { password: hashed }, { new: true })
          .select('_id fullName bizName phone status');
        if (p) { updatedUser = p; break; }
      }
    }

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "Tài khoản không tồn tại" });
    }

    // Xoá token sau khi dùng
    resetTokenStore.delete(resetToken);

    // Tạo session luôn để user đăng nhập ngay
    if (userType === 'shipper') {
      req.session.shipperId = updatedUser._id;
      req.session.userPhone = updatedUser.phone;
      req.session.role = 'shipper';
    } else if (userType === 'customer') {
      req.session.userId = updatedUser._id;
      req.session.userPhone = updatedUser.phone;
      req.session.role = 'customer';
    } else if (userType === 'partner') {
      req.session.partnerId = updatedUser._id;
      req.session.userPhone = updatedUser.phone;
      req.session.role = 'partner';
    }

    await new Promise((resolve, reject) => {
      req.session.save((err) => { if (err) reject(err); else resolve(); });
    });

    const cookieStr = buildSignedSessionCookie(req.session.id);

    console.log(`[ResetPW] ${userType} ${updatedUser._id} changed password`);

    res.json({
      success: true,
      message: "Đổi mật khẩu thành công",
      user: updatedUser,
      cookie: cookieStr,
      sessionId: req.session.id,
    });
  } catch (err) {
    console.error("[ResetPW] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Dọn resetTokenStore hết hạn mỗi 15 phút
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of resetTokenStore) { if (v.expiry < now) resetTokenStore.delete(k); }
}, 15 * 60 * 1000);



// PATCH /api/users/settings - Cập nhật cài đặt app (âm thanh, rung)
app.patch("/api/users/settings", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { vibrationEnabled, soundEnabled, notificationsEnabled, language } = req.body;
    const update = {};
    if (vibrationEnabled !== undefined) update["settings.vibrationEnabled"] = vibrationEnabled;
    if (soundEnabled !== undefined) update["settings.soundEnabled"] = soundEnabled;
    if (notificationsEnabled !== undefined) update["settings.notificationsEnabled"] = notificationsEnabled;
    if (language !== undefined) update["settings.language"] = language;
    await User.findByIdAndUpdate(req.session.userId, update);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  PARTNER FEE & SETTINGS
// ══════════════════════════════════════════════════════════════

// GET /api/partner/fee — Lấy thông tin phí dịch vụ partner
app.get("/api/partner/fee", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const models = [
      mongoose.models.FoodPartner,
      mongoose.models.GiatLa,
      mongoose.models.GiupViec,
      mongoose.models.ChinaShop,
    ].filter(Boolean);
    let partner = null;
    for (const model of models) {
      partner = await model.findById(req.session.partnerId).select('feeAmount feePaid feeStatus feePercent walletBalance');
      if (partner) break;
    }
    if (!partner) return res.status(404).json({ success: false });
    res.json({
      success: true,
      fee: {
        amount:     partner.feeAmount    || 0,
        paid:       partner.feePaid      || 0,
        status:     partner.feeStatus    || 'none',
        percent:    partner.feePercent   || 15,
        wallet:     partner.walletBalance || 0,
      }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/partner/fee/pay-wallet — Trả phí bằng ví
app.post("/api/partner/fee/pay-wallet", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const models = [
      mongoose.models.FoodPartner,
      mongoose.models.GiatLa,
      mongoose.models.GiupViec,
      mongoose.models.ChinaShop,
    ].filter(Boolean);
    let partner = null, usedModel = null;
    for (const model of models) {
      partner = await model.findById(req.session.partnerId);
      if (partner) { usedModel = model; break; }
    }
    if (!partner) return res.status(404).json({ success: false });
    const feeOwed = (partner.feeAmount || 0) - (partner.feePaid || 0);
    if (feeOwed <= 0) return res.json({ success: true, message: "Không có phí cần thanh toán" });
    if ((partner.walletBalance || 0) < feeOwed)
      return res.status(400).json({ success: false, message: `Ví không đủ tiền. Cần ${feeOwed.toLocaleString()}đ` });
    await usedModel.findByIdAndUpdate(req.session.partnerId, {
      $inc: { walletBalance: -feeOwed, feePaid: feeOwed },
      feeStatus: 'paid',
    });
    res.json({ success: true, message: `Đã thanh toán phí ${feeOwed.toLocaleString()}đ từ ví` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/partner/fee/prepare — Chuẩn bị thanh toán phí qua PayOS
app.post("/api/partner/fee/prepare", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Số tiền không hợp lệ" });
    // Generate PayOS order code
    const orderCode = Date.now();
    res.json({
      success: true,
      orderCode,
      amount,
      description: `Phi DV CRABOR`,
      returnUrl: `${process.env.BASE_URL || 'https://crabor-shipper-register.onrender.com'}/payment/success`,
      cancelUrl:  `${process.env.BASE_URL || 'https://crabor-shipper-register.onrender.com'}/payment/cancel`,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/partner/settings — Cập nhật cài đặt partner
app.patch("/api/partner/settings", async (req, res) => {
  try {
    if (!req.session.partnerId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { autoPayFee, soundEnabled, notificationsEnabled } = req.body;
    const update = {};
    if (autoPayFee !== undefined)            update['settings.autoPayFee']            = autoPayFee;
    if (soundEnabled !== undefined)          update['settings.soundEnabled']          = soundEnabled;
    if (notificationsEnabled !== undefined)  update['settings.notificationsEnabled']  = notificationsEnabled;
    const models = [
      mongoose.models.FoodPartner,
      mongoose.models.GiatLa,
      mongoose.models.GiupViec,
      mongoose.models.ChinaShop,
    ].filter(Boolean);
    for (const model of models) {
      const p = await model.findByIdAndUpdate(req.session.partnerId, update);
      if (p) break;
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// POST /api/order/dispatch — Tìm shipper gần nhất cho đơn hàng
app.post("/api/order/dispatch", async (req, res) => {
  try {
    const { orderId, radius = 5 } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: "Thiếu orderId" });

    // Tìm đơn hàng
    const Order = mongoose.models.Order;
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    // Tìm shipper online gần nhất
    const radiusKm = parseFloat(radius) || 5;
    const shippers = await Shipper.find({
      online: true,
      status: 'approved',
      lat: { $exists: true, $ne: null },
      lng: { $exists: true, $ne: null },
    }).select('_id fullName phone lat lng rating tier').lean();

    // Filter theo khoảng cách nếu có toạ độ đơn hàng
    let nearbyShippers = shippers;
    if (order.fromLat && order.fromLng) {
      nearbyShippers = shippers.filter(s => {
        if (!s.lat || !s.lng) return false;
        const R = 6371;
        const dLat = (s.lat - order.fromLat) * Math.PI / 180;
        const dLng = (s.lng - order.fromLng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
          Math.cos(order.fromLat * Math.PI/180) * Math.cos(s.lat * Math.PI/180) * Math.sin(dLng/2)**2;
        const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        s.distKm = parseFloat(dist.toFixed(2));
        return dist <= radiusKm;
      });
      nearbyShippers.sort((a, b) => (a.distKm || 0) - (b.distKm || 0));
    }

    res.json({
      success: true,
      shippers: nearbyShippers.slice(0, 5).map(s => ({
        _id: s._id,
        name: s.fullName,
        phone: s.phone,
        rating: s.rating || 5,
        tier: s.tier || 'bronze',
        distKm: s.distKm || null,
      })),
      total: nearbyShippers.length,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// POST /api/partner/wallet/withdraw — alias cho partner rút tiền
app.post("/api/partner/wallet/withdraw", async (req, res) => {
  // Alias → /api/wallet/withdraw
  if (!req.session.partnerId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
  const { amount, bankName, accountNo, accountName } = req.body;
  const amt = Number(amount);
  if (!amt || amt < 200000) return res.status(400).json({ success: false, message: "Số tiền rút tối thiểu 200.000đ" });
  if (amt > 50000000)       return res.status(400).json({ success: false, message: "Số tiền rút tối đa 50.000.000đ" });
  if (!bankName || !accountNo || !accountName) return res.status(400).json({ success: false, message: "Thiếu thông tin ngân hàng" });
  try {
    const newBal = await walletDebit(req.session.partnerId, 'partner', amt, 'withdraw', null, `Rút tiền → ${bankName} ${accountNo}`);
    req.io.to('admin').emit('withdrawRequest', { ownerId: req.session.partnerId, ownerType: 'partner', amount: amt, bankName, accountNo, accountName });
    res.json({ success: true, newBalance: newBal, message: `Yêu cầu rút ${amt.toLocaleString('vi-VN')}đ đã ghi nhận. Xử lý trong 1–3 ngày.` });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

// POST /api/auth/set-password — Customer đặt mật khẩu lần đầu / đổi mật khẩu
app.post("/api/auth/set-password", async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password || password.length < 6)
      return res.status(400).json({ success: false, message: "Mật khẩu tối thiểu 6 ký tự" });

    const query = {
      $or: [
        { phone: identifier.replace(/\D/g, '') },
        { email: identifier.toLowerCase().trim() },
      ]
    };
    const user = await User.findOne(query);
    if (!user) return res.status(404).json({ success: false, message: "Tài khoản không tồn tại" });

    const bcrypt = require("bcryptjs");
    user.password = await bcrypt.hash(password, 10);
    await user.save();

    // Tạo session
    req.session.userId   = user._id;
    req.session.userPhone = user.phone;
    req.session.role      = "customer";
    await new Promise((resolve, reject) =>
      req.session.save(err => err ? reject(err) : resolve())
    );

    const cookieStr = `connect.sid=${req.session.id}; Path=/; HttpOnly; SameSite=Lax`;
    res.json({
      success: true,
      user: { _id: user._id, fullName: user.fullName, phone: user.phone, email: user.email },
      cookie: cookieStr,
      sessionId: req.session.id,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// GET /api/users/me — alias /api/users/profile
app.get("/api/users/me", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
  try {
    const user = await User.findById(req.session.userId).select('-password').lean();
    if (!user) return res.status(404).json({ success: false });
    res.json({ success: true, user, data: user });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/users/bank — Lấy thông tin ngân hàng đã lưu
app.get("/api/users/bank", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
  try {
    const user = await User.findById(req.session.userId).select('bankName bankAccount bankAccountName').lean();
    if (!user) return res.status(404).json({ success: false });
    res.json({
      success: true,
      bank: {
        bankName:        user.bankName        || '',
        bankAccount:     user.bankAccount     || '',
        bankAccountName: user.bankAccountName || '',
      }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/users/search-history — Lấy lịch sử tìm kiếm
app.get("/api/users/search-history", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  try {
    const user = await User.findById(req.session.userId).select('searchHistory').lean();
    res.json({ success: true, history: user?.searchHistory || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/users/search-history — Thêm vào lịch sử tìm kiếm
app.post("/api/users/search-history", async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ success: false });
    await User.findByIdAndUpdate(req.session.userId, {
      $push: { searchHistory: { $each: [{ query, createdAt: new Date() }], $slice: -20 } }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// POST /api/wallet/topup/prepare — Tạo lệnh nạp ví (qua PayOS/SePay)
app.post("/api/wallet/topup/prepare", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { amount } = req.body;
    const amt = Number(amount);
    if (!amt || amt < 10000)  return res.status(400).json({ success: false, message: "Số tiền tối thiểu 10.000đ" });
    if (amt > 50000000)       return res.status(400).json({ success: false, message: "Số tiền tối đa 50.000.000đ" });

    // Tạo mã tham chiếu CRTOPUP + 8 chars userId
    const uid = req.session.userId.toString().slice(-8).toUpperCase();
    const orderCode = Date.now();
    const description = `CRTOPUP${uid}`;

    res.json({
      success: true,
      orderCode,
      amount: amt,
      description,
      accountNo:   process.env.SEPAY_ACCOUNT || '',
      accountName: process.env.SEPAY_ACCOUNT_NAME || 'CRABOR',
      bankName:    process.env.SEPAY_BANK || 'MB Bank',
      qrUrl: `https://img.vietqr.io/image/${process.env.SEPAY_BANK_CODE || 'MB'}-${process.env.SEPAY_ACCOUNT || ''}-print.png?amount=${amt}&addInfo=${description}`,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/wallet/topup/check — Kiểm tra trạng thái nạp ví
app.post("/api/wallet/topup/check", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { orderCode } = req.body;
    if (!orderCode) return res.status(400).json({ success: false, message: "Thiếu orderCode" });

    // Kiểm tra trong lịch sử giao dịch ví
    const tx = await WalletTx.findOne({
      ownerId: req.session.userId,
      type: 'credit',
      note: { $regex: 'CRTOPUP', $options: 'i' },
    }).sort({ createdAt: -1 });

    if (tx) {
      res.json({ success: true, status: 'paid', amount: tx.amount, tx });
    } else {
      res.json({ success: true, status: 'pending' });
    }
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = { app, server, io };
