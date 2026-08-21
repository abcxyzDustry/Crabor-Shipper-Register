import express from 'express';

const router = express.Router();

router.post('/notify', async (req, res) => {
  const { event, order_code, customer_name, school, reason, amount, time } = req.body;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn('⚠️ DISCORD_WEBHOOK_URL is not set. Skipping notification.');
    return res.json({ success: false, message: 'DISCORD_WEBHOOK_URL is not configured' });
  }

  // Determine host for admin dashboard link
  const appUrl = process.env.APP_URL || (req.get('host') ? `${req.protocol}://${req.get('host')}` : 'https://hocho.com');
  const adminUrl = `${appUrl}/admin`;

  let embed = {
    title: '',
    description: '',
    color: 0,
    fields: [],
    timestamp: new Date().toISOString()
  };

  const formattedAmount = amount ? new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount) : '200.000đ';

  if (event === 'new_order') {
    embed.title = '🔔 ĐƠN HÀNG MỚI ĐÃ ĐƯỢC TẠO';
    embed.description = `Có một đơn hàng mới vừa được tạo trên hệ thống.\n\n👉 [Đi tới Admin Dashboard](${adminUrl}) để quản lý.`;
    embed.color = 3447003; // Màu xanh lam (Blue)
    embed.fields = [
      { name: 'Mã đơn', value: order_code || 'N/A', inline: true },
      { name: 'Tên KH', value: customer_name || 'N/A', inline: true },
      { name: 'Trường', value: school || 'N/A', inline: true },
      { name: 'Lý do hỗ trợ', value: reason || 'N/A', inline: false },
      { name: 'Số tiền', value: formattedAmount, inline: true },
      { name: 'Thời gian đặt', value: time || new Date().toLocaleString('vi-VN'), inline: true }
    ];
  } else if (event === 'payment_claimed') {
    embed.title = '⏳ KHÁCH HÀNG BÁO ĐÃ THANH TOÁN';
    embed.description = `Khách hàng đã bấm nút **"Đã thanh toán"**.\n\n⚠️ Admin vui lòng kiểm tra tài khoản ngân hàng và xác nhận đơn.\n\n👉 [Đi tới Admin Dashboard](${adminUrl}) để xác nhận.`;
    embed.color = 15844367; // Màu vàng (Yellow)
    embed.fields = [
      { name: 'Mã đơn', value: order_code || 'N/A', inline: true },
      { name: 'Số tiền', value: formattedAmount, inline: true }
    ];
  } else if (event === 'payment_confirmed') {
    embed.title = '✅ ĐÃ XÁC NHẬN THANH TOÁN';
    embed.description = `Admin đã xác nhận thanh toán thành công cho đơn hàng.\nĐơn hàng đã chuyển sang trạng thái chờ ghép cặp (matching).\n\n👉 [Đi tới Admin Dashboard](${adminUrl})`;
    embed.color = 3066993; // Màu xanh lá (Green)
    embed.fields = [
      { name: 'Mã đơn', value: order_code || 'N/A', inline: true },
      { name: 'Trạng thái', value: 'Đã xác nhận thanh toán (matching)', inline: true }
    ];
  } else {
    return res.status(400).json({ success: false, message: 'Event không hợp lệ' });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [embed]
      })
    });

    if (response.ok) {
      return res.json({ success: true, message: 'Gửi Discord notification thành công' });
    } else {
      const errorText = await response.text();
      console.error('❌ Discord webhook error response:', errorText);
      return res.status(response.status).json({ success: false, message: 'Discord API trả về lỗi', details: errorText });
    }
  } catch (err) {
    console.error('❌ Lỗi gửi Discord webhook:', err);
    return res.status(500).json({ success: false, message: 'Lỗi internal khi gửi Discord webhook', error: err.message });
  }
});

export default router;
