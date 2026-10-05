import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const supabaseDevices = new Map();
const supabaseStates = new Map();
const supabaseCommands = new Map();
let supabaseFlushActive = false;
let supabaseRetryAt = 0;
let supabaseRetryDelay = 1000;
const certPath = path.join(root, ".tools", "broker-cert", "broker-cert.pem");
const pfxPath = path.join(root, ".tools", "broker-cert", "broker.p12");
const pfxPassphrase = process.env.FLEET_TLS_PASSPHRASE || "";

if (!masterToken || !trackerToken) throw new Error("Set distinct FLEET_MASTER_TOKEN and FLEET_TRACKER_TOKEN in .env.local.");
if (locationEncryptionKey.length !== 32) throw new Error("Set FLEET_LOCATION_KEY to a random base64-encoded 32-byte key in .env.local.");
if (!fs.existsSync(pfxPath) || !fs.existsSync(certPath) || !pfxPassphrase) {
  throw new Error("Local WSS certificate is missing. Generate the local broker certificate before starting the broker.");
}

const devices = new Map([
  ["R9RY506354P", { role: "master", name: "SMB Master", connected: false }],
  ["R9RXC03EC9N", { role: "tracker", name: "SMB Lacak", connected: false }],
]);
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
const tokens = new Map([
  ["R9RY506354P", masterToken],
  ["R9RXC03EC9N", trackerToken],
]);
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
  CREATE INDEX IF NOT EXISTS command_log_device_created ON command_log(device_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS telemetry_minute_recent ON telemetry_minute(device_id, minute_at DESC);
  CREATE INDEX IF NOT EXISTS location_history_recent ON location_history(device_id, captured_at DESC);
`);
const startupTime = new Date().toISOString();
for (const [deviceId, device] of devices) {
  database.prepare("INSERT INTO devices (device_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET name=excluded.name,role=excluded.role,updated_at=excluded.updated_at")
    .run(deviceId, device.name, device.role, startupTime, startupTime);
  database.prepare("INSERT OR IGNORE INTO device_state (device_id,connected,updated_at) VALUES (?,0,?)").run(deviceId, startupTime);
  queueSupabaseDevice(deviceId);
  queueSupabaseState(deviceId);
}
for (const row of database.prepare("SELECT device_id,name FROM devices").all()) if (devices.has(row.device_id)) devices.get(row.device_id).name = row.name;
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
let latestTelemetry = {
  deviceId: "R9RXC03EC9N",
  masterId: "R9RY506354P",
  detected: false,
  rssi: null,
  receivedAt: null,
  online: false,
};
try {
  const savedTelemetry = database.prepare("SELECT telemetry_json FROM device_state WHERE device_id=?").get("R9RXC03EC9N")?.telemetry_json;
  if (savedTelemetry) latestTelemetry = { ...JSON.parse(savedTelemetry), online: false, detected: false, rssi: null };
} catch { /* Keep an empty live state if stored data is unreadable. */ }
try {
  const savedLocation = database.prepare("SELECT * FROM location_history WHERE device_id=? ORDER BY captured_at DESC LIMIT 1").get("R9RXC03EC9N");
  if (savedLocation) latestTelemetry = { ...latestTelemetry, ...decryptLocationRow(savedLocation) };
} catch (error) { console.error(`Saved location could not be decrypted: ${error.message}`); }

const server = https.createServer({
  pfx: fs.readFileSync(pfxPath),
  passphrase: pfxPassphrase,
}, (request, response) => {
  const origin = request.headers.origin || "";
  const allowedOrigins = new Set(["https://localhost", "capacitor://localhost", "http://localhost:5173", "http://127.0.0.1:5173"]);
  if (allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "Authorization,Content-Type");
    response.setHeader("vary", "Origin");
  }
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    const recentCommands = [...commands.values()].slice(-10).map(({ id, deviceId, command, issuedBy, status, createdAt, completedAt, detail }) => ({ id, deviceId, command, issuedBy, status, createdAt, completedAt, detail }));
    response.end(JSON.stringify({ ok: true, service: "smb-fleet-broker", devices: publicDevices(false), telemetry: publicTelemetry(latestTelemetry, false), recentCommands }));
    return;
  }
  if (request.method === "GET" && (request.url === "/api/admin/snapshot" || request.url.startsWith("/api/admin/commands"))) {
    const auth = request.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== masterToken) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.url === "/api/admin/snapshot") {
      const rows = database.prepare("SELECT * FROM command_log ORDER BY created_at DESC LIMIT 30").all().map(publicCommandRow);
      const signalHistory = database.prepare("SELECT minute_at AS minuteAt,sample_count AS sampleCount,detected_count AS detectedCount,CASE WHEN rssi_count=0 THEN NULL ELSE CAST(rssi_sum AS REAL)/rssi_count END AS rssiAvg,rssi_min AS rssiMin,rssi_max AS rssiMax,battery_level AS batteryLevel FROM telemetry_minute WHERE device_id=? ORDER BY minute_at DESC LIMIT 60").all("R9RXC03EC9N").reverse();
      const locationHistory = database.prepare("SELECT * FROM location_history WHERE device_id=? ORDER BY captured_at DESC LIMIT 100").all("R9RXC03EC9N").map(decryptLocationRow).reverse();
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ service: "smb-fleet-broker", generatedAt: new Date().toISOString(), devices: publicDevices(), telemetry: latestTelemetry, locationHistory, signalHistory, commands: rows, telegram: { configured: Boolean(telegramToken), adminChatConfigured: Boolean(telegramAdminChatId) }, supabase: { configured: supabaseEnabled } }));
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
      if (token !== trackerToken) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (payload.deviceId !== "R9RXC03EC9N" || payload.masterId !== "R9RY506354P") {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_device" }));
        return;
      }
      const detected = payload.detected === true;
      const rssi = Number.isInteger(payload.rssi) && payload.rssi >= -127 && payload.rssi <= 20 ? payload.rssi : null;
      const batteryLevel = Number.isInteger(payload.batteryLevel) && payload.batteryLevel >= 0 && payload.batteryLevel <= 100 ? payload.batteryLevel : null;
      const location = validatedLocation(payload);
      latestTelemetry = {
        ...latestTelemetry,
        deviceId: payload.deviceId,
        masterId: payload.masterId,
        detected,
        rssi: detected ? rssi : null,
        deviceOwner: payload.deviceOwner === true,
        lockTaskMode: Number.isInteger(payload.lockTaskMode) ? payload.lockTaskMode : 0,
        batteryLevel,
        ...(location || {}),
        receivedAt: new Date().toISOString(),
        online: true,
      };
      persistTelemetry(latestTelemetry);
      broadcast({ type: "telemetry", ...latestTelemetry }, "R9RY506354P");
      response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ accepted: true, receivedAt: latestTelemetry.receivedAt }));
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);
  const deviceId = url.searchParams.get("deviceId") || "";
  const device = devices.get(deviceId);
  const token = url.searchParams.get("token") || "";
  if (url.pathname !== "/ws" || !device || token !== tokens.get(deviceId)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSocket.deviceId = deviceId;
    webSocket.role = device.role;
    webSockets.emit("connection", webSocket);
  });
});

webSockets.on("connection", (webSocket) => {
  sockets.get(webSocket.deviceId)?.close(4001, "Replaced by a newer session");
  sockets.set(webSocket.deviceId, webSocket);
  devices.get(webSocket.deviceId).connected = true;
  persistDeviceConnection(webSocket.deviceId, true);
  if (webSocket.role === "master") send(webSocket, { type: "telemetry", ...latestTelemetry });
  publishDevices();
  if (webSocket.role === "tracker") drainQueue(webSocket.deviceId);

  webSocket.on("message", (rawMessage) => {
    let message;
    try { message = JSON.parse(rawMessage.toString()); } catch { return; }
    if (webSocket.role === "tracker" && message.type === "telemetry") {
      const detected = message.detected === true;
      const rssi = Number.isInteger(message.rssi) && message.rssi >= -127 && message.rssi <= 20 ? message.rssi : null;
      latestTelemetry = {
        ...latestTelemetry,
        deviceId: webSocket.deviceId,
        masterId: "R9RY506354P",
        detected,
        rssi: detected ? rssi : null,
        receivedAt: new Date().toISOString(),
        online: true,
      };
      persistTelemetry(latestTelemetry);
      broadcast({ type: "telemetry", ...latestTelemetry }, "R9RY506354P");
      return;
    }
    if (webSocket.role === "master" && message.type === "commandRequest") {
      if (message.targetId !== "R9RXC03EC9N" || !["lock", "unlock"].includes(message.command)) {
        send(webSocket, { type: "commandResult", ok: false, error: "Target or command is not allowed." });
        return;
      }
      enqueueCommand(message.targetId, message.command, "master");
      return;
    }
    if (webSocket.role === "master" && message.type === "renameRequest") {
      const device = devices.get(message.targetId);
      const newName = String(message.newName || "").trim();
      if (!device || message.targetId !== "R9RXC03EC9N" || !newName || newName.length > 40
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
      acknowledge(message.commandId, message.ok === true, String(message.detail || ""), webSocket.deviceId);
    }
  });

  webSocket.on("close", () => {
    if (sockets.get(webSocket.deviceId) !== webSocket) return;
    sockets.delete(webSocket.deviceId);
    devices.get(webSocket.deviceId).connected = false;
    persistDeviceConnection(webSocket.deviceId, false);
    if (webSocket.deviceId === "R9RXC03EC9N") {
      latestTelemetry = { ...latestTelemetry, detected: false, rssi: null, online: false, receivedAt: new Date().toISOString() };
      broadcast({ type: "telemetry", ...latestTelemetry }, "R9RY506354P");
    }
    publishDevices();
  });
});

function send(webSocket, packet) {
  if (webSocket?.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(packet));
}
function broadcast(packet, deviceId) { send(sockets.get(deviceId), packet); }
function publicDevices(includeLocation = true) {
  const stateById = new Map(database.prepare("SELECT device_id,last_seen_at,telemetry_json FROM device_state").all().map((state) => [state.device_id, state]));
  return [...devices.entries()].map(([deviceId, device]) => {
    const state = stateById.get(deviceId);
    let telemetry = null;
    try { telemetry = state?.telemetry_json ? JSON.parse(state.telemetry_json) : null; } catch { telemetry = null; }
    return { deviceId, name: device.name, role: device.role, online: device.connected, lastSeenAt: state?.last_seen_at || null, telemetry: publicTelemetry(telemetry, includeLocation) };
  });
}
function publicTelemetry(telemetry, includeLocation = true) {
  if (!telemetry || includeLocation) return telemetry;
  const { latitude, longitude, accuracyMeters, locationAt, locationProvider, ...safe } = telemetry;
  return safe;
}
function publishDevices() { broadcast({ type: "devices", devices: publicDevices() }, "R9RY506354P"); }
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
    await Promise.all(pending.map(([, rows, table, conflict]) => fetch(`${supabaseUrl}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: "POST",
      headers: { apikey: supabaseServiceKey, authorization: `Bearer ${supabaseServiceKey}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(10_000),
    }).then((response) => { if (!response.ok) throw new Error(`Supabase ${table} upsert returned HTTP ${response.status}`); })));
    supabaseRetryDelay = 1000;
    supabaseRetryAt = 0;
  } catch (error) {
    for (const [queue, rows] of pending) for (const row of rows) queue.set(row.device_id || row.id, row);
    supabaseRetryAt = Date.now() + supabaseRetryDelay;
    supabaseRetryDelay = Math.min(30_000, supabaseRetryDelay * 2);
    console.error(`Supabase sync delayed; retrying in ${supabaseRetryDelay} ms: ${error.message}`);
  } finally { supabaseFlushActive = false; }
}

function enqueueCommand(deviceId, command, issuedBy) {
  if (!devices.has(deviceId) || devices.get(deviceId).role !== "tracker") throw new Error("Unknown tracker target.");
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
  broadcast({ type: "commandQueued", command: entry }, "R9RY506354P");
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
  broadcast({ type: "commandUpdate", command: active }, "R9RY506354P");
  active.timeout = setTimeout(() => acknowledge(active.id, false, "No acknowledgement before timeout."), 45_000);
}
function acknowledge(commandId, ok, detail, sourceDeviceId) {
  const entry = commands.get(commandId);
  if (!entry || entry.status !== "sent" || (sourceDeviceId && entry.deviceId !== sourceDeviceId)) return;
  clearTimeout(entry.timeout);
  entry.status = ok ? "acked" : "failed";
  entry.completedAt = new Date().toISOString();
  entry.detail = detail;
  database.prepare("UPDATE command_log SET status=?,completed_at=?,detail=? WHERE id=?")
    .run(entry.status, entry.completedAt, entry.detail, entry.id);
  queueSupabaseCommand(entry);
  console.log(`Command ${commandId} ${entry.status}: ${detail || "no detail"}`);
  const queue = queues.get(entry.deviceId) || [];
  queues.set(entry.deviceId, queue.filter((queued) => queued.id !== commandId));
  broadcast({ type: "commandUpdate", command: entry }, "R9RY506354P");
  drainQueue(entry.deviceId);
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
async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message?.text) return;
  const chatId = String(message.chat?.id || "");
  if (chatId !== telegramAdminChatId) {
    console.warn(`Rejected Telegram command from non-whitelisted chat ${chatId}`);
    return;
  }
  const [rawCommand, ...rest] = message.text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const argument = rest.join(" ");
  if (command === "/daftar") {
    const lines = publicDevices().map((d) => `${d.name} (${d.deviceId}) — ${d.online ? "online" : "offline"}`);
    await telegramReply(chatId, lines.join("\n") || "Belum ada perangkat terdaftar.");
    return;
  }
  if (command === "/status" || command === "/lokasi") {
    const match = findDevice(argument);
    if (!match) { await telegramReply(chatId, candidateReply(argument)); return; }
    const [deviceId, device] = match;
    if (deviceId === "R9RXC03EC9N") {
      const proximity = latestTelemetry.online && latestTelemetry.detected ? `BLE terdeteksi, ${latestTelemetry.rssi} dBm` : "BLE belum terdeteksi";
      await telegramReply(chatId, `${device.name} (${deviceId})\nStatus: ${device.connected ? "online" : "offline"}\nLokasi: hanya kedekatan BLE (${proximity}); koordinat GPS tidak digunakan.`);
    } else {
      await telegramReply(chatId, `${device.name} (${deviceId})\nStatus: ${device.connected ? "online" : "offline"}\nTelemetri baterai/lokasi belum tersedia.`);
    }
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
    if (!match || match[0] !== "R9RXC03EC9N") { await telegramReply(chatId, match ? `Perintah ini hanya diizinkan untuk tracker R9RXC03EC9N, bukan ${match[0]}.` : candidateReply(argument)); return; }
    const queued = enqueueCommand(match[0], command.slice(1), "telegram");
    await telegramReply(chatId, `Perintah ${command.slice(1)} masuk antrean FIFO untuk ${match[1].name}. ID: ${queued.id}. Hasil menunggu ACK dari HP.`);
    return;
  }
  if (["/kamera_depan", "/kamera_belakang"].includes(command)) {
    await telegramReply(chatId, "Android tidak mengizinkan pengambilan kamera diam-diam. Perintah kamera memerlukan notifikasi dan tindakan pengguna di HP; fungsi kamera jarak jauh belum diaktifkan.");
    return;
  }
  await telegramReply(chatId, "Perintah pilot: /daftar, /status <nama>, /lokasi <nama>, /lock <nama>, /unlock <nama>, /rename <nama/ID> <nama baru>.");
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
  if (latestTelemetry.online && latestTelemetry.receivedAt && Date.now() - Date.parse(latestTelemetry.receivedAt) > 10_000) {
    latestTelemetry = { ...latestTelemetry, detected: false, rssi: null, online: false };
    broadcast({ type: "telemetry", ...latestTelemetry }, "R9RY506354P");
  }
}, 2000).unref();

const shutdown = () => {
  for (const entry of commands.values()) clearTimeout(entry.timeout);
  for (const client of webSockets.clients) client.close(1001, "server shutdown");
  server.close(() => { database.close(); process.exit(0); });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
