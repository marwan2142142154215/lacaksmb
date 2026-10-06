import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const PASSWORD_BYTES = 64;

export function ensureAdminAuthSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('superadmin','staff')),
      totp_secret_enc TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      totp_last_step INTEGER NOT NULL DEFAULT -1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_sessions_user ON admin_sessions(admin_user_id);
    CREATE TABLE IF NOT EXISTS admin_totp_pending (
      setup_hash TEXT PRIMARY KEY,
      admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      secret_enc TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_totp_pending_expiry ON admin_totp_pending(expires_at);
    CREATE TABLE IF NOT EXISTS admin_login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username_key TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      succeeded INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS admin_login_attempts_recent ON admin_login_attempts(username_key, attempted_at);
  `);
}

export function bootstrapFirstAdmin(database, username, password) {
  const existing = database.prepare("SELECT COUNT(*) AS count FROM admin_users").get().count;
  if (existing > 0) return false;
  if (!username || !password) {
    throw new Error("No admin account exists. Set FLEET_BOOTSTRAP_ADMIN_USERNAME and FLEET_BOOTSTRAP_ADMIN_PASSWORD in .env.local for first-time setup.");
  }
  createAdminUser(database, username, password, "superadmin", { minPasswordLength: 10 });
  return true;
}

export function validateUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(username) ? username : null;
}

export function createAdminUser(database, rawUsername, password, role = "staff", options = {}) {
  const username = validateUsername(rawUsername);
  const minPasswordLength = options.minPasswordLength ?? 12;
  if (!username) throw new Error("Username harus 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.");
  if (typeof password !== "string" || password.length < minPasswordLength || password.length > 256) {
    throw new Error(`Password harus sepanjang ${minPasswordLength}–256 karakter.`);
  }
  if (!new Set(["superadmin", "staff"]).has(role)) throw new Error("Role admin tidak valid.");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, PASSWORD_BYTES, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const createdAt = new Date().toISOString();
  const result = database.prepare("INSERT INTO admin_users (username,password_salt,password_hash,role,created_at) VALUES (?,?,?,?,?)")
    .run(username, salt.toString("base64"), hash.toString("base64"), role, createdAt);
  return { id: Number(result.lastInsertRowid), username, role, totpEnabled: false, createdAt };
}

export function verifyAdminPassword(user, password) {
  if (!user || typeof password !== "string") return false;
  try {
    const salt = Buffer.from(user.password_salt, "base64");
    const expected = Buffer.from(user.password_hash, "base64");
    const actual = scryptSync(password, salt, expected.length, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

export function updateAdminPassword(database, userId, password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("Password baru harus sepanjang 12–256 karakter.");
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, PASSWORD_BYTES, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  database.prepare("UPDATE admin_users SET password_salt=?,password_hash=? WHERE id=?")
    .run(salt.toString("base64"), hash.toString("base64"), userId);
}

export function makeTotpEnrollment(database, user, authKey) {
  const secret = encodeBase32(randomBytes(20));
  const setupToken = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS).toISOString();
  database.prepare("DELETE FROM admin_totp_pending WHERE admin_user_id=?").run(user.id);
  database.prepare("INSERT INTO admin_totp_pending (setup_hash,admin_user_id,secret_enc,expires_at,created_at) VALUES (?,?,?,?,?)")
    .run(tokenDigest(setupToken), user.id, encryptSecret(secret, authKey), expiresAt, now.toISOString());
  return {
    setupToken,
    secret,
    otpauthUri: `otpauth://totp/${encodeURIComponent("SMB Fleet")}:${encodeURIComponent(user.username)}?secret=${secret}&issuer=${encodeURIComponent("SMB Fleet")}&algorithm=SHA1&digits=6&period=30`,
    expiresAt,
  };
}

export function completeTotpEnrollment(database, setupToken, code, authKey, nowMs = Date.now()) {
  const pending = database.prepare("SELECT * FROM admin_totp_pending WHERE setup_hash=? AND expires_at>?")
    .get(tokenDigest(setupToken), new Date(nowMs).toISOString());
  if (!pending) return null;
  const secret = decryptSecret(pending.secret_enc, authKey);
  const step = matchingTotpStep(secret, code, nowMs, -1);
  if (step === null) return null;
  const user = database.prepare("SELECT id,username,role FROM admin_users WHERE id=?").get(pending.admin_user_id);
  if (!user) return null;
  database.prepare("UPDATE admin_users SET totp_secret_enc=?,totp_enabled=1,totp_last_step=? WHERE id=?")
    .run(pending.secret_enc, step, user.id);
  database.prepare("DELETE FROM admin_totp_pending WHERE admin_user_id=?").run(user.id);
  return { user, session: createAdminSession(database, user.id, nowMs) };
}

export function verifyAdminTotp(database, user, code, authKey, nowMs = Date.now()) {
  if (!user?.totp_enabled || !user.totp_secret_enc) return null;
  const secret = decryptSecret(user.totp_secret_enc, authKey);
  const step = matchingTotpStep(secret, code, nowMs, Number(user.totp_last_step ?? -1));
  if (step === null) return null;
  database.prepare("UPDATE admin_users SET totp_last_step=? WHERE id=?").run(step, user.id);
  return step;
}

export function createAdminSession(database, userId, nowMs = Date.now()) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString();
  database.prepare("INSERT INTO admin_sessions (token_hash,admin_user_id,created_at,expires_at,last_used_at) VALUES (?,?,?,?,?)")
    .run(tokenDigest(token), userId, now, expiresAt, now);
  database.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").run(now);
  return { token, expiresAt };
}

export function resolveAdminSession(database, token, nowMs = Date.now()) {
  if (!token || token.length > 256) return null;
  const now = new Date(nowMs).toISOString();
  const row = database.prepare(`
    SELECT s.token_hash AS tokenHash,s.expires_at AS expiresAt,u.id,u.username,u.role,u.totp_enabled AS totpEnabled
    FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.totp_enabled=1
  `).get(tokenDigest(token), now);
  if (!row) return null;
  database.prepare("UPDATE admin_sessions SET last_used_at=? WHERE token_hash=?").run(now, row.tokenHash);
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    expiresAt: row.expiresAt,
  };
}

export function revokeAdminSession(database, token) {
  if (token) database.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(tokenDigest(token));
}

export function resetAdminTotp(database, userId) {
  database.prepare("UPDATE admin_users SET totp_secret_enc=NULL,totp_enabled=0,totp_last_step=-1 WHERE id=?").run(userId);
  database.prepare("DELETE FROM admin_sessions WHERE admin_user_id=?").run(userId);
  database.prepare("DELETE FROM admin_totp_pending WHERE admin_user_id=?").run(userId);
}

export function recordLoginAttempt(database, username, succeeded, nowMs = Date.now()) {
  const key = String(username || "").trim().toLowerCase().slice(0, 64) || "<empty>";
  const now = new Date(nowMs).toISOString();
  database.prepare("INSERT INTO admin_login_attempts (username_key,attempted_at,succeeded) VALUES (?,?,?)").run(key, now, succeeded ? 1 : 0);
  const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  database.prepare("DELETE FROM admin_login_attempts WHERE attempted_at<?").run(cutoff);
}

export function loginIsThrottled(database, username, nowMs = Date.now()) {
  const key = String(username || "").trim().toLowerCase().slice(0, 64) || "<empty>";
  const cutoff = new Date(nowMs - 15 * 60 * 1000).toISOString();
  const count = database.prepare("SELECT COUNT(*) AS count FROM admin_login_attempts WHERE username_key=? AND succeeded=0 AND attempted_at>?")
    .get(key, cutoff).count;
  return count >= 8;
}

export function listAdminUsers(database) {
  return database.prepare("SELECT id,username,role,totp_enabled AS totpEnabled,created_at AS createdAt FROM admin_users ORDER BY username COLLATE NOCASE")
    .all().map((user) => ({ ...user, totpEnabled: Boolean(user.totpEnabled) }));
}

export function publicAdminUser(user) {
  return { id: user.id, username: user.username, role: user.role };
}

export function tokenDigest(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function matchingTotpStep(secret, rawCode, nowMs, lastAcceptedStep) {
  const code = String(rawCode || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const codeBuffer = Buffer.from(code);
  const currentStep = Math.floor(nowMs / 30_000);
  for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
    if (step <= lastAcceptedStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(codeBuffer, expected)) return step;
  }
  return null;
}

function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const character of String(value).toUpperCase().replace(/=+$/g, "")) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error("Invalid TOTP secret.");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function encryptSecret(secret, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}

function decryptSecret(value, key) {
  const [nonceText, tagText, encryptedText] = String(value).split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
}
