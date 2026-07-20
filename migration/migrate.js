/**
 * TradeNote → Trading Journal migration
 *
 * Run:  cd ~/trading-journal/migration && node migrate.js
 * Dry:  node migrate.js --dry
 *
 * TradeNote real schema (from inspection):
 *   trades collection: one doc per day, has trades[] + executions[]
 *   trade fields: id, account, symbol, strategy("long"/"short"), entryTime/exitTime (unix sec),
 *                 entryPrice, exitPrice, commission, grossProceeds($), netProceeds($), openPosition
 *   execution fields: id, trade(→trade.id), account, symbol, side(B/S/SS/BC),
 *                     quantity, price, execTime(unix sec), commission
 *   tags collection: { tradeId, tags:["tag_12",...], dateUnix }
 *   notes collection: { tradeId, note, dateUnix }
 *   _User doc: { tags: { tag_1:"Name", tag_2:"Other", ... } }
 */

const { MongoClient } = require('mongodb');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const MONGO_URI = 'mongodb://tradenote:tradenote@localhost:27017/tradenote?authSource=admin';
const IMAGES_DIR = path.join(__dirname, '../images');

const pg = new Pool({
  host: 'localhost', port: 5432,
  user: 'journal', password: 'journal', database: 'journal',
});

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Convert a unix-second instant to the journal display zone wall-clock "YYYY-MM-DD HH:MM:SS".
// TradeNote execTime is a true UTC instant; we store US-Eastern (the session clock the user trades in).
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/New_York';
const _fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function unixToLocal(sec) {
  if (!sec) return null;
  const p = {};
  for (const part of _fmt.formatToParts(new Date(sec * 1000))) p[part.type] = part.value;
  let hh = p.hour === '24' ? '00' : p.hour; // Intl can emit '24' at midnight
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`;
}

// "2026-06-15 09:30:00" → date part only
function dateOf(localTs) {
  return localTs ? localTs.slice(0, 10) : null;
}

// side codes: B=Buy(long entry), S=Sell(long exit), SS=Short-Sell(short entry), BC=Buy-to-Cover(short exit)
function sideToAction(side) {
  return (side === 'B' || side === 'BC') ? 'Buy' : 'Sell';
}

async function main() {
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  console.log('Connected to MongoDB');
  if (DRY) console.log('[DRY RUN — no writes to PG]\n');

  const db = mongo.db('tradenote');

  // ── 1. Resolve tag key→name from _User doc ───────────────────────────────
  const userDoc = await db.collection('_User').findOne({});
  const tagMap = {};      // "tag_12" → "accident"
  const tagGroupMap = {}; // "tag_12" → { groupName: "error", groupColor: "#ff3838" }
  // _User.tags is array of group objects: [{id:"group_1", name:"plays", color:"#cab444", tags:[{id:"tag_2",name:"absorption",...}]}]
  const rawGroups = (userDoc && Array.isArray(userDoc.tags)) ? userDoc.tags : [];
  for (const group of rawGroups) {
    for (const tag of (group.tags || [])) {
      if (tag.id && tag.name) {
        tagMap[tag.id] = tag.name;
        tagGroupMap[tag.id] = { groupName: group.name || '', groupColor: group.color || '#6366f1' };
      }
    }
  }
  console.log(`Tag map (${Object.keys(tagMap).length}):`, tagMap);

  // ── 2. Ensure PG tags exist, build tagKey→pgId map ──────────────────────
  const pgTagMap = {}; // "tag_12" → pg tag id
  if (!DRY) {
    for (const [tagKey, name] of Object.entries(tagMap)) {
      const { groupName, groupColor } = tagGroupMap[tagKey] || {};
      const color = groupColor || '#6366f1';
      const gname = groupName || '';
      const { rows: [t] } = await pg.query(
        `INSERT INTO tags (name, color, group_name, group_color)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name, group_name) DO UPDATE SET color=EXCLUDED.color, group_color=EXCLUDED.group_color
         RETURNING id`,
        [name, color, gname, color]
      );
      pgTagMap[tagKey] = t.id;
    }
    console.log(`PG tags ready (${Object.keys(pgTagMap).length} TradeNote tags inserted)`);
  }

  // ── 3. Load notes keyed by tradeId ───────────────────────────────────────
  const notesByTradeId = {};
  const notes = await db.collection('notes').find({}).toArray();
  for (const n of notes) {
    if (n.tradeId) notesByTradeId[n.tradeId] = n.note || '';
  }
  console.log(`Loaded ${notes.length} notes`);

  // ── 4. Load tag assignments keyed by tradeId ─────────────────────────────
  const tagsByTradeId = {};
  const tagDocs = await db.collection('tags').find({}).toArray();
  for (const doc of tagDocs) {
    if (!doc.tradeId) continue;
    // keep the raw tag keys (e.g. "tag_12"); pgTagMap is keyed by the same
    tagsByTradeId[doc.tradeId] = (doc.tags || []).filter(key => tagMap[key]);
  }
  console.log(`Loaded ${tagDocs.length} tag assignments`);

  // ── 5. Load screenshots keyed by reconstructed trade.id ──────────────────
  // screenshot.name = "t{dateUnix}_{symbol}_{side}"; trade.id = "t{dateUnix}_{symbol}_future_{side}"
  const screenshotsByTradeId = {};
  try {
    const screenshots = await db.collection('screenshots').find({}).toArray();
    for (const s of screenshots) {
      const key = `t${s.dateUnix}_${s.symbol}_future_${s.side}`;
      if (!screenshotsByTradeId[key]) screenshotsByTradeId[key] = [];
      screenshotsByTradeId[key].push(s);
    }
    console.log(`Loaded ${screenshots.length} screenshots`);
  } catch (e) {
    console.log('No screenshots collection or error:', e.message);
  }

  // ── 6. Migrate trades ─────────────────────────────────────────────────────
  const tradeDocs = await db.collection('trades').find({}).sort({ dateUnix: 1 }).toArray();
  console.log(`\nMigrating ${tradeDocs.length} day documents…`);

  let tradeCount = 0, fillCount = 0, skipCount = 0, imageCount = 0;

  for (const dayDoc of tradeDocs) {
    const dayTrades = dayDoc.trades || [];
    const executions = dayDoc.executions || [];

    // Index executions by their trade link
    const execByTradeId = {};
    for (const ex of executions) {
      const tid = ex.trade;
      if (!tid) continue;
      if (!execByTradeId[tid]) execByTradeId[tid] = [];
      execByTradeId[tid].push(ex);
    }

    for (const trade of dayTrades) {
      const tradeId = trade.id;
      if (!tradeId) { skipCount++; continue; }

      const symbol = (trade.symbol || trade.symbolOriginal || '').toUpperCase();
      const contract = (trade.symbolOriginal || trade.symbol || '').toUpperCase();
      const direction = (trade.strategy || '').toLowerCase() === 'short' ? 'SHORT' : 'LONG';
      const account = trade.account || 'imported';

      const entryTs = unixToLocal(trade.entryTime);
      const exitTs = unixToLocal(trade.exitTime);
      const tradeDate = dateOf(entryTs) || (dayDoc.dateUnix ? dateOf(unixToLocal(dayDoc.dateUnix)) : null);

      if (!tradeDate) { console.warn(`  Skipping ${tradeId}: no date`); skipCount++; continue; }

      const entryPrice = parseFloat(trade.entryPrice) || null;
      const exitPrice = parseFloat(trade.exitPrice) || null;
      const quantity = parseInt(trade.quantity) || 1;
      const grossPnl = parseFloat(trade.grossProceeds) || 0;   // already in USD $
      const commission = parseFloat(trade.commission) || 0;
      const netPnlRaw = parseFloat(trade.netProceeds);
      const netPnl = !isNaN(netPnlRaw) ? netPnlRaw : (grossPnl - commission);
      const isOpen = !!trade.openPosition;
      const description = notesByTradeId[tradeId] || '';

      if (DRY) {
        const fills = execByTradeId[tradeId] || [];
        console.log(`[DRY] ${tradeDate} ${symbol} ${direction} qty=${quantity} gross=$${grossPnl.toFixed(2)} net=$${netPnl.toFixed(2)} fills=${fills.length} note=${description ? 'yes' : 'no'}`);
        tradeCount++;
        continue;
      }

      const { rows: [pgTrade] } = await pg.query(
        `INSERT INTO trades
          (account, instrument, contract, trade_date, direction, quantity, entry_price, exit_price,
           gross_pnl, commission, net_pnl, open, entry_time, exit_time, description, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'tradenote')
         RETURNING id`,
        [account, symbol, contract, tradeDate, direction, quantity, entryPrice, exitPrice,
         grossPnl, commission, netPnl, isOpen, entryTs, exitTs, description]
      );
      const pgTradeId = pgTrade.id;

      // Insert fills (executions linked to this trade)
      const tradeFills = execByTradeId[tradeId] || [];
      for (const ex of tradeFills) {
        const fillTs = unixToLocal(ex.execTime);
        const action = sideToAction(ex.side);
        await pg.query(
          'INSERT INTO fills (trade_id, action, quantity, price, fill_time, order_id, commission) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [pgTradeId, action, parseInt(ex.quantity) || 1,
           parseFloat(ex.price) || 0, fillTs, ex.id || null, parseFloat(ex.commission) || 0]
        );
        fillCount++;
      }

      // Attach tags — tagsByTradeId holds raw tag keys like "tag_12", pgTagMap maps key→id
      const tradeTagKeys = tagsByTradeId[tradeId] || [];
      for (const tagKey of tradeTagKeys) {
        const tagId = pgTagMap[tagKey];
        if (tagId) {
          await pg.query(
            'INSERT INTO trade_tags (trade_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [pgTradeId, tagId]
          );
        }
      }

      // Attach screenshots matched by reconstructed trade id
      const shots = screenshotsByTradeId[tradeId] || [];
      for (let i = 0; i < shots.length; i++) {
        const shot = shots[i];
        // prefer the annotated image (has the user's markup); fall back to original
        const b64 = shot.annotatedBase64 || shot.originalBase64;
        if (!b64) continue;
        const data = b64.replace(/^data:image\/\w+;base64,/, '');
        const filename = `migrated-${pgTradeId}-${i}-${Date.now()}.png`;
        fs.writeFileSync(path.join(IMAGES_DIR, filename), Buffer.from(data, 'base64'));
        await pg.query(
          'INSERT INTO trade_images (trade_id, filename, original_name) VALUES ($1,$2,$3)',
          [pgTradeId, filename, shot.name || filename]
        );
        imageCount++;
      }

      tradeCount++;
    }
  }

  console.log(`\n✓ Migrated ${tradeCount} trades, ${fillCount} fills, ${imageCount} images (${skipCount} skipped).`);
  await mongo.close();
  await pg.end();
}

main().catch(err => { console.error(err); process.exit(1); });
