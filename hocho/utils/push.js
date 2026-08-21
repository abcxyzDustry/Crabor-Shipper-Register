// Gửi push notification qua Expo Push API — không cần thêm SDK, gọi thẳng REST API
// Docs: https://docs.expo.dev/push-notifications/sending-notifications/

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// tokens: string[] (Expo push token dạng "ExponentPushToken[xxxx]")
export async function sendPushNotifications(tokens, { title, body, data = {} }) {
  const validTokens = (tokens || []).filter(t => typeof t === 'string' && t.startsWith('ExponentPushToken'));
  if (validTokens.length === 0) return { sent: 0 };

  // Expo giới hạn tối đa 100 message/request -> chia batch
  const chunkSize = 100;
  let sent = 0;
  for (let i = 0; i < validTokens.length; i += chunkSize) {
    const batch = validTokens.slice(i, i + chunkSize).map(token => ({
      to: token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
    }));
    try {
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      sent += batch.length;
    } catch (err) {
      console.error('❌ Lỗi gửi push notification:', err.message);
    }
  }
  return { sent };
}
