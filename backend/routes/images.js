const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '../../images');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// POST /api/images/:tradeId
router.post('/:tradeId', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const { rows: [img] } = await pool.query(
      'INSERT INTO trade_images (trade_id, filename, original_name) VALUES ($1,$2,$3) RETURNING *',
      [req.params.tradeId, req.file.filename, req.file.originalname]
    );
    res.status(201).json(img);
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

// GET /api/images/file/:filename — serve the actual image
router.get('/file/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// DELETE /api/images/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows: [img] } = await pool.query('DELETE FROM trade_images WHERE id = $1 RETURNING *', [req.params.id]);
    if (img) {
      const filePath = path.join(UPLOAD_DIR, img.filename);
      fs.unlink(filePath, () => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
