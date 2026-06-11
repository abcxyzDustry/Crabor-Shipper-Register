// ============================================================
// CRABOR Partner Shared API Service
// ============================================================
import AsyncStorage from '@react-native-async-storage/async-storage';

export const BASE_URL = 'https://crabor-shipper-register.onrender.com';

const SESSION_KEY = 'crabor_session_id';
const COOKIE_KEY  = 'crabor_session_cookie';

class ApiService {
  constructor() {
    this.sessionId = null;
    this.cookieStr = null;
  }

  async loadSession() {
    if (!this.sessionId) {
      this.sessionId = await AsyncStorage.getItem(SESSION_KEY) || null;
      this.cookieStr = await AsyncStorage.getItem(COOKIE_KEY) || null;
    }
  }

  async saveSession(sessionId, cookieStr) {
    this.sessionId = sessionId;
    this.cookieStr = cookieStr;
    if (sessionId) await AsyncStorage.setItem(SESSION_KEY, sessionId);
    if (cookieStr) await AsyncStorage.setItem(COOKIE_KEY, cookieStr);
  }

  async clearSession() {
    this.sessionId = null;
    this.cookieStr = null;
    await AsyncStorage.multiRemove([SESSION_KEY, COOKIE_KEY]);
  }

  // Legacy compat
  setSessionCookie(c) { this.cookieStr = c; }
  clearAuth() { this.clearSession(); }

  async getHeaders(extra = {}) {
    await this.loadSession();
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.cookieStr) headers['Cookie'] = this.cookieStr;
    if (this.sessionId) headers['X-Session-ID'] = this.sessionId;
    return headers;
  }

  async request(method, path, body = null, opts = {}) {
    const url = `${BASE_URL}${path}`;
    const headers = await this.getHeaders(opts.headers || {});
    const config = { method, headers, credentials: 'include' };
    if (body) config.body = JSON.stringify(body);

    try {
      const res = await fetch(url, config);

      // Capture Set-Cookie nếu có
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const c = setCookie.split(';')[0];
        this.cookieStr = c;
        await AsyncStorage.setItem(COOKIE_KEY, c);
      }

      const data = await res.json().catch(() => ({}));

      // Capture sessionId từ body nếu server trả về
      if (data.sessionId) {
        await this.saveSession(data.sessionId, data.cookie || this.cookieStr);
      }

      if (!res.ok) throw { status: res.status, message: data.message || data.error || 'Lỗi không xác định', data };
      return data;
    } catch (err) {
      if (err.status) throw err;
      throw { status: 0, message: 'Không thể kết nối server. Kiểm tra mạng!', data: null };
    }
  }

  get(path, opts)         { return this.request('GET',    path, null, opts); }
  post(path, body, opts)  { return this.request('POST',   path, body, opts); }
  patch(path, body, opts) { return this.request('PATCH',  path, body, opts); }
  delete(path, opts)      { return this.request('DELETE', path, null, opts); }
}

export const api = new ApiService();

// ─── Auth endpoints ─────────────────────────────────────────
export const AuthAPI = {
  sendPartnerOTP:        (phone) => api.post('/api/auth/send-otp', { phone, type: 'partner_login' }),
  sendPartnerEmailOTP:   (email) => api.post('/api/auth/send-otp-email/partner', { email }),
  verifyPartnerOTP:      (phone, otp) => api.post('/api/auth/verify-otp', { phone, otp, type: 'partner_login' }),
  verifyPartnerEmailOTP: (email, otp, token) => api.post('/api/auth/verify-otp-email/partner', { email, otp, token }),
  createPartnerSession:  (phone) => api.post('/api/partner/session', { phone }),
};

// ─── Partner endpoints ────────────────────────────────────────
export const PartnerAPI = {
  getMe:          () => api.get('/api/partner/me'),
  getOrders:      () => api.get('/api/partner/orders'),
  acceptOrder:    (id) => api.patch(`/api/partner/orders/${id}`, { action: 'accept' }),
  rejectOrder:    (id) => api.patch(`/api/partner/orders/${id}`, { action: 'reject' }),
  getMenu:        () => api.get('/api/partner/menu'),
  addItem:        (data) => api.post('/api/partner/menu', data),
  updateItem:     (id, data) => api.patch(`/api/partner/menu/${id}`, data),
  deleteItem:     (id) => api.delete(`/api/partner/menu/${id}`),
  getStats:       () => api.get('/api/partner/stats'),
  getRevenueChart:() => api.get('/api/partner/revenue-chart'),
  getWallet:      () => api.get('/api/wallet'),
  withdraw:       (data) => api.post('/api/wallet/withdraw', data),
  setAccepting:   (accepting) => api.patch('/api/partner/accepting', { accepting, isAccepting: accepting }),
  cocoChat:       (messages) => api.post('/api/coco/chat', { messages }),
};

// ─── Version check ────────────────────────────────────────────
export const VersionAPI = {
  check: () => api.get('/api/health'),
};
