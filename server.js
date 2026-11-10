// Guestbook — a tiny app to practise AWS: EC2 + ALB + RDS + EFS
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3000;
const SERVER_NAME = process.env.SERVER_NAME || os.hostname();      // "web-1" / "web-2"
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'); // later: /mnt/efs/uploads
const DB_ENABLED = Boolean(process.env.DB_HOST);                    // app still runs before RDS exists

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Database (RDS MySQL) ----------
const pool = DB_ENABLED
  ? mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER || 'admin',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'guestbook',
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 5000,
    })
  : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      message TEXT NOT NULL,
      photo VARCHAR(255),
      server VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  console.log('✅ Connected to database, table ready');
}

// ---------- File uploads (EFS) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

// ---------- App ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(UPLOAD_DIR));

// ALB health check hits this. Kept independent of the DB on purpose:
// if RDS has a problem we don't want the ALB to mark EVERY server unhealthy.
app.get('/health', (req, res) => res.send('OK'));

app.get('/', async (req, res) => {
  let messages = [];
  let dbStatus = 'Not configured yet (no DB_HOST)';
  if (pool) {
    try {
      const [rows] = await pool.query('SELECT * FROM messages ORDER BY id DESC LIMIT 50');
      messages = rows;
      dbStatus = `Connected to ${process.env.DB_HOST}`;
    } catch (err) {
      dbStatus = `❌ Error: ${err.code || err.message}`;
    }
  }
  res.send(page({ messages, dbStatus }));
});

app.post('/messages', upload.single('photo'), async (req, res) => {
  if (!pool) return res.status(503).send('Database not configured yet. <a href="/">Back</a>');
  const name = (req.body.name || 'Anonymous').trim().slice(0, 100) || 'Anonymous';
  const message = (req.body.message || '').trim();
  if (!message) return res.redirect('/');
  try {
    await pool.query(
      'INSERT INTO messages (name, message, photo, server) VALUES (?, ?, ?, ?)',
      [name, message, req.file ? req.file.filename : null, SERVER_NAME]
    );
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Could not save: ${escapeHtml(err.code || err.message)} <a href="/">Back</a>`);
  }
});

// ---------- HTML ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page({ messages, dbStatus }) {
  const hue = [...SERVER_NAME].reduce((a, c) => a + c.charCodeAt(0), 0) % 360; // each server gets its own colour
  const items = messages.length
    ? messages.map((m) => `
      <div class="msg">
        <div class="meta"><b>${escapeHtml(m.name)}</b> · ${new Date(m.created_at).toLocaleString()} · saved by ${escapeHtml(m.server)}</div>
        <p>${escapeHtml(m.message)}</p>
        ${m.photo ? `<img src="/uploads/${encodeURIComponent(m.photo)}" alt="photo"
             onerror="this.replaceWith(Object.assign(document.createElement('em'),{textContent:'⚠ photo missing on this server (no shared storage?)'}))">` : ''}
      </div>`).join('')
    : '<p class="empty">No messages yet. Be the first!</p>';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Guestbook</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;background:#f6f7f9;color:#1d2330}
  .badge{display:inline-block;padding:8px 16px;border-radius:999px;color:#fff;font-weight:600;background:hsl(${hue},55%,42%)}
  .info{font-size:13px;color:#5b6475;margin:10px 0 24px;line-height:1.7}
  form,.msg{background:#fff;border:1px solid #e3e6eb;border-radius:12px;padding:16px;margin-bottom:14px}
  input,textarea{width:100%;box-sizing:border-box;padding:10px;margin:6px 0;border:1px solid #ccd2db;border-radius:8px;font:inherit}
  button{background:#1d2330;color:#fff;border:0;padding:10px 20px;border-radius:8px;cursor:pointer;font:inherit}
  .meta{font-size:12px;color:#5b6475}.msg img{max-width:100%;border-radius:8px;margin-top:8px}.empty{color:#5b6475}
</style></head>
<body>
  <h1>📝 Guestbook</h1>
  <span class="badge">Served by: ${escapeHtml(SERVER_NAME)}</span>
  <div class="info">
    Database: ${escapeHtml(dbStatus)}<br>
    Uploads folder: ${escapeHtml(UPLOAD_DIR)}
  </div>
  <form method="POST" action="/messages" enctype="multipart/form-data">
    <input name="name" placeholder="Your name" maxlength="100">
    <textarea name="message" placeholder="Write a message…" rows="3" required></textarea>
    <input type="file" name="photo" accept="image/*">
    <button type="submit">Post</button>
  </form>
  ${items}
</body></html>`;
}

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 ${SERVER_NAME} listening on port ${PORT}`));
initDb().catch((err) => console.error('⚠ Database not ready:', err.code || err.message));
