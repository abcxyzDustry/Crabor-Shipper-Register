/**
 * NOVA — Operations Intelligence Agent
 * Agent thứ 2 của CRABOR, chuyên về vận hành nội bộ
 *
 * Phân công:
 *   COCO = Customer Intelligence (phía người dùng, support, chat)
 *   NOVA = Operations Intelligence (phía vận hành, business, system)
 *
 * Nova lo:
 *   1. Dispatch thông minh (ghép đơn real-time, workload balancing)
 *   2. SLA Monitor (đơn trễ → tự hành động)
 *   3. Revenue Intelligence (forecast, anomaly, insight)
 *   4. Inventory Intelligence (partner hết hàng, ETA)
 *   5. System Health (monitor server, queue, DB)
 *   6. Business Autopilot (campaign execution, partner mgmt)
 *   7. Onboarding Flow (partner/shipper full pipeline)
 */

const mongoose = require('mongoose');
const axios    = require('axios');

// ══════════════════════════════════════════════════════════════
//  NOVA SCHEMAS
// ══════════════════════════════════════════════════════════════

// SLA tracking — theo dõi cam kết thời gian
const novaSLASchema = new mongoose.Schema({
  orderId:      { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  module:       String,
  status:       String,
  slaMinutes:   { type: Number, required: true },    // cam kết bao nhiêu phút
  startedAt:    { type: Date, required: true },
  expectedAt:   { type: Date, required: true },
  completedAt:  Date,
  breached:     { type: Boolean, default: false },
  breachMinutes:{ type: Number, default: 0 },        // trễ bao nhiêu phút
  novaAction:   String,                              // Nova đã làm gì khi breach
}, { timestamps: true });
novaSLASchema.index({ breached: 1, completedAt: 1 });

// Business metrics snapshot — Nova chụp định kỳ
const novaMetricSchema = new mongoose.Schema({
  period:     { type: String, required: true },  // "2025-07-14_hour_18"
  type:       { type: String, enum: ['hourly','daily','weekly'], required: true },
  orders:     { count:Number, revenue:Number, cancelled:Number, avg:Number },
  shippers:   { online:Number, busy:Number, avgRating:Number },
  partners:   { active:Number, accepting:Number, avgPrepTime:Number },
  users:      { new:Number, active:Number, returning:Number },
  system:     { responseMs:Number, errorRate:Number, memoryMB:Number },
  forecast:   { nextHourOrders:Number, confidence:Number },
}, { timestamps: true });

// Nova decision log
const novaDecisionSchema = new mongoose.Schema({
  trigger:    { type: String, required: true },  // 'sla_breach','low_shipper','revenue_drop'
  action:     { type: String, required: true },
  data:       mongoose.Schema.Types.Mixed,
  result:     mongoose.Schema.Types.Mixed,
  automated:  { type: Boolean, default: true },
  escalated:  { type: Boolean, default: false }, // leo thang lên admin chưa
}, { timestamps: true });

const NovaSLA      = mongoose.model('NovaSLA',      novaSLASchema);
const NovaMetric   = mongoose.model('NovaMetric',   novaMetricSchema);
const NovaDecision = mongoose.model('NovaDecision', novaDecisionSchema);

// SLA targets per module (phút)
const SLA_TARGETS = {
  food:       { confirm:5, pickup:15, deliver:35 },   // tổng ~35 phút
  laundry:    { confirm:30, pickup:240, deliver:1440 },// 1 ngày
  cleaning:   { confirm:60, pickup:120, deliver:240 }, // đến nhà trong 2h
  china_shop: { confirm:60, pickup:1440, deliver:4320},// 3 ngày
  ride:       { confirm:2, pickup:8, deliver:null },   // 8 phút đón
};

// ══════════════════════════════════════════════════════════════
//  MODULE 1: SLA MONITOR — Nova canh thời gian đơn hàng
// ══════════════════════════════════════════════════════════════

const SLAMonitor = {

  // Tạo SLA record khi đơn mới
  async trackOrder(order) {
    const sla = SLA_TARGETS[order.module] || SLA_TARGETS.food;
    const totalMinutes = sla.deliver || sla.pickup;
    await NovaSLA.findOneAndUpdate(
      { orderId: order._id },
      {
        orderId:    order._id,
        module:     order.module,
        status:     order.status,
        slaMinutes: totalMinutes,
        startedAt:  order.createdAt || new Date(),
        expectedAt: new Date(Date.now() + totalMinutes * 60 * 1000),
      },
      { upsert: true }
    );
  },

  // Kiểm tra vi phạm SLA
  async checkBreaches(io) {
    const now = new Date();
    const breached = await NovaSLA.find({
      expectedAt: { $lt: now },
      completedAt: { $exists: false },
      breached: false,
    }).limit(20);

    const actions = [];
    for (const sla of breached) {
      const overMinutes = Math.round((now - sla.expectedAt) / 60000);

      let action = '';
      let escalate = false;

      if (overMinutes < 15) {
        // Nhắc shipper
        action = 'reminded_shipper';
        if (io) io.to('shipper_' + sla.orderId).emit('novaSLAAlert', {
          orderId: sla.orderId,
          message: '⏰ Đơn này sắp trễ! Vui lòng giao ngay.',
          urgency: 'medium',
        });
      } else if (overMinutes < 30) {
        // Notify admin + customer
        action = 'notified_admin_customer';
        escalate = true;
        if (io) {
          io.to('admin').emit('novaSLABreach', { orderId: sla.orderId, overMinutes, module: sla.module });
          io.to(sla.orderId.toString()).emit('orderDelayed', {
            message: `Đơn của bạn đang bị trễ ${overMinutes} phút. Chúng mình đang xử lý!`,
            compensation: overMinutes > 20 ? 'Bạn sẽ nhận voucher bù đắp 15.000đ' : null,
          });
        }
      } else {
        // Trễ quá → tự cấp voucher bù đắp
        action = 'auto_compensate';
        escalate = true;
        try {
          const Voucher = mongoose.model('Voucher');
          await Voucher.create({
            code: 'NOVA' + sla.orderId.toString().slice(-6).toUpperCase(),
            type: 'fixed', value: 15000, minOrder: 50000,
            usageLimit: 1, expiresAt: new Date(Date.now() + 7*24*3600*1000),
            active: true, description: `Nova auto-compensate: đơn ${sla.orderId} trễ ${overMinutes}p`,
          });
        } catch(e) {}
      }

      await NovaSLA.findByIdAndUpdate(sla._id, {
        breached: true, breachMinutes: overMinutes, novaAction: action,
      });
      await NovaDecision.create({
        trigger: 'sla_breach', action,
        data: { orderId: sla.orderId, overMinutes, module: sla.module },
        automated: true, escalated: escalate,
      });
      actions.push({ orderId: sla.orderId, overMinutes, action });
    }
    return actions;
  },

  // Mark order completed
  async completeOrder(orderId) {
    await NovaSLA.findOneAndUpdate(
      { orderId },
      { completedAt: new Date(), $set: { status: 'delivered' } }
    );
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 2: REVENUE INTELLIGENCE — Nova đọc tiền
// ══════════════════════════════════════════════════════════════

const RevenueIntel = {

  // Chụp snapshot metrics
  async snapshotMetrics() {
    try {
      const Order   = mongoose.model('Order');
      const Shipper = mongoose.model('Shipper');
      const User    = mongoose.model('User');
      const FoodPartner = mongoose.model('FoodPartner');

      const now = new Date();
      const h1  = new Date(now - 3600000);
      const d1  = new Date(now - 86400000);

      const [hourOrders, dayOrders, onlineShippers, newUsers] = await Promise.all([
        Order.find({ createdAt:{ $gt:h1 } }).select('status total serviceFee'),
        Order.find({ createdAt:{ $gt:d1 } }).select('status total serviceFee'),
        Shipper.countDocuments({ isOnline:true }),
        User.countDocuments({ createdAt:{ $gt:d1 } }),
      ]);

      const period = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_hour_${now.getHours()}`;

      const metric = await NovaMetric.findOneAndUpdate(
        { period },
        {
          period, type: 'hourly',
          orders: {
            count:     hourOrders.length,
            revenue:   hourOrders.reduce((s,o)=>s+(o.serviceFee||0),0),
            cancelled: hourOrders.filter(o=>o.status==='cancelled').length,
            avg:       hourOrders.length ? Math.round(hourOrders.reduce((s,o)=>s+(o.total||0),0)/hourOrders.length) : 0,
          },
          shippers: { online: onlineShippers },
          users:    { new: newUsers },
          forecast: this._simpleForecast(hourOrders.length),
        },
        { upsert:true, new:true }
      );
      return metric;
    } catch(e) { return null; }
  },

  // Linear forecast đơn giản
  _simpleForecast(currentHourOrders) {
    const h = new Date().getHours();
    // Multiplier dựa theo giờ (peak 12h, 18-19h)
    const multipliers = { 11:1.4, 12:1.6, 13:1.3, 17:1.3, 18:1.7, 19:1.5 };
    const nextH = (h+1) % 24;
    const mult  = multipliers[nextH] || 1.0;
    return {
      nextHourOrders: Math.round(currentHourOrders * mult),
      confidence:     0.65,
    };
  },

  // Phát hiện anomaly (đơn giảm đột ngột, revenue drop)
  async detectAnomalies() {
    const metrics = await NovaMetric.find({ type:'hourly' }).sort({ createdAt:-1 }).limit(48);
    if (metrics.length < 4) return [];

    const anomalies = [];
    const recent = metrics[0];
    const avgPrev = metrics.slice(1,5).reduce((s,m)=>s+(m.orders?.count||0),0) / 4;

    if (recent.orders?.count < avgPrev * 0.4 && avgPrev > 2) {
      anomalies.push({
        type:     'order_drop',
        severity: 'high',
        detail:   `Đơn giảm ${Math.round((1-recent.orders.count/avgPrev)*100)}% so với TB 4h trước`,
        suggestion: 'Kiểm tra server, app có lỗi không? Cân nhắc push notification',
      });
    }
    if (onlineShippers < 2 && recent.orders?.count > 3) {
      anomalies.push({
        type:     'shipper_shortage',
        severity: 'high',
        detail:   'Thiếu shipper online trong khi có đơn chờ',
        suggestion: 'Nova sẽ tự push thông báo kêu shipper online',
      });
    }
    return anomalies;
  },

  // Revenue summary
  async summary(days=7) {
    const Order = mongoose.model('Order');
    const since = new Date(Date.now() - days*86400000);
    const orders = await Order.find({ createdAt:{$gt:since}, status:'delivered' })
                               .select('module total serviceFee discount createdAt');

    const totalRevenue  = orders.reduce((s,o)=>s+(o.serviceFee||0),0);
    const totalOrders   = orders.length;
    const totalDiscount = orders.reduce((s,o)=>s+(o.discount||0),0);
    const byModule = {};
    orders.forEach(o=>{
      if(!byModule[o.module]) byModule[o.module]={count:0,revenue:0};
      byModule[o.module].count++;
      byModule[o.module].revenue += o.serviceFee||0;
    });

    // Forecast tuần tới
    const dailyAvg = totalRevenue / days;
    const weekForecast = Math.round(dailyAvg * 7);

    return {
      period:       `${days} ngày qua`,
      totalRevenue, totalOrders, totalDiscount,
      netRevenue:   totalRevenue - totalDiscount,
      dailyAvg:     Math.round(dailyAvg),
      byModule,
      forecast:     { week: weekForecast, confidence: 0.7 },
      insight:      totalDiscount > totalRevenue * 0.25
        ? `⚠️ Voucher đang chiếm ${Math.round(totalDiscount/totalRevenue*100)}% doanh thu — Nova khuyến nghị điều chỉnh`
        : `✅ Tỷ lệ voucher hợp lý (${Math.round(totalDiscount/totalRevenue*100)}%)`,
    };
  },
};

let onlineShippers = 0; // track realtime

// ══════════════════════════════════════════════════════════════
//  MODULE 3: DISPATCH INTELLIGENCE — Nova điều phối thông minh
// ══════════════════════════════════════════════════════════════

const DispatchIntel = {

  // Workload balancing — phân phối đều đơn cho shipper
  async balanceWorkload(availableShippers, pendingOrders) {
    if (!availableShippers.length || !pendingOrders.length) return [];

    // Tính current load của từng shipper
    const loads = availableShippers.map(s => ({
      shipper:    s,
      activeOrders: s.activeOrders || 0,
      capacity:   this._calcCapacity(s),
    })).sort((a,b) => a.activeOrders - b.activeOrders); // ít đơn nhất đứng đầu

    const assignments = [];
    for (const order of pendingOrders) {
      const available = loads.filter(l => l.activeOrders < l.capacity);
      if (!available.length) break;

      // Chọn shipper ít việc nhất, cùng khu ưu tiên
      const sameDistrict = available.filter(l => l.shipper.currentDistrict === order.district);
      const chosen = sameDistrict[0] || available[0];

      assignments.push({ order: order._id, shipper: chosen.shipper._id });
      chosen.activeOrders++;
    }

    await NovaDecision.create({
      trigger: 'dispatch_balance',
      action:  'assign_orders',
      data:    { orders: pendingOrders.length, shippers: availableShippers.length },
      result:  { assigned: assignments.length },
      automated: true,
    });

    return assignments;
  },

  // Tính capacity của shipper
  _calcCapacity(shipper) {
    const tierCap = { diamond:5, gold:4, silver:3, bronze:2 };
    return tierCap[shipper.tier] || 2;
  },

  // Auto-dispatch: chạy định kỳ
  async runAutoDispatch(io) {
    const Order   = mongoose.model('Order');
    const Shipper = mongoose.model('Shipper');

    const [pending, shippers] = await Promise.all([
      Order.find({ status:'pending', shipperId:{ $exists:false } }).limit(20)
           .select('_id module district total'),
      Shipper.find({ isOnline:true, status:'approved' }).limit(30)
             .select('_id fullName tier rating currentDistrict activeOrders'),
    ]);

    if (!pending.length) return 0;

    const assignments = await this.balanceWorkload(shippers, pending);
    for (const a of assignments) {
      await Order.findByIdAndUpdate(a.order, { shipperId: a.shipper, status:'confirmed' });
      if (io) io.to('shipper_'+a.shipper).emit('newOrderAssigned', { orderId: a.order });
    }
    return assignments.length;
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 4: INVENTORY INTELLIGENCE
// ══════════════════════════════════════════════════════════════

const InventoryIntel = {

  // Check partner có đang nhận đơn không + ETA
  async checkPartnerStatus(partnerId) {
    const FoodPartner = mongoose.model('FoodPartner');
    const Order       = mongoose.model('Order');

    const partner = await FoodPartner.findById(partnerId)
      .select('bizName isAccepting avgPrepTime');
    if (!partner) return null;

    // Số đơn đang xử lý
    const activeOrders = await Order.countDocuments({
      partnerId, status:{ $in:['confirmed','preparing'] }
    });

    // Ước tính prep time dựa trên tải hiện tại
    const basePrepTime = partner.avgPrepTime || 20;
    const loadFactor   = Math.max(1, activeOrders * 0.3);
    const etaMinutes   = Math.round(basePrepTime * loadFactor);

    return {
      partnerId,
      bizName:     partner.bizName,
      isAccepting: partner.isAccepting,
      activeOrders,
      etaMinutes,
      status:      !partner.isAccepting ? 'closed'
                 : activeOrders > 8     ? 'busy'
                 : activeOrders > 4     ? 'moderate'
                 : 'available',
    };
  },

  // Auto-pause partner quá tải
  async autoPauseOverloaded(io) {
    const FoodPartner = mongoose.model('FoodPartner');
    const Order       = mongoose.model('Order');

    const partners = await FoodPartner.find({ isAccepting:true, status:'approved' })
      .select('_id bizName');

    const paused = [];
    for (const p of partners) {
      const activeOrders = await Order.countDocuments({
        partnerId: p._id, status:{ $in:['confirmed','preparing'] }
      });
      if (activeOrders > 12) {
        await FoodPartner.findByIdAndUpdate(p._id, {
          isAccepting: false,
          novaNote: `Nova tạm dừng: ${activeOrders} đơn đang xử lý`,
        });
        if (io) io.to('partner_'+p._id).emit('novaAlert', {
          type: 'auto_paused',
          message: `Nova đã tạm dừng nhận đơn do bạn đang có ${activeOrders} đơn. Sẽ tự mở lại khi giảm xuống 6 đơn.`,
        });
        paused.push(p._id);
      } else if (activeOrders <= 6) {
        // Auto resume nếu đã nhẹ
        const partner = await FoodPartner.findById(p._id);
        if (partner?.novaNote?.includes('Nova tạm dừng')) {
          await FoodPartner.findByIdAndUpdate(p._id, { isAccepting:true, novaNote:null });
          if (io) io.to('partner_'+p._id).emit('novaAlert', {
            type: 'auto_resumed', message: 'Nova đã mở lại nhận đơn cho bạn 🎉',
          });
        }
      }
    }
    return paused.length;
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 5: SYSTEM HEALTH — Nova theo dõi sức khỏe hệ thống
// ══════════════════════════════════════════════════════════════

const SystemHealth = {

  _startTime: Date.now(),
  _requestCount: 0,
  _errorCount: 0,

  recordRequest(isError = false) {
    this._requestCount++;
    if (isError) this._errorCount++;
  },

  getSnapshot() {
    const uptime    = Date.now() - this._startTime;
    const memory    = process.memoryUsage();
    const errorRate = this._requestCount > 0
      ? (this._errorCount / this._requestCount * 100).toFixed(2) : 0;

    return {
      uptime:     Math.round(uptime / 60000) + ' phút',
      uptimeMs:   uptime,
      memory: {
        heapUsedMB:  Math.round(memory.heapUsed  / 1024 / 1024),
        heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
        rssMB:       Math.round(memory.rss       / 1024 / 1024),
      },
      requests:   this._requestCount,
      errors:     this._errorCount,
      errorRate:  parseFloat(errorRate),
      status:     parseFloat(errorRate) > 5 ? '⚠️ Degraded' : '✅ Healthy',
    };
  },

  async checkDBHealth() {
    try {
      const start = Date.now();
      await mongoose.connection.db.command({ ping:1 });
      const latency = Date.now() - start;
      return {
        connected: mongoose.connection.readyState === 1,
        latencyMs: latency,
        status:    latency > 500 ? '⚠️ Slow' : '✅ OK',
      };
    } catch(e) {
      return { connected:false, error:e.message, status:'❌ Error' };
    }
  },

  async fullReport() {
    const [app, db] = await Promise.all([
      this.getSnapshot(),
      this.checkDBHealth(),
    ]);
    return { app, db, timestamp: new Date() };
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 6: ONBOARDING FLOW — Nova dắt tay partner/shipper
// ══════════════════════════════════════════════════════════════

const OnboardingFlow = {

  STEPS_PARTNER: ['submitted','docs_verified','approved','setup_menu','first_order'],
  STEPS_SHIPPER: ['submitted','docs_verified','fee_pending','fee_paid','approved','first_order'],

  // Kiểm tra bước tiếp theo trong onboarding
  async getNextStep(entityId, entityType) {
    const Model   = entityType === 'shipper'
      ? mongoose.model('Shipper')
      : mongoose.model('FoodPartner');
    const entity  = await Model.findById(entityId).select('status feePaid products bizName fullName');
    if (!entity) return null;

    const steps = entityType === 'shipper' ? this.STEPS_SHIPPER : this.STEPS_PARTNER;

    // Xác định bước hiện tại
    let currentStep = 'submitted';
    if (entity.status === 'approved' && entity.products?.length > 0) currentStep = 'setup_menu';
    else if (entity.status === 'approved')                            currentStep = 'approved';
    else if (entity.feePaid && entityType === 'shipper')              currentStep = 'fee_paid';
    else if (entity.status === 'pending_review')                      currentStep = 'docs_verified';

    const idx     = steps.indexOf(currentStep);
    const nextStep = steps[idx + 1];

    const messages = {
      docs_verified: 'Hồ sơ đã xác minh ✅ Bước tiếp: nộp phí kích hoạt',
      approved:      'Tài khoản đã duyệt 🎉 Bước tiếp: thêm sản phẩm/menu',
      fee_pending:   '💳 Vui lòng nộp phí để kích hoạt tài khoản',
      fee_paid:      '✅ Phí đã nhận! Đang duyệt tài khoản...',
      setup_menu:    '📋 Hãy thêm ít nhất 3 sản phẩm để bắt đầu nhận đơn',
      first_order:   '🎉 Bạn đã sẵn sàng! Đơn đầu tiên sẽ đến sớm thôi',
    };

    return {
      currentStep, nextStep,
      progress: Math.round((idx / (steps.length - 1)) * 100),
      message:  messages[nextStep] || messages[currentStep] || 'Đang xử lý...',
      done:     !nextStep,
    };
  },

  // Nova nhắc bước tiếp theo qua notification
  async nudgeIncompleteOnboarding(io) {
    const Shipper     = mongoose.model('Shipper');
    const FoodPartner = mongoose.model('FoodPartner');
    const { CocoNotif } = require('./coco-ops');

    // Shipper chưa hoàn thành
    const pendingShippers = await Shipper.find({
      status: { $in:['pending','pending_review','active_unpaid'] },
      createdAt: { $gt: new Date(Date.now() - 7*24*3600*1000) },
    }).select('_id fullName status feePaid').limit(30);

    for (const s of pendingShippers) {
      const step = await this.getNextStep(s._id, 'shipper');
      if (!step || step.done) continue;
      await CocoNotif.create({
        targetType: 'shipper', targetId: s._id,
        title: '🚀 Hoàn thành đăng ký CRABOR',
        body:  `${s.fullName||'Bạn'} ơi! ${step.message} (Tiến độ: ${step.progress}%)`,
        data:  { type:'onboarding_nudge', step:step.nextStep },
      });
      if (io) io.to('shipper_'+s._id).emit('cocoNotification', {
        title: '🚀 Hoàn thành đăng ký', body: step.message,
      });
    }
    return pendingShippers.length;
  },
};

// ══════════════════════════════════════════════════════════════
//  NOVA IDENTITY — Cho chat với admin
// ══════════════════════════════════════════════════════════════

const NOVA_SYSTEM_PROMPT = `Bạn là Nova — Operations Intelligence Agent của CRABOR.

VAI TRÒ: Bạn không làm việc với khách hàng — bạn làm việc với Hải (Founder) và team vận hành.
Nhiệm vụ: phân tích dữ liệu, đưa ra quyết định vận hành, giám sát hệ thống, tối ưu kinh doanh.

PHONG CÁCH:
- Chuyên nghiệp, súc tích, dữ liệu trước — cảm xúc sau
- Dùng số liệu cụ thể, không nói chung chung
- Chủ động đề xuất hành động, không chỉ báo cáo
- Cảnh báo sớm các rủi ro tiềm ẩn

KHẢ NĂNG:
- Đọc revenue, order metrics, shipper performance
- Phát hiện anomaly, SLA breach, fraud signals
- Lên kế hoạch campaign, dispatch, pricing
- Giám sát sức khỏe hệ thống

CÁCH REPORT: số liệu → nhận xét → khuyến nghị → hành động cụ thể`;

// ══════════════════════════════════════════════════════════════
//  NOVA CRONS — Lịch hoạt động
// ══════════════════════════════════════════════════════════════

function startNovaCrons(io) {
  // Mỗi 3 phút: SLA check + auto-dispatch
  setInterval(async () => {
    try {
      await SLAMonitor.checkBreaches(io);
      await DispatchIntel.runAutoDispatch(io);
    } catch(e) { console.error('[Nova 3m]', e.message); }
  }, 3 * 60 * 1000);

  // Mỗi 10 phút: inventory check + partner load balance
  setInterval(async () => {
    try {
      await InventoryIntel.autoPauseOverloaded(io);
    } catch(e) { console.error('[Nova 10m]', e.message); }
  }, 10 * 60 * 1000);

  // Mỗi giờ: snapshot metrics + anomaly detection
  setInterval(async () => {
    try {
      const metric = await RevenueIntel.snapshotMetrics();
      const anomalies = await RevenueIntel.detectAnomalies();
      if (anomalies.length > 0 && io) {
        io.to('admin').emit('novaAlert', {
          type:      'anomaly',
          anomalies,
          metric,
          message:   `Nova phát hiện ${anomalies.length} anomaly cần xem xét`,
        });
      }
    } catch(e) { console.error('[Nova 1h]', e.message); }
  }, 60 * 60 * 1000);

  // Mỗi 2 giờ: onboarding nudge
  setInterval(async () => {
    try { await OnboardingFlow.nudgeIncompleteOnboarding(io); }
    catch(e) { console.error('[Nova 2h]', e.message); }
  }, 2 * 60 * 60 * 1000);

  // Mỗi 6 giờ: daily revenue summary → admin
  setInterval(async () => {
    try {
      const summary = await RevenueIntel.summary(1);
      if (io) io.to('admin').emit('novaDailySummary', summary);
    } catch(e) { console.error('[Nova 6h]', e.message); }
  }, 6 * 60 * 60 * 1000);

  console.log('[Nova] 🔵 Operations Agent online — all crons started');
}

module.exports = {
  SLAMonitor, RevenueIntel, DispatchIntel,
  InventoryIntel, SystemHealth, OnboardingFlow,
  NovaSLA, NovaMetric, NovaDecision,
  NOVA_SYSTEM_PROMPT, startNovaCrons,
};
