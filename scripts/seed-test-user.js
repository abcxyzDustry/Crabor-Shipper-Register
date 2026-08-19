require('dotenv').config();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, dbName: 'crabor' });
    const userSchema = new mongoose.Schema({ phone: String, loyaltyPts: Number, totalSpent: Number, totalOrders: Number, fullName: String, role: String }, { timestamps: true });
    const User = mongoose.models.User || mongoose.model('User', userSchema);
    const phone = '0999999001';
    const user = await User.findOneAndUpdate(
      { phone },
      { $set: { phone, loyaltyPts: 150, totalSpent: 1500, totalOrders: 15, fullName: 'Test Loyalty', role: 'customer' } },
      { upsert: true, new: true }
    );
    console.log('USER:', user._id.toString(), 'pts=', user.loyaltyPts);
  } catch (e) { console.error('ERR:', e.message); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
})();