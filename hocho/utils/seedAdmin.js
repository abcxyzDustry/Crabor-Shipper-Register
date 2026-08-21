import Admin from '../models/Admin.js';
import { hashPassword } from './auth.js';

// Tự tạo 1 admin mặc định nếu collection Admin đang trống — để bạn luôn đăng nhập được
// ngay lần đầu deploy, không cần tự tay thêm document vào MongoDB.
//
// ⚠️ BIẾN MÔI TRƯỜNG BẮT BUỘC PHẢI SET TRÊN PRODUCTION: ADMIN_SEED_PASSWORD
// Nếu không set, hệ thống dùng mật khẩu mặc định "hocho2024admin" — giá trị này
// đã từng được nói ra trong chat/code nên KHÔNG an toàn để dùng thật. Hãy set
// ADMIN_SEED_PASSWORD trên Render trước khi đưa app lên cho người dùng thật.
export async function seedDefaultAdmin() {
  const count = await Admin.countDocuments();
  if (count > 0) return;

  const username = process.env.ADMIN_SEED_USERNAME || 'admin';
  const email = process.env.ADMIN_SEED_EMAIL || 'admin@hocho.com';
  const password = process.env.ADMIN_SEED_PASSWORD || 'hocho2024admin';

  if (!process.env.ADMIN_SEED_PASSWORD) {
    console.warn('\n⚠️  CHƯA SET ADMIN_SEED_PASSWORD — đang dùng mật khẩu mặc định "hocho2024admin".');
    console.warn('⚠️  Đây KHÔNG an toàn cho production. Hãy set biến ADMIN_SEED_PASSWORD trên Render rồi deploy lại.\n');
  }

  await Admin.create({
    username,
    email,
    password_hash: await hashPassword(password),
    role: 'admin',
  });

  console.log(`✅ Đã tạo admin mặc định — username: "${username}"`);
}
