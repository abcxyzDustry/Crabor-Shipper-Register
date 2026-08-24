// ============================================================
// CRABOR — Visa Developer Platform Client (mTLS + Basic Auth)
// Dùng cho: Visa Direct (chuyển tiền 1-chạm vào thẻ Visa shipper/khách)
//
// BẢO MẬT:
//  - Private key + certs nằm trong keys/visa/ (gitignored, KHÔNG commit)
//  - VISA_USER_ID / VISA_PASSWORD đặt trong .env
// ============================================================
const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require("axios");

const KEY_DIR = path.join(__dirname, "keys", "visa");
const crypto = require("crypto");

const VISA_BASE_URL = process.env.VISA_BASE_URL || "https://sandbox.api.visa.com";
const VISA_USER_ID = process.env.VISA_USER_ID || "";
const VISA_PASSWORD = process.env.VISA_PASSWORD || "";
// Shared secret để sinh x-pay-token (kiểu xác thực phổ biến của VDC)
const VISA_SHARED_SECRET = process.env.VISA_SHARED_SECRET || "";

function loadCert(file) {
  const p = path.join(KEY_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`[VisaClient] Thiếu file chứng chỉ: ${p}`);
  return fs.readFileSync(p);
}

let _agent = null;
function getAgent() {
  if (_agent) return _agent;
  // One-way TLS: tin server Visa qua CA chain (VDC hiện đại dùng Basic Auth, không cần client cert)
  const ca = [
    loadCert("digicert-root.pem"),
    loadCert("sbx-root.pem"),
    loadCert("sbx-inter.pem"),
  ];
  const opts = { ca, rejectUnauthorized: true, keepAlive: true };
  // Nếu có client cert (mTLS kiểu cũ) thì dùng thêm
  const certFile = process.env.VISA_CERT_FILE;
  if (certFile && fs.existsSync(path.join(KEY_DIR, certFile))) {
    opts.cert = loadCert(certFile);
    opts.key = loadCert(process.env.VISA_KEY_FILE || "private-key.pem");
  }
  _agent = new https.Agent(opts);
  return _agent;
}

function isConfigured() {
  return !!(VISA_USER_ID && VISA_PASSWORD && fs.existsSync(path.join(KEY_DIR, "private-key.pem")));
}

/**
 * Sinh x-pay-token theo chuẩn VDC:
 * preHashString = timestamp + resourcePath + "?" + queryString + ":" + sha256Hex(body)
 * token = "xv2:" + timestamp + ":" + hmacSHA256Hex(sharedSecret, preHashString)
 */
function buildXPayToken(resourcePath, queryString = "", body = null) {
  const ts = Math.floor(Date.now() / 1000);
  const bodyStr = body ? JSON.stringify(body) : "";
  const payload = `${ts}${resourcePath}?${queryString}:${crypto.createHash("sha256").update(bodyStr).digest("hex")}`;
  const hash = crypto.createHmac("sha256", VISA_SHARED_SECRET).update(payload).digest("hex");
  return `xv2:${ts}:${hash}`;
}

/**
 * Gọi API Visa Developer
 * Auth mode tự chọn: có VISA_SHARED_SECRET → x-pay-token; ngược lại Basic Auth (+mTLS nếu có cert)
 * @param {string} method  GET | POST | PUT
 * @param {string} apiPath ví dụ: /visadirect/fundstransfer/v1/pushfunds
 * @param {object|null} body
 * @param {string} qs query string (không có dấu ?)
 */
async function visaRequest(method, apiPath, body = null, qs = "") {
  const useXPay = !!VISA_SHARED_SECRET;
  if (!useXPay && !isConfigured()) {
    throw new Error("Visa Dev chưa cấu hình đủ: cần VISA_SHARED_SECRET hoặc VISA_USER_ID + VISA_PASSWORD");
  }
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (useXPay) headers["x-pay-token"] = buildXPayToken(apiPath, qs, body);

  const res = await axios({
    method,
    url: `${VISA_BASE_URL}${apiPath}${qs ? "?" + qs : ""}`,
    data: body,
    httpsAgent: getAgent(),
    auth: useXPay ? undefined : { username: VISA_USER_ID, password: VISA_PASSWORD },
    headers,
    timeout: 20000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const err = new Error(res.data?.errorMessage || res.data?.errorMessages?.[0]?.message || `Visa HTTP ${res.status}`);
    err.status = res.status;
    err.details = res.data;
    throw err;
  }
  return res.data;
}

// ── Visa Direct — Push Funds (chuyển tiền vào thẻ Visa) ──
async function pushFunds({ recipientPan, amount, currency = "VND", purpose = "CRABOR_PAYOUT" }) {
  return visaRequest("POST", "/visadirect/fundstransfer/v1/pushfunds", {
    systemsTraceAuditNumber: String(Date.now()).slice(-10),
    acquiringBin: process.env.VISA_ACQUIRING_BIN || "408999",
    acquiringCountryCode: "704",
    senderCardExpirationMonth: "12",
    senderCardExpirationYear: "2030",
    amount: String(amount),
    recipientPrimaryAccountNumber: String(recipientPan),
    recipientCurrencyCode: currency,
    businessApplicationId: "FD",
    transactionIdentifier: Date.now() % 1000000000000,
    memo: purpose,
  });
}

module.exports = { isConfigured, visaRequest, pushFunds };
