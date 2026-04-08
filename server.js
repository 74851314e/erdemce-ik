const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const HTML_FILE = path.join(__dirname, "index.html");
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const SA_FILE = "/etc/secrets/service-account.json";
const SA_INLINE = process.env.GOOGLE_SERVICE_ACCOUNT || "";

let useDB = false;
let pool = null;
let sheetsClient = null;

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

async function initSheets() {
  if (!SHEET_ID) { console.log("Sheets: GOOGLE_SHEET_ID yok, devre disi."); return; }
  let credentials = null;
  try {
    if (fs.existsSync(SA_FILE)) credentials = JSON.parse(fs.readFileSync(SA_FILE, "utf8"));
    else if (SA_INLINE) credentials = JSON.parse(SA_INLINE);
    else { console.log("Sheets: Service account bulunamadi."); return; }
    const { google } = require("googleapis");
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    sheetsClient = google.sheets({ version: "v4", auth });
    console.log("Google Sheets baglantisi hazir.");
  } catch (e) {
    console.error("Sheets baslatma hatasi:", e.message);
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

const SHEET_RANGE = "A:C";

async function sheetsReadAll() {
  if (!sheetsClient) throw new Error("Sheets devre disi");
  const r = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
  const rows = r.data.values || [];
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const empId = row[0]; const tc = row[1]; const iban = row[2];
    if (empId) map[String(empId)] = { tc: tc || "", iban: iban || "" };
  }
  return map;
}

async function sheetsUpsert(empId, tc, iban) {
  if (!sheetsClient) throw new Error("Sheets devre disi");
  const r = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
  const rows = r.data.values || [];
  let foundRow = -1;
  for (let i = 1; i < rows.length; i++) if (rows[i] && String(rows[i][0]) === String(empId)) { foundRow = i; break; }
  const newRow = [String(empId), tc || "", iban || ""];
  if (foundRow >= 0) {
    await sheetsClient.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: "A" + (foundRow + 1) + ":C" + (foundRow + 1), valueInputOption: "RAW", requestBody: { values: [newRow] } });
  } else {
    await sheetsClient.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: SHEET_RANGE, valueInputOption: "RAW", requestBody: { values: [newRow] } });
  }
}

async function sheetsDelete(empId) {
  if (!sheetsClient) throw new Error("Sheets devre disi");
  const r = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
  const rows = r.data.values || [];
  let foundRow = -1;
  for (let i = 1; i < rows.length; i++) if (rows[i] && String(rows[i][0]) === String(empId)) { foundRow = i; break; }
  if (foundRow >= 0) {
    await sheetsClient.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: "A" + (foundRow + 1) + ":C" + (foundRow + 1), valueInputOption: "RAW", requestBody: { values: [["", "", ""]] } });
  }
}

async function checkAdmin(req) {
  const u = req.headers["x-auth-user"] || "";
  const p = req.headers["x-auth-pass"] || "";
  if (!u || !p) return false;
  try {
    const data = await loadData();
    const users = data.users || [];
    const user = users.find(x => x.name === u && x.pass === p);
    return user && user.role === "admin";
  } catch (e) { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-User, X-Auth-Pass");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (pathname === "/api/hassas" || pathname === "/api/hassas/batch" || pathname.startsWith("/api/hassas/")) {
    const isAdmin = await checkAdmin(req);
    if (!isAdmin) { res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"Yetki yok"}'); return; }
    try {
      if (req.method === "GET" && pathname === "/api/hassas") {
        const map = await sheetsReadAll();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(map));
        return;
      }
      if (req.method === "POST" && pathname === "/api/hassas") {
        const body = await readBody(req);
        const { empId, tc, iban } = JSON.parse(body);
        if (!empId) { res.writeHead(400); res.end('{"error":"empId zorunlu"}'); return; }
        await sheetsUpsert(empId, tc, iban);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      if (req.method === "POST" && pathname === "/api/hassas/batch") {
        const body = await readBody(req);
        const { items } = JSON.parse(body);
        for (const it of items) await sheetsUpsert(it.empId, it.tc, it.iban);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true,"count":' + items.length + '}');
        return;
      }
      if (req.method === "DELETE") {
        const empId = pathname.replace("/api/hassas/", "");
        await sheetsDelete(empId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
    } catch (e) {
      console.error("Hassas API hatasi:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

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

  if (req.method === "GET") {
    try {
      const html = fs.readFileSync(HTML_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Hata: index.html dosyasi bulunamadi. " + e.message);
    }
    return;
  }

  res.writeHead(404);
  res.end("Bulunamadi");
});

initStorage().then(initSheets).then(() => {
  server.listen(PORT, () => {
    console.log("erdemCe v4.0 | Port: " + PORT + " | Depolama: " + (useDB ? "PostgreSQL" : "data.json") + " | Sheets: " + (sheetsClient ? "AKTIF" : "PASIF"));
  });
});
