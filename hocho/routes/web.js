import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '../public');

const router = express.Router();

router.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
router.get('/register', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));
router.get('/payment', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'payment.html')));
router.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
router.get('/partner', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'partner.html')));

export default router;
