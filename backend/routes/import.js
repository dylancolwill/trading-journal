const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { parseNTCsv, groupIntoTrades } = require('../lib/groupTrades');
const { sessionDateOf } = require('../lib/sessions');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/import — upload NT CSV
// Query param: dateFormat=us|au (default au)
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const dateFormat = req.query.dateFormat || 'au';
  const content = req.file.buffer.toString('utf8');

  let fills, trades;
  try {
    fills = parseNTCsv(content, dateFormat);
    trades = groupIntoTrades(fills);
  } catch (err) {
    return res.status(400).json({ error: 'CSV parse error: ' + err.message });
  }

  if (trades.length === 0) {
    return res.status(400).json({ error: 'No trades found in CSV' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = [];
    for (const trade of trades) {
      const { rows: [row] } = await client.query(
        `INSERT INTO trades
          (account, instrument, contract, trade_date, session_date, direction, quantity, entry_price, exit_price,
           gross_pnl, commission, net_pnl, open, entry_time, exit_time, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'nt_import')
         RETURNING id`,
        [
          trade.account, trade.instrument, trade.contract || trade.instrument, trade.trade_date,
          sessionDateOf(trade), trade.direction,
          trade.quantity, trade.entry_price, trade.exit_price,
          trade.gross_pnl, trade.commission, trade.net_pnl,
          trade.open, trade.entry_time, trade.exit_time,
        ]
      );

      for (const fill of trade.fills) {
        await client.query(
          `INSERT INTO fills (trade_id, action, quantity, price, fill_time, order_id, commission)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [row.id, fill.action, fill.quantity, fill.price, fill.time, fill.orderId, fill.commission]
        );
      }

      inserted.push(row.id);
    }

    await client.query('COMMIT');
    res.json({ imported: inserted.length, ids: inserted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/import/preview — parse without saving
router.post('/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const dateFormat = req.query.dateFormat || 'au';
  try {
    const fills = parseNTCsv(req.file.buffer.toString('utf8'), dateFormat);
    const trades = groupIntoTrades(fills);
    res.json({ count: trades.length, trades: trades.map(t => ({
      account: t.account,
      instrument: t.instrument,
      trade_date: t.trade_date,
      session_date: sessionDateOf(t),
      entry_time: t.entry_time,
      direction: t.direction,
      quantity: t.quantity,
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      commission: t.commission,
      net_pnl: t.net_pnl,
      open: t.open,
      fills: t.fills.length,
    }))});
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
