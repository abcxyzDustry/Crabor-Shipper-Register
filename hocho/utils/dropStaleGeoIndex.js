// Dọn index địa lý (2d/2dsphere) "rác" còn sót lại trên field không còn là GeoJSON.
//
// Bối cảnh lỗi: collection `partners` từng (ở một phiên bản schema cũ) có index
// 2d/2dsphere áp trực tiếp lên field `latitude`/`longitude` dạng Number. Sau khi
// schema đổi sang lưu latitude/longitude là Number thường (không phải GeoJSON),
// index cũ đó KHÔNG tự mất đi — Mongo/Mongoose không tự drop index khi bạn xoá
// khai báo index khỏi schema. Kết quả: mọi lần update latitude/longitude (ví dụ
// khi đối tác bật công tắc nhận đơn) đều gãy với lỗi:
//   "Can't extract geo keys ... geo element must be an array or object"
//
// Hàm này quét toàn bộ index thật sự đang có trên collection, tìm index nào có
// kiểu 2d hoặc 2dsphere, và xoá nó đi. An toàn vì:
//  - Chỉ đụng tới index kiểu geo (2d/2dsphere), không đụng index thường (unique,
//    compound, v.v).
//  - Không xoá field `_id` index mặc định.
//  - Không throw ra ngoài — chỉ log cảnh báo nếu có lỗi, để không chặn server khởi động.
export async function dropStaleGeoIndexes(Model, label) {
  try {
    const indexes = await Model.collection.indexes();
    for (const idx of indexes) {
      if (idx.name === '_id_') continue;
      const isGeo = Object.values(idx.key).some(v => v === '2dsphere' || v === '2d');
      if (isGeo) {
        console.log(`🗑️  [${label}] Phát hiện index geo cũ "${idx.name}" (${JSON.stringify(idx.key)}) — đang xoá...`);
        await Model.collection.dropIndex(idx.name);
        console.log(`✅ [${label}] Đã xoá index geo cũ "${idx.name}"`);
      }
    }
  } catch (err) {
    console.error(`⚠️  [${label}] Lỗi khi kiểm tra/xoá index geo cũ:`, err.message);
  }
}
