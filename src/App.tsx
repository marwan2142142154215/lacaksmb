import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertTriangle, ArrowUpRight, Battery, Bluetooth, Bot, Check, ChevronRight,
  CircleAlert, Clock3, Command, EyeOff, LayoutDashboard, ListChecks, LockKeyhole,
  LogOut, MapPin, MapPinOff, Menu, Network, Pencil, PlugZap, Radio, RefreshCw, Search, Server,
  Settings2, ShieldCheck, Smartphone, UnlockKeyhole, Users, Wifi, X,
} from "lucide-react";
import QRCode from "qrcode";
import TrackerPage from "./TrackerPage";
import { brokerConfig, clearAdminToken, proximityBle, readAdminIdentity, readAdminToken, saveAdminSession, type AdminIdentity } from "./proximityBle";
import { usePilotBroker, type PilotTelemetry } from "./pilotBroker";
import "./MasterConsole.css";
import "./AdminAuth.css";

const MASTER_ID = "R9RY506354P";
const TRACKER_ID = "R9RXC03EC9N";
type Page = "overview" | "devices" | "commands" | "proximity" | "policy" | "integrations" | "settings" | "admins";
type CommandRow = { id: string; deviceId: string; command: string; issuedBy: string; status: string; createdAt: string; completedAt?: string; detail?: string };
type Device = { deviceId: string; name: string; role?: string; online: boolean; lastSeenAt?: string | null; telemetry?: PilotTelemetry | null };
type SignalSample = { minuteAt: string; sampleCount: number; detectedCount: number; rssiAvg: number | null; rssiMin: number | null; rssiMax: number | null; batteryLevel: number | null };
type LocationSample = { deviceId: string; latitude: number; longitude: number; accuracyMeters: number | null; locationProvider: string; locationAt: string; receivedAt: string };
type Snapshot = { generatedAt: string; devices: Device[]; telemetry: PilotTelemetry | null; locationHistory: LocationSample[]; signalHistory: SignalSample[]; commands: CommandRow[]; telegram: { configured: boolean }; supabase: { configured: boolean } };

const navigation: Array<{ id: Page; title: string; icon: typeof LayoutDashboard; group?: string }> = [
  { id: "overview", title: "Ringkasan", icon: LayoutDashboard },
  { id: "devices", title: "Perangkat", icon: Smartphone, group: "ARMADA" },
  { id: "commands", title: "Antrean perintah", icon: ListChecks },
  { id: "proximity", title: "Kedekatan BLE", icon: Bluetooth, group: "KONTROL" },
  { id: "policy", title: "Kebijakan Android", icon: ShieldCheck },
  { id: "integrations", title: "Integrasi", icon: PlugZap, group: "SISTEM" },
  { id: "admins", title: "Akun admin", icon: Users, group: "SISTEM" },
  { id: "settings", title: "Pengaturan", icon: Settings2 },
];
const pageTitles: Record<Page, { title: string; description: string }> = {
  overview: { title: "Ringkasan armada", description: "Kondisi perangkat yang dilaporkan langsung ke broker lokal." },
  devices: { title: "Perangkat", description: "Pilih satu perangkat dan pastikan ID target sebelum mengirim perintah." },
  commands: { title: "Antrean perintah", description: "Riwayat broker tersimpan di SQLite pada PC ini." },
  proximity: { title: "Kedekatan BLE", description: "Status pemindaian beacon aktual. RSSI bukan pengukuran jarak meter." },
  policy: { title: "Kebijakan Android", description: "Status Device Owner dan batasan lock task yang dilaporkan tracker." },
  integrations: { title: "Integrasi", description: "Koneksi yang benar-benar dikonfigurasi oleh broker saat ini." },
  settings: { title: "Pengaturan sistem", description: "Identitas master, broker, penyimpanan, dan kemampuan yang aktif." },
  admins: { title: "Akun admin", description: "Kelola akses staf dengan password unik dan 2FA authenticator." },
};

function App() {
  if (import.meta.env.MODE === "tracker") return <TrackerPage />;
  return <MasterConsoleGate />;
}

const ADMIN_TOKEN_EVENT = "smb:admin-token";

/** Keeps the gate in sync with sessionStorage without a page reload. */
function useAdminToken() {
  const [token, setToken] = useState(readAdminToken);
  useEffect(() => {
    const sync = () => setToken(readAdminToken());
    window.addEventListener(ADMIN_TOKEN_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ADMIN_TOKEN_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return token;
}

function MasterConsoleGate() {
  const token = useAdminToken();
  const [user, setUser] = useState<AdminIdentity | null>(readAdminIdentity);
  const [checking, setChecking] = useState(Boolean(token));
  const apiBase = brokerConfig.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/ws(?:\?.*)?$/, "");
  useEffect(() => {
    let active = true;
    if (!token) { setUser(null); setChecking(false); return; }
    setChecking(true);
    void fetch(`${apiBase}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session expired");
        return response.json() as Promise<{ user: AdminIdentity }>;
      })
      .then((data) => { if (active) { setUser(data.user); setChecking(false); } })
      .catch(() => { if (active) { clearAdminToken(); setUser(null); setChecking(false); } });
    return () => { active = false; };
  }, [apiBase, token]);
  if (!token) return <AdminGate apiBase={apiBase} />;
  if (checking) return <div className="smb-auth-loading"><ShieldCheck size={20} /> Memeriksa sesi admin…</div>;
  if (!user) return <AdminGate apiBase={apiBase} />;
  return <MasterConsole token={token} adminUser={user} apiBase={apiBase} />;
}

function AdminGate({ apiBase }: { apiBase: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [stage, setStage] = useState<"credentials" | "verify_totp" | "enroll_totp">("credentials");
  const [setupToken, setSetupToken] = useState("");
  const [setupSecret, setSetupSecret] = useState("");
  const [setupUri, setSetupUri] = useState("");
  const [setupQr, setSetupQr] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setSetupQr("");
    if (stage === "enroll_totp" && setupUri) {
      void QRCode.toDataURL(setupUri, { errorCorrectionLevel: "M", margin: 2, width: 220 })
        .then((dataUrl) => { if (active) setSetupQr(dataUrl); })
        .catch(() => { if (active) setError("QR gagal dibuat. Gunakan kunci manual di bawah."); });
    }
    return () => { active = false; };
  }, [setupUri, stage]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (stage === "enroll_totp") {
        const response = await fetch(`${apiBase}/api/auth/totp/confirm`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ setupToken, totpCode }), cache: "no-store",
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Kode authenticator tidak diterima.");
        finishLogin(result);
        return;
      }
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, ...(stage === "verify_totp" ? { totpCode } : {}) }), cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Login gagal.");
      if (result.stage === "verify_totp") { setStage("verify_totp"); setTotpCode(""); return; }
      if (result.stage === "enroll_totp") {
        setSetupToken(result.setupToken);
        setSetupSecret(result.secret);
        setSetupUri(result.otpauthUri || "");
        setStage("enroll_totp");
        setTotpCode("");
        return;
      }
      finishLogin(result);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Tidak dapat menghubungi broker.");
    } finally { setBusy(false); }
  };
  const finishLogin = (result: { sessionToken?: string; user?: AdminIdentity }) => {
    if (!result.sessionToken || !result.user) { setError("Server tidak mengirim sesi login yang valid."); return; }
    saveAdminSession(result.sessionToken, result.user);
    setPassword("");
    setTotpCode("");
    setError("");
  };
  const resetLogin = () => { setStage("credentials"); setTotpCode(""); setError(""); };
  return (
    <div className="smb-gate">
      <form className="smb-gate-card" onSubmit={submit}>
        <div className="smb-gate-icon"><ShieldCheck size={22} /></div>
        <h1>Masuk konsol SMB</h1>
        <p>Login dashboard dilindungi password dan kode 2FA dari aplikasi authenticator.</p>
        {stage === "credentials" && <>
          <label htmlFor="smb-admin-username">Username</label>
          <input id="smb-admin-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label htmlFor="smb-admin-password">Password</label>
          <input id="smb-admin-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </>}
        {stage === "verify_totp" && <>
          <p className="smb-auth-step">Masukkan kode 6 digit dari authenticator untuk <strong>{username}</strong>.</p>
          <label htmlFor="smb-admin-code">Kode 2FA</label>
          <input id="smb-admin-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required />
          <button className="smb-gate-secondary" type="button" onClick={resetLogin}>Kembali</button>
        </>}
        {stage === "enroll_totp" && <>
          <p className="smb-auth-step">Pindai QR ini dengan Google Authenticator, Microsoft Authenticator, atau aplikasi TOTP lain. QR dibuat di perangkat ini dan tidak dikirim ke layanan QR pihak ketiga.</p>
          {setupQr ? <img className="smb-totp-qr" src={setupQr} alt="QR untuk menambahkan SMB Fleet ke aplikasi authenticator" /> : <div className="smb-totp-qr-loading">Menyiapkan QR…</div>}
          <p className="smb-auth-fallback">Jika pemindaian tidak tersedia, masukkan kunci setup ini secara manual:</p>
          <code className="smb-totp-secret">{setupSecret}</code>
          <label htmlFor="smb-enroll-code">Kode 6 digit authenticator</label>
          <input id="smb-enroll-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required />
        </>}
        {error && <small className="smb-gate-error">{error}</small>}
        <button type="submit" disabled={busy}>{busy ? "Memverifikasi…" : stage === "enroll_totp" ? "Aktifkan 2FA dan masuk" : stage === "verify_totp" ? "Verifikasi 2FA" : "Masuk"}</button>
        <small className="smb-gate-foot">
          Sesi aktif disimpan sementara pada tab ini dan berakhir otomatis. Jangan bagikan kode authenticator.
        </small>
      </form>
    </div>
  );
}

function MasterConsole({ token, adminUser, apiBase }: { token: string; adminUser: AdminIdentity; apiBase: string }) {
  const broker = usePilotBroker("master", MASTER_ID, undefined, token);
  const [page, setPage] = useState<Page>("overview");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(TRACKER_ID);
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<"lock" | "unlock" | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [beaconActive, setBeaconActive] = useState(false);
  const [beaconBusy, setBeaconBusy] = useState(false);
  const [beaconMessage, setBeaconMessage] = useState("Beacon master belum dinyalakan.");
  const [loading, setLoading] = useState(true);
  const [refreshAt, setRefreshAt] = useState<string | null>(null);
  const trackerTelemetry = snapshot?.telemetry || broker.telemetry;

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${apiBase}/api/admin/snapshot`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (response.status === 401) {
          // Drop the rejected token so the gate reappears instead of looping
          // on a 401 every five seconds.
          if (active) { clearAdminToken(); setNotice("Token admin ditolak broker."); }
          return;
        }
        if (!response.ok) throw new Error(`Broker HTTP ${response.status}`);
        const data = await response.json() as Snapshot;
        if (active) { setSnapshot(data); setRefreshAt(data.generatedAt); setNotice(""); }
      } catch (error) {
        if (active) setNotice(error instanceof Error ? error.message : "Snapshot broker belum tersedia.");
      } finally { if (active) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [apiBase, token]);

  useEffect(() => {
    let mounted = true;
    void proximityBle.isScanning().then((result) => { if (mounted) setBeaconActive(result.active); }).catch(() => undefined);
    const serviceListener = proximityBle.addListener("serviceState", (event) => {
      if (!mounted) return;
      setBeaconActive(event.running);
      setBeaconMessage(event.running ? "Beacon BLE aktif; notifikasi pemantauan tetap terlihat." : `Beacon tidak aktif: ${event.detail}`);
    });
    return () => { mounted = false; void serviceListener.then((listener) => listener.remove()); };
  }, []);

  const startMasterBeacon = async () => {
    setBeaconBusy(true);
    try {
      const access = await proximityBle.requestAccess();
      if (!access.granted) throw new Error("Izin Bluetooth Nearby belum diberikan.");
      if (!access.serviceNotification) throw new Error("Aktifkan izin notifikasi agar status foreground service terlihat.");
      await proximityBle.startAdvertising({ brokerUrl: brokerConfig.url, deviceId: MASTER_ID });
      setBeaconActive(true);
      setBeaconMessage("Beacon BLE master aktif dengan notifikasi layanan foreground.");
    } catch (error) {
      setBeaconActive(false);
      setBeaconMessage(error instanceof Error ? error.message : "Beacon master gagal dimulai.");
    } finally { setBeaconBusy(false); }
  };

  const stopMasterBeacon = async () => {
    setBeaconBusy(true);
    try { await proximityBle.stop(); setBeaconActive(false); setBeaconMessage("Beacon master dihentikan dari aplikasi."); }
    catch (error) { setBeaconMessage(error instanceof Error ? error.message : "Beacon gagal dihentikan."); }
    finally { setBeaconBusy(false); }
  };

  useEffect(() => {
    const renameResult = broker.commandUpdates.find((packet) => packet.type === "commandResult") as { ok?: boolean; detail?: string; error?: string } | undefined;
    if (renameResult) { setNotice(renameResult.ok ? (renameResult.detail || "Perubahan nama tersimpan.") : (renameResult.error || "Perubahan ditolak broker.")); setRenaming(false); }
  }, [broker.commandUpdates]);

  const devices = snapshot?.devices || broker.devices;
  const selected = devices.find((device) => device.deviceId === selectedId) || devices.find((device) => device.deviceId === TRACKER_ID);
  const telemetry = selected?.deviceId === TRACKER_ID ? trackerTelemetry : selected?.telemetry;
  const onlineCount = devices.filter((device) => device.online).length;
  const filteredDevices = useMemo(() => devices.filter((device) => `${device.name} ${device.deviceId}`.toLowerCase().includes(search.toLowerCase())), [devices, search]);
  const commands = useMemo(() => {
    const fromSocket = broker.commandUpdates.flatMap((packet) => {
      const row = packet.command as CommandRow | undefined;
      return row?.id ? [row] : [];
    });
    const joined = new Map<string, CommandRow>();
    for (const item of [...(snapshot?.commands || []), ...fromSocket]) joined.set(item.id, item);
    return [...joined.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60);
  }, [snapshot?.commands, broker.commandUpdates]);

  const sendCommand = (command: "lock" | "unlock") => {
    if (!selected || selected.deviceId !== TRACKER_ID) { setNotice("Target tidak termasuk perangkat tracker yang dipasangkan."); return; }
    if (!broker.connected) { setNotice("Master belum tersambung ke WSS broker."); return; }
    if (command === "lock" && !telemetry?.deviceOwner) { setNotice("Android belum melaporkan Device Owner aktif; perintah tidak dikirim."); return; }
    broker.send({ type: "commandRequest", targetId: selected.deviceId, command });
    setNotice(`Perintah ${command} dimasukkan ke broker untuk ${selected.deviceId}. Tunggu ACK Android.`);
    setConfirm(null);
    setPage("commands");
  };
  const rename = () => {
    const name = renameValue.trim();
    if (!selected || selected.deviceId !== TRACKER_ID || !name) { setNotice("Masukkan nama baru untuk tracker yang dipilih."); return; }
    broker.send({ type: "renameRequest", targetId: selected.deviceId, newName: name });
    setRenameValue("");
    setNotice(`Permintaan nama dikirim untuk ID ${selected.deviceId}. Menunggu konfirmasi server.`);
  };
  const go = (next: Page) => { setPage(next); setSidebarOpen(false); };
  const openDevice = (device: Device) => { setSelectedId(device.deviceId); setPage("devices"); };
  const currentTitle = pageTitles[page];
  const lastUpdate = telemetry?.receivedAt ? formatTime(telemetry.receivedAt) : "Belum ada laporan";
  const logout = () => {
    void fetch(`${apiBase}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    clearAdminToken();
  };

  return (
    <div className="smb-console">
      <aside className={`smb-sidebar ${sidebarOpen ? "smb-sidebar-open" : ""}`}>
        <div className="smb-brand"><div className="smb-brand-mark"><Radio size={21} /></div><div><strong>SMB <span>Master</span></strong><small>FLEET CONTROL</small></div><button className="smb-close-sidebar" onClick={() => setSidebarOpen(false)} aria-label="Tutup menu"><X size={18} /></button></div>
        <div className="smb-master-card"><div className="smb-avatar">SM</div><div><strong>Master utama</strong><span>ID {MASTER_ID}</span></div><span className={`smb-presence ${broker.connected ? "is-online" : ""}`} title={broker.connected ? "Tersambung" : "Terputus"} /></div>
        <nav className="smb-navigation" aria-label="Navigasi utama">
          {navigation.filter((item) => item.id !== "admins" || adminUser.role === "superadmin").map((item, index) => <div key={item.id}>{item.group && <div className={`smb-nav-group ${index > 0 ? "smb-nav-group-spaced" : ""}`}>{item.group}</div>}<button className={`smb-nav-link ${page === item.id ? "is-active" : ""}`} onClick={() => go(item.id)}><item.icon size={18} strokeWidth={1.8} /><span>{item.title}</span>{item.id === "commands" && commands.filter((row) => row.status === "pending" || row.status === "sent").length > 0 && <b>{commands.filter((row) => row.status === "pending" || row.status === "sent").length}</b>}</button></div>)}
        </nav>
        <div className="smb-sidebar-bottom"><div className="smb-broker-indicator"><span className={`smb-live-dot ${broker.connected ? "" : "is-off"}`} /><div><strong>Broker PC</strong><small>{broker.connected ? "Terhubung via WSS TLS" : "Tidak terhubung"}</small></div><Wifi size={16} /></div><div className="smb-sidebar-foot">SMB FLEET · LOCAL BROKER</div></div>
      </aside>
      {sidebarOpen && <button className="smb-sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Tutup menu" />}

      <main className="smb-main">
        <header className="smb-topbar"><button className="smb-menu-button" aria-label="Buka menu" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div className="smb-breadcrumb">SMB Control <ChevronRight size={14} /><span>{currentTitle.title}</span></div><div className="smb-top-actions"><div className={`smb-connection-chip ${broker.connected ? "is-connected" : ""}`}><i />{broker.connected ? "Broker tersambung" : "Broker terputus"}</div><span className="smb-top-divider" /><span className="smb-admin-name">{adminUser.username}</span><button className="smb-logout-button" onClick={logout}><LogOut size={15} />Keluar</button><button className="smb-icon-button" title="Perbarui data" onClick={() => window.location.reload()}><RefreshCw size={17} /></button></div></header>

        <div className="smb-content">
          <div className="smb-page-heading"><div><p className="smb-eyebrow">FLEET MANAGEMENT</p><h1>{currentTitle.title}</h1><p className="smb-page-description">{currentTitle.description}</p></div><div className="smb-heading-meta"><span className="smb-local-badge"><Server size={14} /> Server lokal</span><small>{refreshAt ? `Diperbarui ${formatTime(refreshAt)}` : loading ? "Menghubungkan..." : "Belum tersinkron"}</small></div></div>
          {notice && <div className="smb-notice"><CircleAlert size={17} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Tutup notifikasi"><X size={15} /></button></div>}

          {page === "overview" && <OverviewPage devices={devices} onlineCount={onlineCount} brokerConnected={broker.connected} beaconActive={beaconActive} beaconBusy={beaconBusy} beaconMessage={beaconMessage} onStartBeacon={() => void startMasterBeacon()} onStopBeacon={() => void stopMasterBeacon()} telemetry={trackerTelemetry} locationHistory={snapshot?.locationHistory || []} signalHistory={snapshot?.signalHistory || []} commands={commands} telegramConfigured={snapshot?.telegram.configured || false} supabaseConfigured={snapshot?.supabase.configured || false} onOpenDevices={() => go("devices")} onOpenCommands={() => go("commands")} onSelectDevice={openDevice} />}
          {page === "devices" && <DevicesPage devices={filteredDevices} search={search} setSearch={setSearch} selected={selected} telemetry={telemetry} onlineCount={onlineCount} onSelect={setSelectedId} onCommand={setConfirm} onRename={() => setRenaming(true)} />}
          {page === "commands" && <CommandsPage commands={commands} devices={devices} onOpenDevice={(id) => { setSelectedId(id); setPage("devices"); }} />}
          {page === "proximity" && <ProximityPage telemetry={trackerTelemetry} devices={devices} />}
          {page === "policy" && <PolicyPage telemetry={trackerTelemetry} />}
          {page === "integrations" && <IntegrationsPage brokerConnected={broker.connected} telegramConfigured={snapshot?.telegram.configured || false} supabaseConfigured={snapshot?.supabase.configured || false} />}
          {page === "settings" && <><SettingsPage devices={devices} telemetry={trackerTelemetry} brokerConnected={broker.connected} telegramConfigured={snapshot?.telegram.configured || false} /><ChangePasswordPanel apiBase={apiBase} token={token} /></>}
          {page === "admins" && adminUser.role === "superadmin" && <AdminUsersPage apiBase={apiBase} token={token} />}
          <footer className="smb-page-footer"><span>SMB Master · {MASTER_ID}</span><span>Data berasal dari broker lokal · {lastUpdate}</span></footer>
        </div>
      </main>

      {confirm && selected && <div className="smb-modal-backdrop" role="presentation" onClick={() => setConfirm(null)}><section className="smb-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="smb-confirm-title" onClick={(event) => event.stopPropagation()}><div className={`smb-modal-icon ${confirm === "lock" ? "modal-lock" : "modal-unlock"}`}>{confirm === "lock" ? <LockKeyhole size={23} /> : <UnlockKeyhole size={23} />}</div><button className="smb-modal-close" onClick={() => setConfirm(null)} aria-label="Tutup"><X size={18} /></button><p className="smb-eyebrow">KONFIRMASI TARGET</p><h2 id="smb-confirm-title">{confirm === "lock" ? "Kunci mode kios?" : "Buka mode kios?"}</h2><p>Perintah akan ditujukan tepat ke perangkat berikut. Periksa nama dan ID sebelum melanjutkan.</p><div className="smb-confirm-target"><Smartphone size={18} /><div><strong>{selected.name}</strong><code>{selected.deviceId}</code></div><span className="smb-live-dot" /></div><div className="smb-modal-actions"><button className="smb-button-muted" onClick={() => setConfirm(null)}>Batal</button><button className={confirm === "lock" ? "smb-button-danger" : "smb-button-primary"} onClick={() => sendCommand(confirm)}>{confirm === "lock" ? "Kirim perintah kunci" : "Kirim perintah buka"}</button></div><small>Android dapat menolak permintaan jika aplikasi tracker tidak berada di depan.</small></section></div>}

      {renaming && selected && <div className="smb-modal-backdrop" role="presentation" onClick={() => setRenaming(false)}><section className="smb-confirm-modal smb-rename-modal" role="dialog" aria-modal="true" aria-labelledby="smb-rename-title" onClick={(event) => event.stopPropagation()}><button className="smb-modal-close" onClick={() => setRenaming(false)} aria-label="Tutup"><X size={18} /></button><p className="smb-eyebrow">UBAH IDENTITAS</p><h2 id="smb-rename-title">Ganti nama perangkat</h2><p>Nama baru akan disimpan broker untuk target ID ini.</p><div className="smb-confirm-target"><Smartphone size={18} /><div><strong>{selected.name}</strong><code>{selected.deviceId}</code></div></div><input className="smb-rename-input" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={40} placeholder="Contoh: HP-001-TOKO-A" /><div className="smb-modal-actions"><button className="smb-button-muted" onClick={() => setRenaming(false)}>Batal</button><button className="smb-button-primary" disabled={!renameValue.trim()} onClick={rename}>Simpan nama</button></div></section></div>}
    </div>
  );
}

function OverviewPage({ devices, onlineCount, brokerConnected, beaconActive, beaconBusy, beaconMessage, onStartBeacon, onStopBeacon, telemetry, locationHistory, signalHistory, commands, telegramConfigured, supabaseConfigured, onOpenDevices, onOpenCommands, onSelectDevice }: {
  devices: Device[]; onlineCount: number; brokerConnected: boolean; beaconActive: boolean; beaconBusy: boolean; beaconMessage: string; onStartBeacon: () => void; onStopBeacon: () => void; telemetry: Snapshot["telemetry"] | null | undefined; locationHistory: LocationSample[]; signalHistory: SignalSample[]; commands: CommandRow[]; telegramConfigured: boolean; supabaseConfigured: boolean;
  onOpenDevices: () => void; onOpenCommands: () => void; onSelectDevice: (device: Device) => void;
}) {
  const [showMap, setShowMap] = useState(false);
  const tracker = devices.find((device) => device.deviceId === TRACKER_ID);
  const online = Boolean(tracker?.online && telemetry?.online);
  const detected = Boolean(online && telemetry?.detected);
  const hasLocation = Number.isFinite(telemetry?.latitude) && Number.isFinite(telemetry?.longitude) && Boolean(telemetry?.locationAt);
  const mapUrl = hasLocation ? `https://www.openstreetmap.org/?mlat=${telemetry!.latitude}&mlon=${telemetry!.longitude}#map=16/${telemetry!.latitude}/${telemetry!.longitude}` : "";
  const mapLat = hasLocation ? Number(telemetry!.latitude!.toFixed(4)) : 0;
  const mapLng = hasLocation ? Number(telemetry!.longitude!.toFixed(4)) : 0;
  const mapMargin = 0.004;
  const mapEmbedUrl = hasLocation
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${mapLng - mapMargin}%2C${mapLat - mapMargin}%2C${mapLng + mapMargin}%2C${mapLat + mapMargin}&layer=mapnik&marker=${mapLat}%2C${mapLng}`
    : "";
  const pendingCount = commands.filter((row) => ["pending", "sent"].includes(row.status)).length;
  return <>
    <div className="smb-metric-grid">
      <MetricCard icon={<Smartphone size={19} />} label="Terdaftar" value={String(devices.length)} foot="Data registri broker" tone="green" />
      <MetricCard icon={<Wifi size={19} />} label="Online sekarang" value={`${onlineCount} / ${devices.length}`} foot={brokerConnected ? "Koneksi master aktif" : "Master tidak tersambung"} tone="blue" />
      <MetricCard icon={<Bluetooth size={19} />} label="Tracker terdeteksi" value={detected ? "Ya" : "Tidak"} foot={detected ? `${telemetry?.rssi ?? "—"} dBm · BLE` : "Belum ada beacon terlapor"} tone="violet" />
      <MetricCard icon={<ListChecks size={19} />} label="Perintah menunggu" value={String(pendingCount)} foot="Antrean persisten SQLite" tone="amber" />
    </div>
    <section className="smb-panel smb-master-beacon-panel"><div className="smb-master-beacon-icon"><Radio size={21} /></div><div className="smb-master-beacon-copy"><span className="smb-panel-kicker">BEACON SMB MASTER</span><strong>{beaconActive ? "Beacon BLE aktif" : "Beacon BLE belum aktif"}</strong><small>{beaconMessage}</small></div><span className={`smb-status-pill ${beaconActive ? "status-on" : "status-off"}`}>{beaconActive ? "AKTIF" : "MATI"}</span><button className={beaconActive ? "smb-button-muted" : "smb-button-primary"} onClick={beaconActive ? onStopBeacon : onStartBeacon} disabled={beaconBusy}>{beaconBusy ? "Memproses…" : beaconActive ? "Hentikan beacon" : "Aktifkan beacon"}</button></section>
    <div className="smb-overview-grid smb-live-overview-grid">
      <section className="smb-panel smb-live-radar-panel"><PanelHeading kicker="RADAR KEDEKATAN · BLE" title="Pemantauan perangkat" action={<button className="smb-text-link" onClick={onOpenDevices}>Detail tracker <ArrowUpRight size={14} /></button>} /><div className="smb-device-id-line"><span className={`smb-live-dot ${online ? "" : "is-off"}`} />{TRACKER_ID}<span className={`smb-status-pill ${online ? "status-on" : "status-off"}`}>{online ? "ONLINE" : "OFFLINE"}</span></div><div className={`smb-radar-stage ${detected ? "is-detected" : ""}`} role="img" aria-label={`Radar BLE. Tracker ${detected ? "terdeteksi" : "belum terdeteksi"}; radar tidak menunjukkan koordinat atau arah.`}><div className="smb-radar-sweep" /><div className="smb-radar-ring ring-one" /><div className="smb-radar-ring ring-two" /><div className="smb-radar-ring ring-three" /><div className="smb-radar-crosshair crosshair-x" /><div className="smb-radar-crosshair crosshair-y" /><div className="smb-radar-center"><Radio size={22} /></div></div><div className="smb-radar-summary"><span className={`smb-radar-state-dot ${detected ? "" : "is-off"}`} /><div><small>{detected ? "Beacon master diterima tracker" : "Menunggu beacon BLE"}</small><strong>{detected ? "Perangkat saling terdeteksi" : "Belum ada sinyal langsung"}</strong></div><span className="smb-radar-rssi">{detected && telemetry?.rssi != null ? `${telemetry.rssi} dBm` : "— dBm"}</span></div><div className="smb-mini-stats"><div><small>Device Owner</small><strong>{telemetry?.deviceOwner ? "Aktif" : "Belum dilaporkan"}</strong></div><div><small>Mode kios</small><strong>{telemetry?.lockTaskMode ? "Terkunci" : "Tidak terkunci"}</strong></div><div><small>Diperbarui</small><strong>{telemetry?.receivedAt ? formatTime(telemetry.receivedAt) : "Belum tersedia"}</strong></div></div></section>
      <section className="smb-panel smb-location-panel"><PanelHeading kicker="LOKASI PERANGKAT" title="Peta armada" action={<span className={`smb-location-mode ${hasLocation ? "location-mode-live" : ""}`}><MapPin size={13} /> {hasLocation ? "Lokasi live" : "Lokasi menunggu"}</span>} /><div className={`smb-location-canvas ${showMap && hasLocation ? "has-live-map" : ""}`}>{showMap && hasLocation ? <iframe className="smb-location-iframe" title={`Peta OpenStreetMap untuk ${TRACKER_ID}`} src={mapEmbedUrl} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups" /> : <><div className="smb-map-grid" /><div className="smb-map-orbit orbit-a" /><div className="smb-map-orbit orbit-b" /></>}{hasLocation ? <div className={`smb-map-position ${showMap ? "is-over-map" : ""}`}><div className="smb-map-pin-icon"><MapPin size={22} /></div><span className="smb-map-live-tag"><i /> POSISI TERAKHIR</span><strong>{telemetry!.latitude!.toFixed(6)}, {telemetry!.longitude!.toFixed(6)}</strong><small>Akurasi ±{telemetry?.accuracyMeters == null ? "—" : `${Math.round(telemetry.accuracyMeters)} m`} · {formatTime(telemetry!.locationAt!)}</small><button className="smb-map-load-button" onClick={() => setShowMap((visible) => !visible)}>{showMap ? "Tutup peta" : "Muat peta nyata · OpenStreetMap"}</button><a href={mapUrl} target="_blank" rel="noreferrer">Buka peta penuh <ArrowUpRight size={13} /></a></div> : <div className="smb-map-empty"><div className="smb-map-pin-icon"><MapPin size={22} /></div><strong>Menunggu koordinat GPS</strong><p>Berikan izin lokasi di SMB Lacak dan tunggu perbaikan lokasi pertama. Titik hanya muncul dari koordinat aktual tracker.</p><span><MapPinOff size={14} /> Belum ada posisi yang dilaporkan</span></div>}<div className="smb-map-footer"><span>TRACKER · {TRACKER_ID}</span><strong>{hasLocation ? telemetry!.locationProvider?.toUpperCase() || "LOKASI" : "Menunggu laporan"}</strong></div></div>{hasLocation && <small className="smb-map-privacy">Peta jalan dimuat dari OpenStreetMap hanya setelah Anda menekan Muat peta; layanan peta menerima koordinat titik dan permintaan jaringan.</small>}{locationHistory.length > 1 && <div className="smb-location-history"><span>LOKASI SEBELUMNYA</span>{locationHistory.slice(-4).reverse().map((point) => <div key={`${point.deviceId}-${point.locationAt}`}><strong>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</strong><small>{formatTime(point.locationAt)} · ±{point.accuracyMeters == null ? "—" : `${Math.round(point.accuracyMeters)} m`}</small></div>)}</div>}</section>
    </div>
    <div className="smb-lower-grid"><section className="smb-panel"><PanelHeading kicker="ARMADA" title="Perangkat terdaftar" action={<button className="smb-text-link" onClick={onOpenDevices}>Buka daftar <ArrowUpRight size={14} /></button>} /><div className="smb-device-compact-list">{devices.map((device) => <button className="smb-device-compact" key={device.deviceId} onClick={() => onSelectDevice(device)}><div className="smb-device-type-icon"><Smartphone size={18} /></div><div className="smb-device-compact-copy"><strong>{device.name}</strong><small>{device.deviceId}</small></div><span className={`smb-status-pill ${device.online ? "status-on" : "status-off"}`}>{device.online ? "ONLINE" : "OFFLINE"}</span><ChevronRight size={16} /></button>)}</div></section><section className="smb-panel smb-activity-panel"><PanelHeading kicker="AKTIVITAS" title="Perintah terbaru" action={<button className="smb-text-link" onClick={onOpenCommands}>Semua <ArrowUpRight size={14} /></button>} />{commands.length ? <div className="smb-command-list">{commands.slice(0, 5).map((row) => <CommandListRow key={row.id} row={row} device={devices.find((device) => device.deviceId === row.deviceId)} />)}</div> : <EmptyState icon={<Command size={21} />} title="Belum ada perintah" body="Aktivitas perintah akan muncul setelah broker menerima instruksi dari master atau bot." />}</section><section className="smb-panel"><PanelHeading kicker="KONEKSI" title="Layanan broker" /><div className="smb-service-list"><ServiceRow icon={<Server size={17} />} label="Server PC lokal" value={brokerConnected ? "WSS aktif" : "Terputus"} ok={brokerConnected} /><ServiceRow icon={<Bot size={17} />} label="Telegram Bot" value={telegramConfigured ? "Token siap" : "Belum dikonfigurasi"} ok={telegramConfigured} /><ServiceRow icon={<Network size={17} />} label="Supabase" value={supabaseConfigured ? "Kredensial siap" : "Menunggu kredensial"} ok={supabaseConfigured} /><ServiceRow icon={<ShieldCheck size={17} />} label="Keamanan transport" value="TLS / WSS" ok={true} /></div></section></div>
    <SignalHistoryPanel history={signalHistory} />
  </>;
}

function SignalHistoryPanel({ history }: { history: SignalSample[] }) {
  const recent = history.slice(-60);
  const values = recent.filter((sample) => sample.rssiAvg !== null);
  const points = values.map((sample, index) => {
    const x = values.length < 2 ? 50 : 4 + (index / (values.length - 1)) * 92;
    const rssi = Math.max(-100, Math.min(-25, sample.rssiAvg ?? -100));
    const y = 4 + ((-25 - rssi) / 75) * 48;
    return `${x},${y}`;
  }).join(" ");
  const latest = values.at(-1);
  const min = values.reduce<number | null>((value, sample) => value === null ? sample.rssiMin : sample.rssiMin === null ? value : Math.min(value, sample.rssiMin), null);
  const max = values.reduce<number | null>((value, sample) => value === null ? sample.rssiMax : sample.rssiMax === null ? value : Math.max(value, sample.rssiMax), null);
  const sampleCount = recent.reduce((sum, sample) => sum + sample.sampleCount, 0);
  return <section className="smb-panel smb-signal-history">
    <PanelHeading kicker="TELEMETRI AKTUAL" title="Riwayat sinyal BLE" action={<span className="smb-chart-window">60 menit terakhir</span>} />
    {values.length > 1 ? <div className="smb-signal-chart-wrap">
      <div className="smb-chart-axis"><span>-25 dBm</span><span>-60 dBm</span><span>-100 dBm</span></div>
      <svg className="smb-signal-chart" viewBox="0 0 100 56" preserveAspectRatio="none" role="img" aria-label="Grafik RSSI BLE aktual per menit">
        <line x1="0" y1="4" x2="100" y2="4" /><line x1="0" y1="26.4" x2="100" y2="26.4" /><line x1="0" y1="52" x2="100" y2="52" />
        <polyline points={points} />
        {latest && <circle cx="96" cy={4 + ((-25 - Math.max(-100, Math.min(-25, latest.rssiAvg ?? -100))) / 75) * 48} r="1.7" />}
      </svg>
    </div> : <EmptyState icon={<Radio size={21} />} title="Mengumpulkan telemetri BLE" body="Grafik muncul setelah ada sedikitnya dua menit data RSSI aktual dari tracker." />}
    <div className="smb-signal-summary"><div><small>RSSI terakhir</small><strong>{latest?.rssiAvg === null || !latest ? "—" : `${Math.round(latest.rssiAvg)} dBm`}</strong></div><div><small>Rentang sinyal</small><strong>{min === null || max === null ? "—" : `${min} sampai ${max} dBm`}</strong></div><div><small>Sampel masuk</small><strong>{sampleCount}</strong></div><p>Nilai ini hanya kekuatan sinyal yang diterima, bukan jarak meter. BLE RSSI berubah karena orientasi HP, dinding, tubuh, dan gangguan radio.</p></div>
  </section>;
}

function DevicesPage({ devices, search, setSearch, selected, telemetry, onlineCount, onSelect, onCommand, onRename }: {
  devices: Device[]; search: string; setSearch: (value: string) => void; selected?: Device; telemetry: Device["telemetry"]; onlineCount: number; onSelect: (id: string) => void; onCommand: (command: "lock" | "unlock") => void; onRename: () => void;
}) {
  return <div className="smb-device-page-grid"><section className="smb-panel smb-device-table-panel"><div className="smb-list-toolbar"><div><span className="smb-panel-kicker">REGISTRI PERANGKAT</span><strong>{devices.length} perangkat ditemukan · {onlineCount} online</strong></div><label className="smb-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari nama atau ID" /></label></div><div className="smb-device-table"><div className="smb-table-head"><span>PERANGKAT</span><span>STATUS</span><span>TELEMETRI</span><span /></div>{devices.map((device) => <button className={`smb-table-row ${selected?.deviceId === device.deviceId ? "is-selected" : ""}`} key={device.deviceId} onClick={() => onSelect(device.deviceId)}><div className="smb-table-device"><div className="smb-device-type-icon"><Smartphone size={18} /></div><div><strong>{device.name}</strong><small>{device.deviceId}</small></div></div><span className={`smb-status-pill ${device.online ? "status-on" : "status-off"}`}><i />{device.online ? "ONLINE" : "OFFLINE"}</span><span className="smb-table-telemetry">{device.deviceId === TRACKER_ID && telemetry?.detected ? `BLE ${telemetry.rssi ?? "—"} dBm` : device.lastSeenAt ? `Terlihat ${formatTime(device.lastSeenAt)}` : "Belum ada data"}</span><ChevronRight size={16} /></button>)}{devices.length === 0 && <EmptyState icon={<Search size={20} />} title="Tidak ada hasil" body="Coba cari dengan nama atau ID perangkat yang tepat." />}</div><div className="smb-table-footer"><span>Menampilkan data registri nyata</span><span><span className="smb-live-dot" /> Sinkron dengan broker</span></div></section>
    {selected ? <section className="smb-panel smb-device-detail"><div className="smb-detail-top"><div className="smb-device-type-icon detail-device-icon"><Smartphone size={21} /></div><span className={`smb-status-pill ${selected.online ? "status-on" : "status-off"}`}>{selected.online ? "ONLINE" : "OFFLINE"}</span></div><span className="smb-panel-kicker">DETAIL PERANGKAT</span><h2>{selected.name}</h2><code className="smb-detail-id">{selected.deviceId}</code><div className="smb-detail-divider" /><div className="smb-detail-info"><DetailValue label="Peran" value={selected.role === "master" ? "Master" : "Tracker sewa"} /><DetailValue label="Koneksi" value={selected.online ? "Online saat ini" : "Offline"} /><DetailValue label="Terakhir terlihat" value={selected.lastSeenAt ? formatTime(selected.lastSeenAt) : "Belum tersedia"} /><DetailValue label="BLE" value={selected.deviceId === TRACKER_ID && telemetry?.detected ? `${telemetry.rssi ?? "—"} dBm` : "Tidak terdeteksi"} /><DetailValue label="Baterai" value={selected.deviceId === TRACKER_ID && telemetry?.batteryLevel != null ? `${telemetry.batteryLevel}%` : "Belum dilaporkan"} /><DetailValue label="Lokasi" value={telemetry?.locationAt ? "GPS aktif" : "GPS menunggu"} /></div><div className="smb-detail-actions"><button className="smb-button-muted" onClick={onRename} disabled={selected.deviceId !== TRACKER_ID}><Pencil size={15} /> Ubah nama</button><button className="smb-button-danger" onClick={() => onCommand("lock")} disabled={selected.deviceId !== TRACKER_ID || !telemetry?.deviceOwner}><LockKeyhole size={15} /> Lock kios</button><button className="smb-button-outline" onClick={() => onCommand("unlock")} disabled={selected.deviceId !== TRACKER_ID || !selected.online}><UnlockKeyhole size={15} /> Buka kios</button></div>{selected.deviceId !== TRACKER_ID && <div className="smb-info-note"><AlertTriangle size={16} /><span>Command pilot saat ini hanya diaktifkan untuk tracker {TRACKER_ID}.</span></div>}</section> : <section className="smb-panel smb-device-detail"><EmptyState icon={<Smartphone size={21} />} title="Pilih perangkat" body="Pilih satu baris untuk melihat telemetri dan aksi yang tersedia." /></section>}</div>;
}

function CommandsPage({ commands, devices, onOpenDevice }: { commands: CommandRow[]; devices: Device[]; onOpenDevice: (id: string) => void }) {
  const pending = commands.filter((row) => row.status === "pending" || row.status === "sent").length;
  const failed = commands.filter((row) => row.status === "failed").length;
  return <><div className="smb-command-stats"><div className="smb-panel"><small>DALAM ANTREAN</small><strong>{pending}</strong><span>Menunggu atau sedang dikirim</span></div><div className="smb-panel"><small>TERSIMPAN</small><strong>{commands.length}</strong><span>Riwayat terbaru dari SQLite</span></div><div className="smb-panel"><small>GAGAL / DITOLAK</small><strong>{failed}</strong><span>Termasuk kegagalan yang dilaporkan Android</span></div></div><section className="smb-panel smb-full-command-panel"><PanelHeading kicker="AUDIT TRAIL" title="Riwayat perintah" /><div className="smb-command-table"><div className="smb-command-table-head"><span>PERINTAH</span><span>TARGET</span><span>SUMBER</span><span>WAKTU</span><span>STATUS</span></div>{commands.map((row) => <div className="smb-command-table-row" key={row.id}><div className="smb-command-label"><div className={`smb-command-type-icon ${row.command === "lock" ? "command-is-lock" : ""}`}>{row.command === "lock" ? <LockKeyhole size={16} /> : <UnlockKeyhole size={16} />}</div><div><strong>{row.command.toUpperCase()}</strong><small>{row.id}</small></div></div><button className="smb-command-target" onClick={() => onOpenDevice(row.deviceId)}><strong>{devices.find((device) => device.deviceId === row.deviceId)?.name || "Unknown device"}</strong><small>{row.deviceId}</small></button><span className="smb-source-label">{row.issuedBy}</span><span className="smb-command-time">{formatTime(row.createdAt)}{row.completedAt && <small>Selesai {formatTime(row.completedAt)}</small>}</span><span className={`smb-command-status status-${row.status}`}>{row.status}</span><p className="smb-command-detail">{row.detail || (row.status === "pending" ? "Menunggu slot FIFO" : row.status === "sent" ? "Menunggu ACK dari Android" : "")}</p></div>)}{commands.length === 0 && <EmptyState icon={<Clock3 size={21} />} title="Belum ada riwayat" body="Broker belum menerima perintah. Baris hanya muncul dari aktivitas nyata." />}</div><div className="smb-table-footer"><span>Data disimpan lokal di SQLite</span><span>Riwayat terbaru maksimal 30 entri</span></div></section></>;
}

function ProximityPage({ telemetry, devices }: { telemetry: Snapshot["telemetry"] | null | undefined; devices: Device[] }) {
  const tracker = devices.find((device) => device.deviceId === TRACKER_ID);
  const detected = Boolean(telemetry?.online && telemetry.detected);
  return <div className="smb-two-column-page"><section className="smb-panel smb-ble-panel"><div className="smb-ble-symbol"><Bluetooth size={29} /></div><span className="smb-panel-kicker">BLUETOOTH LOW ENERGY</span><h2>{detected ? "Beacon master terdeteksi" : "Menunggu beacon master"}</h2><p>{tracker?.name || "SMB Lacak"} memindai UUID BLE dari master. Data diperbarui oleh tracker, bukan simulasi.</p><div className="smb-ble-reading"><div><small>Sinyal aktual</small><strong>{detected && telemetry?.rssi !== null ? `${telemetry?.rssi} <i>dBm</i>` : "—"}</strong></div><div><small>Status tracker</small><strong>{telemetry?.online ? "Online" : "Offline"}</strong></div><div><small>Diterima</small><strong>{telemetry?.receivedAt ? formatTime(telemetry.receivedAt) : "Belum tersedia"}</strong></div></div></section><section className="smb-panel"><PanelHeading kicker="BATAS PENGUKURAN" title="Yang bisa dan belum bisa" /><div className="smb-capability-list"><CapabilityRow good icon={<Check size={16} />} title="Pemindaian BLE" text="Berjalan pada tracker melalui foreground service dan notifikasi." /><CapabilityRow good icon={<Check size={16} />} title="Sinyal RSSI" text="Nilai dBm dilaporkan dari hasil scan yang diterima." /><CapabilityRow icon={<AlertTriangle size={16} />} title="Jarak 50 meter presisi" text="RSSI tidak dapat membedakan 50,1 m dari 49 m secara andal." /><CapabilityRow icon={<MapPinOff size={16} />} title="Lokasi GPS" text="Koordinat aktual dilaporkan saat izin Android diberikan dan layanan berjalan." /></div></section><section className="smb-panel smb-wide-note"><div className="smb-note-icon"><AlertTriangle size={19} /></div><div><strong>GPS menunjukkan lokasi, tetapi geofence auto-lock belum diaktifkan.</strong><p>Akurasi GPS berubah akibat bangunan dan kondisi langit. Radius belum dipakai untuk mengunci otomatis; status lokasi tidak menjamin batas meter yang tepat.</p></div></section></div>;
}

function PolicyPage({ telemetry }: { telemetry: Snapshot["telemetry"] | null | undefined }) {
  const owner = Boolean(telemetry?.deviceOwner);
  const locked = Boolean(telemetry?.lockTaskMode);
  return <div className="smb-two-column-page"><section className="smb-panel smb-policy-card"><div className={`smb-policy-icon ${owner ? "is-ready" : ""}`}><ShieldCheck size={25} /></div><span className="smb-panel-kicker">DEVICE POLICY CONTROLLER</span><h2>{owner ? "Device Owner aktif" : "Belum dikonfirmasi"}</h2><p>Status yang terakhir diterima dari aplikasi tracker Android.</p><div className="smb-policy-status-list"><ServiceRow icon={<ShieldCheck size={17} />} label="Android Device Owner" value={owner ? "Aktif" : "Tidak terlapor"} ok={owner} /><ServiceRow icon={<LockKeyhole size={17} />} label="Lock Task" value={locked ? "Aktif" : "Tidak aktif"} ok={locked} /><ServiceRow icon={<Smartphone size={17} />} label="Aktivitas tracker di depan" value="Tidak dilaporkan" ok={false} /></div></section><section className="smb-panel"><PanelHeading kicker="BATAS ANDROID" title="Perilaku kontrol perangkat" /><div className="smb-capability-list"><CapabilityRow good icon={<Check size={16} />} title="Pembatasan kiosk tersedia" text="Device Owner dapat mengizinkan aplikasi tracker masuk Lock Task." /><CapabilityRow icon={<AlertTriangle size={16} />} title="Perintah jarak jauh bisa ditolak" text="Android mensyaratkan kondisi aktivitas yang sesuai; broker hanya mencatat ACK atau error aktual." /><CapabilityRow icon={<EyeOff size={16} />} title="Kamera rahasia tidak tersedia" text="Pengambilan kamera diam-diam tidak disediakan. Android menampilkan izin dan indikator privasi." /></div><div className="smb-policy-warning"><AlertTriangle size={17} /><span>Lock Task membatasi perangkat hanya ketika kebijakan Android dan status activity mengizinkan. Ini bukan jaminan perangkat sama sekali tidak bisa dipakai di semua kondisi.</span></div></section></div>;
}

function IntegrationsPage({ brokerConnected, telegramConfigured, supabaseConfigured }: { brokerConnected: boolean; telegramConfigured: boolean; supabaseConfigured: boolean }) {
  return <div className="smb-integration-grid"><IntegrationCard icon={<Server size={21} />} title="Broker PC" subtitle="Node.js · HTTPS + WSS" status={brokerConnected ? "Tersambung" : "Terputus"} ok={brokerConnected} detail="Dashboard tersambung ke broker lewat WSS terenkripsi. PC dan proses broker harus tetap hidup." /><IntegrationCard icon={<Bot size={21} />} title="Telegram Bot" subtitle="Bot API polling" status={telegramConfigured ? "Token tersedia" : "Belum dikonfigurasi"} ok={telegramConfigured} detail={telegramConfigured ? "Status token tersedia di broker. Periksa whitelist chat admin pada konfigurasi server." : "Telegram belum aktif pada proses broker. Token yang pernah dikirim perlu dirotasi sebelum dipakai kembali."} /><IntegrationCard icon={<Bluetooth size={21} />} title="Proximity BLE" subtitle="Tracker ↔ Master" status="1 tracker terdaftar" ok={true} detail="BLE scan dilaporkan oleh tracker aktual. RSSI tidak dikonversi menjadi meter." /><IntegrationCard icon={<Network size={21} />} title="Cloudflare Tunnel" subtitle="broker.lacaksmbbot.com → PC" status={brokerConnected ? "Aktif · broker terjangkau" : "Menunggu koneksi"} ok={brokerConnected} detail="Tunnel berjalan di latar belakang PC dan meneruskan HTTPS/WSS ke broker lokal pada port 8787. Anda tidak perlu membuka URL tunnel; domain ini dipakai aplikasi dan dashboard." /><IntegrationCard icon={<Network size={21} />} title="Supabase" subtitle="Sinkron database dari PC" status={supabaseConfigured ? "Kredensial tersedia" : "Kredensial belum dipasang"} ok={supabaseConfigured} detail={supabaseConfigured ? "Sinkronisasi sisi server dikonfigurasi; status kirim dan retry tercatat di log PC." : "Skema siap di supabase/schema.sql. Isi URL dan service-role key hanya pada .env.local di PC."} /><div className="smb-integration-footnote"><AlertTriangle size={17} /><span>PC tetap menjadi satu-satunya broker untuk perintah. Supabase hanya menerima sinkronisasi batch dan tidak mengirim perintah langsung ke HP. Service-role key tetap di PC. Skala ribuan unit belum tervalidasi; registri broker saat ini memuat dua perangkat dan belum ada load test.</span></div></div>;
}

function SettingsPage({ devices, telemetry, brokerConnected, telegramConfigured }: { devices: Device[]; telemetry: Snapshot["telemetry"] | null | undefined; brokerConnected: boolean; telegramConfigured: boolean }) {
  return <><div className="smb-settings-grid"><section className="smb-panel"><PanelHeading kicker="IDENTITAS" title="Perangkat master" /><div className="smb-setting-row"><div className="smb-setting-icon"><Smartphone size={18} /></div><div><strong>SMB Master</strong><small>ID perangkat {MASTER_ID}</small></div><span className="smb-tag">MASTER</span></div></section><section className="smb-panel"><PanelHeading kicker="BROKER" title="Koneksi jaringan" /><div className="smb-setting-row"><div className="smb-setting-icon"><Wifi size={18} /></div><div><strong>WSS terenkripsi</strong><small>broker.lacaksmbbot.com melalui Cloudflare Tunnel</small></div><span className={`smb-status-pill ${brokerConnected ? "status-on" : "status-off"}`}>{brokerConnected ? "AKTIF" : "TERPUTUS"}</span></div></section><section className="smb-panel"><PanelHeading kicker="DATA" title="Penyimpanan lokal" /><div className="smb-setting-row"><div className="smb-setting-icon"><Server size={18} /></div><div><strong>SQLite di PC broker</strong><small>{devices.length} baris device aktif dari registri broker</small></div><span className="smb-tag">LOCAL</span></div></section><section className="smb-panel"><PanelHeading kicker="INTEGRASI" title="Fitur tersedia" /><div className="smb-setting-row"><div className="smb-setting-icon"><Bot size={18} /></div><div><strong>Telegram Bot</strong><small>{telegramConfigured ? "Token ditemukan oleh broker" : "Token belum dikonfigurasi"}</small></div><span className={`smb-status-pill ${telegramConfigured ? "status-on" : "status-off"}`}>{telegramConfigured ? "SIAP" : "NONAKTIF"}</span></div><div className="smb-setting-row"><div className="smb-setting-icon"><Battery size={18} /></div><div><strong>Baterai SMB Lacak</strong><small>Telemetri terakhir yang diterima broker</small></div><span className="smb-tag">{telemetry?.batteryLevel == null ? "—" : `${telemetry.batteryLevel}%`}</span></div><div className="smb-setting-row"><div className="smb-setting-icon"><MapPinOff size={18} /></div><div><strong>Lokasi perangkat aktual</strong><small>{telemetry?.locationAt ? `Terakhir ${formatTime(telemetry.locationAt)}` : "Menunggu laporan GPS"}</small></div><span className="smb-tag">{telemetry?.locationAt ? "LIVE" : "MENUNGGU"}</span></div></section></div><div className="smb-scale-callout"><div className="smb-note-icon"><Activity size={18} /></div><div><strong>Kapasitas armada belum diuji pada skala besar.</strong><p>Server memakai SQLite WAL untuk status dan audit perintah pada instalasi lokal ini. Saat ini dua ID perangkat terdaftar. Provisioning massal, failover, dan uji beban skala ribuan belum disiapkan.</p></div></div></>;
}

function ChangePasswordPanel({ apiBase, token }: { apiBase: string; token: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/auth/password`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, totpCode }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Password tidak dapat diperbarui.");
      setMessage(result.message);
      setCurrentPassword("");
      setNewPassword("");
      setTotpCode("");
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Permintaan gagal."); }
    finally { setBusy(false); }
  };
  return <section className="smb-panel smb-password-panel">
    <PanelHeading kicker="KEAMANAN AKUN" title="Ganti password" />
    <p className="smb-admin-help">Gunakan password berbeda dan panjang. Perubahan memerlukan password serta kode 2FA saat ini.</p>
    <form className="smb-admin-create-form" onSubmit={submit}>
      <label>Password saat ini<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
      <label>Password baru<input type="password" autoComplete="new-password" minLength={12} maxLength={256} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /><small>Minimal 12 karakter.</small></label>
      <label>Kode 2FA<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required /></label>
      <button className="smb-button-primary" type="submit" disabled={busy}>{busy ? "Menyimpan…" : "Perbarui password"}</button>
    </form>
    {message && <div className="smb-admin-feedback is-success">{message}</div>}
    {error && <div className="smb-admin-feedback is-error">{error}</div>}
  </section>;
}

type AdminAccount = { id: number; username: string; role: "superadmin" | "staff"; totpEnabled: boolean; createdAt: string };

function AdminUsersPage({ apiBase, token }: { apiBase: string; token: string }) {
  const [users, setUsers] = useState<AdminAccount[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"staff" | "superadmin">("staff");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const loadUsers = async () => {
    try {
      const response = await fetch(`${apiBase}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Daftar akun tidak dapat dimuat.");
      setUsers(data.users as AdminAccount[]);
      setError("");
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Koneksi broker gagal."); }
  };
  useEffect(() => { void loadUsers(); }, [apiBase, token]);
  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/admin/users`, { method: "POST", headers, body: JSON.stringify({ username, password, role }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Akun tidak dapat dibuat.");
      setNotice(`Akun ${data.user.username} dibuat. Minta pengguna mendaftarkan aplikasi authenticator saat login pertama.`);
      setUsername("");
      setPassword("");
      await loadUsers();
    } catch (createError) { setError(createError instanceof Error ? createError.message : "Pembuatan akun gagal."); }
    finally { setBusy(false); }
  };
  const resetTotp = async (user: AdminAccount) => {
    if (!window.confirm(`Reset 2FA untuk ${user.username}? Sesi mereka akan dicabut dan mereka perlu menyiapkan authenticator lagi.`)) return;
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiBase}/api/admin/users/${user.id}/reset-totp`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Reset 2FA gagal.");
      setNotice(data.message);
      await loadUsers();
    } catch (resetError) { setError(resetError instanceof Error ? resetError.message : "Reset 2FA gagal."); }
  };
  return <div className="smb-admin-users-page">
    <section className="smb-panel smb-admin-create-panel">
      <PanelHeading kicker="AKSES DASHBOARD" title="Tambah akun admin" />
      <p className="smb-admin-help">Password hanya disimpan sebagai hash. Pengguna baru wajib mendaftarkan 2FA authenticator sebelum dapat masuk.</p>
      <form className="smb-admin-create-form" onSubmit={createUser}>
        <label>Username<input autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" required /></label>
        <label>Password sementara<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={256} required /><small>Minimal 12 karakter.</small></label>
        <label>Peran<select value={role} onChange={(event) => setRole(event.target.value as "staff" | "superadmin")}><option value="staff">Staff</option><option value="superadmin">Superadmin</option></select></label>
        <button className="smb-button-primary" type="submit" disabled={busy}>{busy ? "Membuat akun…" : "Buat akun"}</button>
      </form>
      {notice && <div className="smb-admin-feedback is-success">{notice}</div>}
      {error && <div className="smb-admin-feedback is-error">{error}</div>}
    </section>
    <section className="smb-panel smb-admin-list-panel">
      <PanelHeading kicker="PENGGUNA TERDAFTAR" title={`${users.length} akun`} action={<button className="smb-text-link" onClick={() => void loadUsers()}><RefreshCw size={14} /> Segarkan</button>} />
      <div className="smb-admin-list">
        {users.map((user) => <div className="smb-admin-row" key={user.id}>
          <div className="smb-admin-avatar"><Users size={17} /></div>
          <div className="smb-admin-account"><strong>{user.username}</strong><small>{user.role === "superadmin" ? "Superadmin" : "Staff"} · dibuat {formatTime(user.createdAt)}</small></div>
          <span className={`smb-status-pill ${user.totpEnabled ? "status-on" : "status-off"}`}>{user.totpEnabled ? "2FA AKTIF" : "2FA WAJIB"}</span>
          {user.totpEnabled && <button className="smb-button-muted smb-reset-totp" onClick={() => void resetTotp(user)}>Reset 2FA</button>}
        </div>)}
        {users.length === 0 && <EmptyState icon={<Users size={21} />} title="Belum ada akun" body="Daftar pengguna akan muncul setelah dimuat dari broker." />}
      </div>
    </section>
  </div>;
}

function MetricCard({ icon, label, value, foot, tone }: { icon: ReactNode; label: string; value: string; foot: string; tone: string }) {
  return <section className="smb-panel smb-metric-card"><div className={`smb-metric-icon tone-${tone}`}>{icon}</div><span>{label}</span><strong>{value}</strong><small>{foot}</small></section>;
}
function PanelHeading({ kicker, title, action }: { kicker: string; title: string; action?: ReactNode }) { return <div className="smb-panel-heading"><div><span className="smb-panel-kicker">{kicker}</span><h2>{title}</h2></div>{action}</div>; }
function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) { return <div className="smb-empty-state"><div>{icon}</div><strong>{title}</strong><p>{body}</p></div>; }
function ServiceRow({ icon, label, value, ok }: { icon: ReactNode; label: string; value: string; ok: boolean }) { return <div className="smb-service-row"><span className="smb-service-icon">{icon}</span><span>{label}</span><strong className={ok ? "service-ok" : "service-muted"}>{value}</strong>{ok ? <Check size={15} /> : <CircleAlert size={15} />}</div>; }
function DetailValue({ label, value }: { label: string; value: string }) { return <div className="smb-detail-value"><small>{label}</small><strong>{value}</strong></div>; }
function CommandListRow({ row, device }: { row: CommandRow; device?: Device }) { return <div className="smb-command-list-row"><div className={`smb-command-type-icon ${row.command === "lock" ? "command-is-lock" : ""}`}>{row.command === "lock" ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</div><div className="smb-command-list-main"><strong>{row.command.toUpperCase()} · {device?.name || row.deviceId}</strong><small>{formatTime(row.createdAt)} · {row.issuedBy}</small></div><span className={`smb-command-status status-${row.status}`}>{row.status}</span></div>; }
function CapabilityRow({ good = false, icon, title, text }: { good?: boolean; icon: ReactNode; title: string; text: string }) { return <div className={`smb-capability-row ${good ? "is-good" : ""}`}><div>{icon}</div><section><strong>{title}</strong><p>{text}</p></section></div>; }
function IntegrationCard({ icon, title, subtitle, status, ok, detail }: { icon: ReactNode; title: string; subtitle: string; status: string; ok: boolean; detail: string }) { return <section className="smb-panel smb-integration-card"><div className="smb-integration-card-top"><div className="smb-integration-icon">{icon}</div><span className={`smb-status-pill ${ok ? "status-on" : "status-off"}`}><i />{status}</span></div><h2>{title}</h2><small>{subtitle}</small><p>{detail}</p></section>; }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Waktu tidak diketahui" : date.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }); }

export default App;
