/**
 * CRABOR Coco AI Widget v2
 * Thay thế FAQ tĩnh bằng gọi API thật tới /api/coco/chat (Groq-powered)
 *
 * Cách dùng: thêm vào cuối <body> của mọi trang HTML:
 *   <script src="/coco-widget.js"></script>
 *
 * Widget tự inject HTML + CSS, không cần thêm gì khác.
 * Tương thích với cả index.html, register.html, admin.html
 */
(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────
  const API_ENDPOINT = '/api/coco/chat';
  const MAX_HISTORY  = 12; // số turn nhớ (client-side)
  const TYPING_MS    = 600; // thời gian giả vờ typing

  // ── Detect trang hiện tại ──────────────────────────────
  const _page = (function () {
    const p = location.pathname.toLowerCase();
    if (p.includes('register')) return 'register';
    if (p.includes('partner'))  return 'partner';
    if (p.includes('sales'))    return 'sales';
    if (p.includes('shipper'))  return 'shipper';
    if (p.includes('admin'))    return 'admin';
    return 'customer';
  })();

  // ── Quick chips theo trang ─────────────────────────────
  const QUICK_CHIPS = {
    customer: ['CRABOR là gì?', 'Các dịch vụ?', 'Hỗ trợ đổi/trả?', 'Liên hệ?'],
    shipper:  ['Đăng ký shipper?', 'Thu nhập bao nhiêu?', 'Phí kích hoạt?', 'Hạng shipper?'],
    partner:  ['Đăng ký đối tác?', 'Hoa hồng bao nhiêu?', 'Duyệt mất bao lâu?', 'Liên hệ?'],
    sales:    ['CTV kiếm tiền?', 'Mã giới thiệu?', 'Rút tiền?', 'Liên hệ?'],
    register: ['Đăng ký shipper?', 'Đăng ký đối tác?', 'Phí là bao nhiêu?', 'Liên hệ?'],
    admin:    ['Tình trạng hệ thống?', 'Thống kê hôm nay?', 'Coco AI status?', 'Liên hệ?'],
    default:  ['CRABOR là gì?', 'Dịch vụ gì?', 'Đăng ký?', 'Liên hệ?'],
  };

  const WELCOME_MSG = {
    customer: '👋 Xin chào! Em là **Coco** — trợ lý AI của CRABOR 🦀\nAnh/chị cần hỗ trợ gì ạ?',
    shipper:  '🛵 Xin chào! Em là **Coco** — trợ lý CRABOR 🦀\nAnh/chị cần hỗ trợ gì về Shipper không ạ?',
    partner:  '🤝 Xin chào! Em là **Coco** — trợ lý CRABOR 🦀\nAnh/chị đối tác cần hỗ trợ gì ạ?',
    register: '🦀 Xin chào! Em là **Coco** — AI của CRABOR!\nAnh/chị đang đăng ký dịch vụ gì? Em có thể giải đáp ngay!',
    admin:    '👋 Xin chào Admin! Em là **Coco AI** — sẵn sàng hỗ trợ ạ.',
    default:  '🦀 Xin chào! Em là **Coco** — trợ lý AI của CRABOR!\nAnh/chị cần hỗ trợ gì ạ?',
  };

  // ── Session ────────────────────────────────────────────
  const _sessionId = 'coco_' + _page + '_' + (
    localStorage.getItem('coco_sid') ||
    (function () { const id = Math.random().toString(36).slice(2, 10); localStorage.setItem('coco_sid', id); return id; })()
  );

  let _history  = []; // [{role, content}]
  let _open     = false;
  let _busy     = false;
  let _notified = false;

  // ── Inject CSS ─────────────────────────────────────────
  const CSS = `
    #cocoFab{
      position:fixed;bottom:80px;right:16px;z-index:8500;
      width:52px;height:52px;border-radius:50%;
      background:linear-gradient(135deg,#E8504A,#c93d37);
      border:none;color:#fff;font-size:1.4rem;cursor:pointer;
      box-shadow:0 4px 18px rgba(232,80,74,.55);
      display:flex;align-items:center;justify-content:center;
      transition:transform .2s;
    }
    #cocoFab:hover{transform:scale(1.1);}
    #cocoBadge{
      position:absolute;top:-3px;right:-3px;
      width:16px;height:16px;background:#27ae60;
      border-radius:50%;border:2px solid #fff;
      font-size:.58rem;color:#fff;
      display:none;align-items:center;justify-content:center;font-weight:900;
    }
    #cocoWin{
      position:fixed;bottom:142px;right:16px;
      width:min(360px,calc(100vw - 32px));
      max-height:min(520px,calc(100vh - 180px));
      background:#fff;border-radius:20px;
      box-shadow:0 10px 40px rgba(0,0,0,.22);
      z-index:8500;display:none;flex-direction:column;overflow:hidden;
    }
    #cocoWin.open{display:flex;}
    .coco-head{
      background:linear-gradient(135deg,#E8504A,#c93d37);
      padding:12px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0;
    }
    .coco-avatar{
      width:34px;height:34px;border-radius:50%;
      background:rgba(255,255,255,.2);
      display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;
    }
    .coco-head-name{color:#fff;font-weight:900;font-size:.88rem;}
    .coco-head-status{
      color:rgba(255,255,255,.8);font-size:.68rem;
      display:flex;align-items:center;gap:4px;
    }
    .coco-status-dot{
      width:6px;height:6px;border-radius:50%;background:#4ade80;
      animation:cocoPulse 1.8s infinite;
    }
    @keyframes cocoPulse{0%,100%{opacity:1}50%{opacity:.4}}
    .coco-close{
      margin-left:auto;background:rgba(255,255,255,.2);border:none;
      color:#fff;border-radius:50%;width:27px;height:27px;
      cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center;
    }
    .coco-msgs{
      flex:1;overflow-y:auto;padding:12px;
      display:flex;flex-direction:column;gap:8px;background:#f8f8f8;
    }
    .coco-msgs::-webkit-scrollbar{width:3px;}
    .coco-msgs::-webkit-scrollbar-thumb{background:rgba(232,80,74,.25);border-radius:3px;}
    .coco-msg{display:flex;gap:7px;align-items:flex-end;}
    .coco-msg.user{flex-direction:row-reverse;}
    .coco-bubble{
      max-width:82%;padding:9px 12px;border-radius:14px;
      font-size:.82rem;line-height:1.55;font-weight:600;
    }
    .coco-msg.bot .coco-bubble{
      background:#fff;color:#333;
      border-bottom-left-radius:4px;
      box-shadow:0 1px 4px rgba(0,0,0,.09);
    }
    .coco-msg.user .coco-bubble{
      background:linear-gradient(135deg,#E8504A,#c93d37);
      color:#fff;border-bottom-right-radius:4px;
    }
    .coco-typing-dots{display:flex;gap:4px;padding:10px 12px;}
    .coco-typing-dots span{
      width:6px;height:6px;border-radius:50%;background:#E8504A;opacity:.4;
      animation:cocoTyping 1.1s infinite;
    }
    .coco-typing-dots span:nth-child(2){animation-delay:.18s;}
    .coco-typing-dots span:nth-child(3){animation-delay:.36s;}
    @keyframes cocoTyping{0%,60%,100%{opacity:.4;transform:none}30%{opacity:1;transform:translateY(-4px)}}
    .coco-chips{
      display:flex;flex-wrap:wrap;gap:6px;padding:7px 10px 9px;
      border-top:1px solid #f0f0f0;background:#fff;flex-shrink:0;
    }
    .coco-chip{
      background:rgba(232,80,74,.07);border:1px solid rgba(232,80,74,.2);
      color:#E8504A;border-radius:50px;padding:4px 10px;
      font-size:.7rem;font-weight:800;cursor:pointer;
      font-family:inherit;transition:background .15s;white-space:nowrap;
    }
    .coco-chip:hover{background:rgba(232,80,74,.18);}
    .coco-input-row{
      padding:8px 10px;border-top:1px solid #eee;
      display:flex;gap:8px;align-items:center;background:#fff;flex-shrink:0;
    }
    .coco-input{
      flex:1;border:1.5px solid #eee;border-radius:50px;
      padding:8px 13px;font-family:inherit;font-size:.82rem;outline:none;color:#333;
    }
    .coco-input:focus{border-color:#E8504A;}
    .coco-send{
      width:34px;height:34px;border-radius:50%;
      background:linear-gradient(135deg,#E8504A,#c93d37);
      border:none;color:#fff;cursor:pointer;font-size:.85rem;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;
    }
    .coco-send:disabled{opacity:.45;cursor:not-allowed;}
    .coco-error{font-size:.78rem;color:#e55;text-align:center;padding:6px;}
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ── Inject HTML ────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <button id="cocoFab" aria-label="Chat với Coco AI">
      🦀<div id="cocoBadge"></div>
    </button>
    <div id="cocoWin" role="dialog" aria-label="Coco AI Chat">
      <div class="coco-head">
        <div class="coco-avatar">🦀</div>
        <div>
          <div class="coco-head-name">Coco — CRABOR AI</div>
          <div class="coco-head-status">
            <span class="coco-status-dot"></span>
            <span id="cocoStatusTxt">Đang kết nối...</span>
          </div>
        </div>
        <button class="coco-close" id="cocoClose">✕</button>
      </div>
      <div class="coco-msgs" id="cocoMsgs"></div>
      <div class="coco-chips" id="cocoChips"></div>
      <div class="coco-input-row">
        <input class="coco-input" id="cocoInput"
          placeholder="Hỏi Coco bất cứ điều gì..."
          autocomplete="off"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._cocoSend();}">
        <button class="coco-send" id="cocoSendBtn" onclick="window._cocoSend()">➤</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrapper);

  // ── DOM refs ───────────────────────────────────────────
  const fab      = document.getElementById('cocoFab');
  const win      = document.getElementById('cocoWin');
  const badge    = document.getElementById('cocoBadge');
  const msgs     = document.getElementById('cocoMsgs');
  const chips    = document.getElementById('cocoChips');
  const input    = document.getElementById('cocoInput');
  const sendBtn  = document.getElementById('cocoSendBtn');
  const closeBtn = document.getElementById('cocoClose');
  const statusTxt = document.getElementById('cocoStatusTxt');

  // ── Helpers ────────────────────────────────────────────
  function _formatText(txt) {
    return txt
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  function _appendMsg(role, html) {
    const row = document.createElement('div');
    row.className = 'coco-msg ' + role;
    if (role === 'bot') {
      row.innerHTML = '<div class="coco-bubble">' + html + '</div>';
    } else {
      const div = document.createElement('div');
      div.className = 'coco-bubble';
      div.textContent = html; // escape user input
      row.appendChild(div);
    }
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  function _showTyping() {
    const row = document.createElement('div');
    row.className = 'coco-msg bot';
    row.id = 'cocoTyping';
    row.innerHTML = '<div class="coco-bubble"><div class="coco-typing-dots"><span></span><span></span><span></span></div></div>';
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function _hideTyping() {
    const el = document.getElementById('cocoTyping');
    if (el) el.remove();
  }

  function _setChips(arr) {
    chips.innerHTML = arr.map(q =>
      '<button class="coco-chip" onclick="window._cocoAsk(this.textContent)">' + q + '</button>'
    ).join('');
  }

  function _setStatus(txt, ok) {
    if (statusTxt) statusTxt.textContent = txt;
  }

  // ── Toggle open/close ──────────────────────────────────
  function _toggle() {
    _open = !_open;
    win.classList.toggle('open', _open);
    badge.style.display = 'none';
    _notified = true;
    if (_open) {
      input.focus();
      // Kiểm tra brain status lần đầu mở
      if (_history.length === 0) _checkBrainStatus();
    }
  }

  fab.onclick     = _toggle;
  closeBtn.onclick = _toggle;

  // ── Check brain status ──────────────────────────────────
  async function _checkBrainStatus() {
    try {
      const r = await fetch('/api/coco/brain/status');
      const d = await r.json();
      if (d.canReason) {
        _setStatus('🟢 AI đang hoạt động');
      } else {
        _setStatus('🟡 Chế độ cơ bản');
      }
    } catch(e) {
      _setStatus('🟡 Đang kết nối');
    }
    // Hiện tin nhắn chào
    _appendMsg('bot', _formatText(WELCOME_MSG[_page] || WELCOME_MSG.default));
    _setChips(QUICK_CHIPS[_page] || QUICK_CHIPS.default);
  }

  // ── Send message ────────────────────────────────────────
  async function _send() {
    const text = input.value.trim();
    if (!text || _busy) return;

    input.value = '';
    _busy = true;
    sendBtn.disabled = true;
    chips.innerHTML  = '';

    _appendMsg('user', text);

    // Thêm vào history client-side (không gửi lịch sử lên — server có session)
    _history.push({ role: 'user', content: text });
    if (_history.length > MAX_HISTORY) _history = _history.slice(-MAX_HISTORY);

    setTimeout(_showTyping, 120);

    try {
      const res = await fetch(API_ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // gửi session cookie để server biết userId
        body: JSON.stringify({
          text,
          message:   text,     // cả 2 field để tương thích route cũ và mới
          sessionId: _sessionId,
          userType:  _page === 'admin' ? 'admin' : _page === 'shipper' ? 'shipper' : _page === 'partner' ? 'partner' : 'customer',
        }),
      });

      _hideTyping();

      if (!res.ok) throw new Error('HTTP ' + res.status);

      const data = await res.json();

      if (!data.success) throw new Error(data.message || 'Coco lỗi');

      const replyText = data.text || data.message || 'Em không hiểu câu này, anh/chị thử hỏi lại nhé 🙏';
      _appendMsg('bot', _formatText(replyText));
      _history.push({ role: 'assistant', content: replyText });

      // Cập nhật status badge
      if (data.backend === 'groq' || data.canReason) {
        _setStatus('🟢 AI đang hoạt động');
      } else {
        _setStatus('🟡 Chế độ cơ bản');
      }

      // Quick chips tiếp theo
      _setChips(QUICK_CHIPS[_page] || QUICK_CHIPS.default);

    } catch (err) {
      _hideTyping();
      console.error('[Coco Widget]', err);
      _appendMsg('bot',
        'Em gặp sự cố kết nối 😔<br>Thử lại sau hoặc liên hệ <strong>support@crabor.vn</strong> nhé!'
      );
      _setChips(QUICK_CHIPS[_page] || QUICK_CHIPS.default);
      _setStatus('🔴 Gặp lỗi');
    }

    _busy = false;
    sendBtn.disabled = false;
    input.focus();
  }

  // ── Quick chip click ────────────────────────────────────
  function _ask(q) {
    input.value = q;
    _send();
  }

  // ── Expose to global (onclick handlers trong HTML) ──────
  window._cocoSend  = _send;
  window._cocoAsk   = _ask;
  window.toggleCrabot = _toggle; // backward compat với code cũ
  window.crabotAsk  = _ask;
  window.crabotSend = _send;

  // ── Badge notification sau 3 giây ──────────────────────
  setTimeout(function () {
    if (!_open && !_notified) {
      badge.style.display = 'flex';
      badge.textContent   = '1';
    }
  }, 3000);

  // ── Xử lý nếu trang đã có chatbot cũ (để tránh trùng) ─
  // Ẩn các widget cũ nếu có
  const oldFab = document.getElementById('crabotFab');
  const oldWin = document.getElementById('crabotWin') || document.getElementById('crabotWindow');
  if (oldFab && oldFab !== fab) oldFab.style.display = 'none';
  if (oldWin && oldWin !== win) oldWin.style.display = 'none';

  console.log('[Coco Widget v2] ✅ Loaded — endpoint:', API_ENDPOINT, '| page:', _page, '| session:', _sessionId);
})();
