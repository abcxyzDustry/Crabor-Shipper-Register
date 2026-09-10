import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import { hashPassword } from './hocho/utils/auth.js';
import Admin from './hocho/models/Admin.js';

const uri = process.env.MONGODB_URI;
console.log('Connecting', uri?.slice(0,40)+'...');
await mongoose.connect(uri);
console.log('Connected DB', mongoose.connection.name);
let admin = await Admin.findOne({ username: 'admin' });
console.log('Found admin:', admin ? admin.username + ' active=' + admin.is_active : 'null');
if(!admin){
  console.log('Creating admin admin/hocho2024admin');
  admin = await Admin.create({ username:'admin', email:'admin@hocho.com', password_hash: await hashPassword('hocho2024admin'), role:'admin', is_active:true });
  console.log('Created', admin._id);
} else {
  console.log('Resetting password to hocho2024admin');
  admin.password_hash = await hashPassword('hocho2024admin');
  admin.is_active = true;
  await admin.save();
  console.log('Reset done');
}
const count = await Admin.countDocuments();
console.log('Total admins', count);
const all = await Admin.find().select('username email is_active role');
console.log(JSON.stringify(all, null, 2));
await mongoose.disconnect();
process.exit(0);
