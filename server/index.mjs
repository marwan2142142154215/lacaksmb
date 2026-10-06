import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const runFile = promisify(execFile);
import { createCipheriv, createDecipheriv, randomBytes, randomInt, X509Certificate } from "node:crypto";
import {
  bootstrapFirstAdmin,
  completeTotpEnrollment,
  createAdminUser,
  createAdminSession,
  ensureAdminAuthSchema,
  listAdminUsers,
  loginIsThrottled,
  makeTotpEnrollment,
  publicAdminUser,
  recordLoginAttempt,
  resetAdminTotp,
  resolveAdminSession,
  revokeAdminSession,
  tokenDigest,
  validateUsername,
  verifyAdminPassword,
  verifyAdminTotp,
  updateAdminPassword,
} from "./adminAuth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDownloads = Object.freeze({
  tracker: { file: "SMB-Lacak.apk", downloadName: "SMB-Lacak.apk", contentType: "application/vnd.android.package-archive" },
  master: { file: "SMB-Master.apk", downloadName: "SMB-Master.apk", contentType: "application/vnd.android.package-archive" },
  server: { file: "SMB-Fleet-Server.exe", downloadName: "SMB-Fleet-Server.exe", contentType: "application/vnd.microsoft.portable-executable" },
});
const operationLogFiles = [
  ["broker", "fleet-server.log"],
  ["error", "fleet-server-error.log"],
  ["launcher", "fleet-launcher.log"],
  ["tunnel", "cloudflared.log"],
];
const envFile = path.join(root, ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

const host = process.env.FLEET_BROKER_HOST || "0.0.0.0";
const port = Number(process.env.FLEET_BROKER_PORT || 8787);
const masterToken = process.env.FLEET_MASTER_TOKEN || "";
const trackerToken = process.env.FLEET_TRACKER_TOKEN || "";
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramAdminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || "1805036529";
const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseEnabled = Boolean(supabaseUrl && supabaseServiceKey);
const locationEncryptionKey = Buffer.from(process.env.FLEET_LOCATION_KEY || "", "base64");
const adminAuthEncryptionKey = Buffer.from(process.env.FLEET_ADMIN_AUTH_KEY || "", "base64");
const supabaseDevices = new Map();
const supabaseStates = new Map();
const supabaseCommands = new Map();
let supabaseFlushActive = false;
let supabaseRetryAt = 0;
let supabaseRetryDelay = 1000;
const supabaseRowFailures = new Map();
const certPath = path.join(root, ".tools", "broker-cert", "broker-cert.pem");
const pfxPath = path.join(root, ".tools", "broker-cert", "broker.p12");
const pfxPassphrase = process.env.FLEET_TLS_PASSPHRASE || "";

// Master/tracker IDs tidak lagi di-hardcode.
// Semua perangkat (master dan tracker) mendaftar lewat enrollment code.
// FLEET_MASTER_ID di .env.local opsional – backward-compat saja.
const FLEET_MASTER_ID = process.env.FLEET_MASTER_ID || null;
// "photo"/"photo_front" hanya dijalankan saat admin memintanya; tidak ada
// pengambilan foto berkala di sisi mana pun.
const ALLOWED_COMMANDS = new Set(["lock", "unlock", "uninstall", "photo", "photo_front"]);
const WIFI_VIOLATION_COOLDOWN_MS = 10 * 60_000;

/**
 * Alamat broker pada jaringan WiFi lokal PC. Tracker memakai alamat ini ketika
 * HP tidak punya akses internet tetapi masih 1 WiFi dengan PC broker.
 * Sertifikat lokal sudah mencantumkan IP LAN, jadi WSS tetap tepercaya di Android.
 */
function resolveLanHost() {
  const configured = (process.env.FLEET_BROKER_LAN_HOST || "").trim();
  const certificateHosts = [];
  try {
    const certificate = new X509Certificate(fs.readFileSync(certPath));
    for (const entry of String(certificate.subjectAltName || "").split(",")) {
      const ip = entry.trim().match(/^IP Address=(.+)$/i)?.[1];
      if (ip) certificateHosts.push(ip);
    }
  } catch { /* Sertifikat dibaca ulang oleh HTTPS server; deteksi IP tetap berjalan. */ }
  const interfaceAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && !address.internal && address.family === "IPv4")
    .map((address) => address.address);
  const preferred = [configured, ...certificateHosts].filter(Boolean);
  const matched = preferred.find((host) => interfaceAddresses.includes(host) || host === "127.0.0.1");
  return matched || interfaceAddresses.find((host) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) || "";
}
const lanHost = resolveLanHost();
const lanBrokerUrl = lanHost ? `wss://${lanHost}:${port}/ws` : "";

if (!masterToken || !trackerToken) throw new Error("Set distinct FLEET_MASTER_TOKEN and FLEET_TRACKER_TOKEN in .env.local.");
if (locationEncryptionKey.length !== 32) throw new Error("Set FLEET_LOCATION_KEY to a random base64-encoded 32-byte key in .env.local.");
if (adminAuthEncryptionKey.length !== 32) throw new Error("Set FLEET_ADMIN_AUTH_KEY to a random base64-encoded 32-byte key in .env.local.");
if (!fs.existsSync(pfxPath) || !fs.existsSync(certPath) || !pfxPassphrase) {
  throw new Error("Local WSS certificate is missing. Generate the local broker certificate before starting the broker.");
}

// Perangkat dimuat dari database saat startup; tidak ada entry hardcoded.
const devices = new Map();
const registryPath = path.join(root, "data", "fleet-registry.json");
if (fs.existsSync(registryPath)) {
  try {
    const saved = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    for (const [deviceId, name] of Object.entries(saved.names || {})) {
      if (devices.has(deviceId) && typeof name === "string" && name.trim()) devices.get(deviceId).name = name.trim();
    }
  } catch (error) {
    console.error("Fleet registry could not be loaded:", error.message);
  }
}
// Token map: masterToken berlaku untuk semua master, trackerToken untuk semua tracker.
const tokens = new Map();
const sockets = new Map();
const queues = new Map();
const commands = new Map();
const databasePath = path.join(root, "data", "fleet.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS device_state (device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE, connected INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, telemetry_json TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS command_log (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id), command TEXT NOT NULL, issued_by TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, completed_at TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS telemetry_minute (device_id TEXT NOT NULL REFERENCES devices(device_id), minute_at TEXT NOT NULL, sample_count INTEGER NOT NULL, detected_count INTEGER NOT NULL, rssi_sum INTEGER NOT NULL, rssi_count INTEGER NOT NULL, rssi_min INTEGER, rssi_max INTEGER, battery_level INTEGER, PRIMARY KEY (device_id, minute_at));
  CREATE TABLE IF NOT EXISTS location_history (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE, captured_at TEXT NOT NULL, received_at TEXT NOT NULL, nonce TEXT NOT NULL, coordinates_enc TEXT NOT NULL, UNIQUE(device_id, captured_at));
  CREATE TABLE IF NOT EXISTS telegram_chat_access (chat_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','operator')), granted_at TEXT NOT NULL, granted_by TEXT NOT NULL, revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS telegram_access_codes (code_hash TEXT PRIMARY KEY, issued_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by_chat_id TEXT);
  CREATE TABLE IF NOT EXISTS telegram_otp_attempts (chat_id TEXT PRIMARY KEY, window_started_at TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, wifi_allowlist TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS enrollment_codes (code_hash TEXT PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, device_label TEXT, issued_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, device_id TEXT);
  CREATE INDEX IF NOT EXISTS command_log_device_created ON command_log(device_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS telemetry_minute_recent ON telemetry_minute(device_id, minute_at DESC);
  CREATE INDEX IF NOT EXISTS location_history_recent ON location_history(device_id, captured_at DESC);
`);
// Migrasi kolom yang ditambahkan untuk banyak perangkat + site/tim. ALTER TABLE
// gagal kalau kolom sudah ada, jadi tiap statement dijalankan terpisah.
for (const statement of [
  "ALTER TABLE devices ADD COLUMN site_id INTEGER REFERENCES sites(id)",
  "ALTER TABLE devices ADD COLUMN token_hash TEXT",
  "ALTER TABLE devices ADD COLUMN uninstall_blocked INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE enrollment_codes ADD COLUMN revoked_at TEXT",
]) {
  try { database.exec(statement); } catch (error) {
    if (!/duplicate column name/i.test(error.message || "")) throw error;
  }
}
if (telegramAdminChatId) {
  database.prepare("INSERT INTO telegram_chat_access (chat_id,role,granted_at,granted_by,revoked_at) VALUES (?,'owner',?,'environment',NULL) ON CONFLICT(chat_id) DO UPDATE SET role='owner',revoked_at=NULL")
    .run(telegramAdminChatId, new Date().toISOString());
}
ensureAdminAuthSchema(database);
const bootstrapCreated = bootstrapFirstAdmin(
  database,
  process.env.FLEET_BOOTSTRAP_ADMIN_USERNAME || "",
  process.env.FLEET_BOOTSTRAP_ADMIN_PASSWORD || "",
);
delete process.env.FLEET_BOOTSTRAP_ADMIN_PASSWORD;
if (bootstrapCreated) console.log("Initial superadmin account created; enroll its authenticator during first login.");
const startupTime = new Date().toISOString();
for (const [deviceId, device] of devices) {
  database.prepare("INSERT INTO devices (device_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET name=excluded.name,role=excluded.role,updated_at=excluded.updated_at")
    .run(deviceId, device.name, device.role, startupTime, startupTime);
  database.prepare("INSERT OR IGNORE INTO device_state (device_id,connected,updated_at) VALUES (?,0,?)").run(deviceId, startupTime);
  queueSupabaseDevice(deviceId);
  queueSupabaseState(deviceId);
}
// Muat semua perangkat dari database (master dan tracker).
for (const row of database.prepare("SELECT device_id,name,role FROM devices").all()) {
  if (devices.has(row.device_id)) { devices.get(row.device_id).name = row.name; continue; }
  devices.set(row.device_id, { role: row.role, name: row.name, connected: false, siteId: null, uninstallBlocked: false });
}

// ── Site / tim ──────────────────────────────────────────────────────────────────
function parseWifiAllowlist(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()) : [];
  } catch { return []; }
}
const sites = new Map();
function reloadSites() {
  sites.clear();
  for (const row of database.prepare("SELECT * FROM sites ORDER BY name").all()) {
    sites.set(row.id, { id: row.id, name: row.name, wifiAllowlist: parseWifiAllowlist(row.wifi_allowlist), createdAt: row.created_at, updatedAt: row.updated_at });
  }
}
reloadSites();
for (const row of database.prepare("SELECT device_id,site_id,token_hash,uninstall_blocked FROM devices").all()) {
  const device = devices.get(row.device_id);
  if (!device) continue;
  device.uninstallBlocked = row.uninstall_blocked === 1;
  if (row.site_id == null) continue;
  if (sites.has(row.site_id)) device.siteId = row.site_id;
  else {
    // Site sudah dihapus oleh superadmin: lepaskan perangkat supaya tidak nyangkut.
    device.siteId = null;
    database.prepare("UPDATE devices SET site_id=NULL WHERE device_id=?").run(row.device_id);
  }
}
function publicSite(site) {
  return { id: site.id, name: site.name, wifiAllowlist: site.wifiAllowlist, createdAt: site.createdAt, updatedAt: site.updatedAt };
}
function siteOf(deviceId) {
  const siteId = devices.get(deviceId)?.siteId;
  return siteId == null ? null : sites.get(siteId) || null;
}
const pendingRows = database.prepare("SELECT * FROM command_log WHERE status IN ('pending','sent') ORDER BY created_at").all();
const recentRows = database.prepare("SELECT * FROM command_log WHERE status IN ('acked','failed') ORDER BY created_at DESC LIMIT 1000").all();
for (const row of [...recentRows.reverse(), ...pendingRows]) {
  const status = row.status === "sent" ? "pending" : row.status;
  if (row.status === "sent") database.prepare("UPDATE command_log SET status='pending',sent_at=NULL WHERE id=?").run(row.id);
  const entry = { id: row.id, deviceId: row.device_id, command: row.command, issuedBy: row.issued_by, status, createdAt: row.created_at, sentAt: status === "pending" ? null : row.sent_at, completedAt: row.completed_at, detail: row.detail };
  commands.set(entry.id, entry);
  queueSupabaseCommand(entry);
  if (status === "pending") queues.set(entry.deviceId, [...(queues.get(entry.deviceId) || []), entry]);
}
// Status tracker disimpan per perangkat karena satu broker melayani banyak HP.
const telemetryByDevice = new Map();
function emptyTelemetry(deviceId) {
  return { deviceId, detected: false, rssi: null, receivedAt: null, online: false };
}
function telemetryFor(deviceId) {
  if (!telemetryByDevice.has(deviceId)) telemetryByDevice.set(deviceId, emptyTelemetry(deviceId));
  return telemetryByDevice.get(deviceId);
}
function setTelemetry(deviceId, patch) {
  const merged = { ...telemetryFor(deviceId), ...patch, deviceId };
  telemetryByDevice.set(deviceId, merged);
  return merged;
}
for (const [deviceId, device] of devices) {
  if (device.role !== "tracker") continue;
  telemetryByDevice.set(deviceId, emptyTelemetry(deviceId));
  try {
    const savedTelemetry = database.prepare("SELECT telemetry_json FROM device_state WHERE device_id=?").get(deviceId)?.telemetry_json;
    if (savedTelemetry) telemetryByDevice.set(deviceId, { ...emptyTelemetry(deviceId), ...JSON.parse(savedTelemetry), online: false, detected: false, rssi: null });
  } catch { /* Simpan awal kosong bila data tersimpan tidak terbaca. */ }
  try {
    const savedLocation = database.prepare("SELECT * FROM location_history WHERE device_id=? ORDER BY captured_at DESC LIMIT 1").get(deviceId);
    if (savedLocation) telemetryByDevice.set(deviceId, { ...telemetryFor(deviceId), ...decryptLocationRow(savedLocation) });
  } catch (error) { console.error(`Saved location for ${deviceId} could not be decrypted: ${error.message}`); }
}

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function bearerToken(request) {
  const authorization = request.headers.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function requireAdminSession(request, response) {
  const admin = resolveAdminSession(database, bearerToken(request));
  if (admin) return admin;
  respondJson(response, 401, { error: "unauthorized", message: "Sesi admin kedaluwarsa. Silakan login lagi." });
  return null;
}

async function readJsonRequest(request, maxBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      error.code = "request_too_large";
      error.publicMessage = "Ukuran data melebihi batas.";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected object");
    return body;
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    error.code = "invalid_json";
    error.publicMessage = "Isi permintaan tidak valid.";
    throw error;
  }
}

/** Autentikasi token perangkat:
 *  1. Master: token cocok dengan FLEET_MASTER_TOKEN env var
 *  2. Tracker: token cocok dengan FLEET_TRACKER_TOKEN env var (device lama pre-enrolmen)
 *  3. Semua perangkat: token_hash dari DB (hasil enrolmen)
 */
function authenticateDevice(deviceId, token) {
  if (!deviceId || !token) return false;
  const device = devices.get(deviceId);
  if (!device) return false;
  // Cek token berbasis role (env var)
  if (device.role === "master" && masterToken && token === masterToken) return true;
  if (device.role === "tracker" && trackerToken && token === trackerToken) return true;
  // Cek token_hash dari DB (hasil enrollment)
  const row = database.prepare("SELECT token_hash FROM devices WHERE device_id=?").get(deviceId);
  return Boolean(row?.token_hash) && row.token_hash === tokenDigest(token);
}

function normalizeSsid(value) {
  const ssid = typeof value === "string" ? value.trim().replace(/^"|"$/g, "") : "";
  if (!ssid || /^unknown ssid$/i.test(ssid) || ssid.length > 32) return null;
  return ssid;
}

const wifiViolationNotifiedAt = new Map();

/**
 * Bandingkan WiFi tracker dengan daftar izin site/tim. Pelanggaran dikirim ke
 * dashboard admin (realtime) dan ke Telegram, disertai nama site/tim.
 */
async function evaluateWifiPolicy(deviceId, wifiSsid) {
  const site = siteOf(deviceId);
  if (!site || !site.wifiAllowlist.length) return;
  const allowed = !wifiSsid || site.wifiAllowlist.some((ssid) => ssid.toLocaleLowerCase("id-ID") === wifiSsid.toLocaleLowerCase("id-ID"));
  if (allowed) { wifiViolationNotifiedAt.delete(deviceId); return; }
  const lastNotified = wifiViolationNotifiedAt.get(deviceId) || 0;
  if (Date.now() - lastNotified < WIFI_VIOLATION_COOLDOWN_MS) return;
  wifiViolationNotifiedAt.set(deviceId, Date.now());
  const device = devices.get(deviceId);
  const event = { type: "siteViolation", deviceId, deviceName: device?.name || deviceId, siteId: site.id, siteName: site.name, wifiSsid, allowedNetworks: site.wifiAllowlist, at: new Date().toISOString() };
  sendToMasters(event);
  console.warn(`WiFi policy violation: ${device?.name || deviceId} (site ${site.name}) joined ${wifiSsid}.`);
  if (!telegramToken || !telegramAdminChatId) return;
  try {
    await telegramReply(telegramAdminChatId, [
      "⚠️ WIFI DI LUAR IZIN SITE/TIM",
      `Site/tim: ${site.name}`,
      `Perangkat: ${device?.name || deviceId} (${deviceId})`,
      `WiFi terdeteksi: ${wifiSsid}`,
      `WiFi diizinkan: ${site.wifiAllowlist.join(", ")}`,
      `Waktu: ${new Date().toLocaleString("id-ID")}`,
    ].join("\n"));
  } catch (error) { console.error("Telegram WiFi alert failed:", error.message); }
}

const publicBrokerUrl = (process.env.FLEET_PUBLIC_BROKER_URL || "wss://broker.lacaksmbbot.com/ws").replace(/\/$/, "");
const publicBrokerHttpUrl = publicBrokerUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/ws$/, "");

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "invalid_request";
  error.publicMessage = message;
  return error;
}

function urlQuery(request) {
  return new URL(request.url || "/", "https://localhost").searchParams;
}

function enrollPayload(deviceId, token) {
  const device = devices.get(deviceId);
  const site = siteOf(deviceId);
  return {
    token,
    device: { deviceId, name: device?.name || deviceId, role: device?.role || "tracker", siteId: device?.siteId ?? null },
    site: site ? publicSite(site) : null,
    brokerUrl: publicBrokerUrl,
    lanBrokerUrl,
    publicBrokerHttpUrl,
  };
}

/**
 * Buat salinan APK Lacak dengan kode enrolmen site ditanam di
 * assets/public/site-enrollment.json. Setelah dipasang, HP membaca file
 * tersebut dan enrolmen berjalan otomatis — tanpa mengetik kode.
 * Hasilnya ditandatangani ulang dengan debug keystore sehingga tetap valid.
 */
async function buildSiteBoundTrackerApk(site, issuedBy) {
  const sourceApk = path.join(root, "artifacts", "SMB-Lacak.apk");
  const workDir = path.join(root, "data", `apk-site-${site.id}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const code = generateEnrollmentCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    database.prepare("INSERT INTO enrollment_codes (code_hash,site_id,device_label,issued_by,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .run(tokenDigest(code), site.id, null, issuedBy, now.toISOString(), expiresAt);

    const extractDir = path.join(workDir, "unzipped");
    fs.cpSync(sourceApk, path.join(workDir, "input.zip"));
    await runFile("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path "${path.join(workDir, "input.zip")}" -DestinationPath "${extractDir}" -Force`]);

    fs.writeFileSync(
      path.join(extractDir, "assets", "public", "site-enrollment.json"),
      JSON.stringify({ code, siteId: site.id, siteName: site.name, expiresAt }),
      "utf8",
    );
    // Tanda tangan lama jadi tidak valid setelah isi diubah; hapus agar tidak bentrok.
    fs.rmSync(path.join(extractDir, "META-INF"), { recursive: true, force: true });

    const unsignedZip = path.join(workDir, "unsigned.zip");
    await runFile("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path "${extractDir}\\*" -DestinationPath "${unsignedZip}" -Force`]);

    const sdkBuildTools = path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "build-tools");
    let version = "";
    for (const candidate of fs.readdirSync(sdkBuildTools)) version = candidate;
    const zipalign = path.join(sdkBuildTools, version, "zipalign.exe");
    const apksigner = path.join(sdkBuildTools, version, "apksigner.bat");
    const aligned = path.join(workDir, "aligned.apk");
    await runFile(zipalign, ["-f", "4", unsignedZip, aligned]);

    const debugKeystore = path.join(os.homedir(), ".android", "debug.keystore");
    await new Promise((resolve, reject) => {
      execFile("cmd.exe", ["/c", apksigner, "sign", "--ks", debugKeystore, "--ks-key-alias", "androiddebugkey", "--ks-pass", "pass:android", "--key-pass", "pass:android", aligned], (error, stdout, stderr) => {
        if (error) reject(new Error(`apksigner gagal: ${stderr || stdout || error.message}`));
        else resolve();
      });
    });

    const downloadName = `SMB-Lacak-${site.name.replace(/[^\w-]+/g, "-")}.apk`;
    return { apkPath: aligned, downloadName };
  } catch (error) {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    throw error;
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateEnrollmentCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (let index = 0; index < 8; index++) code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  return code;
}
function normalizeEnrollmentCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function normalizeWifiAllowlist(value) {
  if (!Array.isArray(value)) throw badRequest("Daftar WiFi harus berupa daftar nama jaringan.");
  if (value.length > 20) throw badRequest("Maksimal 20 jaringan WiFi per site/tim.");
  const networks = [];
  for (const entry of value) {
    const ssid = normalizeSsid(String(entry ?? ""));
    if (!ssid) continue;
    if (!networks.some((existing) => existing.toLocaleLowerCase("id-ID") === ssid.toLocaleLowerCase("id-ID"))) networks.push(ssid);
  }
  return networks;
}
function createSite(body) {
  const name = String(body.name || "").trim();
  if (!name || name.length > 40) throw badRequest("Nama site/tim harus 1-40 karakter.");
  const clash = [...sites.values()].find((site) => site.name.toLocaleLowerCase("id-ID") === name.toLocaleLowerCase("id-ID"));
  if (clash) throw badRequest("Nama site/tim sudah dipakai.");
  const now = new Date().toISOString();
  const wifiAllowlist = normalizeWifiAllowlist(body.wifiAllowlist ?? []);
  const result = database.prepare("INSERT INTO sites (name,wifi_allowlist,created_at,updated_at) VALUES (?,?,?,?)")
    .run(name, JSON.stringify(wifiAllowlist), now, now);
  return { id: Number(result.lastInsertRowid), name, wifiAllowlist, createdAt: now, updatedAt: now };
}

/** Pembatas percobaan kode enrolmen (kode 8 karakter, tetap dibatasi agar tidak ditebak. */
const enrollAttempts = {
  failures: [],
  windowStart: 0,
  expired() { return Date.now() - this.windowStart > 60_000; },
  allow() { return this.failures.length < 10; },
  recordFailure() {
    if (this.expired()) { this.failures = []; this.windowStart = Date.now(); }
    this.failures.push(Date.now());
  },
};

function readOperationLogs(maxEntries = 200) {
  const entries = [];
  const logDirectory = path.join(root, ".tools");
  for (const [source, filename] of operationLogFiles) {
    const logPath = path.join(logDirectory, filename);
    try {
      const size = fs.statSync(logPath).size;
      if (size === 0) continue;
      const bytesToRead = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(bytesToRead);
      const file = fs.openSync(logPath, "r");
      try { fs.readSync(file, buffer, 0, bytesToRead, Math.max(0, size - bytesToRead)); }
      finally { fs.closeSync(file); }
      const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const match = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(.*)$/);
        entries.push({ source, timestamp: match?.[1] || "", message: match?.[2] || line });
      }
    } catch { /* Log files are optional until the desktop launcher starts. */ }
  }
  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-maxEntries).reverse();
}

const server = https.createServer({
  pfx: fs.readFileSync(pfxPath),
  passphrase: pfxPassphrase,
}, (request, response) => {
  const origin = request.headers.origin || "";
  const allowedOrigins = new Set([
    "https://localhost",
    "capacitor://localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://lacaksmb.marwanyahabibi.workers.dev",
    "https://lacaksmbbot.com",
    "https://www.lacaksmbbot.com",
  ]);
  if (allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    response.setHeader("access-control-allow-headers", "Authorization,Content-Type");
    response.setHeader("vary", "Origin");
  }
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, service: "smb-fleet-broker" }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/auth/login") {
    void readJsonRequest(request).then((body) => {
      const username = validateUsername(body.username);
      if (loginIsThrottled(database, username || body.username)) {
        respondJson(response, 429, { error: "too_many_attempts", message: "Terlalu banyak percobaan. Coba lagi setelah 15 menit." });
        return;
      }
      const user = username ? database.prepare("SELECT * FROM admin_users WHERE username=?").get(username) : null;
      if (!verifyAdminPassword(user, body.password)) {
        recordLoginAttempt(database, username || body.username, false);
        respondJson(response, 401, { error: "invalid_credentials", message: "Username atau password salah." });
        return;
      }
      if (!user.totp_enabled) {
        recordLoginAttempt(database, username, true);
        const enrollment = makeTotpEnrollment(database, user, adminAuthEncryptionKey);
        respondJson(response, 200, { stage: "enroll_totp", setupToken: enrollment.setupToken, secret: enrollment.secret, otpauthUri: enrollment.otpauthUri, expiresAt: enrollment.expiresAt });
        return;
      }
      if (!body.totpCode) {
        respondJson(response, 200, { stage: "verify_totp" });
        return;
      }
      if (verifyAdminTotp(database, user, body.totpCode, adminAuthEncryptionKey) === null) {
        recordLoginAttempt(database, username, false);
        respondJson(response, 401, { error: "invalid_totp", message: "Kode authenticator salah atau sudah pernah dipakai." });
        return;
      }
      recordLoginAttempt(database, username, true);
      const session = createAdminSession(database, user.id);
      respondJson(response, 200, { stage: "authenticated", sessionToken: session.token, expiresAt: session.expiresAt, user: publicAdminUser(user) });
    }).catch((error) => respondJson(response, error.statusCode || 400, { error: error.code || "invalid_request", message: error.publicMessage || "Permintaan login tidak valid." }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/auth/totp/confirm") {
    void readJsonRequest(request).then((body) => {
      const setupToken = String(body.setupToken || "");
      const pendingAdmin = database.prepare(`
        SELECT u.username FROM admin_totp_pending p
        JOIN admin_users u ON u.id=p.admin_user_id
        WHERE p.setup_hash=? AND p.expires_at>?
      `).get(tokenDigest(setupToken), new Date().toISOString());
      const attemptKey = pendingAdmin?.username || "totp-enrollment";
      if (loginIsThrottled(database, attemptKey)) {
        respondJson(response, 429, { error: "too_many_attempts", message: "Terlalu banyak percobaan. Coba lagi setelah 15 menit." });
        return;
      }
      const result = completeTotpEnrollment(database, setupToken, body.totpCode, adminAuthEncryptionKey);
      if (!result) {
        recordLoginAttempt(database, attemptKey, false);
        respondJson(response, 401, { error: "invalid_totp", message: "Kode salah atau sesi penyiapan 2FA kedaluwarsa. Ulangi login." });
        return;
      }
      recordLoginAttempt(database, result.user.username, true);
      respondJson(response, 200, { stage: "authenticated", sessionToken: result.session.token, expiresAt: result.session.expiresAt, user: publicAdminUser(result.user) });
    }).catch((error) => respondJson(response, error.statusCode || 400, { error: error.code || "invalid_request", message: error.publicMessage || "Penyiapan 2FA tidak valid." }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/auth/me") {
    const admin = resolveAdminSession(database, bearerToken(request));
    if (!admin) { respondJson(response, 401, { error: "unauthorized" }); return; }
    respondJson(response, 200, { user: publicAdminUser(admin), expiresAt: admin.expiresAt });
    return;
  }
  if (request.method === "POST" && request.url === "/api/auth/logout") {
    revokeAdminSession(database, bearerToken(request));
    respondJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && request.url === "/api/auth/password") {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    void readJsonRequest(request).then((body) => {
      const user = database.prepare("SELECT * FROM admin_users WHERE id=?").get(admin.id);
      if (!verifyAdminPassword(user, body.currentPassword)
        || verifyAdminTotp(database, user, body.totpCode, adminAuthEncryptionKey) === null) {
        respondJson(response, 401, { error: "reauthentication_failed", message: "Password saat ini atau kode 2FA salah." });
        return;
      }
      updateAdminPassword(database, admin.id, body.newPassword);
      respondJson(response, 200, { ok: true, message: "Password berhasil diperbarui." });
    }).catch((error) => respondJson(response, error.statusCode || 400, { error: error.code || "invalid_request", message: error.publicMessage || error.message || "Password tidak dapat diperbarui." }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/admin/operations") {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    respondJson(response, 200, { generatedAt: new Date().toISOString(), broker: { status: "online", host, port }, logs: readOperationLogs() });
    return;
  }
  if (request.method === "GET" && request.url === "/api/admin/telegram/access") {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden" }); return; }
    const accesses = database.prepare("SELECT chat_id AS chatId,role,granted_at AS grantedAt,granted_by AS grantedBy,revoked_at AS revokedAt FROM telegram_chat_access ORDER BY granted_at DESC").all();
    const codes = database.prepare("SELECT issued_by AS issuedBy,created_at AS createdAt,expires_at AS expiresAt,used_at AS usedAt,used_by_chat_id AS usedByChatId FROM telegram_access_codes WHERE created_at>? ORDER BY created_at DESC LIMIT 20").all(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString());
    respondJson(response, 200, { telegramConfigured: Boolean(telegramToken), accesses, codes });
    return;
  }
  if (request.method === "POST" && request.url === "/api/admin/telegram/otp") {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden" }); return; }
    if (!telegramToken) { respondJson(response, 503, { error: "telegram_unconfigured", message: "Telegram bot belum dikonfigurasi pada broker PC." }); return; }
    const code = String(randomInt(10_000_000, 100_000_000));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    database.prepare("UPDATE telegram_access_codes SET expires_at=? WHERE used_at IS NULL").run(now.toISOString());
    database.prepare("DELETE FROM telegram_access_codes WHERE created_at<?").run(new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString());
    database.prepare("INSERT INTO telegram_access_codes (code_hash,issued_by,created_at,expires_at) VALUES (?,?,?,?)")
      .run(tokenDigest(code), admin.username, now.toISOString(), expiresAt);
    respondJson(response, 201, { code, expiresAt, message: "OTP hanya ditampilkan sekali. Berlaku 10 menit dan hanya dapat dipakai satu chat Telegram." });
    return;
  }
  const revokeTelegramAccess = request.method === "DELETE" && request.url.match(/^\/api\/admin\/telegram\/access\/(-?\d+)$/);
  if (revokeTelegramAccess) {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden" }); return; }
    const chatId = revokeTelegramAccess[1];
    if (chatId === telegramAdminChatId) { respondJson(response, 400, { error: "cannot_revoke_owner", message: "Chat owner dari konfigurasi server tidak dapat dicabut dari dashboard." }); return; }
    const result = database.prepare("UPDATE telegram_chat_access SET revoked_at=? WHERE chat_id=? AND role='operator' AND revoked_at IS NULL")
      .run(new Date().toISOString(), chatId);
    if (!result.changes) { respondJson(response, 404, { error: "access_not_found" }); return; }
    respondJson(response, 200, { ok: true, message: "Akses Telegram dicabut." });
    return;
  }
  const downloadMatch = request.method === "GET" && request.url.match(/^\/api\/admin\/downloads\/(tracker|master|server)(?:\?.*)?$/);
  if (downloadMatch) {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    const artifact = artifactDownloads[downloadMatch[1]];
    const artifactPath = path.join(root, "artifacts", artifact.file);
    try { fs.statSync(artifactPath); }
    catch {
      respondJson(response, 404, { error: "artifact_unavailable", message: "File unduhan belum dibuat pada PC broker." });
      return;
    }

    // APK Lacak per-site: kode enrolmen 24 jam ditanamkan ke dalam APK, jadi HP
    // langsung terdaftar ke site tsb tanpa perlu mengetik kode apa pun.
    const query = new URL(request.url, "https://local").searchParams;
    const siteIdParam = query.get("siteId");
    if (downloadMatch[1] === "tracker" && siteIdParam) {
      if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden", message: "Hanya superadmin yang boleh membuat APK per-site." }); return; }
      const siteId = Number(siteIdParam);
      const site = sites.get(siteId);
      if (!site) { respondJson(response, 404, { error: "site_not_found", message: "Site/tim tidak ditemukan." }); return; }
      void buildSiteBoundTrackerApk(site, admin.username).then(({ apkPath, downloadName }) => {
        response.writeHead(200, {
          "content-type": artifact.contentType,
          "content-length": fs.statSync(apkPath).size,
          "content-disposition": `attachment; filename="${downloadName}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
        const stream = fs.createReadStream(apkPath);
        stream.on("end", () => fs.rm(path.dirname(apkPath), { recursive: true, force: true }, () => {}));
        stream.on("error", () => response.destroy());
        stream.pipe(response);
      }).catch((error) => {
        console.error("Gagal membuat APK per-site:", error);
        if (!response.headersSent) respondJson(response, 500, { error: "apk_patch_failed", message: `Gagal menyiapkan APK per-site: ${error.message}` });
        else response.destroy();
      });
      return;
    }

    const stat = fs.statSync(artifactPath);
    response.writeHead(200, {
      "content-type": artifact.contentType,
      "content-length": stat.size,
      "content-disposition": `attachment; filename=\"${artifact.downloadName}\"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    const stream = fs.createReadStream(artifactPath);
    stream.on("error", () => { if (!response.headersSent) respondJson(response, 500, { error: "download_failed" }); else response.destroy(); });
    stream.pipe(response);
    return;
  }
  if (request.method === "GET" && request.url === "/api/admin/users") {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden" }); return; }
    respondJson(response, 200, { users: listAdminUsers(database) });
    return;
  }
  if (request.method === "POST" && request.url === "/api/admin/users") {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden" }); return; }
    void readJsonRequest(request).then((body) => {
      const created = createAdminUser(database, body.username, body.password, body.role || "staff");
      respondJson(response, 201, { user: created, message: "Akun dibuat. Pengguna wajib mendaftarkan authenticator saat login pertama." });
    }).catch((error) => {
      const duplicate = /UNIQUE constraint failed: admin_users\.username/i.test(error.message || "");
      respondJson(response, duplicate ? 409 : error.statusCode || 400, {
        error: duplicate ? "username_taken" : error.code || "invalid_request",
        message: duplicate ? "Username sudah digunakan." : error.message || "Data admin tidak valid.",
      });
    });
    return;
  }
  const resetTotpMatch = request.method === "POST" && request.url.match(/^\/api\/admin\/users\/(\d+)\/reset-totp$/);
  if (resetTotpMatch) {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden" }); return; }
    const targetUserId = Number(resetTotpMatch[1]);
    if (targetUserId === admin.id) { respondJson(response, 400, { error: "cannot_reset_self", message: "Gunakan authenticator yang sedang aktif atau minta superadmin lain membantu." }); return; }
    const user = database.prepare("SELECT id FROM admin_users WHERE id=?").get(targetUserId);
    if (!user) { respondJson(response, 404, { error: "user_not_found" }); return; }
    resetAdminTotp(database, targetUserId);
    for (const client of adminSockets) {
      if (client.adminSession?.id === targetUserId) client.close(4003, "Admin 2FA was reset");
    }
    respondJson(response, 200, { ok: true, message: "2FA direset; pengguna harus mendaftarkan authenticator lagi." });
    return;
  }
  // ── Site / tim (superadmin) ─────────────────────────────────────────────────
  if (request.method === "GET" && request.url === "/api/admin/sites") {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    respondJson(response, 200, { sites: [...sites.values()].map(publicSite), lanBrokerUrl });
    return;
  }
  if (request.method === "POST" && request.url === "/api/admin/sites") {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden", message: "Hanya superadmin yang boleh mengelola site/tim." }); return; }
    void readJsonRequest(request).then((body) => {
      const site = createSite(body);
      reloadSites();
      publishDevices();
      respondJson(response, 201, { site: publicSite(site), message: `Site/tim ${site.name} dibuat.` });
    }).catch((error) => respondJson(response, error.statusCode || 400, { error: error.code || "invalid_site", message: error.publicMessage || error.message || "Site/tim tidak dapat dibuat." }));
    return;
  }
  const siteMatch = request.url.match(/^\/api\/admin\/sites\/(\d+)(\/enrollment-code)?$/);
  if (siteMatch && (request.method === "PUT" || request.method === "DELETE" || (request.method === "POST" && siteMatch[2]))) {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden", message: "Hanya superadmin yang boleh mengelola site/tim." }); return; }
    const siteId = Number(siteMatch[1]);
    const site = sites.get(siteId);
    if (!site) { respondJson(response, 404, { error: "site_not_found", message: "Site/tim tidak ditemukan." }); return; }

    if (request.method === "POST" && siteMatch[2]) {
      const code = generateEnrollmentCode();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
      database.prepare("DELETE FROM enrollment_codes WHERE expires_at<? OR used_at IS NOT NULL").run(new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString());
      database.prepare("INSERT INTO enrollment_codes (code_hash,site_id,device_label,issued_by,created_at,expires_at) VALUES (?,?,?,?,?,?)")
        .run(tokenDigest(code), siteId, null, admin.username, now.toISOString(), expiresAt);
      respondJson(response, 201, { code, expiresAt, site: publicSite(site), message: `Kode enrolmen untuk site/tim ${site.name} berlaku 24 jam dan hanya bisa dipakai sekali.` });
      return;
    }
    if (request.method === "PUT") {
      void readJsonRequest(request).then((body) => {
        const name = body.name === undefined ? site.name : String(body.name || "").trim();
        const allowlist = body.wifiAllowlist === undefined ? site.wifiAllowlist : normalizeWifiAllowlist(body.wifiAllowlist);
        if (!name || name.length > 40) throw badRequest("Nama site/tim harus 1-40 karakter.");
        const clash = [...sites.values()].find((item) => item.id !== siteId && item.name.toLocaleLowerCase("id-ID") === name.toLocaleLowerCase("id-ID"));
        if (clash) throw badRequest("Nama site/tim sudah dipakai.");
        const updatedAt = new Date().toISOString();
        database.prepare("UPDATE sites SET name=?,wifi_allowlist=?,updated_at=? WHERE id=?").run(name, JSON.stringify(allowlist), updatedAt, siteId);
        reloadSites();
        publishDevices();
        respondJson(response, 200, { site: publicSite(sites.get(siteId)), message: "Site/tim diperbarui." });
      }).catch((error) => respondJson(response, error.statusCode || 400, { error: error.code || "invalid_site", message: error.publicMessage || error.message || "Site/tim tidak dapat diperbarui." }));
      return;
    }
    // DELETE: perangkat dilepas dari site, kode enrolmen site ikut terhapus.
    database.prepare("UPDATE devices SET site_id=NULL WHERE site_id=?").run(siteId);
    database.prepare("DELETE FROM enrollment_codes WHERE site_id=?").run(siteId);
    database.prepare("DELETE FROM sites WHERE id=?").run(siteId);
    for (const [deviceId, device] of devices) if (device.siteId === siteId) { device.siteId = null; wifiViolationNotifiedAt.delete(deviceId); }
    reloadSites();
    publishDevices();
    respondJson(response, 200, { ok: true, message: `Site/tim ${site.name} dihapus. Perangkatnya tetap terdaftar tanpa site.` });
    return;
  }

  // ── Kontrol perangkat (buka/blokir hapus, hapus perangkat lama) ─────────────
  const uninstallBlockMatch = request.method === "POST" && request.url.match(/^\/api\/admin\/devices\/([^/]+)\/uninstall-block$/);
  if (uninstallBlockMatch) {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    const deviceId = decodeURIComponent(uninstallBlockMatch[1]);
    const device = devices.get(deviceId);
    if (!device || device.role !== "tracker") { respondJson(response, 404, { error: "device_not_found", message: "Perangkat tracker tidak ditemukan." }); return; }
    void readJsonRequest(request).then((body) => {
      if (typeof body.blocked !== "boolean") throw badRequest("Field blocked harus boolean.");
      setUninstallBlockedState(deviceId, body.blocked);
      respondJson(response, 200, { ok: true, blocked: device.uninstallBlocked, message: device.uninstallBlocked ? "Penghapusan aplikasi diblokir." : "Penghapusan aplikasi diizinkan sementara." });
    }).catch((error) => respondJson(response, error.statusCode || 400, { error: error.code || "invalid_request", message: error.publicMessage || error.message || "Permintaan tidak valid." }));
    return;
  }
  const deviceDeleteMatch = request.method === "DELETE" && request.url.match(/^\/api\/admin\/devices\/([^/]+)$/);
  if (deviceDeleteMatch) {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (admin.role !== "superadmin") { respondJson(response, 403, { error: "forbidden", message: "Hanya superadmin yang boleh menghapus perangkat." }); return; }
    const deviceId = decodeURIComponent(deviceDeleteMatch[1]);
    const device = devices.get(deviceId);
    if (!device) { respondJson(response, 404, { error: "device_not_found", message: "Perangkat tidak ditemukan." }); return; }
    if (device.role !== "tracker") { respondJson(response, 400, { error: "not_tracker", message: "Hanya perangkat tracker yang bisa dihapus dari daftar." }); return; }
    purgeDevice(deviceId);
    publishDevices();
    respondJson(response, 200, { ok: true, message: `Perangkat ${device.name} (${deviceId}) dihapus. Enrolmen baru diperlukan untuk memakainya lagi.` });
    return;
  }

  // ── Enrolmen HP tracker (tanpa sesi admin: kode enrolmen yang menjadi rahasia) ─
  if (request.method === "POST" && request.url === "/api/enroll") {
    void readJsonRequest(request).then(async (body) => {
      const deviceId = String(body.deviceId || "").trim();
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(deviceId)) throw badRequest("ID perangkat tidak valid.");
      const existing = devices.get(deviceId);
      if (existing?.role === "master") throw badRequest("ID perangkat tidak dapat dipakai untuk tracker.");
      const presentedToken = String(body.token || "");
      if (presentedToken && authenticateDevice(deviceId, presentedToken)) {
        respondJson(response, 200, enrollPayload(deviceId, presentedToken));
        return;
      }
      if (!enrollAttempts.allow()) { respondJson(response, 429, { error: "too_many_attempts", message: "Terlalu banyak percobaan enrolmen. Coba lagi satu menit." }); return; }
      const code = normalizeEnrollmentCode(body.code);
      const row = code ? database.prepare("SELECT * FROM enrollment_codes WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").get(tokenDigest(code), new Date().toISOString()) : null;
      if (!row) { enrollAttempts.recordFailure(); throw badRequest("Kode enrolmen salah, kedaluwarsa, atau sudah dipakai."); }
      const site = sites.get(row.site_id);
      if (!site) throw badRequest("Site/tim pada kode enrolmen sudah dihapus. Minta kode baru kepada superadmin.");
      const deviceToken = randomBytes(32).toString("base64url");
      const now = new Date().toISOString();
      const displayName = String(body.name || "").trim().slice(0, 40) || existing?.name || `${site.name} ${deviceId.slice(-4)}`;
      const siteId = site.id;
      database.prepare("INSERT INTO devices (device_id,name,role,site_id,token_hash,created_at,updated_at) VALUES (?,?,'tracker',?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET name=excluded.name,site_id=excluded.site_id,token_hash=excluded.token_hash,updated_at=excluded.updated_at")
        .run(deviceId, displayName, siteId, tokenDigest(deviceToken), now, now);
      database.prepare("INSERT OR IGNORE INTO device_state (device_id,connected,updated_at) VALUES (?,0,?)").run(deviceId, now);
      database.prepare("UPDATE enrollment_codes SET used_at=?,device_id=? WHERE code_hash=?").run(now, deviceId, row.code_hash);
      const device = devices.get(deviceId) || { role: "tracker", name: displayName, connected: false, siteId: null };
      device.name = displayName;
      device.role = "tracker";
      device.siteId = siteId;
      devices.set(deviceId, device);
      queueSupabaseDevice(deviceId);
      queueSupabaseState(deviceId);
      telemetryFor(deviceId);
      publishDevices();
      console.log(`Device ${deviceId} enrolled for site ${site.name} by enrollment code.`);
      respondJson(response, 201, enrollPayload(deviceId, deviceToken));
    }).catch((error) => respondJson(response, error.statusCode || 400, { error: error.code || "enroll_failed", message: error.publicMessage || error.message || "Enrolmen gagal." }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/broker-info") {
    const deviceId = urlQuery(request).get("deviceId") || "";
    const device = devices.get(deviceId);
    if (!device || !authenticateDevice(deviceId, urlQuery(request).get("token") || "")) { respondJson(response, 401, { error: "unauthorized" }); return; }
    respondJson(response, 200, enrollPayload(deviceId, urlQuery(request).get("token") || ""));
    return;
  }

  if (request.method === "GET" && (request.url === "/api/admin/snapshot" || request.url.startsWith("/api/admin/commands"))) {
    const admin = requireAdminSession(request, response);
    if (!admin) return;
    if (request.url === "/api/admin/snapshot") {
      const url = new URL(request.url, `https://${request.headers.host || "localhost"}`);
      const trackerIds = [...devices.entries()].filter(([, device]) => device.role === "tracker").map(([deviceId]) => deviceId);
      const historyDeviceId = trackerIds.includes(url.searchParams.get("deviceId") || "") ? url.searchParams.get("deviceId") : trackerIds[0];
      const rows = database.prepare("SELECT * FROM command_log ORDER BY created_at DESC LIMIT 30").all().map(publicCommandRow);
      const signalHistory = historyDeviceId ? database.prepare("SELECT minute_at AS minuteAt,sample_count AS sampleCount,detected_count AS detectedCount,CASE WHEN rssi_count=0 THEN NULL ELSE CAST(rssi_sum AS REAL)/rssi_count END AS rssiAvg,rssi_min AS rssiMin,rssi_max AS rssiMax,battery_level AS batteryLevel FROM telemetry_minute WHERE device_id=? ORDER BY minute_at DESC LIMIT 60").all(historyDeviceId).reverse() : [];
      const locationHistory = historyDeviceId ? database.prepare("SELECT * FROM location_history WHERE device_id=? ORDER BY captured_at DESC LIMIT 100").all(historyDeviceId).map(decryptLocationRow).reverse() : [];
      const telemetry = Object.fromEntries([...telemetryByDevice.entries()]);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ service: "smb-fleet-broker", generatedAt: new Date().toISOString(), admin: publicAdminUser(admin), devices: publicDevices(), telemetry: historyDeviceId ? (telemetry[historyDeviceId] || null) : null, telemetryByDevice: telemetry, sites: [...sites.values()].map(publicSite), lanBrokerUrl, historyDeviceId, locationHistory, signalHistory, commands: rows, telegram: { configured: Boolean(telegramToken), adminChatConfigured: Boolean(telegramAdminChatId) }, supabase: { configured: supabaseEnabled } }));
      return;
    }
    const url = new URL(request.url, `https://${request.headers.host || "localhost"}`);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
    const rows = database.prepare("SELECT * FROM command_log ORDER BY created_at DESC LIMIT ?").all(limit).map(publicCommandRow);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ commands: rows }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/telemetry") {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      const auth = request.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const deviceId = String(payload.deviceId || "");
      const device = devices.get(deviceId);
      if (!device || device.role !== "tracker" || !authenticateDevice(deviceId, token)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const detected = payload.detected === true;
      const rssi = Number.isInteger(payload.rssi) && payload.rssi >= -127 && payload.rssi <= 20 ? payload.rssi : null;
      const batteryLevel = Number.isInteger(payload.batteryLevel) && payload.batteryLevel >= 0 && payload.batteryLevel <= 100 ? payload.batteryLevel : null;
      const location = validatedLocation(payload);
      const wifiSsid = normalizeSsid(payload.wifiSsid);
      const telemetry = setTelemetry(deviceId, {
        detected,
        rssi: detected ? rssi : null,
        deviceOwner: payload.deviceOwner === true,
        lockTaskMode: Number.isInteger(payload.lockTaskMode) ? payload.lockTaskMode : 0,
        batteryLevel,
        wifiSsid,
        ...(location || {}),
        receivedAt: new Date().toISOString(),
        online: true,
      });
      persistTelemetry(telemetry);
      sendToMasters({ type: "telemetry", ...telemetry });
      void evaluateWifiPolicy(deviceId, wifiSsid);
      response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ accepted: true, receivedAt: telemetry.receivedAt, lanBrokerUrl }));
    });
    return;
  }
  // Foto jarak jauh: hanya dipanggil saat admin/Telegram mengirim perintah photo.
  // Tidak ada timer pengambilan foto; APK mengirim satu bila diminta.
  if (request.method === "POST" && request.url === "/api/telemetry/photo") {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", async () => {
      const auth = request.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const deviceId = String(payload.deviceId || "");
      const device = devices.get(deviceId);
      if (!device || device.role !== "tracker" || !authenticateDevice(deviceId, token)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const image = Buffer.from(String(payload.imageBase64 || ""), "base64");
      const validJpeg = image.length >= 100 && image.length <= 4 * 1024 * 1024 && image[0] === 0xff && image[1] === 0xd8;
      if (!validJpeg) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_image", message: "Foto tidak diterima: harus JPEG maksimal 4 MB." }));
        return;
      }
      const capturedAt = typeof payload.capturedAt === "string" && Number.isFinite(Date.parse(payload.capturedAt))
        ? payload.capturedAt : new Date().toISOString();
      const photoDirectory = path.join(root, "data", "photos");
      fs.mkdirSync(photoDirectory, { recursive: true });
      const filename = `${String(deviceId).replace(/[^A-Za-z0-9_-]/g, "")}-${Date.now()}.jpg`;
      fs.writeFileSync(path.join(photoDirectory, filename), image);
      prunePhotos(photoDirectory);
      // Penerima: chat yang meminta perintah ini, atau chat admin berasal dari web.
      const command = payload.commandId ? commands.get(String(payload.commandId)) : null;
      const sourceChat = String(command?.issuedBy || "").match(/^telegram:(-?\d+)$/)?.[1];
      const chatId = sourceChat || telegramAdminChatId;
      const site = siteOf(deviceId);
      const caption = `Foto ${device.name} (${deviceId})${site ? ` · site ${site.name}` : ""}\nDiambil: ${capturedAt}\nPermintaan: ${command?.command || "photo"}${command?.issuedBy ? ` oleh ${command.issuedBy}` : ""}`;
      let notified = false;
      if (telegramToken && chatId) {
        try {
          await telegramSendPhoto(chatId, image, caption);
          notified = true;
        } catch (error) {
          console.error("Telegram photo upload failed:", error.message);
        }
      }
      console.log(`Photo from ${deviceId} saved as ${filename} (${image.length} bytes)${notified ? " and sent to Telegram" : ""}.`);
      response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ accepted: true, savedAs: filename, notified, capturedAt }));
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const adminSockets = new Set();

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);
  const deviceId = url.searchParams.get("deviceId") || "";
  let device = devices.get(deviceId);
  const token = url.searchParams.get("token") || "";

  // Auto-register master jika belum ada di DB tapi tokennya valid (masterToken dari env)
  if (!device && masterToken && token === masterToken && /^[A-Za-z0-9_-]{4,64}$/.test(deviceId)) {
    const now = new Date().toISOString();
    database.prepare("INSERT INTO devices (device_id,name,role,created_at,updated_at) VALUES (?,?,'master',?,?) ON CONFLICT(device_id) DO NOTHING")
      .run(deviceId, "SMB Master", now, now);
    database.prepare("INSERT OR IGNORE INTO device_state (device_id,connected,updated_at) VALUES (?,0,?)").run(deviceId, now);
    device = { role: "master", name: "SMB Master", connected: false, siteId: null, uninstallBlocked: false };
    devices.set(deviceId, device);
    console.log(`Master device ${deviceId} auto-registered on first connect.`);
  }

  const adminSession = device?.role === "master" && token !== masterToken
    ? resolveAdminSession(database, token)
    : null;
  const isAuthorizedDevice = Boolean(device) && authenticateDevice(deviceId, token);
  if (url.pathname !== "/ws" || !device || (!isAuthorizedDevice && !adminSession)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSocket.deviceId = deviceId;
    webSocket.role = device.role;
    webSocket.adminSession = adminSession;
    webSockets.emit("connection", webSocket);
  });
});

webSockets.on("connection", (webSocket) => {
  if (webSocket.adminSession) {
    adminSockets.add(webSocket);
    webSocket.adminSessionExpiresAt = webSocket.adminSession.expiresAt;
    sendTelemetrySnapshot(webSocket);
  } else {
    sockets.get(webSocket.deviceId)?.close(4001, "Replaced by a newer session");
    sockets.set(webSocket.deviceId, webSocket);
    devices.get(webSocket.deviceId).connected = true;
    persistDeviceConnection(webSocket.deviceId, true);
    if (webSocket.role === "master") sendTelemetrySnapshot(webSocket);
    if (webSocket.role === "tracker") send(webSocket, { type: "uninstallBlocked", blocked: devices.get(webSocket.deviceId)?.uninstallBlocked !== false });
  }
  publishDevices();
  if (webSocket.role === "tracker" && !webSocket.adminSession) drainQueue(webSocket.deviceId);

  webSocket.on("message", (rawMessage) => {
    let message;
    try { message = JSON.parse(rawMessage.toString()); } catch { return; }
    if (webSocket.role === "tracker" && message.type === "telemetry") {
      const detected = message.detected === true;
      const rssi = Number.isInteger(message.rssi) && message.rssi >= -127 && message.rssi <= 20 ? message.rssi : null;
      const wifiSsid = normalizeSsid(message.wifiSsid);
      const telemetry = setTelemetry(webSocket.deviceId, {
        detected,
        rssi: detected ? rssi : null,
        receivedAt: new Date().toISOString(),
        online: true,
        ...(wifiSsid ? { wifiSsid } : {}),
      });
      persistTelemetry(telemetry);
      sendToMasters({ type: "telemetry", ...telemetry });
      if (wifiSsid) void evaluateWifiPolicy(webSocket.deviceId, wifiSsid);
      return;
    }
    if (webSocket.role === "master" && message.type === "commandRequest") {
      const target = devices.get(message.targetId);
      if (!target || target.role !== "tracker" || !ALLOWED_COMMANDS.has(message.command)) {
        send(webSocket, { type: "commandResult", ok: false, error: "Target or command is not allowed." });
        return;
      }
      const queued = enqueueCommand(message.targetId, message.command, webSocket.adminSession?.username || "master");
      if (!queued) send(webSocket, { type: "commandResult", ok: false, error: "Target or command is not allowed." });
      return;
    }
    if (webSocket.role === "master" && message.type === "renameRequest") {
      const device = devices.get(message.targetId);
      const newName = String(message.newName || "").trim();
      if (!device || device.role !== "tracker" || !newName || newName.length > 40
        || [...devices.entries()].some(([id, item]) => id !== message.targetId && normalizeName(item.name) === normalizeName(newName))) {
        send(webSocket, { type: "commandResult", ok: false, error: "Target/name not allowed or ambiguous." });
        return;
      }
      device.name = newName;
      persistDeviceNames();
      publishDevices();
      send(webSocket, { type: "commandResult", ok: true, detail: `Renamed to ${newName}` });
      return;
    }
    if (webSocket.role === "tracker" && message.type === "commandAck") {
      acknowledge(message.commandId, message.ok === true, String(message.detail || ""), webSocket.deviceId, message.lockTaskMode);
    }
  });

  webSocket.on("close", () => {
    if (webSocket.adminSession) {
      adminSockets.delete(webSocket);
      return;
    }
    if (sockets.get(webSocket.deviceId) !== webSocket) return;
    sockets.delete(webSocket.deviceId);
    devices.get(webSocket.deviceId).connected = false;
    persistDeviceConnection(webSocket.deviceId, false);
    if (devices.get(webSocket.deviceId)?.role === "tracker") {
      const offline = setTelemetry(webSocket.deviceId, { detected: false, rssi: null, online: false, receivedAt: new Date().toISOString() });
      sendToMasters({ type: "telemetry", ...offline });
    }
    publishDevices();
  });
});

function send(webSocket, packet) {
  if (webSocket?.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(packet));
}
function broadcast(packet, deviceId) { send(sockets.get(deviceId), packet); }
function sendToMasters(packet) {
  // Kirim ke SEMUA perangkat master yang terhubung (bukan cuma satu)
  for (const [deviceId, socket] of sockets) {
    if (devices.get(deviceId)?.role === "master") send(socket, packet);
  }
  for (const client of adminSockets) send(client, packet);
}
function sendTelemetrySnapshot(webSocket) {
  for (const [deviceId, telemetry] of telemetryByDevice) send(webSocket, { type: "telemetry", ...telemetry });
}
function publicDevices(includeLocation = true) {
  const stateById = new Map(database.prepare("SELECT device_id,last_seen_at,telemetry_json FROM device_state").all().map((state) => [state.device_id, state]));
  return [...devices.entries()].map(([deviceId, device]) => {
    const state = stateById.get(deviceId);
    let telemetry = null;
    try { telemetry = state?.telemetry_json ? JSON.parse(state.telemetry_json) : null; } catch { telemetry = null; }
    const live = telemetryByDevice.get(deviceId);
    const site = siteOf(deviceId);
    return {
      deviceId,
      name: device.name,
      role: device.role,
      online: device.connected,
      lastSeenAt: state?.last_seen_at || null,
      siteId: site?.id ?? null,
      siteName: site?.name ?? null,
      wifiSsid: live?.wifiSsid ?? telemetry?.wifiSsid ?? null,
      uninstallBlocked: device.role === "tracker" && device.uninstallBlocked !== false,
      telemetry: publicTelemetry({ ...(telemetry || {}), ...(live || {}) }, includeLocation),
    };
  });
}
function publicTelemetry(telemetry, includeLocation = true) {
  if (!telemetry || includeLocation) return telemetry;
  const { latitude, longitude, accuracyMeters, locationAt, locationProvider, ...safe } = telemetry;
  return safe;
}
function publishDevices() { sendToMasters({ type: "devices", devices: publicDevices() }); }

/**
 * Status blokir hapus-aplikasi disimpan di broker dan dikirim ke HP tracker,
 * sehingga penghapusan hanya bisa dimulai dari master/web (bukan dari HP).
 */
function setUninstallBlockedState(deviceId, blocked) {
  const device = devices.get(deviceId);
  if (!device) return;
  device.uninstallBlocked = Boolean(blocked);
  database.prepare("UPDATE devices SET uninstall_blocked=?,updated_at=? WHERE device_id=?")
    .run(device.uninstallBlocked ? 1 : 0, new Date().toISOString(), deviceId);
  queueSupabaseDevice(deviceId);
  const socket = sockets.get(deviceId);
  if (socket && socket.role === "tracker") send(socket, { type: "uninstallBlocked", blocked: device.uninstallBlocked });
  publishDevices();
}

/**
 * Hapus total satu perangkat tracker (socket, antrean, telemetri, dan semua baris
 * DB-nya). Dipakai oleh endpoint DELETE admin DAN oleh auto-hapus setelah perintah
 * uninstall dikonfirmasi di HP, supaya "hapus app" juga melenyapkan perangkat dari
 * web admin dan master. FK anak tidak ON DELETE CASCADE, jadi dihapus lebih dulu.
 */
function purgeDevice(deviceId) {
  const device = devices.get(deviceId);
  if (!device) return null;
  sockets.get(deviceId)?.close(4001, "Device removed");
  sockets.delete(deviceId);
  queues.delete(deviceId);
  telemetryByDevice.delete(deviceId);
  wifiViolationNotifiedAt.delete(deviceId);
  database.prepare("DELETE FROM telemetry_minute WHERE device_id=?").run(deviceId);
  database.prepare("DELETE FROM command_log WHERE device_id=?").run(deviceId);
  database.prepare("DELETE FROM location_history WHERE device_id=?").run(deviceId);
  database.prepare("DELETE FROM device_state WHERE device_id=?").run(deviceId);
  database.prepare("DELETE FROM devices WHERE device_id=?").run(deviceId);
  devices.delete(deviceId);
  queueSupabaseDevice(deviceId);
  return device;
}

function persistDeviceNames() {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const names = Object.fromEntries([...devices.entries()].map(([id, device]) => [id, device.name]));
  fs.writeFileSync(registryPath, JSON.stringify({ names, updatedAt: new Date().toISOString() }, null, 2));
  const saveName = database.prepare("UPDATE devices SET name=?,updated_at=? WHERE device_id=?");
  for (const [deviceId, name] of Object.entries(names)) saveName.run(name, new Date().toISOString(), deviceId);
  for (const deviceId of Object.keys(names)) queueSupabaseDevice(deviceId);
}

function persistDeviceConnection(deviceId, connected) {
  database.prepare("INSERT INTO device_state (device_id,connected,last_seen_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET connected=excluded.connected,last_seen_at=CASE WHEN excluded.connected=1 THEN excluded.last_seen_at ELSE device_state.last_seen_at END,updated_at=excluded.updated_at")
    .run(deviceId, connected ? 1 : 0, connected ? new Date().toISOString() : null, new Date().toISOString());
  queueSupabaseState(deviceId);
}
function persistTelemetry(telemetry) {
  const safeTelemetry = publicTelemetry(telemetry, false);
  database.prepare("INSERT INTO device_state (device_id,connected,last_seen_at,telemetry_json,updated_at) VALUES (?,1,?,?,?) ON CONFLICT(device_id) DO UPDATE SET connected=1,last_seen_at=excluded.last_seen_at,telemetry_json=excluded.telemetry_json,updated_at=excluded.updated_at")
    .run(telemetry.deviceId, telemetry.receivedAt, JSON.stringify(safeTelemetry), new Date().toISOString());
  if (Number.isFinite(telemetry.latitude) && Number.isFinite(telemetry.longitude) && telemetry.locationAt) {
    const point = { latitude: telemetry.latitude, longitude: telemetry.longitude, accuracyMeters: telemetry.accuracyMeters ?? null, locationProvider: telemetry.locationProvider || "unknown" };
    if (shouldPersistLocation(telemetry.deviceId, point, telemetry.locationAt)) {
      const encrypted = encryptLocation(point);
      database.prepare("INSERT INTO location_history (device_id,captured_at,received_at,nonce,coordinates_enc) VALUES (?,?,?,?,?) ON CONFLICT(device_id,captured_at) DO NOTHING")
        .run(telemetry.deviceId, telemetry.locationAt, telemetry.receivedAt, encrypted.nonce, encrypted.coordinatesEnc);
    }
  }
  const minute = new Date(Date.parse(telemetry.receivedAt));
  minute.setUTCSeconds(0, 0);
  const minuteAt = minute.toISOString();
  const hasRssi = Number.isInteger(telemetry.rssi);
  database.prepare(`INSERT INTO telemetry_minute (device_id,minute_at,sample_count,detected_count,rssi_sum,rssi_count,rssi_min,rssi_max,battery_level)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,minute_at) DO UPDATE SET
    sample_count=sample_count+1,detected_count=detected_count+excluded.detected_count,rssi_sum=rssi_sum+excluded.rssi_sum,rssi_count=rssi_count+excluded.rssi_count,
    rssi_min=CASE WHEN excluded.rssi_min IS NULL THEN rssi_min WHEN rssi_min IS NULL THEN excluded.rssi_min ELSE MIN(rssi_min,excluded.rssi_min) END,
    rssi_max=CASE WHEN excluded.rssi_max IS NULL THEN rssi_max WHEN rssi_max IS NULL THEN excluded.rssi_max ELSE MAX(rssi_max,excluded.rssi_max) END,
    battery_level=COALESCE(excluded.battery_level,battery_level)`)
    .run(telemetry.deviceId, minuteAt, 1, telemetry.detected ? 1 : 0, hasRssi ? telemetry.rssi : 0, hasRssi ? 1 : 0, hasRssi ? telemetry.rssi : null, hasRssi ? telemetry.rssi : null, Number.isInteger(telemetry.batteryLevel) ? telemetry.batteryLevel : null);
  queueSupabaseState(telemetry.deviceId);
}
function validatedLocation(payload) {
  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const accuracyMeters = payload.accuracyMeters;
  const locationAt = typeof payload.locationAt === "string" ? payload.locationAt : "";
  const time = Date.parse(locationAt);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || !Number.isFinite(time) || time > Date.now() + 60_000 || time < Date.now() - 24 * 60 * 60 * 1000) return null;
  const safeAccuracy = Number.isFinite(accuracyMeters) && accuracyMeters >= 0 && accuracyMeters <= 100_000 ? accuracyMeters : null;
  return { latitude, longitude, accuracyMeters: safeAccuracy, locationAt: new Date(time).toISOString(), locationProvider: typeof payload.locationProvider === "string" ? payload.locationProvider.slice(0, 24) : "unknown" };
}
function encryptLocation(point) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", locationEncryptionKey, nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(point), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString("base64"), coordinatesEnc: encrypted.toString("base64") };
}
function decryptLocationRow(row) {
  const encoded = Buffer.from(row.coordinates_enc, "base64");
  const tag = encoded.subarray(encoded.length - 16);
  const ciphertext = encoded.subarray(0, encoded.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", locationEncryptionKey, Buffer.from(row.nonce, "base64"));
  decipher.setAuthTag(tag);
  const point = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  return { ...point, deviceId: row.device_id, locationAt: row.captured_at, receivedAt: row.received_at };
}
function shouldPersistLocation(deviceId, point, capturedAt) {
  const previousRow = database.prepare("SELECT * FROM location_history WHERE device_id=? ORDER BY captured_at DESC LIMIT 1").get(deviceId);
  if (!previousRow) return true;
  const previous = decryptLocationRow(previousRow);
  const elapsed = Date.parse(capturedAt) - Date.parse(previous.locationAt);
  if (elapsed <= 0) return false;
  return elapsed >= 120_000 || distanceMeters(point.latitude, point.longitude, previous.latitude, previous.longitude) >= 35;
}
function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
function publicCommandRow(row) {
  return { id: row.id, deviceId: row.device_id, command: row.command, issuedBy: row.issued_by, status: row.status, createdAt: row.created_at, sentAt: row.sent_at, completedAt: row.completed_at, detail: row.detail };
}

function queueSupabaseDevice(deviceId) {
  if (!supabaseEnabled) return;
  const row = database.prepare("SELECT device_id,name,role,created_at,updated_at FROM devices WHERE device_id=?").get(deviceId);
  if (row) supabaseDevices.set(deviceId, { device_id: row.device_id, display_name: row.name, device_role: row.role, created_at: row.created_at, updated_at: row.updated_at });
}
function queueSupabaseState(deviceId) {
  if (!supabaseEnabled) return;
  const row = database.prepare("SELECT d.device_id,s.connected,s.last_seen_at,s.telemetry_json,s.updated_at FROM devices d JOIN device_state s USING(device_id) WHERE d.device_id=?").get(deviceId);
  if (!row) return;
  let lastTelemetry = null;
  try { lastTelemetry = row.telemetry_json ? JSON.parse(row.telemetry_json) : null; } catch { lastTelemetry = null; }
  supabaseStates.set(deviceId, { device_id: row.device_id, online: row.connected === 1, last_seen_at: row.last_seen_at, last_telemetry: lastTelemetry, updated_at: row.updated_at });
}
function queueSupabaseCommand(entry) {
  if (!supabaseEnabled) return;
  supabaseCommands.set(entry.id, { id: entry.id, device_id: entry.deviceId, command: entry.command, issued_by: entry.issuedBy, status: entry.status, created_at: entry.createdAt, sent_at: entry.sentAt || null, completed_at: entry.completedAt || null, detail: entry.detail || null });
}
async function flushSupabase() {
  if (!supabaseEnabled || supabaseFlushActive || Date.now() < supabaseRetryAt) return;
  const batches = [[supabaseDevices, [...supabaseDevices.values()], "fleet_devices", "device_id"], [supabaseStates, [...supabaseStates.values()], "fleet_device_state", "device_id"], [supabaseCommands, [...supabaseCommands.values()], "fleet_commands", "id"]];
  const pending = batches.filter(([, rows]) => rows.length > 0);
  if (!pending.length) return;
  supabaseFlushActive = true;
  for (const [queue, rows] of pending) for (const row of rows) queue.delete(row.device_id || row.id);
  try {
    // fleet_device_state and fleet_commands both reference fleet_devices via
    // foreign key, so the parent table has to land first. Flushing all three
    // in parallel makes PostgREST return 409 for the children whenever they
    // arrive ahead of their device row.
    const uploadRows = async (rows, table, conflict) => {
      const response = await fetch(`${supabaseUrl}/rest/v1/${table}?on_conflict=${conflict}`, {
        method: "POST",
        headers: { apikey: supabaseServiceKey, authorization: `Bearer ${supabaseServiceKey}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      const body = (await response.text()).slice(0, 300);
      throw new Error(`Supabase ${table} upsert returned HTTP ${response.status}: ${body}`);
    };
    const parents = pending.filter(([, , table]) => table === "fleet_devices");
    const children = pending.filter(([, , table]) => table !== "fleet_devices");
    const failedRows = [];
    for (const [queue, rows, table, conflict] of [...parents, ...children]) {
      try {
        await uploadRows(rows, table, conflict);
        for (const row of rows) supabaseRowFailures.delete(`${table}:${row[conflict]}`);
      } catch (batchError) {
        // Satu baris rusak tidak boleh memblokir seluruh sinkronisasi: ulangi
        // per baris supaya baris sehat tetap terkirim pada siklus ini.
        console.error(batchError.message);
        for (const row of rows) {
          try {
            await uploadRows([row], table, conflict);
            supabaseRowFailures.delete(`${table}:${row[conflict]}`);
          } catch (rowError) {
            const key = `${table}:${row[conflict]}`;
            const attempts = (supabaseRowFailures.get(key) || 0) + 1;
            if (attempts >= 5) {
              // Baris yang terus gagal dibuang agar antrean tidak macet selamanya.
              supabaseRowFailures.delete(key);
              console.error(`Supabase ${table}: baris ${row[conflict]} dibuang setelah ${attempts} percobaan gagal: ${rowError.message}`);
            } else {
              supabaseRowFailures.set(key, attempts);
              failedRows.push([queue, row]);
            }
          }
        }
      }
    }
    if (failedRows.length) {
      for (const [queue, row] of failedRows) queue.set(row.device_id || row.id, row);
      supabaseRetryAt = Date.now() + supabaseRetryDelay;
      supabaseRetryDelay = Math.min(30_000, supabaseRetryDelay * 2);
      console.error(`Supabase sync sebagian gagal; ${failedRows.length} baris diulang dalam ${supabaseRetryDelay} ms.`);
    } else {
      supabaseRetryDelay = 1000;
      supabaseRetryAt = 0;
    }
  } catch (error) {
    // Galat jaringan/timeout: semua baris siklus ini dikembalikan ke antrean.
    for (const [queue, rows] of pending) for (const row of rows) queue.set(row.device_id || row.id, row);
    supabaseRetryAt = Date.now() + supabaseRetryDelay;
    supabaseRetryDelay = Math.min(30_000, supabaseRetryDelay * 2);
    console.error(`Supabase sync delayed; retrying in ${supabaseRetryDelay} ms: ${error.message}`);
  } finally { supabaseFlushActive = false; }
}

function enqueueCommand(deviceId, command, issuedBy) {
  // Validasi di sini (bukan di pemanggil) supaya jalur WebSocket, Telegram, dan
  // REST tidak ada yang melempar error yang bisa menjatuhkan proses broker.
  const target = devices.get(deviceId);
  if (!target || target.role !== "tracker") return null;
  if (!ALLOWED_COMMANDS.has(command)) return null;
  const queue = queues.get(deviceId) || [];
  const id = `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const entry = { id, deviceId, command, issuedBy, status: "pending", createdAt: new Date().toISOString() };
  database.prepare("INSERT INTO command_log (id,device_id,command,issued_by,status,created_at) VALUES (?,?,?,?,?,?)")
    .run(entry.id, entry.deviceId, entry.command, entry.issuedBy, entry.status, entry.createdAt);
  queueSupabaseCommand(entry);
  commands.set(id, entry);
  console.log(`Command ${id} ${command} queued for ${deviceId} by ${issuedBy}.`);
  queue.push(entry);
  queues.set(deviceId, queue);
  sendToMasters({ type: "commandQueued", command: entry });
  drainQueue(deviceId);
  return entry;
}
function drainQueue(deviceId) {
  const queue = queues.get(deviceId) || [];
  const active = queue[0];
  const socket = sockets.get(deviceId);
  if (!active || !socket || socket.readyState !== WebSocket.OPEN || active.status === "sent") return;
  active.status = "sent";
  active.sentAt = new Date().toISOString();
  database.prepare("UPDATE command_log SET status='sent',sent_at=? WHERE id=? AND status='pending'").run(active.sentAt, active.id);
  queueSupabaseCommand(active);
  send(socket, { type: "command", commandId: active.id, command: active.command, targetId: deviceId });
  sendToMasters({ type: "commandUpdate", command: active });
  active.timeout = setTimeout(() => acknowledge(active.id, false, "No acknowledgement before timeout."), 45_000);
}
function acknowledge(commandId, ok, detail, sourceDeviceId, reportedLockTaskMode) {
  const entry = commands.get(commandId);
  if (!entry || entry.status !== "sent" || (sourceDeviceId && entry.deviceId !== sourceDeviceId)) return;
  if (sourceDeviceId && ["lock", "unlock"].includes(entry.command)) {
    if (Number.isInteger(reportedLockTaskMode) && reportedLockTaskMode >= 0 && reportedLockTaskMode <= 2) {
      const expectedMode = entry.command === "lock" ? 1 : 0;
      if (ok && reportedLockTaskMode !== expectedMode) {
        ok = false;
        detail = `Android reported Lock Task mode ${reportedLockTaskMode}; expected ${expectedMode}.`;
      }
      const telemetry = setTelemetry(sourceDeviceId, {
        lockTaskMode: reportedLockTaskMode,
        receivedAt: new Date().toISOString(),
        online: true,
      });
      persistTelemetry(telemetry);
      sendToMasters({ type: "telemetry", ...telemetry });
    } else if (ok) {
      // APK yang belum diperbarui tidak menyertakan lockTaskMode. Hasil tracker
      // tetap diterima dan status kios dibaca dari telemetri, bukan gagal palsu.
      detail = `${detail ? `${detail} ` : ""}(APK tidak melaporkan mode Lock Task; status kios terbaru ada di panel)`;
    }
  }
  if (sourceDeviceId && entry.command === "uninstall") {
    // HP tracker membuka layar hapus aplikasi; blokir tetap aktif supaya
    // penghapusan manual dari HP tetap dicegah setelah layar ditutup.
    send(sockets.get(entry.deviceId), { type: "uninstallBlocked", blocked: devices.get(entry.deviceId)?.uninstallBlocked !== false });
  }
  clearTimeout(entry.timeout);
  entry.status = ok ? "acked" : "failed";
  entry.completedAt = new Date().toISOString();
  entry.detail = detail;
  database.prepare("UPDATE command_log SET status=?,completed_at=?,detail=? WHERE id=?")
    .run(entry.status, entry.completedAt, entry.detail, entry.id);
  queueSupabaseCommand(entry);
  console.log(`Command ${commandId} ${entry.status}: ${detail || "no detail"}`);
  if (["lock", "unlock", "uninstall", "photo", "photo_front"].includes(entry.command)) void notifyTelegramCommand(entry).catch((error) => console.error("Telegram command notification failed:", error.message));
  const queue = queues.get(entry.deviceId) || [];
  queues.set(entry.deviceId, queue.filter((queued) => queued.id !== commandId));
  sendToMasters({ type: "commandUpdate", command: entry });
  drainQueue(entry.deviceId);
  // "Hapus app" (1 konfirmasi): setelah HP membuka layar hapus & meng-ACK sukses,
  // perangkat dilenyapkan dari daftar web admin + master sesuai permintaan admin.
  if (ok && entry.command === "uninstall") {
    const removed = purgeDevice(entry.deviceId);
    if (removed) {
      publishDevices();
      console.log(`Device ${entry.deviceId} auto-removed from fleet after uninstall confirmation.`);
    }
  }
}

function normalizeName(value) { return String(value || "").trim().toLocaleLowerCase("id-ID"); }
function findDevice(query) {
  const q = normalizeName(query);
  const matches = [...devices.entries()].filter(([id, item]) => normalizeName(id) === q || normalizeName(item.name) === q);
  return matches.length === 1 ? matches[0] : null;
}
function candidateReply(query) {
  const q = normalizeName(query);
  const candidates = [...devices.entries()].filter(([id, item]) => !q || normalizeName(id).includes(q) || normalizeName(item.name).includes(q));
  if (!candidates.length) return "Nama/ID tidak ditemukan. Gunakan /daftar untuk melihat target yang tersedia.";
  return `Nama/ID tidak tepat atau ambigu. Pilih target lengkap:\n${candidates.map(([id, item]) => `${item.name} (${id})`).join("\n")}`;
}
async function telegramCall(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.description || "Telegram API error");
  return payload.result;
}
async function telegramReply(chatId, text) {
  return telegramCall("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}
async function telegramSendPhoto(chatId, imageBuffer, caption) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", String(caption).slice(0, 900));
  form.append("photo", new Blob([imageBuffer], { type: "image/jpeg" }), "snapshot.jpg");
  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.description || "Telegram API error");
  return payload.result;
}
/** Simpan maksimal 50 foto terbaru agar folder data/photos tidak membengkak. */
function prunePhotos(directory) {
  try {
    const files = fs.readdirSync(directory).filter((name) => name.endsWith(".jpg")).map((name) => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(50)) fs.rmSync(path.join(directory, file.name), { force: true });
  } catch (error) {
    console.error("Photo prune failed:", error.message);
  }
}
async function notifyTelegramCommand(entry) {
  if (!telegramToken) return;
  const sourceChat = String(entry.issuedBy || "").match(/^telegram:(-?\d+)$/)?.[1];
  const chatId = sourceChat || telegramAdminChatId;
  if (!chatId) return;
  const device = devices.get(entry.deviceId);
  const site = siteOf(entry.deviceId);
  const telemetry = telemetryFor(entry.deviceId);
  const locationText = Number.isFinite(telemetry.latitude) && Number.isFinite(telemetry.longitude)
    ? `\nLokasi terakhir: https://maps.google.com/?q=${telemetry.latitude},${telemetry.longitude} (akurasi ±${Number.isFinite(telemetry.accuracyMeters) ? Math.round(telemetry.accuracyMeters) : "?"} m; ${telemetry.locationAt || "waktu tidak tersedia"})`
    : "\nLokasi: belum ada koordinat aktual yang dilaporkan.";
  const siteLine = site ? `\nSite/tim: ${site.name}` : "";
  const title = entry.command === "lock" ? "KUNCI" : entry.command === "unlock" ? "BUKA KIOS" : entry.command.startsWith("photo") ? "FOTO" : "HAPUS APLIKASI";
  await telegramReply(chatId, `${title} ${entry.status === "acked" ? "berhasil" : "gagal"}\nPerangkat: ${device?.name || "perangkat"} (${entry.deviceId})${siteLine}\nHasil Android: ${entry.detail || entry.status}${locationText}`);
}

function redeemTelegramOtp(code, chatId) {
  const now = new Date();
  const nowIso = now.toISOString();
  const attempt = database.prepare("SELECT window_started_at AS windowStartedAt,failures FROM telegram_otp_attempts WHERE chat_id=?").get(chatId);
  const windowStart = attempt ? new Date(attempt.windowStartedAt) : null;
  if (attempt && windowStart && now.getTime() - windowStart.getTime() < 15 * 60_000 && attempt.failures >= 5) return "throttled";
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT code_hash AS codeHash,issued_by AS issuedBy FROM telegram_access_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?").get(tokenDigest(code), nowIso);
    if (!row) {
      const currentWindow = attempt && windowStart && now.getTime() - windowStart.getTime() < 15 * 60_000 ? attempt.windowStartedAt : nowIso;
      const failures = currentWindow === attempt?.windowStartedAt ? attempt.failures + 1 : 1;
      database.prepare("INSERT INTO telegram_otp_attempts (chat_id,window_started_at,failures) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET window_started_at=excluded.window_started_at,failures=excluded.failures")
        .run(chatId, currentWindow, failures);
      database.exec("COMMIT");
      return "invalid";
    }
    database.prepare("INSERT INTO telegram_chat_access (chat_id,role,granted_at,granted_by,revoked_at) VALUES (?,'operator',?,?,NULL) ON CONFLICT(chat_id) DO UPDATE SET role=CASE WHEN telegram_chat_access.role='owner' THEN 'owner' ELSE 'operator' END,granted_at=excluded.granted_at,granted_by=excluded.granted_by,revoked_at=NULL")
      .run(chatId, nowIso, row.issuedBy);
    const used = database.prepare("UPDATE telegram_access_codes SET used_at=?,used_by_chat_id=? WHERE code_hash=? AND used_at IS NULL")
      .run(nowIso, chatId, row.codeHash);
    if (!used.changes) { database.exec("ROLLBACK"); return "invalid"; }
    database.prepare("DELETE FROM telegram_otp_attempts WHERE chat_id=?").run(chatId);
    database.exec("COMMIT");
    return "accepted";
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message?.text) return;
  const chatId = String(message.chat?.id || "");
  if (message.chat?.type !== "private") {
    console.warn(`Rejected Telegram command outside private chat ${chatId}`);
    return;
  }
  const [rawCommand, ...rest] = message.text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const argument = rest.join(" ");
  if (command === "/start") {
    if (/^\d{8}$/.test(argument)) {
      const redeemed = redeemTelegramOtp(argument, chatId);
      if (redeemed === "accepted") await telegramReply(chatId, "Akses bot disetujui. Gunakan /daftar, /status <nama>, /lokasi <nama>, /lock <nama>, /unlock <nama>, atau /foto <nama>. Akses ini dapat dicabut dari dashboard.");
      else await telegramReply(chatId, redeemed === "throttled" ? "Terlalu banyak OTP salah. Tunggu 15 menit sebelum mencoba lagi." : "OTP tidak valid atau sudah kedaluwarsa. Minta kode baru kepada admin.");
      return;
    }
    const known = database.prepare("SELECT 1 FROM telegram_chat_access WHERE chat_id=? AND revoked_at IS NULL").get(chatId);
    await telegramReply(chatId, known ? "Bot SMB Fleet aktif. Gunakan /daftar, /status <nama>, /lokasi <nama>, /lock <nama>, /unlock <nama>, atau /foto <nama>." : "Akses bot dibatasi. Minta OTP satu kali dari admin, lalu kirim /start <OTP> dalam 10 menit.");
    return;
  }
  const access = database.prepare("SELECT role FROM telegram_chat_access WHERE chat_id=? AND revoked_at IS NULL").get(chatId);
  if (!access) {
    console.warn(`Rejected Telegram command from unauthorized chat ${chatId}: ${command}`);
    if (command.startsWith("/")) await telegramReply(chatId, "Akses bot belum diberikan. Minta OTP satu kali dari admin, lalu kirim /start <OTP>.");
    return;
  }
  if (command === "/daftar") {
    const lines = publicDevices().map((d) => `${d.name} (${d.deviceId})${d.siteName ? ` — site: ${d.siteName}` : ""} — ${d.online ? "online" : "offline"}`);
    await telegramReply(chatId, lines.join("\n") || "Belum ada perangkat terdaftar.");
    return;
  }
  if (command === "/status" || command === "/lokasi") {
    const match = findDevice(argument);
    if (!match) { await telegramReply(chatId, candidateReply(argument)); return; }
    const [deviceId, device] = match;
    if (device.role !== "tracker") {
      await telegramReply(chatId, `${device.name} (${deviceId}) adalah master, bukan tracker. Gunakan /daftar untuk melihat tracker.`);
      return;
    }
    const telemetry = telemetryFor(deviceId);
    const site = siteOf(deviceId);
    const proximity = telemetry.online && telemetry.detected ? `BLE terdeteksi, ${telemetry.rssi} dBm` : "BLE belum terdeteksi";
    const coords = Number.isFinite(telemetry.latitude) && Number.isFinite(telemetry.longitude)
      ? `Lokasi: ${telemetry.latitude}, ${telemetry.longitude}\nPeta: https://maps.google.com/?q=${telemetry.latitude},${telemetry.longitude}\nAkurasi: ±${Number.isFinite(telemetry.accuracyMeters) ? Math.round(telemetry.accuracyMeters) : "?"} m · ${telemetry.locationAt || "waktu tidak tersedia"}`
      : `Lokasi GPS: belum dilaporkan. Kedekatan BLE: ${proximity}.`;
    const wifiLine = site ? `\nSite/tim: ${site.name}\nWiFi: ${telemetry.wifiSsid || "belum dilaporkan"}${site.wifiAllowlist.length ? ` (izinkan: ${site.wifiAllowlist.join(", ")})` : ""}` : "";
    const lockLine = `\nLock Task mode: ${Number.isInteger(telemetry.lockTaskMode) ? telemetry.lockTaskMode : "belum dilaporkan"} · deviceOwner: ${telemetry.deviceOwner ? "ya" : "belum"}`;
    await telegramReply(chatId, `${device.name} (${deviceId})\nStatus: ${device.connected ? "online" : "offline"}\nBaterai: ${telemetry.batteryLevel == null ? "belum dilaporkan" : `${telemetry.batteryLevel}%`}${wifiLine}${lockLine}\n${coords}`);
    return;
  }
  if (command === "/rename") {
    const split = argument.indexOf(" ");
    if (split < 1) { await telegramReply(chatId, "Format: /rename <nama_lama_atau_ID> <nama_baru>"); return; }
    const match = findDevice(argument.slice(0, split));
    const newName = argument.slice(split + 1).trim();
    if (!match || !newName || [...devices.values()].some((d) => normalizeName(d.name) === normalizeName(newName))) {
      await telegramReply(chatId, "Target tidak ditemukan/ambigu atau nama baru sudah dipakai."); return;
    }
    match[1].name = newName;
    persistDeviceNames();
    publishDevices();
    await telegramReply(chatId, `Nama perangkat diperbarui: ${match[0]} → ${newName}`);
    return;
  }
  if (["/lock", "/unlock"].includes(command)) {
    const match = findDevice(argument);
    if (!match || match[1].role !== "tracker") { await telegramReply(chatId, match ? `Perintah ini hanya untuk HP tracker, bukan ${match[0]}.` : candidateReply(argument)); return; }
    const queued = enqueueCommand(match[0], command.slice(1), `telegram:${chatId}`);
    if (!queued) { await telegramReply(chatId, "Perintah tidak dapat dimasukkan ke antrean."); return; }
    const site = siteOf(match[0]);
    await telegramReply(chatId, `Perintah ${command.slice(1)} masuk antrean FIFO untuk ${match[1].name}${site ? ` (site: ${site.name})` : ""}. ID: ${queued.id}. Hasil menunggu ACK dari HP.`);
    return;
  }
  if (["/foto", "/kamera_depan", "/kamera_belakang"].includes(command)) {
    const match = findDevice(argument);
    if (!match || match[1].role !== "tracker") { await telegramReply(chatId, match ? `Perintah ini hanya untuk HP tracker, bukan ${match[0]}.` : candidateReply(argument)); return; }
    const photoCommand = command === "/kamera_depan" ? "photo_front" : "photo";
    const queued = enqueueCommand(match[0], photoCommand, `telegram:${chatId}`);
    if (!queued) { await telegramReply(chatId, "Perintah foto tidak dapat dimasukkan ke antrean."); return; }
    await telegramReply(chatId, `Permintaan foto untuk ${match[1].name} masuk antrean. Foto hanya diambil saat diminta dan dikirim ke chat ini. ID: ${queued.id}.`);
    return;
  }
  await telegramReply(chatId, "Perintah pilot: /daftar, /status <nama>, /lokasi <nama>, /lock <nama>, /unlock <nama>, /foto <nama>, /rename <nama/ID> <nama baru>.");
}
async function telegramLoop() {
  if (!telegramToken) {
    console.warn("Telegram bot disabled: set TELEGRAM_BOT_TOKEN after rotating the exposed token.");
    return;
  }
  let offset = 0;
  console.log("Telegram polling enabled; only the configured admin chat is accepted.");
  while (true) {
    try {
      const updates = await telegramCall("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        try { await handleTelegramUpdate(update); } catch (error) { console.error("Telegram update failed:", error.message); }
      }
    } catch (error) {
      console.error("Telegram polling error:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

server.on("error", (error) => {
  // Penyebab umum: broker lama masih memegang port. Pesan ini menggantikan
  // unhandled 'error' event yang sebelumnya membuat proses crash tanpa keterangan.
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} pada ${host} masih dipakai proses broker lain. Tutup broker lama (atau tunggu launcher mengambil alih), lalu jalankan ulang SMB Server Console.`);
    process.exit(1);
  }
  console.error("Broker server error:", error.message);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`SMB Fleet broker listening at https://${host}:${port}`);
  if (!supabaseEnabled) console.warn("Supabase sync disabled: configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on this PC.");
  void telegramLoop();
});
setInterval(() => { void flushSupabase(); }, 1000).unref();
setInterval(() => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  database.prepare("DELETE FROM telemetry_minute WHERE minute_at < ?").run(cutoff);
}, 15 * 60 * 1000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, telemetry] of telemetryByDevice) {
    if (telemetry.online && telemetry.receivedAt && now - Date.parse(telemetry.receivedAt) > 10_000) {
      const offline = setTelemetry(deviceId, { detected: false, rssi: null, online: false });
      sendToMasters({ type: "telemetry", ...offline });
    }
  }
}, 2000).unref();
setInterval(() => {
  const now = Date.now();
  for (const client of adminSockets) {
    if (Date.parse(client.adminSessionExpiresAt) <= now) client.close(4003, "Admin session expired");
  }
}, 30_000).unref();

const shutdown = () => {
  for (const entry of commands.values()) clearTimeout(entry.timeout);
  for (const client of webSockets.clients) client.close(1001, "server shutdown");
  server.close(() => { database.close(); process.exit(0); });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
