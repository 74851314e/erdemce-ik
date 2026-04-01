const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const HTML_FILE = path.join(__dirname, "index.html");

/* ========== VERİ DEPOLAMA ========== */
let useDB = false;
let pool = null;

async function initStorage() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_data (id INTEGER PRIMARY KEY DEFAULT 1, data JSONB NOT NULL DEFAULT '{}'::jsonb)`);
      await pool.query(`INSERT INTO app_data (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
      useDB = true;
      console.log("PostgreSQL baglantisi basarili.");
    } catch (e) {
      console.error("PostgreSQL hatasi:", e.message);
    }
  } else {
    const DATA_FILE = path.join(__dirname, "data.json");
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "{}", "utf8");
    console.log("Dosya tabanli depolama (data.json) kullaniliyor.");
  }
}

async function loadData() {
  if (useDB) {
    const res = await pool.query("SELECT data FROM app_data WHERE id = 1");
    return res.rows[0] ? res.rows[0].data : {};
  }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8")); } catch (e) { return {}; }
}

async function saveData(data) {
  if (useDB) {
    await pool.query("UPDATE app_data SET data = $1 WHERE id = 1", [data]);
    return;
  }
  fs.writeFileSync(path.join(__dirname, "data.json"), JSON.stringify(data), "utf8");
}

/* ========== HTTP SUNUCU ========== */
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/api/data") {
    try {
      const data = await loadData();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/data") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        await saveData(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Hata"}');
      }
    });
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      const html = fs.readFileSync(HTML_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end("index.html bulunamadi!");
    }
    return;
  }

  res.writeHead(404);
  res.end("Bulunamadi");
});

initStorage().then(() => {
  server.listen(PORT, () => {
    console.log("erdemCe v3.0 | Port: " + PORT + " | Depolama: " + (useDB ? "PostgreSQL" : "data.json"));
  });
});
