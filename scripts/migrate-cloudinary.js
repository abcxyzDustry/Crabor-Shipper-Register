// Backfill script: chuyển toàn bộ ảnh base64 đang lưu trong MongoDB sang Cloudinary.
// Cách chạy:
//   1) Thêm vào .env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//   2) node scripts/migrate-cloudinary.js          (chạy thật)
//      node scripts/migrate-cloudinary.js --dry-run (chỉ đếm, không ghi)
// Script chỉ xử lý ảnh dạng "data:image/...". URL/PDF/empty được bỏ qua.
require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const axios = require("axios");

const DRY_RUN = process.argv.includes("--dry-run");
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (!MONGODB_URI) { console.error("Thiếu MONGODB_URI trong .env"); process.exit(1); }
if (!cloudName || !apiKey || !apiSecret) {
  console.error("Thiếu CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET trong .env.");
  process.exit(1);
}

// (collection, path, folder) — path là key đơn hoặc "documents.cccdFront"
const TARGETS = [
  ...["cccdFront","cccdBack","selfie","shopFront","shopInside","vehicleImg","productSample","importDoc","licenseImg","driverLicense","vehicleReg"]
    .map(d => ({ coll: "shippers", path: "documents." + d, folder: "docs" })),
  ...["cccdFront","cccdBack","selfie","shopFront","shopInside","vehicleImg","productSample","importDoc","licenseImg","driverLicense","vehicleReg"]
    .map(d => ({ coll: "foodpartners", path: "documents." + d, folder: "docs" })),
  ...["cccdFront","cccdBack","selfie","shopFront","shopInside","vehicleImg","productSample","importDoc","licenseImg","driverLicense","vehicleReg"]
    .map(d => ({ coll: "giatlas", path: "documents." + d, folder: "docs" })),
  ...["cccdFront","cccdBack","selfie","shopFront","shopInside","vehicleImg","productSample","importDoc","licenseImg","driverLicense","vehicleReg"]
    .map(d => ({ coll: "giupviecs", path: "documents." + d, folder: "docs" })),
  ...["cccdFront","cccdBack","selfie","shopFront","shopInside","vehicleImg","productSample","importDoc","licenseImg","driverLicense","vehicleReg"]
    .map(d => ({ coll: "chinaships", path: "documents." + d, folder: "docs" })),
  ...["cccdFront","cccdBack","selfie","shopFront","shopInside","vehicleImg","productSample","importDoc","licenseImg","driverLicense","vehicleReg"]
    .map(d => ({ coll: "ridedrivers", path: "documents." + d, folder: "docs" })),
  { coll: "shippers", path: "avatar", folder: "avatar" },
  { coll: "foodpartners", path: "avatar", folder: "avatar" },
  { coll: "giatlas", path: "avatar", folder: "avatar" },
  { coll: "giupviecs", path: "avatar", folder: "avatar" },
  { coll: "chinaships", path: "avatar", folder: "avatar" },
  { coll: "foodpartners", path: "coverImage", folder: "shop" },
  { coll: "giatlas", path: "coverImage", folder: "shop" },
  { coll: "giupviecs", path: "coverImage", folder: "shop" },
  { coll: "chinaships", path: "coverImage", folder: "shop" },
  { coll: "foodpartners", path: "featuredBanner", folder: "banners" },
  { coll: "foodpartners", path: "featuredBannerVertical", folder: "banners" },
  { coll: "products", path: "image", folder: "menu" },
  { coll: "orders", path: "deliveryPhoto", folder: "orders" },
  { coll: "aibanners", path: "imageUrl", folder: "banners" },
  { coll: "featuredrequests", path: "bannerImage", folder: "banners" },
  { coll: "featuredrequests", path: "bannerVertical", folder: "banners" },
];

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}
function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

async function uploadOne(data, folder) {
  const timestamp = Math.floor(Date.now() / 1000);
  const cdnFolder = "crabor_" + folder;
  const signature = crypto.createHash("sha1")
    .update("folder=" + cdnFolder + "&timestamp=" + timestamp + apiSecret)
    .digest("hex");
  const params = new URLSearchParams();
  params.append("file", data);
  params.append("api_key", apiKey);
  params.append("timestamp", String(timestamp));
  params.append("signature", signature);
  params.append("folder", cdnFolder);
  const r = await axios.post(
    "https://api.cloudinary.com/v1_1/" + cloudName + "/image/upload",
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxContentLength: 25 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024, timeout: 60000 }
  );
  return r.data.secure_url;
}

async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log("Đã kết nối MongoDB." + (DRY_RUN ? "  [DRY RUN — không ghi DB]" : ""));

  const byColl = {};
  for (const t of TARGETS) (byColl[t.coll] = byColl[t.coll] || []).push(t);

  let totalUploaded = 0;
  let totalSkipped = 0;
  let totalDocs = 0;

  for (const [coll, targets] of Object.entries(byColl)) {
    const db = mongoose.connection.db;
    if (!(await db.listCollections({ name: coll }).hasNext())) {
      console.log(`\n[${coll}] bỏ qua (collection không tồn tại)`);
      continue;
    }
    const cursor = db.collection(coll).find({});
    let docs = 0, uploaded = 0, skipped = 0;
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      docs++;
      let changed = false;
      for (const t of targets) {
        const value = getPath(doc, t.path);
        if (typeof value !== "string" || !value.startsWith("data:image")) continue;
        if (Buffer.byteLength(value, "utf8") > 9 * 1024 * 1024) { skipped++; continue; }
        const url = await uploadOne(value, t.folder);
        setPath(doc, t.path, url);
        changed = true;
        uploaded++;
        totalUploaded++;
      }
      if (changed) {
        totalDocs++;
        if (!DRY_RUN) {
          const update = {};
          for (const t of targets) {
            const v = getPath(doc, t.path);
            if (v && v.startsWith("https://")) update["$set"] = update["$set"] || {}, update["$set"][t.path] = v;
          }
          if (update["$set"]) await db.collection(coll).updateOne({ _id: doc._id }, update);
        }
        if (docs % 25 === 0 || uploaded % 50 === 0) process.stdout.write(`\r  [${coll}] scanned=${docs} uploaded=${uploaded}`);
      }
    }
    await cursor.close();
    console.log(`\n[${coll}] docs=${docs} uploaded=${uploaded} skipped=${skipped}`);
  }

  console.log(`\n=== KẾT QUẢ ===`);
  console.log(`Docs được cập nhật: ${totalDocs} (${DRY_RUN ? "chỉ ước lượng" : "đã ghi DB"})`);
  console.log(`Ảnh đã upload Cloudinary: ${totalUploaded}`);
  console.log(`Ảnh bỏ qua (quá lớn / không phải data:image): ${totalSkipped}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
