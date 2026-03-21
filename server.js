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
let MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("[ERR] Thiếu MONGODB_URI trong .env");
  process.exit(1);
}

// Fix: nếu URI có dạng mongodb+srv://user@domain:pass@host (username chứa @)
// thì encode @ trong username thành %40 để driver parse đúng
try {
  // Tách scheme ra
  const schemeMatch = MONGODB_URI.match(/^(mongodb(?:\+srv)?:\/\/)(.*)/s);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    const rest   = schemeMatch[2];
    // Tìm @ cuối cùng phân cách credentials và host
    const lastAt = rest.lastIndexOf("@");
    if (lastAt > 0) {
      const credentials = rest.substring(0, lastAt);   // user:pass
      const hostPart    = rest.substring(lastAt + 1);  // host/db?params
      // Tìm : phân cách user và password (lấy : cuối trong credentials)
      const colonIdx = credentials.lastIndexOf(":");
      if (colonIdx > 0) {
        const rawUser = credentials.substring(0, colonIdx);
        const rawPass = credentials.substring(colonIdx + 1);
        // Encode @ trong username nếu có
        const safeUser = rawUser.replace(/@/g, "%40");
        const safePass = encodeURIComponent(decodeURIComponent(rawPass)); // normalize
        // Đảm bảo có /crabor database name
        const hostFixed = hostPart.includes("/crabor") ? hostPart
          : hostPart.replace(/^([^/?]+)(\/?)(\?|$)/, "$1/crabor$2$3");
        MONGODB_URI = `${scheme}${safeUser}:${safePass}@${hostFixed}`;
        // Thêm retryWrites nếu chưa có
        if (!MONGODB_URI.includes("retryWrites")) {
          MONGODB_URI += (MONGODB_URI.includes("?") ? "&" : "?") + "retryWrites=true&w=majority";
        }
      }
    }
  }
  console.log("[DB] Connecting to MongoDB...");
} catch(e) {
  console.error("[WARN] URI parse error:", e.message);
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
  store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'crabor', collectionName: 'sessions', ttl: 24 * 60 * 60 }),
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
const otpStore = new Map();

// Dọn expired OTPs mỗi 10 phút
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore) { if (v.expiry < now) otpStore.delete(k); }
}, 10 * 60 * 1000);

// Gửi OTP qua SpeedSMS
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