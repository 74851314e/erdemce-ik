const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const HTML_FILE = path.join(__dirname, "index.html");

let useDB = false;
let pool = null;

async function initStorage() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS app_data (id INTEGER PRIMARY KEY DEFAULT 1, data JSONB NOT NULL DEFAULT '{}'::jsonb)");
      await pool.query("INSERT INTO app_data (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
      useDB = true;
      console.log("PostgreSQL baglantisi basarili.");
    } catch (e) {
      console.error("PostgreSQL hatasi:", e.message);
    }
  } else {
    const f = path.join(__dirname, "data.json");
    if (!fs.existsSync(f)) fs.writeFileSync(f, "{}", "utf8");
    console.log("Dosya tabanli depolama kullaniliyor.");
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // API: Veri oku
  if (req.method === "GET" && pathname === "/api/data") {
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

  // API: Veri kaydet
  if (req.method === "POST" && pathname === "/api/data") {
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

  // Diğer tüm GET istekleri → index.html sun
  if (req.method === "GET") {
    try {
      const html = fs.readFileSync(HTML_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Hata: index.html dosyasi bulunamadi. Dosya yolu: " + HTML_FILE + " Hata: " + e.message);
    }
    return;
  }

  res.writeHead(404);
  res.end("Bulunamadi");
});

initStorage().then(() => {
  server.listen(PORT, () => {
    console.log("erdemCe v3.0 | Port: " + PORT + " | Depolama: " + (useDB ? "PostgreSQL" : "data.json"));
    console.log("HTML dosyasi: " + HTML_FILE);
    console.log("Dosya mevcut: " + fs.existsSync(HTML_FILE));
  });
});
