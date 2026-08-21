import Customer from '../models/Customer.js';
import { sendPushNotifications } from './push.js';

// Gửi thông báo nhắc đặt đơn học hộ tới TẤT CẢ khách hàng có push_token
export async function sendStudyReminder() {
  const customers = await Customer.find({ push_token: { $exists: true, $ne: null } }).select('push_token');
  const tokens = customers.map(c => c.push_token);
  const result = await sendPushNotifications(tokens, {
    title: '🤒 Hôm nay không khoẻ?',
    body: 'Bạn có bệnh trong người và không muốn đi học? Đặt đơn học hộ ngay!',
    data: { type: 'reminder' },
  });
  console.log(`🔔 Đã gửi nhắc nhở tới ${result.sent} khách hàng`);
  return result;
}
