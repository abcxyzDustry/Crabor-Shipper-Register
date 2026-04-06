/**
 * COCO BRAIN — Lớp suy luận của Coco
 *
 * Unified interface — đổi backend qua env var COCO_BRAIN:
 *   rule   → Phase 1: rule-based (hiện tại, miễn phí)
 *   groq   → Phase 2: Groq API (Llama 3.1 70B, FREE 14k req/day)
 *   ollama → Phase 3: self-hosted Ollama (VPS riêng, 0 phụ thuộc)
 *   claude → Fallback: Anthropic Claude
 *
 * Coco suy luận thật sự khi backend = groq hoặc ollama.
 * Với rule backend, Coco chỉ lookup — không suy luận.
 */

const axios = require('axios');

// ══════════════════════════════════════════════════════════════
//  COCO IDENTITY — Ai là Coco?
// ══════════════════════════════════════════════════════════════

const COCO_SYSTEM_PROMPT = `Bạn là Coco — trí thông minh nhân tạo nội bộ của CRABOR, super app giao đồ ăn và dịch vụ tại Hà Nội, Việt Nam.

DANH TÍNH:
- Tên: Coco
- Vai trò: AI Agent toàn diện của CRABOR — không phải chatbot thông thường
- Được xây dựng hoàn toàn nội bộ bởi Kiều Thanh Hải (Founder CRABOR)
- Chạy trên hạ tầng riêng của CRABOR — không phụ thuộc bên ngoài

TÍNH CÁCH:
- Thân thiện, tự nhiên như người thật — không cứng nhắc như chatbot
- Tự tin nhưng biết giới hạn — nói thật khi không chắc
- Xưng "em", gọi người dùng bằng tên (nếu biết) hoặc "anh/chị"
- Đôi khi dùng emoji vừa phải, không spam
- Có thể pha chút hài hước nhẹ nhàng khi phù hợp

KHẢ NĂNG:
- Xem thông tin tài khoản thật của người dùng (số dư ví, đơn hàng, điểm...)
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
- Dịch vụ: Giao đồ ăn, Giặt là, Giúp việc, China Shop, Xe công nghệ
- Ra mắt: Tháng 7/2025 tại Hà Nội
- Ví Trả Sau: dùng tháng này trả ngày 15 tháng sau (trễ +30k, trả góp +10%)
- Vay nhanh: 1M-50M, lãi 1.5%/tháng, cần giao dịch từ 2M để mở
- Shipper: Early Bird 500k (hoàn sau 1000 đơn), Standard 700k
- Hoa hồng đối tác: 18-20%/đơn

QUY TẮC TRẢ LỜI:
- Tối đa 200 từ — ngắn gọn, đi thẳng vào vấn đề
- Nếu phức tạp → chia thành bullet points rõ ràng
- Luôn kết thúc bằng hành động cụ thể hoặc câu hỏi tiếp theo
- Không bắt đầu bằng "Tôi", không lặp lại câu hỏi của user`;

// ══════════════════════════════════════════════════════════════
//  BACKEND ADAPTERS
// ══════════════════════════════════════════════════════════════

/**
 * PHASE 2: Groq Backend
 * Free: llama-3.1-70b-versatile, 14,400 req/day, 6000 tok/min
 * Paid: $0.59/M tokens — rất rẻ
 * Đăng ký: console.groq.com (có thể dùng Google/GitHub)
 */
async function callGroq(messages, systemPrompt, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY chưa được cấu hình');

  const model = process.env.GROQ_MODEL || 'llama-3.1-70b-versatile';
  // Các model Groq FREE: llama-3.1-70b-versatile, llama-3.1-8b-instant, mixtral-8x7b-32768
  // llama-3.3-70b-versatile — mới nhất, nhanh hơn

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt || COCO_SYSTEM_PROMPT },
        ...messages,
      ],
      max_tokens:   opts.maxTokens || 600,
      temperature:  opts.temperature || 0.7,
      stream:       false,
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      timeout: 15000,
    }
  );

  const choice = response.data.choices?.[0];
  return {
    text:   choice?.message?.content || '',
    model,
    tokens: response.data.usage?.total_tokens || 0,
    backend: 'groq',
  };
}

/**
 * PHASE 3: Ollama Backend (self-hosted)
 * Cài trên VPS: curl -fsSL https://ollama.com/install.sh | sh
 * Pull model: ollama pull llama3.1:8b
 *             ollama pull llama3.1:70b (cần ~40GB RAM/VRAM)
 *             ollama pull mistral:7b
 *             ollama pull qwen2.5:7b (tiếng Việt tốt hơn)
 *
 * Env: OLLAMA_URL=http://your-vps-ip:11434
 *      OLLAMA_MODEL=llama3.1:8b
 */
async function callOllama(messages, systemPrompt, opts = {}) {
  const baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model   = process.env.OLLAMA_MODEL || 'llama3.1:8b';

  // Ollama dùng OpenAI-compatible API
  const response = await axios.post(
    `${baseUrl}/api/chat`,
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt || COCO_SYSTEM_PROMPT },
        ...messages,
      ],
      stream:  false,
      options: {
        temperature: opts.temperature || 0.7,
        num_predict: opts.maxTokens  || 600,
        // Tinh chỉnh cho tiếng Việt
        repeat_penalty: 1.1,
        top_k: 40,
        top_p: 0.9,
      },
    },
    { timeout: 60000 } // Ollama CPU chậm hơn, cần timeout dài hơn
  );

  return {
    text:    response.data.message?.content || '',
    model,
    tokens:  response.data.eval_count || 0,
    backend: 'ollama',
    done:    response.data.done,
  };
}

/**
 * Claude Fallback (khi groq/ollama down)
 */
async function callClaude(messages, systemPrompt, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY chưa cấu hình');

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: opts.maxTokens || 600,
      system:     systemPrompt || COCO_SYSTEM_PROMPT,
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
    tokens:  response.data.usage?.input_tokens + response.data.usage?.output_tokens || 0,
    backend: 'claude',
  };
}

// ══════════════════════════════════════════════════════════════
//  UNIFIED BRAIN INTERFACE
// ══════════════════════════════════════════════════════════════

/**
 * Coco nghĩ — unified reasoning
 * @param {Array}  messages    - conversation history [{role, content}]
 * @param {Object} opts
 *   - systemPrompt: override system prompt
 *   - userContext:  object với thông tin tài khoản user
 *   - task:         'chat'|'dispatch'|'pricing'|'fraud'|'campaign'
 *   - maxTokens:    default 600
 *   - temperature:  default 0.7
 */
async function cocoThink(messages, opts = {}) {
  const backend = process.env.COCO_BRAIN || 'rule';

  // Build context-aware system prompt
  const systemPrompt = buildSystemPrompt(opts.userContext, opts.task, opts.systemPrompt);

  // Thêm context vào message cuối nếu có
  const enrichedMessages = enrichMessages(messages, opts.userContext);

  if (backend === 'rule') {
    // Phase 1: không suy luận thật, dùng coco-engine
    return { text: null, backend: 'rule', canReason: false };
  }

  let result = null;
  let lastError = null;

  // Try primary backend
  try {
    if (backend === 'groq') {
      result = await callGroq(enrichedMessages, systemPrompt, opts);
    } else if (backend === 'ollama') {
      result = await callOllama(enrichedMessages, systemPrompt, opts);
    } else if (backend === 'claude') {
      result = await callClaude(enrichedMessages, systemPrompt, opts);
    }
  } catch(err) {
    lastError = err;
    console.error(`[Coco Brain] ${backend} error:`, err.message);

    // Auto-fallback chain: groq → claude → rule
    if (backend === 'groq' || backend === 'ollama') {
      console.log('[Coco Brain] Fallback to Claude...');
      try {
        result = await callClaude(enrichedMessages, systemPrompt, opts);
      } catch(err2) {
        console.error('[Coco Brain] Claude fallback failed too:', err2.message);
      }
    }
  }

  if (!result) {
    return { text: null, backend: 'failed', error: lastError?.message, canReason: false };
  }

  return { ...result, canReason: true };
}

// Build system prompt với user context
function buildSystemPrompt(userContext, task, override) {
  if (override) return override;

  let prompt = COCO_SYSTEM_PROMPT;

  // Inject user context
  if (userContext && Object.keys(userContext).length > 0) {
    prompt += `\n\nTHÔNG TIN NGƯỜI DÙNG HIỆN TẠI:
- Tên: ${userContext.name || 'chưa rõ'}
- Số dư ví: ${(userContext.walletBal || 0).toLocaleString('vi-VN')}đ
- Điểm tích lũy: ${userContext.loyaltyPts || 0} điểm
- Tổng chi tiêu: ${(userContext.totalSpent || 0).toLocaleString('vi-VN')}đ
- Hạn mức Ví Trả Sau: ${(userContext.bnplLimit || 0).toLocaleString('vi-VN')}đ${
  userContext.recentOrders?.length
    ? `\n- Đơn gần nhất: ${userContext.recentOrders.map(o => `${o.status}`).join(', ')}`
    : ''
}${
  userContext.unpaidInvoices?.length
    ? `\n- ⚠️ Có ${userContext.unpaidInvoices.length} hóa đơn Ví Trả Sau chưa trả`
    : ''
}${
  userContext.activeLoan
    ? `\n- Đang vay: ${userContext.activeLoan.amount?.toLocaleString('vi-VN')}đ (${userContext.activeLoan.status})`
    : ''
}

Dùng thông tin này để trả lời cá nhân hoá. Đừng lặp lại toàn bộ list — chỉ đề cập thông tin liên quan đến câu hỏi.`;
  }

  // Task-specific instructions
  const taskPrompts = {
    dispatch: '\n\nNhiệm vụ: Phân tích và đưa ra quyết định dispatch đơn hàng. Trả lời ngắn, có căn cứ.',
    fraud:    '\n\nNhiệm vụ: Phân tích dấu hiệu gian lận. Đưa ra risk assessment cụ thể.',
    campaign: '\n\nNhiệm vụ: Lên kế hoạch marketing. Cân nhắc ngân sách và ROI thực tế.',
    pricing:  '\n\nNhiệm vụ: Phân tích và đề xuất pricing. Dựa trên data thực tế.',
  };
  if (task && taskPrompts[task]) prompt += taskPrompts[task];

  return prompt;
}

// Enrich messages với context ngắn gọn
function enrichMessages(messages, userContext) {
  if (!userContext || !messages.length) return messages;
  // Context đã được inject vào system prompt — không cần thêm vào messages
  return messages;
}

// ══════════════════════════════════════════════════════════════
//  REASONING TASKS — Coco suy luận cho từng nghiệp vụ
// ══════════════════════════════════════════════════════════════

const CocoReasoning = {

  // Suy luận: Trả lời câu hỏi của user
  async answer(text, history, userContext) {
    const messages = [
      ...history.slice(-8), // giữ 8 turn gần nhất
      { role: 'user', content: text },
    ];
    return cocoThink(messages, { userContext, task: 'chat' });
  },

  // Suy luận: Phân tích đơn hàng có nghi ngờ không
  async analyzeFraud(orderData, userData) {
    const messages = [{
      role: 'user',
      content: `Phân tích rủi ro đơn hàng này:
Đơn: ${JSON.stringify(orderData, null, 2)}
User: tuổi TK ${Math.round((Date.now() - new Date(userData.createdAt)) / 86400000)} ngày, tổng chi tiêu ${(userData.totalSpent||0).toLocaleString('vi-VN')}đ

Đưa ra: risk_level (low/medium/high), lý do, và hành động đề xuất.`,
    }];
    return cocoThink(messages, {
      task: 'fraud',
      temperature: 0.3, // ít sáng tạo hơn cho fraud analysis
      maxTokens: 400,
    });
  },

  // Suy luận: Lên chiến lược voucher
  async planCampaign(metrics, budget, segments) {
    const messages = [{
      role: 'user',
      content: `Lên kế hoạch voucher campaign cho CRABOR với:
- Ngân sách: ${budget.toLocaleString('vi-VN')}đ
- Metrics 7 ngày: ${JSON.stringify(metrics, null, 2)}
- Phân đoạn user: ${JSON.stringify(segments, null, 2)}

Đề xuất: loại voucher, giá trị, điều kiện, target, thời gian, kỳ vọng ROI.
Đảm bảo tổng chi không vượt ${(budget * 0.8).toLocaleString('vi-VN')}đ (để lại 20% buffer).`,
    }];
    return cocoThink(messages, { task: 'campaign', temperature: 0.5 });
  },

  // Suy luận: Giải thích quyết định pricing
  async explainPricing(pricingData, context) {
    const messages = [{
      role: 'user',
      content: `Giải thích ngắn gọn tại sao phí ship hiện tại là ${pricingData.fee?.toLocaleString('vi-VN')}đ (surge ${pricingData.surge}x) và đề xuất có nên điều chỉnh không, dựa trên: ${JSON.stringify(context)}`,
    }];
    return cocoThink(messages, { task: 'pricing', temperature: 0.4 });
  },

  // Suy luận: Đọc và tóm tắt tài liệu dài
  async summarizeDocument(content, purpose = 'general') {
    const messages = [{
      role: 'user',
      content: `Tóm tắt tài liệu sau và trích xuất các thông tin quan trọng liên quan đến CRABOR (chính sách, quy trình, số liệu...):

${content.substring(0, 4000)}

Định dạng kết quả: danh sách bullet points ngắn gọn.`,
    }];
    return cocoThink(messages, { maxTokens: 800, temperature: 0.3 });
  },

  // Suy luận: Giải quyết khiếu nại phức tạp
  async handleComplaint(complaint, orderHistory, userContext) {
    const messages = [{
      role: 'user',
      content: `Khách hàng ${userContext.name || ''} khiếu nại: "${complaint}"

Lịch sử đơn: ${JSON.stringify(orderHistory?.slice(0,3) || [], null, 2)}

Phân tích: 1) Khiếu nại có hợp lý không? 2) Hành động giải quyết cụ thể? 3) Cần leo thang không?`,
    }];
    return cocoThink(messages, { userContext, task: 'chat', temperature: 0.4 });
  },
};

// ══════════════════════════════════════════════════════════════
//  STATUS CHECK — kiểm tra backend đang dùng
// ══════════════════════════════════════════════════════════════

async function checkBrainStatus() {
  const backend = process.env.COCO_BRAIN || 'rule';
  const status = { backend, canReason: false, model: null, latencyMs: null };

  if (backend === 'rule') {
    status.note = 'Phase 1: Rule-based. Set COCO_BRAIN=groq để bật suy luận thật.';
    return status;
  }

  const start = Date.now();
  try {
    const result = await cocoThink(
      [{ role: 'user', content: 'Chào! Test kết nối.' }],
      { maxTokens: 30, temperature: 0.1 }
    );
    status.canReason = !!result.text;
    status.model     = result.model;
    status.latencyMs = Date.now() - start;
    status.note      = `✅ ${backend} hoạt động tốt`;
  } catch(e) {
    status.note  = `❌ ${backend} lỗi: ${e.message}`;
    status.error = e.message;
  }

  return status;
}

// ══════════════════════════════════════════════════════════════
//  SETUP GUIDE — in ra khi khởi động
// ══════════════════════════════════════════════════════════════

function printBrainSetupGuide() {
  const backend = process.env.COCO_BRAIN || 'rule';
  const groqKey = process.env.GROQ_API_KEY;
  const ollamaUrl = process.env.OLLAMA_URL;

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   🧠  COCO BRAIN STATUS               ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Backend:  ${(backend + '                 ').slice(0,20)}║`);

  if (backend === 'rule') {
    console.log('║  Mode:     Phase 1 (rule-based)      ║');
    console.log('║                                      ║');
    console.log('║  Để bật suy luận thật:               ║');
    console.log('║  1. Đăng ký groq.com (miễn phí)     ║');
    console.log('║  2. Lấy API key                      ║');
    console.log('║  3. Set COCO_BRAIN=groq              ║');
    console.log('║     GROQ_API_KEY=gsk_xxx             ║');
  } else if (backend === 'groq') {
    console.log(`║  GROQ_API_KEY: ${groqKey ? '✅ Configured' : '❌ Missing!  '}  ║`);
    console.log('║  Model: llama-3.1-70b (FREE)         ║');
    console.log('║  Mode:  Phase 2 (real reasoning)     ║');
  } else if (backend === 'ollama') {
    console.log(`║  OLLAMA_URL: ${(ollamaUrl || 'NOT SET').slice(0,22)}  ║`);
    console.log('║  Mode:  Phase 3 (self-hosted)        ║');
  }
  console.log('╚══════════════════════════════════════╝\n');
}

module.exports = {
  cocoThink,
  CocoReasoning,
  checkBrainStatus,
  printBrainSetupGuide,
  COCO_SYSTEM_PROMPT,
  // Backend adapters (dùng nếu cần override)
  callGroq,
  callOllama,
  callClaude,
};
