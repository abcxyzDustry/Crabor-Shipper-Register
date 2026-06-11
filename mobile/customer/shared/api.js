import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

export const BASE_URL = 'https://crabor-shipper-register.onrender.com';

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// ── Session cookie ────────────────────────────────────────────
let sessionCookie = '';

export const setSessionCookie = async (cookie) => {
  sessionCookie = cookie;
  if (cookie) await SecureStore.setItemAsync('session_cookie', cookie);
  else await SecureStore.deleteItemAsync('session_cookie');
};

export const clearSession = async () => {
  sessionCookie = '';
  await SecureStore.deleteItemAsync('session_cookie');
};

// ── Request interceptor ───────────────────────────────────────
api.interceptors.request.use(async (config) => {
  if (!sessionCookie) {
    sessionCookie = await SecureStore.getItemAsync('session_cookie') || '';
  }
  if (sessionCookie) config.headers['Cookie'] = sessionCookie;
  return config;
});

// ── Response interceptor: auto-unwrap res.data ────────────────
api.interceptors.response.use(
  async (res) => {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      await setSessionCookie(raw.split(';')[0]);
    }
    return res.data;
  },
  (err) => {
    if (err.response?.status === 401) clearSession();
    const message =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'Lỗi không xác định';
    return Promise.reject({ status: err.response?.status || 0, message, data: err.response?.data });
  }
);

// ══════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════
export const AuthAPI = {
  me:              ()       => api.get('/api/auth/me'),
  loginGoogle:     (token)  => api.post('/api/auth/google',           { accessToken: token }),
  loginForm:       (e, p)   => api.post('/api/auth/login-form',       { email: e, password: p }),
  register:        (data)   => api.post('/api/auth/register',         data),
  sendOtpEmail:    (email)  => api.post('/api/auth/send-otp-email',   { email }),
  verifyOtpEmail:  (e, c)   => api.post('/api/auth/verify-otp-email', { email: e, code: c }),
  sendOtp:         (phone)  => api.post('/api/auth/send-otp',         { phone }),
  verifyOtp:       (p, c)   => api.post('/api/auth/verify-otp',       { phone: p, code: c }),
  logout:          ()       => api.post('/api/auth/logout'),
  checkAccount:    (val)    => api.post('/api/auth/check-account',  { identifier: val }),
  setPassword:     (data)   => api.post('/api/auth/set-password',   data),
};

// ══════════════════════════════════════════════════════════════
//  FOOD & ORDERS
// ══════════════════════════════════════════════════════════════
export const FoodAPI = {
  getPartners:    (params) => api.get('/api/food-partners',          { params }),
  getFeatured:    ()       => api.get('/api/food-partners/featured'),
  getPartner:     (id)     => api.get(`/api/food-partners/${id}`),
  getMenu:        (id)     => api.get(`/api/food-partners/${id}/menu`),
  getFlashDeals:  ()       => api.get('/api/flash-deals'),
  getBanners:     ()       => api.get('/api/banners'),
  clickBanner:    (id)     => api.post(`/api/banners/${id}/click`),
  placeOrder:     (data)   => api.post('/api/order',                 data),
  getMyOrders:    ()       => api.get('/api/orders/my'),
  getOrder:       (id)     => api.get(`/api/orders/${id}`),
  rateOrder:      (id, d)  => api.post(`/api/orders/${id}/rate`,     d),
  cancelOrder:    (id)     => api.patch(`/api/orders/${id}/cancel`),
  checkVoucher:   (code)   => api.get(`/api/vouchers/validate?code=${code}`),
  getMyVouchers:  ()       => api.get('/api/vouchers/my'),
  reorder:        (id)     => api.post(`/api/orders/${id}/reorder`),
  getOrderChat:   (id)     => api.get(`/api/orders/${id}/chat`),
  sendOrderChat:  (id, msg)=> api.post(`/api/orders/${id}/chat`,     { message: msg }),
};

// ══════════════════════════════════════════════════════════════
//  WALLET & FINANCE
// ══════════════════════════════════════════════════════════════
export const WalletAPI = {
  get:             ()       => api.get('/api/wallet'),
  withdraw:        (data)   => api.post('/api/wallet/withdraw',               data),
  exchangeVoucher: (amt)    => api.post('/api/wallet/exchange-voucher',       { amount: amt }),
  bnplEligibility: ()       => api.get('/api/bnpl/eligibility'),
  bnplSummary:     ()       => api.get('/api/bnpl/summary'),
  bnplPayQR:       (invId)  => api.post(`/api/bnpl/invoice/${invId}/prepare-pay`),
  bnplInstallment: (id, t)  => api.post(`/api/bnpl/invoice/${id}/installment`,{ terms: t }),
  loanEligibility: ()       => api.get('/api/loan/eligibility'),
  loanApply:       (data)   => api.post('/api/loan/apply',                    data),
  myLoans:         ()       => api.get('/api/loan/my'),
};

// ══════════════════════════════════════════════════════════════
//  USER & ADDRESSES
// ══════════════════════════════════════════════════════════════
export const UserAPI = {
  getMe:          ()      => api.get('/api/auth/me'),
  updateProfile:  (data)  => api.patch('/api/users/profile',       data),
  updateBank:     (data)  => api.patch('/api/users/bank',          data),
  getAddresses:   ()      => api.get('/api/users/addresses'),
  saveAddress:    (data)  => api.post('/api/users/addresses',      data),
  deleteAddress:  (id)    => api.delete(`/api/users/addresses/${id}`),
  registerPush:   (t, p)  => api.post('/api/users/push-token',     { token: t, platform: p }),
  unregisterPush: ()      => api.delete('/api/users/push-token'),
};

// ══════════════════════════════════════════════════════════════
//  LOYALTY
// ══════════════════════════════════════════════════════════════
export const LoyaltyAPI = {
  get:    ()    => api.get('/api/loyalty/me'),
  redeem: (pts) => api.post('/api/loyalty/redeem', { points: pts }),
};

// ══════════════════════════════════════════════════════════════
//  SALES
// ══════════════════════════════════════════════════════════════
export const SalesAPI = {
  register:       (data) => api.post('/api/sales/register',    data),
  login:          (data) => api.post('/api/sales/login',       data),
  getMe:          ()     => api.get('/api/sales/me'),
  getLeaderboard: ()     => api.get('/api/sales/leaderboard'),
};

// ══════════════════════════════════════════════════════════════
//  COCO CHAT & SUPPORT - ĐÃ SỬA
// ══════════════════════════════════════════════════════════════
export const CocoAPI = {
  // ✅ Đúng format: { text, sessionId }
  chat: (text, sessionId) => api.post('/api/coco/chat', { text, sessionId }),
  hotline: (text, sessionId) => api.post('/api/coco/hotline', { text, sessionId }),
  sendEmail: (data) => api.post('/api/support/email', data),
};

// ══════════════════════════════════════════════════════════════
//  RIDE (đặt xe công nghệ)
// ══════════════════════════════════════════════════════════════
export const RideAPI = {
  reverseGeocode: (lat, lng)                    => api.get(`/api/ride/geocode?lat=${lat}&lng=${lng}`),
  forwardGeocode: (address)                     => api.get(`/api/ride/geocode?address=${encodeURIComponent(address)}`),
  estimate:       (fromLat, fromLng, toLat, toLng) =>
    api.get(`/api/ride/estimate?fromLat=${fromLat}&fromLng=${fromLng}&toLat=${toLat}&toLng=${toLng}`),
  getSurge:       ()     => api.get('/api/ride/surge'),
  book:           (data) => api.post('/api/ride/book',       data),
  getMyRides:     ()     => api.get('/api/ride/my'),
  cancel:         (id)   => api.patch(`/api/ride/${id}/cancel`),
  getDetail:      (id)   => api.get(`/api/ride/${id}`),
};

// ══════════════════════════════════════════════════════════════
//  PUSH & VERSION
// ══════════════════════════════════════════════════════════════
export const PushAPI = {
  registerToken:   (token, platform) => UserAPI.registerPush(token, platform),
  unregisterToken: ()                => UserAPI.unregisterPush(),
};

export const VersionAPI = {
  check: () => api.get('/api/health'),
};

// ══════════════════════════════════════════════════════════════
//  NOVA & GROWTH
// ══════════════════════════════════════════════════════════════
export const NovaAPI = {
  partnerStatus: (id)     => api.get(`/api/nova/partner/${id}/status`),
  pricing:       (params) => api.get('/api/coco/ops/pricing', { params }),
};

export const GrowthAPI = {
  recommend: () => api.get('/api/coco/ops/growth/recommend'),
};

// ══════════════════════════════════════════════════════════════
//  LAUNDRY & CLEANING
// ══════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════
//  CUSTOMER API — alias backward compatible
// ══════════════════════════════════════════════════════════════
export const CustomerAPI = {
  getMe:               ()         => AuthAPI.me(),
  getBanners:          ()         => FoodAPI.getBanners(),
  getFlashDeals:       ()         => FoodAPI.getFlashDeals(),
  getFeaturedPartners: ()         => FoodAPI.getFeatured(),
  getFoodPartners:     (params)   => FoodAPI.getPartners(params),
  getPartnerMenu:      (id)       => FoodAPI.getMenu(id),
  getOrders:           ()         => FoodAPI.getMyOrders(),
  getOrderDetail:      (id)       => FoodAPI.getOrder(id),
  createOrder:         (data)     => FoodAPI.placeOrder(data),
  rateOrder:           (id, data) => FoodAPI.rateOrder(id, data),
  reorder:             (id)       => FoodAPI.reorder(id),
  getOrderChat:        (id)       => FoodAPI.getOrderChat(id),
  sendOrderChat:       (id, msg)  => FoodAPI.sendOrderChat(id, msg),
  validateVoucher:     (code)     => FoodAPI.checkVoucher(code),
  getAddresses:        ()         => UserAPI.getAddresses(),
  addAddress:          (data)     => UserAPI.saveAddress(data),
  deleteAddress:       (id)       => UserAPI.deleteAddress(id),
  getSearchHistory:    ()         => api.get('/api/users/search-history'),
  addSearchHistory:    (query)    => api.post('/api/users/search-history', { query }),
  getWallet:           ()         => WalletAPI.get(),
  withdraw:            (data)     => WalletAPI.withdraw(data),
  exchangeVoucher:     (amount)   => WalletAPI.exchangeVoucher(amount),
  getBNPLEligibility:  ()         => WalletAPI.bnplEligibility(),
  getBNPLSummary:      ()         => WalletAPI.bnplSummary(),
  useBNPL:             (data)     => api.post('/api/bnpl/use', data),
  getLoanEligibility:  ()         => WalletAPI.loanEligibility(),
  applyLoan:           (data)     => WalletAPI.loanApply(data),
  getMyLoans:          ()         => WalletAPI.myLoans(),
  getVouchers:         ()         => FoodAPI.getMyVouchers(),
  getLoyalty:          ()         => LoyaltyAPI.get(),
  redeemLoyalty:       (pts)      => LoyaltyAPI.redeem(pts),
  // ✅ SỬA: chat nhận text + sessionId
  cocoChat:            (text, sessionId) => CocoAPI.chat(text, sessionId),
  submitSupport:       (data)     => CocoAPI.sendEmail(data),
  clickBanner:         (id)       => FoodAPI.clickBanner(id),
  validateRef:         (code)     => api.get(`/api/validate-ref/${code}`),
  getEarlybird:        ()         => api.get('/api/public/earlybird'),
  getPaymentPlan:      ()         => api.get('/api/payment/plan'),
  updateBankInfo:      (data)     => UserAPI.updateBank(data),
  completeProfile:     (data)     => api.post('/api/auth/complete-profile', data),
};

export default api;