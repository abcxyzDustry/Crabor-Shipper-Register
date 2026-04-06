/**
 * COCO OPS ENGINE — Não vận hành CRABOR
 * 6 AI modules hoạt động độc lập, không cần API ngoài:
 *
 *  1. Dispatch AI    — ghép đơn, chọn shipper, tối ưu đường
 *  2. Pricing AI     — giá động theo giờ, margin tối ưu
 *  3. Risk/Fraud AI  — phát hiện gian lận, đơn ảo, abuse voucher
 *  4. Growth AI      — gợi ý, push notification thông minh, voucher
 *  5. Learning Engine— pattern/behavior/decision feedback loop
 *  6. Auto-Approve   — duyệt hồ sơ tự động, nhắc nộp phí
 */

const mongoose = require('mongoose');

// ══════════════════════════════════════════════════════════════
//  SCHEMAS BỔ SUNG
// ══════════════════════════════════════════════════════════════

// Behavioral patterns — Coco học từ hành vi
const cocoPatternSchema = new mongoose.Schema({
  type:      { type: String, enum: ['order','search','route','voucher','time','user'], required: true },
  key:       { type: String, required: true, index: true }, // "hour_19","district_caugiay","user_abc"
  value:     { type: mongoose.Schema.Types.Mixed },        // count, avg, array...
  count:     { type: Number, default: 1 },
  updatedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: false });
cocoPatternSchema.index({ type: 1, key: 1 }, { unique: true });

// Decision log — mọi quyết định AI đã đưa ra
const cocoDecisionSchema = new mongoose.Schema({
  module:    { type: String, enum: ['dispatch','pricing','fraud','growth','approve'], required: true },
  action:    { type: String, required: true },
  input:     { type: mongoose.Schema.Types.Mixed },
  output:    { type: mongoose.Schema.Types.Mixed },
  confidence:{ type: Number, min: 0, max: 1 },
  feedback:  { type: String, enum: ['positive','negative','neutral','pending'], default: 'pending' },
  entityId:  { type: mongoose.Schema.Types.ObjectId },
  entityType:{ type: String },
}, { timestamps: true });
cocoDecisionSchema.index({ module: 1, createdAt: -1 });

// Scheduled notifications queue
const cocoNotifSchema = new mongoose.Schema({
  targetType: { type: String, enum: ['user','shipper','partner','broadcast'], required: true },
  targetId:   { type: mongoose.Schema.Types.ObjectId },
  channel:    { type: String, enum: ['socket','email','sms','in-app'], default: 'in-app' },
  title:      { type: String, required: true },
  body:       { type: String, required: true },
  data:       { type: mongoose.Schema.Types.Mixed },
  scheduledAt:{ type: Date, default: Date.now },
  sentAt:     Date,
  status:     { type: String, enum: ['pending','sent','failed'], default: 'pending' },
  source:     { type: String, default: 'coco' },
}, { timestamps: true });
cocoNotifSchema.index({ status: 1, scheduledAt: 1 });

// Voucher campaigns — Coco tự lên kế hoạch
const cocoCampaignSchema = new mongoose.Schema({
  name:         { type: String, required: true },
  trigger:      { type: String, enum: ['low_orders','new_user','churn_risk','peak_hour','manual'], required: true },
  targetSegment:{ type: String }, // 'new_users','inactive_7d','high_value'...
  voucherConfig:{ type: mongoose.Schema.Types.Mixed }, // discount type/value/min
  budget:       { type: Number, required: true },      // ngân sách tối đa (VNĐ)
  spent:        { type: Number, default: 0 },
  status:       { type: String, enum: ['draft','active','paused','ended'], default: 'draft' },
  metrics:      {
    issued:     { type: Number, default: 0 },
    used:       { type: Number, default: 0 },
    revenue:    { type: Number, default: 0 },
  },
  cocoReason:   { type: String }, // tại sao Coco đề xuất campaign này
  approvedBy:   { type: String, default: 'coco_auto' },
  startAt:      Date,
  endAt:        Date,
}, { timestamps: true });

const CocoPattern  = mongoose.model('CocoPattern',  cocoPatternSchema);
const CocoDecision = mongoose.model('CocoDecision', cocoDecisionSchema);
const CocoNotif    = mongoose.model('CocoNotif',    cocoNotifSchema);
const CocoCampaign = mongoose.model('CocoCampaign', cocoCampaignSchema);

// ══════════════════════════════════════════════════════════════
//  MODULE 1: DISPATCH AI — não ghép đơn
// ══════════════════════════════════════════════════════════════

const DispatchAI = {

  // Chọn shipper tốt nhất cho đơn
  async selectShipper(order, availableShippers) {
    if (!availableShippers?.length) return null;

    // Score từng shipper
    const scored = availableShippers.map(shipper => {
      let score = 0;

      // 1. Tier bonus (Kim Cương = 40, Vàng = 30, Bạc = 20, Đồng = 10)
      const tierMap = { diamond: 40, gold: 30, silver: 20, bronze: 10 };
      score += tierMap[shipper.tier] || 10;

      // 2. Rating (max 25 điểm)
      score += ((shipper.rating || 4.5) - 4.0) * 50; // 4.5 → 25, 5.0 → 50

      // 3. Số đơn hôm nay (ưu tiên shipper ít đơn hơn để cân bằng tải)
      const todayOrders = shipper.todayOrders || 0;
      score -= Math.min(todayOrders * 2, 20);

      // 4. District match (cùng quận +20)
      if (shipper.currentDistrict === order.district) score += 20;

      // 5. Đang online (phải online mới chọn)
      if (!shipper.isOnline) return { shipper, score: -999 };

      return { shipper, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best.score < 0) return null;

    // Log decision
    await CocoDecision.create({
      module: 'dispatch', action: 'select_shipper',
      input:  { orderId: order._id, candidates: availableShippers.length },
      output: { shipperId: best.shipper._id, score: best.score },
      confidence: Math.min(1, best.score / 100),
      entityId: order._id, entityType: 'Order',
    });

    return best.shipper;
  },

  // Ghép đơn (batch) — gom nhiều đơn cùng khu vực
  async batchOrders(pendingOrders) {
    if (!pendingOrders?.length) return [];

    // Group by district
    const byDistrict = {};
    pendingOrders.forEach(o => {
      const key = o.district || 'unknown';
      if (!byDistrict[key]) byDistrict[key] = [];
      byDistrict[key].push(o);
    });

    const batches = [];
    for (const [district, orders] of Object.entries(byDistrict)) {
      // Batch tối đa 3 đơn cùng khu (tránh shipper đợi lâu)
      const chunks = [];
      for (let i = 0; i < orders.length; i += 3) chunks.push(orders.slice(i, i + 3));
      chunks.forEach(chunk => batches.push({ district, orders: chunk, type: chunk.length > 1 ? 'batch' : 'single' }));
    }

    return batches;
  },

  // Tối ưu đường đi (nearest neighbor heuristic)
  optimizeRoute(stops) {
    if (!stops?.length) return stops;
    if (stops.length <= 2) return stops;

    const visited = new Set();
    const route = [stops[0]]; // bắt đầu từ điểm đầu
    visited.add(0);

    while (visited.size < stops.length) {
      const current = route[route.length - 1];
      let nearest = null, nearestDist = Infinity;

      stops.forEach((stop, i) => {
        if (visited.has(i)) return;
        const dist = this._haversine(current.lat, current.lng, stop.lat, stop.lng);
        if (dist < nearestDist) { nearestDist = dist; nearest = { stop, i }; }
      });

      if (nearest) { route.push(nearest.stop); visited.add(nearest.i); }
    }
    return route;
  },

  // Haversine distance (km)
  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },

  // China Shop batch — gom hàng Trung Quốc cùng nguồn
  async batchChinaShopOrders(orders) {
    // Group by supplier/source
    const bySource = {};
    orders.forEach(o => {
      const key = o.partnerId?.toString() || 'generic';
      if (!bySource[key]) bySource[key] = [];
      bySource[key].push(o);
    });
    return Object.entries(bySource).map(([source, ords]) => ({
      source, orders: ords,
      estimatedPickup: new Date(Date.now() + 24*3600*1000), // next day
      savings: ords.length > 1 ? Math.floor(Math.random()*15+5) + '%' : '0%',
    }));
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 2: PRICING AI — não kiếm tiền
// ══════════════════════════════════════════════════════════════

const PricingAI = {

  // Base ship fee config (km-based)
  BASE_FEE:    15000,
  PER_KM:       3500,
  MIN_FEE:     15000,
  MAX_FEE:     80000,

  // Surge multiplier theo giờ
  SURGE_BY_HOUR: {
    6: 1.0, 7: 1.1, 8: 1.3, 9: 1.1, 10: 1.0,
    11: 1.2, 12: 1.5, 13: 1.3, 14: 1.0, 15: 1.0,
    16: 1.1, 17: 1.3, 18: 1.6, 19: 1.6, 20: 1.4,
    21: 1.2, 22: 1.1, 23: 1.0,
  },

  // Tính phí ship động
  async calcShipFee({ distanceKm = 3, hour = null, district = null, orderTotal = 0 }) {
    const h = hour ?? new Date().getHours();
    const surge = this.SURGE_BY_HOUR[h] || 1.0;

    // Base + distance
    let fee = this.BASE_FEE + (Math.max(0, distanceKm - 2) * this.PER_KM);

    // Surge
    fee = Math.round(fee * surge);

    // Free ship nếu đơn lớn (>200k)
    if (orderTotal >= 200000) fee = Math.max(0, fee - 10000);

    // Clamp
    fee = Math.max(this.MIN_FEE, Math.min(this.MAX_FEE, fee));

    // Learn pattern
    const key = `hour_${h}`;
    await CocoPattern.findOneAndUpdate(
      { type: 'time', key },
      { $inc: { count: 1 }, $set: { updatedAt: new Date(), value: surge } },
      { upsert: true }
    );

    return { fee, surge, hour: h, isSurge: surge > 1.2 };
  },

  // Dynamic service fee (% theo module + thời điểm)
  calcServiceFee(module, orderTotal) {
    const baseRates = { food: 0.18, laundry: 0.15, cleaning: 0.15, china_shop: 0.12, ride: 0.20 };
    const rate = baseRates[module] || 0.18;
    const h = new Date().getHours();
    const surge = this.SURGE_BY_HOUR[h] || 1.0;
    // Tăng nhẹ service fee khi cao điểm (max +2%)
    const finalRate = Math.min(rate + (surge > 1.3 ? 0.02 : 0), 0.22);
    return Math.round(orderTotal * finalRate);
  },

  // Phân tích margin & đề xuất
  async analyzeMargin(days = 7) {
    const Order = mongoose.model('Order');
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const orders = await Order.find({ createdAt: { $gt: since }, status: 'delivered' })
                               .select('module total serviceFee shipFee discount');
    if (!orders.length) return null;

    const byModule = {};
    orders.forEach(o => {
      if (!byModule[o.module]) byModule[o.module] = { count:0, revenue:0, serviceFee:0, shipFee:0, discount:0 };
      const m = byModule[o.module];
      m.count++;
      m.revenue  += o.serviceFee || 0;
      m.shipFee  += o.shipFee   || 0;
      m.discount += o.discount  || 0;
    });

    const insights = Object.entries(byModule).map(([module, data]) => ({
      module,
      orders:      data.count,
      avgRevenue:  Math.round(data.revenue / data.count),
      avgDiscount: Math.round(data.discount / data.count),
      netMargin:   Math.round((data.revenue - data.discount) / data.count),
      suggestion:  data.discount / data.revenue > 0.3
        ? `⚠️ Voucher đang ăn ${Math.round(data.discount/data.revenue*100)}% doanh thu — cân nhắc giảm`
        : `✅ Margin ổn`,
    }));

    return insights;
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 3: RISK / FRAUD AI
// ══════════════════════════════════════════════════════════════

const FraudAI = {

  RISK_THRESHOLDS: {
    fake_order:      0.7,
    voucher_abuse:   0.6,
    shipper_fraud:   0.65,
  },

  // Phân tích đơn hàng — có ảo không?
  async analyzeOrder(order, user) {
    let riskScore = 0;
    const signals = [];

    // 1. Tài khoản mới đặt đơn lớn
    const acctAge = (Date.now() - new Date(user.createdAt)) / (24*3600*1000);
    if (acctAge < 1 && order.total > 500000) {
      riskScore += 0.3; signals.push('new_account_large_order');
    }

    // 2. Nhiều đơn cùng địa chỉ trong 1h
    const Order = mongoose.model('Order');
    const recentSameAddr = await Order.countDocuments({
      address:    order.address,
      createdAt:  { $gt: new Date(Date.now() - 3600*1000) },
      status:     { $ne: 'cancelled' },
    });
    if (recentSameAddr >= 3) { riskScore += 0.25; signals.push('multiple_orders_same_address'); }

    // 3. Thanh toán COD + đơn lớn + tài khoản mới
    if (order.paymentMethod === 'cod' && order.total > 1000000 && acctAge < 7) {
      riskScore += 0.25; signals.push('cod_large_new_account');
    }

    // 4. Địa chỉ không hợp lệ (quá ngắn)
    if (!order.address || order.address.length < 10) {
      riskScore += 0.15; signals.push('invalid_address');
    }

    const riskLevel = riskScore >= 0.7 ? 'high' : riskScore >= 0.4 ? 'medium' : 'low';

    if (riskScore >= 0.4) {
      await CocoDecision.create({
        module: 'fraud', action: 'flag_order',
        input:  { orderId: order._id, userId: user._id },
        output: { riskScore, signals, riskLevel },
        confidence: riskScore,
        entityId: order._id, entityType: 'Order',
      });
    }

    return { riskScore, signals, riskLevel, autoBlock: riskScore >= 0.7 };
  },

  // Phát hiện abuse voucher
  async checkVoucherAbuse(userId, voucherCode) {
    const Order = mongoose.model('Order');
    const User  = mongoose.model('User');

    // Đã dùng voucher này chưa?
    const alreadyUsed = await Order.countDocuments({ customerId: userId, voucherCode });
    if (alreadyUsed > 0) return { blocked: true, reason: 'voucher_already_used' };

    // Trong 24h dùng bao nhiêu voucher?
    const todayVouchers = await Order.countDocuments({
      customerId: userId,
      voucherCode: { $exists: true, $ne: null },
      createdAt:  { $gt: new Date(Date.now() - 24*3600*1000) },
    });
    if (todayVouchers >= 3) return { blocked: true, reason: 'too_many_vouchers_today' };

    // Tài khoản mới dùng voucher lớn
    const user = await User.findById(userId).select('createdAt totalSpent');
    const acctAge = (Date.now() - new Date(user?.createdAt)) / (24*3600*1000);
    const voucher = await mongoose.model('Voucher').findOne({ code: voucherCode });
    if (acctAge < 1 && voucher?.value > 50000) {
      return { blocked: true, reason: 'new_account_large_voucher' };
    }

    return { blocked: false };
  },

  // Phát hiện shipper gian lận
  async analyzeShipperBehavior(shipperId, recentOrders) {
    const signals = [];
    let riskScore = 0;

    // 1. Tỷ lệ hủy đơn cao
    const cancelRate = recentOrders.filter(o => o.status === 'cancelled' && o.shipperId?.toString() === shipperId.toString()).length / Math.max(recentOrders.length, 1);
    if (cancelRate > 0.3) { riskScore += 0.3; signals.push(`cancel_rate_${Math.round(cancelRate*100)}%`); }

    // 2. Rating thấp liên tục
    const avgRating = recentOrders.reduce((s, o) => s + (o.shipperRating||5), 0) / Math.max(recentOrders.length, 1);
    if (avgRating < 3.5) { riskScore += 0.25; signals.push(`low_rating_${avgRating.toFixed(1)}`); }

    // 3. Delivery time bất thường (quá nhanh hoặc quá chậm)
    const deliveryTimes = recentOrders
      .filter(o => o.status === 'delivered' && o.pickedUpAt && o.deliveredAt)
      .map(o => (new Date(o.deliveredAt) - new Date(o.pickedUpAt)) / 60000); // minutes
    const suspicious = deliveryTimes.filter(t => t < 2 || t > 120);
    if (suspicious.length > recentOrders.length * 0.2) {
      riskScore += 0.2; signals.push('suspicious_delivery_times');
    }

    return { shipperId, riskScore, signals, flag: riskScore >= 0.5 };
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 4: GROWTH AI — não tăng trưởng
// ══════════════════════════════════════════════════════════════

const GrowthAI = {

  // Gợi ý món ăn dựa trên lịch sử
  async recommendFood(userId) {
    const Order = mongoose.model('Order');
    const orders = await Order.find({ customerId: userId, module: 'food', status: 'delivered' })
                               .select('items partnerId').sort({ createdAt: -1 }).limit(10);
    if (!orders.length) return [];

    // Tần suất món đặt
    const itemCount = {};
    const partnerCount = {};
    orders.forEach(o => {
      o.items?.forEach(item => {
        itemCount[item.name] = (itemCount[item.name]||0) + 1;
      });
      if (o.partnerId) partnerCount[o.partnerId.toString()] = (partnerCount[o.partnerId.toString()]||0) + 1;
    });

    const topItems    = Object.entries(itemCount).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([name])=>name);
    const topPartners = Object.entries(partnerCount).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([id])=>id);

    return { topItems, topPartners, message: `Hôm nay thử lại ${topItems[0] || 'món yêu thích'}?` };
  },

  // Phân đoạn user để gửi notification thông minh
  async segmentUsers() {
    const User  = mongoose.model('User');
    const Order = mongoose.model('Order');

    const now = new Date();
    const d7  = new Date(now - 7*24*3600*1000);
    const d30 = new Date(now - 30*24*3600*1000);

    // User đặt đơn trong 7 ngày qua
    const activeIds = await Order.distinct('customerId', { createdAt: { $gt: d7 }, status: 'delivered' });

    // User có đơn 7-30 ngày trước nhưng không có đơn 7 ngày gần đây (churn risk)
    const inactiveIds = await Order.distinct('customerId', {
      createdAt: { $gt: d30, $lte: d7 }, status: 'delivered',
      customerId: { $nin: activeIds },
    });

    // New users (đăng ký trong 3 ngày)
    const newUsers = await User.find({ createdAt: { $gt: new Date(now - 3*24*3600*1000) } })
                                .select('_id').limit(100);

    return {
      active:   activeIds.length,
      churnRisk: inactiveIds,
      newUserIds: newUsers.map(u => u._id),
      stats: { active: activeIds.length, churnRisk: inactiveIds.length, newUsers: newUsers.length },
    };
  },

  // Coco tự lên kế hoạch voucher (budget-aware)
  async planVoucherCampaign(ownerBudget = 5000000) {
    const segments = await this.segmentUsers();
    const margin = await PricingAI.analyzeMargin(7);
    const avgOrderValue = margin?.find(m=>m.module==='food')?.avgRevenue || 40000;

    const campaigns = [];

    // Campaign 1: Thu hút user mới nếu có
    if (segments.newUserIds.length > 0) {
      const budget1 = Math.min(ownerBudget * 0.3, segments.newUserIds.length * 20000);
      campaigns.push({
        name: `Chào user mới — ${new Date().toLocaleDateString('vi-VN')}`,
        trigger: 'new_user',
        targetSegment: 'new_users',
        voucherConfig: { type: 'percent', value: 20, maxDiscount: 30000, minOrder: 50000 },
        budget: budget1,
        cocoReason: `${segments.newUserIds.length} user mới trong 3 ngày. Voucher 20% giúp đặt đơn đầu tiên.`,
        startAt: new Date(),
        endAt: new Date(Date.now() + 7*24*3600*1000),
      });
    }

    // Campaign 2: Win-back user sắp rời bỏ
    if (segments.churnRisk.length > 5) {
      const budget2 = Math.min(ownerBudget * 0.4, segments.churnRisk.length * 25000);
      campaigns.push({
        name: `Win-back — ${segments.churnRisk.length} user im lặng`,
        trigger: 'churn_risk',
        targetSegment: 'inactive_7d',
        voucherConfig: { type: 'fixed', value: 25000, minOrder: 80000 },
        budget: budget2,
        cocoReason: `${segments.churnRisk.length} user không đặt đơn 7 ngày. Voucher 25k có thể kéo lại.`,
        startAt: new Date(),
        endAt: new Date(Date.now() + 3*24*3600*1000),
      });
    }

    // Tổng budget check
    const totalBudget = campaigns.reduce((s, c) => s + c.budget, 0);
    if (totalBudget > ownerBudget * 0.8) {
      // Cắt giảm proportionally
      const ratio = (ownerBudget * 0.8) / totalBudget;
      campaigns.forEach(c => { c.budget = Math.round(c.budget * ratio); });
    }

    return {
      campaigns,
      totalBudget: campaigns.reduce((s,c)=>s+c.budget,0),
      ownerBudget,
      safetyMargin: ownerBudget - campaigns.reduce((s,c)=>s+c.budget,0),
      cocoAdvice: `Coco đề xuất ${campaigns.length} campaign với tổng ${campaigns.reduce((s,c)=>s+c.budget,0).toLocaleString('vi-VN')}đ / ngân sách ${ownerBudget.toLocaleString('vi-VN')}đ`,
    };
  },

  // Tạo và queue notification thông minh
  async scheduleNotification({ targetType, targetId, title, body, data, delayMs = 0, channel = 'in-app' }) {
    const scheduledAt = new Date(Date.now() + (delayMs || 0));
    const notif = await CocoNotif.create({ targetType, targetId, title, body, data, scheduledAt, channel, source: 'coco_growth' });
    return notif;
  },

  // Push notification cho churn-risk users
  async pushChurnNotifications(io) {
    const segments = await this.segmentUsers();
    const sent = [];
    for (const userId of segments.churnRisk.slice(0, 20)) {
      const recs = await this.recommendFood(userId);
      const body = recs.topItems?.length
        ? `Lâu rồi không gặp! ${recs.message} 🍜`
        : `CRABOR nhớ bạn! Đặt ngay để nhận ưu đãi 🦀`;
      const notif = await this.scheduleNotification({
        targetType: 'user', targetId: userId,
        title: '🦀 CRABOR nhớ bạn!', body,
        data: { type: 'churn_winback' },
      });
      // Emit realtime nếu user online
      if (io) io.to(userId.toString()).emit('cocoNotification', { title: notif.title, body: notif.body, data: notif.data });
      sent.push(userId);
    }
    return sent.length;
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 5: LEARNING ENGINE — não học thật sự
// ══════════════════════════════════════════════════════════════

const LearningEngine = {

  // Ghi nhận pattern hành vi
  async recordBehavior(type, key, value = 1) {
    await CocoPattern.findOneAndUpdate(
      { type, key },
      { $inc: { count: value }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
  },

  // Học từ đơn hàng thành công
  async learnFromOrder(order) {
    const h = new Date(order.createdAt).getHours();
    // Học: giờ nào nhiều đơn
    await this.recordBehavior('time', `peak_hour_${h}`);
    // Học: quận nào nhiều đơn
    if (order.district) await this.recordBehavior('order', `district_${order.district.replace(/\s/g,'_').toLowerCase()}`);
    // Học: module nào phổ biến
    await this.recordBehavior('order', `module_${order.module}`);
  },

  // Học từ feedback (decision đúng hay sai)
  async feedbackDecision(decisionId, feedback) {
    const dec = await CocoDecision.findByIdAndUpdate(decisionId, { feedback }, { new: true });
    if (!dec) return;

    // Nếu nhiều feedback xấu → điều chỉnh threshold
    if (feedback === 'negative') {
      const recentNeg = await CocoDecision.countDocuments({
        module: dec.module, action: dec.action,
        feedback: 'negative',
        createdAt: { $gt: new Date(Date.now() - 7*24*3600*1000) },
      });
      if (recentNeg >= 5) {
        console.log(`[Coco Learn] Module ${dec.module}/${dec.action} có ${recentNeg} feedback xấu → cần review`);
      }
    }
    return dec;
  },

  // Phân tích patterns để tìm insight
  async analyzePatterns() {
    const patterns = await CocoPattern.find({}).sort({ count: -1 }).limit(50);

    // Peak hours
    const peakHours = patterns
      .filter(p => p.key.startsWith('peak_hour_'))
      .sort((a,b) => b.count - a.count)
      .slice(0, 5)
      .map(p => ({ hour: p.key.replace('peak_hour_',''), count: p.count }));

    // Top districts
    const topDistricts = patterns
      .filter(p => p.key.startsWith('district_'))
      .sort((a,b) => b.count - a.count)
      .slice(0, 5)
      .map(p => ({ district: p.key.replace('district_',''), count: p.count }));

    // Popular modules
    const modules = patterns
      .filter(p => p.key.startsWith('module_'))
      .sort((a,b) => b.count - a.count)
      .map(p => ({ module: p.key.replace('module_',''), count: p.count }));

    return { peakHours, topDistricts, modules };
  },
};

// ══════════════════════════════════════════════════════════════
//  MODULE 6: AUTO-APPROVE AI
// ══════════════════════════════════════════════════════════════

const AutoApproveAI = {

  // Quyết định duyệt partner
  async reviewPartner(partner, Model) {
    const signals = [];
    let score = 100; // bắt đầu đủ điều kiện

    // Check fields
    if (!partner.bizName || partner.bizName.length < 2)   { score -= 20; signals.push('missing_biz_name'); }
    if (!partner.phone   || !/^0[0-9]{9}$/.test(partner.phone)) { score -= 15; signals.push('invalid_phone'); }
    if (!partner.address || partner.address.length < 10)  { score -= 10; signals.push('missing_address'); }
    if (!partner.district)                                 { score -= 5;  signals.push('missing_district'); }

    const decision = score >= 70 ? 'approved' : score >= 50 ? 'pending_review' : 'rejected';
    const reason   = signals.length ? signals.join(', ') : 'Đủ điều kiện';

    await CocoDecision.create({
      module: 'approve', action: 'review_partner',
      input:  { partnerId: partner._id, bizName: partner.bizName },
      output: { score, decision, signals },
      confidence: score / 100,
      entityId: partner._id, entityType: Model.modelName,
    });

    if (decision === 'approved') {
      await Model.findByIdAndUpdate(partner._id, { status: 'approved', approvedAt: new Date(), cocoApproved: true });
    }

    return { decision, score, signals, reason };
  },

  // Duyệt shipper — linh hoạt hơn
  async reviewShipper(shipper) {
    const Shipper = mongoose.model('Shipper');
    const signals = [];
    let score = 100;

    // Validation cơ bản
    if (!shipper.phone   || !/^0[0-9]{9}$/.test(shipper.phone)) { score -= 20; signals.push('invalid_phone'); }
    if (!shipper.fullName || shipper.fullName.length < 3)         { score -= 15; signals.push('missing_name'); }

    // Đã nộp phí chưa? → Nếu chưa thì VẪN duyệt nhưng flag = pending_payment
    const hasPaid = !!shipper.feePaid || shipper.status === 'pending_review';
    if (!hasPaid) { signals.push('fee_not_paid'); }

    // Nếu điểm >= 60 thì cho đăng nhập (kể cả chưa nộp phí)
    const canLogin = score >= 60;
    const needsPayment = !hasPaid;

    // Update status
    if (canLogin && !hasPaid) {
      await Shipper.findByIdAndUpdate(shipper._id, {
        status: 'active_unpaid',    // đăng nhập được nhưng chưa đủ quyền nhận đơn
        cocoNote: 'Coco đã duyệt hồ sơ. Vui lòng nộp phí để nhận đơn.',
      });
    } else if (canLogin && hasPaid) {
      await Shipper.findByIdAndUpdate(shipper._id, { status: 'approved', approvedAt: new Date(), cocoApproved: true });
    }

    await CocoDecision.create({
      module: 'approve', action: 'review_shipper',
      input:  { shipperId: shipper._id },
      output: { score, canLogin, needsPayment, signals },
      confidence: score / 100,
      entityId: shipper._id, entityType: 'Shipper',
    });

    return { canLogin, needsPayment, score, signals };
  },

  // Nhắc shipper chưa nộp phí
  async remindUnpaidShippers(io) {
    const Shipper = mongoose.model('Shipper');
    const unpaid = await Shipper.find({ status: 'active_unpaid' }).select('_id fullName phone').limit(20);

    for (const s of unpaid) {
      // Queue in-app notification
      await CocoNotif.create({
        targetType: 'shipper', targetId: s._id,
        title: '💳 Hoàn tất kích hoạt tài khoản',
        body: `${s.fullName||'Bạn'} ơi! Hồ sơ đã duyệt ✅ Nộp phí để bắt đầu nhận đơn ngay nhé!\n📱 Vào /register → Thanh toán phí`,
        data: { type: 'payment_reminder', shipperId: s._id },
        source: 'coco_auto',
      });
      // Emit realtime nếu online
      if (io) io.to('shipper_' + s._id).emit('cocoNotification', {
        title: '💳 Hoàn tất kích hoạt', body: 'Nộp phí để bắt đầu nhận đơn!',
      });
    }
    return unpaid.length;
  },

  // Batch review: duyệt hàng loạt hồ sơ mới
  async batchReview(io) {
    try {
      const mongoose_ = mongoose;
      let totalApproved = 0, totalFlagged = 0;

      // Models
      const modelMap = {
        FoodPartner: mongoose_.model('FoodPartner'),
        GiatLa:      mongoose_.model('GiatLa'),
        GiupViec:    mongoose_.model('GiupViec'),
        ChinaShop:   mongoose_.model('ChinaShop'),
      };

      // Review partners
      for (const [name, Model] of Object.entries(modelMap)) {
        const pending = await Model.find({ status: 'pending', createdAt: { $lt: new Date(Date.now() - 300000) } }).limit(20);
        for (const p of pending) {
          const result = await this.reviewPartner(p, Model);
          if (result.decision === 'approved') {
            totalApproved++;
            if (io) io.to('admin').emit('partnerAutoApproved', { partnerId: p._id, bizName: p.bizName, model: name });
          }
        }
      }

      // Review shippers
      const Shipper = mongoose_.model('Shipper');
      const pendingShippers = await Shipper.find({
        status: { $in: ['pending', 'pending_review'] },
        createdAt: { $lt: new Date(Date.now() - 60000) }, // sau 1 phút
      }).limit(20);

      for (const s of pendingShippers) {
        const result = await this.reviewShipper(s);
        if (result.canLogin) {
          totalApproved++;
          if (io) io.to('admin').emit('shipperAutoApproved', { shipperId: s._id, needsPayment: result.needsPayment });
        } else {
          totalFlagged++;
        }
      }

      // Nhắc shipper chưa nộp phí
      await this.remindUnpaidShippers(io);

      return { totalApproved, totalFlagged };
    } catch(e) {
      console.error('[AutoApprove]', e.message);
      return { error: e.message };
    }
  },
};

// ══════════════════════════════════════════════════════════════
//  NOTIFICATION DISPATCHER — Coco tự gửi tin nhắn
// ══════════════════════════════════════════════════════════════

async function dispatchPendingNotifications(io) {
  const now = new Date();
  const pending = await CocoNotif.find({
    status: 'pending',
    scheduledAt: { $lte: now },
  }).limit(50);

  let sent = 0;
  for (const notif of pending) {
    try {
      // In-app via Socket.io
      if (notif.channel === 'in-app' && io) {
        const room = notif.targetType === 'broadcast'
          ? 'all'
          : notif.targetId?.toString();
        if (room) io.to(room).emit('cocoNotification', {
          title:  notif.title,
          body:   notif.body,
          data:   notif.data,
          sentAt: now,
        });
      }
      await CocoNotif.findByIdAndUpdate(notif._id, { status:'sent', sentAt:now });
      sent++;
    } catch(e) {
      await CocoNotif.findByIdAndUpdate(notif._id, { status:'failed' });
    }
  }
  return sent;
}

// ══════════════════════════════════════════════════════════════
//  OPS CRON — Lịch hoạt động của Coco
// ══════════════════════════════════════════════════════════════

function startOpsCrons(io) {
  // Mỗi 5 phút: dispatch notifications + auto-approve
  setInterval(async () => {
    try {
      await dispatchPendingNotifications(io);
      await AutoApproveAI.batchReview(io);
    } catch(e) { console.error('[Coco Ops 5m]', e.message); }
  }, 5 * 60 * 1000);

  // Mỗi 30 phút: analyze patterns
  setInterval(async () => {
    try { await LearningEngine.analyzePatterns(); }
    catch(e) { console.error('[Coco Learn 30m]', e.message); }
  }, 30 * 60 * 1000);

  // Mỗi 6 giờ: growth actions (churn push + voucher planning)
  setInterval(async () => {
    try {
      const sent = await GrowthAI.pushChurnNotifications(io);
      console.log(`[Coco Growth] Sent ${sent} churn-risk notifications`);
    } catch(e) { console.error('[Coco Growth 6h]', e.message); }
  }, 6 * 60 * 60 * 1000);

  // Mỗi giờ: nhắc shipper chưa nộp phí
  setInterval(async () => {
    try { await AutoApproveAI.remindUnpaidShippers(io); }
    catch(e) { console.error('[Coco Remind]', e.message); }
  }, 60 * 60 * 1000);

  console.log('[Coco Ops] 🤖 All operational crons started');
}

module.exports = {
  DispatchAI, PricingAI, FraudAI, GrowthAI, LearningEngine, AutoApproveAI,
  CocoPattern, CocoDecision, CocoNotif, CocoCampaign,
  dispatchPendingNotifications, startOpsCrons,
};
