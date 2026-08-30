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
const fs = require("fs");
const expo = new Expo();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── SEPAY CONFIG (tập trung — thay toàn bộ hardcode ngân hàng) ──
// Bank: KienLongBank · STK 101499100004630283 (tài khoản xác thực tự động)
// VietQR bank code KLB (KienLongBank). Cấu hình qua .env để dễ đổi.
const SEPAY_CONFIG = {
  bankCode:    process.env.SEPAY_BANK_CODE    || 'KLB',
  bankName:    process.env.SEPAY_BANK_NAME    || 'KienLongBank',
  accountNo:   process.env.SEPAY_ACCOUNT      || '101499100004630283',
  accountName: process.env.SEPAY_ACCOUNT_NAME || 'KIEU THANH HAI',
  apiToken:    process.env.SEPAY_API_TOKEN    || '',
  webhookUrl:  process.env.SEPAY_WEBHOOK_URL  || '/api/webhook/sepay',
  // Secret để verify chữ ký webhook (nếu cấu hình HMAC-SHA256 trên my.sepay.vn)
  webhookSecret: process.env.SEPAY_WEBHOOK_SECRET || '',
};

// Helper: tạo QR SePay (qr.sepay.vn)
function sepayQrUrl(amount, des) {
  return `https://qr.sepay.vn/img?bank=${SEPAY_CONFIG.bankCode}&acc=${SEPAY_CONFIG.accountNo}&template=compact&amount=${amount}&des=${encodeURIComponent(des)}`;
}
// Helper: tạo QR VietQR (img.vietqr.io) — fallback khi SePay QR không dùng được
function vietQrUrl(amount, des) {
  return `https://img.vietqr.io/image/${SEPAY_CONFIG.bankCode}-${SEPAY_CONFIG.accountNo}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(des)}&accountName=${encodeURIComponent(SEPAY_CONFIG.accountName)}`;
}


const cocoEngine = require("./coco-engine");
const { CocoKnowledge, CocoMemory, CocoLearnLog, CocoTools, cocoRespond, processLearnQueue, seedCocoKnowledge } = cocoEngine;
const cocoOps   = require("./coco-ops");
const cocoBrain = require("./coco-brain");
const { cocoThink, CocoReasoning, checkBrainStatus, printBrainSetupGuide, mountCocoRoutes } = cocoBrain;

// COCO_BRAIN defaults to 'groq' — Coco AI chạy Groq; CRABOR Agent override backend cloudflare
// (fallback giữ sẵn: Groq → OpenRouter → Claude → Cloudflare → rule)
process.env.COCO_BRAIN = process.env.COCO_BRAIN || 'groq';
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
async function loadSessionFromHeader(req, res) {
  if (req.session?.shipperId || req.session?.userId || req.session?.adminId || req.session?.partnerId) return; // đã có session
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
    else if (sess.partnerId) { req.session.partnerId = sess.partnerId; req.session.userPhone = sess.userPhone; req.session.partnerModule = sess.partnerModule; req.session.role = 'partner'; }
    console.log('[SessionFallback] Loaded from X-Session-ID:', xSid.substring(0,8) + '... role:', req.session.role);
    // Quan trọng: ghi đè session data vào đúng session doc của X-Session-ID
    // Sau đó tell client dùng đúng session này (thay vì tạo session mới mỗi request)
    if (res && !res.headersSent) {
      const cookieName = 'crabor.sid';
      const signed = 's:' + require('cookie-signature').sign(xSid, process.env.SESSION_SECRET || 'crabor_secret_2024');
      res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(signed)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`);
    }
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
    // Coco AI: seed knowledge + mount brain routes + start ops crons
    seedCocoKnowledge().catch(e => console.log("[Coco] Seed:", e.message));
    const { mountCocoRoutes } = require("./coco-brain");
    mountCocoRoutes(app, io);
    printBrainSetupGuide();
    startCronJobs();
    setTimeout(() => startOpsCrons(io), 3000); // delay 3s để DB ổn định
    // Admin seed disabled — tạo thủ công nếu cần

    // Test seed disabled — không tạo 0999999999 / 0888888888 / 0777777777
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
// ── Capture raw body để verify chữ ký webhook SePay HMAC ──
app.use(express.json({
  limit: '15mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

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

function requireApp(req, res, next) {
  const key = process.env.ADMIN_APP_KEY || "";
  if (!key) return next();
  if (req.headers["x-app-key"] !== key) {
    return res.status(403).json({ success: false, error: "Invalid app key" });
  }
  next();
}

// Admin app key guard: admin pages/APIs require ADMIN_APP_KEY (desktop app only)
const ADMIN_APP_KEY = process.env.ADMIN_APP_KEY || "";
if (ADMIN_APP_KEY) {
  app.get("/admin.html", (req, res) => {
    const appKey =
      (req.headers["x-app-key"] || "") === ADMIN_APP_KEY ||
      (req.query && req.query.app === ADMIN_APP_KEY);
    if (!appKey) return res.status(403).type("html").send("Blocked: admin access requires the desktop app.");
    const html = fs.readFileSync(path.join(__dirname, "public", "admin.html"), "utf8");
    return res.send(html);
  });
  app.use("/api/admin", requireApp);
}

// Static files
app.use(express.static(path.join(__dirname, "public")));


// ── DISCORD WEBHOOK: Thông báo đơn hàng ──────────────────────
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1537268408175956120/PGWXk0ITAswTFfZZKY-r7SvtyHhsx9A4PUM6zcG-kVhAVWYDI7zRF-nZDCFpDaezRFSH";

const DISCORD_EMOJI = {
  pending:    "🆕",
  confirmed:  "✅",
  delivering: "🛵",
  delivered:  "🎉",
  cancelled:  "❌",
};
const DISCORD_COLOR = {
  pending:    0x3498db,   // xanh dương
  confirmed:  0x2ecc71,   // xanh lá
  delivering: 0xf39c12,   // cam
  delivered:  0x95a5a6,   // xám
  cancelled:  0xe74c3c,   // đỏ
};

async function notifyDiscord(status, order) {
  try {
    const emoji = DISCORD_EMOJI[status] || "📦";
    const color = DISCORD_COLOR[status] || 0x95a5a6;
    const statusText = {
      pending: "Đơn hàng mới",
      confirmed: "Đã xác nhận",
      delivering: "Đang giao hàng",
      delivered: "Giao thành công",
      cancelled: "Đơn bị hủy",
    }[status] || "Cập nhật đơn";

    const total = (order.finalTotal || order.total || 0).toLocaleString("vi-VN");
    const moduleNames = { food: "🍜 Food", ride: "🚗 Ride", gl: "👔 Giặt là", gv: "🧹 Giúp việc", cs: "🛍️ ChinaShop", rx: "🚕 Ride Express" };
    const moduleName = moduleNames[order.module] || order.module || "N/A";

    const items = Array.isArray(order.items) ? order.items.map(i => `${i.qty}× ${i.name}`).join(", ") : "(không có món)";
    const address = order.address || "(không rõ)";
    const district = order.district || "";
    const orderId = order.orderId || order._id?.toString()?.slice(-6) || "N/A";

    const fields = [
      { name: "📋 Mã đơn", value: `\`${orderId}\``, inline: true },
      { name: "📦 Module", value: moduleName, inline: true },
      { name: "💰 Tổng tiền", value: `${total}đ`, inline: true },
      { name: "📍 Khu vực", value: district || "N/A", inline: true },
      { name: "🍽️ Món hàng", value: items.slice(0, 1024), inline: false },
      { name: "🏠 Địa chỉ", value: address.slice(0, 1024), inline: false },
    ];

    if (status === "cancelled" && order.cancelReason) {
      fields.push({ name: "⚠️ Lý do hủy", value: order.cancelReason.slice(0, 1024), inline: false });
    }
    if (status === "delivered" && order.deliveredAt) {
      fields.push({ name: "⏰ Thời gian giao", value: new Date(order.deliveredAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }), inline: true });
    }

    const embed = {
      title: `${emoji} ${statusText}`,
      color: color,
      fields: fields,
      timestamp: new Date().toISOString(),
      footer: { text: "CRABOR Super App" },
    };

    await axios.post(DISCORD_WEBHOOK_URL, {
      username: "CRABOR Orders",
      embeds: [embed],
    });
  } catch (e) {
    console.error("[Discord] Webhook error:", e.message);
  }
}

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
    if (String(room || "").toLowerCase() === "admin") {
      const key = process.env.ADMIN_APP_KEY || "";
      const appKey = socket.handshake && socket.handshake.auth && socket.handshake.auth.appKey;
      if (key && appKey !== key) return;
    }
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

  // Call notification: shipper gọi customer hoặc ngược lại
  socket.on("incomingCallNotify", (data) => {
    const { orderId, from } = data;
    if (!orderId || !from) return;
    io.to(`order_${orderId}`).emit("incomingCall", { orderId, from });
  });


  // Shipper join room riêng
  socket.on("join_shipper", (shipperId) => {
    if (shipperId) {
      const roomName = `shipper_${shipperId}`;
      socket.join(roomName);
      socket.data.shipperId = shipperId; // track để xử lý disconnect
      console.log(`🛵 Shipper joined room [${roomName}] socketId=${socket.id}`);
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

  // Customer/Shipper join order room để nhận shipperLocation
  socket.on("join_order", (orderId) => {
    if (orderId) {
      socket.join(`order_${orderId}`);
      console.log(`[Socket] Client joined order room: order_${orderId}`);
    }
  });

  socket.on("leave_order", (orderId) => {
    if (orderId) {
      socket.leave(`order_${orderId}`);
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

  socket.on("disconnect", async () => {
    console.log("🔌 Client disconnected:", socket.id);
    // Nếu là shipper, set lastSeen để detect offline sau 60s
    if (socket.data?.shipperId) {
      try {
        await Shipper.findByIdAndUpdate(socket.data.shipperId, { lastSeen: new Date() });
      } catch(_) {}
    }
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
  phoneVerified:   { type: Boolean, default: false },
  creditBnplEnabled: { type: Boolean, default: false },
  creditLoanEnabled: { type: Boolean, default: false },
  // Hệ thống ĐIỂM TIN CẬY (trust score) 0-100 đánh giá hành vi chi tiêu
  trustScore:        { type: Number, default: 60, min: 0, max: 100 },
  bnplOnTimePaid:    { type: Number, default: 0, min: 0 },   // tổng giá trị BNPL đã trả ĐÚNG HẠN (cho tăng hạn mức)
  bnplLateCount:     { type: Number, default: 0, min: 0 },   // số lần trả trễ hạn
  bnplActivationStatus: { type: String, enum: ["none","pending","approved","rejected"], default: "none" }, // trạng thái mở khóa Ví Trả Sau (ký kết hợp đồng)
  transactionPassword: { type: String },   // bcrypt hash — mật khẩu giao dịch (xác nhận vay/thanh toán)
  kycStatus:       { type: String, enum: ["none","pending","verified","rejected"], default: "none" },
  kyc:             {
    selfie:      String,
    cccdFront:   String,
    cccdBack:    String,
    submittedAt: Date,
    reviewedAt:  Date,
    rejectReason:String,
  },
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
  cancelCount:     { type: Number, default: 0, min: 0 }, // số lần hủy đơn
  cashBlocked:     { type: Boolean, default: false },      // bị khóa thanh toán tiền mặt
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
  violationKeyword: { type: String, default: null },  // từ khóa vi phạm chính sách (nếu có)
}, { timestamps: true });

productSchema.index({ partnerId: 1, available: 1 });   // menu query
productSchema.index({ category: 1 });                  // filter by category
productSchema.index({ sold: -1 });                     // best seller
productSchema.index({ name: "text", description: "text" }); // search
const Product = mongoose.model("Product", productSchema);

// ── ORDER ─────────────────────────────────
const orderSchema = new mongoose.Schema({
  orderId:      { type: String, unique: true },
  clientRequestId: { type: String, index: true, sparse: true },   // chống tạo đơn trùng
  module:       { type: String, enum: ["food","laundry","cleaning","china_shop","ride"], required: true },
  customerId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  shipperId:    { type: mongoose.Schema.Types.ObjectId, ref: "Shipper" },
  partnerId:    { type: mongoose.Schema.Types.ObjectId },
  customerName: { type: String, trim: true },
  customerPhone:{ type: String, trim: true },
  items:        [{
    productId:  mongoose.Schema.Types.ObjectId,
    name:       { type: String, required: true },
    qty:        { type: Number, required: true, min: 1 },
    price:      { type: Number, required: true, min: 0 },
  }],
  address:      { type: String, required: true, trim: true },
  addressLat:   { type: Number, default: null },
  addressLng:   { type: Number, default: null },
  fromLat:       { type: Number, default: null },
  fromLng:       { type: Number, default: null },
  toLat:         { type: Number, default: null },
  toLng:         { type: Number, default: null },
  partnerLat:    { type: Number, default: null },
  partnerLng:    { type: Number, default: null },
  partnerName:   { type: String, trim: true },
  partnerAddress:{ type: String, trim: true },
  district:     { type: String, trim: true },
  total:        { type: Number, required: true, min: 0 },
  serviceFee:   { type: Number, default: 0, min: 0 },
  shipFee:      { type: Number, default: 0, min: 0 },
  discount:     { type: Number, default: 0, min: 0 },
  finalTotal:   { type: Number, min: 0 },
  status:          { type: String, enum: ["pending","confirmed","preparing","shipper_accepted","picking_up","at_partner","picked_up","delivering","delivered","cancelled","refunded","payment_pending_review","payment_confirmed","payment_confirmed_payos","payment_confirmed_sepay","finding_driver","no_driver","partner_accepted","ready","ready_return"], default: "pending" },
  paymentMethod:{ type: String, enum: ["cash","momo","zalopay","bank","payos","sepay","bank_transfer","wallet","vnpay","bnpl"], default: "cash" },
  paymentStatus:{ type: String, enum: ["unpaid","paid","refunded","pending_review"], default: "unpaid" },
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
  // Điểm loyalty đã cộng cho đơn này chưa (chống cộng đúp)
  loyaltyPointsGranted: { type: Boolean, default: false },
  // Phân bổ chi phí voucher (CRABOR là trung gian, mặc định shipper + đối tác gánh;
  // chỉ khi cả 2 đạt ≥100 đơn/tháng thì CRABOR chịu toàn bộ)
  voucherShipperBear: { type: Number, default: 0, min: 0 },
  voucherPartnerBear: { type: Number, default: 0, min: 0 },
  voucherCraborBear:  { type: Number, default: 0, min: 0 },
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
  avatar:      { type: String }, // Ảnh đại diện từ selfie hoặc upload riêng
  earlyBird:   {
    discountRate:     { type: Number, default: 9 },
    ordersCompleted:  { type: Number, default: 0 },
    refunded:         { type: Boolean, default: false },
  },
  adminNotes:  String,
  lastSeen:    Date,
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
  // Loại tài khoản: 'shipper' = nhận giao hàng + xe công nghệ + giặt là;
  // 'cleaning' = chỉ nhận dọn nhà (đăng ký qua form dọn nhà)
  workType:    { type: String, enum: ['shipper', 'cleaning'], default: 'shipper' },
  // Theo dõi thời gian online (real-time) — cho nhiệm vụ, cấp bậc, chính sách đảm bảo thu nhập
  onlineAt:           { type: Date },            // thời điểm bật online gần nhất
  onlineSecondsToday: { type: Number, default: 0 },
  onlineDay:          { type: String },           // YYYY-MM-DD
  onlineSecondsMonth: { type: Number, default: 0 },
  onlineMonth:        { type: String },           // YYYY-MM
  onlineSecondsTotal: { type: Number, default: 0 },
  // Nhiệm vụ đã nhận thưởng (chống nhận đúp)
  missionClaims:      [{ id: String, day: String, claimedAt: Date }],
  // Đồng ý Điều khoản & Chính sách hợp đồng shipper (hiện 1 lần sau đăng nhập đầu tiên)
  termsAccepted:    { type: Boolean, default: false },
  termsAcceptedAt:  { type: Date },
  // Xác minh danh tính (CCCD 2 mặt + gương mặt) — bắt buộc trước khi nhận đơn
  identityVerified:  { type: Boolean, default: false },
  identityStatus:    { type: String, enum: ["none","submitted","approved","rejected"], default: "none" },
  identitySubmittedAt: Date,
  identityRejectedAt: Date,
  identityRejectNote:  String,
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
  avatar:      { type: String }, // Logo/ảnh đại diện cửa hàng
  coverImage:  { type: String }, // Ảnh bìa
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
  // ── Spotlight "quán nổi bật" ──
  featured:         { type: Boolean, default: false },
  featuredUntil:    { type: Date },
  featuredBanner:   String,
  featuredBannerVertical: String,
  featuredHours:    Number,
  featuredPackage:  String,
  featuredAt:       Date,
  // ── Chặn do vi phạm chính sách đăng món ──
  blockedUntil:     { type: Date },          // khóa quán tới giờ này (vd 24h)
  blockReason:      { type: String, trim: true }, // lý do block (hiển thị cho quán)
  blockViolation:   { type: String, trim: true }, // món/from khóa đã vi phạm
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

// ── FEATURED REQUEST — yêu cầu làm "quán nổi bật" ───────────
const featuredRequestSchema = new mongoose.Schema({
  requestId:      { type: String, unique: true, sparse: true },
  partnerId:      { type: mongoose.Schema.Types.ObjectId, ref: "FoodPartner" },
  partnerName:    String,
  bannerImage:    String,   // base64 hoặc URL banner
  bannerVertical: String,   // ảnh dọc (9:16) dùng cho màn quảng cáo dọc
  hours:          { type: Number, min: 1, max: 24, default: 4 },
  amount:         { type: Number, default: 0 }, // hours * 50.000
  paymentMethod:  { type: String, enum: ["sepay","payos","wallet"], default: "sepay" },
  paymentStatus:  { type: String, enum: ["unpaid","paid","pending_review"], default: "unpaid" },
  status:         { type: String, enum: ["pending","approved","rejected"], default: "pending" },
  sePayRef:       String,
  payosOrderCode: String,
  payosCheckoutUrl: String,
  adminNote:      String,
  approvedAt:     Date,
  rejectedAt:     Date,
  paidAt:         Date,
}, { timestamps: true });

featuredRequestSchema.pre("save", function(next) {
  if (!this.requestId) this.requestId = "CRFTR-" + Date.now().toString(36).toUpperCase();
  next();
});
const FeaturedRequest = mongoose.model("FeaturedRequest", featuredRequestSchema, "featured_requests");

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
  target:      { type: String, enum: ['order','ship'], default: 'order' }, // 'order': giảm giá trị đơn | 'ship': giảm phí giao
  weekly:      { type: String, default: '' },                // mã tuần ISO (vd 2026W34) nếu là voucher tuần tự động
  source:      { type: String, enum: ['public','loyalty'], default: 'public' }, // 'loyalty' = đổi bằng điểm, chỉ chủ sở hữu dùng được
  ownerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },           // user sở hữu (voucher loyalty)
  active:      { type: Boolean, default: true },
  expiresAt:   { type: Date, required: true },
  description: { type: String, trim: true },
  createdBy:   { type: String, default: 'admin' },
}, { timestamps: true });
const Voucher = mongoose.model('Voucher', voucherSchema);

// ── LOYALTY LOG — lịch sử tích/đổi điểm thưởng ──
const loyaltyLogSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  delta:     { type: Number, required: true },            // + tích điểm | - trừ điểm khi đổi
  points:    { type: Number, default: 0 },                // số dư sau khi đổi
  type:      { type: String, enum: ['earn','redeem','bonus'], default: 'earn' },
  description:{ type: String, trim: true },
  voucherCode:{ type: String, default: '' },
}, { timestamps: true });
const LoyaltyLog = mongoose.model('LoyaltyLog', loyaltyLogSchema);


// ── AI BANNER ─────────────────────────────────
const aiBannerSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  subtitle:    { type: String, trim: true },
  badge:       { type: String, trim: true },
  gradient:    { type: String, default: "linear-gradient(135deg,#E8504A,#c93d37)" },
  emoji:       { type: String, default: "🦀" },
  imageUrl:    { type: String },         // AI-generated banner image URL (Puter.js GPT Image)
  ctaText:     { type: String, default: "Đặt ngay" },
  ctaLink:     { type: String, default: "/customer" },
  htmlContent: { type: String },       // full custom HTML nếu muốn
  content:     { type: String },       // nội dung bài viết / tin tức (text, scroll để đọc)
  prompt:      { type: String },       // prompt admin đã dùng
  active:      { type: Boolean, default: true },
  apps:        { type: [String], default: ['customer'] },  // targets: 'customer' | 'partner' | 'shipper'
  category:    { type: String, default: 'promo' },   // 'promo' | 'finance' (banner tài chính cho màn hình tài chính)
  order:       { type: Number, default: 0 },
  clicks:      { type: Number, default: 0 },
  impressions: { type: Number, default: 0 },
  // Mạng xã hội: tym (bot + user)
  likes:         { type: Number, default: 0 },
  likedBy:       { type: [mongoose.Schema.Types.ObjectId], default: [] }, // user đã tym (chống spam)
  botLikesTarget:{ type: Number },  // mục tiêu tym bot ngẫu nhiên [min,max]
  expiresAt:   Date,
}, { timestamps: true });
const AIBanner = mongoose.model("AIBanner", aiBannerSchema);


// ── AUTO FEATURE STATE — tự chọn "quán nổi bật" mỗi 48h ──
const featureStateSchema = new mongoose.Schema({
  key:                 { type: String, unique: true, default: "auto_feature" },
  status:              { type: String, enum: ["idle", "in_progress"], default: "idle" },
  lastRunAt:           Date,
  nextRunAt:           Date,
  selectedPartnerId:   mongoose.Schema.Types.ObjectId,
  selectedAt:          Date,
}, { timestamps: true });
const FeatureState = mongoose.model("FeatureState", featureStateSchema, "featurestate");


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
  ownerType: { type: String, enum: ['user','shipper','partner'], required: true },
  type:      { type: String, enum: ['credit','debit','refund','withdraw','loan_receive','loan_repay','bnpl_pay'], required: true },
  amount:    { type: Number, required: true, min: 0 },
  balance:   { type: Number, required: true },        // số dư sau giao dịch
  ref:       { type: String, trim: true },             // orderId, loanId...
  note:      { type: String, trim: true, maxlength: 200 },
  status:    { type: String, enum: ['completed','pending','failed'], default: 'completed' },
}, { timestamps: true });
walletTxSchema.index({ ownerId: 1, createdAt: -1 });
const WalletTx = mongoose.model('WalletTx', walletTxSchema);

// ── NOTIFICATION (chuông thông báo) ───────────────────────────
const notificationSchema = new mongoose.Schema({
  ownerType: { type: String, enum: ['user','shipper','partner'], required: true },
  ownerId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  type:      { type: String, enum: ['featured','new_order','income','withdraw','topup','product','cash_due','support','warning','system','block'], default: 'system' },
  title:     { type: String, required: true, trim: true },
  body:      { type: String, trim: true, maxlength: 500 },
  ref:       { type: String, trim: true },               // orderId, productId...
  refModule: { type: String, trim: true },               // food|laundry|ride|cleaning|china...
  read:      { type: Boolean, default: false },
}, { timestamps: true });
notificationSchema.index({ ownerId: 1, read: 1, createdAt: -1 });
const Notification = mongoose.model('Notification', notificationSchema);

// Helper: tạo notification + emit socket realtime
async function notifyUser(ownerType, ownerId, { type = 'system', title, body = '', ref = '', refModule = '' }) {
  try {
    const n = await Notification.create({ ownerType, ownerId, type, title, body, ref, refModule });
    const room = ownerType === 'user' ? `customer_${ownerId}` : `${ownerType}_${ownerId}`;
    const io = global._io;
    if (io) io.to(room).emit('new_notification', { _id: n._id, type, title, body, ref, refModule, read: false, createdAt: n.createdAt });
    return n;
  } catch (e) { console.error('[Notify] error:', e.message); return null; }
}

// ── WITHDRAW REQUEST (rút tiền về ngân hàng) ──────────────────
const withdrawRequestSchema = new mongoose.Schema({
  ownerId:     { type: mongoose.Schema.Types.ObjectId, required: true },
  ownerType:   { type: String, enum: ['user','shipper','partner'], required: true },
  amount:      { type: Number, required: true, min: 0 },
  bankName:    { type: String, trim: true, required: true },
  accountNo:   { type: String, trim: true, required: true },
  accountName: { type: String, trim: true, required: true },
  status:      { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  adminNote:   { type: String, trim: true },
  processedAt: Date,
}, { timestamps: true });
withdrawRequestSchema.index({ status: 1, createdAt: -1 });
const WithdrawRequest = mongoose.model('WithdrawRequest', withdrawRequestSchema);

// ── SEPAY TRANSACTION LOG (chống trùng webhook / idempotent) ──
const sePayTxSchema = new mongoose.Schema({
  txId:       { type: String, unique: true, required: true },   // SePay transaction id — chống trùng
  ref:        { type: String, trim: true },                     // mã ref CRTOPUP/CRORD/...
  amount:     { type: Number, default: 0 },
  rawContent: { type: String, trim: true },
  handled:    { type: Boolean, default: false },
  note:       { type: String, trim: true },
}, { timestamps: true });
const SePayTx = mongoose.model('SePayTx', sePayTxSchema);

// ── TEST PAYMENT (trang test chuyển khoản SePay) ──────────────────────
const testPaySchema = new mongoose.Schema({
  ref:      { type: String, unique: true, required: true },
  amount:   { type: Number, required: true, min: 1000 },
  status:   { type: String, enum: ['pending','paid'], default: 'pending' },
  paidAmount: { type: Number, default: 0 },
  paidAt:   Date,
}, { timestamps: true });
testPaySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 }); // tự xoá sau 24h
const TestPayment = mongoose.model('TestPayment', testPaySchema);

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
  // Thẩm định bổ sung
  kyc: {
    facePhoto: String,
    cccdFront: String,
    cccdBack: String,
    emergencyContact: { name: String, phone: String, relation: String },
    submittedAt: Date,
  },
}, { timestamps: true });
const Loan = mongoose.model('Loan', loanSchema);

// ── BNPL TRANSACTION (từng giao dịch mua trả sau) ───────────
const bnplTxSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId:      { type: String, trim: true },
  serviceType:  { type: String, default: 'food' },  // food, laundry, cleaning...
  amount:       { type: Number, required: true },   // baseAmount + fee (tổng ghi nợ trả sau)
  baseAmount:   { type: Number, default: 0 },       // tổng đơn gốc (trước phí)
  fee:          { type: Number, default: 0 },       // phí giao dịch trả sau (3% baseAmount)
  billingMonth: { type: String, required: true },   // "2026-07" — tháng tính vào hóa đơn
  status:       { type: String, enum: ['pending_bill','billed','paid'], default: 'pending_bill' },
  invoiceId:    { type: mongoose.Schema.Types.ObjectId }, // thuộc hóa đơn nào
}, { timestamps: true });
const BNPLTx = mongoose.model('BNPLTx', bnplTxSchema);

// ── BNPL INVOICE (hóa đơn hàng tháng) ────────────────────
const bnplInvoiceSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  billingMonth:   { type: String, required: true },  // "2026-07"
  totalAmount:    { type: Number, required: true },   // tổng tiền gốc tháng đó (không gồm phí)
  bnplFee:        { type: Number, default: 0 },       // tổng phí giao dịch trả sau 3% (các giao dịch)
  serviceFee:     { type: Number, default: 0 },       // phí dịch vụ cố định 30k/tháng khi có giao dịch trả sau
  lateFee:        { type: Number, default: 0 },       // phí phạt quá hạn 1%/ngày trên tổng hóa đơn (tính động)
  installFee:     { type: Number, default: 0 },       // phí 10% nếu trả góp
  finalAmount:    { type: Number, required: true },   // totalAmount + bnplFee + fees
  isInstallment:  { type: Boolean, default: false },
  installTerms:   { type: Number, default: 1 },       // số kỳ
  installPaid:    { type: Number, default: 0 },       // số kỳ đã trả
  perTerm:        { type: Number, default: 0 },       // số tiền phải trả mỗi kỳ trả góp
  paymentAmount:  { type: Number, default: 0 },       // số tiền đang/đã trả lần cuối (kỳ hiện tại)
  issuedAt:       { type: Date, required: true },     // ngày 1 tháng tiếp
  dueDate:        { type: Date, required: true },     // ngày 15 tháng tiếp
  paidAt:         Date,
  status:         { type: String, enum: ['draft','issued','paid','overdue','installment'], default: 'draft' },
  sePayRef:       { type: String },   // mã chuyển khoản SePay
  payosOrderCode: { type: String },   // mã PayOS khi trả hoá đơn bằng PayOS
  paymentMethod:  { type: String },   // wallet | sepay | payos
}, { timestamps: true });
bnplInvoiceSchema.index({ userId: 1, billingMonth: 1 }); // cho phép nhiều hóa đơn/tháng nếu có pending mới sau khi đã chốt
const BNPLInvoice = mongoose.model('BNPLInvoice', bnplInvoiceSchema);

// ── BNPL CREDIT LIMIT + ĐIỂM TIN CẬY ─────────────────────
// Hạn mức Ví Trả Sau: nền 2tr khi đã mở khóa; tăng theo TỔNG BNPL đã trả ĐÚNG HẠN.
// Chương trình "chi tiêu & trả đúng → tăng hạn mức": ≥2tr→4tr, ≥4tr→8tr, ≥8tr→16tr, ≥16tr→32tr
function getBnplLimit(onTimePaid = 0) {
  const otp = Number(onTimePaid) || 0;
  if (otp <  2000000)  return 2000000;   // hạn mức nền khi vừa mở khóa
  if (otp <  4000000)  return 4000000;
  if (otp <  8000000)  return 8000000;
  if (otp < 16000000)  return 16000000;
  return 32000000;
}
// Thang hạn mức + mức chi tiêu cần để đạt hạn mức kế (cho UI hiển thị chương trình)
const BNPL_LIMIT_TIERS = [
  { spentFor: 0,         limit: 2000000,  nextSpent: 2000000 },
  { spentFor: 2000000,   limit: 4000000,  nextSpent: 4000000 },
  { spentFor: 4000000,   limit: 8000000,  nextSpent: 8000000 },
  { spentFor: 8000000,   limit: 16000000, nextSpent: 16000000 },
  { spentFor: 16000000,  limit: 32000000, nextSpent: null },
];
// Điểm tin cậy tối thiểu để mở khóa Ví Trả Sau
const TRUST_MIN_UNLOCK = 50;
// Hủy ≥ 3 đơn → khóa BNPL ngay cả khi đủ 5tr chi tiêu
const TRUST_CANCEL_LOCK = 3;
// Cập nhật điểm tin cậy + các chỉ số liên quan (an toàn, không ném lỗi)
async function adjustTrust(userId, deltas = {}) {
  try {
    const u = await User.findById(userId).select('trustScore') || { trustScore: 60 };
    const cur = Math.max(0, Math.min(100, (u.trustScore ?? 60) + (deltas.trust || 0)));
    const inc = { trustScore: cur - (u.trustScore ?? 60) };
    if (deltas.onTimePaid)            inc.bnplOnTimePaid = deltas.onTimePaid;
    if (deltas.lateCount)             inc.bnplLateCount = deltas.lateCount;
    if (deltas.cancelCount)           inc.cancelCount = deltas.cancelCount;
    await User.findByIdAndUpdate(userId, { $inc: inc }).catch(()=>{});
  } catch(e) {}
}
// Gọi khi 1 hóa đơn BNPL được thanh toán ĐỦ: trả đúng hạn → +5 điểm + cộng onTimePaid; trễ → −20 điểm + tăng lateCount
async function applyBnplPaidTrust(userId, inv) {
  try {
    if (!inv || !userId) return;
    const now = new Date();
    const onTime = !inv.dueDate || new Date(inv.dueDate) >= now;
    const paidAmt = Math.round(inv.finalAmount || inv.totalAmount || 0);
    if (onTime) await adjustTrust(userId, { trust: +5, onTimePaid: paidAmt });
    else        await adjustTrust(userId, { trust: -20, lateCount: 1 });
  } catch(e) {}
}
// Kiểm tra "hay hủy đơn" → khóa BNPL dù có đủ 5tr chi tiêu
function isCancelLocked(user) {
  return (user?.cancelCount || 0) >= TRUST_CANCEL_LOCK;
}
function getCurrentBillingMonth() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
}
// Phí giao dịch trả sau = 3% trên tổng đơn hàng (tách riêng trên hóa đơn)
const BNPL_FEE_RATE = 0.03;
const bnplFeeOf = (base) => Math.round((Number(base) || 0) * BNPL_FEE_RATE);
// Phí phạt quá hạn = 1% mỗi ngày trên tổng hóa đơn (gốc + phí trả sau), không chồng lãi.
const BNPL_PENALTY_RATE = 0.01;
// Phí dịch vụ cố định 30.000đ/tháng khi có phát sinh giao dịch trả sau trong tháng
const BNPL_SERVICE_FEE = 30000;
function bnplDaysOverdue(inv, now = new Date()) {
  if (!inv || !inv.dueDate) return 0;
  const due = new Date(inv.dueDate);
  const late = now > due;
  if (!late) return 0;
  return Math.max(1, Math.floor((now - due) / (24 * 60 * 60 * 1000)));
}
function bnplPenaltyOf(inv, now = new Date()) {
  const days = bnplDaysOverdue(inv, now);
  if (!days) return 0;
  const base = (inv.totalAmount || 0) + (inv.bnplFee || 0);
  return Math.floor(base * BNPL_PENALTY_RATE * days);
}
// Khóa Ví Trả Sau + Vay Nhanh: true khi user còn hóa đơn quá hạn chưa trả
// (hóa đơn tháng status='overdue' HOẶC hóa đơn trả góp mà kỳ hiện tại đã quá hạn)
async function hasOverdueBnpl(userId, now = new Date()) {
  const overdue = await BNPLInvoice.find({ userId, status: { $in: ['overdue', 'installment'] } }).lean().catch(() => []);
  for (const inv of overdue) {
    if (inv.status === 'overdue') return true;
    if (inv.isInstallment) {
      const termDue = getTermDueDate(inv);
      if (now > new Date(termDue)) return true;
    }
  }
  return false;
}
function getNextBillingDates() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth()+1, 1);
  const due  = new Date(now.getFullYear(), now.getMonth()+1, 15, 15, 0, 0);
  return { issuedAt: next, dueDate: due };
}
// Ngày đáo hạn KỲ HIỆN TẠI của hóa đơn trả góp = dueDate + (installPaid) tháng (kỳ 1 = dueDate, kỳ 2 = +1 tháng...)
function getTermDueDate(inv) {
  if (!inv) return null;
  const isInstall = !!inv.isInstallment && inv.status === 'installment';
  const n = isInstall ? (inv.installPaid || 0) : 0;
  const d = new Date(inv.dueDate);
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}


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


// ── TRAINING QA — train CRABOR Agent / Coco bằng cặp câu hỏi–câu trả lời ──
const trainingQaSchema = new mongoose.Schema({
  agent:    { type: String, enum: ['agent', 'coco', 'all'], default: 'agent' }, // đối tượng được train
  question: { type: String, required: true },        // mẫu câu hỏi / từ khóa
  answer:   { type: String, required: true },        // câu trả lời mong muốn
  category: { type: String, default: 'general' },    // nhóm: tài chính, đơn hàng, nhân viên...
  enabled:  { type: Boolean, default: true },
}, { timestamps: true });
const TrainingQA = mongoose.models.TrainingQA || mongoose.model("TrainingQA", trainingQaSchema);

// ── AGENT JOBS — CRABOR Agent nhận task compile plugin, gửi xuống môi trường local (laptop) ──
// Render không chạy gradle/javac được → laptop chạy executor poll các job: status queued → running → done/failed
const agentJobSchema = new mongoose.Schema({
  jobType:  { type: String, default: 'compile-plugin' },
  sessionId:{ type: String, default: '' },
  status:   { type: String, enum: ['queued', 'running', 'done', 'failed', 'canceled'], default: 'queued' },
  request:  { type: mongoose.Schema.Types.Mixed, default: {} }, // { pluginName, files: [{name, content}], prompt }
  result:   { type: mongoose.Schema.Types.Mixed, default: null }, // { jarB64: gzip+base64, jarName, jarSize, buildLog }
  error:    { type: String, default: '' },
  attempts: { type: Number, default: 0 },
}, { timestamps: true });
agentJobSchema.index({ status: 1, createdAt: 1 });
const AgentJob = mongoose.models.AgentJob || mongoose.model("AgentJob", agentJobSchema);

// Auth cho executor (laptop) gọi API lấy/trả job
function executorAuth(req, res, next) {
  const token = String(req.headers['x-executor-token'] || req.query.token || '');
  const secret = process.env.AGENT_EXECUTOR_TOKEN;
  if (!secret) return res.status(503).json({ success: false, message: 'AGENT_EXECUTOR_TOKEN chưa cấu hình' });
  try {
    const a = Buffer.from(token); const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, message: 'Sai token executor' });
  } catch (e) { return res.status(401).json({ success: false, message: 'Sai token executor' }); }
  next();
}

// Helper: tách khối code từ tin nhắn (```...``` hoặc code fence) + đoán tên file
function extractAgentFiles(text) {
  const files = [];
  const re = /```(?:[a-zA-Z0-9_\-]*)?\r?\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    const block = m[1].replace(/\r\n/g, '\n').replace(/^\n+/, '').trimEnd();
    if (!block) continue;
    const name = guessAgentFilename(block);
    files.push({ name, content: block });
  }
  return files;
}
// Validate java sinh từ LLM: phải đúng Mindustry (không phải Bukkit/Minecraft/Spigot)
function agentJavaIsValid(content) {
  const c = String(content || '');
  if (/org\.bukkit|net\.md_5\.|org\.spigotmc|org\.papermc|net\.luckperms|org\.gradle\.api/i.test(c)) return false;
  return /extends\s+Plugin\b/.test(c) && /\bmindustry\b/.test(c);
}
function guessAgentFilename(block) {
  const head = block.trim();
  const named = head.match(/^\s*\/\/\s*([\w./\\@~-]+\.(?:java|gradle|json))\s*(?:\r?\n|$)/i);
  if (named) return named[1];
  if (/^\s*plugins\s*\{/.test(head) || /^\s*repositories\s*\{/.test(head) || /^\s*dependencies\s*\{/.test(head)) return 'build.gradle';
  if (/["']?(name|main|displayName|author)["']?\s*:/.test(head) && head.startsWith('{')) return 'mod.json';
  const pkg = head.match(/package\s+([\w.]+)\s*;/);
  if (pkg) {
    const cls = head.match(/public\s+(?:final\s+)?class\s+(\w+)/) || head.match(/\bclass\s+(\w+)/);
    const name = cls ? cls[1] : 'Plugin';
    return `src/${pkg[1].replace(/\./g, '/')}/${name}.java`;
  }
  return null;
}

// Parse JSON thuần từ output LLM (bỏ markdown fence / text thừa)
function parseAgentJson(reply) {
  let s = String(reply || '').trim();
  const fence = s.match(/```(?:json|java)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const st = s.indexOf('{');
  const en = s.lastIndexOf('}');
  if (st >= 0 && en > st) s = s.slice(st, en + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}
function cleanCodeContent(c) {
  return String(c || '').replace(/^\s*```[^\n]*\r?\n?/, '').replace(/```\s*$/, '').trim();
}
// Tạo AgentJob từ files + trả về reply chuẩn cho chat
async function createAgentJob(sid, pluginName, files, prompt) {
  const javaFile = files.find(f => f.name && f.name.endsWith('.java')) || files[0];
  const name = (javaFile?.name.match(/([^/\\]+)\.java$/) || [])[1] || pluginName || 'Plugin';
  const idea = classifyIdea(prompt);
  const req = {
    pluginName: name,
    files,
    prompt: String(prompt || ''),
    genMode: files.length ? 'auto' : (idea.simple ? 'auto' : 'manual'),
    complexity: idea,
  };
  const job = await AgentJob.create({ status: 'queued', sessionId: sid, request: req });
  console.log(`[AgentJob] Created ${job._id} plugin='${name}' (${files.length} files) mode=${req.genMode} sess=${String(sid).slice(0,12)}`);
  return job;
}

// ── ĐỊNH TUYẾN LLM: ý tưởng đơn giản → executor tự viết (Cloudflare/Meta)
//    ý tưởng phức tạp (app/web/db/hệ thống) → job ở chế độ 'manual': chủ hệ thống
//    code trực tiếp rồi gửi source compile (không bắt LLM nhỏ viết bừa).
const COMPLEX_IDEA_RULES = [
  { re: /\b(app|application|ứng dụng|web app|website|trang web|fullstack|backend|frontend|crm|erp|cms|e-commerce|shop online|đặt hàng|đặt xe|chatbot|thanh toán|vnpay|payos)\b/i, label: 'phạm vi phần mềm' },
  { re: /\b(database|cơ sở dữ liệu|mongodb|mysql|postgres|sqlite)\b/i, label: 'database' },
  { re: /\b(server|api|rest|websocket|socket|auth|đăng nhập|login|jwt|admin|báo cáo|dashboard|multithread|thread|microservice)\b/i, label: 'hạ tầng hệ thống' },
  { re: /\b(multi.?file|nhiều file|vài file|modul|module|thư viện|library|framework)\b/i, label: 'nhiều thành phần' },
];
function classifyIdea(prompt) {
  const p = String(prompt || '').trim();
  const words = p.split(/\s+/).filter(Boolean).length;
  const reasons = [];
  const isGameScope = /(plugin|mod|mindustry|\.jar|jar game|game)/i.test(p);
  for (const rule of COMPLEX_IDEA_RULES) {
    // Chỉ trừ là phức tạp khi KHÔNG thuộc phạm vi plugin game đơn lẻ
    if (!isGameScope && rule.re.test(p) && !reasons.includes(rule.label)) reasons.push(rule.label);
  }
  if (words > 60 && !reasons.includes('mô tả quá dài')) reasons.push('mô tả quá dài');
  if (/\.git|github|repository|repo\b/.test(p) && !reasons.includes('import nguồn ngoài')) reasons.push('import nguồn ngoài');
  return {
    simple: reasons.length === 0,
    reasons,
    words,
    routedTo: reasons.length === 0 ? 'cloudflare-meta-executor' : 'manual-owner',
  };
}

// Dựng spec đầy đủ cho job mode 'manual' — để chủ hệ thống (hoặc CRABOR bên ngoài) code đúng yêu cầu
function buildManualSpec(job) {
  const r = job.request || {};
  const idea = r.complexity || classifyIdea(r.prompt);
  return {
    jobId: String(job._id),
    sessionId: job.sessionId,
    pluginName: r.pluginName || 'Plugin',
    status: job.status,
    complexity: idea.reasons.join(', ') || 'đơn giản',
    routedTo: idea.routedTo,
    idea: r.prompt || '',
    filesProvided: (r.files || []).length,
    createdAt: job.createdAt,
    note: 'Chế độ manual: LLM nhỏ không sinh code cho ý tưởng phức tạp. Chủ hệ thống viết source Java rồi dán lại vào CRABOR Agent kèm "compile" để đóng gói .jar.',
  };
}

function jobQueuedReply(job) {
  const r = job.request || {};
  if (r.genMode === 'manual') {
    return `🧠 **Ý tưởng phức tạp** — CRABOR định tuyến tay để đảm bảo chất lượng.\n\nYêu cầu: _${String(r.prompt || '').slice(0, 300)}_\n\n⚠️ LLM tự động chỉ đảm nhận ý tưởng **đơn giản** (plugin game đơn lẻ — Cloudflare/Meta). Việc này gồm ` + (r.complexity?.reasons || []).map(x => `• ${x}`).join(', ') + `.\n\n🔧 Cách hoàn tất:\n1️⃣ Gửi **source Java** trực tiếp kèm từ khóa **"compile"** → máy chủ đóng gói .jar ngay.\n2️⃣ Hoặc nhờ **CRABOR Agent code thay** (xử lý thủ công bởi đội phát triển).\n\n${AGENT_DISCLAIMER}`;
  }
  return `🎯 CRABOR đã nhận và đang biên dịch **${r.pluginName || 'plugin'}** thành file .jar trên máy chủ CRABOR.\n\n⏳ Quá trình mất ~20–60 giây. Cứ nhắn tiếp: **"kiểm tra trạng thái compile"** để xem kết quả và tải file.\n\n${AGENT_DISCLAIMER}`;
}

// System prompt cho executor (laptop) khi cần TỰ VIẾT code plugin từ ý tưởng
// (được gửi qua proxy LLM cục bộ — not dùng trên Render vì cần model mạnh không bị chặn game code)
const AGENT_EXECUTOR_GEN_PROMPT = `Bạn là lập trình viên Java viết plugin cho trò chơi Mindustry (API mindustry.mod.Plugin, Java 17).
Người dùng mô tả Ý TƯỞNG plugin. Nhiệm vụ: xuất ĐÚNG MỘT khối code duy nhất — file JAVA. KHÔNG viết build.gradle, KHÔNG viết file khác, KHÔNG có lời dẫn, KHÔNG giải thích.
Khuôn bắt buộc (chỉ đổi tên ở ███ và thay LOGIC trong init() theo ý tưởng). Dòng đầu của khối là chú thích // tên file.

// src/███/███.java
package ███;
import arc.Events;
import mindustry.game.EventType;
import mindustry.gen.Call;
import mindustry.gen.Player;
import mindustry.mod.Plugin;

public class ███ extends Plugin {
  @Override
  public void init() {
    // ███ logic đầy đủ theo ý tưởng, đúng cú pháp Java
  }
}

Chỉ dùng API có sẵn trong Mindustry core: arc.Events, mindustry.game.EventType, mindustry.gen.Call, mindustry.gen.Player, mindustry.core.GameState, mindustry.content.Blocks. Logic để trong init(). Sự kiện: Events.on(EventType.X.class, event -> { ... }); Chat: Call.sendMessage("..."); Code phải NGẮN GỌN, ĐẦY ĐỦ, đúng cú pháp.
CHÚ Ý: ĐÂY LÀ GAME MINDUSTRY (2D tower-defense), KHÔNG PHẢI Minecraft. TUYỆT ĐỐI KHÔNG dùng org.bukkit, JavaPlugin, onEnable, Spigot. Chỉ dùng mindustry.mod.Plugin với phương thức init().`;

// Lấy training list theo agent, build thành chuỗi nhúng vào system prompt
async function buildTrainingPrompt(agent = 'agent') {
  try {
    const items = await TrainingQA.find({ enabled: true, $or: [{ agent: 'all' }, { agent }] }).sort({ createdAt: -1 }).limit(40).lean();
    if (!items.length) return '';
    const lines = items.map(t => `- Hỏi: "${t.question}"\n  Trả lời: ${t.answer}`);
    return `\n\n─── DỮ LIỆU ĐƯỢC QUẢN TRỊ VIÊN ĐÀO TẠO (hãy nhớ và tuân thủ khi gặp câu tương tự) ───\n${lines.join('\n')}`;
  } catch(e) {
    console.error('[TrainingQA] build prompt error:', e.message);
    return '';
  }
}

// Admin APIs — Training Agent
app.get("/api/admin/training", adminAuth, async (req, res) => {
  try {
    const list = await TrainingQA.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: list });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
app.post("/api/admin/training", adminAuth, async (req, res) => {
  try {
    const { agent = 'agent', question, answer, category = 'general', enabled = true } = req.body || {};
    if (!question || !answer) return res.status(400).json({ success: false, message: 'Cần câu hỏi và câu trả lời' });
    const doc = await TrainingQA.create({ agent, question: String(question), answer: String(answer), category, enabled });
    res.json({ success: true, data: doc });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
app.patch("/api/admin/training/:id", adminAuth, async (req, res) => {
  try {
    const doc = await TrainingQA.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    res.json({ success: true, data: doc });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
app.delete("/api/admin/training/:id", adminAuth, async (req, res) => {
  try {
    await TrainingQA.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});





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

// Resolve FoodPartner theo session — hỗ trợ 1 tài khoản đăng ký nhiều module (giặt là + đồ ăn cùng phone)
// Ưu tiên tìm theo phone để luôn lấy đúng quán đồ ăn, không phụ thuộc session.partnerId (chỉ trỏ 1 module)
async function getSessionFoodPartner(req) {
  if (req.session?.userPhone) {
    const fp = await FoodPartner.findOne({ phone: normalizePhone(req.session.userPhone) }).catch(() => null);
    if (fp) return fp;
  }
  if (req.session?.partnerModule === 'food_partner' && req.session?.partnerId) {
    const fp = await FoodPartner.findById(req.session.partnerId).catch(() => null);
    if (fp) return fp;
  }
  return null;
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


  // ── AUTO-CANCEL ĐƠN SAU 30 PHÚT KHÔNG TÌM ĐƯỢC SHIPPER ─────────────
  // Chạy mỗi 5 phút: tìm đơn pending > 30 phút → auto cancel
  cron.schedule("*/5 * * * *", async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 phút trước
      // Orders bình thường
      const staleOrders = await Order.find({
        status: { $in: ["pending", "finding_driver"] },
        createdAt: { $lt: cutoff },
      }).lean();
      for (const o of staleOrders) {
        await Order.findByIdAndUpdate(o._id, {
          status: "cancelled",
          cancelReason: "Hệ thống tự động hủy: không tìm được shipper sau 30 phút",
          cancelledAt: new Date(),
        });
        // Thông báo khách
        if (o.userId) {
          const user = await User.findById(o.userId).select("pushToken");
          if (user?.pushToken) {
            await sendPushToUsers([user.pushToken],
              "❌ Đơn hàng bị huỷ tự động",
              `Đơn #${o.orderId?.slice(-6)} đã bị hủy do không tìm được shipper sau 30 phút. Xin lỗi vì sự bất tiện này.`,
              { type: "order_auto_cancelled", orderId: o.orderId, screen: "OrderDetail" }
            );
          }
          if (global._io) global._io.to(`user_${o.userId}`).emit("order_cancelled", {
            orderId: o.orderId,
            message: "Đơn hàng tự động hủy sau 30 phút không tìm được shipper",
          });
        }
        console.log("[AutoCancel] Cancelled order:", o.orderId);
      }
      // Ride orders
      const RideOrder = mongoose.models.RideOrder;
      if (RideOrder) {
        const staleRides = await RideOrder.find({
          status: { $in: ["pending", "finding_driver"] },
          createdAt: { $lt: cutoff },
        }).lean();
        for (const r of staleRides) {
          await RideOrder.findByIdAndUpdate(r._id, {
            status: "cancelled",
            cancelReason: "Tự động hủy: không tìm được tài xế sau 30 phút",
          });
          if (r.userId && global._io) global._io.to(`user_${r.userId}`).emit("ride_status_update", {
            orderId: r.orderId, status: "cancelled",
            message: "Chuyến xe tự động hủy sau 30 phút không tìm được tài xế",
          });
          console.log("[AutoCancel] Cancelled ride:", r.orderId);
        }
      }
      // Laundry orders
      const LaundryOrder = mongoose.models.LaundryOrder;
      if (LaundryOrder) {
        const staleLaundry = await LaundryOrder.find({
          status: "pending",
          createdAt: { $lt: cutoff },
        }).lean();
        for (const l of staleLaundry) {
          await LaundryOrder.findByIdAndUpdate(l._id, {
            status: "cancelled",
            cancelReason: "Tự động hủy: không xác nhận trong 30 phút",
          });
          console.log("[AutoCancel] Cancelled laundry:", l.orderId);
        }
      }
    } catch(e) { console.error("[Cron] AutoCancel error:", e.message); }
  });

  // ── CRON: Nhắc nhở shipper thanh toán phí tiền mặt mỗi 1 tiếng ──────
  cron.schedule("0 * * * *", async () => {
    try {
      const CRABOR_FEE_RATE = 0.15; // 15% phí CRABOR
      // Tìm các shipper có đơn tiền mặt chưa nộp phí
      const cutoffDay = new Date();
      cutoffDay.setHours(0, 0, 0, 0);
      // Tìm đơn tiền mặt đã giao trong ngày hôm nay chưa nộp phí
      const cashOrders = await Order.find({
        paymentMethod: "cash",
        status: "delivered",
        deliveredAt: { $gte: cutoffDay },
        shipperId: { $exists: true },
      }).lean();
      // Nhóm theo shipper
      const shipperFees = {};
      for (const o of cashOrders) {
        const sid = String(o.shipperId);
        if (!shipperFees[sid]) shipperFees[sid] = { shipperId: o.shipperId, total: 0, count: 0 };
        const fee = Math.round((o.finalTotal || o.total || 0) * CRABOR_FEE_RATE);
        shipperFees[sid].total += fee;
        shipperFees[sid].count++;
      }
      // Gửi push cho mỗi shipper
      for (const [sid, data] of Object.entries(shipperFees)) {
        if (data.total <= 0) continue;
        const shipper = await Shipper.findById(sid).select("pushToken fullName");
        if (!shipper?.pushToken || !Expo.isExpoPushToken(shipper.pushToken)) continue;
        await sendPushToUsers(
          [shipper.pushToken],
          "⚠️ Nhắc thanh toán phí CRABOR",
          `Bạn có ${data.count} đơn tiền mặt hôm nay, phí cần nộp: ${Math.round(data.total).toLocaleString("vi-VN")}đ. Thanh toán sớm để tránh bị khóa tài khoản!`,
          { type: "fee_reminder", screen: "Earnings" }
        );
        // Socket notify
        if (global._io) global._io.to(`shipper_${sid}`).emit("fee_reminder", {
          amount: data.total,
          count: data.count,
          message: `Phí CRABOR cần nộp hôm nay: ${Math.round(data.total).toLocaleString("vi-VN")}đ`,
        });
      }
      if (Object.keys(shipperFees).length > 0) {
        console.log(`[Cron] Fee reminder sent to ${Object.keys(shipperFees).length} shippers`);
      }
    } catch(e) { console.error("[Cron] Fee reminder error:", e.message); }
  }, { timezone: "Asia/Ho_Chi_Minh" });

  console.log("[Cron] 9 jobs registered ✓ (Asia/Ho_Chi_Minh)");
}



async function sendPushToUser(userId, title, body, data = {}) {
  const user = await User.findById(userId).select('pushToken');
  if (!user?.pushToken || !Expo.isExpoPushToken(user.pushToken)) return 0;
  return sendPushToUsers([user.pushToken], title, body, data);
}


// ══════════════════════════════════════════════════════════════
//  EMAIL OTP — Resend (ưu tiên) + SMTP fallback
//  Resend: https://resend.com — HTTP API, không bị Render chặn
//  ENV: RESEND_API_KEY=re_xxx , EMAIL_FROM=CRABOR <otp@crabor.vn> hoặc onboarding@resend.dev
// ══════════════════════════════════════════════════════════════
async function sendViaResend(email, subject, html, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || "CRABOR <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject, html, text }),
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.message || `Resend ${res.status}`);
  return data;
}

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
    console.log(` [DEV-EMAIL-OTP] ${email}: ${code} (no transporter)`);
    // Vẫn trả success để dev/test không bị chặn
    if (process.env.NODE_ENV !== 'production') return { success: true, dev: true, code };
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

  // Ưu tiên Resend (HTTP) — không bị Render/Gmail chặn
  if (process.env.RESEND_API_KEY) {
    try {
      await sendViaResend(email, "[CRABOR] Mã OTP: " + code, html, "Ma OTP CRABOR: " + code + ". Het han sau 5 phut.");
      console.log(" [EMAIL-OTP] Sent via Resend to " + email);
      return { success: true };
    } catch (e) {
      console.error(" [EMAIL-OTP] Resend failed:", e.message, "— fallback SMTP, code:", code);
      // rơi xuống SMTP fallback
    }
  }

  try {
    await transporter.sendMail({
      from: '"CRABOR 🦀" <' + process.env.EMAIL_USER + '>',
      to: email,
      subject: "[CRABOR] Mã OTP: " + code,
      html,
      text: "Ma OTP CRABOR: " + code + ". Het han sau 5 phut.",
    });
    console.log(" [EMAIL-OTP] Sent via SMTP to " + email);
  } catch (e) {
    console.error(" [EMAIL-OTP] SMTP send failed:", e.message, "— fallback code:", code);
    console.log(` [DEV-EMAIL-OTP] ${email}: ${code}`);
    if (process.env.DEBUG_OTP === 'true') return { success: true, dev: true, code, warning: e.message };
    throw new Error("Không gửi được email (" + e.message + "). Đã thử Resend+SMTP, vui lòng cấu hình RESEND_API_KEY.");
  }
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


// ══════════════════════════════════════

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

// GET /api/shipper/fee — lấy thông tin phí đăng ký cho shipper app (session-based)
app.get("/api/shipper/fee", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const shipper = await Shipper.findById(req.session.shipperId).select("registerId phone plan fee feeStatus");
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ Shipper" });
    res.json({ success: true, data: {
      registerId: shipper.registerId,
      phone: shipper.phone,
      plan: shipper.plan,
      fee: shipper.fee,
      feeStatus: shipper.feeStatus,
    }});
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/shipper/fee/confirm — xác nhận đã thanh toán phí đăng ký từ shipper app (session-based)
app.post("/api/shipper/fee/confirm", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const { paid } = req.body;
    const shipper = await Shipper.findOneAndUpdate(
      { _id: req.session.shipperId },
      { feeStatus: paid ? "paid" : "unpaid" },
      { new: true }
    ).select("registerId phone plan feeStatus");
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ Shipper" });

    req.io.to("admin").emit("paymentConfirmed", {
      registerId: shipper.registerId,
      phone: shipper.phone,
      plan: shipper.plan,
      paid,
      via: "shipper_app",
    });

    res.json({ success: true, data: { registerId: shipper.registerId, paid } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/shipper/fee/payos/create — tạo link PayOS thanh toán phí đăng ký
// Hỗ trợ thẻ quốc tế Visa/Master ngay trên trang checkout PayOS
app.post("/api/shipper/fee/payos/create", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    if (!payOS) return res.status(500).json({ success: false, message: "PayOS chưa sẵn sàng" });
    const shipper = await Shipper.findById(req.session.shipperId).select("registerId fee");
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ Shipper" });
    const amount = Math.round(Number(shipper.fee) || 0);
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Phí đăng ký không hợp lệ" });

    const orderCode = parseInt(Date.now().toString().slice(-9));
    const desc = (`Phí CRABOR ${String(shipper.registerId || "").slice(-8)}`).trim().slice(0, 25);
    const paymentData = {
      orderCode,
      amount,
      description: desc,
      returnUrl: process.env.PAYOS_RETURN_URL || "https://crabor-shipper-register.onrender.com/payment-success",
      cancelUrl: process.env.PAYOS_CANCEL_URL || "https://crabor-shipper-register.onrender.com/payment-cancel",
    };
    let link;
    if (typeof payOS.paymentRequests?.create === 'function') link = await payOS.paymentRequests.create(paymentData);
    else link = await payOS.createPaymentLink(paymentData);
    res.json({ success: true, checkoutUrl: link.checkoutUrl, orderCode, amount, description: desc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/shipper/fee/payos/confirm — kiểm tra trạng thái link & ghi nhận đã trả
app.post("/api/shipper/fee/payos/confirm", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const { orderCode } = req.body;
    if (!orderCode || !payOS) return res.status(400).json({ success: false, message: "Thiếu orderCode hoặc PayOS chưa sẵn sàng" });
    let info = null;
    if (typeof payOS.paymentRequests?.get === 'function') info = await payOS.paymentRequests.get(String(orderCode));
    const paid = info?.status === "PAID";
    if (paid) {
      await Shipper.findByIdAndUpdate(req.session.shipperId, {
        feeStatus: "paid",
        paidAt: new Date(),
        feePaid: Math.round(Number(info.amountPaid ?? info.amount ?? 0)) || undefined,
      });
      req.io.to("admin").emit("shipperFeePaid", { shipperId: req.session.shipperId, via: "payos_card" });
    }
    res.json({ success: true, paid });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/config/earlybird — lấy cấu hình early bird
app.get("/api/admin/config/earlybird", adminAuth, async (req, res) => {
  try {
    const ebMax   = await getConfig("earlyBirdMax", 50);
    const ebPrice = await getConfig("earlyBirdPrice", 500000);
    const ebUsed = await Shipper.countDocuments({ plan: "early_bird" });
    res.json({ success: true, data: { ebMax, ebPrice, ebUsed, slotsLeft: Math.max(0, ebMax - ebUsed) } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/config/earlybird — cập nhật số suất + giá early bird
app.patch("/api/admin/config/earlybird", adminAuth, async (req, res) => {
  try {
    const { ebMax, ebPrice } = req.body;
    if (ebMax !== undefined) {
      if (typeof ebMax !== "number" || ebMax < 0) return res.status(400).json({ success: false, message: "Số suất không hợp lệ" });
      await setConfig("earlyBirdMax", ebMax);
    }
    if (ebPrice !== undefined) {
      if (typeof ebPrice !== "number" || ebPrice < 0) return res.status(400).json({ success: false, message: "Giá không hợp lệ" });
      await setConfig("earlyBirdPrice", ebPrice);
    }
    const curMax = await getConfig("earlyBirdMax", 50);
    const curPrice = await getConfig("earlyBirdPrice", 500000);
    res.json({ success: true, data: { ebMax: curMax, ebPrice: curPrice } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── STORAGE STATS: dung lượng MongoDB + Cloudinary ──────────────
app.get("/api/admin/storage-stats", adminAuth, async (req, res) => {
  try {
    // ── MongoDB ──
    const db = { configured: true };
    try {
      const dbo = mongoose.connection.db;
      const stats = await dbo.command({ dbstats: 1 });
      db.dataSize    = stats.dataSize    || 0;   // dung lượng dữ liệu (bytes)
      db.storageSize = stats.storageSize || 0;   // dung lượng lưu trữ thực tế
      db.indexSize   = stats.indexSize   || 0;
      db.collections = stats.collections || 0;
      db.objects     = stats.objects     || 0;
    } catch(e) { db.configured = false; db.error = e.message; }

    // Đếm document các collection chính
    const counts = {};
    const countOf = async (name) => {
      try { return await mongoose.connection.db.collection(name).countDocuments(); }
      catch(e) { return null; }
    };
    for (const name of ["orders","users","shippers","products","food_partners",
      "giatla_partners","giupviec_partners","chinashops","laundryorders","cleaningorders",
      "aibanners","wallettxes","bnpltxes","bnplinvoices","loans","socialcomments"]) {
      counts[name] = await countOf(name);
    }

    // Danh sách collection + số object từng cái
    let collections = [];
    try {
      const collInfos = await mongoose.connection.db.listCollections().toArray();
      collections = await Promise.all(collInfos.map(async (c) => ({
        name: c.name,
        count: await countOf(c.name),
      })));
      collections.sort((a,b) => (b.count||0) - (a.count||0));
    } catch(e) {}

    // ── Cloudinary usage API ──
    let cloudinary = { configured: false };
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey    = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (cloudName && apiKey && apiSecret) {
      cloudinary.configured = true;
      try {
        const auth = Buffer.from(apiKey + ":" + apiSecret).toString("base64");
        const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/usage`, {
          headers: { Authorization: "Basic " + auth },
        });
        const d = await r.json();
        if (d && !d.error) {
          cloudinary.plan       = d.plan;
          cloudinary.lastUpdated= d.last_updated;
          cloudinary.resources  = d.resources;   // { count, usage, limit }
          cloudinary.bandwidth  = d.bandwidth;   // { count/usage, limit }
          cloudinary.storage    = d.storage;     // { usage, limit }
          cloudinary.credits    = d.credits;     // { usage, limit }
          cloudinary.objects    = d.objects;
        } else {
          cloudinary.error = d?.error?.message || "Cloudinary trả lời lỗi";
        }
      } catch(e) { cloudinary.error = e.message; }
    }

    res.json({ success: true, db, counts, collections, cloudinary });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── MẠNG XÃ HỘI CRABOR: banner AI → bài viết của CRABOR Official + comment với Coco AI ──
const socialCommentSchema = new mongoose.Schema({
  postId:     { type: mongoose.Schema.Types.ObjectId, ref: "AIBanner", required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  authorName: { type: String, default: "Khách hàng CRABOR" },
  text:       { type: String, required: true, maxlength: 1000 },
  isAI:       { type: Boolean, default: false },
}, { timestamps: true });
const SocialComment = mongoose.models.SocialComment || mongoose.model("SocialComment", socialCommentSchema);

// GET /api/social/posts — feed bài viết từ banner AI đang chạy
// ?app=customer|partner|shipper → chỉ lấy banner nhắm đúng đối tượng đó (tránh loãng bài)
app.get("/api/social/posts", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const uid = req.session?.userId || req.session?.partnerId || req.session?.shipperId || null;
    const appFilter = ["customer","partner","shipper"].includes(String(req.query.app)) ? String(req.query.app) : null;
    const q = { active: true };
    if (appFilter) q.apps = appFilter;
    const banners = await AIBanner.find(q).sort({ createdAt: -1 }).limit(30).lean();
    const ids = banners.map(b => b._id);
    let cmap = {};
    if (ids.length) {
      const agg = await SocialComment.aggregate([
        { $match: { postId: { $in: ids } } },
        { $group: { _id: "$postId", count: { $sum: 1 } } },
      ]);
      cmap = Object.fromEntries(agg.map(c => [String(c._id), c.count]));
    }
    const uidStr = uid ? String(uid) : null;
    const posts = banners.map(b => ({
      _id: b._id,
      imageUrl: b.imageUrl,
      title: b.title,
      content: b.content || b.subtitle || "",
      badge: b.badge,
      emoji: b.emoji,
      gradient: b.gradient,
      ctaLink: b.ctaLink,
      author: { name: "CRABOR Official", verified: true },
      createdAt: b.createdAt,
      commentCount: cmap[String(b._id)] || 0,
      likes: b.likes || 0,
      liked: uidStr ? (b.likedBy || []).map(String).includes(uidStr) : false,
    }));
    res.json({ success: true, posts });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/social/posts/:id/like — tym / bỏ tym (1 tài khoản 1 tym — mọi vai trò)
app.post("/api/social/posts/:id/like", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const uid = req.session?.userId || req.session?.partnerId || req.session?.shipperId || null;
    if (!uid) return res.status(401).json({ success: false, needLogin: true, message: "Đăng nhập để thả tym" });
    const banner = await AIBanner.findById(req.params.id).select("likes likedBy");
    if (!banner) return res.status(404).json({ success: false, message: "Bài viết không tồn tại" });
    const already = (banner.likedBy || []).map(String).includes(String(uid));
    if (already) {
      await AIBanner.findByIdAndUpdate(banner._id, { $pull: { likedBy: uid }, $inc: { likes: -1 } });
    } else {
      await AIBanner.findByIdAndUpdate(banner._id, { $addToSet: { likedBy: uid }, $inc: { likes: 1 } });
    }
    const updated = await AIBanner.findById(banner._id).select("likes likedBy").lean();
    res.json({
      success: true,
      liked: !already,
      likes: Math.max(0, updated.likes || 0),
      message: already ? "Đã bỏ tym" : "❤️ Đã thả tym",
    });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN: BOT TƯƠNG TÁC — ngẫu nhiên số tym cho bài viết ──────────────
// GET /api/admin/social/bot — trạng thái bot
app.get("/api/admin/social/bot", adminAuth, async (req, res) => {
  try {
    const enabled = await getConfig("socialBotEnabled", true);
    const min     = await getConfig("socialBotMinLikes", 50);
    const max     = await getConfig("socialBotMaxLikes", 500);
    const [posts, totalAgg] = await Promise.all([
      AIBanner.countDocuments({ active: true }),
      AIBanner.aggregate([{ $match: { active: true } }, { $group: { _id: null, total: { $sum: "$likes" } } }]),
    ]);
    res.json({ success: true, data: { enabled, min, max, posts, totalLikes: totalAgg[0]?.total || 0 } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/admin/social/bot — lưu cấu hình + random lại mục tiêu tym cho các bài
app.patch("/api/admin/social/bot", adminAuth, async (req, res) => {
  try {
    const { enabled, min, max } = req.body;
    if (enabled !== undefined) await setConfig("socialBotEnabled", !!enabled);
    const curMin = min  !== undefined ? Number(min)  : await getConfig("socialBotMinLikes", 50);
    const curMax = max  !== undefined ? Number(max)  : await getConfig("socialBotMaxLikes", 500);
    if (isNaN(curMin) || isNaN(curMax) || curMin < 0 || curMax < curMin)
      return res.status(400).json({ success: false, message: "Khoảng tym không hợp lệ (cần 0 ≤ min ≤ max)" });
    await setConfig("socialBotMinLikes", curMin);
    await setConfig("socialBotMaxLikes", curMax);
    // Random mục tiêu mới cho từng bài đang chạy
    const actives = await AIBanner.find({ active: true }).select("_id");
    for (const b of actives) {
      const target = curMin + Math.floor(Math.random() * (curMax - curMin + 1));
      await AIBanner.findByIdAndUpdate(b._id, { botLikesTarget: target });
    }
    res.json({ success: true, data: { enabled: await getConfig("socialBotEnabled", true), min: curMin, max: curMax, randomized: actives.length } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// CRON bot tym: mỗi 3 phút tăng dần về mục tiêu ngẫu nhiên (tự nhiên như người thật)
setInterval(async () => {
  try {
    if (!(await getConfig("socialBotEnabled", true))) return;
    const min = await getConfig("socialBotMinLikes", 50);
    const max = await getConfig("socialBotMaxLikes", 500);
    const actives = await AIBanner.find({ active: true }).select("_id likes botLikesTarget");
    for (const b of actives) {
      let target = b.botLikesTarget;
      if (!target || target < min || target > max) {
        target = min + Math.floor(Math.random() * (max - min + 1));
        await AIBanner.findByIdAndUpdate(b._id, { botLikesTarget: target });
      }
      if ((b.likes || 0) >= target) continue;
      // Tăng nhỏ giọt: 1-5 tym mỗi lần quét, không vượt mục tiêu
      const step = 1 + Math.floor(Math.random() * 5);
      const newLikes = Math.min(target, (b.likes || 0) + step);
      await AIBanner.findByIdAndUpdate(b._id, { likes: newLikes });
    }
  } catch(e) { console.error("[SocialBot] lỗi:", e.message); }
}, 3 * 60 * 1000);

// ── BACKFILL 1 LẦN: voucher LPT cũ chưa có source → đánh dấu loyalty + gán chủ sở hữu từ LoyaltyLog ──
setTimeout(async () => {
  try {
    const oldLpt = await Voucher.find({ code: /^LPT/, source: { $ne: 'loyalty' } }).limit(500).lean();
    if (!oldLpt.length) return;
    let fixed = 0;
    for (const v of oldLpt) {
      const log = await LoyaltyLog.findOne({ voucherCode: v.code }).sort({ createdAt: -1 }).select("userId").lean();
      await Voucher.updateOne({ _id: v._id }, { $set: { source: 'loyalty', ownerId: log?.userId || null } });
      fixed++;
    }
    console.log(`[Backfill] Đã đánh dấu ${fixed} voucher loyalty cũ (LPT*)`);
  } catch(e) { console.error("[Backfill] Lỗi:", e.message); }
}, 30 * 1000);

// GET /api/social/posts/:id/comments — danh sách bình luận
app.get("/api/social/posts/:id/comments", async (req, res) => {
  try {
    const comments = await SocialComment.find({ postId: req.params.id }).sort({ createdAt: 1 }).limit(100).lean();
    res.json({ success: true, comments });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── BỘ LỌC TỪ NGỮ XÚC PHẠM cho bình luận mạng xã hội ──
// Chuẩn hoá: bỏ dấu tiếng Việt, teencode (0→o, 3→e...), chỉ giữ a-z + khoảng trắng
function _normalizeAbuseText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e")
    .replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t")
    .replace(/8/g, "ate").replace(/\$/g, "s").replace(/@/g, "a")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ").trim();
}
const _ABUSE_WORDS = new Set([
  // Việt Nam (teencode + viết thường không dấu sau chuẩn hoá)
  "dit", "ditme", "ditcu", "dime", "dmm", "dkm", "dkme", "dme", "dm",
  "cl", "clmm", "clgt", "vcl", "vl", "cc", "ccc", "cacthi", "catmo", "cuctmo", "cucatmo",
  "buoi", "lon", "loz", "lozz", "occho", "memay", "chamang", "ngu", "ngok", "dotdot",
  "xamlon", "sanmat", "daitruong",
  // Tiếng Anh
  "fuck", "fuk", "shit", "bitch", "asshole", "bastard", "dick", "pussy", "cunt", "motherfucker",
]);
const _ABUSE_PHRASES = [
  "dit me", "dit me may", "me may", "me m", "cha may", "cha mang",
  "con cho", "thang cho", "do cho", "suc vat", "do ngu", "ngu nhu",
  "cat mo", "cu cat mo", "quan cho", "app cho", "khanh cho",
];
function containsAbuse(text) {
  const norm = _normalizeAbuseText(text);
  if (!norm) return false;
  const tokens = norm.split(" ");
  for (const t of tokens) if (_ABUSE_WORDS.has(t)) return true;
  for (const p of _ABUSE_PHRASES) if (norm.includes(p)) return true;
  return false;
}

// POST /api/social/posts/:id/comment — bình luận + Coco AI đọc và trả lời (mọi vai trò)
app.post("/api/social/posts/:id/comment", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const uid = req.session?.userId || req.session?.partnerId || req.session?.shipperId || null;
    if (!uid) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ success: false, message: "Thiếu nội dung bình luận" });

    // ── LỌC TỪ NGỮ: phát hiện lăng mạ → xoá/từ chối ngay, không lưu, không AI trả lời ──
    if (containsAbuse(text)) {
      return res.status(400).json({
        success: false,
        deleted: true,
        message: "🚫 Bình luận chứa từ ngữ không phù hợp đã bị gỡ. Vui lòng bình luận văn minh bạn nhé!",
      });
    }

    const banner = await AIBanner.findById(req.params.id).select("title").lean();
    if (!banner) return res.status(404).json({ success: false, message: "Bài viết không tồn tại" });

    // Tác giả theo vai trò: customer / partner / shipper
    let authorName = "Khách hàng CRABOR";
    try {
      if (req.session.shipperId) {
        const sh = await Shipper.findById(req.session.shipperId).select("fullName").lean();
        authorName = sh?.fullName ? `${sh.fullName} 🛵` : "Shipper CRABOR";
      } else if (req.session.partnerId) {
        const models = [mongoose.models.FoodPartner, mongoose.models.GiatLaPartner, mongoose.models.GiupViecPartner, mongoose.models.ChinaShop].filter(Boolean);
        for (const m of models) {
          const p = await m.findById(req.session.partnerId).select("bizName fullName").lean();
          if (p) { authorName = `${p.bizName || p.fullName || "Đối tác"} 🏪`; break; }
        }
      } else if (req.session.userId) {
        const u = await User.findById(req.session.userId).select("fullName").lean();
        authorName = u?.fullName || "Khách hàng CRABOR";
      }
    } catch(_) {}

    const comment = await SocialComment.create({
      postId: req.params.id,
      userId: uid,
      authorName,
      text,
    });

    // Coco AI đọc bình luận và trả lời — Groq LLM (cocoThink), KHÔNG dùng rule form
    let aiText = "";
    try {
      // Ngữ cảnh thread: vài bình luận gần nhất để AI hiểu mạch hội thoại
      const recentCmts = await SocialComment.find({ postId: req.params.id })
        .sort({ createdAt: -1 }).limit(6).lean();
      const historyMsgs = recentCmts.reverse().map(c => ({
        role: c.isAI ? "assistant" : "user",
        content: `${c.authorName}${c.isAI ? "" : " (khách hàng)"}: ${c.text}`,
      }));

      const { cocoThink } = require("./coco-brain");
      const result = await cocoThink(
        [...historyMsgs, { role: "user", content: text }],
        {
          userContext: {},
          task: "chat",
          backend: "groq",
          temperature: 0.6,
          maxTokens: 250,
          systemPromptOverride:
            `Bạn là nhân viên hỗ trợ khách hàng của CRABOR, trả lời bình luận trên fanpage mạng xã hội chính thức với tài khoản "CRABOR Official". ` +
            `Bài viết đang đăng: "${banner.title}". ` +
            `TÍNH CÁCH: chuyên nghiệp, lịch sự, tận tâm như một nhân viên CSKH thật — xưng "CRABOR" hoặc "em", gọi khách là "anh/chị". ` +
            `Văn phong trang nhã, rõ ràng, đi thẳng vào vấn đề; tối đa 70 từ; chỉ dùng tối đa 1 emoji nhẹ nhàng. ` +
            `- Khách khen → cảm ơn anh/chị, mong tiếp tục đồng hành.` +
            `- Khách chê/góp ý → nhận trách nhiệm chân thành, xin lỗi, đề xuất cụ thể: gửi thông tin đơn qua mục Hỗ trợ trong app để em xử lý ngay trong 30 phút.` +
            `- Khách hỏi giá/khuyến mãi/cách đặt → hướng dẫn từng bước ngắn gọn trong app CRABOR.` +
            `- Tuyệt đối KHÔNG trả lời theo mẫu sáo rỗng, KHÔNG lặp lại nguyên câu hỏi, KHÔNG dùng kiểu chữ nhí nhảnh hay nhiều emoji.` +
            `- Mọi câu đều kết thúc tự nhiên, có thể mời khách nhắn tin trực tiếp để được hỗ trợ chi tiết hơn.`,
        }
      );
      if (result?.canReason && result?.text) aiText = result.text;
    } catch(e) { console.error("[Social] Coco AI (groq) lỗi:", e.message); }
    // Fallback 1: rule engine nếu LLM không khả dụng
    if (!aiText) {
      try {
        const { cocoRespondSmart } = require("./coco-engine");
        const r = await cocoRespondSmart({ text, sessionId: `social_${req.params.id}`, userId: uid, userCtx: {} });
        aiText = r?.text || "";
      } catch(_) {}
    }
    // Fallback cuối
    if (!aiText) {
      aiText = `Cảm ơn anh/chị đã quan tâm đến "${banner.title}". CRABOR luôn sẵn sàng hỗ trợ — anh/chị cần giúp gì thêm cứ nhắn tin cho em nhé!`;
    }
    const aiReply = await SocialComment.create({
      postId: req.params.id,
      authorName: "CRABOR Official",
      text: String(aiText).slice(0, 800),
      isAI: true,
    });
    res.json({ success: true, comment, aiReply });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  DOCUMENT UPLOAD — Upload ảnh hồ sơ lên Cloudinary
// ══════════════════════════════════════════════════════════════

// Hàm lấy model theo type
function getModelByType(type) {
  const map = {
    shipper:      Shipper,
    giat_la:      GiatLa,
    giup_viec:    GiupViec,
    china_shop:   ChinaShop,
    food_partner: FoodPartner,
    ride_driver:  RideDriver,
  };
  return map[type] || null;
}

// POST /api/upload-doc — Lưu ảnh hồ sơ (base64) trực tiếp vào MongoDB
// Body: { type, registerId, field, data (base64 data URL, đã nén ~1MB) }
app.post("/api/upload-doc", async (req, res) => {
  try {
    const { type, registerId, field, data } = req.body;
    if (!type || !registerId || !field || !data)
      return res.status(400).json({ success: false, message: "Thiếu thông tin" });

    const allowedFields = ['cccdFront','cccdBack','selfie','shopFront','shopInside','vehicleImg','productSample','importDoc','licenseImg','driverLicense','vehicleReg'];
    if (!allowedFields.includes(field))
      return res.status(400).json({ success: false, message: "Field không hợp lệ" });

    if (!data.startsWith('data:image') && !data.startsWith('data:application/pdf'))
      return res.status(400).json({ success: false, message: "Dữ liệu không hợp lệ" });

    // Giới hạn 1.5MB (ảnh đã nén client-side ~1MB, cho dư một chút)
    if (Buffer.byteLength(data, 'utf8') > 1.5 * 1024 * 1024)
      return res.status(413).json({ success: false, message: "Ảnh quá lớn (tối đa 1.5MB), vui lòng nén lại" });

    const uploaded = await uploadImageToCloudinary(data, "docs");

    // Lưu vào MongoDB (URL Cloudinary — hoặc base64 nếu chưa cấu hình)
    const Model = getModelByType(type);
    if (!Model) return res.status(400).json({ success: false, message: "Loại không hợp lệ" });

    const update = {};
    update["documents." + field] = uploaded;

    const doc = await Model.findOneAndUpdate({ registerId }, { $set: update }, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ" });

    res.json({ success: true, url: uploaded });
  } catch(err) {
    console.error("[upload-doc]", err.message);
    res.status(500).json({ success: false, message: "Upload thất bại: " + err.message });
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
  const Model = ownerType==='user' ? User : ownerType==='shipper' ? Shipper : FoodPartner;
  const doc = await Model.findByIdAndUpdate(ownerId, { $inc: { walletBalance: amount, walletEarned: amount } }, { new: true });
  await WalletTx.create({ ownerId, ownerType, type:'credit', amount, balance: doc.walletBalance, ref, note });
  return doc.walletBalance;
}
async function walletDebit(ownerId, ownerType, amount, type='debit', ref, note) {
  const Model = ownerType==='user' ? User : ownerType==='shipper' ? Shipper : FoodPartner;
  const doc = await Model.findById(ownerId);
  if (!doc || (doc.walletBalance||0) < amount) throw new Error('Số dư không đủ');
  const updated = await Model.findByIdAndUpdate(ownerId, { $inc: { walletBalance: -amount } }, { new: true });
  await WalletTx.create({ ownerId, ownerType, type, amount, balance: updated.walletBalance, ref, note });
  return updated.walletBalance;
}

// ── Helper: mô tả nguồn tiền cho giao dịch ví ─────────────────
function describeTx(tx) {
  if (!tx) return 'Giao dịch ví CRABOR';
  if (tx.note) return tx.note;
  if (tx.ref) {
    const ref = String(tx.ref);
    if (ref === 'mission') return 'Thưởng nhiệm vụ';
    if (ref === 'WITHDRAW_REJECT') return 'Hoàn lại tiền rút bị từ chối';
    return `Giao dịch đơn #${ref.slice(-6)}`;
  }
  if (tx.type === 'withdraw') return 'Rút tiền từ ví';
  if (tx.type === 'credit') return 'Nhận tiền vào ví';
  if (tx.type === 'refund') return 'Hoàn tiền';
  return 'Giao dịch ví CRABOR';
}
function withTxDescription(txs) {
  return (txs || []).map(tx => ({ ...(tx.toObject ? tx.toObject() : tx), description: describeTx(tx) }));
}


// ══════════════════════════════════════════════════════════════
//  TIER 1 FEATURES: Rating · Chat · Voucher · Delivery Photo
// ══════════════════════════════════════════════════════════════

// POST /api/orders/:id/rate — Khách đánh giá shipper + partner
app.post("/api/orders/:id/rate", async (req, res) => {
  try {
    // Khách app gửi { rating, note } — fallback từ { ratingShipper, ratingComment }
    const { ratingShipper, ratingPartner, ratingComment, userId, rating, note } = req.body;
    const finalRatingShipper = ratingShipper || rating || null;
    const finalRatingComment = ratingComment || note || "";
    const order = await Order.findOne({
      $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }]
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });
    if (order.ratedAt) return res.status(400).json({ success: false, message: "Đơn này đã được đánh giá" });
    if (order.status !== "delivered") return res.status(400).json({ success: false, message: "Chỉ đánh giá đơn đã giao" });

    await Order.findByIdAndUpdate(order._id, {
      ratingShipper: finalRatingShipper,
      ratingPartner: ratingPartner || null,
      ratingComment: finalRatingComment,
      ratedAt: new Date(),
    });

    // Update shipper avg rating
    if (finalRatingShipper && order.shipperId) {
      const shipper = await Shipper.findById(order.shipperId);
      if (shipper) {
        const newCount = (shipper.ratingCount || 0) + 1;
        const newRating = (((shipper.rating || 0) * (shipper.ratingCount || 0)) + finalRatingShipper) / newCount;
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
    await loadSessionFromHeader(req, res);
    if (!req.session.userId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    
    // FIX: Sửa "userId" thành "customerId" (đúng với schema)
    const orders = await Order.find({ customerId: req.session.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    
    // Thêm tên nhà hàng + enrich discount fields cho mỗi đơn
    const enrichedOrders = await Promise.all(orders.map(async (order) => {
      if (order.partnerId) {
        const partner = await FoodPartner.findById(order.partnerId).select('bizName');
        if (partner) {
          order.partnerName = partner.bizName;
        }
      }
      // FIX: Đảm bảo discount/finalTotal luôn có giá trị để customer app hiển thị nhất quán
      order.discount      = order.discount || 0;
      order.voucherCode   = order.voucherCode || null;
      order.voucherDiscount = order.voucherDiscount || 0;
      order.finalTotal    = order.finalTotal ?? Math.max(0, (order.total||0) + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0));
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
    const photoUp = await uploadImageToCloudinary(photo, "orders");
    const order = await Order.findOneAndUpdate(
      { orderId: req.params.id },
      { deliveryPhoto: photoUp, status: "delivered", deliveredAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false });
    // Broadcast
    req.io.to(`order_${order.orderId}`).emit("orderStatusChanged", { orderId: order.orderId, status: "delivered", photo: photoUp });
    req.io.to(`customer_${order.customerId}`).emit("orderStatusChanged", { orderId: order.orderId, status: "delivered", photo: photoUp });
    req.io.to("admin").emit("orderUpdated", { orderId: order.orderId, status: "delivered" });
    notifyDiscord("delivered", order);
    // Tích điểm loyalty (1/10 giá trị đơn) nếu chưa được cộng
    if (order.customerId && !order.loyaltyPointsGranted) {
      order.loyaltyPointsGranted = true;
      await order.save().catch(()=>{});
      await earnLoyaltyPoints(order.customerId, orderPaidAmount(order));
    }
    res.json({ success: true, message: "Đã xác nhận giao thành công!" });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/vouchers/validate — Validate mã voucher (hỗ trợ target ship: giảm phí giao)
app.get("/api/vouchers/validate", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const { code, total, shipFee, userId, module: mod } = req.query;
    if (!code) return res.status(400).json({ success: false });
    const v = await Voucher.findOne({ code: code.toUpperCase().trim(), active: true });
    if (!v) return res.status(404).json({ success: false, message: "Mã không tồn tại hoặc đã hết hạn" });
    if (new Date() > v.expiresAt) return res.status(400).json({ success: false, message: "Mã đã hết hạn" });
    if (v.usedCount >= v.usageLimit) return res.status(400).json({ success: false, message: "Mã đã dùng hết lượt" });
    // Voucher đổi bằng điểm: chỉ chủ sở hữu hợp lệ
    if (v.source === 'loyalty') {
      const uid = req.session?.userId || (userId ? String(userId) : null);
      if (!uid || !v.ownerId || String(v.ownerId) !== String(uid)) {
        return res.status(400).json({ success: false, message: "Mã này đổi bằng điểm tích luỹ — chỉ chủ sở hữu mới dùng được" });
      }
    }
    if (userId && v.usedBy.map(String).includes(String(userId))) return res.status(400).json({ success: false, message: "Bạn đã dùng mã này rồi" });

    // target 'ship': giảm theo phí giao; target 'order': giảm theo giá trị đơn
    const base = v.target === "ship" ? (Number(shipFee) || Number(total) || 0) : (Number(total) || 0);
    // FIX: minOrder so với GIÁ TRỊ ĐƠN HÀNG (đồng bộ với applyVoucher)
    if ((Number(total) || 0) < v.minOrder) return res.status(400).json({ success: false, message: `Đơn tối thiểu ${v.minOrder.toLocaleString()}đ` });
    if (v.module !== "all" && v.module !== mod) return res.status(400).json({ success: false, message: "Mã không áp dụng cho đơn này" });
    const discount = base > 0 && v.type === "percent"
      ? Math.min(Math.round(base * v.value / 100), v.maxDiscount || Infinity)
      : (base > 0 ? Math.min(v.value, base) : 0);
    res.json({
      success: true, discount, target: v.target,
      base: Math.round(base),
      description: v.description || `Giảm ${v.type==='percent'?v.value+'%':v.value.toLocaleString()+'đ'}`,
      label: v.target === "ship" ? "phí giao hàng" : "giá trị đơn",
    });
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
      target:      v.target || "order",
    });
    res.json({ success: true, data: v });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Weekly Voucher (voucher tuần — tự tạo đầu mỗi tuần, giảm phí giao) ──
const WEEKLY_VOUCHER_CFG = {
  type: "percent", value: 50, maxDiscount: 25000, minOrder: 50000,
  target: "ship", module: "all", days: 7,
  description: "Voucher tuần: Giảm 50% phí giao hàng (tối đa 25.000đ) — áp dụng mọi dịch vụ",
};

function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}W${String(week).padStart(2, "0")}`;
}

async function generateWeeklyVoucher() {
  try {
    const key = isoWeekKey(new Date());
    const existing = await Voucher.findOne({ weekly: { $exists: true, $ne: "" } }).lean().catch(() => null);
    if (existing && existing.weekly === key) return existing;
    const code = "WEEKLY-" + key.replace("W", "");
    const v = await Voucher.create({
      code,
      type: WEEKLY_VOUCHER_CFG.type,
      value: WEEKLY_VOUCHER_CFG.value,
      minOrder: WEEKLY_VOUCHER_CFG.minOrder,
      maxDiscount: WEEKLY_VOUCHER_CFG.maxDiscount,
      usageLimit: 100000,
      expiresAt: new Date(Date.now() + WEEKLY_VOUCHER_CFG.days * 24 * 3600 * 1000),
      description: WEEKLY_VOUCHER_CFG.description,
      module: WEEKLY_VOUCHER_CFG.module,
      target: WEEKLY_VOUCHER_CFG.target,
      weekly: key,
      active: true,
    });
    console.log(`[WeeklyVoucher] Đã tạo voucher tuần mới: ${code} (${key})`);
    return v;
  } catch (e) {
    console.error("[WeeklyVoucher] Tạo voucher thất bại:", e.message);
    return null;
  }
}

// Check & tạo voucher tuần mới: lúc khởi động + mỗi 3 giờ
setTimeout(generateWeeklyVoucher, 15000);
setInterval(generateWeeklyVoucher, 3 * 3600 * 1000);

// GET /api/admin/weekly-voucher — Thông tin voucher tuần cho trang quản trị
app.get("/api/admin/weekly-voucher", adminAuth, async (req, res) => {
  try {
    const v = await generateWeeklyVoucher();
    if (!v) return res.status(500).json({ success: false, message: "Không tạo được voucher tuần" });
    const [usedCount, turnover] = await Promise.all([
      Order.countDocuments({ voucherCode: v.code, status: { $nin: ["cancelled", "expired"] } }),
      Order.aggregate([
        { $match: { voucherCode: v.code, status: "delivered" } },
        { $group: { _id: null, t: { $sum: { $ifNull: ["$finalTotal", 0] } } } },
      ]),
    ]);
    res.json({
      success: true,
      voucher: v,
      stats: {
        week: v.weekly,
        usedCount,
        turnover: turnover[0]?.t || 0,
      },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/vouchers/public — Public list vouchers cho customer app
app.get("/api/vouchers/public", async (req, res) => {
  try {
    const now = new Date();
    // Chỉ voucher công khai — voucher đổi bằng điểm (loyalty) không hiện ở đây
    const vs = await Voucher.find({
      active: true,
      expiresAt: { $gt: now },
      source: { $ne: 'loyalty' },
    }).sort({ createdAt: -1 }).limit(50).select("-__v");
    res.json({ success: true, vouchers: vs });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/vouchers/my — Voucher công khai + voucher loyalty CỦA CHÍNH user này
app.get("/api/vouchers/my", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const now = new Date();
    const uid = req.session?.userId || null;
    const vs = await Voucher.find({
      active: true,
      expiresAt: { $gt: now },
      $or: [
        { source: { $ne: 'loyalty' } },
        ...(uid ? [{ source: 'loyalty', ownerId: uid }] : []),
      ],
    }).sort({ createdAt: -1 }).limit(50).select("-__v");
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
    const orig = await Order.findOne({
      $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }]
    });
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

// ── Helper: lấy shipper hiện tại từ session (shipper hoặc user đăng nhập) ──
async function currentShipperFromSession(req, res) {
  try { await loadSessionFromHeader(req, res); } catch (_) {}
  if (req.session?.shipperId) return Shipper.findById(req.session.shipperId);
  if (req.session?.userId) {
    const user = await User.findById(req.session.userId).select("phone");
    if (user) return Shipper.findOne({ phone: user.phone });
  }
  return null;
}

// ── Helper: nhiệm vụ ngày (real-time từ dữ liệu thực tế) ──────
async function buildDailyMissions(shipper) {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const tk = dayKey();
  const [todayOrders, ratedToday] = await Promise.all([
    Order.countDocuments({ shipperId: shipper._id, status: "delivered", deliveredAt: { $gte: todayStart } }),
    Order.find({ shipperId: shipper._id, status: "delivered", deliveredAt: { $gte: todayStart }, ratingShipper: { $gte: 1 } }).select("ratingShipper").lean(),
  ]);
  const onlineHours = Math.round(((shipper.onlineSecondsToday || 0) / 3600) * 10) / 10;
  const avgRatingToday = ratedToday.length > 0 ? Math.round((ratedToday.reduce((s,o)=>s+o.ratingShipper,0)/ratedToday.length) * 10) / 10 : 0;
  const claimed = new Set((shipper.missionClaims||[]).filter(c=>c.day===tk).map(c=>c.id));

  const defs = [
    { id:'m1', title:'Giao 3 đơn hôm nay',  target:3, reward:5000,  icon:'🛵', desc:'Hoàn thành giao 3 đơn trong ngày', get: () => todayOrders },
    { id:'m2', title:'Giao 8 đơn hôm nay',  target:8, reward:15000, icon:'⚡', desc:'Hoàn thành giao 8 đơn trong ngày', get: () => todayOrders },
    { id:'m3', title:'Online 3 tiếng hôm nay', target:3, reward:8000, icon:'🕐', desc:'Bật nhận đơn tổng 3 tiếng trong ngày', get: () => onlineHours },
    { id:'m4', title:'Giữ sao 4.8 trong ngày', target:1, reward:10000, icon:'⭐', desc:'Đạt 4.8⭐ cho các đơn hôm nay', get: () => (avgRatingToday >= 4.8 ? 1 : 0) },
  ];

  const missions = defs.map(d => {
    const raw = d.get();
    const current = Math.min(raw, d.target);
    const completed = raw >= d.target;
    return { id:d.id, title:d.title, target:d.target, reward:d.reward, icon:d.icon, desc:d.desc,
             current: Math.round(current * 10) / 10, completed, claimed: claimed.has(d.id) };
  });
  return { missions, todayOrders, onlineHours, avgRatingToday };
}

// GET /api/shipper/missions — Nhiệm vụ ngày của shipper (real-time)
app.get("/api/shipper/missions", async (req, res) => {
  try {
    const shipper = await currentShipperFromSession(req, res);
    if (!shipper) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const data = await buildDailyMissions(shipper);
    res.json({ success: true, ...data });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/shipper/missions/claim — Nhận thưởng nhiệm vụ khi đã hoàn thành
app.post("/api/shipper/missions/claim", async (req, res) => {
  try {
    const shipper = await currentShipperFromSession(req, res);
    if (!shipper) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const { missionId } = req.body;
    const data = await buildDailyMissions(shipper);
    const mission = data.missions.find(m => m.id === missionId);
    if (!mission) return res.status(404).json({ success: false, message: "Không tìm thấy nhiệm vụ" });
    if (!mission.completed) return res.status(400).json({ success: false, message: "Nhiệm vụ chưa hoàn thành, tiếp tục cố gắng nhé!" });
    if (mission.claimed) return res.status(400).json({ success: false, message: "Bạn đã nhận thưởng nhiệm vụ này hôm nay rồi" });

    await Shipper.updateOne({ _id: shipper._id }, { $push: { missionClaims: { id: missionId, day: dayKey(), claimedAt: new Date() } } });
    await walletCredit(shipper._id, 'shipper', mission.reward, 'mission', `Thưởng nhiệm vụ "${mission.title}"`);
    console.log(`[Mission] Shipper ${shipper._id} claimed ${missionId} +${mission.reward}`);
    res.json({ success: true, reward: mission.reward, message: `Nhận thưởng ${mission.reward.toLocaleString('vi-VN')}đ thành công!` });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/shipper/tier — Hạng tài xế (real-time từ đơn thực tế)
app.get("/api/shipper/tier", async (req, res) => {
  try {
    const shipper = await currentShipperFromSession(req, res);
    if (!shipper) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const stats = await getShipperStats(shipper._id, shipper);
    const orders = stats.totalOrders;
    const rating = stats.rating;
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
    const progress = nextTier ? {
      ordersNeeded: Math.max(0, nextTier.minOrders - orders),
      ratingNeeded: Math.max(0, Math.round((nextTier.minRating - rating) * 100) / 100),
      percent: Math.min(100, Math.round(((orders / Math.max(1, nextTier.minOrders)) + (Math.min(rating, nextTier.minRating) / nextTier.minRating)) / 2 * 100)),
    } : { ordersNeeded: 0, ratingNeeded: 0, percent: 100 };
    res.json({
      success: true, currentTier, nextTier, orders, rating, tiers, progress,
      monthOrders: stats.monthOrders, monthEarnings: stats.monthEarnings,
    });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/shipper/policy — Chính sách đảm bảo thu nhập tối thiểu
app.get("/api/shipper/policy", async (req, res) => {
  try {
    const shipper = await currentShipperFromSession(req, res);
    if (!shipper) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const stats = await getShipperStats(shipper._id, shipper);
    res.json({
      success: true,
      guarantee: {
        active: true,
        title: "Đảm bảo thu nhập tối thiểu",
        dailyTarget: 120000,       // mục tiêu thu nhập / ngày
        weeklyTarget: 800000,      // mục tiêu thu nhập / tuần
        monthlyTarget: 3500000,    // mục tiêu thu nhập / tháng
        terms: [
          "Đạt đủ 4.8⭐ trở lên và tỷ lệ hoàn thành đơn ≥ 95% trong kỳ.",
          "Bật nhận đơn tối thiểu 6 tiếng/ngày và hoàn thành ít nhất 20 đơn/tuần.",
          "Thu nhập bảo hiểm được trả bổ sung chênh lệch cuối kỳ vào ví, không thay thế hoa hồng.",
        ],
      },
      stats: {
        todayEarnings: stats.todayEarnings,
        weekEarnings: stats.weekEarnings,
        monthEarnings: stats.monthEarnings,
        todayOrders: stats.todayOrders,
        weekOrders: stats.weekOrders,
        monthOrders: stats.monthOrders,
        totalOrders: stats.totalOrders,
        cancelledOrders: stats.cancelledOrders,
        completionRate: stats.completionRate,
        cancelRate: stats.cancelRate,
        acceptRate: stats.acceptRate,
        rating: stats.rating,
        onlineMinutesToday: stats.onlineMinutesToday,
        onlineHoursMonth: stats.onlineHoursMonth,
        onlineSecondsTotal: stats.onlineSecondsTotal,
      },
    });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/partner/revenue-chart — Biểu đồ doanh thu 7 ngày
app.get("/api/partner/revenue-chart", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success: false });
    const pid = partner._id;
    const days = [];
    const labels = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate()-i); d.setHours(0,0,0,0);
      const end = new Date(d); end.setHours(23,59,59,999);
      const agg = await Order.aggregate([
        { $match: { partnerId: pid, status:"delivered", deliveredAt:{$gte:d,$lte:end} }},
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
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const isAccepting = req.body.isAccepting ?? req.body.accepting;
    const mod = "food_partner";
    const Model = getPartnerModel(mod);
    await Model.findByIdAndUpdate(partner._id, { isAccepting: !!isAccepting });
    req.io.to("admin").emit("partnerStatusChanged", {
      partnerId: partner._id, isAccepting, module: mod
    });
    // Notify shipper broadcast room
    if (!!isAccepting) req.io.to("shipper_broadcast").emit("partner_online", { partnerId: partner._id });
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

// POST /api/loyalty/earn — Cộng điểm sau đơn delivered (gọi sau delivered/completed)
async function earnLoyaltyPoints(userId, orderTotal) {
  try {
    if (!userId || !orderTotal) return;
    const pts = Math.floor(orderTotal / 10); // điểm = 1/10 giá trị đơn
    if (pts <= 0) return;
    await User.findByIdAndUpdate(userId, {
      $inc: { loyaltyPts: pts, totalSpent: orderTotal }
    });
    try {
      await LoyaltyLog.create({
        userId, delta: pts, type: 'earn',
        description: `Tích điểm từ đơn hàng ${orderTotal.toLocaleString('vi-VN')}đ`,
      });
    } catch(_) {}
    console.log(` [Loyalty] +${pts} pts (đơn ${orderTotal}) cho user ${userId}`);
  } catch(e) {}
}

// ── Helper: tính tổng tiền thực trả của đơn để cộng điểm ──
function orderPaidAmount(order, extra = {}) {
  if (order.finalTotal != null && order.finalTotal > 0) return Math.round(order.finalTotal);
  return Math.max(0, Math.round((order.total||0) + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0)));
}

// GET /api/loyalty/me — Điểm tích lũy của user
app.get("/api/loyalty/me", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const user = await User.findById(req.session.userId).select("loyaltyPts totalSpent totalOrders");
    if (!user) return res.status(404).json({ success: false });
    const pts = user.loyaltyPts || 0;
    const tiers = [
      { name:'Thành viên', icon:'🥉', min:0,    color:'#cd7f32', perks:['Tích điểm 10% giá trị đơn'] },
      { name:'Bạc',        icon:'🥈', min:25000,  color:'#aaa',    perks:['Tích điểm 10% giá trị đơn','Voucher sinh nhật'] },
      { name:'Vàng',       icon:'🥇', min:100000, color:'#FFD700', perks:['Tích điểm 12% giá trị đơn','Freeship 2 đơn/tháng'] },
      { name:'VIP',        icon:'💎', min:300000, color:'#b9f2ff', perks:['Tích điểm 15% giá trị đơn','Freeship không giới hạn','Ưu tiên shipper'] },
    ];
    let currentTier = tiers[0];
    for (let i = tiers.length-1; i >= 0; i--) {
      if (pts >= tiers[i].min) { currentTier = tiers[i]; break; }
    }
    const nextTier = tiers[tiers.indexOf(currentTier)+1] || null;
    const history = await LoyaltyLog.find({ userId: req.session.userId }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({
      success: true, pts,
      points: pts,                                  // FE đọc field này
      currentTier, nextTier,
      totalOrders: user.totalOrders || 0, totalSpent: user.totalSpent || 0,
      history: history.map(h => ({ id: h._id, points: h.delta, description: h.description, type: h.type, voucherCode: h.voucherCode, createdAt: h.createdAt })),
    });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Mức đổi điểm → voucher (100 điểm = 10.000đ) ──
const LOYALTY_LEVELS = [
  { pts: 100,  title: 'Voucher 10.000đ', discount: 10000, days: 30,
    desc: 'Voucher giảm 10.000đ cho đơn hàng bất kỳ — 100 điểm' },
  { pts: 200,  title: 'Voucher 20.000đ', discount: 20000, days: 30,
    desc: 'Voucher giảm 20.000đ cho đơn hàng bất kỳ — 200 điểm' },
  { pts: 300,  title: 'Voucher 30.000đ', discount: 30000, days: 30,
    desc: 'Voucher giảm 30.000đ cho đơn hàng bất kỳ — 300 điểm' },
];

// GET /api/loyalty/levels — Danh sách voucher đổi được bằng điểm
app.get("/api/loyalty/levels", async (req, res) => {
  try {
    res.json({ success: true, levels: LOYALTY_LEVELS });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/loyalty/redeem — Đổi điểm tích lũy lấy voucher (100 điểm = 10.000đ)
app.post("/api/loyalty/redeem", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const { pts, points, levelId } = req.body || {};
    const want = Number(pts != null ? pts : points);
    const level = want ? LOYALTY_LEVELS.find(l => l.pts === want) : (levelId != null ? LOYALTY_LEVELS[Number(levelId)] : null);
    if (!level) return res.status(400).json({ success: false, message: "Mức điểm không hợp lệ. Hãy chọn gói có sẵn (100/200/300 điểm)." });
    const user = await User.findById(req.session.userId);
    if (!user || (user.loyaltyPts || 0) < level.pts) return res.status(400).json({ success: false, message: `Không đủ điểm (bạn có ${(user.loyaltyPts||0).toLocaleString('vi-VN')} điểm)` });
    // Tạo voucher giảm giá cố định dùng 1 lần
    const code = "LPT" + Date.now().toString(36).toUpperCase();
    const expiry = new Date(Date.now() + level.days * 24 * 3600 * 1000);
    await Voucher.create({
      code, type: 'fixed', value: level.discount, minOrder: 0,
      usageLimit: 1, expiresAt: expiry,
      description: level.desc || level.title, module: "all", target: "order", active: true,
      source: 'loyalty', ownerId: req.session.userId,
    });
    await User.findByIdAndUpdate(req.session.userId, { $inc: { loyaltyPts: -level.pts } });
    await LoyaltyLog.create({
      userId: req.session.userId, delta: -level.pts, points: Math.max(0, (user.loyaltyPts||0) - level.pts),
      type: 'redeem', description: `Đổi ${level.pts} điểm lấy ${level.title}`, voucherCode: code,
    });
    res.json({ success: true, code, ptsSpent: level.pts, ptsLeft: Math.max(0, (user.loyaltyPts||0) - level.pts), title: level.title, expiry,
      message: `Đã đổi ${level.pts} điểm thành voucher ${code} (${level.title})` });
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

// GET /api/support/my — Customer/Shipper/Partner lấy danh sách ticket của mình
app.get("/api/support/my", async (req, res) => {
  try {
    const { role, phone } = req.query;
    const filter = {};
    if (req.session.userId) filter.userId = req.session.userId;
    else if (req.session.shipperId) filter.userId = req.session.shipperId;
    else if (req.session.partnerId) filter.userId = req.session.partnerId;
    else if (role && phone) { filter.role = role; filter.phone = phone; }
    else return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const tickets = await SupportTicket.find(filter).sort({ createdAt:-1 }).limit(100);
    res.json({ success:true, data:tickets, total:tickets.length });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/support/order — Hỗ trợ ĐƠN HÀNG (workflow)
// 1) Khách chọn danh mục + (gần nhất) + mã shipper/partner → gửi
// 2) Coco AI đọc & phân tích lý do
// 3) Nếu khiếu nại về quán/shipper → lập tức cảnh cáo tài khoản tương ứng
app.post("/api/support/order", async (req, res) => {
  try {
    const { category, orderId, shipperCode, partnerCode, message, description } = req.body || {};
    const text = String(message || description || '').trim();
    if (!text) return res.status(400).json({ success:false, message:"Thiếu nội dung hỗ trợ" });
    const categoryLabel = String(category || 'chung');

    // 1) Tra đơn (nếu khách chọn đơn)
    let orderRef = null;
    if (orderId) {
      orderRef = await Order.findOne({
        $or: [{ orderId: String(orderId) }, mongoose.isValidObjectId(orderId) ? { _id: orderId } : null],
      }).lean();
    }

    // Lưu ticket đơn hàng
    const ticket = await SupportTicket.create({
      userId: req.session.userId || null,
      role: "customer",
      orderId: orderRef?.orderId || String(orderId || ""),
      type: "order",
      category: categoryLabel,
      message: `[${categoryLabel}] ${text}`,
      priority: /mất|hỏng|thiu|kém|không|giao sai|muộn|còn|thiếu/i.test(text) ? "urgent" : "high",
    });

    // 2) Coco AI phân tích (backend = Cloudflare, retry 3 lần qua cocoThink)
    let aiReply = "";
    try {
      const { cocoThink } = require("./coco-brain");
      const prompt = `Khách hàng gửi hỗ trợ về đơn hàng (danh mục: ${categoryLabel}).\nNội dung: "${text}"\n\nHãy đánh giá trong 3-5 câu tiếng Việt:\na) Có phàn nàn về QUÁN / đối tác không? (chất lượng kém, đồ thiu, sai món, ít đồ, đồ nguội...)\nb) Có phàn nàn về SHIPPER không? (thái độ tệ, giao chậm, giao sai, làm rơi, mất đồ...)\nc) đề xuất hướng xử lý phù hợp cho CRABOR. Nếu không phải khiếu nại ai thì xác nhận đã ghi nhận.`;
      const r = await cocoThink([{ role: "user", content: prompt }], {
        task: "complaint", backend: "cloudflare", temperature: 0.4, maxTokens: 450,
      });
      aiReply = (r && r.text) ? String(r.text).trim() : "";
    } catch (e) { console.warn("[Support Order] cocoThink:", e.message); }
    if (!aiReply) aiReply = `Coco đã ghi nhận hỗ trợ thuộc danh mục "${categoryLabel}". Đội ngũ CRABOR sẽ phản hồi trong 1-2 giờ.`;

    // 3) Xác định đối tượng bị khiếu nại
    const textLower = text.toLowerCase();
    const COMPLAINT_PARTNER_RE = /quán|nhà hàng|tiệm|partner|chất lượng|thiu|hỏng|sai món|ít đồ|đồ nguội|khai vị|giá chênh|không ngon|dở/;
    const COMPLAINT_SHIPPER_RE = /shipper|tài xế|giao chậm|giao sai|mất đồ|làm rơi|thái độ|quẳng|vứt|nói khó|điện thoại không nghe/;
    const complaintPartner = COMPLAINT_PARTNER_RE.test(textLower);
    const complaintShipper = COMPLAINT_SHIPPER_RE.test(textLower);
    const warnings = [];
    const cleanCode = (s) => String(s || "").replace(/[^\w@.\-]/g, "").trim();

    // ── Cảnh cáo PARTNER ──
    if (complaintPartner) {
      let partnerTarget = null;
      if (orderRef?.partnerId) partnerTarget = await FoodPartner.findById(orderRef.partnerId).lean();
      if (!partnerTarget && partnerCode) {
        const c = new RegExp(`^${cleanCode(partnerCode)}$`, 'i');
        partnerTarget = await FoodPartner.findOne({ $or: [{ registerId: c }, { phone: c }] }).lean();
      }
      if (partnerTarget) {
        await notifyUser("partner", partnerTarget._id, {
          type: "warning",
          title: "⚠️ Cảnh cáo chất lượng từ khách hàng",
          body: `Đơn ${orderRef?.orderId || '#'} — ${text.slice(0, 200)}. Vui lòng kiểm tra quy trình & an toàn vệ sinh thực phẩm (CRABOR 24/7).`,
          ref: orderRef?.orderId || "",
          refModule: String(orderRef?.module || categoryLabel),
        });
        warnings.push({ target: "partner", name: partnerTarget.bizName, code: partnerTarget.registerId, _id: partnerTarget._id });
      } else {
        warnings.push({ target: "partner", name: partnerCode || "đối tác (không tìm thấy mã)", code: partnerCode || "", unresolved: true });
      }
    }

    // ── Cảnh cáo SHIPPER ──
    if (complaintShipper) {
      let shipperTarget = null;
      if (orderRef?.shipperId) shipperTarget = await Shipper.findById(orderRef.shipperId).lean();
      if (!shipperTarget && shipperCode) {
        const c = new RegExp(`^${cleanCode(shipperCode)}$`, 'i');
        shipperTarget = await Shipper.findOne({ $or: [{ registerId: c }, { phone: cleanCode(shipperCode) }] }).lean();
      }
      if (shipperTarget) {
        await notifyUser("shipper", shipperTarget._id, {
          type: "warning",
          title: "⚠️ Cảnh cáo thái độ/trách nhiệm từ khách hàng",
          body: `Đơn ${orderRef?.orderId || '#'} — ${text.slice(0, 200)}. Hãy tuân thủ quy trình giao hàng CRABOR.`,
          ref: orderRef?.orderId || "",
          refModule: String(orderRef?.module || categoryLabel),
        });
        warnings.push({ target: "shipper", name: shipperTarget.fullName || shipperTarget.registerId, code: shipperTarget.registerId, _id: shipperTarget._id });
      } else {
        warnings.push({ target: "shipper", name: shipperCode || "shipper (không tìm thấy mã)", code: shipperCode || "", unresolved: true });
      }
    }

    req.io && req.io.to("admin").emit("newSupportTicket", {
      id: ticket._id, type: "order", role: "customer", message: `[${categoryLabel}] ${text.slice(0, 80)}`, priority: ticket.priority,
    });

    const reply = buildSupportAiReply(aiReply, warnings);
    res.json({
      success: true, ticketId: ticket._id, aiReply: reply, warnings,
      message: "Đã gửi hỗ trợ. " + (warnings.length ? `Đã gửi cảnh cáo tới ${warnings.length} tài khoản liên quan.` : ""),
    });
  } catch (err) {
    console.error("[Support Order]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

function buildSupportAiReply(ai, warnings) {
  let s = `🦀 **Coco AI đã đọc hỗ trợ của bạn.**\n\n${ai || ""}\n\n`;
  if (warnings.length) {
    s += "⚖️ **Đã lập tức gửi cảnh cáo:**\n" + warnings.map(w =>
      w.target === "shipper"
        ? `• 🛵 Shipper ${w.name} (${w.code})`
        : `• 🏪 ${w.name} (${w.code})`
    ).join("\n") + "\n\nCRABOR sẽ theo dõi — nếu tái phạm sẽ xử lý kỷ luật.";
  } else {
    s += "Hỗ trợ của bạn đã được ghi nhận. Đội ngũ CS 24/7 sẽ phản hồi trong 1-2 giờ tới.";
  }
  return s;
}

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
    }).limit(6).select("_id bizName address district categories rating coverImage avatar featuredBanner featuredBannerVertical");
    const data = featured.map(p => ({
      _id: p._id,
      name: p.bizName,
      bizName: p.bizName,
      logo: p.avatar || p.featuredBanner || p.coverImage,
      coverImage: p.featuredBanner || p.coverImage,
      verticalBanner: p.featuredBannerVertical || null,
      address: p.address,
      district: p.district,
      categories: p.categories,
      rating: p.rating,
      deliveryTime: "25",
    }));
    res.json({ success:true, data });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// ══════════════════════════════════════════════
//  FEATURED RESTAURANT — partner mua gói nổi bật
// ══════════════════════════════════════════════
const FEATURED_PRICE_PER_HOUR = 50000;
const FEATURED_PACKAGES = [
  { hours: 4,  label: "4 giờ",  price: 4  * FEATURED_PRICE_PER_HOUR },
  { hours: 8,  label: "8 giờ",  price: 8  * FEATURED_PRICE_PER_HOUR },
  { hours: 12, label: "12 giờ", price: 12 * FEATURED_PRICE_PER_HOUR },
  { hours: 24, label: "24 giờ", price: 24 * FEATURED_PRICE_PER_HOUR },
];

// POST /api/partner/featured/request — partner tạo yêu cầu nổi bật
app.post("/api/partner/featured/request", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.partnerId && !req.session.userPhone) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(404).json({ success:false, message:"Không tìm thấy quán" });
    if (partner.status !== "approved") return res.status(403).json({ success:false, message:"Quán chưa được duyệt" });

    const { hours, paymentMethod, bannerImage, bannerVertical } = req.body || {};
    const pkg = FEATURED_PACKAGES.find(p => p.hours === Number(hours));
    if (!pkg) return res.status(400).json({ success:false, message:"Gói giờ không hợp lệ (4/8/12/24)" });
    if (!["sepay","payos","wallet"].includes(paymentMethod))
      return res.status(400).json({ success:false, message:"Phương thức thanh toán không hợp lệ" });
    if (!bannerImage || bannerImage.length < 50)
      return res.status(400).json({ success:false, message:"Cần tải ảnh banner" });

    // Đang có gói nổi bật chưa hết hạn? chặn tạo mới
    if (partner.featured && partner.featuredUntil && new Date(partner.featuredUntil) > new Date())
      return res.status(400).json({ success:false, message:"Quán đang trong thời gian nổi bật" });

    const bannerImageUp = await uploadImageToCloudinary(bannerImage, "banners");
    const request = await FeaturedRequest.create({
      partnerId: partner._id,
      partnerName: partner.bizName || partner.fullName || "Quán",
      bannerImage: bannerImageUp,
      bannerVertical,
      hours: pkg.hours,
      amount: pkg.price,
      paymentMethod,
    });

    let payExtra = {};
    // Ví CRABOR: trừ ngay
    if (paymentMethod === "wallet") {
      try {
        await walletDebit(partner._id, 'partner', pkg.price, 'debit', request.requestId,
          `Mua gói nổi bật ${pkg.hours} giờ (${pkg.label})`);
        request.paymentStatus = "paid";
        request.paidAt = new Date();
        await request.save();
        payExtra.walletPaid = true;
      } catch (e) {
        await FeaturedRequest.deleteOne({ _id: request._id });
        return res.status(400).json({ success:false, message: e.message || "Ví không đủ số dư" });
      }
    }

    // SePay: tạo QR
    if (paymentMethod === "sepay") {
      const sePayRef = "CRFTR" + request.requestId.replace(/[^A-Z0-9]/gi, "").slice(-8).toUpperCase();
      request.sePayRef = sePayRef;
      await request.save();
      payExtra = {
        qrUrl: sepayQrUrl(pkg.price, sePayRef),
        sePayRef,
        bankName: SEPAY_CONFIG.bankName,
        bankCode: SEPAY_CONFIG.bankCode,
        accountNo: SEPAY_CONFIG.accountNo,
        accountName: SEPAY_CONFIG.accountName,
      };
    }

    // PayOS: tạo link thanh toán
    if (paymentMethod === "payos") {
      try {
        const orderCode = parseInt(Date.now().toString().slice(-9));
        const description = "CRABOR NOI BAT " + pkg.hours + "h";
        if (payOS) {
          const paymentData = {
            orderCode,
            amount: pkg.price,
            description,
            items: [{ name: `Gói nổi bật ${pkg.hours} giờ`, quantity: 1, price: pkg.price }],
          };
          let link;
          if (typeof payOS.paymentRequests?.create === 'function') link = await payOS.paymentRequests.create(paymentData);
          else if (typeof payOS.createPaymentLink === 'function') link = await payOS.createPaymentLink(paymentData);
          const linkData = link?.data && typeof link.data === 'object' ? link.data : link;
          request.payosOrderCode = String(linkData?.orderCode ?? orderCode);
          request.payosCheckoutUrl = linkData?.checkoutUrl;
          await request.save();
          payExtra = { checkoutUrl: linkData?.checkoutUrl, orderCode: request.payosOrderCode, payosPaid: false };
        } else {
          request.payosOrderCode = String(orderCode);
          await request.save();
          const qrUrl = vietQrUrl(pkg.price, description);
          payExtra = { qrUrl, orderCode: String(orderCode), payosFallback: true };
        }
      } catch (e) {
        console.warn("[Featured PayOS] fallback:", e.message);
        request.payosOrderCode = String(parseInt(Date.now().toString().slice(-9)));
        await request.save();
        payExtra = { payosError: e.message };
      }
    }

    req.io?.to("admin").emit("featured_request_created", { requestId: request.requestId, partnerName: request.partnerName, amount: request.amount });

    res.json({
      success: true,
      request: { _id: request._id, requestId: request.requestId, hours: request.hours, amount: request.amount,
        paymentMethod, paymentStatus: request.paymentStatus, status: request.status,
        bannerImage: request.bannerImage, bannerVertical: request.bannerVertical, sePayRef: request.sePayRef, payosCheckoutUrl: request.payosCheckoutUrl },
      ...payExtra,
    });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/partner/featured/request/:id/confirm-payment — xác nhận đã chuyển khoản
app.post("/api/partner/featured/request/:id/confirm-payment", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.partnerId && !req.session.userPhone) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(404).json({ success:false, message:"Không tìm thấy quán" });
    const request = await FeaturedRequest.findOne({ _id: req.params.id, partnerId: partner._id });
    if (!request) return res.status(404).json({ success:false, message:"Không tìm thấy yêu cầu" });
    if (request.paymentStatus === "paid")
      return res.json({ success:true, request });
    request.paymentStatus = "pending_review";
    request.paidAt = new Date();
    await request.save();
    req.io?.to("admin").emit("featured_request_paid", { requestId: request.requestId, partnerName: request.partnerName });
    res.json({ success:true, request });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/partner/featured/status — trạng thái nổi bật của quán + lịch sử
app.get("/api/partner/featured/status", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.partnerId && !req.session.userPhone) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const partner = await getSessionFoodPartner(req);
    const pid = partner?._id || req.session.partnerId;
    const requests = await FeaturedRequest.find({ partnerId: pid }).sort({ createdAt: -1 }).limit(20);
    res.json({
      success: true,
      featured: {
        active: !!(partner?.featured && partner?.featuredUntil && new Date(partner.featuredUntil) > new Date()),
        featuredUntil: partner?.featuredUntil,
        banner: partner?.featuredBanner,
        bannerVertical: partner?.featuredBannerVertical,
        hours: partner?.featuredHours,
        package: partner?.featuredPackage,
        featuredAt: partner?.featuredAt,
      },
      requests,
    });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/admin/featured-requests — danh sách yêu cầu cho admin
app.get("/api/admin/featured-requests", adminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const q = {};
    if (status && status !== "all") q.status = status;
    const requests = await FeaturedRequest.find(q).sort({ createdAt: -1 }).limit(100);
    res.json({ success:true, data: requests });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/admin/featured-requests/:id/approve — duyệt → kích hoạt featured
app.post("/api/admin/featured-requests/:id/approve", adminAuth, async (req, res) => {
  try {
    const request = await FeaturedRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success:false, message:"Không tìm thấy yêu cầu" });
    if (request.status !== "pending")
      return res.status(400).json({ success:false, message:"Yêu cầu đã được xử lý" });

    const until = new Date(Date.now() + request.hours * 3600e3);
    await FoodPartner.findByIdAndUpdate(request.partnerId, {
      featured: true,
      featuredUntil: until,
      featuredBanner: request.bannerImage,
      featuredBannerVertical: request.bannerVertical,
      featuredHours: request.hours,
      featuredPackage: `Nổi bật ${request.hours} giờ`,
      featuredAt: new Date(),
    });
    request.status = "approved";
    request.approvedAt = new Date();
    request.paymentStatus = request.paymentStatus === "unpaid" ? "pending_review" : request.paymentStatus;
    await request.save();

    req.io?.to(`partner_${request.partnerId}`).emit("featured_approved", { until, hours: request.hours });
    await notifyUser('partner', request.partnerId, {
      type: 'featured', title: '✨ Quán của bạn đã nổi bật!',
      body: `Đã kích hoạt "Nổi bật ${request.hours} giờ" — quán của bạn sẽ xuất hiện ở vị trí nổi bật`,
      refModule: 'featured',
    });
    res.json({ success:true, message:`Đã kích hoạt nổi bật ${request.hours} giờ`, until });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/admin/featured-requests/:id/reject — từ chối
app.post("/api/admin/featured-requests/:id/reject", adminAuth, async (req, res) => {
  try {
    const request = await FeaturedRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success:false, message:"Không tìm thấy yêu cầu" });
    if (request.status !== "pending")
      return res.status(400).json({ success:false, message:"Yêu cầu đã được xử lý" });
    request.status = "rejected";
    request.rejectedAt = new Date();
    request.adminNote = req.body?.note || "Bị từ chối bởi admin";
    await request.save();
    req.io?.to(`partner_${request.partnerId}`).emit("featured_rejected", { note: request.adminNote });
    await notifyUser('partner', request.partnerId, {
      type: 'featured', title: '❌ Yêu cầu nổi bật bị từ chối',
      body: request.adminNote || 'Yêu cầu nổi bật của bạn bị từ chối',
      refModule: 'featured',
    });
    res.json({ success:true, message:"Đã từ chối yêu cầu" });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});


// ═══════════════════════════════════════════════════════════
//  AUTO "QUÁN NỔI BẬT" — mỗi tuần (7 ngày) tự động chọn + tạo banner
// ═══════════════════════════════════════════════════════════
const AUTO_FEATURE_HOURS = 24 * 7; // 1 tuần
const AUTO_FEATURE_LABEL = "1 tuần";

async function autoFeatureTopDish(partnerId) {
  try {
    const dishAgg = await Order.aggregate([
      { $match: { module: "food", partnerId, status: { $nin: ["cancelled", "refunded"] } } },
      { $unwind: "$items" },
      { $group: { _id: { name: "$items.name" }, qty: { $sum: "$items.qty" } } },
      { $sort: { qty: -1 } },
      { $limit: 1 },
    ]);
    if (dishAgg.length) return dishAgg[0]._id.name;
    const best = await Product.findOne({ partnerId, available: true }).sort({ sold: -1 });
    return best ? best.name : null;
  } catch (err) { return null; }
}

async function autoFeaturePick() {
  // Quán có nhiều đánh giá 5★ nhất (chọn ngẫu nhiên nếu hòa)
  const stars = await Order.aggregate([
    { $match: { module: "food", status: { $in: ["delivered"] }, ratingPartner: 5 } },
    { $group: { _id: "$partnerId", stars: { $sum: 1 } } },
    { $sort: { stars: -1 } },
  ]);
  const valid = (stars || []).filter(s => s._id);
  if (!valid.length) return null;
  const max = valid[0].stars;
  const top = valid.filter(s => s.stars === max);
  const picked = top[Math.floor(Math.random() * top.length)];
  const partner = await FoodPartner.findOne({ _id: picked._id, status: "approved" });
  if (!partner) return null;
  return {
    partner,
    fiveStars: max,
    topDish: await autoFeatureTopDish(partner._id),
  };
}

async function autoFeatureSelectionDoc(state) {
  if (!state || !state.selectedPartnerId) return null;
  const p = await FoodPartner.findById(state.selectedPartnerId);
  if (!p) return null;
  return {
    partnerId: p._id,
    bizName: p.bizName,
    district: p.district,
    description: p.description,
    avatar: p.avatar,
    rating: p.rating || 0,
    ratingCount: p.ratingCount || 0,
    topDish: await autoFeatureTopDish(p._id),
  };
}

// GET — trạng thái + chọn quán khi đến hạn
app.get("/api/admin/auto-feature", adminAuth, async (req, res) => {
  try {
    const now = new Date();
    let state = await FeatureState.findOne({ key: "auto_feature" });
    const due = !state || !state.nextRunAt || now >= new Date(state.nextRunAt);

    if (state && state.status === "in_progress") {
      const selection = await autoFeatureSelectionDoc(state);
      if (!selection) {
        // Quán đã bị xoá/vô hiệu → reset, lịch lại sau 1 tuần
        state.status = "idle";
        state.nextRunAt = new Date(now.getTime() + AUTO_FEATURE_HOURS * 3600e3);
        state.selectedPartnerId = null;
        state.selectedAt = null;
        await state.save();
        return res.json({ success: true, due: false, inProgress: false, nextRunAt: state.nextRunAt });
      }
      return res.json({ success: true, due: true, inProgress: true, nextRunAt: state.nextRunAt, selection });
    }
    if (!due) {
      return res.json({ success: true, due: false, inProgress: false, nextRunAt: state && state.nextRunAt });
    }

    // Đến hạn → chọn quán có nhiều 5★ nhất
    const picked = await autoFeaturePick();
    if (!picked) {
      const next = new Date(now.getTime() + AUTO_FEATURE_HOURS * 3600e3);
      if (state) { state.nextRunAt = next; await state.save(); }
      return res.json({ success: true, due: false, inProgress: false, nextRunAt: next, message: "Chưa có quán đủ điều kiện (cần đơn hoàn thành + đánh giá 5★)" });
    }
    if (!state) state = new FeatureState({ key: "auto_feature" });
    state.status = "in_progress";
    state.selectedPartnerId = picked.partner._id;
    state.selectedAt = now;
    await state.save();
    res.json({
      success: true, due: true, inProgress: true, nextRunAt: null,
      selection: {
        partnerId: picked.partner._id,
        bizName: picked.partner.bizName,
        district: picked.partner.district,
        description: picked.partner.description,
        avatar: picked.partner.avatar,
        rating: picked.partner.rating || 0,
        ratingCount: picked.partner.ratingCount || 0,
        fiveStars: picked.fiveStars,
        topDish: picked.topDish,
      },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST — hoàn tất (banner đã đăng): gắn nổi bật cho quán, lịch tiếp theo +1 tuần
app.post("/api/admin/auto-feature/complete", adminAuth, async (req, res) => {
  try {
    const state = await FeatureState.findOne({ key: "auto_feature" });
    if (!state) return res.json({ success: false, message: "Không có tiến trình auto-feature" });
    const pid = state.selectedPartnerId;
    const now = new Date();
    const until = new Date(now.getTime() + AUTO_FEATURE_HOURS * 3600e3);
    if (pid) {
      // Xoay vòng: chỉ giữ 1 quán nổi bật tại một thời điểm
      await FoodPartner.updateMany({ featured: true, _id: { $ne: pid } }, { featured: false });
      const bannerUrl = req.body && req.body.bannerUrl;
      await FoodPartner.findByIdAndUpdate(pid, {
        featured: true,
        featuredUntil: until,
        featuredAt: now,
        featuredHours: AUTO_FEATURE_HOURS,
        featuredPackage: `Auto nổi bật ${AUTO_FEATURE_LABEL}`,
        ...(bannerUrl ? { featuredBanner: bannerUrl, featuredBannerVertical: bannerUrl } : {}),
      });
      req.io?.to(`partner_${pid}`).emit("featured_approved", { until, hours: AUTO_FEATURE_HOURS });
      try {
        await notifyUser('partner', pid, {
          type: 'featured', title: '✨ Quán của bạn đã nổi bật!',
          body: `Hệ thống đã tự động chọn quán bạn làm "Quán nổi bật" (${AUTO_FEATURE_LABEL}) nhờ nhiều đánh giá 5★ nhất.`,
          refModule: 'featured',
        });
      } catch (e) {}
    }
    state.status = "idle";
    state.lastRunAt = now;
    state.nextRunAt = until;
    state.selectedPartnerId = null;
    state.selectedAt = null;
    await state.save();
    res.json({ success: true, nextRunAt: until });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST — bỏ qua (lỗi tạo ảnh/banner): lịch tiếp theo +1 tuần
app.post("/api/admin/auto-feature/skip", adminAuth, async (req, res) => {
  try {
    const state = await FeatureState.findOne({ key: "auto_feature" });
    if (state) {
      state.status = "idle";
      state.nextRunAt = new Date(Date.now() + AUTO_FEATURE_HOURS * 3600e3);
      state.selectedPartnerId = null;
      state.selectedAt = null;
      await state.save();
      res.json({ success: true, nextRunAt: state.nextRunAt });
    } else res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ══════════════════════════════════════════════
//  AI BANNER ENDPOINTS
// ══════════════════════════════════════════════

// GET /api/banners — Public: lấy banner active để hiển thị cho customer
// Hỗ trợ ?app=customer|partner|shipper — mỗi app chỉ nhận banner nhắm tới mình
app.get("/api/banners", async (req, res) => {
  try {
    if (!AIBanner) return res.json({ success: true, data: [] });
    const now = new Date();
    const targetApp = (req.query.app || "customer").toString();
    // Banner cũ (chưa có apps) chỉ hiện ở customer app; partner/shipper chỉ nhận banner được nhắm tới
    const appFilter = targetApp === "customer"
      ? { $or: [{ apps: "customer" }, { apps: { $exists: false } }] }
      : { apps: targetApp };
    const category = (req.query.category || "promo").toString();
    const categoryFilter = category === "finance"
      ? { category: "finance" }
      : { $or: [{ category: { $nin: ["finance"] } }, { category: { $exists: false } }] };
    const banners = await AIBanner.find({
      active: true,
      $and: [
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
        appFilter,
        categoryFilter,
      ],
    }).sort({ order: -1, createdAt: -1 }).limit(10);
    // Track impressions
    const ids = banners.map(b => b._id);
    AIBanner.updateMany({ _id: { $in: ids } }, { $inc: { impressions: 1 } }).catch(()=>{});
    // Strip non-fetchable image URLs (e.g. browser blob: URLs) so the mobile app renders the
    // gradient AI card instead of a blank image box
    banners.forEach(b => { if (b.imageUrl && !/^https?:\/\//i.test(b.imageUrl) && !/^data:/i.test(b.imageUrl)) b.imageUrl = null; });
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
    const body = { ...req.body };
    if (typeof body.imageUrl === "string" && body.imageUrl.startsWith("data:image"))
      body.imageUrl = await uploadImageToCloudinary(body.imageUrl, "banners");
    const banner = await AIBanner.create(body);
    // Broadcast realtime tới tất cả customer
    req.io.to("customer_broadcast").emit("bannersUpdated", { action: "add", bannerId: banner._id });
    res.json({ success: true, data: banner });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/admin/banners/:id — Admin: cập nhật banner
app.patch("/api/admin/banners/:id", adminAuth, async (req, res) => {
  try {
    const body = { ...req.body };
    if (typeof body.imageUrl === "string" && body.imageUrl.startsWith("data:image"))
      body.imageUrl = await uploadImageToCloudinary(body.imageUrl, "banners");
    const banner = await AIBanner.findByIdAndUpdate(req.params.id, body, { new: true });
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

// ══════════════════════════════════════════════════════════════════════════════
//  ADMIN — QUẢN LÝ MÓN & THỰC ĐƠN ĐỐI TÁC (lọc + chặn vi phạm chính sách)
// ══════════════════════════════════════════════════════════════════════════════
// Từ khóa nhận diện món/dịch vụ vi phạm chính sách nền tảng
const VIOLATION_KEYWORDS = [
  "rút ví", "rút ví trả sau", "đáo hạn", "vay nóng", "vay tiền", "cho vay",
  "vay ví", "tín dụng đen", "cầm đồ", "cờ bạc", "cá độ", "lô đề", "đánh bạc",
  "game đổi thưởng", "thuốc lắc", "ma túy", "cần sa", "thuốc phiện", "cỏ mỹ",
  "heroin", "vũ khí", "súng", "dao kiếm", "đồ giả", "hàng nhái", "hành nghề trái phép",
  "mua bán người", "nội dung nhạy cảm", "18+", "sex", "kích dục", "bán hàng đa cấp",
];
// Kiểm tra một chuỗi có chứa từ khóa vi phạm hay không → trả về từ khóa trùng hoặc null
function detectViolation(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const kw of VIOLATION_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

// GET /api/admin/menu-items — list món đối tác + auto-flag vi phạm
// ?q= tìm kiếm theo tên/mô tả · ?partner= partnerId · ?violation=1|0 · ?page=&limit=
app.get("/api/admin/menu-items", adminAuth, async (req, res) => {
  try {
    const { q, violation, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (q) filter.$or = [{ name: new RegExp(q, "i") }, { description: new RegExp(q, "i") }, { category: new RegExp(q, "i") }];
    if (req.query.partner) filter.partnerId = req.query.partner;
    if (violation === "1") filter.violationKeyword = { $ne: null };
    if (violation === "0") filter.violationKeyword = { $eq: null };

    const [total, items] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit)).lean(),
    ]);

    // Map partnerId → thông tin quán + nạp flag vi phạm động
    const partnerIds = [...new Set(items.map(i => String(i.partnerId)).filter(Boolean))];
    const partners = await FoodPartner.find({ _id: { $in: partnerIds } }).select("bizName phone address status blockedUntil").lean();
    const pmap = Object.fromEntries(partners.map(p => [String(p._id), p]));

    const now = Date.now();
    const data = items.map(i => {
      const p = pmap[String(i.partnerId)] || null;
      const blocked = !!(p && p.blockedUntil && new Date(p.blockedUntil).getTime() > now);
      let flag = i.violationKeyword || null;
      if (!flag) flag = detectViolation(`${i.name} ${i.description} ${i.category}`);
      return {
        _id: i._id,
        name: i.name,
        description: i.description,
        price: i.price,
        image: i.image,
        category: i.category,
        available: i.available,
        sold: i.sold,
        createdAt: i.createdAt,
        violationKeyword: flag,
        partner: p ? { _id: p._id, bizName: p.bizName, phone: p.phone, address: p.address, blocked, blockedUntil: p.blockedUntil } : null,
      };
    });

    res.json({ success: true, total, page: Number(page), limit: Number(limit), data });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/menu-items/:id/block — Ẩn món + block quán 24h + popup cảnh báo
// Body: { reason? } — tự động thêm lý do vi phạm chính sách nếu có
app.post("/api/admin/menu-items/:id/block", adminAuth, async (req, res) => {
  try {
    const item = await Product.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: "Không tìm thấy món" });

    // Xác định lý do: từ khóa vi phạm tự phát hiện hoặc lý do admin nhập
    const kw = detectViolation(`${item.name} ${item.description} ${item.category}`);
    const reason = (req.body && req.body.reason && String(req.body.reason).trim())
      || (kw ? `Đăng dịch vụ vi phạm chính sách sử dụng ("${kw}")` : "Vi phạm chính sách sử dụng");

    // 1) Ẩn món khỏi menu
    await Product.findByIdAndUpdate(item._id, { available: false, violationKeyword: kw || item.violationKeyword || "blocked" });

    // 2) Block quán 24h
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const partner = await FoodPartner.findByIdAndUpdate(
      item.partnerId,
      { blockedUntil: until, blockReason: reason, blockViolation: item.name },
      { new: true }
    );

    // 3) Popup cảnh báo realtime tới quán (room partner_<id>)
    const inst = req.io || global._io;
    if (inst) {
      inst.to(`partner_${item.partnerId}`).emit("partner_blocked", {
        until: until.getTime(),
        hours: 24,
        reason,
        violation: item.name,
      });
      // Thông báo live khi menu của quán bị cập nhật (khách đang mở)
      inst.to(`customer_broadcast`).emit("menu_updated", { partnerId: String(item.partnerId), productId: String(item._id), available: false });
    }

    // 4) Ghi notification + new_notification tới quán
    await notifyUser("partner", item.partnerId, {
      type: "block",
      title: "🚫 Cảnh báo vi phạm — đã khóa quán 24h",
      body: `Quán bị khóa 24 giờ vì món "${item.name}" vi phạm chính sách sử dụng (${reason}). Hãy gỡ/gỡ các dịch vụ không phù hợp.`,
      ref: String(item._id),
      refModule: "food",
    });

    if (partner) {
      const expiresIn = Math.round((until.getTime() - Date.now()) / (60 * 60 * 1000));
      res.json({ success: true, message: `Đã ẩn món & khóa quán ${expiresIn} giờ`, itemId: item._id, until: until.getTime(), reason, partner: partner.bizName });
    } else {
      res.json({ success: true, message: "Đã ẩn món (không tìm thấy quán)", itemId: item._id });
    }
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/partners/:id/unblock — Bỏ/chủ động mở khóa quán (dùng khi admin thấy nhầm)
app.post("/api/admin/partners/:id/unblock", adminAuth, async (req, res) => {
  try {
    const partner = await FoodPartner.findByIdAndUpdate(
      req.params.id,
      { $unset: { blockedUntil: 1, blockReason: 1, blockViolation: 1 } },
      { new: true }
    );
    if (!partner) return res.status(404).json({ success: false, message: "Không tìm thấy quán" });
    const inst = req.io || global._io;
    if (inst) inst.to(`partner_${partner._id}`).emit("partner_unblocked", { reason: req.body?.reason || "" });
    res.json({ success: true, message: "Đã mở khóa quán", partner: { _id: partner._id, bizName: partner.bizName } });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/menu-items/:id/unblock — Bỏ chặn 1 món (giữ quán, chỉ bật lại món)
app.post("/api/admin/menu-items/:id/unblock", adminAuth, async (req, res) => {
  try {
    await Product.findByIdAndUpdate(req.params.id, { available: true, $unset: { violationKeyword: 1 } });
    const item = await Product.findById(req.params.id).lean();
    const inst = req.io || global._io;
    if (inst && item) inst.to(`customer_broadcast`).emit("menu_updated", { partnerId: String(item.partnerId), productId: String(req.params.id), available: true });
    res.json({ success: true, message: "Đã bật lại món" });
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

req.session.userId    = user._id;
    req.session.userPhone = user.phone;
    req.session.role      = user.role || 'customer';
    pruneSessionRoles(req, 'user');
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
      [GiatLa,'giat_la'],[GiupViec,'giup_viec'],
      [ChinaShop,'china_shop'],[FoodPartner,'food_partner'],
    ]) {
      const p = await Model.findOne({ email: email.toLowerCase(), status: { $ne: "rejected" } });
      if (p) { found = p; module = mod; break; }
    }
    if (!found) return res.status(404).json({ success: false, message: "Email chưa đăng ký đối tác" });
    req.session.userPhone    = found.phone;
    req.session.partnerId     = found._id;
    req.session.partnerModule = module;
    req.session.role        = "partner";
    pruneSessionRoles(req, 'partner');
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
    req.session.shipperId  = shipper._id;
    req.session.userPhone  = shipper.phone;
    req.session.role       = "shipper";
    pruneSessionRoles(req, 'shipper');
    await new Promise((res, rej) => req.session.save(e => e ? rej(e) : res()));
    res.json({ success: true, shipper: { _id: shipper._id, fullName: shipper.fullName, phone: shipper.phone, vehiclePlate: shipper.vehiclePlate, avatar: shipper.avatar || shipper.documents?.selfie || null, status: shipper.status } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});




// ══════════════════════════════════════════════════════════════
//  VÍ CRABOR — WALLET ENDPOINTS
// ══════════════════════════════════════════════════════════════

// Determine owner from session
function getWalletOwner(req) {
  const role = req.session.role;
  if (role === 'shipper' && req.session.shipperId) return { id: req.session.shipperId, type: 'shipper' };
  if ((role === 'user' || role === 'customer') && req.session.userId) return { id: req.session.userId, type: 'user' };
  if (role === 'partner' && req.session.partnerId) return { id: req.session.partnerId, type: 'partner' };
  if (req.session.shipperId) return { id: req.session.shipperId, type: 'shipper' };
  if (req.session.userId)    return { id: req.session.userId,    type: 'user' };
  if (req.session.partnerId) return { id: req.session.partnerId, type: 'partner' };
  return null;
}

// Giữ đúng 1 role duy nhất trong session để tránh nhầm lẫn ví giữa 3 app
// (1 SĐT đăng ký cả customer + shipper + partner dùng chung cookie → session cũ không được giữ role khác)
function pruneSessionRoles(req, keepRole) {
  if (keepRole !== 'shipper') delete req.session.shipperId;
  if (keepRole !== 'user')    delete req.session.userId;
  if (keepRole !== 'partner') delete req.session.partnerId;
  if (keepRole !== 'admin')   delete req.session.adminId;
}

// GET /api/notifications/my — Danh sách thông báo của owner (shipper/partner/user)
app.get("/api/notifications/my", async (req, res) => {
  try {
    const owner = getWalletOwner(req);
    if (!owner) return res.status(401).json({ success: false });
    const notifs = await Notification.find({ ownerId: owner.id, ownerType: owner.type }).sort({ createdAt: -1 }).limit(100).lean();
    const unread = notifs.filter(n => !n.read).length;
    res.json({ success: true, notifications: notifs, unread });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/notifications/read — Đánh dấu đã đọc (1 hoặc tất cả)
app.post("/api/notifications/read", async (req, res) => {
  try {
    const owner = getWalletOwner(req);
    if (!owner) return res.status(401).json({ success: false });
    const { id } = req.body || {};
    if (id) await Notification.updateOne({ _id: id, ownerId: owner.id, ownerType: owner.type }, { $set: { read: true } });
    else await Notification.updateMany({ ownerId: owner.id, ownerType: owner.type, read: false }, { $set: { read: true } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/notifications/unread-count — Số thông báo chưa đọc (cho badge chuông)
app.get("/api/notifications/unread-count", async (req, res) => {
  try {
    const owner = getWalletOwner(req);
    if (!owner) return res.json({ success: true, count: 0 });
    const count = await Notification.countDocuments({ ownerId: owner.id, ownerType: owner.type, read: false });
    res.json({ success: true, count });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/wallet — số dư + lịch sử
app.get("/api/wallet", async (req, res) => {
  try {
    const owner = getWalletOwner(req);
    if (!owner) return res.status(401).json({ success:false });
    const Model = owner.type==='user' ? User : owner.type==='shipper' ? Shipper
               : FoodPartner;
    const doc = await Model.findById(owner.id).select('walletBalance walletEarned fullName phone');
    if (!doc) return res.status(404).json({ success:false });
    const txs = await WalletTx.find({ ownerId: owner.id }).sort({ createdAt:-1 }).limit(50);
    res.json({ success:true, balance: doc.walletBalance||0, earned: doc.walletEarned||0, transactions: withTxDescription(txs) });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/wallet/shipper — shipper dùng session khác
app.get("/api/wallet/shipper", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.shipperId && !req.session.userId) return res.status(401).json({ success:false });
    let shipper = null;
    if (req.session.shipperId) {
      shipper = await Shipper.findById(req.session.shipperId).select('walletBalance walletEarned _id totalEarnings totalOrders fee feeStatus plan');
    } else {
      // Legacy: tìm qua userId
      shipper = await Shipper.findOne({ _id: req.session.userId }).select('walletBalance walletEarned _id totalEarnings totalOrders fee feeStatus plan');
      if (!shipper) {
        const user = await User.findById(req.session.userId).select('phone');
        if (user) shipper = await Shipper.findOne({ phone: user.phone }).select('walletBalance walletEarned _id totalEarnings totalOrders fee feeStatus plan');
      }
    }
    if (!shipper) return res.status(404).json({ success:false });
    const txs = await WalletTx.find({ ownerId: shipper._id }).sort({ createdAt:-1 }).limit(50);
        // Calculate today/week/month earnings
    const now = new Date();
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const weekStart = new Date(now - 7*24*3600*1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const [todayOrders, weekOrders, monthOrders, pendingTx] = await Promise.all([
      Order.find({ shipperId: shipper._id, status: "delivered", deliveredAt: { $gte: todayStart } }).select("shipFee deliveryFee module total discount voucherShipperBear").lean(),
      Order.find({ shipperId: shipper._id, status: "delivered", deliveredAt: { $gte: weekStart } }).select("shipFee deliveryFee module total discount voucherShipperBear").lean(),
      Order.find({ shipperId: shipper._id, status: "delivered", deliveredAt: { $gte: monthStart } }).select("shipFee deliveryFee module total discount voucherShipperBear").lean(),
      WalletQueue.find({ recipientId: shipper._id, recipientType: "shipper", status: "pending" }).lean(),
    ]);
    
    const calcEarnings = (orders) => orders.reduce((s,o) => s + shipperOrderEarnNet(o), 0);
    const todayEarnings = calcEarnings(todayOrders);
    const weekEarnings = calcEarnings(weekOrders);
    const monthEarnings = calcEarnings(monthOrders);
    const pending = pendingTx.reduce((s,t) => s + (t.amount||0), 0);
    
    const { totalOrders: allTimeOrders, todayOrders: todayCount } = await countShipperCompletedOrders(shipper._id);
    
    res.json({ success:true, balance: shipper.walletBalance||0, earned: shipper.walletEarned||0, pending, todayEarnings, weekEarnings, monthEarnings, totalEarnings: shipper.totalEarnings||0, totalOrders: allTimeOrders, todayOrders: todayCount, fee: shipper.fee, feeStatus: shipper.feeStatus, plan: shipper.plan, transactions: withTxDescription(txs) });
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
    // Persist yêu cầu rút tiền để admin duyệt
    await WithdrawRequest.create({
      ownerId: owner.id, ownerType: owner.type, amount: amt,
      bankName, accountNo, accountName, status: 'pending',
    });
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
// Thanh toán: SePay QR (KienLongBank)
// ══════════════════════════════════════════════════════════════

// GET /api/bnpl/eligibility
app.get("/api/bnpl/eligibility", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.userId) return res.status(401).json({ success:false });
    const user = await User.findById(req.session.userId).select('totalSpent totalOrders isAdmin googleId emailVerified creditBnplEnabled creditLoanEnabled trustScore cancelCount bnplOnTimePaid bnplLateCount bnplActivationStatus');
    if (!user) return res.status(404).json({ success:false });
    const idn = identitySummary(user);
    // Đặc quyền: admin hoặc user được admin "Kích BNPL" (bypass) bỏ qua mọi cổng chặn
    const special = user.isAdmin || user.creditBnplEnabled;
    // BẮT BUỘC xác thực Google trước khi mở Ví Trả Sau — chỉ áp dụng cho luồng tự đăng ký thường
    if (!special && !idn.googleVerified) {
      return res.json({ success:true, eligible:false, limit:0, spent: user.totalSpent||0,
        orderCount: user.totalOrders || 0, usedThisMonth:0, available:0,
        trustScore: user.trustScore ?? 60, cancelLocked: isCancelLocked(user), onTimePaid: user.bnplOnTimePaid||0,
        requireGoogleVerify: true, ...idn,
        message: "Xác thực danh tính qua Google để mở Ví Trả Sau (đảm bảo email/SĐT thật)." });
    }
    // Admin lu�n �? �i?u ki?n; �i?u ki?n m? kho�: t?ng chi ti�u ? 5.000.000�
    // Điều kiện: admin/creditBnplEnabled đặc quyền; còn lại phải MỞ KHÓA (ký hợp đồng) + đủ 5tr + điểm tin cậy ≥ 50 + không "hay hủy đơn"
    const spent       = user.totalSpent || 0;
    const trustScore  = user.trustScore ?? 60;
    const onTimePaid  = user.bnplOnTimePaid || 0;
    const cancelLocked= isCancelLocked(user);
    const activated   = user.isAdmin || user.creditBnplEnabled || user.bnplActivationStatus === 'approved';
    const canGrant    = spent >= 5000000 && trustScore >= TRUST_MIN_UNLOCK && !cancelLocked;
    let eligible      = false;
    let limit         = 0;
    let lockReason    = null;
    if (activated) {
      eligible = special || (spent >= 5000000 && trustScore >= TRUST_MIN_UNLOCK && !cancelLocked);
      limit    = eligible ? getBnplLimit(onTimePaid) : 0;
      if (!eligible) {
        if (cancelLocked) lockReason = 'Bạn đã hủy quá nhiều đơn hàng nên bị khóa Ví Trả Sau, dù có đủ 5.000.000đ chi tiêu.';
        else if (spent < 5000000) lockReason = `Cần tổng chi tiêu tối thiểu 5.000.000đ để dùng Ví Trả Sau (hiện tại: ${spent.toLocaleString('vi-VN')}đ)`;
        else if (trustScore < TRUST_MIN_UNLOCK) lockReason = `Điểm tin cậy chưa đạt (${trustScore}/100, cần ≥ ${TRUST_MIN_UNLOCK}). Đặt đơn và thanh toán đúng hạn để tăng điểm.`;
      }
    } else {
      if (user.bnplActivationStatus === 'pending') lockReason = 'Hồ sơ mở khóa Ví Trả Sau đang chờ admin duyệt.';
      else if (user.bnplActivationStatus === 'rejected') lockReason = 'Hồ sơ mở khóa Ví Trả Sau bị từ chối. Vui lòng liên hệ hỗ trợ.';
      else lockReason = 'Đăng ký mở khóa Ví Trả Sau (ký hợp đồng) để bắt đầu dùng.';
    }
    const month      = getCurrentBillingMonth();
    const txs        = await BNPLTx.find({ userId:req.session.userId, billingMonth:month, status:{$in:['pending_bill','billed']} });
    const usedThisMonth = txs.reduce((s,t)=>s+t.amount,0);
    const available  = Math.max(0, limit - usedThisMonth);
    const unpaid     = await BNPLInvoice.find({ userId:req.session.userId, status:{$in:['issued','overdue','installment']} }).sort({dueDate:1});
    const currentLimitIndex = Math.max(0, BNPL_LIMIT_TIERS.findIndex(t => getBnplLimit(onTimePaid) === t.limit));
    const nextLimit = BNPL_LIMIT_TIERS[currentLimitIndex+1] || null;
    // KHÓA Ví Trả Sau khi còn hóa đơn quá hạn — nhưng BYPASS (special) không bị khóa cứng, vẫn hiện eligible để admin test
    const bnplLocked = await hasOverdueBnpl(req.session.userId);
    if (bnplLocked && !special) {
      return res.json({ success:true, eligible:false, limit:0, spent, orderCount: user.totalOrders || 0, usedThisMonth, available:0,
        trustScore, cancelLocked, onTimePaid, activationStatus: (user.bnplActivationStatus||'none'), canApply:false, tiers: BNPL_LIMIT_TIERS, currentLimitIndex, nextLimit,
        bnplLocked:true, unpaidInvoices: unpaid,
        message:'Ví Trả Sau đã bị khóa do còn hóa đơn quá hạn chưa thanh toán. Vui lòng thanh toán để mở khóa.' });
    }
    // Nếu special mà vẫn overdue, vẫn trả eligible:true nhưng kèm cảnh báo bnplLocked để UI hiển thị
    if (bnplLocked && special) {
      return res.json({ success:true, eligible, limit, spent, orderCount: user.totalOrders || 0, usedThisMonth, available,
        trustScore, cancelLocked, onTimePaid, activationStatus: (user.bnplActivationStatus||'none'), canApply: (!activated && canGrant), tiers: BNPL_LIMIT_TIERS, currentLimitIndex, nextLimit,
        bnplLocked:true, unpaidInvoices: unpaid,
        message: eligible ? `Hạn mức: ${limit.toLocaleString('vi-VN')}đ | Còn: ${available.toLocaleString('vi-VN')}đ (có ${unpaid.length} hóa đơn quá hạn)` : (lockReason || 'Chưa đủ điều kiện mở Ví Trả Sau'),
        unpaidInvoices: unpaid });
    }
    res.json({ success:true, eligible, limit, spent, orderCount: user.totalOrders || 0, usedThisMonth, available,
      trustScore, cancelLocked, onTimePaid, activationStatus: (user.bnplActivationStatus||'none'), canApply: (!activated && canGrant), tiers: BNPL_LIMIT_TIERS, currentLimitIndex, nextLimit,
      message: eligible
        ? `Hạn mức: ${limit.toLocaleString('vi-VN')}đ | Còn: ${available.toLocaleString('vi-VN')}đ`
        : (lockReason || 'Chưa đủ điều kiện mở Ví Trả Sau'),
      unpaidInvoices: unpaid, bnplLocked:false });
  } catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// POST /api/bnpl/use — ghi nhận giao dịch trả sau
app.post("/api/bnpl/use", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({success:false});
    // HARD GATE: phải đã xác thực Google
    const _me = await User.findById(req.session.userId).select('googleId emailVerified');
    if (!identitySummary(_me).googleVerified)
      return res.status(403).json({ success:false, requireGoogleVerify:true, message:'Cần xác thực danh tính qua Google trước khi dùng Ví Trả Sau' });
    const {orderId, amount, serviceType='food'} = req.body;
    const amt = Number(amount);
    if (!amt||amt<=0) return res.status(400).json({success:false,message:'Số tiền không hợp lệ'});
    const fee = bnplFeeOf(amt);
    const user = await User.findById(req.session.userId).select('totalSpent creditBnplEnabled isAdmin trustScore cancelCount bnplOnTimePaid bnplActivationStatus');
    // KHÓA: còn hóa đơn quá hạn → chặn mọi giao dịch trả sau
    if (await hasOverdueBnpl(req.session.userId))
      return res.status(403).json({success:false, bnplLocked:true, message:'Ví Trả Sau đã bị khóa do còn hóa đơn quá hạn. Vui lòng thanh toán để mở khóa.'});
    // HARD GATE: phải đã MỞ KHÓA + đủ 5tr chi tiêu + điểm tin cậy ≥ 50 + không "hay hủy đơn"
    const special = user?.isAdmin || user?.creditBnplEnabled;
    const activated = user?.bnplActivationStatus === 'approved';
    if (!(special || activated))
      return res.status(403).json({success:false, message:'Bạn chưa mở khóa Ví Trả Sau. Vui lòng đăng ký mở khóa (ký hợp đồng) trong mục Tài chính.'});
    if (!special && (((user?.totalSpent||0) < 5000000) || ((user?.trustScore ?? 60) < TRUST_MIN_UNLOCK) || isCancelLocked(user)))
      return res.status(403).json({success:false, message:'Chưa đủ điều kiện dùng Ví Trả Sau (cần ≥5.000.000đ chi tiêu, điểm tin cậy ≥ 50 và không hủy đơn nhiều).'});
    const limit = special ? Math.max(2000000, getBnplLimit(user?.bnplOnTimePaid||0)) : getBnplLimit(user?.bnplOnTimePaid||0);
    if (!limit) return res.status(403).json({success:false,message:'Chưa đủ điều kiện dùng Ví Trả Sau.'});
    const month = getCurrentBillingMonth();
    const txs = await BNPLTx.find({userId:req.session.userId, billingMonth:month, status:{$in:['pending_bill','billed']}});
    const used = txs.reduce((s,t)=>s+t.amount,0);
    if (used+amt+fee>limit) return res.status(400).json({success:false,message:`Vượt hạn mức (còn ${(limit-used).toLocaleString('vi-VN')}đ)`});
    const tx = await BNPLTx.create({userId:req.session.userId, orderId, baseAmount:amt, fee, amount:amt+fee, serviceType, billingMonth:month});
    res.json({success:true, data:tx, message:`Trả sau ${amt.toLocaleString('vi-VN')}đ (gồm phí ${fee.toLocaleString('vi-VN')}đ). Thanh toán trước ngày 15/${month.slice(5)}/${month.slice(0,4)}`});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── MỞ KHÓA VÍ TRẢ SAU (BNPL activation) — ký hợp đồng để dùng ──
// POST /api/bnpl/activation — đăng ký mở khóa Ví Trả Sau (gửi hồ sơ chờ admin duyệt)
app.post("/api/bnpl/activation", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.userId) return res.status(401).json({ success:false });
    // HARD GATE: phải đã xác thực Google — bypass cho admin/special
    const _me = await User.findById(req.session.userId).select('googleId emailVerified creditBnplEnabled isAdmin');
    const _specialAct = _me?.isAdmin || _me?.creditBnplEnabled;
    if (!_specialAct && !identitySummary(_me).googleVerified)
      return res.status(403).json({ success:false, requireGoogleVerify:true, message:'Cần xác thực danh tính qua Google trước khi mở khóa Ví Trả Sau' });
    const user = await User.findById(req.session.userId).select('totalSpent trustScore cancelCount transactionPassword bnplActivationStatus bnplOnTimePaid');
    if (user?.bnplActivationStatus === 'approved')
      return res.status(400).json({ success:false, message:'Ví Trả Sau đã được mở khóa.' });
    // Điều kiện: đủ 5tr chi tiêu + điểm tin cậy ≥ 50 + không "hay hủy đơn"
    if ((user?.totalSpent||0) < 5000000)
      return res.status(403).json({ success:false, message:'Cần tổng chi tiêu tối thiểu 5.000.000đ để mở khóa Ví Trả Sau.' });
    if ((user?.trustScore ?? 60) < TRUST_MIN_UNLOCK)
      return res.status(403).json({ success:false, message:`Điểm tin cậy chưa đạt (${user?.trustScore ?? 60}/100, cần ≥ ${TRUST_MIN_UNLOCK}).` });
    if (isCancelLocked(user))
      return res.status(403).json({ success:false, message:'Bạn đã hủy quá nhiều đơn hàng nên bị khóa mở khóa Ví Trả Sau.' });
    if (await hasOverdueBnpl(req.session.userId))
      return res.status(403).json({ success:false, bnplLocked:true, message:'Còn hóa đơn Ví Trả Sau quá hạn chưa thanh toán, không thể mở khóa/đăng ký.' });
    const { transactionPassword, acceptContract, facePhoto, cccdFront, cccdBack, emergencyContact } = req.body;
    // Thẩm định bắt buộc: khuôn mặt + CCCD 2 mặt + liên hệ phụ
    if (!facePhoto || !cccdFront || !cccdBack) return res.status(400).json({ success:false, message:'Cần đủ ảnh khuôn mặt và 2 mặt CCCD để thẩm định' });
    if (!emergencyContact?.name || !emergencyContact?.phone || !emergencyContact?.relation) return res.status(400).json({ success:false, message:'Cần đủ thông tin liên hệ phụ (tên, SĐT, quan hệ)' });
    if (!/^0[0-9]{9}$/.test(String(emergencyContact.phone).replace(/\s/g,''))) return res.status(400).json({ success:false, message:'SĐT liên hệ phụ không hợp lệ (0xxxxxxxxx)' });
    // Xác thực mật khẩu giao dịch CRABOR
    if (!user?.transactionPassword)
      return res.status(400).json({ success:false, requireTransactionPassword:true, message:'Bạn chưa đặt mật khẩu giao dịch. Vui lòng đặt mật khẩu giao dịch trước khi mở khóa.' });
    if (!transactionPassword)
      return res.status(400).json({ success:false, message:'Nhập mật khẩu giao dịch' });
    const bcrypt = require("bcryptjs");
    const pwOk = await bcrypt.compare(transactionPassword, user.transactionPassword);
    if (!pwOk)
      return res.status(400).json({ success:false, message:'Mật khẩu giao dịch không đúng' });
    if (!acceptContract)
      return res.status(400).json({ success:false, message:'Bạn cần đồng ý với điều khoản hợp đồng Ví Trả Sau.' });
    await User.findByIdAndUpdate(req.session.userId, {
      bnplActivationStatus: 'pending',
      kyc: {
        selfie: facePhoto, cccdFront, cccdBack,
        emergencyContact,
        submittedAt: new Date(),
      },
      kycStatus: 'pending',
    });
    req.io.to('admin').emit('newBnplActivation', { userId: req.session.userId });
    res.json({ success:true, message:'Đã gửi hồ sơ mở khóa Ví Trả Sau. Admin sẽ xét duyệt trong 24h.' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/bnpl/activation — trạng thái mở khóa Ví Trả Sau
app.get("/api/bnpl/activation", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const user = await User.findById(req.session.userId).select('bnplActivationStatus trustScore totalSpent cancelCount bnplOnTimePaid creditBnplEnabled').lean();
    if (!user) return res.status(404).json({ success:false });
    res.json({ success:true, status: user.bnplActivationStatus || 'none', creditBnplEnabled: !!user.creditBnplEnabled, trustScore: user.trustScore ?? 60, totalSpent: user.totalSpent||0, cancelCount: user.cancelCount||0, bnplOnTimePaid: user.bnplOnTimePaid||0, canApply: (user.totalSpent||0) >= 5000000 && (user.trustScore ?? 60) >= TRUST_MIN_UNLOCK && !isCancelLocked(user) && (user.bnplActivationStatus||'none') !== 'approved' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/admin/bnpl/activations — Admin: danh sách hồ sơ mở khóa BNPL
app.get("/api/admin/bnpl/activations", adminAuth, async (req,res) => {
  try {
    const users = await User.find({ bnplActivationStatus: { $in: ['pending','approved','rejected'] } })
      .select('phone email fullName totalSpent totalOrders trustScore cancelCount bnplActivationStatus bnplOnTimePaid').sort({updatedAt:-1}).limit(100).lean();
    res.json({ success:true, data: users });
  } catch(e){ res.status(500).json({ success:false, message:e.message }); }
});

// PATCH /api/admin/bnpl/activation/:userId — Admin duyệt/từ chối hồ sơ mở khóa BNPL
app.patch("/api/admin/bnpl/activation/:userId", adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({success:false, message:'Trạng thái không hợp lệ'});
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success:false });
    await User.findByIdAndUpdate(user._id, { bnplActivationStatus: status });
    req.io.to(`customer_${user._id}`).emit('bnplActivationUpdated', { status });
    res.json({ success:true, message: status === 'approved' ? 'Đã duyệt mở khóa Ví Trả Sau' : 'Đã từ chối hồ sơ mở khóa Ví Trả Sau' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// GET /api/bnpl/summary — tổng kết tháng + hóa đơn
app.get("/api/bnpl/summary", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({success:false});
    const month = getCurrentBillingMonth();
    // Tự động chốt bill nếu có pending mà chưa có invoice CHƯA TRẢ (issued/overdue/installment)
    // FIX: trước đây tìm bất kỳ invoice (kể cả đã paid) nên khi tháng đã có invoice paid,
    // các giao dịch bnpl mới bị kẹt pending_bill mãi không lên bill.
    const pendingCheck = await BNPLTx.find({userId:req.session.userId, billingMonth:month, status:'pending_bill'}).limit(1).lean();
    if(pendingCheck.length){
      const openInv = await BNPLInvoice.findOne({userId:req.session.userId, billingMonth:month, status:{$in:['issued','overdue','installment']}}).lean();
      if(!openInv){
        try{ await createBNPLInvoicesForMonth(month); }catch(e){ console.error('[BNPL auto-bill]',e.message); }
      }
    }
    const pending = await BNPLTx.find({userId:req.session.userId, billingMonth:month, status:'pending_bill'}).sort({createdAt:-1});
    const total = pending.reduce((s,t)=>s+t.amount,0);
    const invoices = await BNPLInvoice.find({userId:req.session.userId}).sort({createdAt:-1}).limit(12).lean();
    // FIX: kèm chi tiết từng giao dịch (BNPLTx) của mỗi hóa đơn để app hiển thị "đã thanh toán cho gì"
    for (const inv of invoices) {
      inv.txs = await BNPLTx.find({ invoiceId: inv._id }).sort({ createdAt: 1 }).lean();
      inv.nextDueDate = getTermDueDate(inv);
      // Phí phạt động: 1% mỗi ngày trên tổng hóa đơn nếu quá hạn (để app/admin hiển thị đúng)
      inv.lateFee = bnplPenaltyOf(inv);
    }
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
    const lateFee = late ? bnplPenaltyOf(inv, now) : 0;
    // Số tiền phải trả lần này: trả góp → chỉ KỲ HIỆN TẠI; không trả góp → toàn bộ bill
    const isInstall = inv.isInstallment && inv.status === 'installment';
    let dueNow = inv.totalAmount + (inv.bnplFee || 0) + (inv.serviceFee || 0) + inv.installFee + lateFee;
    if (isInstall) {
      const perTerm = inv.perTerm || Math.ceil((inv.totalAmount + (inv.bnplFee || 0) + (inv.serviceFee || 0) + inv.installFee)/(inv.installTerms||1));
      dueNow = Math.max(0, Math.min(perTerm, inv.finalAmount || 0));
    }
    const sePayRef = 'BNPL'+inv._id.toString().slice(-8).toUpperCase();
    await BNPLInvoice.findByIdAndUpdate(inv._id,{lateFee,sePayRef,paymentAmount:dueNow});
    // finalAmount trong DB ACCOUNT chỉ lưu toàn bộ số nợ còn; respond trả dueNow là số cần trả lần này
    res.json({
      success:true, amount: dueNow, finalAmount: dueNow, isInstallment: isInstall, lateFee, sePayRef,
      nextDueDate: getTermDueDate(inv),
      qrUrl: sepayQrUrl(dueNow, sePayRef),
      bankName: SEPAY_CONFIG.bankName, bankCode: SEPAY_CONFIG.bankCode,
      accountNo: SEPAY_CONFIG.accountNo, accountName: SEPAY_CONFIG.accountName,
      message:`Chuyển khoản ${dueNow.toLocaleString('vi-VN')}đ · Nội dung: ${sePayRef}`,
      note: late ? `⚠️ Quá hạn: +30.000đ phí trễ` : (isInstall ? `✅ Thanh toán kỳ ${(inv.installPaid||0)+1}/${inv.installTerms||1} trả góp` : `✅ Thanh toán đúng hạn`),
    });
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// POST /api/bnpl/invoice/:id/installment — chuyển trả góp (phí 10%/tháng của chi phí gốc)
app.post("/api/bnpl/invoice/:id/installment", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({success:false});
    const {terms=3} = req.body;
    if (![3,6,12].includes(Number(terms)))
      return res.status(400).json({success:false,message:'Kỳ hạn: 3, 6 hoặc 12 tháng'});
    const inv = await BNPLInvoice.findOne({_id:req.params.id, userId:req.session.userId, status:{$in:['issued','overdue']}});
    if (!inv) return res.status(404).json({success:false,message:'Không tìm thấy hoặc không đủ điều kiện'});
    // Phí trả góp = 10% chi phí gốc cho MỖI tháng (không phải 10% một lần)
    const installFee = Math.round(inv.totalAmount * 0.10 * Number(terms));
    const finalAmount = inv.totalAmount + (inv.bnplFee || 0) + (inv.serviceFee || 0) + installFee;
    const perTerm = Math.ceil(finalAmount/Number(terms));
    await BNPLInvoice.findByIdAndUpdate(inv._id,{isInstallment:true,installTerms:Number(terms),installFee,finalAmount,perTerm,installPaid:0,status:'installment'});
    res.json({success:true, installFee, finalAmount, perTerm, terms:Number(terms),
      message:`Trả góp ${terms} kỳ. Phí 10%/tháng: ${installFee.toLocaleString('vi-VN')}đ. Mỗi kỳ: ${perTerm.toLocaleString('vi-VN')}đ`});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// POST /api/bnpl/invoice/:id/confirm-paid — admin xác nhận đã nhận tiền
app.post("/api/bnpl/invoice/:id/confirm-paid", adminAuth, async (req,res) => {
  try {
    const inv = await BNPLInvoice.findByIdAndUpdate(req.params.id,{status:'paid',paidAt:new Date()},{new:true});
    if (!inv) return res.status(404).json({success:false});
    await BNPLTx.updateMany({invoiceId:inv._id},{status:'paid'});
    await User.findByIdAndUpdate(inv.userId,{$inc:{loyaltyPts:Math.floor(inv.totalAmount/10)}});
    await applyBnplPaidTrust(inv.userId, inv); // cộng điểm tin cậy (đúng hạn/trễ)
    req.io.to('admin').emit('bnplPaid',{invoiceId:inv._id,amount:inv.finalAmount});
    res.json({success:true});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── BNPL BILLING — tạo hóa đơn từ pending_bill ──────────
async function createBNPLInvoicesForMonth(billingMonth){
  const months = billingMonth ? [billingMonth] : [getCurrentBillingMonth()];
  for(const month of months){
    const pendingByUser = await BNPLTx.aggregate([
      {$match:{billingMonth:month, status:'pending_bill'}},
      {$group:{_id:'$userId', base:{ $sum:'$baseAmount' }, fee:{ $sum:'$fee' }, total:{ $sum:'$amount' }, txIds:{ $push:'$_id' }}}
    ]);
    for(const g of pendingByUser){
      const userId=g._id;
      const base=g.base||0;
      const fee=g.fee||0;
      const total=g.total;
      const exists=await BNPLInvoice.findOne({userId, billingMonth:month, status:{$in:['issued','overdue','installment']}}).lean();
      if(exists) {
        // Nếu đã có hóa đơn chưa trả cho tháng này, cộng dồn vào hóa đơn đó
        // Phí dịch vụ cố định 30k/tháng chỉ tính MỘT lần: nếu hóa đơn chưa có serviceFee thì thêm lần đầu.
        const addService = !(exists.serviceFee > 0) ? BNPL_SERVICE_FEE : 0;
        await BNPLInvoice.updateOne({_id: exists._id}, {
          $inc: { totalAmount: base, bnplFee: fee, finalAmount: total + addService },
          $set: addService ? { serviceFee: BNPL_SERVICE_FEE } : {},
        });
        await BNPLTx.updateMany({_id:{$in:g.txIds}}, {$set:{status:'billed', invoiceId:exists._id}});
        console.log(`[BNPL] Added ${total} (fee ${fee}) to existing invoice ${exists._id} for ${userId} month ${month}`);
        continue;
      }
      // FIX race: claim từng tx pending_bill → billed với invoiceId tạm thời TRƯỚC khi tạo invoice.
      // Nếu 2 tiến trình cùng gọi, chỉ 1 thắng ở updateOne này (filter status:'pending_bill'),
      // tiến trình kia không claim thêm được nên không tạo invoice đôi.
      const {issuedAt, dueDate}=getNextBillingDates();
      let createdInv = null;
      for (const txId of g.txIds) {
        const claim = await BNPLTx.findOneAndUpdate(
          { _id: txId, status: 'pending_bill' },
          { $set: { status: 'billed' } },
          { new: true }
        );
        if (!claim) continue; // tx đã bị tiến trình khác claim
        // Đảm bảo đã có invoice (tạo nếu là tx đầu tiên claim được)
        if (!createdInv) {
          createdInv = await BNPLInvoice.findOne({ userId, billingMonth: month, status: { $in: ['issued','overdue','installment'] } }).lean();
          if (!createdInv) {
            try {
              createdInv = await BNPLInvoice.create({
                userId, billingMonth: month, totalAmount: 0, bnplFee: 0, serviceFee: BNPL_SERVICE_FEE, finalAmount: BNPL_SERVICE_FEE,
                issuedAt, dueDate, status: 'issued', lateFee: 0, installFee: 0
              });
              console.log(`[BNPL] Created invoice ${createdInv._id} for ${userId} month ${month}`);
            } catch (dupErr) {
              // ai đó vừa tạo cùng lúc → dùng lại invoice vừa tạo
              createdInv = await BNPLInvoice.findOne({ userId, billingMonth: month, status: { $in: ['issued','overdue','installment'] } }).lean();
              if (!createdInv) throw dupErr;
            }
          }
        }
        await BNPLTx.updateOne({ _id: txId }, { $set: { invoiceId: createdInv._id } });
        await BNPLInvoice.updateOne({ _id: createdInv._id }, { $inc: { totalAmount: claim.baseAmount || 0, bnplFee: claim.fee || 0, finalAmount: claim.amount || 0 } });
      }
      if (!createdInv) {
        // không claim được tx nào (đã bị xử lý) — không tạo invoice thừa
        console.log(`[BNPL] No tx claimed for ${userId} month ${month}, skip`);
      } else {
        console.log(`[BNPL] Billed ${g.txIds.length} tx(s) into ${createdInv._id} for ${userId} month ${month} total ${total}`);
      }
    }
  }
}
// Chạy mỗi ngày 01:05 để chốt bill tháng trước
try{ cron.schedule("5 1 1 * *", async()=>{ const prev=new Date(); prev.setMonth(prev.getMonth()-1); const m=getBillingMonth(prev); await createBNPLInvoicesForMonth(m); }, {timezone:"Asia/Ho_Chi_Minh"}); }catch(e){}
// Manual trigger cho admin / test — chốt luôn tháng hiện tại
app.post("/api/admin/bnpl/billing/trigger", adminAuth, async (req,res)=>{
  try{
    const { month } = req.body || {};
    const target = month || getCurrentBillingMonth();
    await createBNPLInvoicesForMonth(target);
    res.json({success:true, month:target});
  }catch(e){ res.status(500).json({success:false, message:e.message}); }
});
// Tự động chốt khi user xem summary nếu có pending mà chưa có invoice (để test không cần đợi cron)
const _originalSummary = null; // placeholder

// CRON: auto-overdue check mỗi 6h
setInterval(async()=>{
  try {
    // Phí phạt tính theo ngày quá hạn 1% (động, không lưu cố định).
    // Chỉ đánh dấu quá hạn; việc tính phí phạt + khóa Ví Trả Sau/Vay được tính tại thời điểm truy cập.
    await BNPLInvoice.updateMany({status:'issued',dueDate:{$lt:new Date()}},{$set:{status:'overdue'}});
  } catch(e){}
}, 6*60*60*1000);

// POST /api/bnpl/invoice/:id/pay — khách tự trả hoá đơn bằng ví CRABOR | SePay QR | PayOS
app.post("/api/bnpl/invoice/:id/pay", async (req,res) => {
  try {
    if (!req.session.userId) return res.status(401).json({success:false});
    const method = String(req.body?.method || 'sepay').toLowerCase();
    if (!['wallet','sepay','payos'].includes(method))
      return res.status(400).json({success:false,message:'Phương thức không hợp lệ (wallet/sepay/payos)'});
    const inv = await BNPLInvoice.findOne({_id:req.params.id, userId:req.session.userId});
    if (!inv) return res.status(404).json({success:false,message:'Không tìm thấy hóa đơn'});
    if (inv.status==='paid') return res.status(400).json({success:false,message:'Hóa đơn đã thanh toán'});
    const now = new Date();
    const late = now > inv.dueDate && inv.status!=='installment';
    const lateFee = late ? bnplPenaltyOf(inv, now) : 0;

    // ── Số tiền phải trả lần này ─────────────────────────────
    // Nếu là trả góp: chỉ trả KỲ HIỆN TẠI (perTerm), không trả toàn bộ bill.
    // finalAmount = tổng còn nợ; kỳ cuối = phần còn lại của finalAmount.
    // Nếu payAll=true: tất toán toàn bộ phần còn lại.
    let dueNow = inv.totalAmount + (inv.bnplFee || 0) + (inv.serviceFee || 0) + inv.installFee + lateFee; // không trả góp → thanh toán toàn bộ
    let isInstall = inv.status === 'installment' && inv.isInstallment;
    const payAll = !!req.body?.payAll;
    if (isInstall) {
      if (payAll) {
        dueNow = Math.max(0, inv.finalAmount || 0);
        if (dueNow <= 0) return res.status(400).json({success:false,message:'Hóa đơn đã trả đủ các kỳ'});
      } else {
        const perTerm = inv.perTerm || Math.ceil((inv.totalAmount + (inv.bnplFee || 0) + (inv.serviceFee || 0) + inv.installFee) / (inv.installTerms || 1));
        dueNow = Math.max(0, Math.min(perTerm, inv.finalAmount || 0));
        if (dueNow <= 0) return res.status(400).json({success:false,message:'Hóa đơn đã trả đủ các kỳ'});
      }
    }

    // Lưu amount kỳ này để SePay khớp
    await BNPLInvoice.findByIdAndUpdate(inv._id,{lateFee, paymentAmount: dueNow});

    // ── Helper đánh dấu 1 kỳ đã trả (hoặc đóng hóa đơn nếu đủ) ──
    const markInstallPaid = async () => {
      if (!isInstall) {
        await BNPLInvoice.findByIdAndUpdate(inv._id,{status:'paid',paidAt:new Date()});
        await BNPLTx.updateMany({invoiceId:inv._id},{status:'paid'});
        return true; // paid hết
      }
      let newPaid, remain, done;
      if (payAll) {
        newPaid = inv.installTerms || 1;
        remain = 0;
        done = true;
      } else {
        newPaid = (inv.installPaid || 0) + 1;
        const terms = inv.installTerms || 1;
        remain = Math.max(0, (inv.finalAmount||0) - dueNow);
        done = newPaid >= terms || remain <= 0;
      }
      await BNPLInvoice.findByIdAndUpdate(inv._id,{ installPaid: newPaid, finalAmount: remain, ...(done ? {status:'paid',paidAt:new Date()} : {}) });
      if (done) await BNPLTx.updateMany({invoiceId:inv._id},{status:'paid'});
      return done;
    };

    if (method === 'wallet') {
      try {
        await walletDebit(req.session.userId, 'user', dueNow, 'bnpl_pay', inv._id.toString(), `Thanh toán kỳ trả góp ${inv.billingMonth||''} bằng ví CRABOR`);
      } catch (e) {
        return res.status(400).json({ success:false, walletInsufficient:true, message:`Ví CRABOR không đủ số dư. Cần ${dueNow.toLocaleString('vi-VN')}đ` });
      }
      const done = await markInstallPaid();
      if (done) await applyBnplPaidTrust(req.session.userId, inv); // trả hết → cập nhật điểm tin cậy
      const remainAfter = Math.max(0,(inv.finalAmount||dueNow)-dueNow);
      req.io.to('admin').emit(done ? 'bnplPaid' : 'bnplInstallPaid',{invoiceId:inv._id,amount:dueNow,remaining:remainAfter,method:'wallet'});
      return res.json({ success:true, status: done ? 'paid':'installment', method:'wallet', amount: dueNow, isInstallment: isInstall, nextDueDate: getTermDueDate(inv), installPaid: (inv.installPaid||0)+1, installTerms: inv.installTerms, remainingTerms: done ? 0 : Math.max(0, (inv.installTerms||1)-((inv.installPaid||0)+1)), remainingAmount: remainAfter, finalAmount: remainAfter, message:`Đã trả kỳ này ${dueNow.toLocaleString('vi-VN')}đ bằng ví CRABOR` + (done?' (đã trả đủ)':'') });
    }

    if (method === 'sepay') {
      const sePayRef = 'BNPL'+inv._id.toString().slice(-8).toUpperCase();
      await BNPLInvoice.findByIdAndUpdate(inv._id,{sePayRef,paymentMethod:'sepay'});
      return res.json({ success:true, status:'pending', method:'sepay', amount: dueNow, isInstallment: isInstall, finalAmount: dueNow, lateFee, sePayRef, nextDueDate: getTermDueDate(inv),
        qrUrl: sepayQrUrl(dueNow, sePayRef),
        bankName: SEPAY_CONFIG.bankName, bankCode: SEPAY_CONFIG.bankCode,
        accountNo: SEPAY_CONFIG.accountNo, accountName: SEPAY_CONFIG.accountName,
        message:`Chuyển khoản ${dueNow.toLocaleString('vi-VN')}đ · Nội dung: ${sePayRef}` });
    }

    // payos
    if (!payOS) return res.status(503).json({success:false,message:'PayOS chưa cấu hình'});
    const orderCode = Number(String(Date.now()).slice(-9));
    const paymentData = {
      orderCode,
      amount: Math.round(dueNow),
      description: ('BNPL ' + inv._id.toString().slice(-6)).replace(/[^a-zA-Z0-9 ]/g,'').slice(0,25),
      returnUrl: `${process.env.BASE_URL || "https://crabor-shipper-register.onrender.com"}/payment/success`,
      cancelUrl: `${process.env.BASE_URL || "https://crabor-shipper-register.onrender.com"}/payment/cancel`,
      items: [{ name: 'Hoa don tra sau CRABOR'.slice(0,40), quantity:1, price: Math.round(dueNow) }],
    };
    let paymentLink;
    if (typeof payOS.paymentRequests?.create === 'function') paymentLink = await payOS.paymentRequests.create(paymentData);
    else if (typeof payOS.createPaymentLink === 'function') paymentLink = await payOS.createPaymentLink(paymentData);
    else throw new Error('PayOS SDK không hợp lệ');
    const linkData = paymentLink?.data && typeof paymentLink.data === 'object' && !Array.isArray(paymentLink.data)
      ? paymentLink.data : paymentLink;
    await BNPLInvoice.findByIdAndUpdate(inv._id,{payosOrderCode:String(orderCode),paymentMethod:'payos'});
    return res.json({ success:true, status:'pending', method:'payos', amount: dueNow, isInstallment: isInstall, nextDueDate: getTermDueDate(inv), finalAmount: dueNow, orderCode,
      checkoutUrl: linkData?.checkoutUrl, qrCode: linkData?.qrCode });
  } catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// GET /api/bnpl/invoice/payos/:orderCode — poll trạng thái thanh toán PayOS của hoá đơn
app.get("/api/bnpl/invoice/payos/:orderCode", async (req,res) => {
  try {
    const inv = await BNPLInvoice.findOne({ payosOrderCode: String(req.params.orderCode) });
    if (!inv) return res.status(404).json({success:false,message:'Không tìm thấy hóa đơn'});
    if (inv.status==='paid') return res.json({success:true,status:'paid'});
    if (!payOS) return res.status(503).json({success:false});
    let info;
    if (typeof payOS.getPaymentLinkInformation === 'function') info = await payOS.getPaymentLinkInformation(req.params.orderCode);
    else if (typeof payOS.paymentRequests?.get === 'function') info = await payOS.paymentRequests.get({ id: req.params.orderCode });
    const data = info?.data && typeof info.data === 'object' ? info.data : info;
    const st = String(data?.status||'').toUpperCase();
    if (st === 'PAID') {
      if (inv.isInstallment && inv.status === 'installment') {
        const dueNow = inv.paymentAmount || inv.perTerm || Math.ceil(inv.finalAmount/(inv.installTerms||1));
        const newPaid = (inv.installPaid || 0) + 1;
        const terms = inv.installTerms || 1;
        const done = newPaid >= terms;
        const remain = Math.max(0, (inv.finalAmount||0) - dueNow);
        await BNPLInvoice.findByIdAndUpdate(inv._id,{ installPaid: newPaid, finalAmount: remain, ...(done ? {status:'paid',paidAt:new Date()} : {}) });
        if (done) { 
          await BNPLTx.updateMany({invoiceId:inv._id},{status:'paid'}); 
          await applyBnplPaidTrust(inv.userId, inv); // trả hết → cập nhật điểm tin cậy
        }
        global._io?.to('admin').emit(done ? 'bnplPaid':'bnplInstallPaid',{invoiceId:inv._id,amount:dueNow,remaining:remain,method:'payos'});
        return res.json({success:true,status: done ? 'paid':'installment'});
      }
      await BNPLInvoice.findByIdAndUpdate(inv._id,{status:'paid',paidAt:new Date()});
      await BNPLTx.updateMany({invoiceId:inv._id},{status:'paid'});
      await applyBnplPaidTrust(inv.userId, inv); // cập nhật điểm tin cậy
      global._io?.to('admin').emit('bnplPaid',{invoiceId:inv._id,amount:inv.finalAmount,method:'payos'});
      return res.json({success:true,status:'paid'});
    }
    res.json({success:true,status:'pending',payosStatus:st});
  } catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── AUTO-CANCEL: huỷ đơn quá 30 phút không được xác nhận ──
// food/laundry/cleaning: partner không xác nhận trong 30p → huỷ
// ride: 30p không tìm được tài xế → huỷ
// Hoàn tiền: chỉ hoàn về ví CRABOR nếu đơn trả bằng ví; đơn bnpl xoá giao dịch trả sau; phương thức khác không hoàn
async function refundOnAutoCancel(order) {
  try {
    const amt = order.finalTotal
      ?? order.finalPrice
      ?? Math.max(0, (order.total || order.estimatedTotal || order.price || 0)
        + (order.shipFee || 0) + (order.serviceFee || 0)
        - (order.discount || order.voucherDiscount || 0));
    if (order.paymentMethod === 'wallet' && amt > 0) {
      await walletCredit(order.customerId, 'user', amt, order.orderId, `Hoàn tiền đơn ${order.orderId} (tự động huỷ)`);
      global._io?.to(`customer_${order.customerId}`).emit('walletCredited', { amount: amt, orderId: order.orderId, message: `Hoàn ${amt.toLocaleString('vi-VN')}đ vào ví CRABOR` });
      return 'refunded_wallet';
    }
    if (order.paymentMethod === 'bnpl') {
      await BNPLTx.deleteMany({ orderId: order.orderId, status: 'pending_bill' });
      return 'bnpl_reversed';
    }
    return 'no_refund';
  } catch(e) { console.error('[AutoCancel] hoàn tiền lỗi:', e.message); return 'error'; }
}

// ── REFUND ON MANUAL CANCEL — hoàn tiền khi KHÁCH hủy đơn ──
// wallet: hoàn về ví CRABOR | bnpl pending_bill: xoá giao dịch trả sau
// bnpl billed (đã vào hóa đơn): trừ đúng invoice đó
async function refundOnCancel(order) {
  try {
    const amt = order.finalTotal
      ?? order.finalPrice
      ?? Math.max(0, (order.total || order.estimatedTotal || order.price || 0)
        + (order.shipFee || 0) + (order.serviceFee || 0)
        - (order.discount || order.voucherDiscount || 0));
    const cid = order.customerId || order.customer;
    if (!cid) return 'no_refund';

    if (order.paymentMethod === 'wallet' && amt > 0) {
      await walletCredit(cid, 'user', amt, order.orderId, `Hoàn tiền đơn ${order.orderId} (khách hủy)`);
      global._io?.to(`customer_${cid}`).emit('walletCredited', { amount: amt, orderId: order.orderId, message: `Hoàn ${amt.toLocaleString('vi-VN')}đ vào ví CRABOR (đơn đã hủy)` });
      return 'refunded_wallet';
    }

    if (order.paymentMethod === 'bnpl') {
      // Xoá giao dịch trả sau còn pending (chưa lên hóa đơn)
      const del = await BNPLTx.deleteMany({ orderId: order.orderId, status: 'pending_bill' });
      // Nếu đã billed (đã vào hóa đơn) thì trừ ra khỏi invoice
      const billedTx = await BNPLTx.find({ orderId: order.orderId, status: { $in: ['billed', 'paid'] } });
      for (const tx of billedTx) {
        if (tx.invoiceId) {
          const inv = await BNPLInvoice.findById(tx.invoiceId);
          if (inv && inv.status !== 'paid') {
            const newTotal = Math.max(0, (inv.totalAmount || 0) - (tx.baseAmount || tx.amount || 0));
            const newFee = Math.max(0, (inv.bnplFee || 0) - (tx.fee || 0));
            const newFinal = Math.max(0, (inv.finalAmount || 0) - (tx.amount || 0));
            await BNPLInvoice.updateOne({ _id: inv._id }, { $set: { totalAmount: newTotal, bnplFee: newFee, finalAmount: newFinal } });
          }
          await BNPLTx.updateOne({ _id: tx._id }, { $set: { status: 'pending_bill', invoiceId: null } });
        }
      }
      return (del.deletedCount > 0 || billedTx.length > 0) ? 'bnpl_reversed' : 'no_refund';
    }
    return 'no_refund';
  } catch(e) { console.error('[Cancel] hoàn tiền lỗi:', e.message); return 'error'; }
}

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    // Food (bảng Order): pending quá 30p chưa được partner xác nhận
    const staleOrders = await Order.find({
      module: 'food',
      status: 'pending',
      createdAt: { $lt: cutoff },
    }).limit(30);
    // Ride: pending quá 30p chưa có tài xế nhận
    const staleRides = await Order.find({
      module: 'ride',
      status: 'pending',
      shipperId: null,
      createdAt: { $lt: cutoff },
    }).limit(30);
    // Laundry (bảng riêng LaundryOrder): pending quá 30p chưa được partner xác nhận
    const staleLaundry = await LaundryOrder.find({
      status: 'pending',
      createdAt: { $lt: cutoff },
    }).limit(30);
    // Cleaning (bảng riêng CleaningOrder): pending quá 30p chưa được xác nhận
    const staleCleaning = await CleaningOrder.find({
      status: 'pending',
      createdAt: { $lt: cutoff },
    }).limit(30);

    const all = [...staleOrders, ...staleRides, ...staleLaundry, ...staleCleaning];
    for (const o of all) {
      try {
        const reason = o.module === 'ride'
          ? 'Tự động huỷ: không tìm được tài xế sau 30 phút'
          : 'Tự động huỷ: đối tác không xác nhận sau 30 phút';
        o.status = 'cancelled';
        o.cancelReason = reason;
        if (Array.isArray(o.statusHistory)) o.statusHistory.push({ status: 'cancelled', by: 'system', time: new Date(), note: reason });
        await o.save();
        const refundResult = await refundOnAutoCancel(o);
        global._io?.to(`customer_${o.customerId}`).emit('order_status_update', {
          orderId: o.orderId, status: 'cancelled',
          message: reason + (refundResult === 'refunded_wallet' ? '. Tiền đã hoàn vào ví CRABOR.' : refundResult === 'bnpl_reversed' ? '. Đã gỡ khỏi Ví Trả Sau.' : ''),
        });
        console.log(`[AutoCancel] Đã huỷ ${o.module} ${o.orderId} — ${refundResult}`);
      } catch (e) { console.error('[AutoCancel] lỗi xử lý đơn:', e.message); }
    }
  } catch (e) { console.error('[AutoCancel] cron lỗi:', e.message); }
}, 60 * 1000);

// ── RE-DISPATCH DỌN NHÀ đã gộp vào cron AutoDispatch (ping 30s, phía dưới file) ──

// GET /api/admin/cleaning-debug — chẩn đoán vì sao đơn dọn nhà không ghép được shipper
app.get("/api/admin/cleaning-debug", adminAuth, async (req, res) => {
  try {
    const total            = await Shipper.countDocuments({});
    const byStatus         = await Shipper.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    const online           = await Shipper.countDocuments({ online: true });
    const accepting        = await Shipper.countDocuments({ online: true, isAccepting: true });
    const approvedOnline   = await Shipper.countDocuments({ status: { $in: ["approved","active"] }, online: true, isAccepting: true });
    const withAcceptClean  = await Shipper.countDocuments({ "preferences.acceptCleaning": true });
    const withCleanReg     = await Shipper.countDocuments({ "preferences.cleaningRegistered": true });
    const workTypeCleaning = await Shipper.countDocuments({ workType: "cleaning" });
    const matchFull        = await Shipper.countDocuments({
      status: { $in: ["approved","active"] }, online: true, isAccepting: true,
      $or: [{ "preferences.acceptCleaning": true }, { "preferences.cleaningRegistered": true }],
    });

    const shippers = await Shipper.find({
      $or: [
        { "preferences.acceptCleaning": true },
        { "preferences.cleaningRegistered": true },
        { workType: "cleaning" },
        { online: true },
      ],
    }).select("phone fullName status online isAccepting preferences workType feeStatus identityVerified").limit(30).lean();

    const recentOrders = await CleaningOrder.find().sort({ createdAt: -1 }).limit(10)
      .select("orderId status createdAt addressLat addressLng paymentMethod paymentStatus shipperId").lean();

    // CashSettlements của các shipper liên quan — nguyên nhân âm thầm khiến shipper bị loại khỏi dispatch
    const CashSettlement = mongoose.models.CashSettlement;
    let cashSettlements = [];
    if (CashSettlement) {
      cashSettlements = await CashSettlement.find({
        $or: [
          { shipperId: { $in: shippers.map(s => s._id) } },
          { status: { $in: ["pending", "partially_paid", "overdue"] } },
        ],
      }).sort({ createdAt: -1 }).limit(20)
        .select("orderId shipperId total amountPaid status dueAt createdAt").lean();
    }
    const now = new Date();
    const cashBlockedNow = cashSettlements.filter(s =>
      ["pending","partially_paid","overdue"].includes(s.status) && s.dueAt && new Date(s.dueAt) <= now);

    res.json({ success: true, counts: {
      total, byStatus, online, accepting, approvedOnline,
      withAcceptCleaning: withAcceptClean, withCleaningRegistered: withCleanReg,
      workTypeCleaning, matchFullQuery: matchFull,
    }, shippers, recentOrders, cashSettlements, cashBlockedCount: cashBlockedNow.length });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/cleaning-orders/cancel-all — huỷ TOÀN BỘ đơn dọn nhà chưa hoàn thành (reset để test)
app.post("/api/admin/cleaning-orders/cancel-all", adminAuth, async (req, res) => {
  try {
    const r = await CleaningOrder.updateMany(
      { status: { $nin: ["completed", "cancelled"] } },
      {
        $set: { status: "cancelled" },
        $push: { statusHistory: { status: "cancelled", by: "admin", time: new Date() } },
      }
    );
    console.log(`[Cleaning] Admin reset: đã huỷ ${r.modifiedCount} đơn`);
    res.json({ success: true, cancelled: r.modifiedCount });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/cash-settlements/:id/settle — Admin xác nhận đã nhận tiền → mở khoá shipper
app.post("/api/admin/cash-settlements/:id/settle", adminAuth, async (req, res) => {
  try {
    const { note } = req.body || {};
    const CashSettlement = mongoose.models.CashSettlement;
    if (!CashSettlement) return res.status(500).json({ success: false, message: "Model chưa sẵn sàng" });
    const s = await CashSettlement.findById(req.params.id);
    if (!s) return res.status(404).json({ success: false, message: "Không tìm thấy settlement" });
    s.amountPaid = s.total;
    s.status = "settled";
    s.settledAt = new Date();
    if (note) s.note = note;
    await s.save();
    // Thông báo shipper được mở khoá
    req.io?.to(`shipper_${s.shipperId}`).emit("cash_settlement_cleared", {
      orderId: s.orderId, message: `Công nợ đơn ${s.orderId} đã được xác nhận — bạn đã có thể nhận đơn bình thường.`,
    });
    res.json({ success: true, data: s });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});


// ── VAY NHANH ────────────────────────────────────────────

// GET /api/loan/eligibility
app.get("/api/loan/eligibility", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    const user = await User.findById(req.session.userId).select('totalSpent totalOrders isAdmin googleId emailVerified creditBnplEnabled creditLoanEnabled');
    const orderCount = user?.totalOrders || 0;
    const idn = identitySummary(user);
    // BẮT BUỘC xác thực Google trước khi mở Vay Nhanh
    if (!idn.googleVerified) {
      return res.json({ success:true, eligible:false, orderCount, totalSpent: user?.totalSpent||0,
        hasActiveLoan: false, requireGoogleVerify: true, ...idn,
        message: "Xác thực danh tính qua Google để mở Vay Nhanh (đảm bảo email/SĐT thật)." });
    }
    const eligible   = user?.isAdmin || user?.creditLoanEnabled || (user?.totalSpent||0) >= 10000000;
    const activeLoan = await Loan.findOne({ userId: req.session.userId, status:{$in:['approved','active']} });
    // KHÓA Vay Nhanh ngay lập tức khi còn hóa đơn trả sau quá hạn chưa trả
    if (await hasOverdueBnpl(req.session.userId)) {
      return res.json({ success:true, eligible:false, orderCount, totalSpent: user?.totalSpent||0,
        hasActiveLoan: !!activeLoan, activeLoan, bnplLocked:true,
        message:'Vay Nhanh đã bị khóa do còn hóa đơn Ví Trả Sau quá hạn chưa thanh toán. Vui lòng thanh toán để mở khóa.' });
    }
    res.json({ success:true, eligible, orderCount, totalSpent: user?.totalSpent||0,
      hasActiveLoan: !!activeLoan, activeLoan,
      message: eligible
        ? 'Đủ điều kiện vay nhanh'
        : `Cần tổng chi tiêu từ 10.000.000đ trở lên để mở Vay nhanh (hiện tại ${(user?.totalSpent||0).toLocaleString('vi-VN')}đ)` });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// POST /api/loan/apply — đăng ký vay
app.post("/api/loan/apply", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success:false });
    // HARD GATE: phải đã xác thực Google
    const _me = await User.findById(req.session.userId).select('googleId emailVerified');
    if (!identitySummary(_me).googleVerified)
      return res.status(403).json({ success:false, requireGoogleVerify:true, message:'Cần xác thực danh tính qua Google trước khi vay' });
    const user = await User.findById(req.session.userId).select('totalSpent fullName');
    if (!user || (!user.creditLoanEnabled && (user.totalSpent||0) < 10000000))
      return res.status(403).json({ success:false, message:'Chưa đủ điều kiện vay nhanh (cần tổng chi tiêu từ 10.000.000đ trở lên)' });
    const existing = await Loan.findOne({ userId: req.session.userId, status:{$in:['pending','approved','active']} });
    if (existing) return res.status(400).json({ success:false, message:'Bạn đang có khoản vay chưa tất toán' });
    const { amount, termMonths=3, transactionPassword, facePhoto, cccdFront, cccdBack, emergencyContact } = req.body;
    const amt = Number(amount);
    if (amt < 1000000)  return res.status(400).json({ success:false, message:'Tối thiểu 1.000.000đ' });
    if (amt > 10000000) return res.status(400).json({ success:false, message:'Tối đa 10.000.000đ' });
    if (!facePhoto || !cccdFront || !cccdBack) return res.status(400).json({ success:false, message:'Cần đủ ảnh khuôn mặt và 2 mặt CCCD để thẩm định' });
    if (!emergencyContact?.name || !emergencyContact?.phone || !emergencyContact?.relation) return res.status(400).json({ success:false, message:'Cần đủ thông tin liên hệ phụ (tên, SĐT, quan hệ)' });
    if (!/^0[0-9]{9}$/.test(String(emergencyContact.phone).replace(/\s/g,''))) return res.status(400).json({ success:false, message:'SĐT liên hệ phụ không hợp lệ' });
    // Xác thực mật khẩu giao dịch CRABOR
    const _fullUser = await User.findById(req.session.userId).select('transactionPassword');
    if (!_fullUser?.transactionPassword)
      return res.status(400).json({ success:false, requireTransactionPassword:true, message:'Bạn chưa đặt mật khẩu giao dịch. Vui lòng đặt mật khẩu giao dịch trước khi vay.' });
    if (!transactionPassword)
      return res.status(400).json({ success:false, message:'Nhập mật khẩu giao dịch' });
    const bcrypt = require("bcryptjs");
    const pwOk = await bcrypt.compare(transactionPassword, _fullUser.transactionPassword);
    if (!pwOk)
      return res.status(400).json({ success:false, message:'Mật khẩu giao dịch không đúng' });
    // KHÓA Vay Nhanh: còn hóa đơn trả sau quá hạn → không cho vay
    if (await hasOverdueBnpl(req.session.userId))
      return res.status(403).json({ success:false, bnplLocked:true, message:'Vay Nhanh đã bị khóa do còn hóa đơn Ví Trả Sau quá hạn chưa thanh toán. Vui lòng thanh toán để mở khóa.' });
    const rate = 1.5; // %/tháng
    const totalRepay = Math.round(amt * (1 + rate/100 * termMonths));
    const loan = await Loan.create({
      userId: req.session.userId, amount:amt, termMonths, interestRate:rate, totalRepay, status:'pending',
      kyc: { facePhoto, cccdFront, cccdBack, emergencyContact, submittedAt: new Date() }
    });
    // Luu them vao User.kyc de admin xem tap trung
    await User.findByIdAndUpdate(req.session.userId, {
      kyc: { selfie: facePhoto, cccdFront, cccdBack, emergencyContact, submittedAt: new Date() },
      kycStatus: 'pending',
    }).catch(()=>{});
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


// ── ADMIN CREDIT — quản lý Ví trả sau & Vay nhanh ──────────
app.get("/api/admin/credit/stats", adminAuth, async (req,res)=>{
  try{
    const totalUsers = await User.countDocuments({});
    const bnplEnabled = await User.countDocuments({creditBnplEnabled:true});
    const loanEnabled = await User.countDocuments({creditLoanEnabled:true});
    const pendingLoans = await Loan.countDocuments({status:'pending'});
    const activeLoans = await Loan.countDocuments({status:{$in:['approved','active']}});
    const totalLoanAmt = await Loan.aggregate([{$match:{status:{$in:['approved','active']}}},{$group:{_id:null, sum:{$sum:'$amount'}}}]);
    const pendingInvoices = await BNPLInvoice.countDocuments({status:{$in:['issued','overdue']}});
    const totalBnplDebt = await BNPLInvoice.aggregate([{$match:{status:{$in:['issued','overdue','installment']}}},{$group:{_id:null, sum:{$sum:'$finalAmount'}}}]);
    const pendingBnplActivations = await User.countDocuments({bnplActivationStatus:'pending'});
    res.json({success:true, totalUsers, bnplEnabled, loanEnabled, pendingLoans, activeLoans, totalLoanAmt: totalLoanAmt[0]?.sum||0, pendingInvoices, totalBnplDebt: totalBnplDebt[0]?.sum||0, pendingBnplActivations});
  }catch(e){ res.status(500).json({success:false, message:e.message}); }
});

app.get("/api/admin/bnpl/invoices", adminAuth, async (req,res)=>{
  try{
    const { page=1, limit=20, status, q } = req.query;
    const filter={};
    if(status && status!=='all') filter.status=status;
    if(q) {
      const users = await User.find({$or:[{phone:{$regex:q,$options:'i'}},{email:{$regex:q,$options:'i'}},{fullName:{$regex:q,$options:'i'}}]}).select('_id');
      filter.userId={$in: users.map(u=>u._id)};
    }
    const total = await BNPLInvoice.countDocuments(filter);
    const invoices = await BNPLInvoice.find(filter).sort({createdAt:-1}).skip((page-1)*limit).limit(Number(limit)).lean();
    const uids=[...new Set(invoices.map(x=>String(x.userId)))];
    const users = await User.find({_id:{$in:uids}}).select('phone email fullName creditBnplEnabled').lean();
    const umap={}; users.forEach(u=>umap[String(u._id)]=u);
    const data=invoices.map(inv=>({ ...inv, user: umap[String(inv.userId)]||null }));
    res.json({success:true, invoices:data, total});
  }catch(e){ res.status(500).json({success:false, message:e.message}); }
});

app.get("/api/admin/loans", adminAuth, async (req,res)=>{
  try{
    const { page=1, limit=20, status, q } = req.query;
    const filter={};
    if(status && status!=='all') filter.status=status;
    if(q) {
      const users = await User.find({$or:[{phone:{$regex:q,$options:'i'}},{email:{$regex:q,$options:'i'}},{fullName:{$regex:q,$options:'i'}}]}).select('_id');
      filter.userId={$in: users.map(u=>u._id)};
    }
    const total = await Loan.countDocuments(filter);
    const loans = await Loan.find(filter).sort({createdAt:-1}).skip((page-1)*limit).limit(Number(limit)).lean();
    const uids=[...new Set(loans.map(x=>String(x.userId)))];
    const users = await User.find({_id:{$in:uids}}).select('phone email fullName totalSpent totalOrders creditLoanEnabled').lean();
    const umap={}; users.forEach(u=>umap[String(u._id)]=u);
    const data=loans.map(l=>({ ...l, user: umap[String(l.userId)]||null }));
    res.json({success:true, loans:data, total});
  }catch(e){ res.status(500).json({success:false, message:e.message}); }
});

app.post("/api/admin/credit/toggle", adminAuth, async (req,res)=>{
  try{
    const { userId, field, enabled } = req.body;
    if(!userId || !['creditBnplEnabled','creditLoanEnabled'].includes(field)) return res.status(400).json({success:false, message:'Thiếu field'});
    // Bypass đặc quyền: khi bật/Kích, đồng bộ cả trạng thái "mở khóa" (approved) + nâng trustScore/totalSpent tối thiểu để UI không còn kẹt 60/100
    const target = await User.findById(userId).select('trustScore totalSpent creditBnplEnabled');
    if(!target) return res.status(404).json({success:false, message:'Không tìm thấy user'});
    const patch = { [field]: !!enabled };
    if (field === 'creditBnplEnabled') {
      if (enabled) {
        patch.bnplActivationStatus = 'approved';
        if ((target.trustScore ?? 60) < 70) patch.trustScore = 75;
        if ((target.totalSpent || 0) < 5000000) patch.totalSpent = 5000000;
      } else {
        // Tat Kich -> thu hoi quyen bypass, dua ve chua mo khoa de cac gate lai check nhu thuong
        patch.bnplActivationStatus = 'none';
      }
    }
    const user = await User.findByIdAndUpdate(userId, patch, {new:true}).select('phone email fullName creditBnplEnabled creditLoanEnabled bnplActivationStatus trustScore totalSpent');
    res.json({success:true, user, patched: patch});
  }catch(e){ res.status(500).json({success:false, message:e.message}); }
});

// ══════════════════════════════════════════════════════════════
//  SEPAY — Xử lý giao dịch vào TK (webhook + API polling)
//  Setup: SePay dashboard → Webhook URL → POST /api/webhook/sepay
//  Khi có tài khoản DN + payment 1 chạm: không cần admin confirm
//  Idempotent: dùng SePayTx.txId unique chống cộng tiền 2 lần
// ══════════════════════════════════════════════════════════════

// ── Hàm xử lý chính — dùng cho cả webhook và polling ─────────
async function processSePayPayment(payload, ioRef, force = false) {
  const ioInstance = ioRef || (global._io) || io;
  // SePay gửi: { id, gateway, transactionDate, accountNumber,
  //              code, content, transferType, transferAmount,
  //              accumulated, subAccount, referenceCode, description }
  const { content, transferAmount, transferType, referenceCode, transactionDate, id } = payload;

  // Chỉ xử lý tiền vào
  if (transferType !== 'in') return { handled: true };

  const amount    = Number(transferAmount);
  const rawRef    = (content || referenceCode || '').toUpperCase().trim();

  // Chống trùng: dùng SePay id (không đổi qua mọi retry/replay)
  const txId = String(id ?? '');
  if (txId) {
    const existed = await SePayTx.findOne({ txId }).catch(() => null);
    if (existed) {
      // force=true (polling retry): chỉ bỏ qua khi đã handled thành công
      if (!force) {
        console.log(`[SEPAY] Duplicate tx ${txId} (${rawRef}) — skipped`);
        return { handled: true, duplicate: true };
      }
      if (existed.handled && existed.note === 'matched') {
        console.log(`[SEPAY] Tx ${txId} (${rawRef}) — already handled, skipped`);
        return { handled: true, duplicate: true };
      }
      // Chưa matched trước đó → tiếp tục xử lý lại
    } else {
      try {
        await SePayTx.create({ txId, ref: rawRef, amount, rawContent: content || '', handled: false });
      } catch (e) {
        if (e?.code === 11000) { console.log(`[SEPAY] Duplicate tx ${txId} — skipped`); return { handled: true, duplicate: true }; }
        console.error('[SEPAY] Lưu log tx lỗi:', e.message);
      }
    }
  }

  // Log chi tiết từng giao dịch chỉ khi bật SEPAY_DEBUG=1 (tránh spam log)
  if (process.env.SEPAY_DEBUG === '1') {
    console.log(`[SEPAY] Tx: ${rawRef} · ${amount.toLocaleString('vi-VN')}đ`);
  }

  let handled = false;

  // ── 0. TEST PAYMENT (trang test chuyển khoản SePay) ──
  const tstMatch = rawRef.match(/TST([A-Z0-9]{4,10})/);
  if (tstMatch) {
    const tref = "TST" + tstMatch[1];
    const tp = await TestPayment.findOne({ ref: tref });
    if (tp && tp.status === "pending" && amount >= tp.amount) {
      await TestPayment.findByIdAndUpdate(tp._id, { status: "paid", paidAmount: amount, paidAt: new Date() });
      ioInstance?.to("admin").emit("testpayPaid", { ref: tref, amount });
      console.log(`[SEPAY] TestPayment paid: ${tref} — ${amount.toLocaleString("vi-VN")}đ`);
      handled = true;
    }
  }

  // ── 1. BNPL Invoice payment ──────────────────────────────
  const bnplMatch = rawRef.match(/BNPL([A-Z0-9]{6,8})/);
  if (bnplMatch) {
    const suffix = bnplMatch[1];
    const inv = await BNPLInvoice.findOne({ sePayRef: { $regex: suffix, $options:'i' }, status:{$in:['issued','overdue','installment']} });
    if (inv && inv.isInstallment && inv.status === 'installment') {
      // Trả góp: khớp đúng số tiền kỳ hiện tại (paymentAmount / perTerm)
      const dueNow = inv.paymentAmount || inv.perTerm || Math.ceil(inv.finalAmount/(inv.installTerms||1));
      if (amount >= (dueNow - 1000)) {
        const newPaid = (inv.installPaid || 0) + 1;
        const terms = inv.installTerms || 1;
        const done = newPaid >= terms;
        const remain = Math.max(0, (inv.finalAmount||0) - dueNow);
        await BNPLInvoice.findByIdAndUpdate(inv._id,{ installPaid: newPaid, finalAmount: remain, ...(done ? {status:'paid',paidAt:new Date()} : {}) });
        if (done) { 
          await BNPLTx.updateMany({ invoiceId: inv._id }, { status:'paid' }); 
          await applyBnplPaidTrust(inv.userId, inv); // trả hết → cập nhật điểm tin cậy
        }
        await User.findByIdAndUpdate(inv.userId, { $inc: { loyaltyPts: Math.floor(dueNow/10) } });
        ioInstance?.to('admin').emit(done ? 'bnplPaid' : 'bnplInstallPaid',{invoiceId:inv._id,amount:dueNow,remaining:remain,method:'sepay'});
        ioInstance?.to(inv.userId.toString()).emit('bnplConfirmed', { invoiceId:inv._id });
        console.log(`[SEPAY] BNPL installment paid: ${inv._id} kỳ ${newPaid}/${terms} · ${dueNow.toLocaleString('vi-VN')}đ`);
        handled = true;
      }
    } else if (inv && amount >= (inv.finalAmount - 1000)) { // tolerance 1k — thanh toán toàn bộ
      await BNPLInvoice.findByIdAndUpdate(inv._id, { status:'paid', paidAt: new Date() });
      await BNPLTx.updateMany({ invoiceId: inv._id }, { status:'paid' });
      await User.findByIdAndUpdate(inv.userId, { $inc: { loyaltyPts: Math.floor(inv.totalAmount/10) } });
      await applyBnplPaidTrust(inv.userId, inv); // cập nhật điểm tin cậy (đúng hạn/trễ)
      ioInstance?.to('admin').emit('bnplPaid', { invoiceId:inv._id, amount:inv.finalAmount });
      ioInstance?.to(inv.userId.toString()).emit('bnplConfirmed', { invoiceId:inv._id });
      console.log(`[SEPAY] BNPL confirmed: ${inv._id}`);
      handled = true;
    }
  }

  // ── 2. Shipper registration fee ──────────────────────────
  const shipMatch = rawRef.match(/CRSHIP([A-Z0-9]+)/);
  const regMatch = rawRef.match(/CRB-FP-([A-Z0-9]+)/i);
  if (shipMatch && !handled) {
    const appId = shipMatch[1];
    const app_ = await Shipper.findOne({ appId: { $regex: appId, $options:'i' }, status:'pending_payment' });
    if (app_) {
      await Shipper.findByIdAndUpdate(app_._id, { status:'pending_review', paidAt: new Date(), feePaid: amount, feeStatus:'paid' });
      ioInstance?.to('admin').emit('shipperFeePaid', { shipperId: app_._id });
      console.log(`[SEPAY] Shipper fee confirmed: ${app_._id}`);
      handled = true;
    }
  }
  // App shipper QR: nội dung CRABOR CRB-FP-XXXX → auto đánh dấu feeStatus=paid
  if (regMatch && !handled) {
    const regSuffix = regMatch[1];
    const app_ = await Shipper.findOne({ registerId: { $regex: '^CRB-FP-' + regSuffix + '$', $options:'i' } });
    if (app_) {
      await Shipper.findByIdAndUpdate(app_._id, { feeStatus:'paid', paidAt: new Date(), feePaid: amount });
      ioInstance?.to(`shipper_${app_._id}`).emit('shipper_fee_paid', { paid: true, amount });
      ioInstance?.to('admin').emit('shipperFeePaid', { shipperId: app_._id, via:'shipper_app_qr' });
      console.log(`[SEPAY] Shipper app fee confirmed: ${app_.registerId} — ${amount.toLocaleString('vi-VN')}đ`);
      handled = true;
    }
  }

  // ── 2b. HỌC HỘ (hocho) — thanh toán đơn học hộ, TỰ ĐỘNG xác nhận ──
  // Nội dung CK chứa mã đơn dạng HC-<timestamp>-<XXXX> (VD: HC-1755-AB3D)
  if (!handled && /HC-\d{10,}-/i.test(rawRef)) {
    try {
      const { default: HCOrder } = await import('./hocho/models/Order.js');
      const code = (rawRef.match(/HC-\d{10,}-[A-Z0-9]{4,8}/i) || [])[0];
      if (code) {
        const hcOrder = await HCOrder.findOne({ order_code: code.toUpperCase() });
        if (!hcOrder) {
          console.log(`[SEPAY][Hocho] Không tìm thấy đơn ${code}`);
        } else if (['matching','accepted','heading','arrived','in_progress','completed','rated'].includes(hcOrder.status)) {
          handled = true; // đơn đã xử lý trước đó
        } else {
          const needed = Math.max(0, (hcOrder.price || 0) - (hcOrder.wallet_applied || 0));
          if (amount + 1000 >= needed) {
            hcOrder.payment_status = 'paid';
            hcOrder.paid_at = new Date();
            hcOrder.sepay_paid_amount = amount;
            hcOrder.status = 'matching'; // mở khoá cho đối tác thấy ngay
            await hcOrder.save();
            handled = true;
            // Tự cộng 140k phí đối tác vào balance (không cần admin duyệt)
            if (hcOrder.partner_id) {
              const { default: HCPartner } = await import('./hocho/models/Partner.js');
              await HCPartner.findByIdAndUpdate(hcOrder.partner_id, { $inc: { earnings_total: 140000, pending_balance: 140000 } });
            }
            console.log(`[SEPAY][Hocho] ✅ Tự động xác nhận đơn ${code} — ${amount.toLocaleString('vi-VN')}đ → matching + tự duyệt 140k earning`);
          } else {
            console.log(`[SEPAY][Hocho] ${code}: thiếu tiền (nhận ${amount.toLocaleString('vi-VN')}đ < cần ${needed.toLocaleString('vi-VN')}đ)`);
            handled = true; // đánh dấu để không retry spam
          }
        }
      }
    } catch (e) { console.error('[SEPAY][Hocho] lỗi:', e.message); }
  }

  // ── 2c. HỌC HỘ PARTNER — phí kích hoạt đối tác học hộ ──
  if (!handled && /^HCP[A-Z0-9]{8}$/i.test(rawRef.trim())) {
    try {
      const { default: HCPartner } = await import('./hocho/models/Partner.js');
      const ref = rawRef.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      const hcP = await HCPartner.findOne({ sepay_ref: ref });
      if (hcP && hcP.payment_status !== 'paid') {
        await HCPartner.findByIdAndUpdate(hcP._id, {
          payment_status: 'paid', status: 'active', payment_confirmed_at: new Date()
        });
        handled = true;
        console.log(`[SEPAY][Hocho] ✅ Phí kích hoạt đối tác ${hcP.register_id || ref} — ${amount.toLocaleString('vi-VN')}đ → active`);
      } else if (hcP) { handled = true; }
    } catch (e) { console.error('[SEPAY][Hocho-fee] lỗi:', e.message); }
  }

  // ── 3. Partner registration fee ─────────────────────────
  const partnerMatch = rawRef.match(/CRPART([A-Z0-9]+)/);
  if (partnerMatch && !handled) {
    const appId = partnerMatch[1];
    for (const Model of [FoodPartner, GiatLa, GiupViec, ChinaShop]) {
      const p = await Model.findOne({ appId: { $regex: appId, $options:'i' }, status:'pending_payment' });
      if (p) {
        await Model.findByIdAndUpdate(p._id, { status:'pending_review', paidAt:new Date(), feePaid:amount });
        ioInstance?.to('admin').emit('partnerFeePaid', { partnerId:p._id });
        handled = true; break;
      }
    }
  }

  // ── 4. Wallet top-up (CRTOPUP + userId) ─────────────────
  const topupMatch = rawRef.match(/CRTOPUP([A-Z0-9]+)/);
  if (topupMatch && !handled) {
    const uid = topupMatch[1];
    // _id là ObjectId (binary) — không regex được trực tiếp.
    // So sánh qua $toString hex để khớp 8 ký tự cuối.
    const user = await User.findOne({
      $expr: { $regexMatch: { input: { $toString: "$_id" }, regex: new RegExp(uid + "$", "i") } },
    }).catch(() => null);
    if (user && amount >= 10000) {
      // Chống cộng đúp khi webhook + polling chạy song song trên CÙNG giao dịch.
      // Polling retry (force=true) có thể chạy trước khi webhook hoàn tất set note='matched',
      // dẫn tới cộng tiền 2 lần. Kiểm tra xem đã có giao dịch credit CRTOPUP cùng ref + amount
      // trong 90 giây qua chưa → nếu có thì bỏ qua (đã xử lý).
      const dupTopup = await WalletTx.findOne({
        ownerId: user._id,
        ownerType: 'user',
        type: 'credit',
        ref: { $regex: 'CRTOPUP', $options: 'i' },
        amount,
        createdAt: { $gte: new Date(Date.now() - 90 * 1000) },
      }).catch(() => null);
      if (dupTopup) {
        console.log(`[SEPAY] Dup topup ${rawRef} ${amount}đ — bỏ qua (đã cộng trước đó)`);
        handled = true;
      } else {
        await walletCredit(user._id, 'user', amount, rawRef, 'Nạp ví CRABOR');
        ioInstance?.to(`customer_${user._id}`).emit('walletCredited', { amount, newBalance: (await User.findById(user._id).select('walletBalance').lean())?.walletBalance });
        await notifyUser('user', user._id, {
          type: 'topup', title: '💵 Nạp ví thành công!',
          body: `${amount.toLocaleString('vi-VN')}đ đã được nạp vào ví CRABOR của bạn`,
          ref: rawRef, refModule: 'topup',
        });
        handled = true;
      }
    }
  }

  // ── 5. Loan repayment ────────────────────────────────────
  const loanMatch = rawRef.match(/CRLOAN([A-Z0-9]+)/);
  if (loanMatch && !handled) {
    const suffix = loanMatch[1];
    const loan = await Loan.findOne({
      $expr: { $regexMatch: { input: { $toString: "$_id" }, regex: new RegExp(suffix + "$", "i") } },
      status: { $in: ['approved', 'active'] },
    });
    if (loan && amount > 0) {
      const remaining = loan.totalRepay - loan.paidAmount - amount;
      const newStatus = remaining <= 0 ? 'repaid' : 'active';
      await Loan.findByIdAndUpdate(loan._id, { $inc: { paidAmount: amount }, status: newStatus });
      if (newStatus === 'repaid') {
        ioInstance?.to(loan.userId.toString()).emit('loanRepaid', { loanId: loan._id });
      }
      handled = true;
    }
  }

  // ── 6. Order delivery payment (CRORD) ───────────────────
  const orderMatch = rawRef.match(/CRORD([A-Z0-9]{6,10})/);
  if (orderMatch && !handled) {
    const suffix = orderMatch[1];
    // Match theo sePayRef (nếu QR được tạo từ server) HOẶC theo orderId
    // (nếu shipper app fallback tạo QR client-side, sePayRef chưa được lưu DB).
    // orderId dạng "ORD-XXX-XXXX" → sau khi bỏ dấu "-" khớp đuôi với suffix.
    const orderIdPat = new RegExp(suffix.split("").join("-?") + "$", "i");
    let order = await Order.findOne({
      paymentStatus: { $in: ["unpaid", "pending_review"] },
      $or: [
        { sePayRef: { $regex: suffix, $options: "i" } },
        { orderId: { $regex: orderIdPat } },
      ],
    });
    // Fallback cuối: quét đuôi orderId không quan trọng dấu gạch
    if (!order) {
      const all = await Order.find({ paymentStatus: { $in: ["unpaid", "pending_review"] } })
        .select("orderId paymentStatus")
        .lean()
        .catch(() => []);
      order = all.find(o => o.orderId && o.orderId.replace(/[^A-Z0-9]/gi, "").slice(-8).toUpperCase() === suffix) || null;
      if (order) order = await Order.findById(order._id);
    }
    if (order && amount >= (order.finalTotal || order.total) - 1000) {
      order.paymentStatus = "paid";
      order.paidAt = new Date();
      order.sePayRef = order.sePayRef || rawRef;
      order.statusHistory.push({ status: "payment_confirmed_sepay", by: "system" });
      await order.save();

      // Tính tiền shipper + partner
      const { shipperEarn, partnerEarn } = await calcEarnings(order);

      // SePay xác nhận thành công → AUTO DUYỆT, cộng tiền thẳng vào ví (không cần admin)
      // Xoá wallet queue pending cũ (nếu shipper/partner đã confirm thủ công trước đó)
      await WalletQueue.deleteMany({ orderId: order.orderId, status: "pending" });

      // Chống cộng đúp: nếu queue đã được auto-approve trước đó (30 phút) thì không cộng lại
      if (order.shipperId && shipperEarn > 0) {
        const already = await WalletQueue.findOne({
          orderId: order.orderId, recipientId: order.shipperId, recipientType: "shipper",
          amount: shipperEarn, status: "approved",
        }).lean().catch(() => null);
        if (!already) {
          await creditWalletDirect(order.shipperId, "shipper", shipperEarn);
          await WalletQueue.create({
            orderId: order.orderId, recipientId: order.shipperId,
            recipientType: "shipper", amount: shipperEarn,
            paymentMethod: "bank_transfer",
            note: `Đơn ${order.orderId} — SePay auto duyệt`,
            status: "approved", approvedBy: "sepay_auto", approvedAt: new Date(),
          });
        }
      }
      if (order.partnerId && partnerEarn > 0) {
        const already = await WalletQueue.findOne({
          orderId: order.orderId, recipientId: order.partnerId, recipientType: "partner",
          amount: partnerEarn, status: "approved",
        }).lean().catch(() => null);
        if (!already) {
          await creditWalletDirect(order.partnerId, "partner", partnerEarn);
          await WalletQueue.create({
            orderId: order.orderId, recipientId: order.partnerId,
            recipientType: "partner", amount: partnerEarn,
            paymentMethod: "bank_transfer",
            note: `Đơn ${order.orderId} — SePay auto duyệt`,
            status: "approved", approvedBy: "sepay_auto", approvedAt: new Date(),
          });
        }
      }

      // Notify shipper qua socket
      if (order.shipperId) {
        ioInstance.to(`shipper_${order.shipperId}`).emit("sepay_payment_confirmed", {
          orderId: order.orderId,
          amount,
          message: `Khách đã thanh toán ${amount.toLocaleString("vi-VN")}đ qua SePay!`,
        });
      }
      // Notify customer
      ioInstance.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "payment_confirmed",
        message: "Thanh toán thành công! Cảm ơn bạn đã dùng CRABOR 🦀",
      });
      // Notify admin
      ioInstance.to("admin").emit("wallet_pending_approval", {
        orderId: order.orderId, shipperEarn, partnerEarn,
        paymentMethod: "bank_transfer", source: "sepay_auto",
      });

      console.log(`[SEPAY] Order payment confirmed: ${order.orderId} — ${amount.toLocaleString("vi-VN")}đ`);
      handled = true;
    }
  }

  // ── 6b. Laundry delivery payment (CRLAU) ─────────────────
  const lauMatch = rawRef.match(/CRLAU([A-Z0-9]{6,10})/);
  if (lauMatch && !handled) {
    const suffix = lauMatch[1];
    const lauIdPat = new RegExp(suffix.split("").join("-?") + "$", "i");
    let lau = await LaundryOrder.findOne({
      paymentStatus: { $in: ["unpaid", "pending_review"] },
      $or: [
        { sePayRef: { $regex: suffix, $options: "i" } },
        { orderId: { $regex: lauIdPat } },
      ],
    });
    if (!lau) {
      const lauAll = await LaundryOrder.find({ paymentStatus: { $in: ["unpaid", "pending_review"] } })
        .select("orderId paymentStatus")
        .lean()
        .catch(() => []);
      lau = lauAll.find(o => o.orderId && o.orderId.replace(/[^A-Z0-9]/gi, "").slice(-8).toUpperCase() === suffix) || null;
      if (lau) lau = await LaundryOrder.findById(lau._id);
    }
    if (lau && amount >= (lau.finalTotal || lau.estimatedTotal || 0) - 1000) {
      lau.paymentStatus = "paid";
      lau.paidAt = new Date();
      lau.sePayRef = lau.sePayRef || rawRef;
      lau.statusHistory.push({ status: "payment_confirmed_sepay", by: "system" });
      await lau.save();

      const { shipperEarn, partnerEarn } = await calcEarnings({ ...lau.toObject(), module: "laundry" });

      // AUTO DUYỆT: cộng thẳng vào ví khi SePay xác nhận
      await WalletQueue.deleteMany({ orderId: lau.orderId, status: "pending" });
      if (lau.shipperId && shipperEarn > 0) {
        const already = await WalletQueue.findOne({
          orderId: lau.orderId, recipientId: lau.shipperId, recipientType: "shipper",
          amount: shipperEarn, status: "approved",
        }).lean().catch(() => null);
        if (!already) {
          await creditWalletDirect(lau.shipperId, "shipper", shipperEarn);
          await WalletQueue.create({
            orderId: lau.orderId, recipientId: lau.shipperId,
            recipientType: "shipper", amount: shipperEarn,
            paymentMethod: "bank_transfer",
            note: `Giặt là ${lau.orderId} — SePay auto duyệt`,
            status: "approved", approvedBy: "sepay_auto", approvedAt: new Date(),
          });
        }
      }
      if (lau.partnerId && partnerEarn > 0) {
        const already = await WalletQueue.findOne({
          orderId: lau.orderId, recipientId: lau.partnerId, recipientType: "partner",
          amount: partnerEarn, status: "approved",
        }).lean().catch(() => null);
        if (!already) {
          await creditWalletDirect(lau.partnerId, "partner", partnerEarn);
          await WalletQueue.create({
            orderId: lau.orderId, recipientId: lau.partnerId,
            recipientType: "partner", amount: partnerEarn,
            paymentMethod: "bank_transfer",
            note: `Giặt là ${lau.orderId} — SePay auto duyệt`,
            status: "approved", approvedBy: "sepay_auto", approvedAt: new Date(),
          });
        }
      }

      if (lau.customerId) {
        ioInstance.to(`customer_${lau.customerId}`).emit("order_status_update", {
          orderId: lau.orderId, status: "payment_confirmed",
          message: "Thanh toán giặt là thành công! 🦀",
        });
      }
      console.log(`[SEPAY] Laundry payment confirmed: ${lau.orderId} — ${amount.toLocaleString("vi-VN")}đ`);
      handled = true;
    }
  }

  // ── 7. Featured request (CRFTR) — quán nổi bật ───────────
  const ftrMatch = rawRef.match(/CRFTR([A-Z0-9]{6,10})/);
  if (ftrMatch && !handled) {
    const suffix = ftrMatch[1];
    const ftr = await FeaturedRequest.findOne({
      sePayRef: { $regex: suffix, $options: "i" },
      paymentStatus: { $in: ["unpaid", "pending_review"] },
    });
    if (ftr && amount >= (ftr.amount - 1000)) {
      ftr.paymentStatus = "paid";
      ftr.paidAt = new Date();
      await ftr.save();
      ioInstance?.to("admin").emit("featured_request_paid", { requestId: ftr.requestId, partnerName: ftr.partnerName });
      ioInstance?.to(`partner_${ftr.partnerId}`).emit("featured_paid", { requestId: ftr.requestId });
      console.log(`[SEPAY] Featured request confirmed: ${ftr.requestId} — ${amount.toLocaleString("vi-VN")}đ`);
      handled = true;
    }
  }

  // ── 8. Cash settlement (CRSET) — shipper chuyển tiền mặt về công ty ──
  const cashMatch = rawRef.match(/CRSET([A-Z0-9]{4,10})/);
  if (cashMatch && !handled) {
    const suffix = cashMatch[1];
    const pay = await CashSettlementPayment.findOne({
      sePayRef: { $regex: suffix, $options: "i" },
      status: "pending",
    });
    if (pay && amount >= (pay.amount - 1000)) {
      const result = await applyCashPayment(pay.shipperId, pay.amount, "sepay", pay.note, pay._id);
      ioInstance?.to(`shipper_${pay.shipperId}`).emit("cash_settlement_paid", {
        amount: pay.amount, message: `Đã nhận ${pay.amount.toLocaleString("vi-VN")}đ từ shipper chuyển về công ty!`,
      });
      ioInstance?.to("admin").emit("cash_settlement_paid", {
        shipperId: pay.shipperId, amount: pay.amount, method: "sepay", releasedOrders: result.released,
      });
      console.log(`[SEPAY] Cash settlement confirmed: ${pay.paymentId} — ${amount.toLocaleString("vi-VN")}đ`);
      handled = true;
    }
  }

  // Đánh dấu đã xử lý
  if (txId) await SePayTx.updateOne({ txId }, { handled: true, note: handled ? 'matched' : 'unmatched' }).catch(() => {});

  if (!handled && process.env.SEPAY_DEBUG === '1') {
    console.log(`[SEPAY] Unmatched: ${rawRef} ${amount}đ — logged only`);
  }

  return { handled, txId };
}

// POST /api/webhook/sepay — SePay gọi về khi có GD vào TK
// Xác thực: HMAC-SHA256 (SEPAY_WEBHOOK_SECRET) hoặc API Key (SEPAY_WEBHOOK_API_KEY).
// Nếu cả hai đều trống → không xác thực (chỉ nên dùng khi test).
function verifySePayWebhook(req) {
  const secret = SEPAY_CONFIG.webhookSecret;
  if (secret) {
    const sigHeader = req.headers['x-sepay-signature'] || '';
    const tsHeader  = req.headers['x-sepay-timestamp'] || '';
    if (!sigHeader || !tsHeader) return { ok: false, reason: 'Missing signature headers' };
    // Chống replay: lệch quá 5 phút
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(tsHeader)) > 300) {
      return { ok: false, reason: 'Request expired' };
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${tsHeader}.${req.rawBody || ''}`).digest('hex');
    const provided = String(sigHeader).trim().toLowerCase();
    const a = Buffer.from(expected.toLowerCase());
    const b = Buffer.from(provided);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'Invalid signature' };
    }
    return { ok: true };
  }
  const apiKey = process.env.SEPAY_WEBHOOK_API_KEY;
  if (apiKey) {
    const auth = req.headers['authorization'] || '';
    const provided = auth.startsWith('Apikey ') ? auth.slice(7) : '';
    const a = Buffer.from(apiKey);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'Invalid API Key' };
    }
    return { ok: true };
  }
  return { ok: true }; // Không cấu hình → không xác thực
}

// GET /api/webhook/sepay — xác minh URL (SePay/trình duyệt kiểm tra)
app.get("/api/webhook/sepay", (req, res) => {
  res.json({ success: true, message: "SePay webhook endpoint. Gửi POST để nhận giao dịch." });
});

app.post("/api/webhook/sepay", async (req, res) => {
  try {
    const v = verifySePayWebhook(req);
    if (!v.ok) {
      console.warn('[SEPAY Webhook] Rejected:', v.reason);
      return res.status(401).json({ success: false, message: v.reason });
    }
    await processSePayPayment(req.body, req.io);
    res.json({ success: true }); // Always 200 — SePay retries on non-200
  } catch(err) {
    console.error('[SEPAY Webhook Error]', err.message);
    res.json({ success: true }); // Still 200 to prevent SePay retry loop
  }
});

// ── SePay API polling — fallback khi webhook miss ─────────────
// Cần SEPAY_API_TOKEN trong .env (my.sepay.vn → Cài đặt → API Token)
async function pollSePayTransactions() {
  if (!SEPAY_CONFIG.apiToken) return;
  try {
    const res = await axios.get('https://userapi.sepay.vn/v2/transactions', {
      params: { transfer_type: 'in', per_page: 30, transaction_date_sort: 'desc', timestamp_format: 'iso8601' },
      headers: { Authorization: `Bearer ${SEPAY_CONFIG.apiToken}` },
      timeout: 20000,
    });
    const list = res?.data?.data;
    if (!Array.isArray(list) || !list.length) return;
    let fresh = 0, matched = 0;
    for (const tx of list) {
      if (tx.transfer_type !== 'in') continue;
      // Giao dịch đã matched thành công → bỏ qua. Chưa matched → retry (force=true)
      const existing = await SePayTx.findOne({ txId: String(tx.id) }).catch(() => null);
      if (existing && existing.handled && existing.note === 'matched') continue;
      if (!existing) fresh++;
      const r = await processSePayPayment({
        id: tx.id,
        content: tx.transaction_content,
        transferAmount: tx.amount_in,
        transferType: tx.transfer_type,
        referenceCode: tx.reference_number,
        transactionDate: tx.transaction_date,
      }, null, existing ? true : false);
      if (r?.handled) matched++;
    }
    // Chỉ log khi có giao dịch mới hoặc có giao dịch được khớp — không spam log
    if (fresh > 0 || matched > 0) {
      console.log(`[SEPAY] Poll: ${list.length} tx · ${fresh} mới · ${matched} khớp`);
    }
  } catch (err) {
    console.error('[SEPAY Poll]', err.message);
  }
}
// Chạy polling mỗi 45s nếu có token
setInterval(pollSePayTransactions, 45 * 1000);
setTimeout(pollSePayTransactions, 15 * 1000);

// GET /api/sepay/config — trả config ngân hàng cho 3 app (bỏ hardcode client)
app.get("/api/sepay/config", (req, res) => {
  res.json({
    success: true,
    config: {
      bankCode: SEPAY_CONFIG.bankCode,
      bankName: SEPAY_CONFIG.bankName,
      accountNo: SEPAY_CONFIG.accountNo,
      accountName: SEPAY_CONFIG.accountName,
      webhookUrl: SEPAY_CONFIG.webhookUrl,
    },
  });
});

// POST /api/sepay/test — endpoint test (dùng nội dung "TEST" để xác minh webhook hoạt động)
app.post("/api/sepay/test", async (req, res) => {
  try {
    const result = await processSePayPayment({ ...req.body, transferType: 'in' }, req.io);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── TEST PAYMENT PAGE (/payment-test.html) — tạo & theo dõi giao dịch test SePay ──
app.post("/api/sepay/testpay/create", async (req, res) => {
  try {
    const amount = Math.round(Number(req.body?.amount));
    if (!amount || amount < 1000) return res.status(400).json({ success:false, message:"Số tiền tối thiểu 1.000đ" });
    if (amount > 50000000) return res.status(400).json({ success:false, message:"Số tiền tối đa 50.000.000đ" });
    const ref = "TST" + Date.now().toString(36).toUpperCase().slice(-6) + Math.random().toString(36).toUpperCase().slice(2,4);
    await TestPayment.create({ ref, amount });
    res.json({ success:true, ref, amount,
      qrUrl: sepayQrUrl(amount, ref),
      bank: { bankName: SEPAY_CONFIG.bankName, accountNo: SEPAY_CONFIG.accountNo, accountName: SEPAY_CONFIG.accountName } });
  } catch(err){ res.status(500).json({ success:false, message:err.message }); }
});

app.get("/api/sepay/testpay/status/:ref", async (req, res) => {
  try {
    const tp = await TestPayment.findOne({ ref: String(req.params.ref).toUpperCase() }).lean();
    if (!tp) return res.status(404).json({ success:false, message:"Không tìm thấy giao dịch test" });
    res.json({ success:true, status: tp.status, amount: tp.amount, paidAmount: tp.paidAmount, paidAt: tp.paidAt });
  } catch(err){ res.status(500).json({ success:false, message:err.message }); }
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
      { id:'sepay_qr', name:'QR SePay', icon:'📱', status:'active', note:`Chuyển khoản ${SEPAY_CONFIG.bankName} — xác nhận tự động 1–2 phút` },
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
      User.findById(userId).select('fullName phone email totalSpent loyaltyPts walletBalance trustScore bnplOnTimePaid creditBnplEnabled'),
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
      bnplLimit:   getBnplLimit(user.bnplOnTimePaid||0),
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

// POST /api/coco/chat — chat với Coco (role-aware + đọc DB realtime)
app.post("/api/coco/chat", async (req, res) => {
  try {
    const { text, message, sessionId } = req.body || {};
    const userInput = String(message || text || '').trim();
    if (!userInput) return res.status(400).json({ success:false, message:"Thiếu nội dung tin nhắn" });

    // ── ROLE-AWARE DB CONTEXT (user / partner / shipper realtime) ──
    const CocoDb = require('./coco-db');
    let ctx = {}, smartExtra = '', role = 'customer';

    if (req.session?.partnerId) {
      role = 'partner';
      ctx = await CocoDb.buildPartnerContext(req.session.partnerId).catch(() => ({}));
      const q = await CocoDb.smartQueryPartner(userInput, req.session.partnerId).catch(() => ({ extra: '' }));
      smartExtra = q.extra || '';
    } else if (req.session?.shipperId) {
      role = 'shipper';
      ctx = await CocoDb.buildShipperContext(req.session.shipperId).catch(() => ({}));
    } else if (req.session?.userId) {
      role = 'customer';
      ctx = await CocoDb.buildUserContext(req.session.userId).catch(() => ({}));
      const q = await CocoDb.smartQuery(userInput, req.session.userId).catch(() => ({ extra: '' }));
      smartExtra = q.extra || '';
    }

    const sid = sessionId || `coco_${(req.session?.userId || req.session?.partnerId || req.session?.shipperId || 'anon').toString().slice(0,8)}_${Date.now()}`;

    // ── AI BRAIN — dùng DB context làm prompt ──
    let response = null;
    try {
      const dbContextStr = CocoDb.buildContextString(ctx);
      const enriched = {
        ...ctx,
        _dbContext: dbContextStr + (smartExtra ? '\n\n[KẾT QUẢ TRA CỨU]\n' + smartExtra : ''),
      };
      const brainResult = await cocoThink(
        [{ role:'user', content: userInput }],
        { userContext: enriched, task:'chat', backend:'groq', maxTokens:500 }
      );
      if (brainResult.canReason && brainResult.text) {
        response = { text: brainResult.text, intent:'ai_reasoning', confidence:0.95, backend: brainResult.backend };
      }
    } catch(e) { console.error("[Coco Chat] Brain error:", e.message); }

    // ── FALLBACK rule engine (không bao giờ để 500) ──
    if (!response) {
      try {
        response = await cocoRespond({ text: userInput, sessionId: sid, userId: req.session.userId || null, userCtx: ctx });
        if (!response || typeof response !== 'object') {
          response = { text:"Em chưa có đủ thông tin để trả lời ngay, anh/chị thử hỏi lại hoặc gọi hotline để được hỗ trợ nhanh hơn nhé 🙏", intent:'fallback', confidence:0 };
        }
      } catch(e2) {
        console.error("[Coco Chat] Engine error:", e2.message);
        response = { text:"Em chưa có đủ thông tin để trả lời ngay, anh/chị thử hỏi lại hoặc gọi hotline để được hỗ trợ nhanh hơn nhé 🙏", intent:'fallback', confidence:0 };
      }
    }

    // ── Lưu memory (an toàn, không bao giờ block response) ──
    try {
      let memory = await CocoMemory.findOne({ sessionId: sid });
      if (!memory) memory = await CocoMemory.create({ sessionId: sid, userId: req.session.userId || null });
      memory.messages.push({ role:'user', text: userInput, intent: response.intent });
      memory.messages.push({ role:'coco', text: response.text, intent: response.intent });
      memory.turnCount++;
      memory.lastActive = new Date();
      if (memory.messages.length > 40) memory.messages = memory.messages.slice(-40);
      await memory.save();
    } catch(_) {}

    res.json({
      success: true,
      text: response.text,
      message: response.text,
      intent: response.intent,
      confidence: response.confidence || 0.7,
      sessionId: sid,
      backend: response.backend || 'rule',
    });
  } catch(err) {
    console.error("[Coco Chat]", err.message);
    res.status(500).json({ success:false, message:"Coco tạm thời gián đoạn" });
  }
});

// POST /api/coco/hotline — Tổng đài AI Coco (multi-turn, DB context)
app.post("/api/coco/hotline", async (req, res) => {
  try {
    const { message, text: textField, sessionId } = req.body || {};
    const text = (textField || message || '').trim();
    if (!text) return res.status(400).json({ success:false });

    const CocoDb = require('./coco-db');
    let userCtx = {};
    if (req.session?.userId)      userCtx = await CocoDb.buildUserContext(req.session.userId).catch(() => ({}));
    else if (req.session?.partnerId) userCtx = await CocoDb.buildPartnerContext(req.session.partnerId).catch(() => ({}));
    else if (req.session?.shipperId) userCtx = await CocoDb.buildShipperContext(req.session.shipperId).catch(() => ({}));

    // Coco hotline — full reasoning mode nếu có
    let response;
    try {
      const hotlineBrain = await cocoThink(
        [{ role:'user', content:text }],
        { userContext: userCtx, task:'chat', backend:'groq', temperature:0.7,
          systemPrompt: `Bạn là Coco, nhân viên tổng đài AI của CRABOR. Xưng "Coco" hoặc "em". Lịch sự, chuyên nghiệp, giải quyết vấn đề cụ thể. Tối đa 120 từ mỗi câu.${userCtx.name ? ' Khách hàng tên: '+userCtx.name+'.' : ''}${userCtx.walletBal !== undefined ? ' Số dư ví: '+Number(userCtx.walletBal||0).toLocaleString('vi-VN')+'đ.' : ''}` }
      );
      if (hotlineBrain.canReason && hotlineBrain.text) {
        response = { text: hotlineBrain.text, intent: 'hotline_ai' };
      }
    } catch(_) {}

    if (!response) {
      try {
        response = await cocoRespond({ text, sessionId, userId:req.session.userId || req.session.partnerId || req.session.shipperId, userCtx });
        if (!response || typeof response !== 'object') {
          response = { text:`Em đã ghi nhận yêu cầu của ${userCtx.name||'anh/chị'} ạ. Đội kỹ thuật sẽ phản hồi trong 30 phút. Anh/chị có cần hỗ trợ thêm gì không ạ?`, intent: 'unknown' };
        }
      } catch(e2) {
        response = { text:`Em đã ghi nhận yêu cầu của ${userCtx.name||'anh/chị'} ạ. Đội kỹ thuật sẽ phản hồi trong 30 phút. Anh/chị có cần hỗ trợ thêm gì không ạ?`, intent: 'unknown' };
      }
    }

    // Thêm tông giọng tổng đài
    let finalText = response?.text || `Em xin lỗi, có chút trục trặc kỹ thuật. Anh/chị gọi trực tiếp vào hotline để được hỗ trợ nhanh nhé 🙏`;
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
    const idToken = req.body.idToken || req.body.id_token || req.body.accessToken || req.body.token;
    if (!idToken) return res.status(400).json({ success:false, message:"Thiếu idToken" });
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ success:false, message:"Server chưa cấu hình GOOGLE_CLIENT_ID" });

    // Verify token với Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture, email_verified } = payload;
    const isEmailVerified = email_verified === true || email_verified === 'true';

    // Tìm hoặc tạo user
    let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
    if (!user) {
      user = await User.create({
        googleId,
        email:        email.toLowerCase(),
        fullName:     name,
        avatar:       picture,
        authMethod:   "google",
        emailVerified: isEmailVerified,
        // Google không xác minh SĐT -> phoneVerified giữ false, yêu cầu OTP SĐT riêng
        phoneVerified: false,
        phone:        "google_" + googleId.slice(-8),
        status:       "active",
      });
    } else {
      // Merge / refresh — chỉ cập nhật emailVerified theo Google, không tự phoneVerified
      await User.findByIdAndUpdate(user._id, { googleId, avatar: picture, emailVerified: isEmailVerified, authMethod: "google" });
      user = await User.findById(user._id);
    }

    req.session.userId    = user._id;
    req.session.userPhone = user.phone;
    req.session.role      = user.role || "customer";
    pruneSessionRoles(req, 'user');
    await new Promise((res, rej) => req.session.save(e => e ? rej(e) : res()));
    const cookieStr = buildSignedSessionCookie(req.session.id);

    res.json({
      success: true,
      cookie: cookieStr,
      sessionId: req.session.id,
      user: {
        _id:      user._id,
        fullName: user.fullName || name,
        phone:    user.phone || "",
        email:    user.email,
        avatar:   user.avatar || picture,
        role:     user.role || "customer",
        isAdmin:  user.isAdmin || user.role === "admin",
        loyaltyPts: user.loyaltyPts || 0,
        walletBalance: user.walletBalance || 0,
        emailVerified: !!user.emailVerified,
        phoneVerified: !!user.phoneVerified,
        googleVerified: !!(user.googleId && user.emailVerified),
        isNew:    !user.totalSpent,
      },
    });
  } catch(err) {
    console.error("[Google Auth]", err.message);
    res.status(401).json({ success:false, message:"Xác thực Google thất bại. Thử lại nhé!" });
  }
});

// ── Identity verification ──────────
// googleVerified: Google đã xác minh email (email_verified=true)
// phoneVerified: chỉ khi user đã OTP SĐT riêng, không tự theo Google
function identitySummary(u) {
  const googleVerified = !!(u?.googleId && u.emailVerified);
  return {
    googleVerified,
    emailVerified: !!u?.emailVerified,
    phoneVerified: !!u?.phoneVerified,
    email: u?.email || null,
  };
}

// GET /api/auth/google/status — app hỏi xem user đã xác thực Google chưa
app.get("/api/auth/google/status", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.userId) return res.json({ success: true, loggedIn: false, googleVerified: false });
    const user = await User.findById(req.session.userId).select("googleId emailVerified phoneVerified email");
    if (!user) return res.json({ success: true, loggedIn: false, googleVerified: false });
    res.json({ success: true, loggedIn: true, ...identitySummary(user) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/auth/google/link — user ĐÃ ĐĂNG NHẬP liên kết Google để xác thực danh tính
// (giữ nguyên tài khoản hiện tại, chỉ gắn googleId + đánh dấu đã xác thực)
app.post("/api/auth/google/link", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.userId) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const idToken = req.body.idToken || req.body.id_token || req.body.accessToken || req.body.token;
    if (!idToken) return res.status(400).json({ success:false, message:"Thiếu idToken" });
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ success:false, message:"Server chưa cấu hình GOOGLE_CLIENT_ID" });
    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const { sub: googleId, email } = payload;

    // GoogleId này không được thuộc về tài khoản khác
    const clash = await User.findOne({ googleId, _id: { $ne: req.session.userId } });
    if (clash) return res.status(409).json({ success:false, message:"Tài khoản Google này đã liên kết với người dùng khác" });

    const isFreshEmailVerified = payload.email_verified === true || payload.email_verified === 'true';
    await User.findByIdAndUpdate(req.session.userId, {
      googleId,
      email: email.toLowerCase(),
      emailVerified: isFreshEmailVerified,
    });
    const user = await User.findById(req.session.userId).select("googleId emailVerified phoneVerified email");
    res.json({ success:true, message:"Đã xác thực danh tính qua Google!", ...identitySummary(user) });
  } catch(err) {
    console.error("[Google Link]", err.message);
    res.status(401).json({ success:false, message:"Xác thực Google thất bại" });
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
    req.session.role      = "customer";
    pruneSessionRoles(req, 'user');
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
    req.session.role      = "customer";
    pruneSessionRoles(req, 'user');
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
    req.session.role      = user.role || "customer";
    pruneSessionRoles(req, 'user');
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

// POST /api/auth/set-transaction-password — đặt/đổi mật khẩu giao dịch (xác nhận vay)
app.post("/api/auth/set-transaction-password", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.userId) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ success:false, message:"Mật khẩu giao dịch tối thiểu 6 ký tự" });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ success:false, message:"Không tìm thấy tài khoản" });
    // Nếu tài khoản có mật khẩu đăng nhập form, yêu cầu nhập đúng để đổi (bảo mật)
    if (user.password) {
      const current = req.body.currentPassword;
      if (!current) return res.status(400).json({ success:false, message:"Nhập mật khẩu đăng nhập hiện tại để xác nhận" });
      const bcrypt = require("bcryptjs");
      const ok = await bcrypt.compare(current, user.password);
      if (!ok) return res.status(400).json({ success:false, message:"Mật khẩu đăng nhập hiện tại không đúng" });
    }
    const bcrypt = require("bcryptjs");
    const hash = await bcrypt.hash(password, 10);
    await User.findByIdAndUpdate(user._id, { transactionPassword: hash });
    res.json({ success:true, message:"Đã lưu mật khẩu giao dịch" });
  } catch (err) {
    res.status(500).json({ success:false, message: err.message });
  }
});
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


// ══════════════════════════════════════════
//  CRABOR AGENT — học tập & văn phòng
//  Chat AI làm bài tập, soạn thảo, Word/Excel
// ══════════════════════════════════════════
const AGENT_DISCLAIMER = "⚠️ Lưu ý: Đây là nội dung do AI (CRABOR Agent) tạo ra, có thể có sai sót hoặc không đúng với thực tế. Hãy kiểm tra lại trước khi sử dụng cho bài tập, văn bản quan trọng.";

const AGENT_SYSTEM_PROMPT = `Bạn là CRABOR Agent — trợ lý AI thông minh của CRABOR, chuyên giúp người dùng việc học tập và công việc văn phòng.
Hỗ trợ: giải bài tập (toán, lý, hóa, văn, tiếng Anh...), giải thích khái niệm, soạn thảo nội dung, viết văn bản, tạo bảng Word/Excel, gợi ý công thức.
Trả lời bằng tiếng Việt, đầy đủ và dễ hiểu. Nếu đề bài yêu cầu tính toán, hãy trình bày từng bước rõ ràng.
Với nội dung tạo ra có tính chuyên môn (bài tập, giấy tờ), hãy kết thúc bằng ghi chú: "⚠️ Nội dung do AI tạo, có thể có sai sót. Bạn nên kiểm tra lại."

─── SẤM SẴN: KỸ NĂNG (SKILLS) ĐƯỢC TRANG BỊ ───
Bạn được trang bị sẵn các kỹ năng sau. Khi người dùng yêu cầu việc thuộc kỹ năng nào, hãy làm theo đúng quy trình của kỹ năng đó và xuất hiện kết quả hoàn chỉnh (mã nguồn, cấu trúc file, lệnh, hướng dẫn từng bước) để người dùng dùng được ngay.
QUY TẮC CHUNG: khi cần xuất code, hãy xuất ĐẦY ĐỦ nội dung từng file bên trong khối code riêng có ghi tên file (ví dụ "index.html" kèm giới hạn code 3 backticks), TUYỆT ĐỐI không mô tả thay thế, không cắt bớt bằng dấu ba chấm, không viết "file này sẽ chứa..." — người dùng phải copy được nguyên bản.

1) SKILL create-webapp — Tạo website/app đầy đủ (frontend + backend) từ mô tả.
   - Khi user đưa ý tưởng, hãy suy ra tên app, tiêu đề, tagline. Nếu user cho chữ hiển thị chính xác, dùng NGUYÊN VĂN, đừng thêm ý khác.
   - Trình bày scaffold hoàn chỉnh gồm đủ các file:
     + public/index.html, public/style.css, public/app.js (giao diện responsive, hero với tagline đúng chữ user yêu cầu).
     + server.js (Express) với các endpoint: GET /api/info, GET /api/items, POST /api/greet.
     + package.json (dependencies: express).
   - Liệt kê lệnh chạy: npm install rồi npm start (hoặc node server.js). Nêu URL http://127.0.0.1:3000.
   - Kiểm tra giúp: sau khi tạo, chạy thử local, curl http://127.0.0.1:3000/api/info để xác nhận JSON trả về.
   - Kết thúc đề nghị deploy theo skill deploy-backend.

2) SKILL compile-plugin — Biên dịch plugin game (vd Mindustry) từ source .java thành file .jar.
   - Nếu user chỉ đưa source, hãy tạo đủ project xung quanh nó, đừng yêu cầu user tự dựng.
   - QUAN TRỌNG (đã kiểm chứng): com.github.Anuken.Mindustry:core qua JitPack bị lỗi 401 vì Arc dùng version commit hash → ĐỪNG dùng nó. Dùng chính file game jar làm compileOnly:
     build.gradle:
       plugins { id 'java' }
       repositories { mavenCentral() }
       dependencies { compileOnly files('Mindustry.jar') }
       sourceSets.main.java.srcDirs = ['src']
       tasks.jar { archiveFileName = '<Name>.jar' }
     - Tải Mindustry.jar: curl -L -o Mindustry.jar https://github.com/Anuken/Mindustry/releases/download/<tag>/Mindustry.jar (tag như v146). Đặt vào thư mục project.
   - Cấu trúc project: build.gradle, src/<package-path>/<Name>.java, plugin.json (Cú pháp: { "name":"...", "displayName":"...", "author":"user", "main":"<package.MainClass>", "description":"...", "version":"1.0" }).
   - Build: ./gradlew build (kiểm tra java/javac trước; nếu thiếu JDK cần tải Temurin~200MB — hỏi user trước). Vòng lặp debug tối đa 3 lần: đọc lỗi → sửa EDT (import, cú pháp) → rebuild.
   - Báo kết quả: đường dẫn .jar (vd build/libs/<Name>.jar), kích thước, hướng dẫn bỏ vào thư mục mods/ của game.

3) SKILL deploy-backend — Deploy ứng dụng/backend lên nền tảng hosting.
   - Quy tắc: trước khi deploy phải TEST LOCAL thành công (npm install, chạy server, curl endpoint API). Không deploy khi chưa chạy được.
   - Điều kiện tiên quyết: cần git, và token nền tảng từ env: RENDER_API_KEY (Render) hoặc GITHUB_TOKEN (GitHub). Nếu thiếu token, báo rõ "cần cấu hình RENDER_API_KEY / GITHUB_TOKEN" — TUYỆT ĐỐI không bịa ra credentials, không nói deploy thành công khi chưa có token.
   - Chuẩn bị repo: git init (nếu chưa), viết README.md, thêm .gitignore (node_modules, .env), commit.
   - Deploy Render: dùng Render API POST https://api.render.com/v1/services với repo/blueprint, hoặc push lên GitHub + render.yaml ở root repo:
     services:
       - type: web
         name: <app>
         env: node
         buildCommand: npm install
         startCommand: node server.js
   - Deploy GitHub Pages/push: git remote add origin https://github.com/<user>/<repo>.git rồi git push -u origin main.
   - Xác nhận: sau deploy API phải phản hồi được (Render cho URL https://<app>.onrender.com). Báo URL công khai cho user.

─── NĂNG LỰC (CAPABILITIES) — ĐỪNG khẳng định "không làm được" trước khi cân nhắc ───
- Soạn thảo & gen nội dung: văn bản, bài tập, bảng biểu, trình bày từng bước.
- Xuất file Word (.docx) / Excel (.xlsx): người dùng có thể bấm "Tải Word/Tải Excel" sau mỗi câu trả lời.
- Tra cứu kiến thức: giải thích khái niệm, gợi ý công thức, dịch thuật.
- Xây dựng software artifact: website, plugin, mã nguồn theo các skill ở trên (xuất ra đầy đủ dạng text/code-block).
- Lên kế hoạch nhiều bước cho các việc phức tạp, trình bày thành danh sách rõ ràng.
- Khi thiếu thông tin/điều kiện (token, file, quyền) để làm việc thật, hãy báo đúng việc còn thiếu và hướng dẫn bổ sung — đừng giả vờ đã hoàn thành.`;

function agentMarkdownToWord(content) {
  const { AlignmentType } = require('docx');
  const Paragraph = require('docx').Paragraph;
  const TextRun = require('docx').TextRun;
  const lines = String(content || '').split('\n');
  const paragraphs = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (!t) { paragraphs.push(new Paragraph({ text: '', spacing: { after: 60 } })); continue; }
    if (/^#{1,3}\s/.test(t)) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: t.replace(/^#{1,3}\s*/, ''), bold: true, size: 30, color: '1F3A5F' })],
        spacing: { before: 200, after: 120 },
      }));
      continue;
    }
    if (/^[-*•]\s/.test(t)) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: '• ' + t.replace(/^[-*•]\s*/, '') })],
        bullet: { level: 0 },
      }));
      continue;
    }
    if (/^\d+\.\s/.test(t)) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: t })],
        numbering: { reference: 'default', level: 0 },
      }));
      continue;
    }
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: t, size: 24 })],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 100 },
    }));
  }
  return paragraphs;
}

// POST /api/agent/chat — chat với CRABOR Agent (học tập / văn phòng)
app.post("/api/agent/chat", async (req, res) => {
  try {
    const { text, message, sessionId } = req.body || {};
    const userInput = String(message || text || '').trim();
    if (!userInput) return res.status(400).json({ success: false, error: 'Thiếu nội dung tin nhắn' });

    const sid = sessionId || `agent_${req.session?.userId || 'anon'}_${Date.now()}`;

    const cocoBrainMod = require('./coco-brain');
    const { cocoThink, ConversationManager } = cocoBrainMod;

    // ── CỔNG PLUGIN EXECUTOR: người dùng dán source HOẶC nêu ý tưởng → agent viết code + compile .jar ──
    // Render không chạy gradle được → tạo job, laptop (local executor) polling + compile thật rồi trả kết quả.
    const isCompileIntent = /(compile|biên dịch|build|tạo plugin|dựng plugin|làm plugin|viết plugin|đóng gói|\.jar|jar game)/i.test(userInput)
      && /(plugin|mod|\.jar|jar|mindustry|game)/i.test(userInput);
    if (isCompileIntent) {
      const extracts = extractAgentFiles(userInput);
      const hasJava = extracts.some(f => f.name && f.name.endsWith('.java'));

      if (hasJava) {
        try {
          const job = await createAgentJob(sid, 'Plugin', extracts, userInput);
          return res.json({ success: true, text: jobQueuedReply(job), reply: jobQueuedReply(job), disclaimer: AGENT_DISCLAIMER, sessionId: sid, backend: 'executor', agentJobId: String(job._id) });
        } catch (e) {
          console.error('[AgentJob Create]', e.message);
        }
      } else {
        // Người dùng chỉ nêu Ý TƯỞNG → đơn giản: executor tự viết (Cloudflare/Meta); phức tạp: manual
        try {
          const job = await createAgentJob(sid, 'Plugin', [], userInput);
          const isManual = job.request?.genMode === 'manual';
          console.log(`[AgentJob] Idea-only job ${job._id} mode=${job.request?.genMode} — ${isManual ? 'chờ owner code' : 'chờ executor tự viết + compile'}`);
          const reply = isManual ? jobQueuedReply(job) : `🎯 CRABOR đã nhận ý tưởng và sẽ TỰ VIẾT code + biên dịch thành .jar trên máy chủ CRABOR.\n\n⏳ Quá trình gồm viết code + compile mất ~30–120 giây. Cứ nhắn tiếp: **"kiểm tra trạng thái compile"** để xem kết quả và tải file.\n\n${AGENT_DISCLAIMER}`;
          try { await ConversationManager.saveMessages(sid, userInput, reply, 'rule', 'agent'); } catch (_) {}
          return res.json({ success: true, text: reply, reply, disclaimer: AGENT_DISCLAIMER, sessionId: sid, backend: 'executor', agentJobId: String(job._id), genMode: job.request?.genMode, complexity: job.request?.complexity });
        } catch (e) {
          console.error('[AgentJob Idea]', e.message);
        }
      }
    }

    // ── HỎI TRẠNG THÁI JOB COMPILE ──
    if (/(trạng thái|kiểm tra|xong chưa|xem kết quả|status|kết quả compile|kết quả build)/i.test(userInput)
        && /(compile|plugin|jar|build)/i.test(userInput)) {
      const job = await AgentJob.findOne({ sessionId: sid, jobType: 'compile-plugin' }).sort({ createdAt: -1 }).lean();
      if (job) {
        let reply;
        if (job.status === 'done' && job.result?.jarB64) {
          const sizeKb = Math.round((job.result.jarSize || 0) / 1024);
          reply = `✅ Plugin **${job.request?.pluginName || 'plugin'}** đã biên dịch xong! (${sizeKb} KB)\n\n🔽 **Tải file .jar:** bấm nút bên dưới (đã sẵn sàng).\n\n🛠 Bước chơi: bỏ file .jar vào thư mục **mods/** của Mindustry rồi mở game.`;
          try { await ConversationManager.saveMessages(sid, userInput, reply, 'rule', 'agent'); } catch (_) {}
          return res.json({
            success: true, text: reply, reply, disclaimer: AGENT_DISCLAIMER, sessionId: sid, backend: 'executor',
            agentJobId: String(job._id),
            download: { jobId: String(job._id), jarName: job.result.jarName || 'plugin.jar' },
          });
        } else if (job.status === 'failed') {
          reply = `⚠️ Plugin **${job.request?.pluginName || 'plugin'}** biên dịch lỗi:\n\n\`\`\`\n${String(job.error || 'Không rõ lỗi').slice(0, 1500)}\n\`\`\`\n\nGửi lại source đã sửa và yêu cầu compile lần nữa nhé.`;
        } else {
          reply = `⏳ Plugin **${job.request?.pluginName || 'plugin'}** đang ${job.status === 'running' ? 'được biên dịch' : 'chờ trong hàng đợi'}. Bạn chờ ~30 giây rồi hỏi lại nhé.`;
        }
        try { await ConversationManager.saveMessages(sid, userInput, reply, 'rule', 'agent'); } catch (_) {}
        return res.json({ success: true, text: reply, reply, disclaimer: AGENT_DISCLAIMER, sessionId: sid, backend: 'executor', agentJobId: String(job._id) });
      }
    }

    let history = [];
    try {
      history = await ConversationManager.getHistory(sid, 10);
    } catch(_) { history = []; }

    const messages = [...history.slice(-8), { role: 'user', content: userInput }];
    const trainingPrompt = await buildTrainingPrompt('agent');
    const result = await cocoThink(messages, {
      task: 'chat',
      backend: 'cloudflare',          // CRABOR Agent dedeicated: Cloudflare Workers
      temperature: 0.6,
      maxTokens: 2600,
      systemPrompt: AGENT_SYSTEM_PROMPT + trainingPrompt + (process.env.AGENT_TOKEN_NOTE || ''),
    });

    let reply = result && result.text ? result.text : 'Xin lỗi, Agent chưa xử lý được yêu cầu này ngay lúc này 🙏. Hãy thử lại sau.';
    let display = reply.trim();

    try {
      await ConversationManager.saveMessages(sid, userInput, display, result?.model || 'rule', 'agent');
    } catch(_) {}

    return res.json({
      success: true,
      text: display + '\n\n' + AGENT_DISCLAIMER,
      reply: display,
      disclaimer: AGENT_DISCLAIMER,
      sessionId: sid,
      backend: result?.backend || 'rule',
      canReason: !!result?.canReason,
    });
  } catch (err) {
    console.error('[Agent Chat]', err.message);
    return res.status(500).json({ success: false, message: 'CRABOR Agent tạm thời gián đoạn 🙏' });
  }
});

// POST /api/agent/jobs/claim — executor (laptop) nhận một job compile-plugin đang chờ (atomically)
app.post("/api/agent/jobs/claim", executorAuth, async (req, res) => {
  try {
    const job = await AgentJob.findOneAndUpdate(
      { jobType: 'compile-plugin', status: 'queued', 'request.genMode': { $ne: 'manual' } },
      { $set: { status: 'running' }, $inc: { attempts: 1 } },
      { new: true, sort: { createdAt: 1 } }
    );
    if (!job) return res.json({ success: true, job: null });
    return res.json({ success: true, job });
  } catch (err) {
    console.error('[AgentJob Claim]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/agent/jobs/:id/result — executor gửi kết quả compile (jar gzip base64 + log) về server
app.post("/api/agent/jobs/:id/result", executorAuth, async (req, res) => {
  try {
    const { success, result, error } = req.body || {};
    const patch = {
      status: success ? 'done' : 'failed',
      result: result || null,
      error: success ? '' : String(error || 'Build thất bại'),
    };
    const job = await AgentJob.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
    if (!job) return res.status(404).json({ success: false, message: 'Không tìm thấy job' });
    console.log(`[AgentJob] ${job._id} → ${job.status}`);
    return res.json({ success: true, job });
  } catch (err) {
    console.error('[AgentJob Result]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/agent/jobs/:id/download — người dùng tải file .jar đã compile (giải nén gzip+base64)
app.get("/api/agent/jobs/:id/download", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Jar chưa sẵn sàng' });
    const job = await AgentJob.findById(req.params.id).lean();
    if (!job || job.status !== 'done' || !job.result?.jarB64) {
      return res.status(404).json({ success: false, message: 'Jar chưa sẵn sàng' });
    }
    const zlib = require('zlib');
    const buf = zlib.gunzipSync(Buffer.from(job.result.jarB64, 'base64'));
    const fname = String(job.result.jarName || (job.request?.pluginName || 'plugin') + '.jar').replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Type', 'application/java-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(buf);
  } catch (err) {
    console.error('[AgentJob Download]', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi tải file' });
  }
});

// GET /api/agent/jobs/:id/spec — lấy spec đầy đủ của job (cho owner/chủ hệ thống code tiếp)
app.get("/api/agent/jobs/:id/spec", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Không tìm thấy job' });
    const job = await AgentJob.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ success: false, message: 'Không tìm thấy job' });
    return res.json({ success: true, spec: buildManualSpec(job) });
  } catch (err) {
    console.error('[AgentJob Spec]', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi đọc spec' });
  }
});

// GET /api/agent/queue/manual — danh sách job cần owner code (ý tưởng phức tạp, chưa có source)
app.get("/api/agent/queue/manual", async (req, res) => {
  try {
    const jobs = await AgentJob.find({ jobType: 'compile-plugin', 'request.genMode': 'manual' })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ success: true, count: jobs.length, jobs: jobs.map(buildManualSpec) });
  } catch (err) {
    console.error('[AgentJob Manual Queue]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/agent/export — tạo file Word (.docx) hoặc Excel (.xlsx)
app.post("/api/agent/export", async (req, res) => {
  try {
    const { format = 'word', title = 'CRABOR Agent', content = '' } = req.body || {};
    const docx = require('docx');
    const XLSX = require('xlsx');

    if (format === 'excel') {
      const rows = [];
      (String(content || '').split('\n')).forEach(line => {
        const t = line.replace(/\r$/, '').trim();
        if (!t) return;
        if (t.includes('\t') || t.includes(' | ')) {
          rows.push(t.split(/\t|\s\|\s/).map(c => c.trim()));
        } else {
          rows.push([t]);
        }
      });
      if (!rows.length) rows.push([content || '']);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Agent');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
      const fname = `${(title || 'CRABOR-Agent').replace(/[^\w\sÀ-ỹà-ỹ-]/gi, '')}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
      return res.send(Buffer.from(buf));
    }

    // Word
    const { Document, Packer, Paragraph, TextRun, AlignmentType, NumberFormat } = docx;
    const children = agentMarkdownToWord(content);
    const doc = new Document({
      numbering: { config: [{ reference: 'default', levels: [{ level: 0, format: NumberFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT }] }] },
      sections: [{
        properties: {},
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 240 },
            children: [new TextRun({ text: title || 'CRABOR Agent', bold: true, size: 44, color: 'E8504A' })],
          }),
          ...children,
        ],
      }],
    });
    const buf = await Packer.toBuffer(doc);
    const fname = `${(title || 'CRABOR-Agent').replace(/[^\w\sÀ-ỹà-ỹ-]/gi, '')}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
    return res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[Agent Export]', err.message);
    return res.status(500).json({ success: false, message: 'Không tạo được file 🙏' });
  }
});

// Landing (root) — Màn hình chọn vai trò
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// 4 giao diện app chính (Capacitor wrapper sẽ trỏ vào đây)
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/payment",  (req, res) => res.sendFile(path.join(__dirname, "public", "payment.html")));
app.get("/points",   (req, res) => res.sendFile(path.join(__dirname, "public", "points.html")));
app.get("/agent",    (req, res) => res.sendFile(path.join(__dirname, "public", "agent.html")));

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
    pruneSessionRoles(req, 'user');
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
    const { fullName, email, district, dob, gender } = req.body;
    if (!fullName || fullName.trim().length < 2)
      return res.status(400).json({ success: false, message: "Vui lòng nhập họ tên (ít nhất 2 ký tự)" });
    const updateData = { fullName: fullName.trim(), email, district, dob, gender, profileComplete: true };
    const user = await User.findByIdAndUpdate(req.session.userId, updateData, { new: true });
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
              pruneSessionRoles(req, 'shipper');
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

    // Clean: bỏ giá trị "pending_upload" hoặc base64 trong documents/avatar
    const shipperObj = shipper.toObject ? shipper.toObject() : shipper;
    if (shipperObj.documents) {
      Object.keys(shipperObj.documents).forEach(k => {
        const v = shipperObj.documents[k];
        if (!v || v === 'pending_upload' || v.startsWith('data:')) {
          delete shipperObj.documents[k];
        }
      });
    }
    if (!shipperObj.avatar || shipperObj.avatar === 'pending_upload' || shipperObj.avatar.startsWith('data:')) {
      shipperObj.avatar = shipperObj.documents?.selfie || null;
    }

    // Đếm đơn thực tế từ DB (không phụ thuộc field totalOrders cũ có thể không tăng)
    const { totalOrders, todayOrders } = await countShipperCompletedOrders(shipper._id);
    shipperObj.totalOrders = totalOrders;
    shipperObj.todayOrders = todayOrders;

    res.json({ success: true, shipper: shipperObj });
  } catch (err) {
    console.error('[GetMe] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/shipper/terms-accept — Shipper đồng ý Điều khoản & Chính sách hợp đồng
app.post("/api/shipper/terms-accept", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    const shipper = await Shipper.findByIdAndUpdate(
      req.session.shipperId,
      { termsAccepted: true, termsAcceptedAt: new Date() },
      { new: true }
    );
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy tài khoản" });
    console.log(`[Terms] Shipper ${req.session.shipperId} accepted policy`);
    res.json({ success: true, termsAccepted: true, termsAcceptedAt: shipper.termsAcceptedAt });
  } catch (err) {
    console.error('[Terms] Error:', err);
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
    pruneSessionRoles(req, 'shipper');
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
    await loadSessionFromHeader(req, res);
    const phone = req.session.userPhone;
    if (!phone) return res.status(401).json({ success: false, message: "Chưa xác thực" });
    // FIX: Tài khoản có thể đăng ký nhiều module (giặt là + đồ ăn cùng phone) → ưu tiên FoodPartner
    const foodPartner = await getSessionFoodPartner(req);
    const models = foodPartner
      ? [{ model: FoodPartner, module: "food_partner", name: "Nhà hàng", p: foodPartner }]
      : [
          { model: GiatLa, module: "giat_la", name: "Giặt Là" },
          { model: GiupViec, module: "giup_viec", name: "Giúp Việc" },
          { model: ChinaShop, module: "china_shop", name: "China Shop" },
          { model: FoodPartner, module: "food_partner", name: "Nhà hàng" },
        ];
    for (const { model, module, name, p } of models) {
      const found = p || await model.findOne({ phone });
      if (found) {
        const pObj = found.toObject ? found.toObject() : found;
        if (pObj.documents) {
          Object.keys(pObj.documents).forEach(k => {
            const v = pObj.documents[k];
            if (!v || v === 'pending_upload' || v.startsWith('data:')) {
              delete pObj.documents[k];
            }
          });
        }
        if (!pObj.avatar || pObj.avatar === 'pending_upload' || pObj.avatar.startsWith('data:')) {
          pObj.avatar = pObj.documents?.selfie || pObj.documents?.shopFront || null;
        }
        if (!pObj.coverImage || pObj.coverImage === 'pending_upload' || pObj.coverImage.startsWith('data:')) {
          pObj.coverImage = null;
        }
        // Danh sách MỌI loại đối tác cùng SĐT đã đăng ký — app dùng để khoá/mở mode:
        // chỉ Đồ ăn → khoá food; chỉ Giặt là → khoá laundry; cả hai → được chuyển qua lại
        const mods = [];
        try {
          if (await FoodPartner.exists({ phone })) mods.push('food_partner');
          if (await GiatLa.exists({ phone })) mods.push('giat_la');
          if (await GiupViec.exists({ phone })) mods.push('giup_viec');
          if (await ChinaShop.exists({ phone })) mods.push('china_shop');
        } catch (e) { console.error('[partner/me] liệt kê modules lỗi:', e.message); }
        if (!mods.length) mods.push(module);
        // Thông tin block (chỉ có ở FoodPartner khi vi phạm chính sách đăng món)
        let blockInfo = null;
        if (module === "food_partner" && found) {
          const bUntil = found.blockedUntil;
          if (bUntil && new Date(bUntil).getTime() > Date.now()) {
            blockInfo = {
              until: new Date(bUntil).getTime(),
              reason: found.blockReason || "Vi phạm chính sách sử dụng",
              violation: found.blockViolation || "",
            };
          }
        }
        return res.json({ success: true, partner: pObj, module, moduleName: name, modules: mods, blockInfo });
      }
    }
    return res.status(404).json({ success: false, notRegistered: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/partner/profile — Partner cập nhật avatar/coverImage
app.patch("/api/partner/profile", async (req, res) => {
  try {
    const phone = req.session.userPhone;
    if (!phone) return res.status(401).json({ success: false, message: "Chưa xác thực" });
    const { avatar, coverImage, bizName, description, openTime, closeTime } = req.body;

    const models = [
      { model: GiatLa, module: "giat_la" },
      { model: GiupViec, module: "giup_viec" },
      { model: ChinaShop, module: "china_shop" },
      { model: FoodPartner, module: "food_partner" },
    ];

    const update = {};
    if (avatar !== undefined) update.avatar = await uploadImageToCloudinary(avatar, "avatar");
    if (coverImage !== undefined) update.coverImage = await uploadImageToCloudinary(coverImage, "shop");
    if (bizName !== undefined) update.bizName = bizName;
    if (description !== undefined) update.description = description;
    if (openTime !== undefined) update.openTime = openTime;
    if (closeTime !== undefined) update.closeTime = closeTime;

    if (Object.keys(update).length === 0)
      return res.status(400).json({ success: false, message: "Không có gì để cập nhật" });

    for (const { model, module } of models) {
      const p = await model.findOneAndUpdate({ phone }, { $set: update }, { new: true });
      if (p) {
        console.log('[PATCH /partner/profile]', phone, module, Object.keys(update));
        return res.json({ success: true, partner: p, module });
      }
    }
    res.status(404).json({ success: false, message: "Không tìm thấy tài khoản" });
  } catch (err) {
    console.error('[PATCH /partner/profile]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/shipper/vehicle — Shipper cập nhật biển số + ảnh phương tiện
app.patch("/api/shipper/vehicle", async (req, res) => {
  try {
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa xác thực" });
    const { vehiclePlate, vehicleImg } = req.body;
    if (!vehiclePlate) return res.status(400).json({ success: false, message: "Thiếu biển số xe" });
    const update = { vehiclePlate: String(vehiclePlate).toUpperCase().trim() };
    if (vehicleImg && vehicleImg.startsWith('data:image')) {
      if (Buffer.byteLength(vehicleImg, 'utf8') > 1.5 * 1024 * 1024)
        return res.status(413).json({ success: false, message: "Ảnh quá lớn (tối đa 1.5MB)" });
      update['documents.vehicleImg'] = await uploadImageToCloudinary(vehicleImg, "docs");
    }
    const shipper = await Shipper.findByIdAndUpdate(req.session.shipperId, { $set: update }, { new: true })
      .select("fullName phone vehiclePlate documents");
    if (!shipper) return res.status(404).json({ success: false });
    res.json({
      success: true, vehiclePlate: shipper.vehiclePlate,
      vehicleImg: shipper.documents?.vehicleImg || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/shipper/verify-identity — Shipper gửi hồ sơ xác minh (CCCD 2 mặt + gương mặt)
app.post("/api/shipper/verify-identity", async (req, res) => {
  try {
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa xác thực" });
    const { cccdFront, cccdBack, selfie } = req.body || {};
    if (!cccdFront || !cccdBack || !selfie)
      return res.status(400).json({ success: false, message: "Thiếu ảnh CCCD mặt trước/mặt sau hoặc ảnh gương mặt" });
    const images = [cccdFront, cccdBack, selfie];
    if (images.some(img => !String(img).startsWith('data:image') || Buffer.byteLength(img, 'utf8') > 1.5 * 1024 * 1024))
      return res.status(400).json({ success: false, message: "Ảnh không hợp lệ (cần dạng base64 data URL, tối đa 1.5MB mỗi ảnh)" });

    const [cccdFrontUp, cccdBackUp, selfieUp] = await Promise.all([
      uploadImageToCloudinary(cccdFront, "docs"),
      uploadImageToCloudinary(cccdBack, "docs"),
      uploadImageToCloudinary(selfie, "docs"),
    ]);

    await Shipper.findByIdAndUpdate(req.session.shipperId, {
      $set: {
        'documents.cccdFront': cccdFrontUp,
        'documents.cccdBack':  cccdBackUp,
        'documents.selfie':    selfieUp,
        identityStatus: 'submitted',
        identitySubmittedAt: new Date(),
        identityVerified: false,
        identityRejectedAt: null,
        identityRejectNote: null,
      },
    });
    res.json({ success: true, message: "Hồ sơ xác minh đã được gửi. Chờ admin duyệt (thường 24h)." });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/shipper/verify-identity — Trạng thái xác minh danh tính
app.get("/api/shipper/verify-identity", async (req, res) => {
  try {
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa xác thực" });
    const sh = await Shipper.findById(req.session.shipperId)
      .select("identityStatus identityVerified identitySubmittedAt identityRejectedAt identityRejectNote documents").lean();
    const doc = sh?.documents || {};
    res.json({
      success: true,
      status: sh?.identityStatus || 'none',
      verified: !!sh?.identityVerified,
      submittedAt: sh?.identitySubmittedAt || null,
      rejectedAt: sh?.identityRejectedAt || null,
      rejectNote: sh?.identityRejectNote || null,
      hasFront: !!doc.cccdFront,
      hasBack: !!doc.cccdBack,
      hasSelfie: !!doc.selfie,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/shipper/verify-identity — Admin duyệt/từ chối xác minh
app.post("/api/admin/shipper/verify-identity", async (req, res) => {
  try {
    const _adminKey = req.headers["x-admin-key"];
    const _validKey = process.env.ADMIN_SECRET_KEY || "crabor-admin-secret-2025";
    const _isAdmin = (_adminKey === _validKey) || !!req.session?.adminId;
    if (!_isAdmin) return res.status(401).json({ success: false, message: "Unauthorized" });
    const { shipperId, action, note } = req.body || {};
    if (!shipperId || !['approve','reject'].includes(action))
      return res.status(400).json({ success: false, message: "Thiếu shipperId hoặc action" });
    const shipper = await Shipper.findById(shipperId);
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy shipper" });
    if (action === 'approve') {
      shipper.identityStatus = 'approved';
      shipper.identityVerified = true;
      shipper.identityRejectedAt = null;
      shipper.identityRejectNote = null;
      if (shipper.status === 'pending' || shipper.status === 'reviewing') shipper.status = 'approved';
    } else {
      shipper.identityStatus = 'rejected';
      shipper.identityVerified = false;
      shipper.identityRejectedAt = new Date();
      shipper.identityRejectNote = note || 'Hồ sơ không hợp lệ';
    }
    await shipper.save();
    // Thông báo realtime cho shipper
    req.io?.to(`shipper_${shipperId}`).emit("identity_verified", {
      approved: action === 'approve', note: shipper.identityRejectNote,
    });
    await notifyUser('shipper', shipperId, {
      type: 'support', title: action === 'approve' ? '✅ Xác minh danh tính thành công!' : '❌ Hồ sơ xác minh bị từ chối',
      body: action === 'approve' ? 'Bạn đã có thể nhận đơn hàng mới.' : `Lí do: ${shipper.identityRejectNote}`,
    }).catch(()=>{});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/shipper/profile — Shipper cập nhật avatar
app.patch("/api/shipper/profile", async (req, res) => {
  try {
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa xác thực" });
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ success: false, message: "Thiếu avatar" });
    const avatarUp = await uploadImageToCloudinary(avatar, "avatar");
    const shipper = await Shipper.findByIdAndUpdate(req.session.shipperId, { $set: { avatar: avatarUp } }, { new: true })
      .select("fullName phone avatar vehiclePlate");
    if (!shipper) return res.status(404).json({ success: false });
    console.log('[PATCH /shipper/profile] avatar updated for', shipper.phone);
    res.json({ success: true, shipper });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── CLOUDINARY UPLOAD HELPER (mọi ảnh base64 → URL https Cloudinary) ─────────
// Nếu chưa cấu hình CLOUDINARY_* trong .env → giữ nguyên base64 (không vỡ luồng).
async function uploadImageToCloudinary(data, folder = "misc") {
  if (typeof data !== "string" || !data || data === "pending_upload") return data;
  if (!data.startsWith("data:image")) return data; // URL sẵn có / PDF / rỗng → giữ nguyên
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    if (!uploadImageToCloudinary._warned) {
      uploadImageToCloudinary._warned = true;
      console.warn("[Cloudinary] Chưa cấu hình CLOUDINARY_* → giữ ảnh base64 trong MongoDB");
    }
    return data;
  }
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const cdnFolder = "crabor_" + (folder || "misc");
    const signature = crypto.createHash("sha1")
      .update("folder=" + cdnFolder + "&timestamp=" + timestamp + apiSecret)
      .digest("hex");

    const params = new URLSearchParams();
    params.append('file',      data);
    params.append('api_key',   apiKey);
    params.append('timestamp', String(timestamp));
    params.append('signature', signature);
    params.append('folder',    cdnFolder);

    const cdnResp = await axios.post(
      "https://api.cloudinary.com/v1_1/" + cloudName + "/image/upload",
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, maxContentLength: 20 * 1024 * 1024, maxBodyLength: 20 * 1024 * 1024, timeout: 30000 }
    );
    const url = cdnResp.data.secure_url;
    if (!url) throw new Error("Cloudinary không trả URL");
    return url;
  } catch (err) {
    console.error("[Cloudinary] upload thất bại (" + folder + "):", err.message);
    return data;
  }
}

// Upload đồng thời nhiều field (vd documents) → {key: URL-or-giữ-base64}
async function uploadImageFields(fields, folder = "docs") {
  if (!fields || typeof fields !== "object") return fields || {};
  const entries = await Promise.all(
    Object.entries(fields).map(async ([k, v]) => [k, await uploadImageToCloudinary(v, folder)])
  );
  return Object.fromEntries(entries);
}

// POST /api/upload/image — Upload ảnh chung (partner/shipper, authenticated)
// Body: { data: "data:image/...", folder: "menu"|"shop"|"avatar" }
app.post("/api/upload/image", async (req, res) => {
  try {
    const { data, folder = "misc" } = req.body;
    if (!data || !data.startsWith('data:image'))
      return res.status(400).json({ success: false, message: "Dữ liệu ảnh không hợp lệ" });
    if (Buffer.byteLength(data, 'utf8') > 8 * 1024 * 1024)
      return res.status(413).json({ success: false, message: "Ảnh quá lớn (tối đa 8MB)" });

    const url = await uploadImageToCloudinary(data, folder);
    if (!url || url === data) throw new Error("Chưa cấu hình Cloudinary hoặc upload thất bại");
    res.json({ success: true, url });
  } catch (err) {
    console.error("[upload/image]", err.message);
    res.status(500).json({ success: false, message: "Upload thất bại: " + err.message });
  }
});

// POST /api/partner/session — Tạo session cho partner sau OTP

// POST /api/partner/check-account - Kiểm tra tài khoản đã có mật khẩu chưa
app.post("/api/partner/check-account", async (req, res) => {
  try {
    const { phone, email } = req.body;
    const query = phone ? { phone: normalizePhone(phone) } : { email: email?.toLowerCase().trim() };
    const models = [
      { model: GiatLa,      module: "giat_la" },
      { model: GiupViec,    module: "giup_viec" },
      { model: ChinaShop,   module: "china_shop" },
      { model: FoodPartner, module: "food_partner" },
      { model: RideDriver,  module: "ride_driver" },
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
      { model: GiatLa,      key: "giat_la" },
      { model: GiupViec,    key: "giup_viec" },
      { model: ChinaShop,   key: "china_shop" },
      { model: FoodPartner, key: "food_partner" },
      { model: RideDriver,  key: "ride_driver" },
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
        if (p.status === 'rejected') {
          return res.status(403).json({ success: false, status: 'rejected', message: "Tài khoản bị từ chối" });
        }
        req.session.userPhone = p.phone;
        req.session.partnerId = p._id;
        req.session.partnerModule = module;
        req.session.role = "partner";
        pruneSessionRoles(req, 'partner');
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
app.post("/api/auth/admin-login", requireApp, async (req, res) => {
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
  try { await loadSessionFromHeader(req, res); } catch(_) {}
  if (req.session.role === "shipper" && req.session.shipperId) {
    const shipper = await Shipper.findById(req.session.shipperId);
    return res.json({ success: true, role: "shipper", shipper });
  }
  if (req.session.role === "partner" && req.session.partnerId) {
    // FIX: tài khoản nhiều module — ưu tiên FoodPartner theo phone
    const foodPartner = await getSessionFoodPartner(req);
    if (foodPartner) {
      return res.json({ success: true, role: "partner", partner: foodPartner, module: "food_partner" });
    }
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
  try { await loadSessionFromHeader(req, res); } catch(_) {}
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
      .sort({ createdAt: -1 }).limit(50).select("-__v").lean();
    // FIX: Enrich discount fields để frontend hiển thị đúng giá sau voucher
    const enriched = orders.map(o => ({
      ...o,
      discount: o.discount || 0,
      voucherCode: o.voucherCode || null,
      voucherDiscount: o.voucherDiscount || 0,
      finalTotal: o.finalTotal ?? Math.max(0, (o.total||0) + (o.shipFee||0) + (o.serviceFee||0) - (o.discount||0)),
    }));
    res.json({ success: true, data: enriched });
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
    const { module = "food", items, address, district, paymentMethod, note, customerId, addressLat, addressLng, partnerLat, partnerLng, partnerName, partnerAddress } = req.body;

    const uid = customerId || req.session.userId;
    if (!uid) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });

    // Tính tổng
    const total = (items || []).reduce((s, i) => s + i.price * i.qty, 0);
    const shipFee = total >= 150000 ? 0 : 15000;
    const serviceFee = Math.round(total * 0.02);

    const order = await Order.create({
      module, customerId: uid, items, address, district,
      addressLat: addressLat || null, addressLng: addressLng || null,
      partnerLat: partnerLat || null, partnerLng: partnerLng || null,
      partnerName: partnerName || null, partnerAddress: partnerAddress || null,
      total, shipFee, serviceFee,
      paymentMethod: paymentMethod || "cash",
      paymentStatus: (paymentMethod || "cash") === "wallet" ? "paid" : "unpaid",
      note,
      statusHistory: [{ status: "pending", time: new Date(), by: "system" }]
    });

    // WALLET: trừ tiền ví CRABOR khách ngay khi đặt
    if ((paymentMethod || "cash") === "wallet") {
      const orderAmount = order.finalTotal ?? Math.max(0, total + shipFee + serviceFee);
      const userDoc = await User.findById(uid).select("walletBalance");
      if (!userDoc || (userDoc.walletBalance||0) < orderAmount) {
        await Order.findByIdAndDelete(order._id);
        return res.status(400).json({ success: false, message: `Ví CRABOR không đủ số dư. Cần ${orderAmount.toLocaleString("vi-VN")}đ`, walletInsufficient: true });
      }
      await walletDebit(uid, "user", orderAmount, "debit", order.orderId, `Thanh toán đơn ${order.orderId} bằng ví CRABOR`);
      req.io.to(`customer_${uid}`).emit("walletDebited", { amount: orderAmount, orderId: order.orderId });
    }

    // Realtime: thông báo admin và shipper
    req.io.to("admin").emit("newOrder", { orderId: order.orderId, module, total: order.finalTotal });
    req.io.to("shippers").emit("newOrderAvailable", { orderId: order.orderId, district, total: order.finalTotal });
    notifyDiscord("pending", order);

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
      Order.find(filter).sort({ createdAt: -1 }).skip((page-1)*limit).limit(Number(limit)).lean(),
      Order.countDocuments(filter)
    ]);
    // Đảm bảo mọi order đều có field discount/finalTotal
    const enriched = data.map(o => ({
      ...o,
      discount: o.discount || 0,
      voucherCode: o.voucherCode || null,
      voucherDiscount: o.voucherDiscount || 0,
      finalTotal: o.finalTotal ?? Math.max(0, (o.total||0) + (o.shipFee||0) + (o.serviceFee||0) - (o.discount||0)),
    }));
    res.json({ success: true, total, page: Number(page), data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/orders/:id
app.get("/api/orders/:id", async (req, res) => {
  try {
    const idParam = req.params.id;
    const query = { $or: [
      { orderId: idParam },
      ...(mongoose.isValidObjectId(idParam) ? [{ _id: idParam }] : [])
    ]};
    const order = await Order.findOne(query).lean();
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });
    // Enrich với shipper info (avatar, fullName, phone, vehiclePlate)
    let shipperInfo = null;
    if (order.shipperId) {
      try {
        const sh = await Shipper.findById(order.shipperId).select("fullName phone vehiclePlate avatar location documents").lean();
        if (sh) {
          shipperInfo = {
            _id: sh._id,
            fullName: sh.fullName,
            phone: sh.phone,
            vehiclePlate: sh.vehiclePlate,
            avatar: sh.avatar || sh.documents?.selfie || null,
            location: sh.location || null,
          };
        }
      } catch(_) {}
    }
    // Đảm bảo discount/finalTotal luôn có giá trị để frontend 3 app nhất quán
    const enrichedOrder = {
      ...order,
      discount: order.discount || 0,
      voucherCode: order.voucherCode || null,
      voucherDiscount: order.voucherDiscount || 0,
      finalTotal: order.finalTotal ?? Math.max(0, (order.total||0) + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0)),
    };
    res.json({ success: true, order: { ...enrichedOrder, shipperInfo }, data: { ...enrichedOrder, shipperInfo } });
  } catch(err) {
    console.error('[GET /api/orders/:id] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/orders/:id/cancel — Customer hủy đơn hàng food/general
app.patch("/api/orders/:id/cancel", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.userId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    const idParam = req.params.id;
    const query = { $or: [
      { orderId: idParam, customerId: req.session.userId },
      ...(mongoose.isValidObjectId(idParam) ? [{ _id: idParam, customerId: req.session.userId }] : [])
    ]};
    const order = await Order.findOne(query);
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    const cancellableStatuses = ["pending", "confirmed", "preparing", "shipper_accepted"];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ success: false, message: "Không thể hủy đơn ở trạng thái này (shipper đã lấy hàng)" });
    }

    const reason = req.body.reason || "Khách hàng hủy đơn";
    
    // Tăng cancelCount + trừ điểm tin cậy (hủy đơn làm giảm uy tín); block COD nếu >= 2 lần
    const user = await User.findById(req.session.userId);
    const newCount = (user?.cancelCount || 0) + 1;
    const willBlock = newCount >= 2;
    await adjustTrust(req.session.userId, { trust: -15, cancelCount: 1 });
    await User.findByIdAndUpdate(req.session.userId, {
      ...(willBlock ? { cashBlocked: true } : {}),
    });
    
    order.status = "cancelled";
    order.cancelReason = reason;
    order.cancelledAt = new Date();
    order.statusHistory.push({ status: "cancelled", by: "customer", time: new Date() });
    await order.save();
    notifyDiscord("cancelled", order);

    // Hoàn tiền ví / gỡ ví trả sau khi khách hủy
    try { await refundOnCancel(order); } catch(e) { console.error('[Cancel] refundOnCancel lỗi:', e.message); }

    // Notify shipper nếu đã assigned
    if (order.shipperId) {
      req.io.to(`shipper_${order.shipperId}`).emit("order_cancelled", {
        orderId: order.orderId,
        message: "Khách hàng đã hủy đơn hàng",
        cancelReason: order.cancelReason || null,
      });
    }
    // Notify partner
    if (order.partnerId) {
      req.io.to(`partner_${order.partnerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "cancelled",
        message: `Khách hủy: ${reason}`,
        cancelReason: order.cancelReason || reason || null,
      });
    }

    const cashBlocked = newCount >= 2;
    console.log(`[Cancel Order] ${order.orderId} cancelled by customer ${req.session.userId}. TotalCancel=${newCount}`);
    res.json({ success: true, message: "Đã hủy đơn hàng thành công", cashBlocked, cancelCount: newCount });
  } catch (err) {
    console.error('[PATCH /api/orders/:id/cancel] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
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
      Order.find(matchBase).select("orderId deliveryFee finalTotal status deliveredAt createdAt module total discount voucherShipperBear").lean(),
      Order.find({ ...matchPeriod, status: "delivered" }).select("orderId deliveryFee finalTotal deliveredAt module total discount voucherShipperBear").lean(),
      Order.find({ ...matchBase, status: "delivered", deliveredAt: { $gte: (() => { const d=new Date(); d.setHours(0,0,0,0); return d; })() } }).select("deliveryFee module total discount voucherShipperBear").lean(),
    ]);

    // Thu nhập thực nhận đã trừ phần shipper gánh voucher (CRABOR trung gian không chịu)
    const totalEarnings   = allOrders.filter(o=>o.status==="delivered").reduce((s,o) => s + shipperOrderEarnNet(o), 0);
    const periodEarnings  = periodOrders.reduce((s,o) => s + shipperOrderEarnNet(o), 0);
    const todayEarnings   = todayOrders.reduce((s,o) => s + shipperOrderEarnNet(o), 0);
    const allDone         = allOrders.filter(o=>o.status==="delivered").length;
    const allCancelled    = allOrders.filter(o=>o.status==="cancelled").length;

    const transactions = periodOrders.map(o => ({
      type: "delivery",
      label: "Phí giao hàng",
      orderId: o.orderId,
      amount: shipperOrderEarnNet(o),
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

// GET /api/shipper/cash-stats — Thống kê tiền mặt shipper cần nộp CRABOR (35%)
app.get("/api/shipper/cash-stats", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.shipperId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const CRABOR_FEE_RATE = 0.15; // 15%
    const shipperId = req.session.shipperId;
    // Lấy đơn tiền mặt đã giao (chưa nộp phí)
    const cashOrders = await Order.find({
      shipperId,
      paymentMethod: "cash",
      status: "delivered",
    }).select("orderId finalTotal total deliveredAt createdAt customerName module").lean();
    const totalCash = cashOrders.reduce((s, o) => s + (o.finalTotal || o.total || 0), 0);
    const feeDue = Math.round(totalCash * CRABOR_FEE_RATE);
    // Tìm những đơn đã nộp phí (có trong cashFeeLog)
    const paidLog = await mongoose.models.CashFeeLog
      ? await mongoose.models.CashFeeLog.find({ shipperId }).lean()
      : [];
    const paidOrderIds = new Set(paidLog.flatMap(l => l.orderIds || []));
    const unpaidOrders = cashOrders.filter(o => !paidOrderIds.has(o.orderId));
    const unpaidTotal = unpaidOrders.reduce((s, o) => s + (o.finalTotal || o.total || 0), 0);
    const unpaidFee = Math.round(unpaidTotal * CRABOR_FEE_RATE);
    res.json({
      success: true,
      summary: {
        totalCashOrders: cashOrders.length,
        totalCashAmount: totalCash,
        totalFeeDue: feeDue,
        unpaidOrders: unpaidOrders.length,
        unpaidAmount: unpaidTotal,
        unpaidFee,
        feeRate: CRABOR_FEE_RATE * 100,
      },
      orders: unpaidOrders.map(o => ({
        orderId: o.orderId,
        amount: o.finalTotal || o.total,
        fee: Math.round((o.finalTotal || o.total) * CRABOR_FEE_RATE),
        deliveredAt: o.deliveredAt || o.createdAt,
        customerName: o.customerName,
        module: o.module,
      })),
      qrInfo: {
        bankName: SEPAY_CONFIG.bankName,
        bankCode: SEPAY_CONFIG.bankCode,
        accountNo: SEPAY_CONFIG.accountNo,
        accountName: SEPAY_CONFIG.accountName,
        transferNote: `PHICRABOR ${String(shipperId).slice(-8).toUpperCase()} ${new Date().toLocaleDateString("vi-VN").replace(/\//g,"")}`,
        note: "Đây là tài khoản cá nhân chính thức của cty. Chúng tôi sẽ sớm ra mắt tài khoản doanh nghiệp trong thời gian tới. Cảm ơn bạn đã tin tưởng và sử dụng dịch vụ.",
      },
    });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/pay-cash-fee — Shipper xác nhận đã nộp phí tiền mặt
app.post("/api/shipper/pay-cash-fee", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session.shipperId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const shipperId = req.session.shipperId;
    const CRABOR_FEE_RATE = 0.15;
    const { method = "payos", orderIds } = req.body;
    // Lấy đơn cần nộp phí
    const query = { shipperId, paymentMethod: "cash", status: "delivered" };
    if (orderIds?.length) query.orderId = { $in: orderIds };
    const cashOrders = await Order.find(query).lean();
    const totalCash = cashOrders.reduce((s, o) => s + (o.finalTotal || o.total || 0), 0);
    const feeDue = Math.round(totalCash * CRABOR_FEE_RATE);
    if (feeDue <= 0) return res.status(400).json({ success: false, message: "Không có phí cần thanh toán" });
    // Tạo QR thanh toán
    const shipper = await Shipper.findById(shipperId).select("fullName phone");
    const transferNote = `PHICRABOR ${String(shipperId).slice(-8).toUpperCase()}`;
    const qrUrl = sepayQrUrl(feeDue, transferNote);
    const vietqrUrl = vietQrUrl(feeDue, transferNote);
    let payosUrl = null;
    if (method === "payos" && payOS) {
      try {
        const orderCode = parseInt(Date.now().toString().slice(-9));
        const link = await (payOS.createPaymentLink || payOS.paymentRequests?.create?.bind(payOS.paymentRequests))({
          orderCode,
          amount: feeDue,
          description: `PHI ${String(shipperId).slice(-6).toUpperCase()}`,
          returnUrl: `${process.env.BASE_URL || ""}/payment/success`,
          cancelUrl: `${process.env.BASE_URL || ""}/payment/cancel`,
          buyerName: shipper?.fullName,
          buyerPhone: shipper?.phone,
        });
        payosUrl = link?.checkoutUrl;
      } catch(e) { console.warn("[PayCashFee] PayOS err:", e.message); }
    }
    // Thông báo admin
    req.io.to("admin").emit("shipper_fee_payment", {
      shipperId: String(shipperId),
      shipperName: shipper?.fullName,
      amount: feeDue,
      method,
      orderCount: cashOrders.length,
      timestamp: new Date().toISOString(),
    });
    res.json({
      success: true,
      feeDue,
      orderCount: cashOrders.length,
      qrUrl,
      vietqrUrl,
      payosUrl,
      bankName: SEPAY_CONFIG.bankName,
      bankCode: SEPAY_CONFIG.bankCode,
      accountNo: SEPAY_CONFIG.accountNo,
      accountName: SEPAY_CONFIG.accountName,
      transferNote,
      note: "Đây là tài khoản cá nhân chính thức của cty. Chúng tôi sẽ sớm ra mắt tài khoản doanh nghiệp. Cảm ơn bạn đã tin tưởng!",
    });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
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
    // Early Bird: check dynamic max + price from Config
    const ebMax    = await getConfig("earlyBirdMax", 50);
    const ebPrice  = await getConfig("earlyBirdPrice", 500000);
    const ebCount = await Shipper.countDocuments({ plan: "early_bird" });
    const plan = ebCount < ebMax ? "early_bird" : "standard";

    const documents = await uploadImageFields(req.body.documents || {}, "docs");
    // workType: tick "đăng ký dọn nhà" lúc đăng ký → tài khoản CHỈ NHẬN DỌN NHÀ;
    // đăng ký shipper thường → tự động bật cả 3 module (đồ ăn, giặt là, xe công nghệ)
    const isCleaningAccount = req.body.cleaningRegistered === true;
    const shipper = await Shipper.create({
      phone, firstName, lastName, email, dob, address, district, vehicle,
      plan, fee: plan === "early_bird" ? ebPrice : 700000,
      status: "pending", documents,
      workType: isCleaningAccount ? "cleaning" : "shipper",
      preferences: isCleaningAccount
        ? { acceptFood: false, acceptLaundry: false, acceptRide: false, acceptCleaning: true, cleaningRegistered: true }
        : { acceptFood: true, acceptLaundry: true, acceptRide: true, acceptCleaning: false },
    });

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
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const products = await Product.find({ partnerId: partner._id }).sort({ createdAt: -1 });
    res.json({ success: true, items: products });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// POST /api/partner/menu — thêm món
app.post("/api/partner/menu", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    if (partner.blockedUntil && new Date(partner.blockedUntil).getTime() > Date.now())
      return res.status(403).json({ success:false, blocked:true, code:"PARTNER_BLOCKED", until: partner.blockedUntil.getTime(), reason: partner.blockReason || "", message:`Quán đã bị khóa đến ${new Date(partner.blockedUntil).toLocaleString('vi-VN')} vì vi phạm chính sách. Không thể thay đổi thực đơn.` });
    const { name, price, category, description, available, image } = req.body;
    if (!name || !price) return res.status(400).json({ success:false, message:"Thiếu tên hoặc giá" });
    const item = await Product.create({
      partnerId: partner._id,
      name: name.trim(), price: Number(price),
      category: category?.trim() || "Khác",
      description: description?.trim() || "",
      available: available !== false,
      image: (await uploadImageToCloudinary(image, "menu")) || "",
    });
    await notifyUser('partner', partner._id, {
      type: 'product', title: '🍽️ Món mới đã thêm',
      body: `"${item.name}" giá ${Number(price).toLocaleString('vi-VN')}đ đã có trên menu`,
      ref: String(item._id), refModule: 'food',
    });
    res.json({ success: true, item });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// PATCH /api/partner/menu/:id — sửa món
app.patch("/api/partner/menu/:id", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    if (partner.blockedUntil && new Date(partner.blockedUntil).getTime() > Date.now())
      return res.status(403).json({ success:false, blocked:true, code:"PARTNER_BLOCKED", until: partner.blockedUntil.getTime(), reason: partner.blockReason || "", message:`Quán đã bị khóa đến ${new Date(partner.blockedUntil).toLocaleString('vi-VN')} vì vi phạm chính sách. Không thể thay đổi thực đơn.` });
    const body = { ...req.body };
    if (body.image) body.image = await uploadImageToCloudinary(body.image, "menu");
    const item = await Product.findOneAndUpdate(
      { _id: req.params.id, partnerId: partner._id },
      body, { new: true }
    );
    if (!item) return res.status(404).json({ success:false, message:"Không tìm thấy món" });
    res.json({ success: true, item });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// DELETE /api/partner/menu/:id — xóa món
app.delete("/api/partner/menu/:id", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    if (partner.blockedUntil && new Date(partner.blockedUntil).getTime() > Date.now())
      return res.status(403).json({ success:false, blocked:true, code:"PARTNER_BLOCKED", until: partner.blockedUntil.getTime(), reason: partner.blockReason || "", message:`Quán đã bị khóa đến ${new Date(partner.blockedUntil).toLocaleString('vi-VN')} vì vi phạm chính sách. Không thể thay đổi thực đơn.` });
    await Product.findOneAndDelete({ _id: req.params.id, partnerId: partner._id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// GET /api/partner/orders — lấy đơn hàng của partner
app.get("/api/partner/orders", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const orders = await Order.find({ partnerId: partner._id })
      .sort({ createdAt: -1 }).limit(100).lean();
    // Đảm bảo mọi order đều có field discount/finalTotal để partner app hiển thị nhất quán
    const enriched = orders.map(o => ({
      ...o,
      discount: o.discount || 0,
      voucherCode: o.voucherCode || null,
      voucherDiscount: o.voucherDiscount || 0,
      finalTotal: o.finalTotal ?? Math.max(0, (o.total||0) + (o.shipFee||0) + (o.serviceFee||0) - (o.discount||0)),
    }));
    // Nối vị trí realtime của tài xế đang nhận đơn để partner app vẽ đường shipper → quán trên bản đồ
    const shipperIds = [...new Set(orders.map(o => o.shipperId).filter(Boolean))];
    const shippers = shipperIds.length
      ? await Shipper.find({ _id: { $in: shipperIds } }).select("location fullName firstName lastName").lean().catch(() => [])
      : [];
    const shipperById = {};
    shippers.forEach(sh => { shipperById[String(sh._id)] = sh; });
    const mapped = enriched.map(o => {
      const sh = o.shipperId ? shipperById[String(o.shipperId)] : null;
      return {
        ...o,
        shipperLocation: sh?.location?.lat != null && sh.location.lng != null
          ? { latitude: sh.location.lat, longitude: sh.location.lng }
          : null,
        shipperName: sh ? (sh.fullName || [sh.firstName, sh.lastName].filter(Boolean).join(" ") || "Shipper") : null,
      };
    });
    res.json({ success: true, orders: mapped });
  } catch(err) { res.status(500).json({ success:false, message: err.message }); }
});

// GET /api/partner/ratings — Tất cả đánh giá khách hàng đã cho quán
app.get("/api/partner/ratings", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const ratedOrders = await Order.find({ partnerId: partner._id, ratingPartner: { $exists: true, $ne: null } })
      .sort({ ratedAt: -1 })
      .select("orderId ratingPartner ratingComment ratedAt items customerName customerPhone")
      .lean();
    const reviews = ratedOrders.map(o => ({
      orderId: o.orderId,
      rating: o.ratingPartner,
      comment: o.ratingComment || '',
      date: o.ratedAt,
      customerName: o.customerName || 'Khách hàng',
      customerPhone: o.customerPhone || '',
      orderInfo: (o.items || []).map(i => `${i.qty}× ${i.name}`).join(', '),
    }));
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviews.forEach(r => { if (r.rating >= 1 && r.rating <= 5) distribution[r.rating]++; });
    res.json({ success: true, averageRating: partner.rating || 5, totalRatings: partner.ratingCount || 0, reviews, distribution });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/partner/banner — Đăng tải ảnh banner quán
app.patch("/api/partner/banner", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const { coverImage } = req.body || {};
    if (!coverImage || coverImage.length < 50) return res.status(400).json({ success: false, message: "Thiếu ảnh banner" });
    const coverUp = await uploadImageToCloudinary(coverImage, "shop");
    await FoodPartner.findByIdAndUpdate(partner._id, { coverImage: coverUp });
    res.json({ success: true, coverImage: coverUp });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// PATCH /api/partner/orders/:id — Partner xác nhận / từ chối đơn hàng
// Partner app gọi { action: 'accept' | 'reject' }
app.patch("/api/partner/orders/:id", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner)
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const partnerId = partner._id;

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
    if (order.partnerId && order.partnerId.toString() !== partnerId.toString())
      return res.status(403).json({ success: false, message: "Bạn không có quyền thao tác đơn này" });

    if (action === "accept") {
      order.status = "confirmed";
      order.confirmedAt = new Date();
      order.statusHistory.push({ status: "confirmed", by: "partner", time: new Date() });
      notifyDiscord("confirmed", order);
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
                total: order.total,
                finalTotal: order.finalTotal,
                discount: order.discount || 0,
                voucherCode: order.voucherCode,
                voucherDiscount: order.voucherDiscount || 0,
                shipFee: order.shipFee || 0,
                serviceFee: order.serviceFee || 0,
                pickupAddress: order.partnerAddress || "Địa chỉ quán",
                pickupLat, pickupLng,
                deliveryAddress: order.address,
                deliveryLat: order.addressLat || null,
                deliveryLng: order.addressLng || null,
                note: order.note,
                customerName: order.customerName,
                customerPhone: order.customerPhone,
                module: order.module || 'food',
                partnerName: order.partnerName || "Cửa hàng",
              },
              timeout: 30,
            };
            for (const shipper of nearbyShippers) {
              req.io.to(`shipper_${shipper._id}`).emit("order_request", payload);
              await notifyUser('shipper', shipper._id, {
                type: 'new_order', title: '🚚 Đơn hàng mới!',
                body: `Đơn #${(payload.order?.orderId || order.orderId || '').slice(-6)} cần giao`,
                ref: String(order._id), refModule: 'food',
              });
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
      notifyDiscord("cancelled", order);
      if (note) order.partnerNote = note;
      if (note) order.cancelReason = note;
      else if (!order.cancelReason) order.cancelReason = "Quán đã từ chối đơn hàng";

      // Thông báo customer
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId || order._id,
        status: "cancelled",
        message: note ? `Rất tiếc, quán đã từ chối đơn hàng của bạn. Lý do: ${note}` : "Rất tiếc, quán đã từ chối đơn hàng của bạn.",
        cancelReason: order.cancelReason,
      });

      await order.save();
      return res.json({ success: true, status: "cancelled", message: "Đã từ chối đơn" });
    }
  } catch (err) {
    console.error("[PATCH /api/partner/orders/:id] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/partner/orders/:id — Chi tiết đơn cho partner (mã đơn, thời gian, tiền món, phí nền tảng, TT, tổng thực nhận)
app.get("/api/partner/orders/:id", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner)
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    const partnerId = partner._id;

    const order = await Order.findOne({
      $or: [
        { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null },
        { orderId: req.params.id },
      ]
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });
    if (order.partnerId && order.partnerId.toString() !== partnerId.toString())
      return res.status(403).json({ success: false, message: "Bạn không có quyền xem đơn này" });

    const e = await calcEarnings(order).catch(() => null);
    const shipFee = order.shipFee || 0;
    const serviceFee = order.serviceFee || 0;
    const partnerBase = Math.max(0, order.total || 0);
    const commissionPct = e?.commissionPct || 0;
    const platformFee = Math.round(partnerBase * commissionPct / 100);

    res.json({
      success: true,
      order: {
        _id: order._id, orderId: order.orderId, module: order.module, status: order.status,
        createdAt: order.createdAt, deliveredAt: order.deliveredAt,
        total: order.total || 0, discount: order.discount || 0,
        finalTotal: order.finalTotal || order.total || 0,
        items: order.items || [], customerName: order.customerName,
        customerPhone: order.customerPhone, address: order.address, note: order.note,
        paymentMethod: order.paymentMethod || "cash",
        paymentStatus: order.paymentStatus || (order.isPaid ? "paid" : "unpaid"),
        shipFee, serviceFee,
        partnerEarn: e?.partnerEarn || Math.round(partnerBase * (1 - commissionPct/100)),
        platformFee, commissionPct,
      },
    });
  } catch (err) {
    console.error("[GET /api/partner/orders/:id] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/partner/stats
app.get("/api/partner/stats", async (req, res) => {
  try {
    const partner = await getSessionFoodPartner(req);
    if (!partner) return res.status(401).json({ success:false, message:"Chưa đăng nhập" });
    const pid = partner._id;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [todayOrders, monthOrders, allOrders, recentOrders] = await Promise.all([
      Order.find({ partnerId:pid, createdAt:{$gte:todayStart}, status:"delivered" }),
      Order.find({ partnerId:pid, createdAt:{$gte:monthStart}, status:"delivered" }),
      Order.find({ partnerId:pid, status:"delivered" }).limit(500),
      Order.find({ partnerId:pid }).sort({ createdAt:-1 }).limit(30),
    ]);
    const cancelled = await Order.countDocuments({ partnerId:pid, status:"cancelled" });

    const sumEarnings = async (orders) => {
      let s = 0;
      for (const o of orders) { try { s += (await calcEarnings(o)).partnerEarn; } catch(e) { s += 0; } }
      return s;
    };
    const todayRevenue = await sumEarnings(todayOrders);
    const monthRevenue = await sumEarnings(monthOrders);
    const avgOrderValue = allOrders.length ? allOrders.reduce((s,o)=>s+(o.total||0),0)/allOrders.length : 0;

    // Lịch sử đơn kèm chi tiết phí — KHÔNG hiển thị phí ship
    const recentOrdersOut = [];
    for (const o of recentOrders) {
      const e = await calcEarnings(o).catch(() => null);
      const shipFee = o.shipFee || 0;
      const serviceFee = o.serviceFee || 0;
      const finalTotal = o.finalTotal || o.total || 0;
      // FIX: Platform chịu discount → partnerBase = originalTotal (không trừ discount)
      const partnerBase = Math.max(0, o.total || 0);
      const commissionPct = e?.commissionPct || 0;
      const platformFee = Math.round(partnerBase * commissionPct / 100);
      recentOrdersOut.push({
        _id: o._id, orderId: o.orderId, module: o.module, status: o.status,
        createdAt: o.createdAt, deliveredAt: o.deliveredAt,
        total: o.total || 0, discount: o.discount || 0, finalTotal,
        items: o.items || [], customerName: o.customerName,
        customerPhone: o.customerPhone, address: o.address, note: o.note,
        paymentMethod: o.paymentMethod || "cash",
        paymentStatus: o.paymentStatus || (o.isPaid ? "paid" : "unpaid"),
        shipFee, serviceFee: o.serviceFee || 0,
        partnerEarn: e?.partnerEarn || Math.round(partnerBase * (1 - commissionPct/100)),
        platformFee,
        commissionPct,
      });
    }

    res.json({
      success:true, todayRevenue, monthRevenue,
      todayOrders:todayOrders.length, cancelledOrders:cancelled,
      avgOrderValue, avgRating:"5.0",
      recentOrders: recentOrdersOut,
    });
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
      documents: await uploadImageFields(req.body.documents || {}, "docs"),
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

    await sendSms(phone,
      `CRABOR: Ho so doi tac ${modName} (${partner.registerId}) da duoc tiep nhan. Chung toi se lien he trong 24-48h.`).catch(() => {});

    // Nếu là Dọn nhà / Giúp việc và đã có tài khoản Shipper cùng SĐT → mở khoá nhận đơn dọn nhà
    if (mod === "giup_viec") {
      await Shipper.updateOne(
        { phone: normalizePhone(phone) },
        { $set: { "preferences.cleaningRegistered": true } }
      ).catch(() => {});
    }

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

// GET /api/ride/nearby-shippers — Shipper online gần điểm đón (cho bản đồ realtime)
app.get("/api/ride/nearby-shippers", async (req, res) => {
  try {
    const { lat, lng, radiusKm = 10, limit = 30 } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: "Thiếu tọa độ" });
    }
    const pLat = parseFloat(lat), pLng = parseFloat(lng);
    const maxRadius = Math.min(Math.max(parseFloat(radiusKm) || 10, 1), 50);
    const maxLimit = Math.min(Math.max(parseInt(limit) || 30, 1), 100);

    const shippers = await Shipper.find({
      status: { $in: ["approved", "active"] },
      online: true,
      isAccepting: true,
      "location.lat": { $exists: true, $ne: null },
      "location.lng": { $exists: true, $ne: null },
    })
      .select("fullName vehicle vehiclePlate location rating ratingCount totalOrders avatar tier")
      .lean();

    const R = 6371;
    const list = shippers
      .map(s => {
        if (!s.location?.lat || !s.location?.lng) return null;
        const dLat = (s.location.lat - pLat) * Math.PI / 180;
        const dLng = (s.location.lng - pLng) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
          Math.cos(pLat * Math.PI/180) * Math.cos(s.location.lat * Math.PI/180) * Math.sin(dLng/2)**2;
        const distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return {
          id: String(s._id),
          name: s.fullName || "",
          vehicle: s.vehicle || "motorbike",
          plate: s.vehiclePlate || "",
          lat: s.location.lat,
          lng: s.location.lng,
          rating: s.rating || 0,
          ratingCount: s.ratingCount || 0,
          totalOrders: s.totalOrders || 0,
          distKm: Math.round(distKm * 10) / 10,
        };
      })
      .filter(Boolean)
      .filter(s => s.distKm <= maxRadius)
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, maxLimit);

    res.json({ success: true, count: list.length, shippers: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
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

    // Hoàn tiền ví / gỡ ví trả sau khi khách huỷ chuyến
    try { await refundOnCancel(order); } catch(e) { console.error('[Cancel Ride] refundOnCancel lỗi:', e.message); }

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
    const {
      serviceId, serviceName, price, duration, address,
      addressLat, addressLng,
      lat, lng,                            // fallback từ client cũ
      bookingDate, bookingTime,
      date, time,                          // fallback từ client cũ
      note, paymentMethod,
      receiverName, receiverPhone, total,
      voucherCode,
    } = req.body;
    const finalDate   = bookingDate || date;
    const finalTime   = bookingTime || time || "08:00";
    const finalLat    = addressLat  || lat  || null;
    const finalLng    = addressLng  || lng  || null;
    if (!serviceId || !address || !finalDate) {
      return res.status(400).json({ success: false, message: "Thiếu thông tin: cần serviceId, address, date" });
    }
    const user = await User.findById(customerId).select("fullName phone cashBlocked");
    const pmCleaning = paymentMethod || "cash";
    if (pmCleaning === "cash" && user?.cashBlocked) {
      return res.status(403).json({ success: false, message: "Bạn đã hủy đơn quá 2 lần. Vui lòng dùng PayOS, SePay hoặc ví CRABOR.", cashBlocked: true });
    }
    // ── ÁP VOUCHER (trước đây bị bỏ qua → khách xem giảm giá nhưng không được trừ) ──
    const servicePrice = Number(price) || 200000;
    const { discount: cleaningDiscount, applied: appliedVoucher } = await applyVoucher(voucherCode, { order: servicePrice, ship: 0 }, customerId, "cleaning");
    const finalPrice = Math.max(0, servicePrice - cleaningDiscount);
    const order = new CleaningOrder({
      customerId,
      customerName: receiverName || user?.fullName || "Khách hàng",
      customerPhone: receiverPhone || user?.phone,
      address,
      addressLat: finalLat,
      addressLng: finalLng,
      serviceType: serviceId,
      serviceName,
      price: servicePrice,
      discount: cleaningDiscount,
      voucherCode,
      voucherDiscount: cleaningDiscount,
      duration: duration || "2-3 tiếng",
      note,
      bookingDate: new Date(finalDate),
      bookingTime: finalTime,
      paymentMethod: pmCleaning,
      status: "pending",
      statusHistory: [{ status: "pending", by: "customer", time: new Date() }],
    });
    await order.save();
    // WALLET: trừ tiền ví CRABOR ngay khi đặt đơn dọn nhà (đã trừ discount)
    if (pmCleaning === "wallet") {
      const amt = order.finalTotal ?? finalPrice;
      const userDoc = await User.findById(customerId).select("walletBalance");
      if (!userDoc || (userDoc.walletBalance||0) < amt) {
        await CleaningOrder.findByIdAndDelete(order._id);
        if (appliedVoucher) await Voucher.updateOne({ _id: appliedVoucher._id }, { $inc: { usedCount: -1 }, $pull: { usedBy: customerId } }).catch(() => {});
        return res.status(400).json({ success: false, message: `Ví CRABOR không đủ số dư. Cần ${amt.toLocaleString("vi-VN")}đ`, walletInsufficient: true });
      }
      order.paymentStatus = "paid";
      order.paidAt = new Date();
      await order.save();
      await walletDebit(customerId, "user", amt, "debit", order.orderId, `Thanh toán đơn dọn nhà ${order.orderId} bằng ví CRABOR`);
      req.io.to(`customer_${customerId}`).emit("walletDebited", { amount: amt, orderId: order.orderId });
    }
    let nearbyShippers = [];
    try {
      // Dọn nhà: ưu tiên shipper online + đã mở khoá/nhận đơn dọn nhà
      // Có GPS → mở rộng bán kính dần; không có GPS → tìm trong lệnh chung
      const cleaningQ = {
        status: { $in: ["approved", "active"] },
        online: true,
        isAccepting: true,
        $or: [
          { "preferences.acceptCleaning": true },
          { "preferences.cleaningRegistered": true },
        ],
      };
      if (addressLat && addressLng) {
        nearbyShippers = await findCleaningShippers(addressLat, addressLng, 5, 10);
      } else {
        const all = await Shipper.find(cleaningQ).select("_id phone fullName location pushToken walletBalance rating totalOrders").limit(20);
        nearbyShippers = all;
      }
      // Fallback: không có shipper dọn nhà online → gửi cho mọi shipper online để không sót đơn
      if (!nearbyShippers.length) {
        const anyQ = {
          status: { $in: ["approved", "active"] },
          online: true,
          isAccepting: true,
        };
        const any = await Shipper.find(anyQ).select("_id phone fullName location pushToken walletBalance rating totalOrders").limit(10);
        nearbyShippers = any;
        console.log(`[Cleaning] No cleaning-registered shipper online, fallback dispatch to ${any.length} online shippers`);
      }
      const blockedIds = await getCashBlockedShipperIds(nearbyShippers.map(s => s._id));
      if (blockedIds.size) nearbyShippers = nearbyShippers.filter(s => !blockedIds.has(String(s._id)));
    } catch(e) { console.error('[Cleaning] dispatch error:', e.message); }
    const payload = {
      type: "cleaning_request",
      orderId: order.orderId,
      order: {
        _id: order._id, orderId: order.orderId, serviceName: order.serviceName,
        module: 'cleaning',
        price: order.price, discount: order.discount || 0, finalTotal: order.finalTotal ?? Math.max(0, (order.price||0) - (order.discount||0)),
        duration: order.duration, address: order.address,
        addressLat: order.addressLat, addressLng: order.addressLng,
        bookingDate: order.bookingDate, bookingTime: order.bookingTime,
        note: order.note, customerName: order.customerName,
        customerPhone: order.customerPhone || "",
      },
      timeout: 30,
    };
    for (const shipper of nearbyShippers) {
      req.io.to(`shipper_${shipper._id}`).emit("order_request", payload);
      console.log(`[Cleaning] Dispatched to shipper ${shipper._id}`);
    }
    res.status(201).json({
      success: true, orderId: order.orderId,
      discount: order.discount || 0,
      finalTotal: order.finalTotal ?? finalPrice,
      message: cleaningDiscount > 0 ? `Đã áp voucher tiết kiệm ${cleaningDiscount.toLocaleString("vi-VN")}đ` : undefined,
    });
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
    // Hoàn tiền ví / gỡ ví trả sau khi khách hủy
    try { await refundOnCancel(order); } catch(e) { console.error('[Cancel Cleaning] refundOnCancel lỗi:', e.message); }
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
      // ── 2 SHIPPER CÙNG BẤM: giữ lại người GẦN KHÁCH HÀNG hơn ──
      // Chỉ áp dụng khi người giữ hiện tại chưa bắt đầu làm gì (pending/accepted)
      const canSteal = ["pending", "accepted"].includes(order.status);
      let transferred = false;
      if (canSteal && order.addressLat != null) {
        try {
          const [meDoc, curDoc] = await Promise.all([
            Shipper.findById(shipperId).select("location").lean(),
            Shipper.findById(order.shipperId).select("location").lean(),
          ]);
          const distTo = (s) => (s?.location?.lat != null)
            ? Math.hypot(s.location.lat - order.addressLat, (s.location.lng || 0) - (order.addressLng || 0))
            : null;
          const dMe = distTo(meDoc), dCur = distTo(curDoc);
          if (dMe != null && (dCur == null || dMe < dCur)) {
            await CleaningOrder.findOneAndUpdate({ _id: order._id }, { $set: { shipperId } });
            transferred = true;
            // Người giữ cũ mất đơn
            req.io.to(`shipper_${order.shipperId}`).emit("order_taken", { orderId: order.orderId, message: "Đơn đã chuyển cho nhân viên ở gần khách hơn" });
            req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
              orderId: order.orderId, status: "accepted",
              message: "CRABOR đã đổi sang nhân viên ở gần bạn hơn để phục vụ nhanh hơn.",
            });
            console.log(`[Cleaning] Tie-break: đơn ${order.orderId} chuyển sang shipper ${shipperId} (gần hơn: ${dMe?.toFixed(2)}km < ${dCur ?? '∞'})`);
          }
        } catch (_) {}
      }
      if (!transferred) {
        req.io.to(`shipper_${shipperId}`).emit("order_taken", { orderId: order.orderId, message: "Đơn hàng đã có người nhận" });
        return res.status(409).json({ success: false, taken: true, message: "Đơn hàng đã có người nhận" });
      }
      // Chuyển thành công → coi như là chủ đơn mới, tiếp tục flow bên dưới
      order.shipperId = shipperId;
    }
    if (!order.shipperId) {
      // Chặn nếu shipper nợ tiền mặt quá hạn
      if (await isShipperCashBlocked(shipperId)) {
        return res.status(403).json({ success: false, message: "Bạn đang nợ tiền mặt quá 24h. Vui lòng chuyển tiền về công ty tại màn 'Thanh toán chi phí đơn tiền mặt'." });
      }
      // ── CHỐT ĐƠN: chỉ 1 shipper được nhận (atomic claim) ──
      const _claimC = await CleaningOrder.findOneAndUpdate(
        { _id: order._id, $or: [{ shipperId: null }, { shipperId: { $exists: false } }] },
        { $set: { shipperId } },
        { new: true }
      );
      if (!_claimC) {
        req.io.to(`shipper_${shipperId}`).emit("order_taken", { orderId: order.orderId, message: "Đơn hàng đã có người nhận" });
        return res.status(409).json({ success: false, taken: true, message: "Đơn hàng đã có người nhận" });
      }
      order.shipperId = _claimC.shipperId;
      // LƯU Ý: KHÔNG phát order_taken khi claim THÀNH CÔNG — người thắng cuộc
      // cũng đang trong room shipper_broadcast, nhận nhầm sẽ tự đóng modal của chính mình.
      // Shipper thua cuộc sẽ nhận order_taken riêng qua 409 ở trên.
    }
    const prevStatus = order.status;
    order.status = status;
    order.statusHistory.push({ status, by: "shipper", time: new Date() });
    // Notify customer on status change
    req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
      orderId: order.orderId, status,
      message: status === "accepted" ? "Shipper đã nhận đơn dọn nhà!" :
               status === "in_progress" ? "Shipper đang dọn nhà!" :
               status === "completed" ? "Dọn nhà hoàn thành! 🧹" : status,
    });
    if (status === "completed") {
      order.completedAt = new Date();
      if (!order.loyaltyPointsGranted && order.customerId) {
        order.loyaltyPointsGranted = true;
        await earnLoyaltyPoints(order.customerId, orderPaidAmount(order, { cleaning: true }));
      }
      const { shipperEarn } = await calcEarnings(order);
      const WalletQueue = mongoose.models.WalletQueue;
      if (WalletQueue) {
        await addToWalletQueue(
          order.orderId, shipperId, "shipper", shipperEarn, order.paymentMethod,
          `Dọn nhà ${order.orderId}`,
          new Date(Date.now() + 30 * 60 * 1000)
        );
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
    // FIX: Ưu tiên FoodPartner (tài khoản nhiều module) — Featured debit vào wallet FoodPartner
    const foodPartner = await getSessionFoodPartner(req);
    const wallet = await (async () => {
      if (foodPartner) {
        const p = await FoodPartner.findById(foodPartner._id).select("walletBalance walletHistory");
        if (p) return { balance: p.walletBalance || 0, history: p.walletHistory || [], partnerId: foodPartner._id };
      }
      // Dùng partnerId hoặc userPhone để lấy wallet
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
        if (p) return { balance: p.walletBalance || 0, history: p.walletHistory || [], partnerId: p._id };
      }
      return { balance: 0, history: [], partnerId: null };
    })();
    // Lịch sử dòng tiền thật từ WalletTx (credit/debit/withdraw/fee) thay vì walletHistory rỗng
    let transactions = [];
    if (wallet.partnerId) {
      const ids = new Set([String(wallet.partnerId)]);
      if (req.session.partnerId) ids.add(String(req.session.partnerId));
      const txs = await WalletTx.find({ ownerId: { $in: [...ids].map(id => new mongoose.Types.ObjectId(id)) }, ownerType: "partner" })
        .sort({ createdAt: -1 }).limit(100).lean();
      transactions = txs.map(tx => ({
        _id: tx._id, type: tx.type, amount: tx.amount, balance: tx.balance,
        note: tx.note || "", ref: tx.ref || "", createdAt: tx.createdAt,
        description: describeTx(tx),
      }));
    }
    res.json({ success: true, wallet: { balance: wallet.balance, history: wallet.history, transactions } });
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
    await loadSessionFromHeader(req, res);
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
async function handleDeliveryQR(req, res) {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await Order.findOne({
      orderId: req.params.orderId || req.params.id,
      shipperId: req.session.shipperId,
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    const amount   = order.finalTotal || order.total || 0;
    const sePayRef = "CRORD" + order.orderId.replace(/[^A-Z0-9]/gi, "").slice(-8).toUpperCase();

    // Lưu sePayRef vào order để webhook match
    await Order.findByIdAndUpdate(order._id, { sePayRef });

    const qrUrl = sepayQrUrl(amount, sePayRef);

    res.json({
      success: true,
      qrUrl,
      sePayRef,
      amount,
      bankName:    SEPAY_CONFIG.bankName,
      bankCode:    SEPAY_CONFIG.bankCode,
      accountNo:   SEPAY_CONFIG.accountNo,
      accountName: SEPAY_CONFIG.accountName,
      message:     `Chuyển khoản ${amount.toLocaleString("vi-VN")}đ · Nội dung: ${sePayRef}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}
app.post("/api/orders/:orderId/delivery-qr", handleDeliveryQR);
app.post("/api/ride/:orderId/delivery-qr", handleDeliveryQR);
app.post("/api/cleaning/orders/:id/delivery-qr", handleDeliveryQR);

// POST /api/orders/:orderId/customer-qr — Khách tự chuyển khoản thanh toán đơn
app.post("/api/orders/:orderId/customer-qr", async (req, res) => {
  try {
    const customerId = req.session?.userId || req.session?.customerId;
    if (!customerId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await Order.findOne({
      orderId: req.params.orderId,
      customerId,
      paymentStatus: { $in: ["unpaid", "pending_review"] },
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    const amount   = order.finalTotal || order.total || 0;
    const sePayRef = "CRORD" + order.orderId.replace(/[^A-Z0-9]/gi, "").slice(-8).toUpperCase();
    await Order.findByIdAndUpdate(order._id, { sePayRef });

    const qrUrl = sepayQrUrl(amount, sePayRef);

    res.json({
      success: true,
      qrUrl,
      sePayRef,
      amount,
      bankName:    SEPAY_CONFIG.bankName,
      bankCode:    SEPAY_CONFIG.bankCode,
      accountNo:   SEPAY_CONFIG.accountNo,
      accountName: SEPAY_CONFIG.accountName,
      message:     `Chuyển khoản ${amount.toLocaleString("vi-VN")}đ · Nội dung: ${sePayRef}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/orders/:orderId/confirm-payment — Shipper xác nhận thủ công
async function handleConfirmPayment(req, res) {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await Order.findOne({
      orderId: req.params.orderId || req.params.id,
      shipperId: req.session.shipperId,
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    // ── ĐƠN TIỀN MẶT: shipper xác nhận đã thu đủ tiền → ghi nợ công ty ──
    if (order.paymentMethod === "cash") {
      order.paymentStatus = "paid";
      order.paymentConfirmedAt = new Date();
      order.paymentNote = req.body.note || "Shipper xác nhận thu tiền mặt";
      order.statusHistory.push({ status: "payment_confirmed_cash", by: "shipper" });
      await order.save();

      // Chỉ ghi nợ nếu chưa có settlement (delivered đã tạo rồi thì bỏ qua)
      const finalTotal = order.finalTotal ?? Math.max(0, (order.total||0) + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0));
      const existingSettlement = await CashSettlement.findOne({ orderId: order.orderId }).lean().catch(() => null);
      if (!existingSettlement) {
        const { shipperEarn, partnerEarn } = await calcEarnings(order);
        const dueAt = new Date(Date.now() + 24 * 3600 * 1000);
        await CashSettlement.create({
          orderId: order.orderId, orderModule: order.module || "food",
          shipperId: order.shipperId, partnerId: order.partnerId || null,
          total: finalTotal, amountPaid: 0, shipperEarn, partnerEarn,
          status: "pending", dueAt,
          note: `Đơn ${order.orderId} — tiền mặt`,
        });
        req.io.to(`shipper_${order.shipperId}`).emit("cash_settlement_created", {
          orderId: order.orderId, amount: finalTotal, dueAt,
          message: `Bạn phải chuyển ${finalTotal.toLocaleString("vi-VN")}đ về công ty trong 24h`,
        });
      }

      res.json({
        success: true,
        message: `Đã ghi nhận thu ${finalTotal.toLocaleString("vi-VN")}đ tiền mặt. Hãy chuyển về công ty trong 24h qua màn 'Thanh toán chi phí đơn tiền mặt'.`,
        cashSettlement: true,
      });
      return;
    }

    if (order.paymentStatus === "paid")
      return res.status(400).json({ success: false, message: "Đơn đã thanh toán rồi" });

    // ── VÍ CRABOR / VÍ TRẢ SAU: đã auto-credit ở delivered, chỉ cần confirm là xong ──
    if (order.paymentMethod === "wallet" || order.paymentMethod === "bnpl") {
      order.paymentStatus = "paid";
      order.paymentConfirmedAt = new Date();
      order.paymentNote = req.body.note || "Thanh toán qua ví CRABOR";
      order.statusHistory.push({ status: "payment_confirmed_wallet", by: "shipper" });
      await order.save();
      return res.json({ success: true, message: "Đơn đã thanh toán qua ví CRABOR" });
    }

    // Đánh dấu pending review thay vì paid ngay
    order.paymentStatus = "pending_review";
    order.paymentConfirmedAt = new Date();
    order.paymentNote = req.body.note || "Shipper xác nhận";
    order.statusHistory.push({ status: "payment_pending_review", by: "shipper" });
    await order.save();


    // Tính tiền và đưa vào wallet queue với delay 30 phút
    const { shipperEarn, partnerEarn } = await calcEarnings(order);
    const releaseAt = new Date(Date.now() + 30 * 60 * 1000); // 30 phút

    // Lưu wallet queue với timestamp để cron job hoặc admin duyệt
    // Dùng addToWalletQueue để chống trùng với queue đã tạo lúc delivered
    if (order.shipperId) {
      await addToWalletQueue(
        order.orderId, order.shipperId, "shipper", shipperEarn, order.paymentMethod,
        `Đơn ${order.orderId} — phí ship (xác nhận thủ công)`,
        releaseAt
      );
    }
    if (order.partnerId) {
      await addToWalletQueue(
        order.orderId, order.partnerId, "partner", partnerEarn, order.paymentMethod,
        `Đơn ${order.orderId} — tiền hàng (xác nhận thủ công)`,
        releaseAt
      );
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
}
app.post("/api/orders/:orderId/confirm-payment", handleConfirmPayment);
app.post("/api/ride/:orderId/confirm-payment", handleConfirmPayment);
app.post("/api/cleaning/orders/:id/confirm-payment", handleConfirmPayment);

// POST /api/orders/:orderId/customer-confirm-payment — Khách tự xác nhận đã chuyển khoản
app.post("/api/orders/:orderId/customer-confirm-payment", async (req, res) => {
  try {
    const customerId = req.session?.userId || req.session?.customerId;
    if (!customerId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await Order.findOne({
      orderId: req.params.orderId,
      customerId,
      paymentStatus: { $in: ["unpaid", "pending_review"] },
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn" });

    order.paymentStatus = "pending_review";
    order.paymentConfirmedAt = new Date();
    order.paymentNote = req.body.note || "Khách tự xác nhận đã chuyển khoản";
    order.statusHistory.push({ status: "payment_pending_review", by: "customer" });
    await order.save();

    req.io.to("admin").emit("wallet_pending_approval", {
      orderId: order.orderId,
      type: "customer_self_confirm",
      message: `Đơn ${order.orderId} — Khách tự xác nhận đã chuyển khoản. Kiểm tra SePay để duyệt.`,
    });

    res.json({ success: true, message: "Đã ghi nhận, chờ admin xác nhận" });
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
  // Phân bổ chi phí voucher (CRABOR trung gian — shipper + đối tác gánh, trừ khi milestone 100 đơn/tháng)
  voucherShipperBear: { type: Number, default: 0, min: 0 },
  voucherPartnerBear: { type: Number, default: 0, min: 0 },
  voucherCraborBear:  { type: Number, default: 0, min: 0 },
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
  cancelReason:  String,
  sePayRef:      String,
  note:          String,
  dispatchedTo:  [mongoose.Schema.Types.ObjectId], // shipper đã được dispatch
  dispatchedAt:  Date,                            // lần dispatch gần nhất
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
      .select("bizName address district rating totalOrders packages pricePerKg openTime closeTime lastLat lastLng avatar coverImage")
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
            pickupAddress, pickupLat, pickupLng, paymentMethod, voucherCode, note,
            receiverName, receiverPhone } = req.body;
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

    // Validate voucher — dùng applyVoucher thống nhất (percent/fixed + minOrder + usageLimit + module + target)
    const { discount, applied: appliedVoucher } = await applyVoucher(voucherCode, { order: estimatedTotal, ship: shipFee }, req.session.userId, "laundry");

    // Deadline
    const turnaroundMap = { "5h": 5*3600000, "10h": 10*3600000, "24h": 24*3600000 };
    const deadline = new Date(Date.now() + (turnaroundMap[turnaround] || 24*3600000));

    const order = new LaundryOrder({
      customerId:    req.session.userId,
      partnerId:     providerId,
      customerName:  receiverName || user?.fullName || "Khách hàng",
      customerPhone: receiverPhone || user?.phone,
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

    // WALLET: trừ tiền ví CRABOR ngay khi đặt đơn giặt
    if ((paymentMethod || "cash") === "wallet") {
      const amt = order.finalTotal ?? Math.max(0, estimatedTotal + shipFee - discount);
      const userDoc = await User.findById(req.session.userId).select("walletBalance");
      if (!userDoc || (userDoc.walletBalance||0) < amt) {
        await LaundryOrder.findByIdAndDelete(order._id);
        if (appliedVoucher) await Voucher.updateOne({ _id: appliedVoucher._id }, { $inc: { usedCount: -1 }, $pull: { usedBy: req.session.userId } }).catch(() => {});
        return res.status(400).json({ success: false, message: `Ví CRABOR không đủ số dư. Cần ${amt.toLocaleString("vi-VN")}đ`, walletInsufficient: true });
      }
      order.paymentStatus = "paid";
      order.paidAt = new Date();
      await order.save();
      await walletDebit(req.session.userId, "user", amt, "debit", order.orderId, `Thanh toán đơn giặt ${order.orderId} bằng ví CRABOR`);
      req.io.to(`customer_${req.session.userId}`).emit("walletDebited", { amount: amt, orderId: order.orderId });
    }

    // Thông báo partner
    await notifyUser('partner', providerId, {
      type: 'new_order', title: '🧺 Đơn giặt là mới!',
      body: `Đơn ${order.orderId} — ${(order.finalTotal||0).toLocaleString('vi-VN')}đ. Khách: ${order.customerName}`,
      ref: order.orderId, refModule: 'laundry',
    });
    req.io.to(`partner_${providerId}`).emit("new_laundry_order", {
      order: {
        _id: order._id, orderId: order.orderId,
        customerName: order.customerName, customerPhone: order.customerPhone,
        pickupAddress: order.pickupAddress,
        packageName: order.packageName, turnaround: order.turnaround,
        estimatedKg: order.estimatedKg, estimatedTotal: order.estimatedTotal,
        finalTotal: order.finalTotal, shipFee: order.shipFee, discount: order.discount,
        deadline: order.deadline, note: order.note, paymentMethod: order.paymentMethod,
      }
    });

    // FIX: Enrich discount fields trong response
    const laundryCreatedRes = order.toObject ? order.toObject() : order;
    laundryCreatedRes.discount = laundryCreatedRes.discount || 0;
    laundryCreatedRes.voucherCode = laundryCreatedRes.voucherCode || null;
    laundryCreatedRes.finalTotal = laundryCreatedRes.finalTotal ?? Math.max(0, (laundryCreatedRes.estimatedTotal||0) + (laundryCreatedRes.shipFee||0) - (laundryCreatedRes.discount||0));
    res.status(201).json({ success: true, order: laundryCreatedRes, orderId: order.orderId });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/orders/my — Customer lấy đơn của mình
app.get("/api/laundry/orders/my", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false });
    const orders = await LaundryOrder.find({ customerId: req.session.userId }).sort({ createdAt: -1 }).limit(30).lean();
    // FIX: Enrich discount fields để customer app hiển thị đúng giá sau voucher
    const enriched = orders.map(o => ({
      ...o,
      discount: o.discount || 0,
      voucherCode: o.voucherCode || null,
      finalTotal: o.finalTotal ?? Math.max(0, (o.estimatedTotal||0) + (o.shipFee||0) - (o.discount||0)),
    }));
    res.json({ success: true, orders: enriched });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/orders/:id
app.get("/api/laundry/orders/:id", async (req, res) => {
  try {
    const order = await LaundryOrder.findOne({ $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }] });
    if (!order) return res.status(404).json({ success: false });
    const plain = order.toObject();
    plain.module = "laundry";
    // FIX: Enrich discount fields
    plain.discount = plain.discount || 0;
    plain.voucherCode = plain.voucherCode || null;
    plain.finalTotal = plain.finalTotal ?? Math.max(0, (plain.estimatedTotal||0) + (plain.shipFee||0) - (plain.discount||0));
    // Gắn shipperInfo để customer app hiện bubble/map theo dõi
    const activeShipperId = plain.shipperReturnId || plain.shipperId;
    if (activeShipperId) {
      const sh = await Shipper.findById(activeShipperId).select("fullName phone vehiclePlate location avatar").lean();
      if (sh) plain.shipperInfo = sh;
    }
    res.json({ success: true, order: plain });
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

    // ── Shipper nhận đơn: gán shipperId / shipperReturnId ──
    if (isShipper) {
      // Chặn nếu shipper nợ tiền mặt quá hạn
      if ((status === "shipper_picking" && !order.shipperId) || (status === "shipper_returning" && !order.shipperReturnId)) {
        if (await isShipperCashBlocked(req.session.shipperId)) {
          return res.status(403).json({ success: false, message: "Bạn đang nợ tiền mặt quá 24h. Vui lòng chuyển tiền về công ty tại màn 'Thanh toán chi phí đơn tiền mặt'." });
        }
      }
      if (status === "shipper_picking" && !order.shipperId) {
        // ── CHỐT ĐƠN: chỉ 1 shipper được nhận (atomic claim) ──
        const _claimL = await LaundryOrder.findOneAndUpdate(
          { _id: order._id, $or: [{ shipperId: null }, { shipperId: { $exists: false } }] },
          { $set: { shipperId: req.session.shipperId, pickupTime: new Date() } },
          { new: true }
        );
        if (!_claimL) {
          req.io.to(`shipper_${req.session.shipperId}`).emit("order_taken", { orderId: order.orderId, message: "Đơn hàng đã có người nhận" });
          return res.status(409).json({ success: false, taken: true, message: "Đơn hàng đã có người nhận" });
        }
        order.shipperId = _claimL.shipperId;
        order.pickupTime = _claimL.pickupTime;
      }
      if (status === "shipper_returning" && !order.shipperReturnId) {
        const _claimR = await LaundryOrder.findOneAndUpdate(
          { _id: order._id, $or: [{ shipperReturnId: null }, { shipperReturnId: { $exists: false } }] },
          { $set: { shipperReturnId: req.session.shipperId } },
          { new: true }
        );
        if (!_claimR) {
          req.io.to(`shipper_${req.session.shipperId}`).emit("order_taken", { orderId: order.orderId, message: "Đơn hàng đã có người nhận" });
          return res.status(409).json({ success: false, taken: true, message: "Đơn hàng đã có người nhận" });
        }
        order.shipperReturnId = _claimR.shipperReturnId;
      }
    }

    order.status = status;
    order.statusHistory.push({ status, by: isPartner?"partner":isShipper?"shipper":"customer", time: new Date() });

    if (status === "cancelled") {
      if (note) order.cancelReason = note;
      else if (!order.cancelReason) order.cancelReason = "Cửa hàng đã từ chối đơn hàng";
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "cancelled",
        message: order.cancelReason,
        cancelReason: order.cancelReason,
      });
    }

    if (status === "partner_accepted") {
      // Partner nhận đơn → tìm shipper gần nhất đến địa chỉ khách (5km, mở rộng dần)
      const dispatchLat = order.pickupLat || 21.0285;   // Hà Nội fallback nếu chưa có GPS
      const dispatchLng = order.pickupLng || 105.8542;
      // Lấy toạ độ cửa hàng để shipper biết điểm trả sau khi lấy đồ
      let partnerLat = null, partnerLng = null;
      if (order.partnerId) {
        const g = await GiatLa.findById(order.partnerId).select("lastLat lastLng").catch(() => null);
        if (g?.lastLat) { partnerLat = g.lastLat; partnerLng = g.lastLng; }
      }
      const nearby = await findLaundryShippers(dispatchLat, dispatchLng, 5);
      if (nearby.length) {
        const pickupPayload = {
          type: "laundry_pickup_request",
          orderId: order.orderId,
          pickupAddress: order.pickupAddress,
          pickupLat: dispatchLat, pickupLng: dispatchLng,
          partnerAddress: `${order.partnerName}`,
          partnerLat, partnerLng,
          customerName: order.customerName,
          customerPhone: order.customerPhone || "",
          packageName: order.packageName,
          estimatedTotal: order.estimatedTotal || 0,
          finalTotal: order.finalTotal || order.estimatedTotal || 0,
          discount: order.discount || 0,
          voucherCode: order.voucherCode || null,
          shipFee: order.shipFee,
          module: "laundry",
          timeout: 30,
        };
        for (const s of nearby) req.io.to(`shipper_${s._id}`).emit("order_request", pickupPayload);
        order.dispatchedTo = nearby.map(s => s._id);
        order.dispatchedAt = new Date();
        await order.save().catch(() => {});
      }
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "partner_accepted",
        message: "Cửa hàng đã xác nhận đơn! Đang tìm shipper đến lấy đồ...",
      });
    }

    if (status === "shipper_picking") {
      // Shipper đã nhận → thông báo cho customer (bubble + map) và partner
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "shipper_picking",
        shipperId: order.shipperId,
        message: "Shipper đang đến lấy đồ của bạn!",
      });
      req.io.to(`partner_${order.partnerId}`).emit("laundry_shipper_picking", {
        orderId: order.orderId, shipperId: order.shipperId,
        message: "Shipper đang đến lấy đồ tại khách",
      });
    }

    if (status === "picked_up_by_shipper") {
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "picked_up_by_shipper",
        message: "Shipper đã lấy đồ, đang mang đến cửa hàng giặt!",
      });
      req.io.to(`partner_${order.partnerId}`).emit("laundry_shipper_picked", {
        orderId: order.orderId, message: "Shipper đang mang đồ đến cửa hàng",
      });
    }

    if (status === "at_partner") {
      // Shipper đã đưa đồ đến partner → partner bắt đầu countdown
      order.countdownStarted = new Date();
      order.shipperReturnId = order.shipperReturnId || order.shipperId;
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
      // Ưu tiên shipper đã lấy đồ (đang chờ) trả; không có thì tìm shipper khác
      const returnPayload = {
        type: "laundry_return_request",
        orderId: order.orderId,
        pickupAddress: `${order.partnerName} — Lấy đồ đã giặt`,
        deliveryAddress: order.pickupAddress,
        deliveryLat: order.pickupLat, deliveryLng: order.pickupLng,
        customerName: order.customerName,
        customerPhone: order.customerPhone || "",
        packageName: order.packageName,
        finalTotal: order.finalTotal || order.estimatedTotal || 0,
        discount: order.discount || 0,
        voucherCode: order.voucherCode || null,
        shipFee: Math.round(order.shipFee / 2), // shipper về nhận 1 chiều
        module: "laundry",
        timeout: 30,
      };
      if (order.shipperReturnId) {
        // Ưu tiên shipper đã lấy đồ; nếu họ offline → tìm shipper gần khác
        const assigned = await Shipper.findById(order.shipperReturnId).select("online isAccepting status").lean().catch(() => null);
        const available = assigned && assigned.online && assigned.isAccepting && ["approved", "active"].includes(assigned.status);
        if (available) {
          req.io.to(`shipper_${order.shipperReturnId}`).emit("order_request", returnPayload);
        } else {
          const nearby = await findLaundryShippers(
            order.pickupLat || 21.0285, order.pickupLng || 105.8542, 5
          );
          for (const s of nearby) req.io.to(`shipper_${s._id}`).emit("order_request", returnPayload);
        }
      } else {
        const nearby = await findLaundryShippers(
          order.pickupLat || 21.0285, order.pickupLng || 105.8542, 5
        );
        for (const s of nearby) req.io.to(`shipper_${s._id}`).emit("order_request", returnPayload);
      }
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "ready_return",
        message: "Đồ đã sạch! Đang tìm shipper trả đồ về cho bạn...",
      });
    }

    if (status === "shipper_returning") {
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "shipper_returning",
        message: "Shipper đang mang đồ sạch về cho bạn!",
      });
    }

    if (status === "delivered") {
      order.deliveredAt = new Date();
      const pm = order.paymentMethod;
      // Tích điểm loyalty (1/10 giá trị đơn)
      if (order.customerId && !order.loyaltyPointsGranted) {
        order.loyaltyPointsGranted = true;
        await earnLoyaltyPoints(order.customerId, orderPaidAmount(order));
      }
      // Tính phân chia: đọc commission từ DB (mặc định 18%), tính serviceFee
      order.module = "laundry";
      const { shipperEarn, partnerEarn } = await calcEarnings(order);
      if (pm === "cash") {
        order.paymentStatus = "paid";
        const finalTotal = order.finalTotal ?? Math.max(0, (order.estimatedTotal||0) + (order.shipFee||0) - (order.discount||0));
        const dueAt = new Date(Date.now() + 24 * 3600 * 1000);
        const existingSettlement = await CashSettlement.findOne({ orderId: order.orderId }).lean().catch(() => null);
        if (!existingSettlement) {
          await CashSettlement.create({
            orderId: order.orderId, orderModule: "laundry",
            shipperId: order.shipperId, partnerId: order.partnerId || null,
            total: finalTotal, amountPaid: 0,
            shipperEarn, partnerEarn,
            status: "pending", dueAt,
            note: `Giặt là ${order.orderId} — tiền mặt`,
          });
          if (order.shipperId) {
            req.io.to(`shipper_${order.shipperId}`).emit("cash_settlement_created", {
              orderId: order.orderId, amount: finalTotal, dueAt,
              message: `Bạn phải chuyển ${finalTotal.toLocaleString("vi-VN")}đ về công ty trong 24h`,
            });
          }
        }
        req.io.to("admin").emit("cash_settlement_pending", {
          orderId: order.orderId, shipperEarn, partnerEarn, amount: finalTotal, dueAt,
        });
      } else if (pm === "wallet") {
        order.paymentStatus = "paid";
        await autoCreditOrderEarnings(order, shipperEarn, partnerEarn, "wallet", `Giặt là ${order.orderId} — ví CRABOR`);
        if (order.shipperId) {
          req.io.to(`shipper_${order.shipperId}`).emit("sepay_payment_confirmed", {
            orderId: order.orderId, amount: order.finalTotal,
            message: `Khách đã thanh toán qua ví CRABOR — ${(shipperEarn||0).toLocaleString("vi-VN")}đ đã vào ví bạn`,
          });
        }
      } else {
        if (order.shipperId)  await addToWalletQueue(order.orderId, order.shipperId,  "shipper",  shipperEarn, pm, `Giặt là ${order.orderId}`);
        if (order.partnerId)  await addToWalletQueue(order.orderId, order.partnerId,  "partner",  partnerEarn, pm, `Giặt là ${order.orderId}`);
      }
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "delivered",
        message: "Đồ đã được trả! Cảm ơn bạn đã dùng CRABOR Giặt là 👕",
      });
    }

    await order.save();
    // FIX: Enrich discount fields trong response
    const laundryRes = order.toObject ? order.toObject() : order;
    laundryRes.discount = laundryRes.discount || 0;
    laundryRes.voucherCode = laundryRes.voucherCode || null;
    laundryRes.finalTotal = laundryRes.finalTotal ?? Math.max(0, (laundryRes.estimatedTotal||0) + (laundryRes.shipFee||0) - (laundryRes.discount||0));
    res.json({ success: true, order: laundryRes });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/laundry/orders/:id/cancel — Customer hủy đơn giặt
app.patch("/api/laundry/orders/:id/cancel", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.userId && !req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });
    }
    const LaundryOrder = mongoose.models.LaundryOrder;
    if (!LaundryOrder) return res.status(500).json({ success: false, message: "Model chưa khởi tạo" });

    const order = await LaundryOrder.findOne({ orderId: req.params.id });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn giặt" });

    const cancellableStatuses = ["pending", "partner_accepted", "shipper_accepted", "washing"];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ success: false, message: "Không thể hủy đơn ở trạng thái hiện tại" });
    }

    order.status = "cancelled";
    order.cancelReason = req.body.reason || "Khách hàng hủy";
    order.cancelledAt = new Date();
    await order.save();

    // Hoàn tiền ví / gỡ ví trả sau khi khách hủy
    try { await refundOnCancel(order); } catch(e) { console.error('[Laundry Cancel] refundOnCancel lỗi:', e.message); }

    // Notify partner
    if (order.partnerId) {
      req.io.to(`partner_${order.partnerId}`).emit("laundry_order_cancelled", {
        orderId: order.orderId, message: "Khách hàng đã hủy đơn giặt",
      });
    }

    console.log(`[Laundry Cancel] ${order.orderId} cancelled`);
    res.json({ success: true, message: "Đã hủy đơn giặt" });
  } catch (err) {
    console.error('[PATCH /laundry/cancel]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


// POST /api/laundry/orders/:id/delivery-qr — Shipper lấy QR thu tiền đơn giặt
app.post("/api/laundry/orders/:id/delivery-qr", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await LaundryOrder.findOne({
      $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }]
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn giặt" });

    const amount   = order.finalTotal || order.estimatedTotal || 0;
    const sePayRef = "CRLAU" + order.orderId.replace(/[^A-Z0-9]/gi, "").slice(-8).toUpperCase();
    await LaundryOrder.findByIdAndUpdate(order._id, { sePayRef });

    const qrUrl = sepayQrUrl(amount, sePayRef);

    res.json({
      success: true,
      qrUrl,
      sePayRef,
      amount,
      bankName:    SEPAY_CONFIG.bankName,
      bankCode:    SEPAY_CONFIG.bankCode,
      accountNo:   SEPAY_CONFIG.accountNo,
      accountName: SEPAY_CONFIG.accountName,
      message:     `Chuyển khoản ${amount.toLocaleString("vi-VN")}đ · Nội dung: ${sePayRef}`,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/laundry/orders/:id/customer-qr — Khách tự chuyển khoản thanh toán giặt là
app.post("/api/laundry/orders/:id/customer-qr", async (req, res) => {
  try {
    const customerId = req.session?.userId || req.session?.customerId;
    if (!customerId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await LaundryOrder.findOne({
      $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }],
      customerId,
      paymentStatus: { $in: ["unpaid", "pending_review"] },
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn giặt" });

    const amount   = order.finalTotal || order.estimatedTotal || 0;
    const sePayRef = "CRLAU" + order.orderId.replace(/[^A-Z0-9]/gi, "").slice(-8).toUpperCase();
    await LaundryOrder.findByIdAndUpdate(order._id, { sePayRef });

    const qrUrl = sepayQrUrl(amount, sePayRef);

    res.json({
      success: true,
      qrUrl,
      sePayRef,
      amount,
      bankName:    SEPAY_CONFIG.bankName,
      bankCode:    SEPAY_CONFIG.bankCode,
      accountNo:   SEPAY_CONFIG.accountNo,
      accountName: SEPAY_CONFIG.accountName,
      message:     `Chuyển khoản ${amount.toLocaleString("vi-VN")}đ · Nội dung: ${sePayRef}`,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/laundry/orders/:id/confirm-payment — Shipper xác nhận đã thu tiền
app.post("/api/laundry/orders/:id/confirm-payment", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await LaundryOrder.findOne({
      $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }]
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn giặt" });
    if (order.paymentStatus === "paid")
      return res.status(400).json({ success: false, message: "Đơn đã thanh toán rồi" });

    order.paymentStatus = "pending_review";
    order.paymentConfirmedAt = new Date();
    order.paymentNote = req.body.note || "Shipper xác nhận";
    order.statusHistory.push({ status: "payment_pending_review", by: "shipper" });
    await order.save();

    // Tính tiền và đưa vào wallet queue
    const { shipperEarn, partnerEarn } = await calcEarnings({ ...order.toObject(), module: "laundry" });
    if (order.shipperId)  await addToWalletQueue(order.orderId, order.shipperId,  "shipper", shipperEarn, order.paymentMethod, `Giặt là ${order.orderId}`);
    if (order.partnerId)  await addToWalletQueue(order.orderId, order.partnerId,  "partner", partnerEarn, order.paymentMethod, `Giặt là ${order.orderId}`);

    res.json({ success: true, message: "Đã ghi nhận thanh toán, chờ admin duyệt" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/laundry/orders/:id/customer-confirm-payment — Khách tự xác nhận đã chuyển khoản
app.post("/api/laundry/orders/:id/customer-confirm-payment", async (req, res) => {
  try {
    const customerId = req.session?.userId || req.session?.customerId;
    if (!customerId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await LaundryOrder.findOne({
      $or: [{ orderId: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }],
      customerId,
      paymentStatus: { $in: ["unpaid", "pending_review"] },
    });
    if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn giặt" });

    order.paymentStatus = "pending_review";
    order.paymentConfirmedAt = new Date();
    order.paymentNote = req.body.note || "Khách tự xác nhận đã chuyển khoản";
    order.statusHistory.push({ status: "payment_pending_review", by: "customer" });
    await order.save();

    req.io.to("admin").emit("wallet_pending_approval", {
      orderId: order.orderId,
      type: "customer_self_confirm",
      message: `Đơn giặt ${order.orderId} — Khách tự xác nhận đã chuyển khoản. Kiểm tra SePay để duyệt.`,
    });

    res.json({ success: true, message: "Đã ghi nhận, chờ admin xác nhận" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Helper: resolve GiatLa partner từ session ─────────────
// Ưu tiên partnerId; nếu không khớp GiatLa thì fallback theo phone
// (trường hợp session.partnerId trỏ sang model khác như FoodPartner).
async function findLaundryPartner(req) {
  let p = null;
  if (req.session?.partnerId) p = await GiatLa.findById(req.session.partnerId).catch(() => null);
  if (!p && req.session?.userPhone) p = await GiatLa.findOne({ phone: normalizePhone(req.session.userPhone) });
  return p;
}

// GET /api/laundry/partner/orders — Partner xem đơn giặt của mình
app.get("/api/laundry/partner/orders", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const partner = await findLaundryPartner(req);
    if (!partner) return res.status(401).json({ success: false });
    const { status } = req.query;
    const filter = { partnerId: partner._id };
    if (status) filter.status = status;
    const orders = await LaundryOrder.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    // FIX: Enrich discount fields
    const enriched = orders.map(o => ({
      ...o,
      discount: o.discount || 0,
      voucherCode: o.voucherCode || null,
      finalTotal: o.finalTotal ?? Math.max(0, (o.estimatedTotal||0) + (o.shipFee||0) - (o.discount||0)),
    }));
    res.json({ success: true, orders: enriched });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/laundry/partner/packages — Partner cập nhật gói giặt
app.patch("/api/laundry/partner/packages", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const { packages } = req.body;
    if (!Array.isArray(packages)) return res.status(400).json({ success: false, message: "packages phải là array" });
    // Đảm bảo partnerId đúng với GiatLa (không phải FoodPartner)
    let partner = await findLaundryPartner(req);
    if (!partner) {
      // Thử tìm lại qua các model khác để báo lỗi rõ hơn
      return res.status(404).json({ success: false, message: "Không tìm thấy tài khoản giặt là. Bạn có đang dùng đúng tài khoản?" });
    }
    partner.packages = packages;
    const updated = await partner.save();
    console.log("[PATCH /laundry/partner/packages] Updated", packages.length, "packages for partner", partner._id);
    res.json({ success: true, packages: updated.packages });
  } catch (err) {
    console.error("[PATCH /laundry/partner/packages]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/laundry/partner/accepting — Partner bật/tắt nhận đơn
app.patch("/api/laundry/partner/accepting", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const partner = await findLaundryPartner(req);
    if (!partner) return res.status(401).json({ success: false });
    const { accepting } = req.body;
    partner.isAccepting = accepting;
    await partner.save();
    res.json({ success: true, isAccepting: accepting });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/laundry/partner/me — Partner xem thông tin của mình
app.get("/api/laundry/partner/me", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    const p = await findLaundryPartner(req);
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
    pruneSessionRoles(req, 'shipper');
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
    pruneSessionRoles(req, 'shipper');
    
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
  const PayOSLib = require("@payos/node");
  // SDK mới: named export { PayOS }, SDK cũ: default export hoặc class trực tiếp
  const PayOSClass = PayOSLib.PayOS || PayOSLib.default || PayOSLib;
  const clientId    = process.env.PAYOS_CLIENT_ID    || "94156c0e-dd25-45e0-aac9-75148eed142e";
  const apiKey      = process.env.PAYOS_API_KEY      || "89cdfbd7-5a3b-46b2-99d7-1395d3d14840";
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY || "0940b669da1439031c9f179309674890cb8aaebfa81777da0756b7f870467168";
  if (!clientId || !apiKey || !checksumKey) throw new Error("Thiếu PayOS credentials");
  // SDK v2 (mới): new PayOS({ clientId, apiKey, checksumKey }) — export named { PayOS }
  // SDK v1 (cũ):  new PayOS(clientId, apiKey, checksumKey) — default export / class trực tiếp
  // Nếu khởi tạo sai kiểu (v1 mà truyền object), instance sẽ lưu credentials undefined
  // → khi gọi create bên trong SDK sẽ crash "Cannot read properties of undefined (reading 'length')"
  const usable = (inst) => (inst && (typeof inst.paymentRequests?.create === 'function' || typeof inst.createPaymentLink === 'function')) ? inst : null;
  let inst = null;
  try { inst = usable(new PayOSClass({ clientId, apiKey, checksumKey })); } catch (_) { inst = null; }
  if (inst && typeof inst.checksumKey === 'string') payOS = inst;
  if (!payOS) {
    try { payOS = usable(new PayOSClass(clientId, apiKey, checksumKey)); } catch (_) { payOS = null; }
  }
  if (payOS) console.log("[OK] PayOS initialized, methods:", typeof payOS.createPaymentLink, typeof payOS.paymentRequests?.create);
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
      description: (description || "").replace(/[^a-zA-Z0-9 ]/g,"").slice(0, 25) || "Thanh toan", // PayOS giới hạn 25 ký tự
      returnUrl:   returnUrl  || `${process.env.BASE_URL || "https://crabor-shipper-register.onrender.com"}/payment/success?orderId=${orderId}`,
      cancelUrl:   cancelUrl  || `${process.env.BASE_URL || "https://crabor-shipper-register.onrender.com"}/payment/cancel?orderId=${orderId}`,
      // PayOS bắt buộc có items — fallback nếu client không gửi
      items:       (Array.isArray(items) && items.length > 0)
                    ? items
                    : [{ name: (description || "Thanh toan").slice(0, 40), quantity: 1, price: Math.round(amount) }],
      ...(buyerName  && { buyerName }),
      ...(buyerPhone && { buyerPhone }),
      ...(buyerEmail && { buyerEmail }),
    };

    // PayOS SDK: ưu tiên paymentRequests.create() (SDK mới), fallback createPaymentLink() (SDK cũ)
    let paymentLink;
    if (typeof payOS.paymentRequests?.create === 'function') {
      paymentLink = await payOS.paymentRequests.create(paymentData);
    } else if (typeof payOS.createPaymentLink === 'function') {
      paymentLink = await payOS.createPaymentLink(paymentData);
    } else {
      throw new Error('PayOS SDK không hợp lệ - không tìm thấy createPaymentLink hoặc paymentRequests.create');
    }

    // Chuẩn hoá response (SDK mới trả thẳng data, SDK cũ bọc { data: {...} })
    const linkData = paymentLink?.data && typeof paymentLink.data === 'object' && !Array.isArray(paymentLink.data)
      ? paymentLink.data
      : paymentLink;

    // Lưu mapping orderCode <-> orderId để webhook match
    await require("mongoose").models.Order?.findOneAndUpdate(
      { orderId },
      { payosOrderCode: orderCode, payosCheckoutUrl: linkData?.checkoutUrl },
    );

    res.json({
      success:     true,
      checkoutUrl: linkData?.checkoutUrl,
      paymentLinkId: linkData?.paymentLinkId,
      orderCode:   linkData?.orderCode ?? orderCode,
      qrCode:      linkData?.qrCode,
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
    // PayOS SDK bọc response trong { data: {...} } — unwrap để app có thể đọc status trực tiếp
    const raw = info?.data && typeof info.data === 'object' && !Array.isArray(info.data) ? info.data : info;
    const statusPay = raw?.status || info?.status;
    res.json({ success: true, payment: { ...raw, status: statusPay }, status: statusPay, paid: statusPay === "PAID" || statusPay === "00" });
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
    // Verify webhook signature - SDK mới: payOS.webhooks.verify(), SDK cũ: webhook.verifySignature()
    let verified = false;
    try {
      if (typeof payOS?.webhooks?.verify === 'function') {
        payOS.webhooks.verify(webhookData); // throws nếu invalid
        verified = true;
      } else if (typeof payOS?.webhook?.verifySignature === 'function') {
        verified = payOS.webhook.verifySignature(webhookData);
      } else {
        verified = true; // skip nếu không có method verify
      }
    } catch(verifyErr) {
      console.warn("[PayOS Webhook] Signature verify failed:", verifyErr.message);
      verified = false;
    }

    if (!verified) return res.status(400).json({ success: false, message: "Invalid signature" });

    const { orderCode, status, amount } = webhookData.data || webhookData;

    if (status === "PAID" || status === "00") {
      // Tìm order theo payosOrderCode
      const Order = require("mongoose").models.Order;
      const order = Order ? await Order.findOne({ payosOrderCode: String(orderCode) }) : null;

      // Featured request (quán nổi bật) cũng có thể khớp orderCode
      let ftr = null;
      try { ftr = await FeaturedRequest.findOne({ payosOrderCode: String(orderCode), paymentStatus: { $in: ["unpaid","pending_review"] } }); } catch(_) {}

      if (ftr) {
        ftr.paymentStatus = "paid";
        ftr.paidAt = new Date();
        await ftr.save();
        global._io?.to("admin").emit("featured_request_paid", { requestId: ftr.requestId, partnerName: ftr.partnerName });
        global._io?.to(`partner_${ftr.partnerId}`).emit("featured_paid", { requestId: ftr.requestId });
        console.log(`[PayOS Webhook] Featured request ${ftr.requestId} PAID — ${amount?.toLocaleString("vi-VN")}đ`);
      }

      // Cash settlement (shipper chuyển tiền mặt về công ty)
      const cashPay = await CashSettlementPayment.findOne({
        payosOrderCode: String(orderCode), status: "pending",
      }).catch(() => null);
      if (cashPay && cashPay.status === "pending") {
        const result = await applyCashPayment(cashPay.shipperId, cashPay.amount, "payos", cashPay.note, cashPay._id);
        global._io?.to(`shipper_${cashPay.shipperId}`).emit("cash_settlement_paid", {
          amount: cashPay.amount, message: `Đã nhận ${cashPay.amount.toLocaleString("vi-VN")}đ từ shipper chuyển về công ty!`,
        });
        global._io?.to("admin").emit("cash_settlement_paid", {
          shipperId: cashPay.shipperId, amount: cashPay.amount, method: "payos", releasedOrders: result.released,
        });
        console.log(`[PayOS Webhook] Cash settlement ${cashPay.paymentId} PAID — ${cashPay.amount?.toLocaleString("vi-VN")}đ`);
      }

      if (order && order.paymentStatus !== "paid") {
        order.paymentStatus = "paid";
        order.paidAt        = new Date();
        order.statusHistory.push({ status: "payment_confirmed_payos", by: "system" });
        await order.save();

        // Tính tiền và add vào wallet queue
        const { shipperEarn, partnerEarn } = await calcEarnings(order);
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
      req.session.role = "customer";
      pruneSessionRoles(req, 'user');
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
      pruneSessionRoles(req, 'shipper');
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
      pruneSessionRoles(req, 'partner');
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

// GET /api/food-partners/search?q=... — Tìm kiếm MỌI THỨ: tên quán + TÊN MÓN trong menu
app.get("/api/food-partners/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(50, Number(req.query.limit) || 20);
    if (!q) return res.json({ success: true, partners: [] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    // 1) Tìm món khớp → gom theo quán
    const matchedProducts = await Product.find({ available: true, $or: [{ name: rx }, { description: rx }] })
      .select("name price partnerId")
      .limit(100).lean();
    const productMap = {}; // partnerId -> [tên món]
    for (const p of matchedProducts) {
      const key = String(p.partnerId);
      (productMap[key] = productMap[key] || []).push(p.name);
    }
    const partnerIdsFromProducts = Object.keys(productMap);

    // 2) Quán khớp theo tên/địa chỉ/mô tả/danh mục
    const nameMatched = await FoodPartner.find({
      status: "approved",
      $or: [{ bizName: rx }, { address: rx }, { description: rx }, { categories: rx }],
    }).select("_id registerId bizName address district categories openTime closeTime avatar coverImage rating totalOrders description")
      .sort({ rating: -1, totalOrders: -1 }).limit(limit).lean();

    // 3) Quán có món khớp (loại trừ những quán đã có ở trên)
    let productMatched = [];
    if (partnerIdsFromProducts.length) {
      productMatched = await FoodPartner.find({
        status: "approved",
        _id: { $in: partnerIdsFromProducts, $nin: nameMatched.map(p => p._id) },
      }).select("_id registerId bizName address district categories openTime closeTime avatar coverImage rating totalOrders description")
        .sort({ rating: -1, totalOrders: -1 }).limit(limit).lean();
    }

    // Gắn danh sách món khớp vào từng quán để UI hiển thị "Món: ..."
    const withMatches = [...nameMatched, ...productMatched].map(p => ({
      ...p,
      matchedProducts: (productMap[String(p._id)] || []).slice(0, 5),
    }));
    // Quán khớp tên ưu tiên trước, sau đó xếp theo rating
    withMatches.sort((a, b) => (b.matchedProducts?.length ? 0 : 1) - (a.matchedProducts?.length ? 0 : 1) || (b.rating || 0) - (a.rating || 0));

    res.json({ success: true, partners: withMatches.slice(0, limit), total: withMatches.length });
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

// GET /api/food-partners/:id/reviews — Đánh giá + phân bố sao theo tỉ lệ đơn của quán
app.get("/api/food-partners/:id/reviews", async (req, res) => {
  try {
    const id = req.params.id;
    const partner = await FoodPartner.findById(id).select("rating ratingCount totalOrders");
    const rated = await Order.find({ partnerId: id, ratingPartner: { $exists: true, $ne: null } })
      .sort({ ratedAt: -1 })
      .select("orderId ratingPartner ratingComment ratedAt customerName items")
      .lean();
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    rated.forEach(r => { const v = Math.round(r.ratingPartner); if (v >= 1 && v <= 5) distribution[v]++; });
    const reviews = rated.map(r => ({
      orderId: r.orderId,
      rating: r.ratingPartner,
      comment: r.ratingComment || '',
      date: r.ratedAt,
      customerName: r.customerName || 'Khách hàng',
      orderInfo: (r.items || []).map(i => `${i.qty}× ${i.name}`).join(', '),
    }));
    res.json({
      success: true,
      averageRating: partner?.rating || 5,
      ratingCount: partner?.ratingCount || 0,
      totalOrders: partner?.totalOrders || 0,
      reviews,
      distribution,
    });
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
//  13b. API: ANALYTICS — FINANCE (period-aware)
// ==========================================

// GET /api/analytics/revenue?period=today|week|month|quarter
// Trả về doanh thu thật theo kỳ được chọn
app.get("/api/analytics/revenue", adminAuth, async (req, res) => {
  try {
    const period = req.query.period || "month";
    const days   = { today: 0, week: 7, month: 30, quarter: 90 }[period] ?? 30;

    let since;
    if (period === "today") {
      since = new Date(); since.setHours(0,0,0,0);
    } else {
      since = new Date(Date.now() - days * 24 * 3600e3);
    }

    const [revenueResult, ordersByModule, shipperCount] = await Promise.all([
      Order.aggregate([
        { $match: { status: "delivered", deliveredAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: "$finalTotal" }, deliveryFees: { $sum: "$shipFee" } } }
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$module", count: { $sum: 1 }, revenue: { $sum: "$finalTotal" } } },
        { $sort: { revenue: -1 } }
      ]),
      Shipper.countDocuments(),
    ]);

    const gmv          = revenueResult[0]?.total || 0;
    const deliveryFees = revenueResult[0]?.deliveryFees || 0;
    const totalModRev  = ordersByModule.reduce((s, m) => s + (m.revenue || 0), 0);

    // Tính commission thật: aggregate serviceFee + (partnerBase * commissionPct) theo module
    const commissionByModule = { food: 20, laundry: 30, cleaning: 30, china_shop: 20, ride: 30 };
    let totalCraborCommission = 0;
    let totalServiceFees = 0;

    // Lấy tổng serviceFee thực tế từ orders
    const serviceFeeResult = await Order.aggregate([
      { $match: { status: "delivered", deliveredAt: { $gte: since } } },
      { $group: { _id: null, totalServiceFee: { $sum: "$serviceFee" } } }
    ]);
    totalServiceFees = serviceFeeResult[0]?.totalServiceFee || 0;

    // Tính commission thực từ mỗi module
    for (const m of ordersByModule) {
      const pct = commissionByModule[m._id] ?? 15;
      const moduleBase = (m.revenue || 0) - (m.deliveryFees || 0) - (m.serviceFees || 0);
      totalCraborCommission += Math.round(moduleBase * pct / 100);
    }

    // Tính % thực tế mỗi module
    const modulesWithPct = ordersByModule.map(m => ({
      module:  m._id,
      count:   m.count,
      revenue: m.revenue,
      pct:     totalModRev > 0 ? Math.round((m.revenue / totalModRev) * 100) : 0,
    }));

    res.json({
      success: true,
      data: {
        gmv,
        commission:  totalCraborCommission,
        serviceFee:  totalServiceFees,
        deliveryFee: deliveryFees,
        shipperFee:  shipperCount * 700000,
        craborTotal: totalCraborCommission + totalServiceFees,
        modules:     modulesWithPct,
        period,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/transactions?page=1&limit=20&type=
// Lấy giao dịch thật từ Orders (thay thế data cứng trong admin)
app.get("/api/admin/transactions", adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, type, module } = req.query;
    const filter = {};
    if (module) filter.module = module;
    // type filter: order | refund | all
    if (type === "refund")  filter.status = "cancelled";
    else if (type === "order") filter.status = { $in: ["delivered","pending","accepted","delivering"] };

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .select("orderId module status finalTotal paymentMethod createdAt deliveredAt customerName customerPhone")
        .lean(),
      Order.countDocuments(filter),
    ]);

    const moduleLabel = { food:"🍜 Đồ ăn", laundry:"👕 Giặt là", cleaning:"🧹 Giúp việc", china_shop:"🛍️ China Shop", ride:"🛵 Xe ôm" };
    const statusLabel = { delivered:"Thành công", cancelled:"Hoàn tiền", pending:"Chờ xử lý", accepted:"Đang xử lý", delivering:"Đang giao" };

    const transactions = orders.map(o => ({
      id:     o.orderId || o._id,
      type:   o.status === "cancelled" ? "Hoàn tiền" : "Thanh toán đơn",
      user:   o.customerName || o.customerPhone || "–",
      amount: o.status === "cancelled" ? -(o.finalTotal || 0) : (o.finalTotal || 0),
      method: o.paymentMethod || "cash",
      module: moduleLabel[o.module] || o.module,
      status: o.status === "cancelled" ? "refund" : (o.status === "delivered" ? "success" : "pending"),
      statusLabel: statusLabel[o.status] || o.status,
      time:   o.deliveredAt || o.createdAt,
    }));

    res.json({ success: true, data: transactions, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
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
      earlyBirdPrice: await getConfig("earlyBirdPrice", 500000),
      earlyBirdLeft: Math.max(0, await getConfig("earlyBirdMax", 50) - earlyBird),
      earlyBirdRevenue: earlyBird * (await getConfig("earlyBirdPrice", 500000)),
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


// Helper: clean documents (bỏ pending_upload, base64) trước khi trả về cho admin
function cleanDocuments(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  if (obj.documents) {
    Object.keys(obj.documents).forEach(k => {
      const v = obj.documents[k];
      if (!v || v === 'pending_upload' || (typeof v === 'string' && v.startsWith('data:'))) {
        delete obj.documents[k];
      }
    });
  }
  if (!obj.avatar || obj.avatar === 'pending_upload' || (typeof obj.avatar === 'string' && obj.avatar.startsWith('data:'))) {
    obj.avatar = obj.documents?.selfie || obj.documents?.shopFront || null;
  }
  if (obj.coverImage && (obj.coverImage === 'pending_upload' || (typeof obj.coverImage === 'string' && obj.coverImage.startsWith('data:')))) {
    obj.coverImage = null;
  }
  return obj;
}

// GET /api/admin/shippers/:id — Chi tiết 1 shipper
app.get("/api/admin/shippers/:id", adminAuth, async (req, res) => {
  try {
    const doc = await Shipper.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    res.json({ success: true, data: cleanDocuments(doc) });
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
    res.json({ success: true, data: cleanDocuments(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/ride-drivers/:id — Chi tiết 1 tài xế
app.get("/api/admin/ride-drivers/:id", adminAuth, async (req, res) => {
  try {
    const doc = await RideDriver.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy" });
    res.json({ success: true, data: cleanDocuments(doc) });
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
    // documents giờ chỉ lưu URL Cloudinary (ngắn) → trả thẳng, bỏ pending_upload
    const flatMapped = flat.map(doc => {
      const docsUrls = {};
      if (doc.documents) {
        Object.entries(doc.documents).forEach(([field, val]) => {
          if (val && val !== 'pending_upload' && !val.startsWith('data:')) {
            docsUrls[field] = val; // Cloudinary URL
          } else {
            docsUrls[field] = null;
          }
        });
      }
      const { documents, ...rest } = doc;
      return { ...rest, documentsUrls: docsUrls };
    });
    res.json({ success: true, total: flatMapped.length, data: flatMapped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/registrations/:type/:id — Lấy chi tiết 1 hồ sơ (kèm documents)
app.get("/api/admin/registrations/:type/:id", adminAuth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const Model = getModelByType(type);
    if (!Model) return res.status(400).json({ success: false, message: "Type không hợp lệ" });

    const doc = await Model.findById(id).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy" });

    // documents lưu base64 hoặc URL trực tiếp → trả thẳng, pending_upload = null
    const docsForAdmin = {};
    if (doc.documents) {
      Object.entries(doc.documents).forEach(([field, val]) => {
        if (val && val !== 'pending_upload') {
          docsForAdmin[field] = val;
        } else {
          docsForAdmin[field] = null;
        }
      });
    }

    res.json({ success: true, data: { ...doc, _type: type, documentsUrls: docsForAdmin } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/registrations/:type/:id/upload-doc — Admin upload ảnh (base64) vào MongoDB
app.post("/api/admin/registrations/:type/:id/upload-doc", adminAuth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const { field, data } = req.body;
    if (!field || !data) return res.status(400).json({ success: false, message: "Thiếu field hoặc data" });

    const allowedFields = ['cccdFront','cccdBack','selfie','shopFront','shopInside','vehicleImg','productSample','importDoc','licenseImg','driverLicense','vehicleReg'];
    if (!allowedFields.includes(field))
      return res.status(400).json({ success: false, message: "Field không hợp lệ" });

    if (!data.startsWith('data:image') && !data.startsWith('data:application/pdf'))
      return res.status(400).json({ success: false, message: "Dữ liệu không hợp lệ" });

    if (Buffer.byteLength(data, 'utf8') > 1.5 * 1024 * 1024)
      return res.status(413).json({ success: false, message: "Ảnh quá lớn (tối đa 1.5MB)" });

    const uploaded = await uploadImageToCloudinary(data, "docs");

    // Lưu vào MongoDB bằng _id (URL Cloudinary — hoặc base64 nếu chưa cấu hình)
    const Model = getModelByType(type);
    if (!Model) return res.status(400).json({ success: false, message: "Loại không hợp lệ" });
    const update = {};
    update["documents." + field] = uploaded;
    const doc = await Model.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy hồ sơ" });

    res.json({ success: true, url: uploaded, field });
  } catch(err) {
    console.error("[admin upload-doc]", err.message);
    res.status(500).json({ success: false, message: "Upload thất bại: " + err.message });
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

// ── CASH SETTLEMENT — shipper nợ tiền mặt phải chuyển về công ty ──
const cashSettlementSchema = new mongoose.Schema({
  orderId:        { type: String, required: true, unique: true },
  orderModule:    { type: String, default: "food" },
  shipperId:      { type: mongoose.Schema.Types.ObjectId, ref: "Shipper", required: true },
  partnerId:      { type: mongoose.Schema.Types.ObjectId, default: null },
  total:          { type: Number, required: true, min: 0 },   // finalTotal = tiền khách trả mặt
  amountPaid:     { type: Number, default: 0 },               // đã chuyển về công ty
  shipperEarn:    { type: Number, default: 0 },               // shipper sẽ nhận khi hoàn tất
  partnerEarn:    { type: Number, default: 0 },               // partner sẽ nhận khi hoàn tất
  status:         { type: String, enum: ["pending","partially_paid","settled","overdue"], default: "pending" },
  dueAt:          { type: Date },                              // +24h từ khi giao
  earningsReleased:{ type: Boolean, default: false },          // đã cộng shipper+partner chưa
  releasedAt:     Date,
  lastPaidAt:     Date,
  note:           { type: String },
}, { timestamps: true });
cashSettlementSchema.index({ shipperId: 1, status: 1 });
const CashSettlement = mongoose.models.CashSettlement || mongoose.model("CashSettlement", cashSettlementSchema);

// ── CASH SETTLEMENT PAYMENT — lệnh chuyển tiền về công ty ──
const cashSettlementPaymentSchema = new mongoose.Schema({
  paymentId:      { type: String, unique: true, sparse: true },
  settlementId:   { type: mongoose.Schema.Types.ObjectId, ref: "CashSettlement", default: null },
  shipperId:      { type: mongoose.Schema.Types.ObjectId, ref: "Shipper", required: true },
  amount:         { type: Number, required: true, min: 1000 },
  method:         { type: String, enum: ["payos","sepay","wallet"], required: true },
  status:         { type: String, enum: ["pending","confirmed","cancelled"], default: "pending" },
  sePayRef:       { type: String },
  payosOrderCode: { type: String },
  payosCheckoutUrl:{ type: String },
  note:           { type: String },
  confirmedAt:    Date,
}, { timestamps: true });
cashSettlementPaymentSchema.index({ shipperId: 1, status: 1, createdAt: -1 });
const CashSettlementPayment = mongoose.models.CashSettlementPayment || mongoose.model("CashSettlementPayment", cashSettlementPaymentSchema);

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
        const upd = await Shipper.findByIdAndUpdate(item.recipientId, {
          $inc: { walletBalance: item.amount, totalEarnings: item.amount }
        }, { new: true });
        if (upd) await WalletTx.create({ ownerId: item.recipientId, ownerType: "shipper", type: "credit", amount: item.amount, balance: upd.walletBalance, ref: item.orderId, note: item.note || "Thu nhập đơn hàng" }).catch(()=>{});
      } else {
        const pModels = [
          mongoose.models.FoodPartner, mongoose.models.GiatLa,
          mongoose.models.GiupViec,   mongoose.models.ChinaShop,
        ].filter(Boolean);
        for (const m of pModels) {
          const upd = await m.findByIdAndUpdate(item.recipientId, {
            $inc: { walletBalance: item.amount, totalSales: item.amount }
          }, { new: true });
          if (upd) {
            await WalletTx.create({ ownerId: item.recipientId, ownerType: "partner", type: "credit", amount: item.amount, balance: upd.walletBalance, ref: item.orderId, note: item.note || "Thu nhập đơn hàng" }).catch(()=>{});
            break;
          }
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
// Commission mặc định theo module (fallback nếu không có trong DB)
// Tỷ lệ nền tảng thống nhất:
//   - Shipper / tài xế / người giúp việc: giữ 70% thu nhập (nền tảng thu 30%)
//   - Partner nhà hàng & China Shop: giữ 80% giá hàng (nền tảng thu 20%/đơn)
//   - Giặt là & Dọn nhà: nền tảng thu 30%
const DEFAULT_COMMISSION = { food: 20, laundry: 30, cleaning: 30, china_shop: 20, ride: 30 };

// ── Helper: earnings base của đơn shipper thực hiện ────────────
// Đồ ăn/giặt: tính trên shipFee. Xe công nghệ (ride): cước nằm ở total (shipFee=0).
// Dọn nhà (CleaningOrder): không có shipFee/total → tính trên price (giá ca)
function shipperOrderEarningsBase(o) {
  if (o.module === 'ride') return o.total || 0;
  if (o.module === 'cleaning' || o.serviceType) return o.price || 0;
  return o.deliveryFee || o.shipFee || 15000;
}

// ── Số đơn hoàn thành tối thiểu/tháng để CRABOR chịu toàn bộ voucher ──
const VOUCHER_MILESTONE_ORDERS = 100;

// CRABOR là ứng dụng trung gian KHÔNG chịu chi phí voucher. Mặc định shipper +
// đối tác cùng gánh. Chỉ khi CẢ HAI đạt ≥100 đơn hoàn thành trong tháng dương
// lịch hiện tại thì CRABOR chịu hoàn toàn mức giảm giá do voucher gây ra.
async function voucherBorneByCrabor(order) {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // ── Đếm đơn hoàn thành của shipper trong tháng (food + ride + giặt + dọn nhà) ──
    let shipperMonth = 0;
    if (order.shipperId) {
      const [foodRide, clean] = await Promise.all([
        Order.countDocuments({ shipperId: order.shipperId, status: "delivered", deliveredAt: { $gte: monthStart, $lt: monthEnd } }),
        mongoose.models.CleaningOrder ? CleaningOrder.countDocuments({ shipperId: order.shipperId, status: "completed", completedAt: { $gte: monthStart, $lt: monthEnd } }) : 0,
      ]);
      let laundry = 0;
      if (mongoose.models.LaundryOrder) {
        const [l1, l2] = await Promise.all([
          LaundryOrder.countDocuments({ shipperId: order.shipperId, status: "delivered", deliveredAt: { $gte: monthStart, $lt: monthEnd } }),
          LaundryOrder.countDocuments({ shipperReturnId: order.shipperId, status: "delivered", deliveredAt: { $gte: monthStart, $lt: monthEnd } }),
        ]);
        laundry = l1 + l2;
      }
      shipperMonth = foodRide + clean + laundry;
    }

    // ── Đếm đơn hoàn thành của đối tác trong tháng (theo module của đơn) ──
    const pid = order.partnerId;
    const hasPartner = !!(pid && String(pid) !== "0" && String(pid) !== "null");
    let partnerMonth = 0;
    if (hasPartner) {
      if (order.module === "laundry" && mongoose.models.LaundryOrder) {
        partnerMonth = await LaundryOrder.countDocuments({ partnerId: pid, status: "delivered", deliveredAt: { $gte: monthStart, $lt: monthEnd } });
      } else {
        partnerMonth = await Order.countDocuments({ partnerId: pid, status: "delivered", deliveredAt: { $gte: monthStart, $lt: monthEnd } });
      }
    }

    const shipperOk = order.shipperId ? shipperMonth >= VOUCHER_MILESTONE_ORDERS : false;
    const partnerOk = hasPartner ? partnerMonth >= VOUCHER_MILESTONE_ORDERS : true;
    return shipperOk && partnerOk;
  } catch (e) {
    console.error('[voucherBorneByCrabor]', e.message);
    return false; // mặc định: shipper/đối tác gánh
  }
}

// ── Helper: áp voucher (dùng chung food/laundry/cleaning/ride) ──
// bases: { order: giá trị đơn, ship: phí giao (ride = cước xe) }
// target 'order' → tính trên giá trị đơn; target 'ship' → tính trên phí giao.
// Trả về discount theo type (percent + maxDiscount / fixed VNĐ) và ghi nhận lượt dùng.
async function applyVoucher(code, bases, customerId, module) {
  if (!code) return { discount: 0, applied: null };
  try {
    const v = await Voucher.findOne({ code: String(code).toUpperCase().trim(), active: true, expiresAt: { $gt: new Date() } });
    if (!v) return { discount: 0, applied: null };
    if (v.usedCount >= v.usageLimit) return { discount: 0, applied: null };
    if (v.module !== "all" && v.module !== module) return { discount: 0, applied: null };
    // Voucher đổi bằng điểm: CHỈ chủ sở hữu được dùng
    if (v.source === 'loyalty') {
      if (!customerId || !v.ownerId || String(v.ownerId) !== String(customerId)) {
        console.log(`[applyVoucher] Chặn voucher loyalty ${v.code}: không phải chủ sở hữu`);
        return { discount: 0, applied: null };
      }
    }
    // Chọn base giảm theo target
    const subtotal = v.target === "ship" ? (bases.ship || bases.order || 0) : (bases.order || 0);
    // FIX: minOrder so sánh với GIÁ TRỊ ĐƠN HÀNG (không phải phí giao!)
    // Trước đây ship-voucher bị so minOrder với phí giao (~20k) nên mã minOrder 50k+ không bao giờ áp dụng được
    if ((bases.order || 0) < (v.minOrder || 0)) return { discount: 0, applied: null };
    const discount = subtotal > 0 && v.type === "percent"
      ? Math.min(Math.round(subtotal * v.value / 100), v.maxDiscount || Infinity)
      : (subtotal > 0 ? Math.min(v.value, subtotal) : 0);
    await Voucher.updateOne({ _id: v._id }, { $inc: { usedCount: 1 }, $addToSet: { usedBy: customerId } });
    return { discount, applied: v };
  } catch (e) {
    console.error('[applyVoucher]', e.message);
    return { discount: 0, applied: null };
  }
}

// ── Helper: thu nhập thực nhận của shipper sau khi gánh voucher (đồng bộ, cho thống kê) ──
function shipperOrderEarnNet(o) {
  const raw = Math.round(shipperOrderEarningsBase(o) * 0.7);
  const bear = typeof o.voucherShipperBear === "number" ? o.voucherShipperBear : 0;
  return Math.max(0, raw - bear);
}

async function calcEarnings(order) {
  // Dọn nhà là cleaning order: earnings base = price, không có partner
  const isCleaning = !!(order && (order.module === 'cleaning' || order.serviceType));
  const originalTotal = isCleaning ? (order.price || 0) : (order.total || 0);
  const finalTotal = isCleaning
    ? Math.max(0, (order.price || 0) - (order.discount || 0))
    : (order.finalTotal || (originalTotal + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0)));
  const shipFee    = order.shipFee    || 0;
  const serviceFee = order.serviceFee || 0;
  const discount   = order.discount   || 0;
  const module     = isCleaning ? 'cleaning' : (order.module || 'food');

  // Platform thu 30% — shipper/tài xế/giúp việc giữ 70% (ride tính trên cước, dọn nhà trên giá ca)
  const PLATFORM_FEE_PCT = 30;
  const shipperEarnRaw = Math.round(shipperOrderEarningsBase(order) * (1 - PLATFORM_FEE_PCT / 100));

  // Hoa hồng thống nhất theo module (không đọc commission tùy biến từng partner)
  const commissionPct = isCleaning ? 0 : (DEFAULT_COMMISSION[module] ?? 20);
  const partnerBase = Math.max(0, originalTotal);
  const partnerEarnRaw = isCleaning ? 0 : Math.round(partnerBase * (1 - commissionPct / 100));

  // ── PHÂN BỔ VOUCHER ──
  // CRABOR chỉ là trung gian → KHÔNG chịu voucher. Mặc định shipper + đối tác
  // cùng gánh theo đúng TỶ LỆ THU NHẬP THỰC NHẬN của họ; đơn không có đối tác
  // (xe công nghệ, dọn nhà) → shipper gánh 100%.
  // Chỉ khi cả shipper VÀ đối tác đạt ≥100 đơn/tháng thì CRABOR chịu toàn bộ.
  let voucherShipperBear = 0, voucherPartnerBear = 0, voucherCraborBear = 0;
  if (discount > 0) {
    const hasPartner = !isCleaning && !!(order.partnerId && String(order.partnerId) !== "0");
    if (await voucherBorneByCrabor(order)) {
      voucherCraborBear = discount;
    } else if (hasPartner) {
      const earnSum12 = shipperEarnRaw + partnerEarnRaw;
      if (earnSum12 > 0) {
        voucherShipperBear = Math.round(discount * shipperEarnRaw / earnSum12);
        voucherPartnerBear = discount - voucherShipperBear;
      } else {
        voucherShipperBear = discount;
      }
    } else {
      voucherShipperBear = discount; // ride/dọn nhà: shipper gánh 100%
    }
  }

  const shipperEarn = Math.max(0, shipperEarnRaw - voucherShipperBear);
  const partnerEarn = Math.max(0, partnerEarnRaw - voucherPartnerBear);

  // CRABOR giữ đúng serviceFee + hoa hồng (không mất tiền voucher).
  // Chỉ khi milestone (CRABOR chịu) thì craborEarn giảm đúng bằng discount.
  const craborEarn = finalTotal - shipperEarn - partnerEarn;

  // Lưu phân bổ voucher vào đơn để thống kê/đối soát chính xác (chỉ ghi khi có thay đổi)
  if (typeof order.save === 'function') {
    const changed = order.voucherShipperBear !== voucherShipperBear ||
                    order.voucherPartnerBear !== voucherPartnerBear ||
                    order.voucherCraborBear  !== voucherCraborBear;
    if (changed) {
      try {
        order.voucherShipperBear = voucherShipperBear;
        order.voucherPartnerBear = voucherPartnerBear;
        order.voucherCraborBear  = voucherCraborBear;
        await order.save();
      } catch (e) {
        console.error('[calcEarnings] save voucher attribution:', e.message);
      }
    }
  }

  return { shipperEarn, partnerEarn, craborEarn, commissionPct, serviceFee, module, discount,
           voucherShipperBear, voucherPartnerBear, voucherCraborBear };
}

// ── Helper: đếm số đơn đã hoàn thành của shipper (all-time + hôm nay) ──
async function countShipperCompletedOrders(shipperId) {
  if (!shipperId) return { totalOrders: 0, todayOrders: 0 };
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  try {
    const [foodTotal, foodToday, cleanTotal, cleanToday] = await Promise.all([
      Order.countDocuments({ shipperId, status: "delivered" }),
      Order.countDocuments({ shipperId, status: "delivered", deliveredAt: { $gte: todayStart } }),
      mongoose.models.CleaningOrder ? CleaningOrder.countDocuments({ shipperId, status: "completed" }) : 0,
      mongoose.models.CleaningOrder ? CleaningOrder.countDocuments({ shipperId, status: "completed", completedAt: { $gte: todayStart } }) : 0,
    ]);
    return { totalOrders: foodTotal + cleanTotal, todayOrders: foodToday + cleanToday };
  } catch (e) {
    console.error('[countShipperCompletedOrders]', e.message);
    return { totalOrders: 0, todayOrders: 0 };
  }
}

// ── Helper: key ngày / tháng (cho tracking online-time) ─────────
function dayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function monthKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}

// ── Helper: cộng dồn thời gian online real-time ────────────────
// Gọi mỗi khi shipper ping location (10s), bật/tắt online → tích lũy chính xác
async function flushOnlineTime(shipperId, now = new Date()) {
  if (!shipperId) return;
  try {
    const sh = await Shipper.findById(shipperId).select('onlineAt onlineSecondsToday onlineDay onlineSecondsMonth onlineMonth onlineSecondsTotal').lean().catch(() => null);
    if (!sh || !sh.onlineAt) return;
    const secs = Math.max(0, Math.floor((now - new Date(sh.onlineAt)) / 1000));
    if (secs <= 0) return;
    const tk = dayKey(now), mk = monthKey(now);
    const todaySecs = sh.onlineDay === tk ? (sh.onlineSecondsToday || 0) + secs : secs;
    const monthSecs = sh.onlineMonth === mk ? (sh.onlineSecondsMonth || 0) + secs : secs;
    await Shipper.updateOne({ _id: shipperId }, {
      $set: {
        onlineSecondsToday: todaySecs, onlineDay: tk,
        onlineSecondsMonth: monthSecs, onlineMonth: mk,
        onlineSecondsTotal: (sh.onlineSecondsTotal || 0) + secs,
        onlineAt: now,
      }
    });
  } catch (e) {
    console.error('[flushOnlineTime]', e.message);
  }
}

// ── Helper: thống kê hiệu suất shipper real-time ────────────────
// Trả về các chỉ số từ dữ liệu đơn thực tế: đã giao, hủy, hoàn thành, nhận đơn, thu nhập
async function getShipperStats(shipperId, shipper) {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0,0,0,0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Thu nhập thực nhận = base × 70% trừ phần shipper gánh voucher (CRABOR trung gian không chịu)
  const earnSum = (docs) => docs.reduce((s, o) => s + shipperOrderEarnNet(o), 0);

  const [deliveredToday, deliveredWeek, deliveredMonth, deliveredTotal, cancelledTotal, inProgressTotal, deliveredTodayDocs, deliveredWeekDocs, deliveredMonthDocs, ratedOrders] = await Promise.all([
    Order.countDocuments({ shipperId, status: "delivered", deliveredAt: { $gte: todayStart } }),
    Order.countDocuments({ shipperId, status: "delivered", deliveredAt: { $gte: weekStart } }),
    Order.countDocuments({ shipperId, status: "delivered", deliveredAt: { $gte: monthStart } }),
    Order.countDocuments({ shipperId, status: "delivered" }),
    Order.countDocuments({ shipperId, status: "cancelled" }),
    Order.countDocuments({ shipperId, status: { $in: ["shipper_accepted","picking_up","at_partner","picked_up","delivering","in_progress","ready_return","shipper_returning","picked_up_by_shipper"] } }),
    Order.find({ shipperId, status: "delivered", deliveredAt: { $gte: todayStart } }).select("shipFee deliveryFee module total discount voucherShipperBear").lean(),
    Order.find({ shipperId, status: "delivered", deliveredAt: { $gte: weekStart } }).select("shipFee deliveryFee module total discount voucherShipperBear").lean(),
    Order.find({ shipperId, status: "delivered", deliveredAt: { $gte: monthStart } }).select("shipFee deliveryFee module total discount voucherShipperBear").lean(),
    Order.find({ shipperId, status: "delivered", ratingShipper: { $gte: 1 } }).select("ratingShipper").lean(),
  ]);

  // Thu nhập thực tế từ ví (đã duyệt) + ước tính theo phí ship
  const todayEarnings = earnSum(deliveredTodayDocs);
  const weekEarnings  = earnSum(deliveredWeekDocs);
  const monthEarnings = earnSum(deliveredMonthDocs);

  // Tỷ lệ nhận đơn / hoàn thành / hủy (tính từ đơn thực tế shipper đã làm)
  const acceptedTotal = deliveredTotal + inProgressTotal;
  const completionRate = acceptedTotal > 0 ? Math.round((deliveredTotal / acceptedTotal) * 100) : 100;
  const cancelRate = (deliveredTotal + cancelledTotal) > 0 ? Math.round((cancelledTotal / (deliveredTotal + cancelledTotal)) * 100) : 0;
  const acceptRate = Math.max(0, 100 - cancelRate);
  const avgRating = ratedOrders.length > 0 ? ratedOrders.reduce((s, o) => s + o.ratingShipper, 0) / ratedOrders.length : (shipper?.rating || 5);

  return {
    todayOrders: deliveredToday,
    weekOrders: deliveredWeek,
    monthOrders: deliveredMonth,
    totalOrders: deliveredTotal,
    cancelledOrders: cancelledTotal,
    todayEarnings, weekEarnings, monthEarnings,
    acceptRate, completionRate, cancelRate,
    rating: Math.round(avgRating * 10) / 10,
    onlineSecondsToday: shipper?.onlineSecondsToday || 0,
    onlineSecondsMonth: shipper?.onlineSecondsMonth || 0,
    onlineSecondsTotal: shipper?.onlineSecondsTotal || 0,
    onlineMinutesToday: Math.round((shipper?.onlineSecondsToday || 0) / 60),
    onlineHoursMonth: Math.round(((shipper?.onlineSecondsMonth || 0) / 3600) * 10) / 10,
  };
}

// ── Helper: thêm vào wallet pending queue (tránh trùng) ──────
async function addToWalletQueue(orderId, recipientId, recipientType, amount, paymentMethod, note, releaseAt = null) {
  if (amount <= 0) return;
  const exists = await WalletQueue.findOne({ orderId, recipientId, recipientType, amount, status: { $in: ["pending", "approved"] } }).lean().catch(() => null);
  if (exists) return;
  await WalletQueue.create({ orderId, recipientId, recipientType, amount, paymentMethod, note, releaseAt });
}

// ── Helper: cộng tiền trực tiếp vào ví (auto-duyệt) ─────────
async function creditWalletDirect(recipientId, recipientType, amount, ref = null, note = "") {
  if (!recipientId || amount <= 0) return;
  if (recipientType === "shipper") {
    const upd = await Shipper.findByIdAndUpdate(recipientId, { $inc: { walletBalance: amount, totalEarnings: amount } }, { new: true });
    if (upd) {
      await WalletTx.create({ ownerId: recipientId, ownerType: "shipper", type: "credit", amount, balance: upd.walletBalance, ref, note: note || "Thu nhập đơn hàng" });
      return upd;
    }
    return null;
  }
  const pModels = [
    mongoose.models.FoodPartner, mongoose.models.GiatLa,
    mongoose.models.GiupViec,   mongoose.models.ChinaShop,
  ].filter(Boolean);
  for (const m of pModels) {
    const upd = await m.findByIdAndUpdate(recipientId, { $inc: { walletBalance: amount, totalSales: amount } }, { new: true });
    if (upd) {
      await WalletTx.create({ ownerId: recipientId, ownerType: "partner", type: "credit", amount, balance: upd.walletBalance, ref, note: note || "Thu nhập đơn hàng" });
      return upd;
    }
  }
  return null;
}

// ── Helper: auto-credit earnings + ghi WalletQueue approved (chống đúp) ──
async function autoCreditOrderEarnings(order, shipperEarn, partnerEarn, method, baseNote) {
  if (order.shipperId && shipperEarn > 0) {
    const already = await WalletQueue.findOne({
      orderId: order.orderId, recipientId: order.shipperId, recipientType: "shipper",
      amount: shipperEarn, status: "approved",
    }).lean().catch(() => null);
    if (!already) {
      await creditWalletDirect(order.shipperId, "shipper", shipperEarn, order.orderId, `${baseNote} — phí ship`);
      await WalletQueue.create({
        orderId: order.orderId, recipientId: order.shipperId,
        recipientType: "shipper", amount: shipperEarn,
        paymentMethod: method,
        note: `${baseNote} — phí ship`,
        status: "approved", approvedBy: "auto_credit", approvedAt: new Date(),
      });
      await notifyUser('shipper', order.shipperId, {
        type: 'income', title: '💰 Thu nhập mới!',
        body: `Đơn ${order.orderId} — bạn nhận ${shipperEarn.toLocaleString('vi-VN')}đ (phí ship)`,
        ref: order.orderId, refModule: order.module || 'food',
      });
    }
  }
  if (order.partnerId && partnerEarn > 0) {
    const already = await WalletQueue.findOne({
      orderId: order.orderId, recipientId: order.partnerId, recipientType: "partner",
      amount: partnerEarn, status: "approved",
    }).lean().catch(() => null);
    if (!already) {
      await creditWalletDirect(order.partnerId, "partner", partnerEarn, order.orderId, `${baseNote} — tiền hàng`);
      await WalletQueue.create({
        orderId: order.orderId, recipientId: order.partnerId,
        recipientType: "partner", amount: partnerEarn,
        paymentMethod: method,
        note: `${baseNote} — tiền hàng`,
        status: "approved", approvedBy: "auto_credit", approvedAt: new Date(),
      });
    }
  }
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

// ── Helper: tìm shipper cho đơn giặt — 5km rồi mở rộng dần ──
async function findLaundryShippers(lat, lng, baseRadiusKm = 5, limit = 5) {
  const radii = [baseRadiusKm, Math.round(baseRadiusKm * 2), Math.round(baseRadiusKm * 3), Math.round(baseRadiusKm * 5)];
  let best = [];
  for (const r of radii) {
    const found = await findNearbyShippers(lat, lng, r, limit, true);
    if (found.length) { best = found; break; }
    best = found.length ? found : best;
  }
  return best;
}

// ── Helper: tìm shipper cho đơn dọn nhà — 5km rồi mở rộng dần ──
async function findCleaningShippers(lat, lng, baseRadiusKm = 5, limit = 10) {
  const radii = [baseRadiusKm, Math.round(baseRadiusKm * 2), Math.round(baseRadiusKm * 3), Math.round(baseRadiusKm * 5)];
  let best = [];
  for (const r of radii) {
    const found = await findNearbyShippers(lat, lng, r, limit, false, true);
    if (found.length) { best = found; break; }
  }
  return best;
}

// ── Helper: find nearby shippers ─────────────────────────────
// requireLaundry=true → chỉ lấy shipper có preferences.acceptLaundry === true
// requireCleaning=true → chỉ lấy shipper đã mở khoá/nhận đơn dọn nhà
async function findNearbyShippers(lat, lng, radiusKm = 5, limit = 5, requireLaundry = false, requireCleaning = false) {
  const query = {
    status: { $in: ["approved", "active"] },
    online: true,
    isAccepting: true,
  };
  if (requireLaundry) {
    query["preferences.acceptLaundry"] = true;
    // Tài khoản chỉ đăng ký Dọn nhà → không nhận giặt là
    query.workType = { $ne: "cleaning" };
  } else if (!requireCleaning) {
    // Food / Ride / mặc định: loại tài khoản chỉ đăng ký Dọn nhà
    query.workType = { $ne: "cleaning" };
  }
  if (requireCleaning) query["$or"] = [
    { "preferences.acceptCleaning": true },
    { "preferences.cleaningRegistered": true },
  ];
  const shippers = await Shipper.find(query).select("_id phone fullName location pushToken walletBalance rating totalOrders");

  // Loại shipper đang bị chặn vì nợ tiền mặt quá hạn
  const blockedIds = await getCashBlockedShipperIds(shippers.map(s => s._id));
  const active = blockedIds.size ? shippers.filter(s => !blockedIds.has(String(s._id))) : shippers;

  const R = 6371;
  const withDistance = active.map(s => {
    // Shipper không có GPS location → fallback distance = 0 (ưu tiên nhận đơn)
    const hasLoc = !!(s.location?.lat && s.location?.lng);
    if (!lat || !lng || !hasLoc) return { ...s.toObject(), distKm: 0, noLocation: !hasLoc };
    const dLat = (s.location.lat - lat) * Math.PI / 180;
    const dLng = (s.location.lng - lng) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
      Math.cos(lat * Math.PI/180) * Math.cos(s.location.lat * Math.PI/180) * Math.sin(dLng/2)**2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return { ...s.toObject(), distKm: Math.round(dist * 10) / 10 };
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
        total: order.total,
        finalTotal: order.finalTotal,
        discount: order.discount || 0,
        voucherCode: order.voucherCode,
        shipFee: order.shipFee,
        serviceFee: order.serviceFee,
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
      await notifyUser('shipper', s._id, {
        type: 'new_order', title: '🚚 Đơn hàng mới!',
        body: `Đơn #${order.orderId?.slice(-6)} cần giao`,
        ref: String(order._id), refModule: order.module || 'food',
      });
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
        total: order.total,
        finalTotal: order.finalTotal,
        discount: order.discount || 0,
        voucherCode: order.voucherCode,
        voucherDiscount: order.voucherDiscount || 0,
        shipFee: order.shipFee,
        serviceFee: order.serviceFee || 0,
        pickupAddress: order.partnerAddress || "Địa chỉ quán",
        pickupLat,
        pickupLng,
        deliveryAddress: order.address,
        deliveryLat: order.addressLat || order.deliveryLat || order.lat || null,
        deliveryLng: order.addressLng || order.deliveryLng || order.lng || null,
        note: order.note,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        module: order.module,
        partnerName: order.partnerName || "Cửa hàng",
      },
      timeout: 30,
    };

    for (const shipper of nearbyShippers) {
      io.to(`shipper_${shipper._id}`).emit("order_request", payload);
      await notifyUser('shipper', shipper._id, {
        type: 'new_order', title: '🚚 Đơn hàng mới!',
        body: `Đơn #${order.orderId?.slice(-6)} cần giao`,
        ref: String(order._id), refModule: order.module || 'food',
      });
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
    await loadSessionFromHeader(req, res);
    if (!req.session.userId)
      return res.status(401).json({ success: false, message: "Chưa đăng nhập" });

    const { partnerId, items, address, note, paymentMethod, voucherCode, shipFee, fromAddress, fromLat, fromLng, toAddress, toLat, toLng, vehicleType, clientRequestId } = req.body;

    // ── IDEMPOTENCY: chặn tạo đơn trùng khi app gửi lặp (double-tap / retry) ──
    const dedupeKey = clientRequestId || null;
    if (dedupeKey) {
      const existed = await Order.findOne({ clientRequestId: dedupeKey }).lean();
      if (existed) {
        return res.json({ success: true, orderId: existed.orderId, order: existed, duplicated: true });
      }
    } else {
      // Fallback: trùng khách + quán + tổng tiền trong vòng 15 giây → trả lại đơn cũ
      const window = new Date(Date.now() - 15000);
      const dup = await Order.findOne({
        customerId: req.session.userId,
        partnerId: partnerId || { $exists: false },
        createdAt: { $gte: window },
      }).sort({ createdAt: -1 }).lean();
      if (dup && !['ride'].includes(dup.module || 'food')) {
        return res.json({ success: true, orderId: dup.orderId, order: dup, duplicated: true });
      }
    }

    if (!items?.length && !fromAddress) 
      return res.status(400).json({ success: false, message: "Thiếu thông tin đơn hàng" });

    const user = await User.findById(req.session.userId).select("fullName phone cancelCount cashBlocked");
    
    // Block COD nếu bị khóa
    const pmMethod = req.body.paymentMethod || "cash";
    if (pmMethod === "cash" && user?.cashBlocked) {
      return res.status(403).json({ success: false, message: "Bạn đã hủy đơn quá 2 lần. Vui lòng dùng PayOS, SePay hoặc ví CRABOR.", cashBlocked: true });
    }
    
    let order;
    
    // Xử lý đơn ride
    if (fromAddress && toAddress) {
      const total = shipFee || 30000;
      order = new Order({
        clientRequestId: dedupeKey || undefined,
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
        customerPhone: user?.phone || "",
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
      // Validate voucher nếu có — dùng applyVoucher thống nhất (percent/fixed + minOrder + usageLimit + module)
      let discount = 0;
      if (voucherCode) {
        const vres = await applyVoucher(voucherCode, { order: total, ship: fShipFee }, req.session.userId, "food");
        discount = vres.discount;
      }

      order = new Order({
        clientRequestId: dedupeKey || undefined,
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
        voucherDiscount: discount,
        customerName: user?.fullName || "Khách hàng",
        customerPhone: user?.phone || "",
        partnerAddress: partner?.address,
        statusHistory: [{ status: "pending", by: "customer" }],
      });
    }

    // ── WALLET: Trừ tiền ví CRABOR của khách NGAY khi đặt đơn ──
    const isWalletPay = (paymentMethod || "cash") === "wallet";
    if (isWalletPay) {
      const orderAmount = Math.max(0, (order.total||0) + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0));
      const userDoc = await User.findById(req.session.userId).select("walletBalance");
      if (!userDoc || (userDoc.walletBalance||0) < orderAmount) {
        return res.status(400).json({
          success: false,
          message: `Ví CRABOR không đủ số dư. Cần ${orderAmount.toLocaleString("vi-VN")}đ, hiện có ${(userDoc?.walletBalance||0).toLocaleString("vi-VN")}đ.`,
          walletInsufficient: true,
        });
      }
      // Tạm đánh dấu để save xong mới deduct (cần orderId làm ref)
      order.paymentStatus = "paid";
      order.paidAt = new Date();
    }

    // ── VÍ TRẢ SAU (BNPL): check điều kiện + hạn mức, ghi nợ trả sau ──
    const isBnplPay = (paymentMethod || "cash") === "bnpl";
    let bnplBillingMonth = null;
    let bnplOrderAmount = 0;
    if (isBnplPay) {
      bnplOrderAmount = Math.max(0, (order.total||0) + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0));
      const bnplUser = await User.findById(req.session.userId).select("totalSpent isAdmin creditBnplEnabled trustScore cancelCount bnplOnTimePaid bnplActivationStatus");
      const bnplSpecial   = bnplUser?.isAdmin || bnplUser?.creditBnplEnabled;
      const bnplActivated = bnplUser?.bnplActivationStatus === 'approved';
      const bnplEligible  = bnplSpecial || (bnplActivated && (bnplUser?.totalSpent||0) >= 5000000 && (bnplUser?.trustScore ?? 60) >= TRUST_MIN_UNLOCK && !isCancelLocked(bnplUser));
      if (!bnplEligible) {
        return res.status(403).json({
          success: false,
          bnplNotEligible: true,
          message: "Bạn chưa đủ điều kiện dùng Ví Trả Sau. Vui lòng mở khóa (ký hợp đồng), đạt ≥5.000.000đ chi tiêu, điểm tin cậy ≥ 50 và không hủy đơn nhiều.",
        });
      }
      if (await hasOverdueBnpl(req.session.userId)) {
        return res.status(403).json({
          success: false,
          bnplLocked: true,
          message: "Ví Trả Sau đã bị khóa do còn hóa đơn quá hạn chưa thanh toán. Vui lòng thanh toán để mở khóa.",
        });
      }
      const bnplLimit = bnplSpecial ? Math.max(2000000, getBnplLimit(bnplUser?.bnplOnTimePaid||0)) : getBnplLimit(bnplUser?.bnplOnTimePaid||0);
      bnplBillingMonth = getCurrentBillingMonth();
      const bnplTxs = await BNPLTx.find({ userId: req.session.userId, billingMonth: bnplBillingMonth, status:{$in:['pending_bill','billed']} });
      const bnplUsed = bnplTxs.reduce((s,t)=>s+t.amount,0);
      if (bnplUsed + bnplOrderAmount + bnplFeeOf(bnplOrderAmount) > bnplLimit) {
        return res.status(400).json({
          success: false,
          bnplLimitExceeded: true,
          message: `Vượt hạn mức Ví Trả Sau. Hạn mức: ${bnplLimit.toLocaleString("vi-VN")}đ, còn lại: ${Math.max(0, bnplLimit-bnplUsed).toLocaleString("vi-VN")}đ, cần: ${bnplOrderAmount.toLocaleString("vi-VN")}đ.`,
        });
      }
      // Nợ trả sau: đơn được coi là đã thanh toán (công ty ứng trước), khách trả vào hóa đơn cuối tháng
      order.paymentStatus = "paid";
      order.paidAt = new Date();
    }

    await order.save();

    if (isWalletPay) {
      const orderAmount = Math.max(0, (order.total||0) + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0));
      await walletDebit(req.session.userId, "user", orderAmount, "debit", order.orderId, `Thanh toán đơn ${order.orderId} bằng ví CRABOR`);
      // Thông báo khách trừ ví thành công
      req.io.to(`customer_${req.session.userId}`).emit("walletDebited", {
        amount: orderAmount, orderId: order.orderId, message: `Đã trừ ${orderAmount.toLocaleString("vi-VN")}đ cho đơn ${order.orderId}`,
      });
    }

    // ── VÍ TRẢ SAU: lập tức ghi giao dịch trả sau (lên hóa đơn kỳ này) ──
    if (isBnplPay) {
      try {
        await BNPLTx.create({
          userId: req.session.userId,
          orderId: order.orderId,
          baseAmount: bnplOrderAmount,
          fee: bnplFeeOf(bnplOrderAmount),
          amount: bnplOrderAmount + bnplFeeOf(bnplOrderAmount),
          serviceType: order.module || 'food',
          billingMonth: bnplBillingMonth,
        });
        req.io.to(`customer_${req.session.userId}`).emit("bnplUsed", {
          amount: bnplOrderAmount, orderId: order.orderId,
          message: `Đơn ${order.orderId} đã vào Ví Trả Sau — thanh toán trước ngày 15 tháng sau`,
        });
      } catch (bnplErr) {
        console.error('[BNPL] tạo BNPLTx lỗi:', bnplErr.message);
      }
    }

    // Thông báo partner có đơn mới
    // FIX: emit này trước đây nằm TRƯỚC order.save(), nên order.orderId và
    // order.finalTotal (được set trong Mongoose pre('save') hook) luôn là
    // undefined lúc gửi realtime cho partner app. Chuyển xuống sau save()
    // và bổ sung voucherCode/discount để partner app hiển thị đúng, đủ.
    if (order.module === "food" && order.partnerId) {
      await notifyUser('partner', order.partnerId, {
        type: 'new_order', title: '📦 Đơn hàng mới!',
        body: `Đơn ${order.orderId} — ${(order.finalTotal||order.total||0).toLocaleString('vi-VN')}đ. Khách: ${order.customerName}`,
        ref: order.orderId, refModule: 'food',
      });
      req.io.to(`partner_${order.partnerId}`).emit("new_order", {
        order: {
          _id: order._id,
          orderId: order.orderId,
          items: order.items,
          total: order.total,
          shipFee: order.shipFee,
          serviceFee: order.serviceFee,
          discount: order.discount,
          voucherCode: order.voucherCode,
          voucherDiscount: order.voucherDiscount,
          finalTotal: order.finalTotal,
          address: order.address,
          note: order.note,
          customerName: order.customerName,
          paymentMethod: order.paymentMethod,
          createdAt: order.createdAt,
        }
      });
    }
    
    // ── DISPATCH SHIPPER ──
    // Đơn FOOD: CHỜ PARTNER XÁC NHẬN CÒN MÓN đã (endpoint accept của partner
    // sẽ dispatch shipper ngay lúc đó). Các module khác (ride...) dispatch ngay.
    if (order.module === 'food') {
      console.log(`[Order] Food order ${order.orderId} chờ partner xác nhận trước khi tìm shipper`);
    } else {
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
          originalTotal: order.total,
          discount: order.discount,
          voucherCode: order.voucherCode,
          voucherDiscount: order.voucherDiscount,
          shipFee: order.shipFee,
          pickupAddress: order.partnerAddress || "Địa chỉ quán",
          pickupLat,
          pickupLng,
          deliveryAddress: order.address,
          deliveryLat: order.addressLat || null,
          deliveryLng: order.addressLng || null,
          note: order.note,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          module: order.module,
          partnerName: order.partnerName || "Cửa hàng",
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
    }
    
    req.io.to("admin").emit("newOrderNotification", { orderId: order.orderId, module: order.module, total: order.finalTotal });

    // FIX: Enrich discount fields trong response để customer app nhận đủ thông tin
    const orderRes = order.toObject ? order.toObject() : order;
    orderRes.discount = orderRes.discount || 0;
    orderRes.voucherCode = orderRes.voucherCode || null;
    orderRes.voucherDiscount = orderRes.voucherDiscount || 0;
    orderRes.finalTotal = orderRes.finalTotal ?? Math.max(0, (orderRes.total||0) + (orderRes.shipFee||0) + (orderRes.serviceFee||0) - (orderRes.discount||0));

    res.status(201).json({ success: true, order: orderRes, orderId: order.orderId });
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
      cancelled:   isCustomer && ["pending","confirmed","preparing","shipper_accepted"].includes(order.status), // Customer hủy được trước khi shipper đến lấy hàng
    };

    const _ak = req.headers["x-admin-key"];
    const _vk = process.env.ADMIN_SECRET_KEY || "crabor-admin-secret-2025";
    const _isAdm = (_ak === _vk) || !!req.session?.adminId;
    if (!allowed[status] && !_isAdm)
      return res.status(403).json({ success: false, message: `Không có quyền set status ${status}` });

    order.status = status;
    order.cancelReason = (status === "cancelled" && req.body.reason) ? req.body.reason : order.cancelReason;
    order.statusHistory.push({ status, by: isShipper ? "shipper" : isPartner ? "partner" : "customer", time: new Date() });

    // ── Khi customer hủy → thông báo shipper (nếu đã assign) ──
    if (status === "cancelled" && isCustomer) {
      if (order.shipperId) {
        req.io.to(`shipper_${order.shipperId}`).emit("order_cancelled", {
          orderId: order.orderId,
          message: "Khách hàng đã hủy đơn hàng",
          cancelReason: order.cancelReason || null,
        });
      }
      req.io.to(`partner_${order.partnerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "cancelled",
        message: "Khách hàng đã hủy đơn hàng",
      });
    }

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
      // Chặn nếu shipper nợ tiền mặt quá hạn
      if (req.session.shipperId && await isShipperCashBlocked(req.session.shipperId)) {
        req.io.to(`shipper_${req.session.shipperId}`).emit("cash_settlement_blocked", {
          message: "Bạn đang nợ tiền mặt quá 24h. Vui lòng chuyển tiền về công ty trước khi nhận đơn mới.",
        });
        return res.status(403).json({ success: false, message: "Bạn đang nợ tiền mặt quá 24h. Vui lòng chuyển tiền về công ty tại màn 'Thanh toán chi phí đơn tiền mặt'." });
      }
      // Chặn nếu shipper chưa hoàn tất xác minh danh tính (CCCD + gương mặt)
      if (req.session.shipperId) {
        const _sh = await Shipper.findById(req.session.shipperId).select("status documents feeStatus fee identityVerified").lean().catch(() => null);
        if (_sh) {
          const doc = _sh.documents || {};
          const hasDocs = !!doc.cccdFront && !!doc.cccdBack && !!doc.selfie;
          const verified = !!_sh.identityVerified || hasDocs;
          if (!verified) {
            req.io?.to(`shipper_${req.session.shipperId}`).emit("verify_identity_required", {
              message: "Bạn cần hoàn tất xác minh danh tính (CCCD 2 mặt + ảnh gương mặt) trước khi nhận đơn.",
            });
            return res.status(403).json({ success: false, needVerification: true, message: "Bạn cần hoàn tất xác minh danh tính (CCCD 2 mặt + ảnh gương mặt) tại mục 'Xác minh thông tin' trước khi nhận đơn." });
          }
          // Chặn nếu chưa đóng phí đăng ký shipper
          if (_sh.feeStatus !== "paid") {
            req.io?.to(`shipper_${req.session.shipperId}`).emit("fee_unpaid_blocked", {
              message: "Bạn chưa đóng phí đăng ký shipper. Vui lòng thanh toán để nhận đơn mới.",
            });
            return res.status(403).json({ success: false, needFee: true, message: "Bạn chưa đóng phí đăng ký shipper. Vui lòng thanh toán tại màn 'Thu nhập' để nhận đơn mới." });
          }
        }
      }
      // ── CHỐT ĐƠN: chỉ DUY NHẤT 1 shipper được nhận (atomic claim) ──
      const _claimFood = await Order.findOneAndUpdate(
        { _id: order._id, $or: [{ shipperId: null }, { shipperId: { $exists: false } }] },
        { $set: { shipperId: req.session.shipperId } },
        { new: true }
      );
      if (!_claimFood) {
        // Shipper khác đã nhận trước đó
        req.io.to(`shipper_${req.session.shipperId}`).emit("order_taken", { orderId: order.orderId, message: "Đơn hàng đã có người nhận" });
        return res.status(409).json({ success: false, taken: true, message: "Đơn hàng đã có người nhận" });
      }
      order.shipperId = req.session.shipperId;
      // Thông báo CÁC SHIPPER KHÁC từng được dispatch: đơn đã có người nhận
      // (KHÔNG broadcast toàn phòng — người thắng cũng đang trong room, nhận nhầm sẽ tự đóng modal)
      const _otherDispatched = (order.dispatchedTo || []).map(String).filter(id => id !== String(req.session.shipperId));
      for (const sid of _otherDispatched) {
        req.io.to(`shipper_${sid}`).emit("order_taken", { orderId: order.orderId, message: "Đơn hàng đã có người nhận" });
      }
      const _autoMsg = {
        from: "shipper",
        text: `Bạn ơi chờ xíu nhé, CRABOR sắp tới nơi rồi (${order.orderId})`,
        time: new Date(),
        type: "text",
        system: true,
      };
      await Order.findOneAndUpdate({ _id: order._id }, { $push: { chatMessages: _autoMsg } }).catch(() => {});
      req.io.to(`order_${order.orderId}`).emit("chatMessage", { orderId: order.orderId, ..._autoMsg });
      // Thông báo customer
      req.io.to(`customer_${order.customerId}`).emit("order_status_update", {
        orderId: order.orderId,
        status: "shipper_accepted",
        message: "Shipper đã nhận đơn và đang đến lấy hàng!",
      });
      // Thông báo partner
      req.io.to(`partner_${order.partnerId}`).emit("order_status_update", {
        orderId: order.orderId, status: "shipper_accepted",
        total: order.total, finalTotal: order.finalTotal,
        discount: order.discount || 0, voucherCode: order.voucherCode,
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
        total: order.total, finalTotal: order.finalTotal,
        discount: order.discount || 0, voucherCode: order.voucherCode,
      });
    }

    // ── Khi giao thành công (delivered) → xử lý thanh toán ──
    if (status === "delivered") {
      order.deliveredAt = new Date();
      const pm = order.paymentMethod;

      // Tích điểm loyalty (1/10 giá trị đơn) — chỉ 1 lần/đơn
      if (order.customerId && !order.loyaltyPointsGranted) {
        order.loyaltyPointsGranted = true;
        await earnLoyaltyPoints(order.customerId, orderPaidAmount(order));
      }

      // Tính tiền cho shipper và partner
      const { shipperEarn, partnerEarn } = await calcEarnings(order);

      if (pm === "cash") {
        // ── ĐƠN TIỀN MẶT: shipper đã thu tiền mặt → ghi nợ công ty ──
        // Earnings chưa cộng; chờ shipper chuyển đủ tiền về công ty mới release
        order.paymentStatus = "paid"; // shipper đã thu tiền mặt từ khách
        const finalTotal = order.finalTotal ?? Math.max(0, (order.total||0) + (order.shipFee||0) + (order.serviceFee||0) - (order.discount||0));
        const dueAt = new Date(Date.now() + 24 * 3600 * 1000); // 24h
        const existingSettlement = await CashSettlement.findOne({ orderId: order.orderId }).lean().catch(() => null);
        if (!existingSettlement) {
          await CashSettlement.create({
            orderId: order.orderId, orderModule: order.module || "food",
            shipperId: order.shipperId, partnerId: order.partnerId || null,
            total: finalTotal, amountPaid: 0,
            shipperEarn, partnerEarn,
            status: "pending", dueAt,
            note: `Đơn ${order.orderId} — tiền mặt`,
          });
          // Cảnh báo shipper phải chuyển tiền về công ty trong 24h
          if (order.shipperId) {
            req.io.to(`shipper_${order.shipperId}`).emit("cash_settlement_created", {
              orderId: order.orderId, amount: finalTotal, dueAt,
              message: `Bạn phải chuyển ${finalTotal.toLocaleString("vi-VN")}đ về công ty trong 24h`,
            });
          }
        }
        req.io.to("admin").emit("cash_settlement_pending", {
          orderId: order.orderId, shipperEarn, partnerEarn, amount: finalTotal, dueAt,
        });
      } else if (pm === "wallet" || pm === "bnpl") {
        // ── VÍ CRABOR / VÍ TRẢ SAU: tiền đã được bảo đảm khi đặt → AUTO CREDIT ngay ──
        order.paymentStatus = "paid";
        await autoCreditOrderEarnings(order, shipperEarn, partnerEarn, pm, `Đơn ${order.orderId} — ${pm === "bnpl" ? "ví trả sau" : "ví CRABOR"}`);
        if (order.shipperId) {
          req.io.to(`shipper_${order.shipperId}`).emit("sepay_payment_confirmed", {
            orderId: order.orderId, amount: order.finalTotal,
            message: `Khách đã thanh toán qua ${pm === "bnpl" ? "ví trả sau" : "ví CRABOR"} — ${(shipperEarn||0).toLocaleString("vi-VN")}đ đã vào ví bạn`,
          });
        }
      } else {
        // ── SEPAY/PAYOS/bank: chờ webhook auto-confirm ──
        // Vẫn thêm vào wallet queue như pending fallback; webhook sẽ delete + credit
        if (order.shipperId) {
          await addToWalletQueue(
            order.orderId, order.shipperId, "shipper", shipperEarn,
            pm, `Đơn ${order.orderId} — phí ship`
          );
        }
        if (order.partnerId) {
          await addToWalletQueue(
            order.orderId, order.partnerId, "partner", partnerEarn,
            pm, `Đơn ${order.orderId} — tiền hàng`
          );
        }
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
        paymentMethod: pm,
      });
    }

    await order.save();

    // FIX: Enrich discount fields trước khi gửi cho các app
    const orderObj = order.toObject();
    orderObj.discount = orderObj.discount || 0;
    orderObj.voucherCode = orderObj.voucherCode || null;
    orderObj.voucherDiscount = orderObj.voucherDiscount || 0;
    orderObj.finalTotal = orderObj.finalTotal ?? Math.max(0, (orderObj.total||0) + (orderObj.shipFee||0) + (orderObj.serviceFee||0) - (orderObj.discount||0));

    // Broadcast cho tất cả room đang track đơn này
    req.io.to(`order_${order.orderId}`).emit("orderStatusChanged", {
      orderId: order.orderId, status, order: orderObj,
    });

    res.json({ success: true, order: orderObj });
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

    const { vehicleType, fromAddress, fromLat, fromLng, toAddress, toLat, toLng, fee, note, paymentMethod: ridePayMethod, voucherCode } = req.body;
    if (!vehicleType || !fromAddress || !toAddress || !fee)
      return res.status(400).json({ success: false, message: "Thiếu thông tin đặt xe" });

    const user = await User.findById(req.session.userId).select("fullName phone");

    // Áp voucher (nếu có) — voucher giảm phí ship/giảm cước xe
    const { discount: rideDiscount, applied: appliedVoucher } = await applyVoucher(voucherCode, { order: fee, ship: fee }, req.session.userId, "ride");

    // Tạo ride order
    const rideOrder = new Order({
      module: "ride",
      customerId: req.session.userId,
      customerPhone: user?.phone || "",
      items: [{ name: `Xe ${vehicleType} — ${fromAddress} → ${toAddress}`, qty: 1, price: fee }],
      address: toAddress,
      fromLat: parseFloat(fromLat) || null, fromLng: parseFloat(fromLng) || null,
      toLat: parseFloat(toLat) || null, toLng: parseFloat(toLng) || null,
      addressLat: parseFloat(toLat) || null, addressLng: parseFloat(toLng) || null,
      total: fee,
      shipFee: 0,
      serviceFee: Math.round(fee * 0.1),
      discount: rideDiscount,
      voucherCode,
      voucherDiscount: rideDiscount,
      paymentMethod: ridePayMethod || "cash",
      note,
      customerName: user?.fullName || "Khách hàng",
      statusHistory: [{ status: "pending", by: "customer" }],
    });
    await rideOrder.save();

    // WALLET: trừ tiền ví CRABOR ngay khi đặt xe
    if ((ridePayMethod || "cash") === "wallet") {
      const amt = rideOrder.finalTotal ?? Math.max(0, fee + Math.round(fee * 0.1) - rideDiscount);
      const userDoc = await User.findById(req.session.userId).select("walletBalance");
      if (!userDoc || (userDoc.walletBalance||0) < amt) {
        await Order.findByIdAndDelete(rideOrder._id);
        if (appliedVoucher) await Voucher.updateOne({ _id: appliedVoucher._id }, { $inc: { usedCount: -1 }, $pull: { usedBy: req.session.userId } }).catch(() => {});
        return res.status(400).json({ success: false, message: `Ví CRABOR không đủ số dư. Cần ${amt.toLocaleString("vi-VN")}đ`, walletInsufficient: true });
      }
      rideOrder.paymentStatus = "paid";
      rideOrder.paidAt = new Date();
      await rideOrder.save();
      await walletDebit(req.session.userId, "user", amt, "debit", rideOrder.orderId, `Thanh toán cuốc xe ${rideOrder.orderId} bằng ví CRABOR`);
      req.io.to(`customer_${req.session.userId}`).emit("walletDebited", { amount: amt, orderId: rideOrder.orderId });
    }

    // ── VÍ TRẢ SAU (BNPL): check điều kiện + hạn mức, ghi nợ trả sau cho cuốc xe ──
    const isBnplRide = (ridePayMethod || "cash") === "bnpl";
    let bnplRideMonth = null;
    let bnplRideAmount = 0;
    if (isBnplRide) {
      bnplRideAmount = Math.max(0, rideOrder.finalTotal ?? (fee + Math.round(fee * 0.1) - (rideDiscount || 0)));
      const bnplUser = await User.findById(req.session.userId).select("totalSpent isAdmin creditBnplEnabled trustScore cancelCount bnplOnTimePaid bnplActivationStatus");
      const bnplSpecial   = bnplUser?.isAdmin || bnplUser?.creditBnplEnabled;
      const bnplActivated = bnplUser?.bnplActivationStatus === 'approved';
      const bnplEligible  = bnplSpecial || (bnplActivated && (bnplUser?.totalSpent||0) >= 5000000 && (bnplUser?.trustScore ?? 60) >= TRUST_MIN_UNLOCK && !isCancelLocked(bnplUser));
      if (!bnplEligible) {
        await Order.findByIdAndDelete(rideOrder._id);
        if (appliedVoucher) await Voucher.updateOne({ _id: appliedVoucher._id }, { $inc: { usedCount: -1 }, $pull: { usedBy: req.session.userId } }).catch(() => {});
        return res.status(403).json({ success: false, bnplNotEligible: true, message: "Bạn chưa đủ điều kiện dùng Ví Trả Sau. Vui lòng mở khóa (ký hợp đồng), đạt ≥5.000.000đ chi tiêu, điểm tin cậy ≥ 50 và không hủy đơn nhiều." });
      }
      if (await hasOverdueBnpl(req.session.userId)) {
        await Order.findByIdAndDelete(rideOrder._id);
        if (appliedVoucher) await Voucher.updateOne({ _id: appliedVoucher._id }, { $inc: { usedCount: -1 }, $pull: { usedBy: req.session.userId } }).catch(() => {});
        return res.status(403).json({ success: false, bnplLocked: true, message: "Ví Trả Sau đã bị khóa do còn hóa đơn quá hạn chưa thanh toán. Vui lòng thanh toán để mở khóa." });
      }
      const bnplLimit = bnplSpecial ? Math.max(2000000, getBnplLimit(bnplUser?.bnplOnTimePaid||0)) : getBnplLimit(bnplUser?.bnplOnTimePaid||0);
      bnplRideMonth = getCurrentBillingMonth();
      const bnplTxs = await BNPLTx.find({ userId: req.session.userId, billingMonth: bnplRideMonth, status:{$in:['pending_bill','billed']} });
      const bnplUsed = bnplTxs.reduce((s,t)=>s+t.amount,0);
      if (bnplUsed + bnplRideAmount + bnplFeeOf(bnplRideAmount) > bnplLimit) {
        await Order.findByIdAndDelete(rideOrder._id);
        if (appliedVoucher) await Voucher.updateOne({ _id: appliedVoucher._id }, { $inc: { usedCount: -1 }, $pull: { usedBy: req.session.userId } }).catch(() => {});
        return res.status(400).json({ success: false, bnplLimitExceeded: true, message: `Vượt hạn mức Ví Trả Sau. Hạn mức: ${bnplLimit.toLocaleString("vi-VN")}đ, còn lại: ${Math.max(0, bnplLimit-bnplUsed).toLocaleString("vi-VN")}đ, cần: ${bnplRideAmount.toLocaleString("vi-VN")}đ.` });
      }
      rideOrder.paymentStatus = "paid";
      rideOrder.paidAt = new Date();
      await rideOrder.save();
      try {
        await BNPLTx.create({
          userId: req.session.userId,
          orderId: rideOrder.orderId,
          baseAmount: bnplRideAmount,
          fee: bnplFeeOf(bnplRideAmount),
          amount: bnplRideAmount + bnplFeeOf(bnplRideAmount),
          serviceType: "ride",
          billingMonth: bnplRideMonth,
        });
        req.io.to(`customer_${req.session.userId}`).emit("bnplUsed", {
          amount: bnplRideAmount, orderId: rideOrder.orderId,
          message: `Cuốc xe ${rideOrder.orderId} đã vào Ví Trả Sau — thanh toán trước ngày 15 tháng sau`,
        });
      } catch (bnplErr) {
        console.error('[BNPL] tạo BNPLTx ride lỗi:', bnplErr.message);
      }
    }

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
      customerPhone: user?.phone || "",
      timeout: 30,
    };

    for (const s of nearby) {
      req.io.to(`shipper_${s._id}`).emit("ride_request", ridePayload);
      await notifyUser('shipper', s._id, {
        type: 'new_order', title: '🚗 Yêu cầu đặt xe mới!',
        body: `${rideOrder.customerName || 'Khách hàng'} — ${(fee || 0).toLocaleString('vi-VN')}đ`,
        ref: String(rideOrder._id), refModule: 'ride',
      });
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

    // Chặn nếu shipper nợ tiền mặt quá hạn
    if (await isShipperCashBlocked(req.session.shipperId)) {
      return res.status(403).json({ success: false, message: "Bạn đang nợ tiền mặt quá 24h. Vui lòng chuyển tiền về công ty tại màn 'Thanh toán chi phí đơn tiền mặt'." });
    }

    const shipper = await Shipper.findById(req.session.shipperId).select("fullName phone vehiclePlate location");

    // ── CHỐT CUỐC: chỉ DUY NHẤT 1 tài xế được nhận (atomic claim) ──
    const _claimRide = await Order.findOneAndUpdate(
      { _id: order._id, $or: [{ shipperId: null }, { shipperId: { $exists: false } }] },
      { $set: { shipperId: req.session.shipperId } },
      { new: true }
    );
    if (!_claimRide) {
      req.io.to(`shipper_${req.session.shipperId}`).emit("order_taken", { orderId: order.orderId, message: "Cuốc xe đã có người nhận" });
      return res.status(409).json({ success: false, taken: true, message: "Cuốc xe đã có người nhận" });
    }
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
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const order = await Order.findOne({ orderId: req.params.orderId, module: "ride", shipperId: req.session.shipperId });
    if (!order) return res.status(404).json({ success: false });

    order.status = "delivered";
    order.deliveredAt = new Date();
    order.paymentStatus = "paid";
    order.statusHistory.push({ status: "delivered", by: "shipper" });
    // Tích điểm loyalty (1/10 giá trị đơn) — chỉ 1 lần
    order.loyaltyPointsGranted = true;
    await order.save();
    await earnLoyaltyPoints(order.customerId, orderPaidAmount(order));

    // Tính tiền shipper theo commission DB (mặc định ride=10%, shipper giữ 90%)
    const { shipperEarn } = await calcEarnings(order);

    if ((order.paymentMethod || "cash") === "wallet") {
      // Ví CRABOR: auto-credit ngay
      await autoCreditOrderEarnings(order, shipperEarn, 0, "wallet", `Cuốc xe ${order.orderId} — ví CRABOR`);
      req.io.to(`shipper_${order.shipperId}`).emit("sepay_payment_confirmed", {
        orderId: order.orderId, amount: order.finalTotal,
        message: `Khách đã thanh toán qua ví CRABOR — ${(shipperEarn||0).toLocaleString("vi-VN")}đ đã vào ví bạn`,
      });
    } else if ((order.paymentMethod || "cash") === "cash") {
      // Tiền mặt: ghi nợ công ty
      const finalTotal = order.finalTotal ?? Math.max(0, (order.total||0) + (order.serviceFee||0));
      const dueAt = new Date(Date.now() + 24 * 3600 * 1000);
      const existingSettlement = await CashSettlement.findOne({ orderId: order.orderId }).lean().catch(() => null);
      if (!existingSettlement) {
        await CashSettlement.create({
          orderId: order.orderId, orderModule: "ride",
          shipperId: order.shipperId, partnerId: null,
          total: finalTotal, amountPaid: 0,
          shipperEarn, partnerEarn: 0,
          status: "pending", dueAt,
          note: `Cuốc xe ${order.orderId} — tiền mặt`,
        });
        req.io.to(`shipper_${order.shipperId}`).emit("cash_settlement_created", {
          orderId: order.orderId, amount: finalTotal, dueAt,
          message: `Bạn phải chuyển ${finalTotal.toLocaleString("vi-VN")}đ về công ty trong 24h`,
        });
      }
      req.io.to("admin").emit("cash_settlement_pending", {
        orderId: order.orderId, shipperEarn, amount: finalTotal, dueAt,
      });
    } else {
      await addToWalletQueue(order.orderId, order.shipperId, "shipper", shipperEarn, order.paymentMethod, `Cuốc xe ${order.orderId}`);
    }

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
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    // Chỉ ghi nhận shipper này từ chối, không thay đổi order
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  SHIPPER — Online/Offline + Socket Room Registration
// ══════════════════════════════════════════════════════════════

// GET /api/shipper/order-history — Lịch sử đơn đã hoàn thành
app.get("/api/shipper/order-history", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [orders, total] = await Promise.all([
      Order.find({ 
        shipperId: req.session.shipperId, 
        status: { $in: ["delivered", "cancelled", "completed"] }
      })
      .sort({ deliveredAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("orderId module items address partnerAddress finalTotal total shipFee serviceFee discount voucherCode voucherDiscount voucherShipperBear status deliveredAt createdAt ratingShipper ratingComment customerName customerPhone customerLat customerLng partnerLat partnerLng fromAddress toAddress")
      .lean(),
      Order.countDocuments({ 
        shipperId: req.session.shipperId, 
        status: { $in: ["delivered", "cancelled", "completed"] }
      })
    ]);
    
    const formatted = orders.map(o => ({
      orderId: o.orderId,
      module: o.module || 'food',
      status: o.status,
      total: o.total || 0,
      finalTotal: o.finalTotal ?? Math.max(0, (o.total||0) + (o.shipFee||0) + (o.serviceFee||0) - (o.discount||0)),
      discount: o.discount || 0,
      voucherCode: o.voucherCode || null,
      shipFee: o.shipFee || 0,
      serviceFee: o.serviceFee || 0,
      shipperEarn: shipperOrderEarnNet(o),
      address: o.address,
      partnerAddress: o.partnerAddress,
      customerName: o.customerName || o.receiverName || 'Khách hàng',
      customerPhone: o.customerPhone || '',
      items: (o.items || []).map(i => ({ name: i.name, qty: i.qty || i.quantity || 1, price: i.price || 0 })),
      ratingShipper: o.ratingShipper || null,
      ratingComment: o.ratingComment || null,
      date: o.deliveredAt || o.createdAt,
    }));
    
    res.json({ 
      success: true, 
      orders: formatted, 
      total, 
      page: parseInt(page),
      hasMore: skip + formatted.length < total
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/shipper/ratings — Đánh giá của khách hàng cho shipper
app.get("/api/shipper/ratings", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const shipper = await Shipper.findById(req.session.shipperId).select('rating ratingCount');
    
    const [ratedOrders, total] = await Promise.all([
      Order.find({ 
        shipperId: req.session.shipperId, 
        ratingShipper: { $exists: true, $ne: null }
      })
      .sort({ ratedAt: -1, deliveredAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("orderId ratingShipper ratingComment ratedAt deliveredAt module items address")
      .lean(),
      Order.countDocuments({ 
        shipperId: req.session.shipperId, 
        ratingShipper: { $exists: true, $ne: null }
      })
    ]);
    
    const reviews = ratedOrders.map(o => ({
      orderId: o.orderId,
      rating: o.ratingShipper,
      comment: o.ratingComment || '',
      date: o.ratedAt || o.deliveredAt,
      module: o.module || 'food',
      orderInfo: (o.items || []).map(i => `${i.qty}× ${i.name}`).join(', ') || o.address || '',
    }));
    
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviews.forEach(r => { if (r.rating >= 1 && r.rating <= 5) distribution[r.rating]++; });
    
    res.json({ 
      success: true, 
      averageRating: shipper?.rating || 5,
      totalRatings: shipper?.ratingCount || 0,
      reviews,
      distribution,
      total,
      page: parseInt(page),
      hasMore: skip + reviews.length < total
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/shipper/:id/public-ratings — Đánh giá công khai (customer app xem shipper)
app.get("/api/shipper/:id/public-ratings", async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "ID không hợp lệ" });
    const shipper = await Shipper.findById(id).select("rating ratingCount fullName avatar vehiclePlate totalOrders");
    if (!shipper) return res.status(404).json({ success: false, message: "Không tìm thấy shipper" });

    const rated = await Order.find({ shipperId: id, ratingShipper: { $exists: true, $ne: null } })
      .sort({ ratedAt: -1 })
      .limit(100)
      .select("orderId ratingShipper ratingComment ratedAt deliveredAt module items address customerName")
      .lean();

    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    rated.forEach(r => { const v = Math.round(r.ratingShipper); if (v >= 1 && v <= 5) distribution[v]++; });

    const reviews = rated.map(r => ({
      orderId: r.orderId,
      rating: r.ratingShipper,
      comment: r.ratingComment || '',
      date: r.ratedAt || r.deliveredAt,
      module: r.module || 'food',
      customerName: r.customerName || 'Khách hàng',
      orderInfo: (r.items || []).map(i => `${i.qty || i.quantity || 1}× ${i.name || ''}`).join(', ') || r.address || '',
    }));

    const ratedCount = distribution[1] + distribution[2] + distribution[3] + distribution[4] + distribution[5];

    res.json({
      success: true,
      shipper: {
        _id: shipper._id,
        fullName: shipper.fullName,
        avatar: shipper.avatar,
        vehiclePlate: shipper.vehiclePlate,
        totalOrders: shipper.totalOrders || 0,
      },
      averageRating: shipper?.rating || 5,
      ratingCount: shipper?.ratingCount || ratedCount || 0,
      reviews,
      distribution,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/preferences — Cập nhật loại đơn nhận
app.post("/api/shipper/preferences", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập shipper' });
    const { acceptFood, acceptLaundry, acceptRide, acceptCleaning } = req.body;

    const me = await Shipper.findById(req.session.shipperId).select('workType').lean();
    const isCleaning = me?.workType === 'cleaning';

    const shipper = await Shipper.findByIdAndUpdate(
      req.session.shipperId,
      { $set: isCleaning ? {
        // Tài khoản Dọn nhà: khoá cứng chỉ nhận dọn nhà
        'preferences.acceptFood': false,
        'preferences.acceptLaundry': false,
        'preferences.acceptRide': false,
        'preferences.acceptCleaning': true,
      } : {
        'preferences.acceptFood': acceptFood !== false,
        'preferences.acceptLaundry': acceptLaundry !== false,
        'preferences.acceptRide': acceptRide !== false,
        'preferences.acceptCleaning': acceptCleaning === true,
      }},
      { new: true }
    ).select('preferences workType');

    const prefs = shipper?.preferences || {};
    res.json({
      success: true,
      workType: shipper?.workType || 'shipper',
      preferences: {
        acceptFood: prefs.acceptFood !== false,
        acceptLaundry: prefs.acceptLaundry !== false,
        acceptRide: prefs.acceptRide !== false,
        acceptCleaning: prefs.acceptCleaning === true,
        cleaningRegistered: !!prefs.cleaningRegistered,
      }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/shipper/preferences — Lấy loại đơn nhận
app.get("/api/shipper/preferences", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập shipper' });
    const shipper = await Shipper.findById(req.session.shipperId).select('preferences workType');
    const prefs = shipper?.preferences || {};
    const isCleaning = shipper?.workType === 'cleaning';
    res.json({
      success: true,
      workType: shipper?.workType || 'shipper',
      preferences: {
        acceptFood:  isCleaning ? false : prefs.acceptFood !== false,
        acceptLaundry: isCleaning ? false : prefs.acceptLaundry !== false,
        acceptRide:  isCleaning ? false : prefs.acceptRide !== false,
        acceptCleaning: isCleaning ? true : prefs.acceptCleaning === true,
        cleaningRegistered: isCleaning || !!prefs.cleaningRegistered,
      }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/online — Shipper bật nhận đơn
app.post("/api/shipper/online", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    console.log('[Online] Session shipperId:', req.session?.shipperId);
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    const { lat, lng } = req.body;
    // Chặn bật online nếu chưa hoàn tất xác minh danh tính hoặc chưa đóng phí đăng ký
    const _gating = await Shipper.findById(req.session.shipperId).select("documents feeStatus identityVerified").lean().catch(() => null);
    if (_gating) {
      const _doc = _gating.documents || {};
      const _verified = !!_gating.identityVerified || (!!_doc.cccdFront && !!_doc.cccdBack && !!_doc.selfie);
      if (!_verified) {
        return res.status(403).json({ success: false, needVerification: true, message: "Bạn cần hoàn tất xác minh danh tính (CCCD 2 mặt + ảnh gương mặt) tại mục 'Xác minh thông tin' trước khi bật nhận đơn." });
      }
      if (_gating.feeStatus !== "paid") {
        return res.status(403).json({ success: false, needFee: true, message: "Bạn chưa hoàn tất nghĩa vụ thanh toán phí đăng ký shipper. Vui lòng thanh toán tại màn 'Thu nhập' để nhận đơn." });
      }
    }
    const updateData = { online: true, isAccepting: true, lastSeen: new Date() };
    if (lat && lng) {
      updateData.location = { lat, lng };
      updateData.lastLocationAt = new Date();
    }
    // Nếu chưa có mốc online → gán onlineAt để tích lũy thời gian online
    const prev = await Shipper.findById(req.session.shipperId).select('onlineAt onlineDay onlineMonth onlineSecondsToday onlineSecondsMonth onlineSecondsTotal').lean().catch(() => null);
    if (!prev || !prev.onlineAt) updateData.onlineAt = new Date();
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
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) {
      return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    }
    await flushOnlineTime(req.session.shipperId);
    await Shipper.findByIdAndUpdate(req.session.shipperId, { online: false, isAccepting: false, onlineAt: null });
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
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: "Chưa đăng nhập shipper" });
    const { lat, lng, heading, speed, orderId } = req.body;
    if (!lat || !lng) return res.status(400).json({ success: false, message: "Thiếu tọa độ" });

    await flushOnlineTime(req.session.shipperId);
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

// GET /api/shipper/active-orders — Đơn đang active của shipper (food + laundry + cleaning)
app.get("/api/shipper/active-orders", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    const shipperId = req.session.shipperId;
    const CleaningOrderM = mongoose.models.CleaningOrder;
    const [foodOrders, laundryOrders, cleaningOrders] = await Promise.all([
      Order.find({
        shipperId,
        status: { $in: ["shipper_accepted", "picking_up", "picked_up", "delivering"] }
      }).sort({ createdAt: -1 }).lean(),
      LaundryOrder.find({
        shipperId,
        status: { $in: ["shipper_picking", "picked_up_by_shipper", "at_partner", "washing", "countdown", "ready_return", "shipper_returning"] }
      }).sort({ createdAt: -1 }).lean(),
      // Đơn dọn nhà: từ lúc nhận đến khi hoàn thành — để hiển thị các bước tiếp theo
      CleaningOrderM
        ? CleaningOrderM.find({
            shipperId,
            status: { $in: ["accepted", "calling", "arrived", "in_progress", "working", "cleaned", "awaiting_payment"] }
          }).sort({ createdAt: -1 }).lean()
        : Promise.resolve([]),
    ]);

    // Lấy toạ độ cửa hàng giặt (partner) để shipper vẽ lộ trình theo workflow giặt
    const laundryPartnerIds = [...new Set(laundryOrders.map(o => String(o.partnerId)).filter(Boolean))];
    const laundryPartners = laundryPartnerIds.length
      ? await GiatLa.find({ _id: { $in: laundryPartnerIds } }).select("lastLat lastLng businessLat businessLng baseLat baseLng").lean().catch(() => [])
      : [];
    const laundryPartnerMap = new Map(laundryPartners.map(p => [String(p._id), p]));
    const mappedLaundry = laundryOrders.map(o => {
      const p = laundryPartnerMap.get(String(o.partnerId));
      const partnerLat = p?.lastLat ?? p?.businessLat ?? p?.baseLat ?? null;
      const partnerLng = p?.lastLng ?? p?.businessLng ?? p?.baseLng ?? null;
      return {
        ...o,
        module: "laundry",
        orderId: o.orderId,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        partnerName: o.partnerName,
        address: o.pickupAddress,
        addressLat: o.pickupLat, addressLng: o.pickupLng,
        deliveryAddress: o.pickupAddress,
        deliveryLat: o.pickupLat, deliveryLng: o.pickupLng,
        pickupLat: o.pickupLat, pickupLng: o.pickupLng,
        partnerAddress: o.partnerName,
        partnerLat, partnerLng,
        finalTotal: o.finalTotal || o.estimatedTotal || 0,
        total: o.finalTotal || o.estimatedTotal || 0,
        shipFee: o.shipFee,
        packageName: o.packageName,
        items: [{ name: `${o.packageName}`, qty: 1, price: o.finalTotal || o.estimatedTotal || 0 }],
        deadline: o.deadline,
      };
    });

    // Enrich food orders với toạ độ quán (pickup) để vẽ lộ trình quán → người nhận + discount/finalTotal
    const foodPartnerIds = [...new Set(foodOrders.map(o => String(o.partnerId)).filter(Boolean))];
    const foodPartners = foodPartnerIds.length
      ? await FoodPartner.find({ _id: { $in: foodPartnerIds } }).select("lastLat lastLng location").lean().catch(() => [])
      : [];
    const foodPartnerMap = new Map(foodPartners.map(p => [String(p._id), p]));
    const enrichedFood = foodOrders.map(o => {
      const p = foodPartnerMap.get(String(o.partnerId));
      const pickupLat = p?.lastLat ?? p?.location?.lat ?? o.partnerLat ?? o.pickupLat ?? o.addressLat ?? null;
      const pickupLng = p?.lastLng ?? p?.location?.lng ?? o.partnerLng ?? o.pickupLng ?? o.addressLng ?? null;
      return {
        ...o,
        pickupLat, pickupLng,
        partnerLat: pickupLat, partnerLng: pickupLng,
        discount: o.discount || 0,
        voucherCode: o.voucherCode || null,
        voucherDiscount: o.voucherDiscount || 0,
        finalTotal: o.finalTotal ?? Math.max(0, (o.total||0) + (o.shipFee||0) + (o.serviceFee||0) - (o.discount||0)),
      };
    });
    // Map cleaning orders — workflow dọn nhà: pickup = nhà khách, KHÔNG có phí ship
    const mappedCleaning = cleaningOrders.map(o => ({
      ...o,
      module: "cleaning",
      orderId: o.orderId,
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      partnerName: o.serviceName || 'Dọn nhà',
      address: o.address,
      addressLat: o.addressLat, addressLng: o.addressLng,
      deliveryAddress: o.address,
      deliveryLat: o.addressLat, deliveryLng: o.addressLng,
      pickupAddress: o.address,
      pickupLat: o.addressLat, pickupLng: o.addressLng,
      finalTotal: o.finalTotal ?? o.price ?? 0,
      total: o.finalTotal ?? o.price ?? 0,
      shipFee: 0,
      serviceFee: 0,
      discount: o.discount || 0,
      voucherCode: o.voucherCode || null,
      voucherDiscount: o.voucherDiscount || 0,
      paymentMethod: o.paymentMethod || 'cash',
      items: [{ name: o.serviceName || 'Dọn nhà', qty: 1, price: o.finalTotal ?? o.price ?? 0 }],
      duration: o.duration,
      bookingDate: o.bookingDate,
      bookingTime: o.bookingTime,
    }));

    res.json({ success: true, orders: [...mappedLaundry, ...enrichedFood, ...mappedCleaning] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════════════════════════
//  WALLET PENDING QUEUE — Admin duyệt
// ══════════════════════════════════════════════════════════════

// GET /api/admin/wallet-queue — Xem danh sách pending với filter
app.get("/api/admin/wallet-queue", async (req, res) => {
  try {
    const _adminKey = req.headers["x-admin-key"];
    const _validKey = process.env.ADMIN_SECRET_KEY || "crabor-admin-secret-2025";
    const _isAdmin = (_adminKey === _validKey) || !!req.session?.adminId;
    if (!_isAdmin) return res.status(401).json({ success: false, message: "Unauthorized" });
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
    const _adminKey = req.headers["x-admin-key"];
    const _validKey = process.env.ADMIN_SECRET_KEY || "crabor-admin-secret-2025";
    const _isAdmin = (_adminKey === _validKey) || !!req.session?.adminId;
    if (!_isAdmin) return res.status(401).json({ success: false, message: "Unauthorized" });

    const item = await WalletQueue.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false });
    if (item.status !== "pending") return res.status(400).json({ success: false, message: "Đã xử lý rồi" });

    // Cộng tiền vào ví khả dụng
    if (item.recipientType === "shipper") {
      const upd = await Shipper.findByIdAndUpdate(item.recipientId, {
        $inc: { walletBalance: item.amount, totalEarnings: item.amount }
      }, { new: true });
      if (upd) await WalletTx.create({ ownerId: item.recipientId, ownerType: "shipper", type: "credit", amount: item.amount, balance: upd.walletBalance, ref: item.orderId, note: item.note || "Thu nhập đơn hàng" }).catch(()=>{});
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
        }, { new: true });
        if (upd) {
          await WalletTx.create({ ownerId: item.recipientId, ownerType: "partner", type: "credit", amount: item.amount, balance: upd.walletBalance, ref: item.orderId, note: item.note || "Thu nhập đơn hàng" }).catch(()=>{});
          break;
        }
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
    const _adminKey = req.headers["x-admin-key"];
    const _validKey = process.env.ADMIN_SECRET_KEY || "crabor-admin-secret-2025";
    const _isAdmin = (_adminKey === _validKey) || !!req.session?.adminId;
    if (!_isAdmin) return res.status(401).json({ success: false, message: "Unauthorized" });
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
    const _adminKey = req.headers["x-admin-key"];
    const _validKey = process.env.ADMIN_SECRET_KEY || "crabor-admin-secret-2025";
    const _isAdmin = (_adminKey === _validKey) || !!req.session?.adminId;
    if (!_isAdmin) return res.status(401).json({ success: false, message: "Unauthorized" });
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
        mongoose.models.GiatLaPartner?.aggregate([{ $group: { _id: null, total: { $sum: "$walletBalance" } } }]) || [],
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
    const _adminKey = req.headers["x-admin-key"];
    const _validKey = process.env.ADMIN_SECRET_KEY || "crabor-admin-secret-2025";
    const _isAdmin = (_adminKey === _validKey) || !!req.session?.adminId;
    if (!_isAdmin) return res.status(401).json({ success: false, message: "Unauthorized" });
    const items = await WalletQueue.find({ status: "pending" });
    let approved = 0, totalAmount = 0;
    for (const item of items) {
      if (item.recipientType === "shipper") {
        const upd = await Shipper.findByIdAndUpdate(item.recipientId, { $inc: { walletBalance: item.amount, totalEarnings: item.amount } }, { new: true });
        if (upd) await WalletTx.create({ ownerId: item.recipientId, ownerType: "shipper", type: "credit", amount: item.amount, balance: upd.walletBalance, ref: item.orderId, note: item.note || "Thu nhập đơn hàng" }).catch(()=>{});
      } else {
        const pModels = [mongoose.models.FoodPartner, mongoose.models.GiatLa, mongoose.models.GiupViec, mongoose.models.ChinaShop].filter(Boolean);
        for (const m of pModels) {
          const upd = await m.findByIdAndUpdate(item.recipientId, { $inc: { walletBalance: item.amount, totalSales: item.amount } }, { new: true });
          if (upd) {
            await WalletTx.create({ ownerId: item.recipientId, ownerType: "partner", type: "credit", amount: item.amount, balance: upd.walletBalance, ref: item.orderId, note: item.note || "Thu nhập đơn hàng" }).catch(()=>{});
            break;
          }
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
//  CASH SETTLEMENT — Shipper chuyển tiền mặt về công ty
// ══════════════════════════════════════════════════════════════

// ── Helper: release earnings của settlement khi đã chuyển đủ ──
async function releaseSettlementEarnings(settlement) {
  if (!settlement || settlement.earningsReleased) return;
  const updates = [];
  if (settlement.shipperId && settlement.shipperEarn > 0) {
    await creditWalletDirect(settlement.shipperId, "shipper", settlement.shipperEarn,
      settlement.orderId, `Hoàn tất đối soát tiền mặt đơn ${settlement.orderId}`);
    const already = await WalletQueue.findOne({
      orderId: settlement.orderId, recipientId: settlement.shipperId, recipientType: "shipper",
      amount: settlement.shipperEarn, status: "approved",
    }).lean().catch(() => null);
    if (!already) await WalletQueue.create({
      orderId: settlement.orderId, recipientId: settlement.shipperId,
      recipientType: "shipper", amount: settlement.shipperEarn,
      paymentMethod: "cash",
      note: `Đơn ${settlement.orderId} — tiền mặt (đối soát xong)`,
      status: "approved", approvedBy: "cash_settlement", approvedAt: new Date(),
    }).catch(()=>{});
    updates.push(`shipper_${settlement.shipperId}`);
  }
  if (settlement.partnerId && settlement.partnerEarn > 0) {
    await creditWalletDirect(settlement.partnerId, "partner", settlement.partnerEarn,
      settlement.orderId, `Hoàn tất đối soát tiền mặt đơn ${settlement.orderId}`);
    const already = await WalletQueue.findOne({
      orderId: settlement.orderId, recipientId: settlement.partnerId, recipientType: "partner",
      amount: settlement.partnerEarn, status: "approved",
    }).lean().catch(() => null);
    if (!already) await WalletQueue.create({
      orderId: settlement.orderId, recipientId: settlement.partnerId,
      recipientType: "partner", amount: settlement.partnerEarn,
      paymentMethod: "cash",
      note: `Đơn ${settlement.orderId} — tiền mặt (đối soát xong)`,
      status: "approved", approvedBy: "cash_settlement", approvedAt: new Date(),
    }).catch(()=>{});
    if (settlement.partnerId) updates.push(`partner_${settlement.partnerId}`);
  }
  settlement.earningsReleased = true;
  settlement.releasedAt = new Date();
  settlement.status = "settled";
  await settlement.save();
  for (const room of updates) {
    global._io?.to(room).emit("wallet_credited", {
      amount: (settlement.shipperEarn||0) + (settlement.partnerEarn||0),
      orderId: settlement.orderId,
      message: `Đối soát tiền mặt xong — thu nhập đã vào ví!`,
    });
  }
  if (settlement.shipperId && settlement.shipperEarn > 0) {
    await notifyUser('shipper', settlement.shipperId, {
      type: 'income', title: '💰 Đối soát tiền mặt xong!',
      body: `Đơn ${settlement.orderId} — ${settlement.shipperEarn.toLocaleString('vi-VN')}đ đã vào ví`,
      ref: settlement.orderId, refModule: settlement.orderModule || 'food',
    });
  }
  if (settlement.partnerId && settlement.partnerEarn > 0) {
    await notifyUser('partner', settlement.partnerId, {
      type: 'income', title: '💰 Bạn đã nhận được tiền sau đơn hàng!',
      body: `Đơn ${settlement.orderId} — ${settlement.partnerEarn.toLocaleString('vi-VN')}đ đã vào ví Crabor. Bấm để xem chi tiết`,
      ref: settlement.orderId, refModule: settlement.orderModule || 'food',
    });
  }
  return settlement;
}

// ── Helper: áp tiền chuyển về vào các settlement (FIFO) ──
async function applyCashPayment(shipperId, amount, method, note, paymentId = null) {
  if (amount <= 0) return { applied: 0 };
  let remaining = amount;
  const settlements = await CashSettlement.find({
    shipperId, status: { $in: ["pending", "partially_paid"] },
  }).sort({ createdAt: 1 });
  let released = [];
  for (const s of settlements) {
    if (remaining <= 0) break;
    const debt = s.total - (s.amountPaid || 0);
    const pay = Math.min(debt, remaining);
    s.amountPaid = (s.amountPaid || 0) + pay;
    s.lastPaidAt = new Date();
    remaining -= pay;
    if (s.amountPaid >= s.total) {
      await releaseSettlementEarnings(s);
      released.push(s.orderId);
    } else {
      s.status = "partially_paid";
      await s.save();
    }
  }
  if (paymentId) {
    await CashSettlementPayment.findByIdAndUpdate(paymentId, {
      status: "confirmed", confirmedAt: new Date(),
    }).catch(()=>{});
  }
  return { applied: amount - remaining, remaining, released };
}

// GET /api/shipper/cash-settlement — Tổng quan + lịch sử
app.get("/api/shipper/cash-settlement", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    const shipperId = req.session.shipperId;
    const now = new Date();

    const [pending, history, payments, unpaidCount] = await Promise.all([
      CashSettlement.find({
        shipperId, status: { $in: ["pending", "partially_paid"] },
      }).sort({ createdAt: 1 }),
      CashSettlement.find({ shipperId, status: { $in: ["settled"] } })
        .sort({ updatedAt: -1 }).limit(50),
      CashSettlementPayment.find({ shipperId }).sort({ createdAt: -1 }).limit(50),
      CashSettlement.countDocuments({ shipperId, status: { $in: ["pending", "partially_paid"] } }),
    ]);

    const totalDebt = pending.reduce((s, it) => s + (it.total - (it.amountPaid || 0)), 0);
    const paidTotal = pending.reduce((s, it) => s + (it.amountPaid || 0), 0);
    const grandTotal = pending.reduce((s, it) => s + it.total, 0);
    const pct = grandTotal > 0 ? Math.round(((grandTotal - totalDebt) / grandTotal) * 100) : 100;
    const overdue = pending.filter(it => it.dueAt && new Date(it.dueAt) < now).length;

    res.json({
      success: true,
      totalDebt,
      paidTotal,
      grandTotal,
      percentComplete: pct,
      overdueCount: overdue,
      blocked: overdue > 0,
      unpaidCount,
      pending: pending.map(p => ({
        orderId: p.orderId, module: p.orderModule,
        total: p.total, amountPaid: p.amountPaid, dueAt: p.dueAt,
        shipperEarn: p.shipperEarn, partnerEarn: p.partnerEarn,
        status: p.status, note: p.note, createdAt: p.createdAt,
      })),
      history,
      payments: payments.map(p => ({
        paymentId: p.paymentId, amount: p.amount, method: p.method,
        status: p.status, note: p.note, createdAt: p.createdAt, confirmedAt: p.confirmedAt,
      })),
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/cash-settlement/payos/create — Tạo link PayOS chuyển về công ty
app.post("/api/shipper/cash-settlement/payos/create", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    const shipperId = req.session.shipperId;
    const { amount } = req.body;
    const pending = await CashSettlement.find({ shipperId, status: { $in: ["pending", "partially_paid"] } });
    const debt = pending.reduce((s, it) => s + (it.total - (it.amountPaid || 0)), 0);
    const payAmount = Math.min(Math.round(Number(amount) || debt), debt);
    if (payAmount <= 0) return res.status(400).json({ success: false, message: "Không có khoản nào cần thanh toán" });

    const orderCode = parseInt(Date.now().toString().slice(-9));
    const description = "CRABOR CASH SETTLE";
    if (!payOS) return res.status(500).json({ success: false, message: "PayOS chưa cấu hình" });
    const paymentData = {
      orderCode, amount: payAmount, description,
      items: [{ name: "Chuyển tiền mặt về công ty", quantity: 1, price: payAmount }],
      returnUrl: `${process.env.BASE_URL || "https://crabor-shipper-register.onrender.com"}/payment/success?type=cash_settlement`,
      cancelUrl: `${process.env.BASE_URL || "https://crabor-shipper-register.onrender.com"}/payment/cancel`,
    };
    let link;
    if (typeof payOS.paymentRequests?.create === 'function') link = await payOS.paymentRequests.create(paymentData);
    else if (typeof payOS.createPaymentLink === 'function') link = await payOS.createPaymentLink(paymentData);
    const linkData = link?.data && typeof link.data === 'object' && !Array.isArray(link.data) ? link.data : link;

    const rec = await CashSettlementPayment.create({
      shipperId, amount: payAmount, method: "payos",
      payosOrderCode: String(linkData?.orderCode ?? orderCode),
      payosCheckoutUrl: linkData?.checkoutUrl,
      status: "pending", note: "Chuyển tiền mặt về công ty",
    });

    res.json({
      success: true, checkoutUrl: linkData?.checkoutUrl,
      orderCode: linkData?.orderCode ?? orderCode,
      paymentId: rec.paymentId || rec._id,
      amount: payAmount,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/cash-settlement/sepay/prepare — QR SePay chuyển về công ty
app.post("/api/shipper/cash-settlement/sepay/prepare", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    const shipperId = req.session.shipperId;
    const pending = await CashSettlement.find({ shipperId, status: { $in: ["pending", "partially_paid"] } });
    const debt = pending.reduce((s, it) => s + (it.total - (it.amountPaid || 0)), 0);
    const amount = Math.round(Number(req.body?.amount) || debt);
    if (amount <= 0) return res.status(400).json({ success: false, message: "Không có khoản nào cần thanh toán" });

    const sePayRef = "CRSET" + Date.now().toString(36).toUpperCase().slice(-6);
    const rec = await CashSettlementPayment.create({
      shipperId, amount, method: "sepay", sePayRef, status: "pending",
      note: "Chuyển tiền mặt về công ty",
    });
    const qrUrl = sepayQrUrl(amount, sePayRef);
    res.json({
      success: true, qrUrl, sePayRef, amount,
      bankName: SEPAY_CONFIG.bankName, bankCode: SEPAY_CONFIG.bankCode,
      accountNo: SEPAY_CONFIG.accountNo, accountName: SEPAY_CONFIG.accountName,
      paymentId: rec.paymentId || rec._id,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/cash-settlement/wallet/pay — Trả bằng ví CRABOR shipper
app.post("/api/shipper/cash-settlement/wallet/pay", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    const shipperId = req.session.shipperId;
    const { amount } = req.body;
    const pending = await CashSettlement.find({ shipperId, status: { $in: ["pending", "partially_paid"] } });
    const debt = pending.reduce((s, it) => s + (it.total - (it.amountPaid || 0)), 0);
    const payAmount = Math.min(Math.round(Number(amount) || debt), debt);
    if (payAmount <= 0) return res.status(400).json({ success: false, message: "Không có khoản nào cần thanh toán" });

    const shipper = await Shipper.findById(shipperId).select("walletBalance");
    if (!shipper || (shipper.walletBalance || 0) < payAmount)
      return res.status(400).json({ success: false, message: `Ví không đủ tiền. Cần ${payAmount.toLocaleString("vi-VN")}đ` });

    const newBal = await walletDebit(shipperId, 'shipper', payAmount, 'debit', null, 'Chuyển tiền mặt về công ty');
    const rec = await CashSettlementPayment.create({
      shipperId, amount: payAmount, method: "wallet", status: "confirmed", confirmedAt: new Date(),
      note: "Chuyển tiền mặt về công ty bằng ví CRABOR",
    });
    const result = await applyCashPayment(shipperId, payAmount, "wallet", "Chuyển tiền mặt về công ty", rec._id);

    req.io.to("admin").emit("cash_settlement_paid", {
      shipperId, amount: payAmount, method: "wallet", releasedOrders: result.released,
    });

    res.json({
      success: true, message: `Đã chuyển ${payAmount.toLocaleString("vi-VN")}đ về công ty`,
      newBalance: newBal, applied: result.applied, remaining: result.remaining, released: result.released,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/shipper/cash-settlement/payos/confirm — Poll PayOS
app.post("/api/shipper/cash-settlement/payos/confirm", async (req, res) => {
  try {
    await loadSessionFromHeader(req, res);
    if (!req.session?.shipperId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
    const { orderCode } = req.body;
    if (!orderCode) return res.status(400).json({ success: false, message: "Thiếu orderCode" });
    const rec = await CashSettlementPayment.findOne({
      shipperId: req.session.shipperId, payosOrderCode: String(orderCode), status: "pending",
    });
    if (!rec) return res.json({ success: false, message: "Không tìm thấy lệnh thanh toán" });
    if (!payOS) return res.status(500).json({ success: false, message: "PayOS chưa cấu hình" });
    let info;
    try {
      info = payOS.paymentRequestDetails ? await payOS.paymentRequestDetails(Number(orderCode)) : await payOS.getPaymentLinkInformation(Number(orderCode));
    } catch(e) {
      try { info = await payOS.getPaymentLinkInformation(Number(orderCode)); } catch(_) { info = null; }
    }
    const statusPay = info?.data?.status || info?.status;
    if (statusPay === "PAID" || statusPay === "00") {
      const result = await applyCashPayment(rec.shipperId, rec.amount, "payos", rec.note, rec._id);
      req.io.to("admin").emit("cash_settlement_paid", {
        shipperId: rec.shipperId, amount: rec.amount, method: "payos", releasedOrders: result.released,
      });
      return res.json({ success: true, paid: true, applied: result.applied, released: result.released });
    }
    res.json({ success: true, paid: false, status: statusPay });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Cron: đánh dấu quá hạn + chặn shipper (mỗi 60 giây)
setInterval(async () => {
  try {
    const now = new Date();
    const overdueItems = await CashSettlement.updateMany(
      { status: { $in: ["pending", "partially_paid"] }, dueAt: { $lte: now }, $or: [{ status: { $ne: "overdue" } }, { status: "pending" }, { status: "partially_paid" }] },
      { $set: { status: "overdue" } }
    );
    if (overdueItems.modifiedCount > 0) console.log(`[CRON] ${overdueItems.modifiedCount} cash settlements quá hạn`);
  } catch (e) { console.error("[CRON cash-overdue]", e.message); }
}, 60 * 1000);

// Helper: shipper có bị chặn nhận đơn vì nợ cash quá hạn không
async function isShipperCashBlocked(shipperId) {
  if (!shipperId) return false;
  try {
    const now = new Date();
    const overdue = await CashSettlement.findOne({
      shipperId, status: { $in: ["pending", "partially_paid", "overdue"] },
      dueAt: { $lte: now },
    }).lean();
    return !!overdue;
  } catch (_) { return false; }
}

// Helper: danh sách shipper bị chặn (theo Set) — dùng trong dispatch
async function getCashBlockedShipperIds(shipperIds) {
  const set = new Set();
  if (!shipperIds || !shipperIds.length) return set;
  try {
    const now = new Date();
    const overdue = await CashSettlement.find({
      shipperId: { $in: shipperIds },
      status: { $in: ["pending", "partially_paid", "overdue"] },
      dueAt: { $lte: now },
    }).distinct("shipperId");
    for (const id of overdue) set.add(String(id));
  } catch (_) {}
  return set;
}

// ══════════════════════════════════════════════════════════════
//  SOCKET — Register shipper/partner vào room khi login
// ══════════════════════════════════════════════════════════════
// NOTE: Handlers đã được đăng ký trong io.on("connection") ở trên
// KHÔNG xóa listeners ở đây để tránh mất join_shipper, join_partner, v.v.


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

// PATCH /api/admin/customers/:id/trustscore — Điều chỉnh điểm tin cậy (0-100)
app.patch("/api/admin/customers/:id/trustscore", adminAuth, async (req, res) => {
  try {
    const raw = Number(req.body.score);
    if (raw === null || raw === undefined || isNaN(raw))
      return res.status(400).json({ success: false, message: "Thiếu giá trị điểm tin cậy" });
    const score = Math.max(0, Math.min(100, Math.round(raw)));
    const user = await User.findByIdAndUpdate(req.params.id, { trustScore: score }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy user" });
    res.json({ success: true, trustScore: user.trustScore, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/clear-balance — Xoá số dư ví về 0 (khách/shipper/đối tác)
app.post("/api/admin/clear-balance", adminAuth, async (req, res) => {
  try {
    const { type, id, module } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: "Thiếu id" });
    let Model = null, ownerType = null, label = "";
    if (type === "user")       { Model = User; ownerType = "user"; label = "khách hàng"; }
    else if (type === "shipper") { Model = Shipper; ownerType = "shipper"; label = "shipper"; }
    else if (type === "partner") { Model = module ? getPartnerModel(module) : FoodPartner; ownerType = "partner"; label = "đối tác"; }
    if (!Model) return res.status(400).json({ success: false, message: "Loại tài khoản không hợp lệ" });

    const doc = await Model.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy " + label });
    const oldBal = doc.walletBalance || 0;
    if (oldBal > 0) {
      doc.walletBalance = 0;
      await doc.save();
      await WalletTx.create({
        ownerId: doc._id, ownerType, type: "debit", amount: oldBal,
        balance: 0, ref: "ADMIN_CLEAR", note: "Admin xoá số dư ví",
      });
    }
    res.json({ success: true, cleared: oldBal, message: `Đã xoá ${oldBal.toLocaleString("vi-VN")}đ khỏi ví` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 3000;

// GET /api/admin/withdraws — Danh sách yêu cầu rút tiền về ngân hàng
app.get("/api/admin/withdraws", adminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status && status !== "all" ? { status } : {};
    const reqs = await WithdrawRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    // Gắn tên chủ ví
    const owners = {};
    const idsByType = { user: [], shipper: [], partner: [] };
    for (const r of reqs) (idsByType[r.ownerType] || idsByType.user).push(r.ownerId);
    const nameMap = {};
    const fill = async (Model, arr) => {
      if (!arr.length) return;
      const docs = await Model.find({ _id: { $in: arr } }).select("fullName phone walletBalance").lean();
      for (const d of docs) nameMap[String(d._id)] = { name: d.fullName, phone: d.phone, balance: d.walletBalance || 0 };
    };
    await fill(User, idsByType.user);
    await fill(Shipper, idsByType.shipper);
    await fill(FoodPartner, idsByType.partner);
    const data = reqs.map(r => ({
      ...r,
      ownerName: nameMap[String(r.ownerId)]?.name || nameMap[String(r.ownerId)]?.phone || "N/A",
      ownerPhone: nameMap[String(r.ownerId)]?.phone || "",
      ownerBalance: nameMap[String(r.ownerId)]?.balance ?? null,
    }));
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PATCH /api/admin/withdraws/:id — Duyệt / từ chối yêu cầu rút tiền
app.patch("/api/admin/withdraws/:id", adminAuth, async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    if (!["approved", "rejected"].includes(status))
      return res.status(400).json({ success: false, message: "Trạng thái không hợp lệ" });
    const wr = await WithdrawRequest.findById(req.params.id);
    if (!wr) return res.status(404).json({ success: false, message: "Không tìm thấy yêu cầu" });
    if (wr.status !== "pending")
      return res.status(400).json({ success: false, message: `Yêu cầu đã ${wr.status === "approved" ? "được duyệt" : "bị từ chối"} trước đó` });

    const Model = wr.ownerType === "user" ? User : wr.ownerType === "shipper" ? Shipper : FoodPartner;
    const ownerLabel = wr.ownerType === "user" ? "Khách hàng" : wr.ownerType === "shipper" ? "Shipper" : "Đối tác";

    if (status === "rejected") {
      // Tiền đã trừ khi tạo yêu cầu → hoàn lại ví khi từ chối
      await walletCredit(wr.ownerId, wr.ownerType, wr.amount, "WITHDRAW_REJECT", `Hoàn lại tiền rút bị từ chối`);
    }

    wr.status = status;
    wr.adminNote = adminNote || "";
    wr.processedAt = new Date();
    await wr.save();

    if (status === "approved") {
      const p = await Model.findById(wr.ownerId).catch(() => null);
      const room = wr.ownerType === "user" ? `customer_${wr.ownerId}` : `${wr.ownerType}_${wr.ownerId}`;
      req.io.to(room).emit("withdraw_status", {
        status: "approved", amount: wr.amount,
        message: `Yêu cầu rút ${wr.amount.toLocaleString("vi-VN")}đ đã được duyệt và chuyển đến ${wr.bankName}`,
      });
      await notifyUser(wr.ownerType, wr.ownerId, {
        type: 'withdraw', title: '💸 Rút tiền thành công!',
        body: `${wr.amount.toLocaleString("vi-VN")}đ đã được chuyển đến ${wr.bankName} ${wr.accountNo}`,
        ref: String(wr._id), refModule: 'withdraw',
      });
    } else if (status === "rejected") {
      const room = wr.ownerType === "user" ? `customer_${wr.ownerId}` : `${wr.ownerType}_${wr.ownerId}`;
      req.io.to(room).emit("withdraw_status", {
        status: "rejected", amount: wr.amount,
        message: `Yêu cầu rút ${wr.amount.toLocaleString("vi-VN")}đ bị từ chối. Tiền đã hoàn về ví. ${adminNote ? "Lý do: " + adminNote : ""}`,
      });
      await notifyUser(wr.ownerType, wr.ownerId, {
        type: 'withdraw', title: '❌ Yêu cầu rút tiền bị từ chối',
        body: `${wr.amount.toLocaleString("vi-VN")}đ đã hoàn về ví. ${adminNote ? "Lý do: " + adminNote : ""}`,
        ref: String(wr._id), refModule: 'withdraw',
      });
    }

    res.json({ success: true, data: wr });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

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
    const retryThreshold = new Date(Date.now() - 35000); // 35s

    // ── Food / Ride orders ──
    const pendingOrders = await Order.find({
      status: { $in: ["pending", "confirmed"] }, // confirmed = partner đã xác nhận
      shipperId: { $exists: false },             // chưa có shipper
      module: { $in: ["food", "ride"] },
      $or: [
        { dispatchedAt: { $exists: false } },    // chưa dispatch lần nào
        { dispatchedAt: { $lt: retryThreshold } } // dispatch lần trước đã > 35s, dispatch lại
      ]
    }).limit(10);

    // ── Laundry orders (partner đã xác nhận, chưa có shipper lấy đồ) ──
    let pendingLaundry = [];
    if (mongoose.models.LaundryOrder) {
      pendingLaundry = await mongoose.models.LaundryOrder.find({
        status: "partner_accepted",
        shipperId: { $exists: false },
        $or: [
          { dispatchedAt: { $exists: false } },
          { dispatchedAt: { $lt: retryThreshold } }
        ]
      }).limit(10).lean();
    }

    // ── Cleaning orders (pending, chưa có shipper nhận) ──
    let pendingCleaning = [];
    if (mongoose.models.CleaningOrder) {
      pendingCleaning = await mongoose.models.CleaningOrder.find({
        status: "pending",
        shipperId: null,
        $or: [
          { dispatchedAt: { $exists: false } },
          { dispatchedAt: { $lt: retryThreshold } }
        ]
      }).limit(10).lean();
    }

    if (pendingOrders.length === 0 && pendingLaundry.length === 0 && pendingCleaning.length === 0) return;

    // Log tổng số socket đang kết nối để debug
    const totalSockets = global._io?.sockets?.sockets?.size || 0;
    console.log(`[AutoDispatch] Found ${pendingOrders.length} orders + ${pendingLaundry.length} laundry + ${pendingCleaning.length} cleaning | Total connected sockets: ${totalSockets}`);

    for (const order of pendingOrders) {
      // dispatchedAt check handled in query (retry after 35s)
      
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
            deliveryLat: order.addressLat || null,
            deliveryLng: order.addressLng || null,
            note: order.note,
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            module: order.module,
            partnerName: order.partnerName || "Cửa hàng",
          },
          timeout: 30,
        };
        
        for (const shipper of nearbyShippers) {
          const room = `shipper_${shipper._id}`;
          const roomSockets = global._io?.sockets?.adapter?.rooms?.get(room);
          const socketCount = roomSockets ? roomSockets.size : 0;
          global._io?.to(room).emit("order_request", payload);
          await notifyUser('shipper', shipper._id, {
            type: 'new_order', title: order.module === 'laundry' ? '👕 Đơn giặt là' : '🚚 Đơn hàng mới!',
            body: `Đơn #${order.orderId?.slice(-6)}`,
            ref: String(order._id), refModule: order.module || 'food',
          });
          console.log(`[AutoDispatch] Emit order_request → room=[${room}] sockets=${socketCount} order=${order.orderId} dist=${shipper.distKm ?? 0}km`);
        }
        
        await Order.findByIdAndUpdate(order._id, {
          $set: { dispatchedTo: nearbyShippers.map(s => s._id), dispatchedAt: new Date() }
        });
      } else {
        console.log(`[AutoDispatch] No nearby shipper for order ${order.orderId}`);
      }
    }

    // ── Laundry: re-dispatch pickup request ──
    for (const order of pendingLaundry) {
      const dispatchLat = order.pickupLat || 21.0285;
      const dispatchLng = order.pickupLng || 105.8542;
      let partnerLat = null, partnerLng = null;
      if (order.partnerId) {
        const g = await GiatLa.findById(order.partnerId).select("lastLat lastLng").catch(() => null);
        if (g?.lastLat) { partnerLat = g.lastLat; partnerLng = g.lastLng; }
      }
      const nearby = await findLaundryShippers(dispatchLat, dispatchLng, 5);
      if (nearby.length > 0) {
        const payload = {
          type: "laundry_pickup_request",
          orderId: order.orderId,
          pickupAddress: order.pickupAddress,
          pickupLat: dispatchLat, pickupLng: dispatchLng,
          partnerAddress: `${order.partnerName}`,
          partnerLat, partnerLng,
          customerName: order.customerName,
          customerPhone: order.customerPhone || "",
          packageName: order.packageName,
          estimatedTotal: order.estimatedTotal || 0,
          finalTotal: order.finalTotal || order.estimatedTotal || 0,
          discount: order.discount || 0,
          voucherCode: order.voucherCode || null,
          shipFee: order.shipFee,
          module: "laundry",
          timeout: 30,
        };
        for (const s of nearby) {
          const room = `shipper_${s._id}`;
          const roomSockets = global._io?.sockets?.adapter?.rooms?.get(room);
          const socketCount = roomSockets ? roomSockets.size : 0;
          global._io?.to(room).emit("order_request", payload);
          await notifyUser('shipper', s._id, {
            type: 'new_order', title: '👕 Đơn giặt là mới!',
            body: `Đơn #${order.orderId?.slice(-6)}`,
            ref: String(order._id), refModule: 'laundry',
          });
          console.log(`[AutoDispatch] Laundry emit order_request → room=[${room}] sockets=${socketCount} order=${order.orderId} dist=${s.distKm ?? 0}km`);
        }
        await mongoose.models.LaundryOrder.findByIdAndUpdate(order._id, {
          $set: { dispatchedTo: nearby.map(s => s._id), dispatchedAt: new Date() }
        });
      } else {
        console.log(`[AutoDispatch] No nearby shipper for laundry order ${order.orderId}`);
      }
    }

    // ── Cleaning: re-dispatch đơn dọn nhà (ping liên tục như food) ──
    for (const order of pendingCleaning) {
      const dispatchLat = order.addressLat || 21.0285;
      const dispatchLng = order.addressLng || 105.8542;
      let nearby = await findCleaningShippers(dispatchLat, dispatchLng, 5, 5);
      if (!nearby.length) nearby = await findNearbyShippers(dispatchLat, dispatchLng, 25, 10);
      if (nearby.length === 0) {
        console.log(`[AutoDispatch] No shipper online for cleaning order ${order.orderId}`);
        continue;
      }
      const payload = {
        type: "cleaning_request",
        orderId: order.orderId,
        order: {
          _id: order._id, orderId: order.orderId, serviceName: order.serviceName,
          module: 'cleaning',
          price: order.price, discount: order.discount || 0,
          finalTotal: order.finalTotal ?? Math.max(0, (order.price || 0) - (order.discount || 0)),
          duration: order.duration, address: order.address,
          addressLat: order.addressLat, addressLng: order.addressLng,
          bookingDate: order.bookingDate, bookingTime: order.bookingTime,
          note: order.note, customerName: order.customerName,
          customerPhone: order.customerPhone || "",
        },
        timeout: 30,
      };
      for (const s of nearby) {
        const room = `shipper_${s._id}`;
        global._io?.to(room).emit("order_request", payload);
        await notifyUser('shipper', s._id, {
          type: 'new_order', title: '🧹 Đơn dọn nhà mới!',
          body: `Đơn #${order.orderId?.slice(-6)}`,
          ref: String(order._id), refModule: 'cleaning',
        });
      }
      await mongoose.models.CleaningOrder.findByIdAndUpdate(order._id, {
        $set: { dispatchedAt: new Date() }
      });
      console.log(`[AutoDispatch] Cleaning emit → ${nearby.length} shipper · order=${order.orderId}`);
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
  module:        { type: String, default: "cleaning" },
  customerName:  String,
  customerPhone: String,
  address:       String,
  addressLat:    Number,
  addressLng:    Number,
  serviceType:   { type: String, enum: ["basic","medium","deep"], default: "basic" },
  serviceName:   String,
  price:         Number,
  discount:      { type: Number, default: 0, min: 0 },
  voucherCode:   { type: String, trim: true, uppercase: true },
  voucherDiscount:{ type: Number, default: 0, min: 0 },
  finalTotal:    { type: Number, min: 0 },
  duration:      String,
  note:          String,
  bookingDate:   Date,
  bookingTime:   String,
  paymentMethod: { type: String, default: "cash" },
  paymentStatus: { type: String, default: "unpaid" },
  paidAt:        Date,
  // Phân bổ chi phí voucher (CRABOR trung gian — shipper gánh 100%, trừ khi ≥100 đơn/tháng)
  voucherShipperBear: { type: Number, default: 0, min: 0 },
  voucherPartnerBear: { type: Number, default: 0, min: 0 },
  voucherCraborBear:  { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    // Workflow dọn nhà: pending → accepted → calling (gọi khách dặn dò) → arrived
    // → in_progress (đang dọn) → cleaned (dọn xong) → awaiting_payment (thanh toán) → completed
    enum: ["pending","accepted","shipper_accepted","calling","arrived","in_progress","working","cleaned","awaiting_payment","picking_up","completed","cancelled"],
    default: "pending",
  },
  statusHistory: [{ status: String, by: String, time: Date }],
  completedAt:   Date,
  dispatchedAt:  Date,   // lần phát đơn gần nhất (cron AutoDispatch ping lại mỗi 35s)
  rating:        { type: Number, min: 1, max: 5 },
  ratingComment: String,
}, { timestamps: true });

cleaningOrderSchema.pre("save", function(next) {
  if (!this.orderId) this.orderId = "CLN-" + Date.now().toString(36).toUpperCase();
  this.finalTotal = Math.max(0, (this.price||0) - (this.discount||0));
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
    // FIX: tài khoản nhiều module — ưu tiên FoodPartner theo phone
    const foodPartner = await getSessionFoodPartner(req);
    if (foodPartner) {
      partner = foodPartner;
      module = "food_partner";
    } else {
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
      pruneSessionRoles(req, 'shipper');
    } else if (userType === 'customer') {
      req.session.userId = updatedUser._id;
      req.session.userPhone = updatedUser.phone;
      req.session.role = 'customer';
      pruneSessionRoles(req, 'user');
    } else if (userType === 'partner') {
      req.session.partnerId = updatedUser._id;
      req.session.userPhone = updatedUser.phone;
      req.session.role = 'partner';
      pruneSessionRoles(req, 'partner');
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
    await WithdrawRequest.create({
      ownerId: req.session.partnerId, ownerType: 'partner', amount: amt,
      bankName, accountNo, accountName, status: 'pending',
    });
     req.io.to('admin').emit('withdrawRequest', { ownerId: req.session.partnerId, ownerType: 'partner', amount: amt, bankName, accountNo, accountName });
     await notifyUser('partner', req.session.partnerId, {
       type: 'withdraw', title: '💸 Yêu cầu rút tiền đã ghi nhận',
       body: `${amt.toLocaleString('vi-VN')}đ → ${bankName} ${accountNo}. Xử lý trong 1–3 ngày.`,
       ref: '', refModule: 'withdraw',
     });
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


// POST /api/wallet/topup/prepare — Tạo lệnh nạp ví (qua SePay)
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
    const sePayRef = description;
    const qrUrl = sepayQrUrl(amt, sePayRef);

    res.json({
      success: true,
      orderCode,
      amount: amt,
      description,
      sePayRef,
      accountNo:   SEPAY_CONFIG.accountNo,
      accountName: SEPAY_CONFIG.accountName,
      bankName:    SEPAY_CONFIG.bankName,
      bankCode:    SEPAY_CONFIG.bankCode,
      qrUrl,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/wallet/topup/check — Kiểm tra trạng thái nạp ví (không cần orderCode)
app.post("/api/wallet/topup/check", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Chưa đăng nhập" });

    // Tìm giao dịch CRTOPUP mới nhất của user (không cần orderCode — SePay chỉ match nội dung CK)
    // Lưu ý: webhook lưu mã CRTOPUP vào field "ref", note là 'Nạp ví CRABOR'
    const tx = await WalletTx.findOne({
      ownerId: req.session.userId,
      type: 'credit',
      $or: [
        { ref: { $regex: 'CRTOPUP', $options: 'i' } },
        { note: { $regex: 'CRTOPUP', $options: 'i' } },
      ],
    }).sort({ createdAt: -1 });

    if (tx) {
      res.json({ success: true, status: 'paid', amount: tx.amount, tx });
    } else {
      res.json({ success: true, status: 'pending' });
    }
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── COCO AI PATCH — nâng cấp routes Coco/Nova với OpenRouter + Groq ──
try {
  require('./server-coco-patch')(app, io);
  console.log('[Server] ✅ Coco AI Patch loaded (OpenRouter + Groq)');
} catch(e) {
  console.error('[Server] ⚠️  Coco AI Patch failed:', e.message);
}

// ══════════════════════════════════════════════════════════════
//  HỌC HỘ (hocho) — mount toàn bộ API vào CRABOR tại /api/hocho/*
//  (ESM module, load bằng dynamic import; models HC* + collection hocho_*)
// ══════════════════════════════════════════════════════════════
(async () => {
  try {
    const [c, p, o, ch, ad, up, cb, cr, di] = await Promise.all([
      import('./hocho/routes/api/customer.js'),
      import('./hocho/routes/api/partner.js'),
      import('./hocho/routes/api/order.js'),
      import('./hocho/routes/api/chat.js'),
      import('./hocho/routes/api/admin.js'),
      import('./hocho/routes/api/upload.js'),
      import('./hocho/routes/api/chatbot.js'),
      import('./hocho/routes/api/cron.js'),
      import('./hocho/routes/api/discord.js'),
    ]);
    app.use('/api/hocho/customer', c.default);
    app.use('/api/hocho/partner',  p.default);
    app.use('/api/hocho/order',    o.default);
    app.use('/api/hocho/chat',     ch.default);
    app.use('/api/hocho/admin',    ad.default);
    app.use('/api/hocho/upload',   up.default);
    app.use('/api/hocho/chatbot',  cb.default);
    app.use('/api/hocho/cron',     cr.default);
    app.use('/api/hocho/discord',  di.default);
    console.log('[Hocho] ✅ API mounted tại /api/hocho/* (customer/partner/order/chat/admin/upload/chatbot)');
  } catch (e) {
    console.error('[Hocho] ❌ mount lỗi:', e.message);
  }
})();

module.exports = { app, server, io };
