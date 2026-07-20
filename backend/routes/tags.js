const express = require('express');
const { pool } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tags WHERE archived = false ORDER BY group_name, name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, color, group_name, group_color } = req.body;
    const { rows: [tag] } = await pool.query(
      'INSERT INTO tags (name, color, group_name, group_color) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, color || '#6366f1', group_name || '', group_color || '']
    );
    res.status(201).json(tag);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, color, group_name, group_color } = req.body;
    const { rows: [tag] } = await pool.query(
      'UPDATE tags SET name = COALESCE($1, name), color = COALESCE($2, color), group_name = COALESCE($3, group_name), group_color = COALESCE($4, group_color) WHERE id = $5 RETURNING *',
      [name, color, group_name, group_color, req.params.id]
    );
    if (!tag) return res.status(404).json({ error: 'Not found' });
    res.json(tag);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tags WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
