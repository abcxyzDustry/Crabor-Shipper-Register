import express from 'express';
import { sendStudyReminder } from '../../utils/reminder.js';

const router = express.Router();
const CRON_SECRET = process.env.CRON_SECRET || 'hocho-cron-secret';

// Endpoint để dịch vụ cron NGOÀI (vd: cron-job.org) gọi vào, phòng trường hợp
// server (Render free tier) bị ngủ nên cron nội bộ trong code không chạy đúng giờ.
// Gọi: GET /api/cron/send-reminder?secret=xxx  lúc 6h30 + mỗi giờ sau đó.
router.get('/send-reminder', async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (secret !== CRON_SECRET) {
    return res.status(401).json({ success: false, message: 'Không được phép' });
  }
  try {
    const result = await sendStudyReminder();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi gửi thông báo: ' + err.message });
  }
});

export default router;
