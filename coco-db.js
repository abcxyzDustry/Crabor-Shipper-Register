/**
 * COCO DB — Database Intelligence Layer cho Coco AI
 *
 * Module này cho phép Coco đọc dữ liệu thật từ MongoDB để trả lời
 * chính xác các câu hỏi về đơn hàng, ví, vay, tickets...
 *
 * Usage:
 *   const CocoDb = require('./coco-db');
 *   const ctx = await CocoDb.buildUserContext(userId);     // full context
 *   const ctx = await CocoDb.buildShipperContext(shipperId);
 *   const ctx = await CocoDb.buildAdminContext();          // Nova admin view
 *   const answer = await CocoDb.queryOrder(orderId, userId); // tra cứu đơn
 */

'use strict';

const mongoose = require('mongoose');

// ══════════════════════════════════════════════════════════════
//  HELPER: lấy model an toàn (tránh lỗi nếu schema chưa đăng ký)
// ══════════════════════════════════════════════════════════════
function M(name) {
  return mongoose.models[name] || null;
}

// ══════════════════════════════════════════════════════════════
//  FORMAT HELPERS
// ══════════════════════════════════════════════════════════════
function vnd(n) {
  return (n || 0).toLocaleString('vi-VN') + 'đ';
}

function timeAgo(date) {
  if (!date) return 'không rõ';
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'vừa xong';
  if (mins < 60)  return `${mins} phút trước`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs} giờ trước`;
  const days = Math.floor(hrs / 24);
  return `${days} ngày trước`;
}

const STATUS_VI = {
  pending:                  '⏳ Chờ xác nhận',
  confirmed:                '✅ Đã xác nhận',
  preparing:                '👨‍🍳 Đang chuẩn bị',
  shipper_accepted:         '🛵 Shipper đã nhận',
  picking_up:               '🛵 Shipper đang lấy hàng',
  at_partner:               '📍 Shipper tại cửa hàng',
  picked_up:                '📦 Đã lấy hàng',
  delivering:               '🚀 Đang giao',
  delivered:                '🎉 Đã giao',
  cancelled:                '❌ Đã huỷ',
  refunded:                 '💸 Đã hoàn tiền',
  payment_pending_review:   '🔍 Đang xác nhận thanh toán',
  payment_confirmed:        '✅ Thanh toán xác nhận',
  finding_driver:           '🔍 Đang tìm tài xế',
  no_driver:                '⚠️ Không có tài xế',
  partner_accepted:         '✅ Đối tác đã nhận',
  ready:                    '✅ Sẵn sàng giao',
};

function statusVi(s) {
  return STATUS_VI[s] || s;
}

const MODULE_VI = {
  food:       '🍜 Đồ ăn',
  laundry:    '👕 Giặt là',
  cleaning:   '🧹 Giúp việc',
  china_shop: '🛍️ China Shop',
  ride:       '🚗 Xe công nghệ',
};

// ══════════════════════════════════════════════════════════════
//  1. BUILD USER CONTEXT — toàn bộ thông tin user cho Coco
// ══════════════════════════════════════════════════════════════
async function buildUserContext(userId) {
  if (!userId) return {};
  const ctx = {};

  try {
    // ── User cơ bản ──────────────────────────────────────────
    const User = M('User');
    if (User) {
      const user = await User.findById(userId)
        .select('fullName phone walletBalance loyaltyPts totalSpent totalOrders status district');
      if (user) {
        ctx.userId     = user._id.toString();
        ctx.name       = user.fullName || 'bạn';
        ctx.phone      = user.phone;
        ctx.walletBal  = user.walletBalance || 0;
        ctx.loyaltyPts = user.loyaltyPts || 0;
        ctx.totalSpent = user.totalSpent || 0;
        ctx.totalOrders= user.totalOrders || 0;
        ctx.district   = user.district || '';
        ctx.status     = user.status;
      }
    }

    // ── Đơn hàng gần nhất (5 đơn) ───────────────────────────
    const Order = M('Order');
    if (Order && userId) {
      const orders = await Order.find({ customerId: userId })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('orderId module status finalTotal total shipFee items address createdAt deliveredAt cancelReason paymentMethod paymentStatus ratingShipper ratingPartner');

      ctx.recentOrders = orders.map(o => ({
        orderId:       o.orderId,
        module:        MODULE_VI[o.module] || o.module,
        status:        statusVi(o.status),
        statusRaw:     o.status,
        total:         vnd(o.finalTotal || o.total),
        shipFee:       vnd(o.shipFee),
        items:         o.items?.map(i => `${i.name} x${i.qty}`).join(', ') || '',
        address:       o.address,
        time:          timeAgo(o.createdAt),
        createdAt:     o.createdAt,
        deliveredAt:   o.deliveredAt,
        cancelReason:  o.cancelReason || null,
        paymentMethod: o.paymentMethod,
        paymentStatus: o.paymentStatus,
        rated:         !!(o.ratingShipper || o.ratingPartner),
      }));

      // Đơn đang chạy (active)
      const activeStatuses = ['pending','confirmed','preparing','shipper_accepted','picking_up','at_partner','picked_up','delivering','finding_driver','partner_accepted','ready'];
      ctx.activeOrders = ctx.recentOrders.filter(o => activeStatuses.includes(o.statusRaw));
    }

    // ── BNPL (Ví Trả Sau) ────────────────────────────────────
    const BNPLInvoice = M('BNPLInvoice');
    const BNPLTx      = M('BNPLTx');
    if (BNPLInvoice && userId) {
      const unpaid = await BNPLInvoice.find({
        userId,
        status: { $in: ['issued','overdue','installment'] },
      }).sort({ dueDate: 1 }).limit(3);

      ctx.unpaidInvoices = unpaid.map(inv => ({
        billingMonth: inv.billingMonth,
        amount:       vnd(inv.finalAmount),
        dueDate:      inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('vi-VN') : '?',
        status:       inv.status === 'overdue' ? '⚠️ Quá hạn' : '📅 Chờ thanh toán',
        isOverdue:    inv.status === 'overdue',
      }));
    }
    if (BNPLTx && userId) {
      const now = new Date();
      const billingMonth = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
      const thisMonthTotal = await BNPLTx.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(userId), billingMonth, status: { $in: ['pending_bill','billed'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      ctx.bnplUsed = thisMonthTotal[0]?.total || 0;
    }
    // BNPL limit dựa totalSpent
    if (ctx.totalSpent !== undefined) {
      const ts = ctx.totalSpent;
      if (ts < 2000000)       ctx.bnplLimit = 0;
      else if (ts < 5000000)  ctx.bnplLimit = 2000000;
      else if (ts < 10000000) ctx.bnplLimit = 5000000;
      else if (ts < 20000000) ctx.bnplLimit = 10000000;
      else                    ctx.bnplLimit = 20000000;
    }

    // ── Loan (Vay nhanh) ─────────────────────────────────────
    const Loan = M('Loan');
    if (Loan && userId) {
      const loan = await Loan.findOne({
        userId,
        status: { $in: ['pending','approved','active','overdue'] },
      }).sort({ createdAt: -1 });
      if (loan) {
        ctx.activeLoan = {
          amount:    vnd(loan.amount),
          remaining: vnd(loan.amount - (loan.paidAmount || 0)),
          status:    loan.status,
          dueAt:     loan.dueAt ? new Date(loan.dueAt).toLocaleDateString('vi-VN') : '?',
          interestRate: loan.interestRate,
        };
      }
    }

    // ── Wallet Transactions gần nhất ─────────────────────────
    const WalletTx = M('WalletTx');
    if (WalletTx && userId) {
      const txs = await WalletTx.find({ ownerId: userId, ownerType: 'user' })
        .sort({ createdAt: -1 }).limit(5)
        .select('type amount note createdAt status');
      ctx.recentWalletTx = txs.map(tx => ({
        type:   tx.type,
        amount: vnd(tx.amount),
        note:   tx.note || '',
        time:   timeAgo(tx.createdAt),
        status: tx.status,
      }));
    }

    // ── Support Tickets ──────────────────────────────────────
    const SupportTicket = M('SupportTicket');
    if (SupportTicket && userId) {
      const tickets = await SupportTicket.find({
        userId,
        status: { $in: ['open','in_progress'] },
      }).sort({ createdAt: -1 }).limit(3)
        .select('type status priority createdAt');
      ctx.openTickets = tickets.map(t => ({
        type:     t.type,
        status:   t.status,
        priority: t.priority,
        time:     timeAgo(t.createdAt),
      }));
    }

    ctx.userType = 'customer';
  } catch(err) {
    console.error('[CocoDb] buildUserContext error:', err.message);
  }

  return ctx;
}

// ══════════════════════════════════════════════════════════════
//  2. BUILD SHIPPER CONTEXT
// ══════════════════════════════════════════════════════════════
async function buildShipperContext(shipperId) {
  if (!shipperId) return {};
  const ctx = { userType: 'shipper' };

  try {
    const Shipper  = M('Shipper');
    const Order    = M('Order');
    const WalletTx = M('WalletTx');

    if (Shipper) {
      const s = await Shipper.findById(shipperId)
        .select('fullName phone walletBalance plan status rating todayOrders totalOrders');
      if (s) {
        ctx.name       = s.fullName;
        ctx.phone      = s.phone;
        ctx.earnings   = s.walletBalance || 0;
        ctx.plan       = s.plan;
        ctx.status     = s.status;
        ctx.rating     = s.rating;
        ctx.todayOrders= s.todayOrders || 0;
        ctx.totalOrders= s.totalOrders || 0;
      }
    }

    if (Order && shipperId) {
      // Đơn đang giao
      const active = await Order.find({
        shipperId,
        status: { $in: ['shipper_accepted','picking_up','at_partner','picked_up','delivering'] },
      }).limit(3).select('orderId module status address finalTotal createdAt');
      ctx.activeDeliveries = active.map(o => ({
        orderId: o.orderId,
        module:  MODULE_VI[o.module] || o.module,
        status:  statusVi(o.status),
        address: o.address,
        total:   vnd(o.finalTotal),
        time:    timeAgo(o.createdAt),
      }));

      // Đơn hôm nay
      const today = new Date(); today.setHours(0,0,0,0);
      const todayOrders = await Order.countDocuments({ shipperId, createdAt: { $gte: today } });
      ctx.todayOrdersReal = todayOrders;
    }

    if (WalletTx && shipperId) {
      const txs = await WalletTx.find({ ownerId: shipperId, ownerType: 'shipper' })
        .sort({ createdAt: -1 }).limit(5)
        .select('type amount note createdAt');
      ctx.recentWalletTx = txs.map(tx => ({
        type:   tx.type,
        amount: vnd(tx.amount),
        note:   tx.note || '',
        time:   timeAgo(tx.createdAt),
      }));
    }
  } catch(err) {
    console.error('[CocoDb] buildShipperContext error:', err.message);
  }

  return ctx;
}

// ══════════════════════════════════════════════════════════════
//  3. BUILD ADMIN / NOVA CONTEXT — business intelligence
// ══════════════════════════════════════════════════════════════
async function buildAdminContext() {
  const ctx = {};

  try {
    const Order  = M('Order');
    const User   = M('User');
    const Shipper= M('Shipper');

    const today = new Date(); today.setHours(0,0,0,0);
    const week  = new Date(Date.now() - 7*24*3600*1000);

    if (Order) {
      const [
        totalOrders, todayOrders, pendingOrders, deliveringOrders,
        todayRevAgg, weekRevAgg,
        cancelledToday,
      ] = await Promise.all([
        Order.countDocuments(),
        Order.countDocuments({ createdAt: { $gte: today } }),
        Order.countDocuments({ status: 'pending' }),
        Order.countDocuments({ status: { $in: ['delivering','picking_up','at_partner'] } }),
        Order.aggregate([
          { $match: { createdAt: { $gte: today }, status: { $ne: 'cancelled' } } },
          { $group: { _id: null, total: { $sum: '$finalTotal' } } },
        ]),
        Order.aggregate([
          { $match: { createdAt: { $gte: week }, status: { $ne: 'cancelled' } } },
          { $group: { _id: null, total: { $sum: '$finalTotal' } } },
        ]),
        Order.countDocuments({ createdAt: { $gte: today }, status: 'cancelled' }),
      ]);

      ctx.orders = {
        total:      totalOrders,
        today:      todayOrders,
        pending:    pendingOrders,
        delivering: deliveringOrders,
        cancelledToday,
        revenueToday: vnd(todayRevAgg[0]?.total || 0),
        revenueWeek:  vnd(weekRevAgg[0]?.total || 0),
      };

      // Phân tích theo module hôm nay
      const byModule = await Order.aggregate([
        { $match: { createdAt: { $gte: today } } },
        { $group: { _id: '$module', count: { $sum: 1 }, revenue: { $sum: '$finalTotal' } } },
      ]);
      ctx.todayByModule = byModule.map(m => ({
        module: MODULE_VI[m._id] || m._id,
        count:  m.count,
        revenue: vnd(m.revenue),
      }));
    }

    if (User)    ctx.totalUsers    = await User.countDocuments();
    if (Shipper) ctx.activeShippers= await Shipper.countDocuments({ status: 'active' });

    // SLA: đơn pending > 15 phút
    if (Order) {
      const slaBreach = await Order.countDocuments({
        status: 'pending',
        createdAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) },
      });
      ctx.slaBreachCount = slaBreach;
    }

  } catch(err) {
    console.error('[CocoDb] buildAdminContext error:', err.message);
  }

  return ctx;
}

// ══════════════════════════════════════════════════════════════
//  4. QUERY ORDER — tra cứu đơn cụ thể (có kiểm tra ownership)
// ══════════════════════════════════════════════════════════════
async function queryOrder(orderId, userId = null) {
  const Order = M('Order');
  if (!Order) return null;

  try {
    const filter = { orderId };
    if (userId) filter.customerId = userId; // chỉ xem đơn của mình

    const o = await Order.findOne(filter)
      .select('orderId module status finalTotal total shipFee discount items address district createdAt confirmedAt deliveredAt cancelReason paymentMethod paymentStatus statusHistory note chatMessages ratingShipper ratingPartner voucherCode voucherDiscount');

    if (!o) return null;

    return {
      orderId:       o.orderId,
      module:        MODULE_VI[o.module] || o.module,
      status:        statusVi(o.status),
      statusRaw:     o.status,
      items:         o.items?.map(i => `${i.name} x${i.qty} (${vnd(i.price)})`).join('\n') || '',
      address:       o.address,
      district:      o.district,
      total:         vnd(o.total),
      shipFee:       vnd(o.shipFee),
      discount:      vnd(o.discount),
      voucherDiscount: vnd(o.voucherDiscount),
      finalTotal:    vnd(o.finalTotal || o.total),
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus === 'paid' ? '✅ Đã thanh toán' : '⏳ Chưa thanh toán',
      note:          o.note || '',
      cancelReason:  o.cancelReason || null,
      createdAt:     o.createdAt ? new Date(o.createdAt).toLocaleString('vi-VN') : '?',
      deliveredAt:   o.deliveredAt ? new Date(o.deliveredAt).toLocaleString('vi-VN') : null,
      statusHistory: o.statusHistory?.slice(-5).map(h => `${statusVi(h.status)} — ${timeAgo(h.time)}`).join('\n') || '',
      rated:         !!(o.ratingShipper || o.ratingPartner),
    };
  } catch(err) {
    console.error('[CocoDb] queryOrder error:', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  5. SEARCH ORDERS — tìm đơn theo từ khóa / filter
// ══════════════════════════════════════════════════════════════
async function searchOrders(userId, filter = {}) {
  const Order = M('Order');
  if (!Order || !userId) return [];

  try {
    const query = { customerId: userId };
    if (filter.status)  query.status = filter.status;
    if (filter.module)  query.module = filter.module;

    const orders = await Order.find(query)
      .sort({ createdAt: -1 }).limit(filter.limit || 10)
      .select('orderId module status finalTotal items address createdAt deliveredAt');

    return orders.map(o => ({
      orderId:    o.orderId,
      module:     MODULE_VI[o.module] || o.module,
      status:     statusVi(o.status),
      total:      vnd(o.finalTotal),
      items:      o.items?.map(i => i.name).join(', ') || '',
      time:       timeAgo(o.createdAt),
    }));
  } catch(err) {
    console.error('[CocoDb] searchOrders error:', err.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
//  6. BUILD CONTEXT STRING — chuyển context thành text cho AI
// ══════════════════════════════════════════════════════════════
function buildContextString(ctx) {
  if (!ctx || !Object.keys(ctx).length) return '';

  const lines = ['[DỮ LIỆU THẬT CỦA NGƯỜI DÙNG]'];

  if (ctx.name)        lines.push(`• Tên: ${ctx.name}`);
  if (ctx.phone)       lines.push(`• SĐT: ${ctx.phone}`);
  if (ctx.walletBal !== undefined) lines.push(`• Số dư ví: ${vnd(ctx.walletBal)}`);
  if (ctx.loyaltyPts !== undefined) lines.push(`• Điểm tích lũy: ${ctx.loyaltyPts} điểm`);
  if (ctx.totalOrders) lines.push(`• Tổng đơn đã đặt: ${ctx.totalOrders} đơn`);
  if (ctx.totalSpent)  lines.push(`• Tổng chi tiêu: ${vnd(ctx.totalSpent)}`);

  // BNPL
  if (ctx.bnplLimit !== undefined) lines.push(`• Hạn mức Ví Trả Sau: ${vnd(ctx.bnplLimit)}`);
  if (ctx.bnplUsed)    lines.push(`• Đã dùng Trả Sau tháng này: ${vnd(ctx.bnplUsed)}`);
  if (ctx.unpaidInvoices?.length) {
    lines.push(`• ⚠️ ${ctx.unpaidInvoices.length} hóa đơn Trả Sau chưa trả:`);
    ctx.unpaidInvoices.forEach(inv =>
      lines.push(`  - ${inv.billingMonth}: ${inv.amount} — hạn ${inv.dueDate} (${inv.status})`)
    );
  }

  // Loan
  if (ctx.activeLoan) {
    lines.push(`• Khoản vay đang active: ${ctx.activeLoan.amount} (còn: ${ctx.activeLoan.remaining}) — hạn ${ctx.activeLoan.dueAt}`);
  }

  // Active orders
  if (ctx.activeOrders?.length) {
    lines.push(`\n[ĐƠN ĐANG XỬ LÝ]`);
    ctx.activeOrders.forEach(o =>
      lines.push(`• ${o.orderId}: ${o.module} — ${o.status} — ${o.total} (${o.time})`)
    );
  }

  // Recent orders
  if (ctx.recentOrders?.length) {
    lines.push(`\n[LỊCH SỬ ĐƠN GẦN NHẤT]`);
    ctx.recentOrders.slice(0,3).forEach(o => {
      let line = `• ${o.orderId}: ${o.module} — ${o.status} — ${o.total} (${o.time})`;
      if (o.items)        line += `\n  Món: ${o.items}`;
      if (o.cancelReason) line += `\n  Lý do huỷ: ${o.cancelReason}`;
      lines.push(line);
    });
  }

  // Wallet tx
  if (ctx.recentWalletTx?.length) {
    lines.push(`\n[GIAO DỊCH VÍ GẦN ĐÂY]`);
    ctx.recentWalletTx.forEach(tx =>
      lines.push(`• ${tx.type === 'credit' ? '➕' : '➖'} ${tx.amount} — ${tx.note} (${tx.time})`)
    );
  }

  // Open tickets
  if (ctx.openTickets?.length) {
    lines.push(`\n[TICKET HỖ TRỢ ĐANG MỞ]`);
    ctx.openTickets.forEach(t =>
      lines.push(`• ${t.type} — ${t.status} — ${t.priority} priority (${t.time})`)
    );
  }

  // Shipper context
  if (ctx.userType === 'shipper') {
    lines.push(`\n[SHIPPER INFO]`);
    if (ctx.plan)          lines.push(`• Gói: ${ctx.plan}`);
    if (ctx.rating)        lines.push(`• Rating: ${ctx.rating}⭐`);
    if (ctx.todayOrdersReal !== undefined) lines.push(`• Đơn hôm nay: ${ctx.todayOrdersReal}`);
    if (ctx.earnings !== undefined) lines.push(`• Ví shipper: ${vnd(ctx.earnings)}`);
    if (ctx.activeDeliveries?.length) {
      lines.push(`• Đang giao ${ctx.activeDeliveries.length} đơn:`);
      ctx.activeDeliveries.forEach(d => lines.push(`  - ${d.orderId}: ${d.status} — ${d.address}`));
    }
  }

  // Admin context
  if (ctx.orders) {
    lines.push(`\n[NOVA ADMIN METRICS]`);
    lines.push(`• Đơn hôm nay: ${ctx.orders.today} (huỷ: ${ctx.orders.cancelledToday})`);
    lines.push(`• Đang xử lý: ${ctx.orders.pending} pending, ${ctx.orders.delivering} đang giao`);
    lines.push(`• Doanh thu hôm nay: ${ctx.orders.revenueToday}`);
    lines.push(`• Doanh thu 7 ngày: ${ctx.orders.revenueWeek}`);
    if (ctx.slaBreachCount) lines.push(`• ⚠️ SLA breach: ${ctx.slaBreachCount} đơn pending > 15 phút`);
    if (ctx.todayByModule?.length) {
      lines.push(`• Theo dịch vụ: ${ctx.todayByModule.map(m => `${m.module}:${m.count}`).join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  7. DETECT INTENT — nhận diện user đang hỏi gì để query đúng
// ══════════════════════════════════════════════════════════════
function detectDbIntent(text) {
  const t = text.toLowerCase();

  // Tra cứu đơn hàng cụ thể
  const orderIdMatch = text.match(/ORD-[A-Z0-9-]+/i);
  if (orderIdMatch) return { intent: 'lookup_order', orderId: orderIdMatch[0].toUpperCase() };

  // Xem đơn đang giao
  if (/đơn.*đang|đang.*giao|giao hàng.*đâu|ship.*đâu|đơn.*nào.*đang|tracking|theo dõi.*đơn/.test(t))
    return { intent: 'active_orders' };

  // Lịch sử đơn
  if (/lịch sử.*đơn|đơn.*cũ|đơn.*trước|đã.*đặt|xem.*đơn|đơn.*hàng.*của|bao nhiêu.*đơn/.test(t))
    return { intent: 'order_history' };

  // Đơn bị huỷ
  if (/đơn.*huỷ|huỷ.*đơn|cancelled/.test(t))
    return { intent: 'cancelled_orders' };

  // Ví tiền
  if (/số dư|ví.*tiền|tiền.*ví|ví.*bao nhiêu|còn.*bao nhiêu.*tiền|nạp tiền|rút tiền/.test(t))
    return { intent: 'wallet' };

  // Giao dịch ví
  if (/giao dịch|lịch sử.*ví|ví.*lịch sử|thanh toán.*gần/.test(t))
    return { intent: 'wallet_tx' };

  // Điểm tích lũy
  if (/điểm|loyalty|tích lũy|điểm thưởng|đổi điểm/.test(t))
    return { intent: 'loyalty' };

  // BNPL
  if (/trả sau|bnpl|hóa đơn|công nợ|hạn mức|nợ/.test(t))
    return { intent: 'bnpl' };

  // Vay
  if (/vay|khoản vay|loan|trả góp|lãi suất/.test(t))
    return { intent: 'loan' };

  // Ticket
  if (/khiếu nại|ticket|support|hỗ trợ.*đang|đang.*xử lý/.test(t))
    return { intent: 'tickets' };

  return { intent: 'general' };
}

// ══════════════════════════════════════════════════════════════
//  8. SMART QUERY — auto query đúng data theo intent
// ══════════════════════════════════════════════════════════════
async function smartQuery(text, userId) {
  const { intent, orderId } = detectDbIntent(text);
  const Order = M('Order');
  let extra = '';

  try {
    switch(intent) {
      case 'lookup_order': {
        if (orderId) {
          const o = await queryOrder(orderId, userId);
          if (o) {
            extra = `\n[CHI TIẾT ĐƠN ${o.orderId}]\n`;
            extra += `• Dịch vụ: ${o.module}\n`;
            extra += `• Trạng thái: ${o.status}\n`;
            extra += `• Sản phẩm:\n${o.items}\n`;
            extra += `• Địa chỉ: ${o.address}\n`;
            extra += `• Tổng tiền: ${o.finalTotal} (ship: ${o.shipFee})\n`;
            extra += `• Thanh toán: ${o.paymentMethod} — ${o.paymentStatus}\n`;
            if (o.note) extra += `• Ghi chú: ${o.note}\n`;
            if (o.cancelReason) extra += `• Lý do huỷ: ${o.cancelReason}\n`;
            extra += `• Đặt lúc: ${o.createdAt}\n`;
            if (o.statusHistory) extra += `• Lịch sử trạng thái:\n${o.statusHistory}`;
          } else {
            extra = `\n[Không tìm thấy đơn ${orderId} cho user này]`;
          }
        }
        break;
      }

      case 'active_orders': {
        if (Order && userId) {
          const activeStatuses = ['pending','confirmed','preparing','shipper_accepted','picking_up','at_partner','picked_up','delivering','finding_driver','partner_accepted','ready'];
          const actives = await Order.find({ customerId: userId, status: { $in: activeStatuses } })
            .sort({ createdAt: -1 }).limit(5)
            .select('orderId module status address finalTotal createdAt');
          if (actives.length) {
            extra = `\n[ĐƠN ĐANG XỬ LÝ — ${actives.length} đơn]\n`;
            actives.forEach(o => {
              extra += `• ${o.orderId}: ${MODULE_VI[o.module]||o.module} — ${statusVi(o.status)} — ${vnd(o.finalTotal)} — ${timeAgo(o.createdAt)}\n`;
              extra += `  Địa chỉ: ${o.address}\n`;
            });
          } else {
            extra = '\n[Không có đơn nào đang xử lý]';
          }
        }
        break;
      }

      case 'cancelled_orders': {
        const cancelled = await searchOrders(userId, { status: 'cancelled', limit: 5 });
        if (cancelled.length) {
          extra = `\n[ĐƠN ĐÃ HUỶ]\n` + cancelled.map(o => `• ${o.orderId}: ${o.module} — ${o.total} — ${o.time}`).join('\n');
        } else {
          extra = '\n[Không có đơn huỷ nào]';
        }
        break;
      }

      default:
        break;
    }
  } catch(err) {
    console.error('[CocoDb] smartQuery error:', err.message);
  }

  return { intent, extra };
}

// ══════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════
module.exports = {
  buildUserContext,
  buildShipperContext,
  buildAdminContext,
  buildContextString,
  queryOrder,
  searchOrders,
  smartQuery,
  detectDbIntent,
};
