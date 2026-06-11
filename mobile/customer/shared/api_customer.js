// ============================================================
// CRABOR Customer Shared API — Fixed session persistence
// ============================================================
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

export const BASE_URL = 'https://crabor-shipper-register.onrender.com';

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

let _sessionCookie = '';

export const setSessionCookie = async (cookie) => {
  _sessionCookie = cookie || '';
  try {
    if (cookie) await SecureStore.setItemAsync('session_cookie', cookie);
    else         await SecureStore.deleteItemAsync('session_cookie');
  } catch(_) {}
};

export const clearSession = async () => {
  _sessionCookie = '';
  try { await SecureStore.deleteItemAsync('session_cookie'); } catch(_) {}
};

// ── Request: luôn đính cookie ──────────────────────────────
api.interceptors.request.use(async (config) => {
  if (!_sessionCookie) {
    try { _sessionCookie = await SecureStore.getItemAsync('session_cookie') || ''; } catch(_) {}
  }
  if (_sessionCookie) config.headers['Cookie'] = _sessionCookie;
  return config;
});

// ── Response: lưu cookie mới, unwrap data ──────────────────
api.interceptors.response.use(
  async (res) => {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      await setSessionCookie(raw.split(';')[0]);
    }
    return res.data;
  },
  async (err) => {
    if (err.response?.status === 401) await clearSession();
    const message = err.response?.data?.message || err.response?.data?.error || err.message || 'Lỗi không xác định';
    return Promise.reject({ status: err.response?.status || 0, message, data: err.response?.data });
  }
);

export const api = new ApiService();

// ─── Auth endpoints ─────────────────────────────────────────
export const AuthAPI = {
  // Customer
  sendOTP: (phone) => api.post('/api/auth/send-otp', { phone, type: 'customer_login' }),
  sendEmailOTP: (email) => api.post('/api/auth/send-otp-email', { email }),
  verifyOTP: (phone, otp) => api.post('/api/auth/verify-otp', { phone, otp, type: 'customer_login' }),
  verifyEmailOTP: (email, otp, token) => api.post('/api/auth/verify-otp-email', { email, otp, token }),
  completeProfile: (data) => api.post('/api/auth/complete-profile', data),

  // Shipper
  sendShipperOTP: (phone) => api.post('/api/auth/send-otp', { phone, type: 'shipper_login' }),
  sendShipperEmailOTP: (email) => api.post('/api/auth/send-otp-email/shipper', { email }),
  verifyShipperOTP: (phone, otp) => api.post('/api/auth/verify-otp', { phone, otp, type: 'shipper_login' }),
  verifyShipperEmailOTP: (email, otp, token) => api.post('/api/auth/verify-otp-email/shipper', { email, otp, token }),
  createShipperSession: (phone) => api.post('/api/shipper/session', { phone }),

  // Partner
  sendPartnerOTP: (phone) => api.post('/api/auth/send-otp', { phone, type: 'partner_login' }),
  sendPartnerEmailOTP: (email) => api.post('/api/auth/send-otp-email/partner', { email }),
  verifyPartnerOTP: (phone, otp) => api.post('/api/auth/verify-otp', { phone, otp, type: 'partner_login' }),
  verifyPartnerEmailOTP: (email, otp, token) => api.post('/api/auth/verify-otp-email/partner', { email, otp, token }),
  createPartnerSession: (phone) => api.post('/api/partner/session', { phone }),

  // Sales
  sendSalesOTP: (phone) => api.post('/api/auth/send-otp', { phone, type: 'sales_login' }),
  verifySalesOTP: (phone, otp) => api.post('/api/auth/verify-otp', { phone, otp, type: 'sales_login' }),
};

// ─── Customer endpoints ──────────────────────────────────────
export const CustomerAPI = {
  getMe: () => api.get('/api/users/me'),
  getBanners: () => api.get('/api/banners'),
  getFlashDeals: () => api.get('/api/flash-deals'),
  getFeaturedPartners: () => api.get('/api/food-partners/featured'),
  getFoodPartners: (params = '') => api.get(`/api/food-partners${params}`),
  getPartnerMenu: (id) => api.get(`/api/food-partners/${id}/menu`),
  getOrders: () => api.get('/api/orders'),
  getOrderDetail: (id) => api.get(`/api/orders/${id}`),
  createOrder: (data) => api.post('/api/orders', data),
  rateOrder: (id, data) => api.post(`/api/orders/${id}/rate`, data),
  reorder: (id) => api.post(`/api/orders/${id}/reorder`),
  getOrderChat: (id) => api.get(`/api/orders/${id}/chat`),
  sendOrderChat: (id, msg) => api.post(`/api/orders/${id}/chat`, { message: msg }),
  validateVoucher: (code) => api.get(`/api/vouchers/validate?code=${code}`),
  getAddresses: () => api.get('/api/users/addresses'),
  addAddress: (data) => api.post('/api/users/addresses', data),
  deleteAddress: (label) => api.delete(`/api/users/addresses/${label}`),
  getSearchHistory: () => api.get('/api/users/search-history'),
  addSearchHistory: (query) => api.post('/api/users/search-history', { query }),
  getWallet: () => api.get('/api/wallet'),
  withdraw: (data) => api.post('/api/wallet/withdraw', data),
  exchangeVoucher: (amount) => api.post('/api/wallet/exchange-voucher', { amount }),
  getBNPLEligibility: () => api.get('/api/bnpl/eligibility'),
  useBNPL: (data) => api.post('/api/bnpl/use', data),
  getBNPLSummary: () => api.get('/api/bnpl/summary'),
  getLoanEligibility: () => api.get('/api/loan/eligibility'),
  applyLoan: (data) => api.post('/api/loan/apply', data),
  getMyLoans: () => api.get('/api/loan/my'),
  getLoyalty: () => api.get('/api/loyalty/me'),
  redeemLoyalty: (points) => api.post('/api/loyalty/redeem', { points }),
  cocoChat: (messages) => api.post('/api/coco/chat', { messages }),
  submitSupport: (data) => api.post('/api/support', data),
  updateBankInfo: (data) => api.patch('/api/users/bank', data),
  validateRef: (code) => api.get(`/api/validate-ref/${code}`),
  getEarlybird: () => api.get('/api/public/earlybird'),
  getPaymentPlan: () => api.get('/api/payment/plan'),
  clickBanner: (id) => api.post(`/api/banners/${id}/click`),
};

// ─── Sales endpoints ─────────────────────────────────────────
export const SalesAPI = {
  register: (data) => api.post('/api/sales/register', data),
  login: (data) => api.post('/api/sales/login', data),
  getMe: () => api.get('/api/sales/me'),
  getLeaderboard: () => api.get('/api/sales/leaderboard'),
};

// ─── Shipper endpoints ────────────────────────────────────────
export const ShipperAPI = {
  getMe: () => api.get('/api/shipper/me'),
  getWallet: () => api.get('/api/wallet/shipper'),
  withdraw: (data) => api.post('/api/wallet/withdraw', data),
  getMissions: () => api.get('/api/shipper/missions'),
  getTier: () => api.get('/api/shipper/tier'),
  getHeatmap: () => api.get('/api/shipper/heatmap'),
  updateLocation: (data) => api.post('/api/shipper/location', data),
  acceptOrder: (id) => api.patch(`/api/orders/${id}/status`, { status: 'shipper_accepted' }),
  updateOrderStatus: (id, status) => api.patch(`/api/orders/${id}/status`, { status }),
  uploadDeliveryPhoto: (id, data) => api.post(`/api/orders/${id}/delivery-photo`, data),
};

// ─── Partner endpoints ────────────────────────────────────────
export const PartnerAPI = {
  getMe: () => api.get('/api/partner/me'),
  getOrders: () => api.get('/api/partner/orders'),
  acceptOrder: (id) => api.patch(`/api/partner/orders/${id}`, { action: 'accept' }),
  rejectOrder: (id) => api.patch(`/api/partner/orders/${id}`, { action: 'reject' }),
  getMenu: () => api.get('/api/partner/menu'),
  addItem: (data) => api.post('/api/partner/menu', data),
  updateItem: (id, data) => api.patch(`/api/partner/menu/${id}`, data),
  deleteItem: (id) => api.delete(`/api/partner/menu/${id}`),
  getStats: () => api.get('/api/partner/stats'),
  getRevenueChart: () => api.get('/api/partner/revenue-chart'),
  getWallet: () => api.get('/api/wallet'),
  withdraw: (data) => api.post('/api/wallet/withdraw', data),
  setAccepting: (accepting) => api.patch('/api/partner/accepting', { accepting }),
  cocoChat: (messages) => api.post('/api/coco/chat', { messages }),
};

// ─── Version check ────────────────────────────────────────────
export const VersionAPI = {
  check: () => api.get('/api/health'),
};
export const LaundryAPI = {
  getProviders:  (params) => api.get('/api/laundry/providers',       { params }),
  getProvider:   (id)     => api.get(`/api/laundry/providers/${id}`),
  getServices:   (id)     => api.get(`/api/laundry/providers/${id}/services`),
  placeOrder:    (data)   => api.post('/api/laundry/order',          data),
  getMyOrders:   ()       => api.get('/api/laundry/orders/my'),
  getOrder:      (id)     => api.get(`/api/laundry/orders/${id}`),
  cancelOrder:   (id)     => api.patch(`/api/laundry/orders/${id}/cancel`),
  rateOrder:     (id, d)  => api.post(`/api/laundry/orders/${id}/rate`, d),
};

// ══════════════════════════════════════════════════════════════
//  CLEANING / GIÚP VIỆC
// ══════════════════════════════════════════════════════════════
export const CleaningAPI = {
  getProviders:  (params) => api.get('/api/cleaning/providers',      { params }),
  getProvider:   (id)     => api.get(`/api/cleaning/providers/${id}`),
  getServices:   (id)     => api.get(`/api/cleaning/providers/${id}/services`),
  placeOrder:    (data)   => api.post('/api/cleaning/order',         data),
  getMyOrders:   ()       => api.get('/api/cleaning/orders/my'),
  getOrder:      (id)     => api.get(`/api/cleaning/orders/${id}`),
  cancelOrder:   (id)     => api.patch(`/api/cleaning/orders/${id}/cancel`),
  rateOrder:     (id, d)  => api.post(`/api/cleaning/orders/${id}/rate`, d),
};
  registerPush:   (t, p)  => api.post('/api/users/push-token',     { token: t, platform: p }),
  unregisterPush: ()      => api.delete('/api/users/push-token'),
};

// ══════════════════════════════════════════════════════════════
//  LOYALTY
// ══════════════════════════════════════════════════════════════
export const LoyaltyAPI = {
  get:    ()    => api.get('/api/loyalty/me'),
  redeem: (pts) => api.post('/api/loyalty/redeem', { points: pts }),

export default api;
