import express from 'express';

const router = express.Router();

// ⚠️ Chatbot dạng rule-based đơn giản (match theo từ khoá) — KHÔNG phải AI thật.
// Khi cần thông minh hơn, có thể nối qua OpenRouter/Claude API giống Coco AI bên CRABOR
// (chỉ cần thêm 1 lệnh gọi fetch tới LLM ở đây thay cho findReply()).
const FAQ = [
  { keywords: ['giá', 'phí', 'bao nhiêu tiền', 'chi phí'], reply: 'Phí dịch vụ học hộ là 200.000đ/lượt, đối tác nhận 140.000đ, nền tảng giữ lại 60.000đ.' },
  { keywords: ['huỷ', 'hủy', 'cancel'], reply: 'Bạn có thể huỷ đơn trước khi đối tác nhận. Tiền sẽ được hoàn vào ví hocho để dùng cho lần đặt sau, không hoàn về ngân hàng.' },
  { keywords: ['rút tiền', 'rút', 'withdraw'], reply: 'Đối tác có thể rút tiền trong mục Ví — yêu cầu rút sẽ được duyệt trong 1-2 giờ.' },
  { keywords: ['thanh toán', 'sepay', 'qr'], reply: 'hocho.com dùng SePay để thanh toán qua chuyển khoản QR. Sau khi chuyển khoản, bấm "Đã thanh toán" để tiếp tục.' },
  { keywords: ['đối tác', 'partner', 'tìm đối tác'], reply: 'Sau khi thanh toán, hệ thống sẽ tự tìm đối tác gần bạn nhất trong vài phút.' },
  { keywords: ['ví', 'wallet'], reply: 'Ví hocho chỉ dùng để thanh toán dịch vụ trên app, không rút ra ngân hàng được.' },
];

const findReply = (text) => {
  const lower = (text || '').toLowerCase();
  for (const item of FAQ) {
    if (item.keywords.some(k => lower.includes(k))) return item.reply;
  }
  return 'Mình chưa hiểu rõ câu hỏi này 🙏 Bạn có thể hỏi về: giá dịch vụ, huỷ đơn, rút tiền, thanh toán, hoặc tìm đối tác.';
};

router.post('/ask', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false, message: 'Thiếu nội dung câu hỏi' });

  const apiKey = process.env.GROQ_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [
            {
              role: 'system',
              content: 'Bạn là trợ lý AI của HoCho.com - nền tảng hỗ trợ sinh viên ốm đau. Trả lời ngắn gọn bằng tiếng Việt về: giá 200k/buổi, đối tác nhận 140k, cách đặt đơn, thanh toán SePay QR. Không trả lời ngoài chủ đề HoCho.'
            },
            {
              role: 'user',
              content: message
            }
          ],
          temperature: 0.7,
          max_tokens: 1024
        })
      });

      if (response.ok) {
        const result = await response.json();
        const reply = result.choices?.[0]?.message?.content;
        if (reply) {
          return res.json({ success: true, data: { reply } });
        }
      }
    } catch (error) {
      console.error('Error calling Groq API, fallback to rule-based chatbot:', error);
    }
  }

  // Fallback rule-based
  res.json({ success: true, data: { reply: findReply(message) } });
});

export default router;
