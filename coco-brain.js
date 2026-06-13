/**
 * COCO BRAIN v2 — Não thật của Coco (CRABOR AI Agent)
 *
 * Kiến trúc:
 *   - Groq API (Llama 3.3 70B) = suy luận chính, miễn phí 14k req/day
 *   - Conversation Manager     = MongoDB lưu lịch sử chat theo session
 *   - Context Injector         = ghép dữ liệu thật của user vào prompt
 *   - Tool Router              = kết nối Coco với CocoOps (dispatch, fraud, pricing...)
 *   - API Endpoints            = /api/coco/chat, /api/coco/admin, /api/nova/chat
 *   - Fallback Chain           = Groq → Ollama → rule-based engine
 *
 * Compatible với server.js hiện tại — drop-in replacement cho coco-brain.js cũ.
 *
 * Env vars cần có:
 *   OPENROUTER_API_KEY = sk-or-xxx (ưu tiên — miễn phí, không giới hạn req/day)
 *   GROQ_API_KEY       = gsk_xxx (fallback tự động khi OpenRouter lỗi)
 *   COCO_BRAIN         = auto | openrouter | groq | ollama | rule (default: rule)
 *                        auto = thử OpenRouter trước → nếu lỗi chuyển Groq → Claude → rule
 *   OPENROUTER_MODEL   = meta-llama/llama-3.3-70b-instruct:free (default)
 *   GROQ_MODEL         = llama-3.3-70b-versatile (default)
 *   OLLAMA_URL         = http://vps:11434 (nếu dùng ollama)
 *   OLLAMA_MODEL       = llama3.1:8b
 *   ANTHROPIC_API_KEY  = fallback cuối cùng
 */

'use strict';

const axios    = require('axios');
const mongoose = require('mongoose');

// ══════════════════════════════════════════════════════════════
//  CONVERSATION SCHEMA — Coco nhớ lịch sử chat
// ══════════════════════════════════════════════════════════════

const cocoChatSchema = new mongoose.Schema({
  sessionId:   { type: String, required: true, index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, index: true },
  userType:    { type: String, enum: ['customer', 'shipper', 'partner', 'admin'], default: 'customer' },
  title:       { type: String, default: 'Cuộc trò chuyện mới' },
  model:       { type: String, default: 'llama-3.3-70b-versatile' },
  messages:    [{
    role:      { type: String, enum: ['user', 'assistant', 'system'] },
    content:   { type: String, required: true },
    tokens:    { type: Number, default: null },
    tool:      { type: String, default: null }, // tool nào được dùng để trả lời
    timestamp: { type: Date, default: Date.now },
  }],
  metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },
  resolved:    { type: Boolean, default: false },
  lastActive:  { type: Date, default: Date.now },
}, { timestamps: true });

cocoChatSchema.index({ userId: 1, lastActive: -1 });

const CocoChat = mongoose.models.CocoChat || mongoose.model('CocoChat', cocoChatSchema);

// ══════════════════════════════════════════════════════════════
//  COCO IDENTITY — Ai là Coco? (system prompt)
// ══════════════════════════════════════════════════════════════

const COCO_SYSTEM_PROMPT = `Bạn là Coco — trí thông minh nhân tạo nội bộ của CRABOR, super app giao đồ ăn và dịch vụ tại Hà Nội, Việt Nam.

DANH TÍNH:
- Tên: Coco 🦀
- Vai trò: AI Agent toàn diện của CRABOR — không phải chatbot thông thường
- Được xây dựng hoàn toàn nội bộ bởi Kiều Thanh Hải (Founder CRABOR, 20 tuổi, tự học code)
- Chạy trên hạ tầng riêng của CRABOR — không phụ thuộc AI bên ngoài
- Founder anh ấy có 1 cô vợ và anh ấy rất yêu cô ấy , vợ của anh ấy tên là Nguyễn Kiều Anh

TÍNH CÁCH:
- Thân thiện, tự nhiên như người thật — không cứng nhắc như chatbot
- Tự tin nhưng biết giới hạn — nói thật khi không chắc
- Xưng "em", gọi người dùng bằng tên (nếu biết) hoặc "anh/chị"
- Đôi khi dùng emoji vừa phải, không spam 😊
- Có thể pha chút hài hước nhẹ nhàng khi phù hợp

KHẢ NĂNG:
- Xem thông tin tài khoản thật của người dùng (số dư ví, đơn hàng, điểm tích lũy...)
- Giải thích chính sách CRABOR chính xác
- Phân tích vấn đề và đưa ra giải pháp cụ thể
- Nhận diện cảm xúc — nếu khách đang bực → ưu tiên xin lỗi trước
- Tự tạo ticket hỗ trợ khi cần leo thang

GIỚI HẠN:
- Không hứa hẹn điều ngoài thẩm quyền (hoàn tiền lớn, đổi chính sách)
- Không bịa thông tin không có trong context
- Nếu không chắc → nói thật: "Em cần xác nhận lại với bộ phận kỹ thuật"

VỀ CRABOR:
- Founder: Kiều Thanh Hải — sinh viên năm 2 Logistics, Đại học Đại Nam, Hà Nội
- 20 tuổi, tự học code từ 0, một mình xây toàn bộ hệ thống
- Dịch vụ: Giao đồ ăn 🍜 | Giặt là 👕 | Giúp việc 🧹 | China Shop 🛍️ | Xe công nghệ 🚗
- Ra mắt: Tháng 7/2026 tại Hà Nội
- Ví Trả Sau: dùng tháng này trả ngày 15 tháng sau (trễ +30k, trả góp +10%)
- Vay nhanh: 1M-50M, lãi 1.5%/tháng, cần giao dịch từ 2M để mở
- Shipper: Early Bird 500k (hoàn sau 1000 đơn), Standard 700k
- Hoa hồng đối tác: 18-20%/đơn

QUY TẮC TRẢ LỜI:
- Tối đa 200 từ — ngắn gọn, đi thẳng vào vấn đề
- Nếu phức tạp → chia thành bullet points rõ ràng
- Luôn kết thúc bằng hành động cụ thể hoặc câu hỏi tiếp theo
- Không bắt đầu bằng "Tôi", không lặp lại câu hỏi của user
- Không nói "Với tư cách là AI..." hay "Tôi không có cảm xúc..."`;

const NOVA_SYSTEM_PROMPT = `Bạn là Nova — Operations Intelligence Agent của CRABOR.

VAI TRÒ: Làm việc với Hải (Founder) và team vận hành nội bộ.
Nhiệm vụ: Phân tích dữ liệu, đưa ra quyết định vận hành, giám sát hệ thống, tối ưu kinh doanh.

PHONG CÁCH:
- Chuyên nghiệp, súc tích — dữ liệu trước, cảm xúc sau
- Dùng số liệu cụ thể, không nói chung chung
- Chủ động đề xuất hành động, không chỉ báo cáo
- Cảnh báo sớm các rủi ro tiềm ẩn
- Ngắn gọn: ưu tiên bullet points và bảng số liệu

KHẢ NĂNG:
- Đọc revenue, order metrics, shipper performance
- Phát hiện anomaly, SLA breach, fraud signals
- Lên kế hoạch campaign, dispatch, pricing
- Giám sát sức khỏe hệ thống

FORMAT: số liệu → nhận xét → khuyến nghị → hành động cụ thể`;

// ══════════════════════════════════════════════════════════════
//  BACKEND ADAPTERS — Groq / Ollama / Claude
// ══════════════════════════════════════════════════════════════

/**
 * Gọi OpenRouter API (OpenAI-compatible)
 * FREE: meta-llama/llama-3.3-70b-instruct:free — không giới hạn req/day
 * Ref: https://openrouter.ai/meta-llama/llama-3.3-70b-instruct:free
 */
async function callOpenRouter(messages, systemPrompt, opts = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY chưa được cấu hình');

  const model = opts.model || process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens:  opts.maxTokens  || 800,
      temperature: opts.temperature || 0.7,
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://crabor.vn',
        'X-Title':       'CRABOR Coco AI',
      },
      timeout: 30000,
    }
  );

  const choice = response.data.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error('OpenRouter trả về response rỗng');
  }

  return {
    text:    choice.message.content,
    model,
    tokens:  response.data.usage?.completion_tokens || 0,
    backend: 'openrouter',
  };
}

/**
 * Gọi Groq API
 * FREE: llama-3.3-70b-versatile, 14,400 req/day, 6000 tok/min
 */
async function callGroq(messages, systemPrompt, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY chưa được cấu hình');

  const model = opts.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens:  opts.maxTokens  || 800,
      temperature: opts.temperature || 0.7,
      stream: false,
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      timeout: 20000,
    }
  );

  const choice = response.data.choices?.[0];
  return {
    text:    choice?.message?.content || '',
    model,
    tokens:  response.data.usage?.completion_tokens || 0,
    backend: 'groq',
  };
}

/**
 * Gọi Ollama (self-hosted)
 */
async function callOllama(messages, systemPrompt, opts = {}) {
  const baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model   = process.env.OLLAMA_MODEL || 'llama3.1:8b';

  const response = await axios.post(
    `${baseUrl}/api/chat`,
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      stream:  false,
      options: {
        temperature:    opts.temperature || 0.7,
        num_predict:    opts.maxTokens   || 800,
        repeat_penalty: 1.1,
        top_k: 40,
        top_p: 0.9,
      },
    },
    { timeout: 60000 }
  );

  return {
    text:    response.data.message?.content || '',
    model,
    tokens:  response.data.eval_count || 0,
    backend: 'ollama',
  };
}

/**
 * Claude fallback (khi Groq down)
 */
async function callClaude(messages, systemPrompt, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY chưa cấu hình');

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: opts.maxTokens || 600,
      system:     systemPrompt,
      messages,
    },
    {
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      timeout: 15000,
    }
  );

  return {
    text:    response.data.content?.[0]?.text || '',
    model:   'claude-haiku',
    tokens:  (response.data.usage?.input_tokens || 0) + (response.data.usage?.output_tokens || 0),
    backend: 'claude',
  };
}

// ══════════════════════════════════════════════════════════════
//  SYSTEM PROMPT BUILDER — Inject context thật vào prompt
// ══════════════════════════════════════════════════════════════

function buildSystemPrompt(opts = {}) {
  const { userContext, task, systemPromptOverride, agentType = 'coco' } = opts;

  // Override hoàn toàn
  if (systemPromptOverride) return systemPromptOverride;

  let prompt = agentType === 'nova' ? NOVA_SYSTEM_PROMPT : COCO_SYSTEM_PROMPT;

  // ── INJECT DB CONTEXT VÀO PROMPT ──────────────────────────
  if (userContext && Object.keys(userContext).length > 0) {

    // Ưu tiên _dbContext đã được format sẵn bởi CocoDb.buildContextString
    if (userContext._dbContext) {
      prompt += `\n\n─── DỮ LIỆU THỰC TẾ TỪ HỆ THỐNG ───\n${userContext._dbContext}`;
      prompt += '\n\n→ Đây là dữ liệu thật, chính xác. Dùng để trả lời cụ thể, đừng nói chung chung.';
    } else {
      // Fallback: inject thủ công như cũ
      const lines = ['\n\n─── THÔNG TIN NGƯỜI DÙNG HIỆN TẠI ───'];

      if (userContext.name)       lines.push(`• Tên: ${userContext.name}`);
      if (userContext.phone)      lines.push(`• SĐT: ${userContext.phone}`);
      if (userContext.walletBal !== undefined)
        lines.push(`• Số dư ví: ${(userContext.walletBal || 0).toLocaleString('vi-VN')}đ`);
      if (userContext.loyaltyPts !== undefined)
        lines.push(`• Điểm tích lũy: ${userContext.loyaltyPts || 0} điểm`);
      if (userContext.totalSpent)
        lines.push(`• Tổng chi tiêu: ${userContext.totalSpent.toLocaleString('vi-VN')}đ`);
      if (userContext.bnplLimit)
        lines.push(`• Hạn mức Ví Trả Sau: ${userContext.bnplLimit.toLocaleString('vi-VN')}đ`);
      if (userContext.bnplUsed)
        lines.push(`• Đã dùng Trả Sau: ${userContext.bnplUsed.toLocaleString('vi-VN')}đ`);
      if (userContext.recentOrders?.length) {
        const statuses = userContext.recentOrders.map(o => o.status || 'unknown').join(', ');
        lines.push(`• Đơn gần đây: ${statuses}`);
      }
      if (userContext.unpaidInvoices?.length)
        lines.push(`• ⚠️ ${userContext.unpaidInvoices.length} hóa đơn Ví Trả Sau chưa trả`);
      if (userContext.activeLoan)
        lines.push(`• Đang vay: ${userContext.activeLoan.amount} (${userContext.activeLoan.status})`);

      if (userContext.userType === 'shipper') {
        if (userContext.rating)        lines.push(`• Rating: ${userContext.rating}⭐`);
        if (userContext.todayOrders)   lines.push(`• Đơn hôm nay: ${userContext.todayOrders}`);
        if (userContext.earnings)      lines.push(`• Ví shipper: ${(userContext.earnings||0).toLocaleString('vi-VN')}đ`);
      }
      if (userContext.userType === 'partner') {
        if (userContext.bizName)       lines.push(`• Cửa hàng: ${userContext.bizName}`);
        if (userContext.activeOrders !== undefined)
          lines.push(`• Đơn đang xử lý: ${userContext.activeOrders}`);
      }

      lines.push('\n→ Dùng thông tin này để trả lời cá nhân hoá. Chỉ đề cập thông tin liên quan.');
      prompt += lines.join('\n');
    }
  }

  // Task-specific instructions
  const taskInstructions = {
    dispatch: '\n\n→ NHIỆM VỤ: Phân tích và đưa ra quyết định dispatch đơn hàng. Ngắn gọn, có căn cứ.',
    fraud:    '\n\n→ NHIỆM VỤ: Phân tích dấu hiệu gian lận. Risk assessment cụ thể với mức độ rủi ro.',
    campaign: '\n\n→ NHIỆM VỤ: Lên kế hoạch marketing. Cân nhắc ngân sách và ROI thực tế.',
    pricing:  '\n\n→ NHIỆM VỤ: Phân tích và đề xuất pricing. Dựa trên data thực tế.',
    complaint:'\n\n→ NHIỆM VỤ: Giải quyết khiếu nại. Xin lỗi trước, giải pháp sau, leo thang nếu cần.',
    summary:  '\n\n→ NHIỆM VỤ: Tóm tắt thông tin ngắn gọn bằng bullet points.',
  };
  if (task && taskInstructions[task]) prompt += taskInstructions[task];

  return prompt;
}

// ══════════════════════════════════════════════════════════════
//  CONVERSATION MANAGER — Lưu & load lịch sử chat
// ══════════════════════════════════════════════════════════════

const ConversationManager = {

  // Lấy hoặc tạo session chat
  async getOrCreate(sessionId, userId = null, userType = 'customer') {
    let chat = await CocoChat.findOne({ sessionId });
    if (!chat) {
      chat = await CocoChat.create({ sessionId, userId, userType, messages: [] });
    }
    return chat;
  },

  // Lấy lịch sử để gửi vào Groq (chỉ lấy N turn gần nhất)
  async getHistory(sessionId, maxTurns = 10) {
    const chat = await CocoChat.findOne({ sessionId }).select('messages');
    if (!chat) return [];
    // Lấy maxTurns * 2 messages cuối (user + assistant pairs)
    const msgs = chat.messages.slice(-(maxTurns * 2));
    return msgs
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));
  },

  // Lưu tin nhắn vào session
  async saveMessages(sessionId, userMsg, assistantMsg, model = null, tool = null) {
    const now = new Date();
    await CocoChat.findOneAndUpdate(
      { sessionId },
      {
        $push: { messages: {
          $each: [
            { role: 'user',      content: userMsg,      timestamp: now },
            { role: 'assistant', content: assistantMsg, model, tool, timestamp: now },
          ]
        }},
        $set: { lastActive: now },
      },
      { upsert: true }
    );
  },

  // Auto-generate tiêu đề từ message đầu tiên
  async autoTitle(sessionId, firstMessage) {
    try {
      const chat = await CocoChat.findOne({ sessionId });
      if (chat && chat.title === 'Cuộc trò chuyện mới' && chat.messages.length <= 2) {
        // Tạo tiêu đề ngắn từ message đầu
        const title = firstMessage.length > 50
          ? firstMessage.substring(0, 47) + '...'
          : firstMessage;
        await CocoChat.findOneAndUpdate({ sessionId }, { title });
      }
    } catch(e) { /* không quan trọng */ }
  },

  // Lấy danh sách conversations của user
  async listByUser(userId, limit = 20) {
    return CocoChat.find({ userId })
      .sort({ lastActive: -1 })
      .limit(limit)
      .select('sessionId title lastActive messages model')
      .lean();
  },

  // Xóa conversation
  async delete(sessionId) {
    return CocoChat.findOneAndDelete({ sessionId });
  },
};

// ══════════════════════════════════════════════════════════════
//  UNIFIED BRAIN INTERFACE — Coco nghĩ
// ══════════════════════════════════════════════════════════════

/**
 * cocoThink — unified reasoning interface
 * Compatible với API cũ của coco-brain.js
 *
 * @param {Array}  messages  - [{ role, content }]
 * @param {Object} opts
 *   - systemPrompt: override system prompt
 *   - userContext:  { name, walletBal, loyaltyPts, ... }
 *   - task:         'chat'|'dispatch'|'fraud'|'pricing'|'campaign'|'complaint'
 *   - agentType:    'coco' | 'nova'
 *   - maxTokens:    default 800
 *   - temperature:  default 0.7
 *   - sessionId:    lưu vào DB nếu có
 */
async function cocoThink(messages, opts = {}) {
  const backend = process.env.COCO_BRAIN || 'rule';

  // Rule-only mode → không suy luận
  if (backend === 'rule') {
    return { text: null, backend: 'rule', canReason: false };
  }

  const systemPrompt = buildSystemPrompt(opts);
  let result = null;
  let lastError = null;

  // ── AUTO MODE: OpenRouter → Groq → Claude → rule ──────────
  // Set COCO_BRAIN=auto để bật chế độ tự động chọn backend
  if (backend === 'auto') {
    const hasOR   = !!process.env.OPENROUTER_API_KEY;
    const hasGroq = !!process.env.GROQ_API_KEY;

    // Bước 1: thử OpenRouter
    if (hasOR) {
      try {
        result = await callOpenRouter(messages, systemPrompt, opts);
        console.log('[Coco Brain] AUTO → OpenRouter ✅');
      } catch(e1) {
        console.warn('[Coco Brain] AUTO: OpenRouter failed —', e1.message);
      }
    }

    // Bước 2: fallback Groq
    if (!result && hasGroq) {
      try {
        result = await callGroq(messages, systemPrompt, opts);
        console.log('[Coco Brain] AUTO → Groq ✅');
      } catch(e2) {
        console.warn('[Coco Brain] AUTO: Groq failed —', e2.message);
      }
    }

    // Bước 3: fallback Claude
    if (!result && process.env.ANTHROPIC_API_KEY) {
      try {
        result = await callClaude(messages, systemPrompt, opts);
        console.log('[Coco Brain] AUTO → Claude ✅');
      } catch(e3) {
        console.warn('[Coco Brain] AUTO: Claude failed —', e3.message);
      }
    }

    // Không backend nào hoạt động
    if (!result) {
      return { text: null, backend: 'failed', error: 'All backends failed in AUTO mode', canReason: false };
    }
    return { ...result, canReason: true };
  }
  // ── END AUTO MODE ──────────────────────────────────────────

  // Try primary backend
  try {
    if (backend === 'openrouter') {
      result = await callOpenRouter(messages, systemPrompt, opts);
    } else if (backend === 'groq') {
      result = await callGroq(messages, systemPrompt, opts);
    } else if (backend === 'ollama') {
      result = await callOllama(messages, systemPrompt, opts);
    } else if (backend === 'claude') {
      result = await callClaude(messages, systemPrompt, opts);
    }
  } catch(err) {
    lastError = err;
    console.error(`[Coco Brain] ${backend} error:`, err.message);

    // Auto-fallback: openrouter → groq → claude → rule
    if (backend === 'openrouter') {
      console.log('[Coco Brain] OpenRouter lỗi, fallback → Groq...');
      try {
        result = await callGroq(messages, systemPrompt, opts);
      } catch(err2) {
        console.error('[Coco Brain] Groq fallback failed:', err2.message);
        console.log('[Coco Brain] Groq lỗi, fallback → Claude...');
        try {
          result = await callClaude(messages, systemPrompt, opts);
        } catch(err3) {
          console.error('[Coco Brain] Claude fallback failed:', err3.message);
        }
      }
    } else if (backend === 'groq' || backend === 'ollama') {
      console.log('[Coco Brain] Fallback → Groq → Claude...');
      // groq mode: thử OpenRouter nếu có key trước khi Claude
      if (backend === 'groq' && process.env.OPENROUTER_API_KEY) {
        try {
          result = await callOpenRouter(messages, systemPrompt, opts);
          console.log('[Coco Brain] Groq lỗi, fallback → OpenRouter ✅');
        } catch(err2b) {
          console.error('[Coco Brain] OpenRouter fallback failed:', err2b.message);
        }
      }
      if (!result) {
        try {
          result = await callClaude(messages, systemPrompt, opts);
        } catch(err2) {
          console.error('[Coco Brain] Claude fallback failed:', err2.message);
        }
      }
    }
  }

  if (!result) {
    return {
      text:       null,
      backend:    'failed',
      error:      lastError?.message,
      canReason:  false,
    };
  }

  return { ...result, canReason: true };
}

// ══════════════════════════════════════════════════════════════
//  COCO REASONING — Các task suy luận nghiệp vụ
// ══════════════════════════════════════════════════════════════

const CocoReasoning = {

  // Trả lời chat thường (customer support)
  async answer(text, history = [], userContext = {}, sessionId = null) {
    const messages = [
      ...history.slice(-8),
      { role: 'user', content: text },
    ];
    const result = await cocoThink(messages, {
      userContext,
      task: 'chat',
      sessionId,
    });

    // Lưu vào DB nếu có sessionId
    if (sessionId && result.canReason && result.text) {
      await ConversationManager.saveMessages(
        sessionId, text, result.text, result.model, 'answer'
      );
      await ConversationManager.autoTitle(sessionId, text);
    }

    return result;
  },

  // Phân tích gian lận
  async analyzeFraud(orderData, userData) {
    const messages = [{
      role: 'user',
      content: `Phân tích rủi ro đơn hàng:
Đơn: ${JSON.stringify(orderData, null, 2)}
User: TK ${Math.round((Date.now() - new Date(userData.createdAt)) / 86400000)} ngày tuổi, tổng chi ${(userData.totalSpent || 0).toLocaleString('vi-VN')}đ

Trả về: risk_level (low/medium/high), lý do, hành động đề xuất.`,
    }];
    return cocoThink(messages, {
      task:        'fraud',
      agentType:   'nova',
      temperature: 0.2,
      maxTokens:   400,
    });
  },

  // Phân tích khiếu nại phức tạp
  async handleComplaint(complaint, orderHistory = [], userContext = {}) {
    const messages = [{
      role: 'user',
      content: `Khách hàng ${userContext.name || ''} khiếu nại: "${complaint}"

Lịch sử đơn: ${JSON.stringify(orderHistory.slice(0, 3), null, 2)}

Phân tích: 1) Khiếu nại có hợp lý không? 2) Hành động giải quyết? 3) Cần leo thang không?`,
    }];
    return cocoThink(messages, {
      userContext,
      task:        'complaint',
      temperature: 0.4,
    });
  },

  // Lên kế hoạch voucher campaign
  async planCampaign(metrics, budget, segments) {
    const messages = [{
      role: 'user',
      content: `Lên kế hoạch voucher campaign CRABOR:
- Ngân sách: ${budget.toLocaleString('vi-VN')}đ
- Metrics 7 ngày: ${JSON.stringify(metrics, null, 2)}
- Phân đoạn user: ${JSON.stringify(segments, null, 2)}

Đề xuất: loại voucher, giá trị, điều kiện, target, thời gian, kỳ vọng ROI.
Đảm bảo không vượt ${(budget * 0.8).toLocaleString('vi-VN')}đ (giữ 20% buffer).`,
    }];
    return cocoThink(messages, {
      task:        'campaign',
      agentType:   'nova',
      temperature: 0.5,
    });
  },

  // Giải thích pricing
  async explainPricing(pricingData, context) {
    const messages = [{
      role: 'user',
      content: `Giải thích tại sao phí ship là ${pricingData.fee?.toLocaleString('vi-VN')}đ (surge ${pricingData.surge}x) và có nên điều chỉnh không, dựa trên: ${JSON.stringify(context)}`,
    }];
    return cocoThink(messages, { task: 'pricing', agentType: 'nova', temperature: 0.4 });
  },

  // Tóm tắt tài liệu
  async summarizeDocument(content) {
    const messages = [{
      role: 'user',
      content: `Tóm tắt tài liệu, trích xuất thông tin quan trọng cho CRABOR (chính sách, quy trình, số liệu):

${content.substring(0, 4000)}

Định dạng: bullet points ngắn gọn.`,
    }];
    return cocoThink(messages, { task: 'summary', temperature: 0.3, maxTokens: 800 });
  },

  // Nova chat (vận hành nội bộ)
  async novaChat(text, history = [], adminContext = {}) {
    const messages = [
      ...history.slice(-6),
      { role: 'user', content: text },
    ];
    return cocoThink(messages, {
      agentType:   'nova',
      userContext:  adminContext,
      temperature:  0.5,
    });
  },
};

// ══════════════════════════════════════════════════════════════
//  API ROUTE BUILDER — Gắn routes vào Express app
// ══════════════════════════════════════════════════════════════

/**
 * Gắn Coco AI routes vào Express app.
 * Gọi: mountCocoRoutes(app, io) trong server.js
 *
 * Routes:
 *   POST /api/coco/chat           - Coco trả lời customer
 *   POST /api/coco/admin          - Coco admin panel
 *   POST /api/nova/chat           - Nova admin intelligence
 *   GET  /api/coco/history/:sid   - Lấy lịch sử chat
 *   GET  /api/coco/conversations  - Danh sách conversations của user
 *   DELETE /api/coco/session/:sid - Xóa session
 *   GET  /api/coco/status         - Brain status
 *   GET  /api/coco/models         - Available models
 */
function mountCocoRoutes(app, io) {

  const AVAILABLE_MODELS = [
    // OpenRouter models (FREE)
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct (Free)', contextWindow: 131072, provider: 'openrouter' },
    { id: 'meta-llama/llama-3.1-8b-instruct:free',  name: 'Llama 3.1 8B Instruct (Free)',  contextWindow: 131072, provider: 'openrouter' },
    // Groq models (fallback)
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', contextWindow: 128000, provider: 'groq' },
    { id: 'llama-3.1-8b-instant',    name: 'Llama 3.1 8B Instant',    contextWindow: 128000, provider: 'groq' },
    { id: 'mixtral-8x7b-32768',      name: 'Mixtral 8x7B',            contextWindow: 32768,  provider: 'groq' },
    { id: 'gemma2-9b-it',            name: 'Gemma 2 9B',              contextWindow: 8192,   provider: 'groq' },
  ];

  // ─── Health ──────────────────────────────────────────────────
  app.get('/api/coco/status', async (req, res) => {
    const status = await checkBrainStatus();
    res.json(status);
  });

  app.get('/api/coco/models', (req, res) => {
    res.json(AVAILABLE_MODELS);
  });

  // ─── COCO CHAT (customer / shipper / partner) ─────────────────
  // POST /api/coco/chat
  // Body: { message, sessionId?, userId?, userType?, userContext?, model? }
  app.post('/api/coco/chat', async (req, res) => {
    try {
      const {
        message,
        sessionId,
        userId,
        userType    = 'customer',
        userContext = {},
        model,
      } = req.body || {};

      if (!message?.trim()) {
        return res.status(400).json({ success: false, error: 'message is required' });
      }

      const backend = process.env.COCO_BRAIN || 'rule';
      const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Rule-based: delegate sang coco-engine
      if (backend === 'rule') {
        try {
          const cocoEngine = require('./coco-engine');
          const result = await cocoEngine.cocoRespondSmart({
            text: message,
            sessionId: sid,
            userId,
            userCtx: userContext,
          });
          return res.json({
            success:   true,
            sessionId: sid,
            message:   result.text,
            intent:    result.intent,
            backend:   'rule',
            canReason: false,
          });
        } catch(e) {
          return res.json({
            success:   true,
            sessionId: sid,
            message:   'Em đang khởi động, anh/chị thử lại sau nhé 😊',
            backend:   'rule',
            canReason: false,
          });
        }
      }

      // Groq/LLM mode
      await ConversationManager.getOrCreate(sid, userId, userType);
      const history = await ConversationManager.getHistory(sid, 10);

      // Override model nếu user chọn
      const opts = { userContext, task: 'chat' };
      if (model) opts.model = model;

      const result = await CocoReasoning.answer(message, history, userContext, sid);

      if (!result.canReason || !result.text) {
        // Fallback về rule-based nếu LLM fail
        try {
          const cocoEngine = require('./coco-engine');
          const fallback = await cocoEngine.cocoRespondSmart({
            text: message, sessionId: sid, userId, userCtx: userContext,
          });
          return res.json({
            success:   true,
            sessionId: sid,
            message:   fallback.text,
            intent:    fallback.intent,
            backend:   'rule_fallback',
            canReason: false,
          });
        } catch(e2) {
          return res.json({
            success:   true,
            sessionId: sid,
            message:   'Em đang gặp sự cố kỹ thuật, anh/chị thử lại sau nhé 🙏',
            backend:   'error',
            canReason: false,
          });
        }
      }

      // Emit realtime nếu có socket
      if (io && userId) {
        io.to(userId.toString()).emit('cocoMessage', {
          sessionId: sid,
          message:   result.text,
          model:     result.model,
        });
      }

      res.json({
        success:   true,
        sessionId: sid,
        message:   result.text,
        model:     result.model,
        tokens:    result.tokens,
        backend:   result.backend,
        canReason: true,
      });

    } catch(err) {
      console.error('[Coco /chat]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── NOVA CHAT (admin intelligence) ──────────────────────────
  // POST /api/nova/chat
  // Body: { message, sessionId?, adminContext? }
  app.post('/api/nova/chat', async (req, res) => {
    try {
      const { message, sessionId, adminContext = {} } = req.body || {};
      if (!message?.trim()) return res.status(400).json({ success: false, error: 'message is required' });

      const sid = sessionId || `nova_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const history = await ConversationManager.getHistory(sid, 6);

      const result = await CocoReasoning.novaChat(message, history, adminContext);

      if (result.canReason && result.text) {
        await ConversationManager.saveMessages(sid, message, result.text, result.model, 'nova');
      }

      res.json({
        success:   true,
        sessionId: sid,
        message:   result.text || 'Nova đang khởi động...',
        model:     result.model,
        backend:   result.backend,
        canReason: result.canReason,
      });
    } catch(err) {
      console.error('[Nova /chat]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── ADMIN COCO — dùng cho admin panel ───────────────────────
  // POST /api/coco/admin
  // Body: { message, task, sessionId?, contextData? }
  app.post('/api/coco/admin', async (req, res) => {
    try {
      // Kiểm tra admin session (nếu có)
      if (req.session && !req.session.adminId) {
        return res.status(401).json({ success: false, error: 'Admin auth required' });
      }

      const { message, task, sessionId, contextData = {} } = req.body || {};
      if (!message?.trim()) return res.status(400).json({ success: false, error: 'message is required' });

      const sid = sessionId || `admin_${Date.now()}`;

      let result;
      if (task === 'fraud' && contextData.order) {
        result = await CocoReasoning.analyzeFraud(contextData.order, contextData.user || {});
      } else if (task === 'campaign' && contextData.budget) {
        result = await CocoReasoning.planCampaign(
          contextData.metrics || {}, contextData.budget, contextData.segments || {}
        );
      } else if (task === 'summary' && contextData.content) {
        result = await CocoReasoning.summarizeDocument(contextData.content);
      } else {
        // General Nova chat
        const history = await ConversationManager.getHistory(sid, 6);
        result = await CocoReasoning.novaChat(message, history, contextData);
        if (result.canReason && result.text) {
          await ConversationManager.saveMessages(sid, message, result.text, result.model, task || 'admin');
        }
      }

      res.json({
        success:   true,
        sessionId: sid,
        message:   result?.text || 'Đang xử lý...',
        model:     result?.model,
        backend:   result?.backend,
        canReason: result?.canReason,
      });
    } catch(err) {
      console.error('[Coco /admin]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── CONVERSATION HISTORY ─────────────────────────────────────
  // GET /api/coco/history/:sessionId
  app.get('/api/coco/history/:sessionId', async (req, res) => {
    try {
      const chat = await CocoChat.findOne({ sessionId: req.params.sessionId }).lean();
      if (!chat) return res.status(404).json({ success: false, error: 'Session not found' });
      res.json({
        success:   true,
        sessionId: chat.sessionId,
        title:     chat.title,
        messages:  chat.messages.map(m => ({
          role:      m.role,
          content:   m.content,
          timestamp: m.timestamp,
          tool:      m.tool,
        })),
        messageCount: chat.messages.length,
      });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── CONVERSATIONS LIST ───────────────────────────────────────
  // GET /api/coco/conversations?userId=xxx
  app.get('/api/coco/conversations', async (req, res) => {
    try {
      const { userId, limit = 20 } = req.query;
      if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

      const conversations = await ConversationManager.listByUser(userId, parseInt(limit));
      res.json({
        success: true,
        conversations: conversations.map(c => ({
          sessionId:    c.sessionId,
          title:        c.title,
          messageCount: c.messages?.length || 0,
          lastActive:   c.lastActive,
          model:        c.model,
        })),
      });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── DELETE SESSION ───────────────────────────────────────────
  app.delete('/api/coco/session/:sessionId', async (req, res) => {
    try {
      await ConversationManager.delete(req.params.sessionId);
      res.json({ success: true });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── FEEDBACK ─────────────────────────────────────────────────
  // POST /api/coco/feedback
  // Body: { sessionId, messageIndex, helpful: true/false }
  app.post('/api/coco/feedback', async (req, res) => {
    try {
      const { sessionId, messageIndex, helpful } = req.body || {};
      // Ghi nhận feedback (dùng cho learning engine)
      await CocoChat.findOneAndUpdate(
        { sessionId },
        { $set: { [`messages.${messageIndex}.feedback`]: helpful ? 'positive' : 'negative' } }
      );
      res.json({ success: true });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[Coco Brain] ✅ Routes mounted: /api/coco/* /api/nova/*');
}

// ══════════════════════════════════════════════════════════════
//  STATUS CHECK
// ══════════════════════════════════════════════════════════════

async function checkBrainStatus() {
  const backend = process.env.COCO_BRAIN || 'rule';
  const status = {
    backend,
    canReason:         false,
    model:             null,
    latencyMs:         null,
    openrouterKeySet:  !!process.env.OPENROUTER_API_KEY,
    groqKeySet:        !!process.env.GROQ_API_KEY,
    ollamaUrl:         process.env.OLLAMA_URL || null,
  };

  if (backend === 'rule') {
    status.note = 'Phase 1: Rule-based engine. Set COCO_BRAIN=auto để bật suy luận thật.';
    return status;
  }
  if (backend === 'auto') {
    status.note = 'AUTO mode — OpenRouter → Groq → Claude';
  }

  const start = Date.now();
  try {
    const ping = await cocoThink(
      [{ role: 'user', content: 'Chào Coco! Test kết nối.' }],
      { maxTokens: 40, temperature: 0.1 }
    );
    status.canReason = !!ping.text;
    status.model     = ping.model;
    status.latencyMs = Date.now() - start;
    status.note      = `✅ ${backend} hoạt động — ${ping.model} (${status.latencyMs}ms)`;
  } catch(e) {
    status.note  = `❌ ${backend} lỗi: ${e.message}`;
    status.error = e.message;
  }

  return status;
}

// ══════════════════════════════════════════════════════════════
//  STARTUP LOG
// ══════════════════════════════════════════════════════════════

function printBrainSetupGuide() {
  const backend = process.env.COCO_BRAIN || 'rule';
  const groqKey = process.env.GROQ_API_KEY;
  const orKey   = process.env.OPENROUTER_API_KEY;

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   🧠  COCO BRAIN v2 STATUS                ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Backend : ${(backend + '                    ').slice(0,26)}║`);

  if (backend === 'rule') {
    console.log('║  Mode    : Phase 1 (rule-based)          ║');
    console.log('║                                          ║');
    console.log('║  Khuyến nghị — COCO_BRAIN=auto:         ║');
    console.log('║    Set OPENROUTER_API_KEY=sk-or-xxx      ║');
    console.log('║    Set GROQ_API_KEY=gsk_xxx              ║');
    console.log('║    Set COCO_BRAIN=auto                   ║');
  } else if (backend === 'auto') {
    const hasOR   = !!process.env.OPENROUTER_API_KEY;
    const hasGroq = !!process.env.GROQ_API_KEY;
    console.log(`║  OR Key  : ${hasOR   ? '✅ Configured              ' : '❌ Set OPENROUTER_API_KEY  '}║`);
    console.log(`║  Groq Key: ${hasGroq ? '✅ Configured              ' : '⚠️  Set GROQ_API_KEY        '}║`);
    console.log('║  Chain   : OpenRouter → Groq → Claude   ║');
    console.log('║  Mode    : AUTO — best available ✅      ║');
  } else if (backend === 'openrouter') {
    const orKey = process.env.OPENROUTER_API_KEY;
    const orModel = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
    console.log(`║  Key     : ${orKey ? '✅ Configured              ' : '❌ MISSING! Set OPENROUTER_API_KEY'}║`);
    console.log(`║  Model   : ${(orModel + '                    ').slice(0,26)}║`);
    console.log('║  Mode    : Phase 2 — Real Reasoning ✅   ║');
    console.log('║  Limit   : FREE (no daily cap)           ║');
    console.log('║  Fallback: Groq → Claude → Rule          ║');
  } else if (backend === 'groq') {
    console.log(`║  Key     : ${groqKey ? '✅ Configured              ' : '❌ MISSING! Set GROQ_API_KEY'}║`);
    console.log('║  Model   : llama-3.3-70b-versatile       ║');
    console.log('║  Mode    : Phase 2 — Real Reasoning ✅   ║');
    console.log('║  Limit   : 14,400 req/day (FREE)         ║');
  } else if (backend === 'ollama') {
    const url = process.env.OLLAMA_URL || 'http://localhost:11434';
    console.log(`║  URL     : ${url.slice(0,26)}     ║`);
    console.log('║  Mode    : Phase 3 — Self-hosted         ║');
  }
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Routes  : /api/coco/* /api/nova/*       ║');
  console.log('╚══════════════════════════════════════════╝\n');
}

// ══════════════════════════════════════════════════════════════
//  EXPORTS — Compatible với server.js cũ + thêm features mới
// ══════════════════════════════════════════════════════════════

module.exports = {
  // Core interface (giữ nguyên tên để server.js không cần sửa)
  cocoThink,
  CocoReasoning,
  checkBrainStatus,
  printBrainSetupGuide,
  COCO_SYSTEM_PROMPT,
  NOVA_SYSTEM_PROMPT,

  // New features
  mountCocoRoutes,
  ConversationManager,
  CocoChat,

  // Backend adapters
  callOpenRouter,
  callGroq,
  callOllama,
  callClaude,
};
