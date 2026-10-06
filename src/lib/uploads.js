const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('../db');

// Per-file cap for evidence and feed uploads. Profile photos are additionally
// capped at 20 MB in profiles.js.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 512);

const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|mp4|webm|mov|m4v)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;

// 'image' vs 'video' — drives the <img>/<video> rendering branch.
const mediaKind = (name) => (IMAGE_EXT.test(name) ? 'image' : 'video');

const makeUpload = (prefix) => multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  // Loud rejection (not a silent skip) so the client learns why nothing landed.
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_EXT.test(file.originalname.toLowerCase())) return cb(null, true);
    cb(Object.assign(
      new Error('Only photos (jpg/png/gif/webp) and videos (mp4/webm/mov/m4v) are supported'),
      { status: 400 }));
  }
});

// Upload instances are cheap; the prefix keeps files identifiable in uploads/
// (ev- = task/punishment evidence, fp- = feed post attachments).
const upload = makeUpload('ev');
const feedUpload = makeUpload('fp');
const MULTER_MAX_FILES = 10;

module.exports = { upload, feedUpload, ALLOWED_EXT, mediaKind, MULTER_MAX_FILES, MAX_UPLOAD_MB };