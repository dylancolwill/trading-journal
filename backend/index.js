require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');

const tradesRouter = require('./routes/trades');
const importRouter = require('./routes/import');
const tagsRouter = require('./routes/tags');
const imagesRouter = require('./routes/images');
const footprintRouter = require('./routes/footprint');
const candlesRouter = require('./routes/candles');
const tpoRouter = require('./routes/tpo');
const levelsRouter = require('./routes/levels');

const app = express();
const PORT = process.env.PORT || 8090;

app.use(cors());
app.use(express.json());

app.use('/api/trades', tradesRouter);
app.use('/api/import', importRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/images', imagesRouter);
app.use('/api/footprint', footprintRouter);
app.use('/api/candles', candlesRouter);
app.use('/api/tpo', tpoRouter);
app.use('/api/levels', levelsRouter);

const distPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Trading Journal running on :${PORT}`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
