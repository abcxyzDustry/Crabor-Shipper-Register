import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET = process.env.JWT_SECRET || 'hocho-dev-secret-doi-truoc-khi-deploy-thuc-te';

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const comparePassword = (plain, hash) => bcrypt.compare(plain, hash);

export const generateToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });

export const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

// Middleware xác thực CUSTOMER — yêu cầu header: Authorization: Bearer <token>
export const authCustomer = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const decoded = verifyToken(token);
    if (decoded.role !== 'customer') {
      return res.status(403).json({ success: false, message: 'Không có quyền truy cập' });
    }
    req.customerId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
  }
};

// Middleware xác thực PARTNER
export const authPartner = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const decoded = verifyToken(token);
    if (decoded.role !== 'partner') {
      return res.status(403).json({ success: false, message: 'Không có quyền truy cập' });
    }
    req.partnerId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
  }
};

// Middleware chấp nhận CẢ customer và partner — dùng cho route chung như chat
export const authEither = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const decoded = verifyToken(token);
    if (decoded.role !== 'customer' && decoded.role !== 'partner') {
      return res.status(403).json({ success: false, message: 'Không có quyền truy cập' });
    }
    req.userId = decoded.id;
    req.userRole = decoded.role; // 'customer' | 'partner'
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
  }
};

// Middleware xác thực ADMIN — JWT thật (thay cho kiểu secret tĩnh cũ)
export const authAdmin = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });

    const decoded = verifyToken(token);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Không có quyền truy cập' });
    }
    req.adminId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
  }
};
