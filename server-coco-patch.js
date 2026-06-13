/**
 * COCO AI PATCH — Nâng cấp /api/coco/chat thành Groq-powered Coco thật sự
 *
 * CÁCH DÙNG:
 *   Thêm dòng này vào cuối server.js (ngay trước server.listen):
 *     require('./server-coco-patch')(app, io);
 *
 * File này OVERRIDE các route /api/coco/chat & /api/coco/hotline cũ,
 * và THÊM các route mới: /api/coco/conversations, /api/nova/chat
 *
 * Không cần sửa gì trong server.js cả — chỉ thêm 1 dòng require().
 */

'use strict';

module.exports = function installCocoAI(app, io) {

  const cocoBrain = require('./coco-brain');
  const {
    cocoThink, CocoReasoning, ConversationManager,
    mountCocoRoutes, checkBrainStatus, printBrainSetupGuide,
  } = cocoBrain;

  // ── COCO DB — Database Intelligence Layer ──
  const CocoDb = require('./coco-db');

  // In status ra console khi khởi động
  printBrainSetupGuide();

  // ════════════════════════════════════════════════════════════
  //  OVERRIDE: POST /api/coco/chat
  //  Nâng cấp từ single-turn → multi-turn với Groq memory
  // ════════════════════════════════════════════════════════════
  // Express route order: routes đăng ký SAU sẽ override route trước
  // nếu dùng app.post() với cùng path + không có `return next()`
  // Để chắc chắn, ta dùng middleware layer mới

  // Xóa route cũ bằng cách layer mới intercept trước
  app.use('/api/coco/chat', async (req, res, next) => {
    if (req.method !== 'POST') return next();

    try {
      const {
        text,           // backward compat với route cũ
        message,        // field mới
        sessionId,
        userType = 'customer',
        model,
      } = req.body || {};

      const userInput = (message || text || '').trim();
      if (!userInput) return res.status(400).json({ success: false, error: 'Thiếu nội dung tin nhắn' });

      // ── BUILD FULL USER CONTEXT từ DB ──────────────────────
      const userId = req.session?.userId;
      let userCtx = {};

      if (userId) {
        try {
          // CocoDb đọc đầy đủ: đơn hàng, ví, BNPL, vay, tickets
          userCtx = await CocoDb.buildUserContext(userId);
        } catch(e) {
          console.error('[Coco Patch] CocoDb.buildUserContext error:', e.message);
        }
      }

      // Session ID: ưu tiên truyền vào, fallback sinh mới
      const sid = sessionId || `coco_${userId || 'anon'}_${Date.now()}`;

      // Smart query: detect intent và lấy data cụ thể (VD: tra mã đơn)
      let smartExtra = '';
      if (userId) {
        try {
          const { extra } = await CocoDb.smartQuery(userInput, userId);
          smartExtra = extra || '';
        } catch(e) {}
      }

      // Lấy lịch sử chat (multi-turn)
      const history = await ConversationManager.getHistory(sid, 10);

      // Nếu COCO_BRAIN = rule → fallback về engine cũ
      const backend = process.env.COCO_BRAIN || 'rule';
      if (backend === 'rule') {
        const cocoEngine = require('./coco-engine');
        const result = await cocoEngine.cocoRespondSmart({
          text: userInput, sessionId: sid, userId, userCtx,
        });

        // Vẫn lưu vào CocoMemory cũ (backward compat)
        try {
          const CocoMemory = require('mongoose').models.CocoMemory;
          if (CocoMemory) {
            await CocoMemory.findOneAndUpdate(
              { sessionId: sid },
              {
                $push: { messages: { $each: [
                  { role: 'user', text: userInput, intent: result.intent, timestamp: new Date() },
                  { role: 'coco', text: result.text, intent: result.intent, timestamp: new Date() },
                ]}},
                $inc: { turnCount: 1 },
                $set: { lastActive: new Date(), userId: userId || null },
              },
              { upsert: true }
            );
          }
        } catch(_) {}

        return res.json({
          success:   true,
          text:      result.text,
          message:   result.text,
          intent:    result.intent,
          confidence:result.confidence || 0.7,
          sessionId: sid,
          backend:   'rule',
          canReason: false,
        });
      }

      // ── GROQ / LLM mode ──
      await ConversationManager.getOrCreate(sid, userId, userType);

      // Đính kèm DB context vào userCtx để AI đọc
      const dbContextStr = CocoDb.buildContextString(userCtx);
      const enrichedUserCtx = {
        ...userCtx,
        _dbContext: dbContextStr + (smartExtra ? '\n\n[QUERY RESULT]\n' + smartExtra : ''),
      };

      const result = await CocoReasoning.answer(userInput, history, enrichedUserCtx, sid);

      if (!result.canReason || !result.text) {
        // Fallback engine rule-based
        const cocoEngine = require('./coco-engine');
        const fallback = await cocoEngine.cocoRespondSmart({
          text: userInput, sessionId: sid, userId, userCtx,
        });
        return res.json({
          success:   true,
          text:      fallback.text,
          message:   fallback.text,
          intent:    fallback.intent,
          sessionId: sid,
          backend:   'rule_fallback',
          canReason: false,
        });
      }

      // Emit socket realtime
      if (io && userId) {
        io.to(userId.toString()).emit('cocoMessage', {
          sessionId: sid,
          message:   result.text,
          model:     result.model,
        });
      }

      return res.json({
        success:   true,
        text:      result.text,       // backward compat
        message:   result.text,       // field mới
        intent:    'ai_reasoning',
        confidence:0.95,
        sessionId: sid,
        model:     result.model,
        tokens:    result.tokens,
        backend:   result.backend,
        canReason: true,
      });

    } catch(err) {
      console.error('[Coco Chat Override]', err.message);
      return res.status(500).json({ success: false, message: 'Coco tạm thời gián đoạn 🙏' });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  OVERRIDE: POST /api/coco/hotline
  //  Coco tổng đài — multi-turn, đầy đủ user context
  // ════════════════════════════════════════════════════════════
  app.use('/api/coco/hotline', async (req, res, next) => {
    if (req.method !== 'POST') return next();

    try {
      const { text, message, sessionId } = req.body || {};
      const userInput = (message || text || '').trim();
      if (!userInput) return res.status(400).json({ success: false });

      const userId = req.session?.userId;
      let userCtx  = {};

      if (userId) {
        try {
          const User = require('mongoose').model('User');
          const user = await User.findById(userId)
            .select('fullName phone walletBalance loyaltyPts totalSpent');
          if (user) userCtx = {
            name:      user.fullName || 'anh/chị',
            phone:     user.phone,
            walletBal: user.walletBalance || 0,
            loyaltyPts:user.loyaltyPts   || 0,
            totalSpent:user.totalSpent   || 0,
          };
        } catch(_) {}
      }

      const sid = sessionId || `hotline_${userId || 'anon'}_${Date.now()}`;
      const history = await ConversationManager.getHistory(sid, 8);

      const backend = process.env.COCO_BRAIN || 'rule';
      let responseText;

      if (backend !== 'rule') {
        const result = await cocoThink(
          [...history.slice(-6), { role: 'user', content: userInput }],
          {
            userContext: userCtx,
            task: 'chat',
            temperature: 0.6,
            maxTokens: 400,
            systemPromptOverride: `Bạn là Coco, nhân viên tổng đài AI của CRABOR. Xưng "em", gọi khách bằng tên nếu biết. Lịch sự, chuyên nghiệp, giải quyết vấn đề cụ thể. Tối đa 120 từ.${userCtx.name && userCtx.name !== 'bạn' ? ' Khách hàng tên: ' + userCtx.name + '.' : ''}${userCtx.walletBal !== undefined ? ' Số dư ví: ' + (userCtx.walletBal || 0).toLocaleString('vi-VN') + 'đ.' : ''}`,
          }
        );
        if (result.canReason && result.text) {
          responseText = result.text;
          await ConversationManager.saveMessages(sid, userInput, responseText, result.model, 'hotline');
        }
      }

      if (!responseText) {
        const cocoEngine = require('./coco-engine');
        const r = await cocoEngine.cocoRespondSmart({ text: userInput, sessionId: sid, userId, userCtx });
        responseText = r.text;
        if (r.intent === 'unknown') {
          responseText = `Em đã ghi nhận yêu cầu của ${userCtx.name || 'anh/chị'} ạ. Đội kỹ thuật sẽ phản hồi trong 30 phút. Anh/chị cần hỗ trợ thêm gì không ạ?`;
        }
      }

      return res.json({ success: true, text: responseText, sessionId: sid });
    } catch(err) {
      return res.status(500).json({ success: false, message: 'Tổng đài Coco tạm thời gián đoạn ạ' });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  NEW: POST /api/nova/chat — Nova intelligence (admin)
  // ════════════════════════════════════════════════════════════
  app.post('/api/nova/chat', async (req, res) => {
    try {
      const { message, sessionId, adminContext = {} } = req.body || {};
      if (!message?.trim()) return res.status(400).json({ success: false, error: 'message required' });

      // Build admin context từ Nova metrics
      let enrichedCtx = { ...adminContext };
      try {
        const { RevenueIntel, SystemHealth } = require('./nova-agent');
        const [sysHealth] = await Promise.all([
          SystemHealth.fullReport().catch(() => null),
        ]);
        if (sysHealth) enrichedCtx.systemHealth = sysHealth;
      } catch(_) {}

      const sid = sessionId || `nova_${Date.now()}`;
      const history = await ConversationManager.getHistory(sid, 6);
      const result  = await CocoReasoning.novaChat(message, history, enrichedCtx);

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
      console.error('[Nova Chat]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  NEW: GET /api/coco/conversations — Lịch sử chat của user
  // ════════════════════════════════════════════════════════════
  app.get('/api/coco/conversations', async (req, res) => {
    try {
      const userId = req.session?.userId || req.query.userId;
      if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
      const conversations = await ConversationManager.listByUser(userId, 20);
      res.json({
        success: true,
        conversations: conversations.map(c => ({
          sessionId:    c.sessionId,
          title:        c.title,
          messageCount: c.messages?.length || 0,
          lastActive:   c.lastActive,
        })),
      });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/coco/history/:sessionId — Lấy messages của 1 session
  app.get('/api/coco/history/:sessionId', async (req, res) => {
    try {
      const CocoChat = require('mongoose').models.CocoChat;
      if (!CocoChat) return res.status(404).json({ success: false, error: 'CocoChat model not ready' });
      const chat = await CocoChat.findOne({ sessionId: req.params.sessionId }).lean();
      if (!chat) return res.status(404).json({ success: false, error: 'Session not found' });
      res.json({
        success:   true,
        sessionId: chat.sessionId,
        title:     chat.title,
        messages:  chat.messages.map(m => ({
          role:      m.role,
          content:   m.content,
          tool:      m.tool,
          timestamp: m.timestamp,
        })),
        messageCount: chat.messages.length,
      });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/coco/session/:sessionId
  app.delete('/api/coco/session/:sessionId', async (req, res) => {
    try {
      await ConversationManager.delete(req.params.sessionId);
      res.json({ success: true });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  PUBLIC: GET /api/coco/status — Widget check (no auth needed)
  // ════════════════════════════════════════════════════════════
  app.get('/api/coco/status', async (req, res) => {
    try {
      const backend = process.env.COCO_BRAIN || 'rule';
      const canReason = backend !== 'rule';
      const hasOR   = !!process.env.OPENROUTER_API_KEY;
      const hasGroq  = !!process.env.GROQ_API_KEY;
      res.json({
        success:   true,
        canReason,
        backend,
        model: canReason
          ? (hasOR ? 'meta-llama/llama-3.3-70b-instruct:free' : 'llama-3.3-70b-versatile')
          : null,
        providers: { openrouter: hasOR, groq: hasGroq },
      });
    } catch(err) {
      res.json({ success: true, canReason: false, backend: 'rule' });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  ENHANCED: GET /api/coco/brain/status — Chi tiết hơn (admin)
  // ════════════════════════════════════════════════════════════
  app.get('/api/coco/brain/status', async (req, res) => {
    try {
      const status = await checkBrainStatus();
      // Thêm stats conversation
      const CocoChat = require('mongoose').models.CocoChat;
      if (CocoChat) {
        const totalChats = await CocoChat.countDocuments();
        const activeToday = await CocoChat.countDocuments({
          lastActive: { $gt: new Date(Date.now() - 24*3600*1000) }
        });
        status.conversations = { total: totalChats, activeToday };
      }
      res.json({ success: true, ...status });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  ENHANCED: POST /api/coco/admin — Coco trả lời với full context
  // ════════════════════════════════════════════════════════════
  app.post('/api/coco/admin', async (req, res) => {
    try {
      if (!req.session?.adminId) {
        return res.status(401).json({ success: false, error: 'Admin auth required' });
      }
      const { message, task, sessionId, contextData = {} } = req.body || {};
      if (!message?.trim()) return res.status(400).json({ success: false });

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
        const history = await ConversationManager.getHistory(sid, 6);
        result = await CocoReasoning.novaChat(message, history, contextData);
        if (result.canReason && result.text) {
          await ConversationManager.saveMessages(sid, message, result.text, result.model, task || 'admin');
        }
      }

      res.json({
        success:   true,
        sessionId: sid,
        message:   result?.text || 'Coco/Nova đang xử lý...',
        model:     result?.model,
        backend:   result?.backend,
        canReason: result?.canReason,
      });
    } catch(err) {
      console.error('[Coco Admin]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  GET /api/coco/models — Danh sách model Groq
  // ════════════════════════════════════════════════════════════
  app.get('/api/coco/models', (req, res) => {
    res.json([
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', contextWindow: 128000, provider: 'groq', default: true },
      { id: 'llama-3.1-8b-instant',    name: 'Llama 3.1 8B Instant',    contextWindow: 128000, provider: 'groq' },
      { id: 'mixtral-8x7b-32768',      name: 'Mixtral 8x7B',            contextWindow: 32768,  provider: 'groq' },
      { id: 'gemma2-9b-it',            name: 'Gemma 2 9B',              contextWindow: 8192,   provider: 'groq' },
    ]);
  });

  // ══════════════════════════════════════════════════════════
  //  NEW: GET /api/coco/order/:orderId — Tra cứu đơn hàng
  // ══════════════════════════════════════════════════════════
  app.get('/api/coco/order/:orderId', async (req, res) => {
    try {
      const { orderId } = req.params;
      const userId = req.session?.userId || null;
      const isAdmin = req.session?.adminId;
      const order = await CocoDb.queryOrder(orderId, isAdmin ? null : userId);
      if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
      res.json({ success: true, order });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════
  //  NEW: GET /api/coco/me — User context đầy đủ
  // ══════════════════════════════════════════════════════════
  app.get('/api/coco/me', async (req, res) => {
    try {
      if (!req.session?.userId) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
      const ctx = await CocoDb.buildUserContext(req.session.userId);
      res.json({ success: true, context: ctx });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════
  //  NEW: GET /api/nova/db/context — Admin metrics (Nova)
  // ══════════════════════════════════════════════════════════
  app.get('/api/nova/db/context', async (req, res) => {
    try {
      if (!req.session?.adminId) return res.status(401).json({ success: false });
      const ctx = await CocoDb.buildAdminContext();
      res.json({ success: true, context: ctx });
    } catch(err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[Coco AI Patch] ✅ Installed — /api/coco/* upgraded to AI reasoning + DB integration');
  console.log('[Coco AI Patch]    /api/nova/chat → Nova Operations Intelligence');
};

