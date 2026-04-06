/**
 * COCO AI ENGINE — Não của CRABOR AI Agent
 * Không dùng API ngoài. Tự học, tự nhớ, tự suy luận.
 *
 * Kiến trúc:
 *   1. Knowledge Base (MongoDB) — não dài hạn
 *   2. Session Memory (RAM) — ký ức ngắn hạn mỗi cuộc trò chuyện
 *   3. NLU Pipeline — hiểu ngôn ngữ
 *   4. Tool System — Coco có thể hành động
 *   5. Auto-Learn — tự học từ mọi cuộc trò chuyện
 */

const mongoose  = require('mongoose');
const axios     = require('axios');
const cheerio   = require('cheerio');

// ══════════════════════════════════════════════════════════════
//  SCHEMAS — Não của Coco
// ══════════════════════════════════════════════════════════════

// Mỗi "knowledge entry" là 1 điều Coco biết
const cocoKnowledgeSchema = new mongoose.Schema({
  category:   { type: String, required: true, index: true },   // 'faq','policy','product','user','web'
  intent:     { type: String, required: true, index: true },   // 'ask_balance','ask_order','ask_founder'...
  keywords:   [{ type: String, lowercase: true }],             // từ khoá trigger
  patterns:   [{ type: String }],                              // regex patterns
  answer:     { type: String, required: true },                // câu trả lời template
  answerVars: [{ type: String }],                              // {balance}, {name}, {order_id}...
  source:     { type: String },                                // 'manual','web','conversation','document'
  sourceUrl:  { type: String },
  confidence: { type: Number, default: 1.0, min:0, max:1 },   // độ tin cậy
  useCount:   { type: Number, default: 0 },                   // số lần dùng
  helpful:    { type: Number, default: 0 },                   // feedback tốt
  notHelpful: { type: Number, default: 0 },                   // feedback xấu
  active:     { type: Boolean, default: true },
  language:   { type: String, default: 'vi' },
}, { timestamps: true });
cocoKnowledgeSchema.index({ keywords: 1 });
cocoKnowledgeSchema.index({ '$**': 'text' }); // full-text search

// Ký ức cuộc trò chuyện — Coco nhớ context
const cocoMemorySchema = new mongoose.Schema({
  sessionId:   { type: String, required: true, index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId },
  messages:    [{
    role:      { type: String, enum: ['user','coco'] },
    text:      String,
    intent:    String,
    entities:  mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now },
  }],
  context:     { type: mongoose.Schema.Types.Mixed, default: {} }, // entities đang track
  turnCount:   { type: Number, default: 0 },
  resolved:    { type: Boolean, default: false },
  lastActive:  { type: Date, default: Date.now },
}, { timestamps: true });

// Log học hỏi — mọi thứ Coco đã học
const cocoLearnLogSchema = new mongoose.Schema({
  type:       { type: String, enum: ['web','document','conversation','manual','feedback'] },
  source:     String,
  content:    String,
  extracted:  [{ intent: String, answer: String, keywords: [String] }],
  knowledgeIds: [mongoose.Schema.Types.ObjectId],
  status:     { type: String, enum: ['pending','processed','failed'], default: 'pending' },
}, { timestamps: true });

// Export schemas để main server dùng
const CocoKnowledge = mongoose.model('CocoKnowledge', cocoKnowledgeSchema);
const CocoMemory    = mongoose.model('CocoMemory',    cocoMemorySchema);
const CocoLearnLog  = mongoose.model('CocoLearnLog',  cocoLearnLogSchema);

// ══════════════════════════════════════════════════════════════
//  NLU — Coco hiểu ngôn ngữ
// ══════════════════════════════════════════════════════════════

// Tokenize tiếng Việt (đơn giản — split + normalize)
function tokenize(text) {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[.,!?;:"'()[\]{}<>]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// Tính độ tương đồng (Jaccard + keyword overlap)
function similarity(textA, textB) {
  const a = new Set(tokenize(textA));
  const b = new Set(tokenize(textB));
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// Extract entities từ tin nhắn
function extractEntities(text) {
  const entities = {};
  // Số điện thoại
  const phoneMatch = text.match(/0[0-9]{9}/);
  if (phoneMatch) entities.phone = phoneMatch[0];
  // Số tiền
  const moneyMatch = text.match(/(\d{1,3}(?:[.,]\d{3})*)\s*(?:đ|vnd|vnđ|triệu|k)/i);
  if (moneyMatch) entities.money = moneyMatch[0];
  // Order ID
  const orderMatch = text.match(/[A-Z]{2}[0-9]{6,10}|đơn\s+#?\s*([A-Z0-9]+)/i);
  if (orderMatch) entities.orderId = orderMatch[0];
  // Email
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) entities.email = emailMatch[0];
  // Tên người
  const nameMatch = text.match(/(?:tên|gọi|là)\s+([A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼỀỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸ][a-zàáâãèéêìíòóôõùúăđĩũơưạảấầẩẫậắằẳẵặẹẻẽềềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+(?:\s+[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼỀỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸ][a-zàáâãèéêìíòóôõùúăđĩũơưạảấầẩẫậắằẳẵặẹẻẽềềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+)*)/i);
  if (nameMatch) entities.name = nameMatch[1];
  return entities;
}

// Intent detection — tìm ý định người dùng
const INTENT_RULES = [
  // Tài khoản cá nhân
  { intent:'ask_balance',       patterns:[/số dư|ví.*bao nhiêu|còn.*tiền|balance/i] },
  { intent:'ask_order',         patterns:[/đơn.*(?:nào|của tôi|mới nhất|gần đây)|xem đơn|track.*đơn/i] },
  { intent:'ask_points',        patterns:[/điểm.*tích lũy|loyalty|bao nhiêu.*điểm/i] },
  { intent:'ask_bnpl',          patterns:[/trả sau|hóa đơn.*trả|bnpl|hạn mức.*trả/i] },
  { intent:'ask_loan',          patterns:[/vay.*tiền|khoản.*vay|loan/i] },
  // Hỗ trợ
  { intent:'complaint_order',   patterns:[/đơn.*sai|đồ ăn.*không đúng|không.*nhận được|shipper.*không|khiếu nại/i] },
  { intent:'complaint_payment', patterns:[/thanh toán.*lỗi|tiền.*bị trừ|không.*hoàn tiền/i] },
  { intent:'request_refund',    patterns:[/hoàn tiền|refund|hủy.*đơn|trả lại tiền/i] },
  { intent:'ask_delivery',      patterns:[/shipper.*ở đâu|đơn.*đang đâu|tracking|theo dõi.*đơn/i] },
  // Thông tin chung
  { intent:'ask_founder',       patterns:[/ai.*làm|ai.*tạo|người sáng lập|founder|kiều thanh hải|câu chuyện|hành trình/i] },
  { intent:'ask_service',       patterns:[/dịch vụ.*gì|crabor.*làm gì|app.*gì/i] },
  { intent:'ask_register',      patterns:[/đăng ký|register|trở thành shipper|làm đối tác/i] },
  { intent:'ask_fee',           patterns:[/phí.*bao nhiêu|giá.*đăng ký|500k|700k/i] },
  // Chào hỏi / kết thúc
  { intent:'greeting',          patterns:[/^(?:xin chào|hello|hi|chào|hey)\b/i] },
  { intent:'farewell',          patterns:[/tạm biệt|bye|cảm ơn|thank|xong rồi/i] },
  { intent:'thanks',            patterns:[/cảm ơn|thanks|hay quá|tốt quá|ổn rồi/i] },
  // Coco's identity
  { intent:'ask_coco_identity', patterns:[/bạn là ai|coco là ai|ai trả lời|chatbot không|người thật không|có phải ai không/i] },
];

function detectIntent(text) {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some(p => p.test(text))) {
      return rule.intent;
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  KNOWLEDGE RETRIEVAL — Coco tìm câu trả lời
// ══════════════════════════════════════════════════════════════

async function searchKnowledge(query, intent = null) {
  const tokens = tokenize(query);
  if (!tokens.length) return null;

  // 1. Ưu tiên: tìm theo intent
  if (intent) {
    const byIntent = await CocoKnowledge.findOne({ intent, active: true })
      .sort({ confidence: -1, useCount: -1 });
    if (byIntent) return byIntent;
  }

  // 2. Tìm theo keywords match
  const byKeyword = await CocoKnowledge.find({
    keywords: { $in: tokens },
    active: true,
  }).sort({ confidence: -1, useCount: -1 }).limit(5);

  if (byKeyword.length > 0) {
    // Rank theo số keyword trùng
    const ranked = byKeyword.map(k => ({
      doc: k,
      score: k.keywords.filter(kw => tokens.includes(kw)).length / k.keywords.length,
    })).sort((a, b) => b.score - a.score);
    if (ranked[0].score > 0.2) return ranked[0].doc;
  }

  // 3. Full-text search fallback
  const byText = await CocoKnowledge.find(
    { $text: { $search: query }, active: true },
    { score: { $meta: 'textScore' } }
  ).sort({ score: { $meta: 'textScore' } }).limit(3);

  return byText[0] || null;
}

// Fill template với variables
function fillTemplate(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (vars[key] !== undefined) {
      const val = vars[key];
      if (typeof val === 'number') return val.toLocaleString('vi-VN');
      return String(val);
    }
    return match; // giữ nguyên nếu không có var
  });
}

// ══════════════════════════════════════════════════════════════
//  TOOLS — Coco có thể làm gì
// ══════════════════════════════════════════════════════════════

const CocoTools = {

  // Tool: đọc website và học
  async webFetch(url) {
    try {
      const r = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'CRABOR-Coco/1.0' },
      });
      const $ = cheerio.load(r.data);
      // Xóa script, style, nav
      $('script,style,nav,footer,header,aside').remove();
      const title = $('title').text().trim();
      const h1    = $('h1').first().text().trim();
      // Lấy text từ main content
      const content = $('article,main,.content,body').first().text()
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 3000);
      return { success: true, title, h1, content, url };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // Tool: phân tích văn bản và tách knowledge
  extractKnowledge(text, source = 'document') {
    const lines = text.split(/[.!?\n]+/).filter(l => l.trim().length > 20);
    const extracted = [];
    for (const line of lines.slice(0, 50)) { // max 50 facts
      const clean = line.trim();
      if (clean.length < 15) continue;
      const kws = tokenize(clean).filter(t => t.length > 3).slice(0, 8);
      if (kws.length < 2) continue;
      extracted.push({
        answer:   clean,
        keywords: kws,
        intent:   'general',
        source,
        confidence: 0.6,
      });
    }
    return extracted;
  },

  // Tool: lưu knowledge mới vào brain
  async learnFact({ intent, keywords, answer, source = 'manual', confidence = 0.9, category = 'faq' }) {
    // Check duplicate
    const existing = await CocoKnowledge.findOne({ intent, answer: { $regex: answer.substring(0, 30), $options: 'i' } });
    if (existing) {
      await CocoKnowledge.findByIdAndUpdate(existing._id, {
        $addToSet: { keywords: { $each: keywords } },
        $max:      { confidence },
      });
      return { updated: true, id: existing._id };
    }
    const doc = await CocoKnowledge.create({ intent, keywords, answer, source, confidence, category, active: true });
    return { created: true, id: doc._id };
  },

  // Tool: lấy context user
  async getUserContext(userId, User, WalletTx, BNPLInvoice, Loan) {
    if (!userId) return {};
    try {
      const user = await User.findById(userId).select('fullName phone totalSpent loyaltyPts walletBalance');
      if (!user) return {};
      return {
        name:        user.fullName || 'bạn',
        phone:       user.phone,
        totalSpent:  user.totalSpent || 0,
        loyaltyPts:  user.loyaltyPts || 0,
        walletBal:   user.walletBalance || 0,
      };
    } catch (e) { return {}; }
  },
};

// ══════════════════════════════════════════════════════════════
//  COCO BRAIN — Response generator
// ══════════════════════════════════════════════════════════════

// Coco trả lời dựa trên knowledge + context
async function cocoRespond({ text, sessionId, userId, userCtx = {} }) {
  const intent  = detectIntent(text);
  const entities = extractEntities(text);

  // Merge entities vào context
  const allVars = { ...userCtx, ...entities };

  // ── Built-in responses — những thứ Coco LUÔN biết ──
  if (intent === 'greeting') {
    const name = userCtx.name && userCtx.name !== 'bạn' ? userCtx.name : '';
    return {
      text:   name
        ? `Dạ, CRABOR xin nghe! Em là Coco${name ? `, ${name}` : ''} 😊 Anh/chị cần hỗ trợ gì ạ?`
        : `Dạ, CRABOR xin nghe! Em là Coco, trợ lý của CRABOR 🦀 Anh/chị cần hỗ trợ gì ạ?`,
      intent, learned: false,
    };
  }

  if (intent === 'farewell' || intent === 'thanks') {
    return {
      text: `Cảm ơn anh/chị đã liên hệ CRABOR! Chúc anh/chị một ngày thật vui 🦀 Coco luôn ở đây nếu cần nhé!`,
      intent, learned: false,
    };
  }

  if (intent === 'ask_coco_identity') {
    return {
      text: `Em là **Coco** — trợ lý AI của CRABOR 🦀\n\nEm không phải chatbot thông thường — em tự học từ mọi cuộc trò chuyện, đọc được tài liệu, và nhớ thông tin tài khoản của anh/chị.\n\nEm được xây dựng hoàn toàn nội bộ bởi đội CRABOR — không dùng AI ngoài 💪`,
      intent, learned: false,
    };
  }

  // ── Account-specific — cần userId ──
  if (intent === 'ask_balance') {
    if (userCtx.walletBal !== undefined) {
      return { text:`💳 Số dư ví của ${userCtx.name||'anh/chị'}: **${(userCtx.walletBal||0).toLocaleString('vi-VN')}đ**\n\nĐiểm tích lũy: ⭐ ${userCtx.loyaltyPts||0} điểm`, intent, learned: false };
    }
    return { text:'Anh/chị cần đăng nhập để em kiểm tra số dư ạ 🙏', intent, learned: false };
  }

  if (intent === 'ask_points') {
    if (userCtx.loyaltyPts !== undefined) {
      return { text:`⭐ Anh/chị đang có **${userCtx.loyaltyPts||0} điểm** tích lũy\n\n50 điểm = voucher 10.000đ\nTổng chi tiêu: ${(userCtx.totalSpent||0).toLocaleString('vi-VN')}đ`, intent, learned: false };
    }
    return { text:'Đăng nhập để xem điểm tích lũy nhé anh/chị 🙏', intent, learned: false };
  }

  // ── Search knowledge base ──
  const knowledge = await searchKnowledge(text, intent);
  if (knowledge) {
    await CocoKnowledge.findByIdAndUpdate(knowledge._id, { $inc: { useCount: 1 } });
    const answer = fillTemplate(knowledge.answer, allVars);
    return { text: answer, intent, knowledgeId: knowledge._id, learned: false, confidence: knowledge.confidence };
  }

  // ── Không biết — học từ đây ──
  await CocoLearnLog.create({
    type: 'conversation',
    source: 'unanswered',
    content: text,
    status: 'pending',
  });

  return {
    text: `Em chưa có đủ thông tin để trả lời câu này 🙏\n\nEm đã ghi nhận để tự học thêm. Anh/chị có thể:\n• Hỏi lại bằng từ khóa khác\n• Gửi email support@crabor.vn\n• Nhấn 📞 để nói chuyện với Coco trực tiếp`,
    intent: 'unknown',
    learned: true,
    confidence: 0,
  };
}

// ══════════════════════════════════════════════════════════════
//  AUTO-LEARN — Coco tự học định kỳ
// ══════════════════════════════════════════════════════════════

async function processLearnQueue() {
  const pending = await CocoLearnLog.find({ status: 'pending', type: 'web' }).limit(5);
  for (const log of pending) {
    try {
      const fetched = await CocoTools.webFetch(log.source);
      if (fetched.success) {
        const extracted = CocoTools.extractKnowledge(fetched.content, 'web:' + log.source);
        const ids = [];
        for (const fact of extracted.slice(0, 10)) {
          const r = await CocoTools.learnFact({ ...fact, confidence: 0.6 });
          if (r.created || r.updated) ids.push(r.id);
        }
        await CocoLearnLog.findByIdAndUpdate(log._id, {
          status: 'processed',
          extracted: extracted.slice(0, 10),
          knowledgeIds: ids,
        });
      }
    } catch (e) {
      await CocoLearnLog.findByIdAndUpdate(log._id, { status: 'failed' });
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  SEED — Kiến thức ban đầu của Coco
// ══════════════════════════════════════════════════════════════

async function seedCocoKnowledge() {
  const count = await CocoKnowledge.countDocuments();
  if (count > 0) return; // đã có data

  const seeds = [
    // CRABOR info
    { category:'faq', intent:'ask_service', confidence:1.0,
      keywords:['crabor','là gì','app gì','dịch vụ'],
      answer:'🦀 CRABOR là super app All-in-One tại Hà Nội: 🍜 Giao đồ ăn · 👕 Giặt là · 🧹 Giúp việc · 🛍️ China Shop · 🚗 Xe công nghệ. Ra mắt T7/2025!' },

    // Founder
    { category:'faq', intent:'ask_founder', confidence:1.0,
      keywords:['sáng lập','founder','kiều thanh hải','ai làm','ai tạo','câu chuyện','hành trình'],
      answer:'👨‍💻 CRABOR được sáng lập bởi **Kiều Thanh Hải** — sinh viên năm 2 Logistics, Đại học Đại Nam, Hà Nội.\n\n🚀 20 tuổi · tự học code từ 0 · 3tr/tháng · không nhà đầu tư · một mình xây 21.000+ dòng code.\n\n💬 "Tôi muốn xây ứng dụng mà mọi người Hà Nội đều muốn có." — Kiều Thanh Hải' },

    // Shipper
    { category:'faq', intent:'ask_register_shipper', confidence:1.0,
      keywords:['đăng ký shipper','shipper','early bird','phí 500','phí 700'],
      answer:'🛵 Đăng ký Shipper:\n1. Vào /register → chọn Shipper\n2. Upload giấy tờ\n3. Thanh toán phí → tự động duyệt\n\n💰 Early Bird: 500.000đ (hoàn sau 1.000 đơn) · Standard: 700.000đ\nNhận 85% phí giao mỗi đơn!' },

    // Partner
    { category:'faq', intent:'ask_register_partner', confidence:1.0,
      keywords:['đối tác','nhà hàng','đăng ký đối tác','hoa hồng','18%','20%'],
      answer:'🤝 Đăng ký đối tác CRABOR:\n✅ Miễn phí · Duyệt trong 1 giờ\n📊 Hoa hồng 18–20%/đơn\n📱 Dashboard quản lý realtime\n\nVào /register → chọn loại đối tác!' },

    // Chính sách hoàn tiền
    { category:'policy', intent:'request_refund', confidence:1.0,
      keywords:['hoàn tiền','refund','hủy đơn','trả tiền'],
      answer:'💰 Chính sách hoàn tiền:\n✅ Hủy trước shipper nhận: Hoàn 100%\n✅ Đồ ăn/dịch vụ sai: Hoàn 100%\n✅ Shipper không giao được: Hoàn 100%\n⚠️ Hủy sau khi shipper nhận: Phí 15.000đ\n\nGửi email support@crabor.vn để được hỗ trợ nhanh nhất!' },

    // Điều khoản
    { category:'policy', intent:'ask_terms', confidence:1.0,
      keywords:['điều khoản','terms','pháp lý','quy định','thoả thuận'],
      answer:'📜 Điều khoản CRABOR:\n👤 Người dùng cung cấp thông tin trung thực\n🛵 Shipper có bằng lái hợp lệ\n🤝 Đối tác đảm bảo chất lượng sản phẩm\n⚖️ CRABOR có quyền tạm khóa tài khoản vi phạm' },

    // Bảo mật
    { category:'policy', intent:'ask_privacy', confidence:1.0,
      keywords:['bảo mật','privacy','dữ liệu','thông tin cá nhân'],
      answer:'🔒 Bảo mật CRABOR:\n✅ Mã hoá dữ liệu\n✅ Không bán thông tin người dùng\n✅ OTP hết hạn 5 phút\n✅ Tuân thủ Luật An ninh mạng Việt Nam' },

    // Ví trả sau
    { category:'product', intent:'ask_bnpl', confidence:1.0,
      keywords:['ví trả sau','trả sau','bnpl','hạn mức','mua trước'],
      answer:'💳 Ví Trả Sau CRABOR:\n🔓 Mở khi giao dịch từ 2.000.000đ\n📅 Hóa đơn phát hành ngày 1 hàng tháng\n⏰ Hạn trả: ngày 15 cùng tháng\n⚠️ Trễ hạn: +30.000đ · Trả góp: +10%\n💳 Thanh toán qua QR SePay' },

    // Vay nhanh
    { category:'product', intent:'ask_loan', confidence:1.0,
      keywords:['vay nhanh','vay tiền','loan','1 triệu','50 triệu'],
      answer:'💵 Vay nhanh CRABOR:\n🔓 Điều kiện: giao dịch từ 2.000.000đ\n💰 Vay 1M – 50M · Lãi 1.5%/tháng\n⏱️ Xét duyệt trong 24h · Giải ngân vào ví\n📱 Đăng ký tại tab Ví → Vay nhanh' },

    // Liên hệ
    { category:'faq', intent:'ask_contact', confidence:1.0,
      keywords:['liên hệ','hotline','email','hỗ trợ','sos'],
      answer:'📞 Liên hệ CRABOR:\n🤖 Coco (Tổng đài AI) — 24/7 ngay trong app\n📧 support@crabor.vn — AI tự động phản hồi\n🚨 Nút SOS khẩn cấp trong app' },

    // CTV Sales
    { category:'product', intent:'ask_sales', confidence:1.0,
      keywords:['ctv','sales','cộng tác viên','giới thiệu','hoa hồng ctv','2000đ'],
      answer:'🎯 CTV Sales CRABOR:\n💰 +2.000đ/đơn hoàn thành qua referral\n🔗 Mã: CR + 3 ký tự + 4 số SĐT\n💳 Rút tối thiểu 50.000đ\n📱 Đăng ký tại /sales' },
  ];

  await CocoKnowledge.insertMany(seeds.map(s => ({ ...s, source: 'seed', active: true })));
  console.log(`[Coco] 🧠 Seeded ${seeds.length} knowledge entries`);
}


// ══════════════════════════════════════════════════════════════
//  COCO UPGRADES — Sentiment, Typo, Cross-session Memory
// ══════════════════════════════════════════════════════════════

// Sentiment Analysis — Coco đọc cảm xúc người dùng
function analyzeSentiment(text) {
  const t = text.toLowerCase();
  const negative = ['tệ','bực','tức','chán','sai','lỗi','không nhận','mất tiền','hoàn tiền','khiếu nại','quá lâu','không được','lừa','thất vọng','kém','dở'];
  const positive = ['cảm ơn','tốt','ổn','hay','nhanh','tuyệt','hài lòng','ok','ngon','đúng rồi','chuẩn','thích'];
  const urgent   = ['khẩn','gấp','ngay','ngay bây giờ','cần gấp','mất tiền','bị trừ','không nhận được'];

  const negCount = negative.filter(w => t.includes(w)).length;
  const posCount = positive.filter(w => t.includes(w)).length;
  const isUrgent = urgent.some(w => t.includes(w));

  if (isUrgent)       return { mood: 'urgent',   score: -1.5, emoji: '🚨' };
  if (negCount >= 2)  return { mood: 'angry',     score: -1,   emoji: '😤' };
  if (negCount === 1) return { mood: 'frustrated',score: -0.5, emoji: '😕' };
  if (posCount >= 1)  return { mood: 'positive',  score: 1,    emoji: '😊' };
  return                     { mood: 'neutral',   score: 0,    emoji: '😐' };
}

// Typo correction — xử lý lỗi gõ phím phổ biến tiếng Việt
function correctTypo(text) {
  const typos = {
    'tôi muốn hỏi': ['toi muon hoi','tôi muốn hỏi','t muốn hỏi'],
    'số dư': ['so du','sô du','số dư','số dờ'],
    'đơn hàng': ['don hang','đơn hàng','đon hang','dơn hàng'],
    'shipper': ['sipper','shippr','shiper'],
    'voucher': ['vocher','vuocher','vaucher'],
    'hoàn tiền': ['hoan tien','hoàn tiên','hoàn tiền'],
    'đăng ký': ['dang ky','đăng ki','đăng kí'],
  };
  let result = text;
  for (const [correct, variants] of Object.entries(typos)) {
    for (const v of variants) {
      result = result.replace(new RegExp(v, 'gi'), correct);
    }
  }
  return result;
}

// Cross-session memory — Coco nhớ user qua nhiều phiên
async function getUserLongTermMemory(userId) {
  if (!userId) return null;
  const mem = await CocoMemory.findOne({ userId, resolved: false })
    .sort({ lastActive: -1 })
    .select('messages context turnCount');
  if (!mem) return null;
  // Tóm tắt: lấy 3 turn cuối cùng
  const lastTurns = mem.messages.slice(-6).map(m => `${m.role}: ${m.text.substring(0,80)}`).join(' | ');
  return { lastTurns, context: mem.context, totalTurns: mem.turnCount };
}

// Smart response với sentiment-awareness
async function cocoRespondSmart({ text, sessionId, userId, userCtx = {} }) {
  // 1. Correct typos
  const cleanText = correctTypo(text);
  // 2. Analyze sentiment
  const sentiment = analyzeSentiment(cleanText);
  // 3. Get long-term memory
  const ltm = await getUserLongTermMemory(userId);

  // 4. Prepend sentiment-aware prefix nếu cần
  let prefix = '';
  if (sentiment.mood === 'urgent') {
    prefix = `🚨 Em hiểu đây là vấn đề khẩn cấp! `;
  } else if (sentiment.mood === 'angry') {
    prefix = `Em xin lỗi vì trải nghiệm này, ${userCtx.name||'anh/chị'} ơi. `;
  } else if (sentiment.mood === 'frustrated') {
    prefix = `Em hiểu cảm giác đó ạ. `;
  }

  // 5. Get base response
  const base = await cocoRespond({ text: cleanText, sessionId, userId, userCtx });

  // 6. Enrich with context
  if (ltm && ltm.lastTurns && base.intent === 'unknown') {
    base.text += `

Em thấy ${userCtx.name||'anh/chị'} đã hỏi về việc này trước đó. Cần em giải thích thêm không ạ?`;
  }

  return {
    ...base,
    text: prefix + base.text,
    sentiment,
    correctedInput: cleanText !== text ? cleanText : null,
  };
}

module.exports = {
  CocoKnowledge, CocoMemory, CocoLearnLog,
  CocoTools, cocoRespond, searchKnowledge,
  processLearnQueue, seedCocoKnowledge,
  tokenize, detectIntent, extractEntities,
  analyzeSentiment, correctTypo, getUserLongTermMemory, cocoRespondSmart,
};
