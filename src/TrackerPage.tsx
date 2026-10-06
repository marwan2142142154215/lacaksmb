import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Bluetooth, Building2, LockKeyhole, MapPin, Radio, ShieldCheck, Signal, Wifi } from "lucide-react";
import { brokerConfig, devicePolicy, proximityBle, type BleScanResult, type DeviceLocation } from "./proximityBle";
import { clearTrackerAuth, readTrackerAuth, saveTrackerAuth, usePilotBroker, type BrokerCommand } from "./pilotBroker";
import "./tracker.css";

const DEFAULT_BROKER_URL = brokerConfig.url;
const DEFAULT_MASTER_ID = "R9RY506354P";
const API_BASE = DEFAULT_BROKER_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/ws(?:\?.*)?$/, "");

type EnrollmentSite = { id: number; name: string; wifiAllowlist?: string[] };

export default function TrackerPage() {
  const [scanning, setScanning] = useState(true);
  const [lastLocation, setLastLocation] = useState<DeviceLocation | null>(null);
  const [lastResult, setLastResult] = useState<BleScanResult | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
  const [message, setMessage] = useState("Pemantauan GPS, BLE & WiFi berjalan otomatis. Kamera hanya mengambil foto saat diminta.");
  const lastUpdate = useRef(0);
  const latestRef = useRef<{ detected: boolean; rssi: number | null; at: number }>({ detected: false, rssi: null, at: 0 });
  const [locked, setLocked] = useState(false);
  const [policyNotice, setPolicyNotice] = useState("Memeriksa status proteksi…");
  const [auth, setAuth] = useState(() => readTrackerAuth());
  const [uninstallBlocked, setUninstallBlocked] = useState(true);

  // Perintah jarak jauh dari master/web. Target harus sama dengan ID perangkat ini.
  const runRemoteCommand = async (command: BrokerCommand) => {
    const currentAuth = readTrackerAuth();
    const myId = currentAuth?.deviceId || auth?.deviceId || "";
    if (myId && command.targetId && command.targetId !== myId) return { ok: false, detail: "Target perangkat tidak cocok." };
    try {
      // Foto hanya diambil ketika ada perintah ini; tidak ada timer pengambilan foto.
      if (command.command === "photo" || command.command === "photo_front") {
        if (!currentAuth?.token) return { ok: false, detail: "Perangkat belum terdaftar (belum enrolmen site)." };
        setMessage("Mengambil foto sesuai permintaan…");
        const shot = await proximityBle.capturePhoto({ lens: command.command === "photo_front" ? "front" : "back" });
        const response = await fetch(`${API_BASE}/api/telemetry/photo`, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${currentAuth.token}` },
          body: JSON.stringify({ deviceId: currentAuth.deviceId, commandId: command.commandId, imageBase64: shot.imageBase64, capturedAt: shot.capturedAt }),
        });
        if (!response.ok) throw new Error(`Foto gagal dikirim (HTTP ${response.status}).`);
        setMessage("Foto dikirim sesuai permintaan ke broker/Telegram.");
        return { ok: true, detail: "Foto diambil dan diteruskan ke Telegram admin." };
      }
      if (command.command === "lock") {
        const result = await devicePolicy.lock();
        setLocked(result.lockTaskMode === 1);
        setMessage("Mode kios dikonfirmasi Android.");
        return { ok: result.locked && result.lockTaskMode === 1, detail: "Status Lock Task dilaporkan Android.", lockTaskMode: result.lockTaskMode };
      }
      if (command.command === "unlock") {
        const result = await devicePolicy.unlock();
        setLocked(result.lockTaskMode === 1);
        setMessage("Status buka kunci dikonfirmasi Android.");
        return { ok: !result.locked && result.lockTaskMode === 0, detail: "Status Lock Task dilaporkan Android.", lockTaskMode: result.lockTaskMode };
      }
      // "uninstall": buka layar hapus bawaan Android. Blokir dilepas sementara
      // oleh Device Owner, lalu dikunci lagi setelah layar terbuka.
      await devicePolicy.setUninstallBlocked({ blocked: false }).catch(() => ({ blocked: false }));
      setUninstallBlocked(false);
      const opened = await devicePolicy.openUninstallScreen();
      setMessage("Layar hapus aplikasi dibuka oleh perintah master.");
      // Kunci ulang setelah beberapa detik agar HP tidak bisa dihapus seenaknya.
      window.setTimeout(() => {
        void devicePolicy.setUninstallBlocked({ blocked: true }).then(() => setUninstallBlocked(true)).catch(() => undefined);
      }, 30_000);
      return { ok: opened.opened, detail: "Layar hapus aplikasi Android dibuka." };
    } catch (error) {
      const status = await devicePolicy.getStatus().catch(() => null);
      setLocked(status?.lockTaskMode === 1);
      return { ok: false, detail: error instanceof Error ? error.message : "Perintah Device Policy gagal.", ...(status ? { lockTaskMode: status.lockTaskMode } : {}) };
    }
  };

  const broker = usePilotBroker("tracker", auth?.deviceId || "", runRemoteCommand, auth?.token, auth?.lanBrokerUrl);

  // Sinkronkan blokir hapus dari broker (master/web yang mengontrol).
  useEffect(() => {
    if (broker.uninstallBlocked === null) return;
    setUninstallBlocked(broker.uninstallBlocked);
    void devicePolicy.setUninstallBlocked({ blocked: broker.uninstallBlocked }).catch(() => undefined);
  }, [broker.uninstallBlocked]);

  const startScanning = async () => {
    const currentAuth = readTrackerAuth();
    if (!currentAuth?.token) return; // Belum enrolmen → service tidak dijalankan.
    try {
      await proximityBle.startScan({
        brokerUrl: currentAuth.brokerUrl || DEFAULT_BROKER_URL,
        lanBrokerUrl: currentAuth.lanBrokerUrl || "",
        token: currentAuth.token,
        deviceId: currentAuth.deviceId,
        masterId: DEFAULT_MASTER_ID,
      });
      setScanning(true);
      setMessage("Layanan GPS dan BLE aktif.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Memulai pemantauan background...");
    }
  };

  useEffect(() => {
    if (!auth?.token) return;
    void startScanning();
    void proximityBle.isScanning().then((result) => { setScanning(result.active); }).catch(() => undefined);
    void devicePolicy.getStatus().then((status) => {
      setLocked(status.lockTaskMode === 1);
      setPolicyNotice(status.deviceOwner
        ? "Android Device Owner aktif."
        : status.deviceAdmin
          ? "Device Admin aktif; mode kios memerlukan enrollment Device Owner."
          : "Android Device Owner belum terdaftar.");
    }).catch(() => setPolicyNotice("Status keamanan aktif."));

    // Auto-restart service bila Android mematikannya.
    const keepAliveTimer = window.setInterval(() => {
      void proximityBle.isScanning().then((result) => {
        if (!result.active) void startScanning();
      }).catch(() => undefined);
    }, 5000);

    return () => { window.clearInterval(keepAliveTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.token]);

  useEffect(() => {
    let mounted = true;
    const resultListener = proximityBle.addListener("scanResult", (event) => {
      if (!mounted) return;
      const now = Date.now();
      latestRef.current = { detected: true, rssi: event.rssi, at: now };
      setLastSeenAt(now);
      if (now - lastUpdate.current > 700) {
        lastUpdate.current = now;
        setLastResult(event);
      }
    });
    const errorListener = proximityBle.addListener("scanError", (event) => {
      if (mounted) setMessage(`Pemindaian BLE: kode ${event.errorCode}`);
    });
    const serviceListener = proximityBle.addListener("serviceState", (event) => {
      if (!mounted) return;
      setScanning(event.running);
      if (!event.running) void startScanning();
    });
    const locationListener = proximityBle.addListener("locationResult", (event) => {
      if (mounted) setLastLocation(event);
    });

    return () => {
      mounted = false;
      void resultListener.then((listener) => listener.remove());
      void errorListener.then((listener) => listener.remove());
      void serviceListener.then((listener) => listener.remove());
      void locationListener.then((listener) => listener.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const latest = latestRef.current;
      if (latest.detected && latest.at > 0 && Date.now() - latest.at > 8000) {
        latestRef.current = { detected: false, rssi: null, at: latest.at };
        setMessage("Beacon master berada di luar jangkauan.");
      }
    }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);

  const ageSeconds = lastSeenAt === null ? null : Math.floor((Date.now() - lastSeenAt) / 1000);
  const signalStrength = lastResult ? Math.max(0, Math.min(100, Math.round((lastResult.rssi + 100) * 2))) : 0;
  const isDetected = scanning && lastSeenAt !== null && Date.now() - lastSeenAt < 8000;

  if (!auth?.token) return <EnrollmentScreen onEnrolled={(next) => { setAuth(next); setMessage("Enrolmen site selesai. Pemantauan dimulai."); }} />;

  if (locked) {
    return (
      <main className="tracker-lock-screen">
        <div className="tracker-lock-icon"><LockKeyhole size={34} /></div>
        <span className="tracker-eyebrow"><i /> PERANGKAT DIKUNCI MASTER</span>
        <h1>Silakan kembali ke posisi Anda, bosku.</h1>
        <p>Mode kiosk Android aktif. Akses aplikasi dan tombol Home dibatasi sampai SMB Master mengirim buka kunci.</p>
        <div className="tracker-lock-status"><span className="tracker-status-pulse" /> BLE latar aktif · broker {broker.connected ? "terhubung" : "menyambung"}</div>
        <small>{policyNotice}</small>
      </main>
    );
  }

  return (
    <main className="tracker-shell">
      <header className="tracker-header">
        <div className="tracker-brand-mark"><Radio size={20} /></div>
        <div>
          <strong>SMB <span>Lacak</span></strong>
          <small>PEMANTAUAN OTOMATIS</small>
        </div>
        <span className="tracker-device-pill">{auth.site?.name ? auth.site.name.toUpperCase() : "TERDAFTAR"}</span>
      </header>

      <section className="tracker-intro">
        <div className="tracker-eyebrow"><span /> PELACAK AKTIF PERMANEN</div>
        <h1>{auth.site?.name ? `Site: ${auth.site.name}` : "Perangkat tracker"}</h1>
        <p>SMB Lacak mengirim status GPS, WiFi dan BLE ke broker saat izin Android aktif. Kamera tidak mengambil foto otomatis; foto hanya diambil ketika admin mengirim perintah Kirim foto, lalu hasilnya dikirim ke Telegram admin.</p>
      </section>

      <section className={`tracker-signal-card ${isDetected ? "signal-detected" : ""}`}>
        <div className="tracker-signal-top">
          <div className="tracker-signal-icon"><Bluetooth size={22} /></div>
          <span className={`tracker-state ${isDetected ? "state-online" : ""}`}>
            <i /> {isDetected ? "TERDETEKSI" : "MEMANTAU"}
          </span>
        </div>
        <div className="tracker-master-id">{DEFAULT_MASTER_ID}</div>
        <div className="tracker-master-caption">Beacon master yang dipasangkan</div>
        <div className="tracker-signal-meter" aria-label={`Kekuatan sinyal ${signalStrength}%`}>
          {Array.from({ length: 5 }, (_, index) => (
            <i key={index} className={signalStrength > index * 20 ? "meter-active" : ""} />
          ))}
          <strong>{lastResult ? `${lastResult.rssi} dBm` : "— dBm"}</strong>
        </div>
        <div className="tracker-last-seen">
          <span><Signal size={14} /> {lastResult ? "Sinyal BLE diterima" : "Memindai frekuensi..."}</span>
          <span>{ageSeconds !== null && isDetected ? "Baru saja" : "—"}</span>
        </div>
      </section>

      <div className="tracker-status-line">
        <span className="tracker-status-pulse" />
        <span>{message} Broker: <strong>{broker.connected ? "terhubung" : "menyambung…"}</strong></span>
      </div>

      <div className="tracker-site-card">
        <Building2 size={17} />
        <span><strong>{auth.site?.name || "Belum ada site"}</strong> · ID {auth.deviceId}</span>
        <span className={`tracker-site-block ${uninstallBlocked ? "is-blocked" : ""}`}>
          {uninstallBlocked ? "Uninstall diblokir" : "Uninstall sementara dibuka"}
        </span>
      </div>

      <div className="tracker-permission-note">
        <ShieldCheck size={17} />
        <span>Sistem pelacak bekerja 24/7 di latar belakang. Tidak ada tombol henti untuk mencegah penonaktifan tanpa izin.</span>
      </div>

      <section className="tracker-location-card">
        <div className="tracker-location-heading">
          <MapPin size={17} />
          <strong>Lokasi GPS Terkini</strong>
          <span className={lastLocation ? "location-live" : "location-waiting"}>{lastLocation ? "TERKIRIM" : "MENUNGGU GPS"}</span>
        </div>
        {lastLocation ? (
          <div className="tracker-location-values">
            <strong>{lastLocation.latitude.toFixed(6)}, {lastLocation.longitude.toFixed(6)}</strong>
            <small>Akurasi ±{lastLocation.accuracyMeters == null ? "—" : `${Math.round(lastLocation.accuracyMeters)} m`} · {lastLocation.provider.toUpperCase()} · {new Date(lastLocation.capturedAt).toLocaleTimeString()}</small>
          </div>
        ) : (
          <p>Mendapatkan koordinat presisi dari satelit GPS...</p>
        )}
      </section>

      <div style={{
        margin: "12px 0",
        padding: "14px 18px",
        background: "rgba(16, 185, 129, 0.12)",
        border: "1px solid rgba(16, 185, 129, 0.3)",
        borderRadius: "14px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        color: "#10b981",
        fontSize: "13px",
        fontWeight: 600
      }}>
        <div style={{
          width: "10px",
          height: "10px",
          borderRadius: "50%",
          background: "#10b981",
          boxShadow: "0 0 10px #10b981"
        }} />
        <span>Pemantauan Aktif Permanen (Auto-Run & Selalu Terhubung)</span>
      </div>

      <div className="tracker-warning">
        <AlertTriangle size={16} />
        <span>Pengambilan kamera otomatis/nonaktif; foto hanya diambil ketika perintah Kirim foto dari web atau Telegram, satu foto per permintaan.</span>
      </div>
      <footer className="tracker-footer">{policyNotice} · Auto-start pada boot & update aktif</footer>
    </main>
  );
}

/** Layar enrolmen: masukkan kode 8 karakter yang dibuat superadmin saat memilih site. */
function EnrollmentScreen({ onEnrolled }: { onEnrolled: (auth: NonNullable<ReturnType<typeof readTrackerAuth>>) => void }) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [site, setSite] = useState<EnrollmentSite | null>(null);

  useEffect(() => {
    // ID kandidat diambil dari Android agar enrolmen terikat ke HP ini.
    void proximityBle.getDeviceId?.().then((result) => { if (result?.deviceId) setDeviceId(result.deviceId); }).catch(() => undefined);
  }, []);

  useEffect(() => {
    // APK yang diunduh dari dashboard dengan pilihan site sudah membawa kode
    // enrolmen di assets/public/site-enrollment.json: daftar otomatis tanpa input.
    void (async () => {
      try {
        const config = await fetch("site-enrollment.json", { cache: "no-store" }).then((res) => (res.ok ? res.json() : null)) as { code?: string } | null;
        const seededCode = (config?.code || "").trim();
        if (!seededCode) return;
        setBusy(true);
        setSite(null);
        const resolvedId = (await proximityBle.getDeviceId?.().then((r) => r?.deviceId).catch(() => "")) || deviceId || `device-${Math.random().toString(36).slice(2, 10)}`;
        const response = await fetch(`${API_BASE}/api/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId: resolvedId, code: seededCode, name: "" }),
          cache: "no-store",
        });
        const payload = await response.json().catch(() => null) as {
          token?: string; brokerUrl?: string; lanBrokerUrl?: string;
          device?: { deviceId?: string }; site?: EnrollmentSite | null; message?: string;
        } | null;
        if (!response.ok || !payload?.token) throw new Error(payload?.message || `Enrolmen gagal (HTTP ${response.status}).`);
        const next = {
          deviceId: payload.device?.deviceId || resolvedId,
          token: payload.token,
          brokerUrl: payload.brokerUrl || DEFAULT_BROKER_URL,
          lanBrokerUrl: payload.lanBrokerUrl || "",
          site: payload.site ? { id: payload.site.id, name: payload.site.name } : null,
        };
        saveTrackerAuth(next);
        setSite(payload.site || null);
        onEnrolled(next);
      } catch (autoError) {
        setError(autoError instanceof Error ? `Enrolmen otomatis gagal: ${autoError.message}. Masukkan kode manual atau unduh ulang APK per-site.` : "Enrolmen otomatis gagal; masukkan kode manual.");
      } finally { setBusy(false); }
    })();
    // Hanya sekali saat layar dibuka.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const resolvedId = deviceId || `device-${Math.random().toString(36).slice(2, 10)}`;
      const response = await fetch(`${API_BASE}/api/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: resolvedId, code: code.trim(), name: label.trim() }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as {
        token?: string; brokerUrl?: string; lanBrokerUrl?: string;
        device?: { deviceId?: string }; site?: EnrollmentSite | null; message?: string;
      } | null;
      if (!response.ok || !payload?.token) throw new Error(payload?.message || `Enrolmen gagal (HTTP ${response.status}).`);
      const next = {
        deviceId: payload.device?.deviceId || resolvedId,
        token: payload.token,
        brokerUrl: payload.brokerUrl || DEFAULT_BROKER_URL,
        lanBrokerUrl: payload.lanBrokerUrl || "",
        site: payload.site ? { id: payload.site.id, name: payload.site.name } : null,
      };
      saveTrackerAuth(next);
      setSite(payload.site || null);
      onEnrolled(next);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Tidak dapat menghubungi broker.");
    } finally { setBusy(false); }
  };

  return (
    <main className="tracker-shell">
      <header className="tracker-header">
        <div className="tracker-brand-mark"><Radio size={20} /></div>
        <div>
          <strong>SMB <span>Lacak</span></strong>
          <small>ENROLMEN SITE</small>
        </div>
        <span className="tracker-device-pill">BELUM AKTIF</span>
      </header>

      <section className="tracker-intro">
        <div className="tracker-eyebrow"><span /> LANGKAH 1 · DAFTARKAN KE SITE/TIM</div>
        <h1>Masukkan kode enrolmen</h1>
        <p>Kode 8 karakter diberikan superadmin setelah memilih site/tim di dashboard. Kode hanya berlaku 24 jam dan sekali pakai.</p>
      </section>

      <form className="tracker-enroll-form" onSubmit={submit}>
        <label htmlFor="enroll-code">Kode enrolmen</label>
        <input
          id="enroll-code"
          className="tracker-enroll-input"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
          placeholder="CONTOH: K3RT7P2Q"
          maxLength={8}
          autoComplete="off"
          required
        />
        <label htmlFor="enroll-label">Nama HP (opsional)</label>
        <input
          id="enroll-label"
          className="tracker-enroll-input"
          value={label}
          onChange={(event) => setLabel(event.target.value.slice(0, 40))}
          placeholder="Contoh: HP-001-TOKO-A"
          autoComplete="off"
        />
        {error && <small className="tracker-enroll-error">{error}</small>}
        {site && <small className="tracker-enroll-ok">Terhubung ke site {site.name}.</small>}
        <button type="submit" disabled={busy || code.length !== 8}>
          {busy ? "Memverifikasi…" : "Daftarkan perangkat"}
        </button>
        <p className="tracker-enroll-note">
          ID perangkat: <code>{deviceId || "mengambil dari Android…"}</code>.Broker publik: <code>{DEFAULT_BROKER_URL}</code>.
          <button type="button" className="tracker-enroll-reset" onClick={() => { clearTrackerAuth(); setCode(""); setError(""); }}>
            Hapus enrolmen tersimpan
          </button>
        </p>
      </form>

      <footer className="tracker-footer"><Wifi size={14} /> Enrolmen mengikat HP ini ke satu site/tim beserta daftar WiFi izinnya.</footer>
    </main>
  );
}
