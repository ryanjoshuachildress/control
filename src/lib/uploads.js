const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('../db');

const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|mp4|webm|mov|m4v)$/i;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `ev-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_EXT.test(file.originalname.toLowerCase()))
});

module.exports = { upload, ALLOWED_EXT };