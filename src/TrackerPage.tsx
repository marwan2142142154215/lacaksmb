import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bluetooth, LockKeyhole, MapPin, Radio, ShieldCheck, Signal, X } from "lucide-react";
import { brokerConfig, devicePolicy, proximityBle, type BleScanResult, type DeviceLocation, type LocationPermissionStatus } from "./proximityBle";
import { usePilotBroker, type BrokerCommand } from "./pilotBroker";
import "./tracker.css";

export default function TrackerPage() {
  const [scanning, setScanning] = useState(false);
  const [locationStatus, setLocationStatus] = useState<LocationPermissionStatus>({ granted: false, precise: false, backgroundGranted: false, gpsEnabled: false });
  const [locationActive, setLocationActive] = useState(false);
  const [lastLocation, setLastLocation] = useState<DeviceLocation | null>(null);
  const [lastResult, setLastResult] = useState<BleScanResult | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
  const [message, setMessage] = useState("Siap memindai beacon master.");
  const lastUpdate = useRef(0);
  const latestRef = useRef<{ detected: boolean; rssi: number | null; at: number }>({ detected: false, rssi: null, at: 0 });
  const [deviceOwner, setDeviceOwner] = useState(false);
  const [locked, setLocked] = useState(false);
  const [policyNotice, setPolicyNotice] = useState("Memeriksa status Device Owner…");
  const runRemoteCommand = async (command: BrokerCommand) => {
    if (command.targetId !== "R9RXC03EC9N") return { ok: false, detail: "Target perangkat tidak cocok." };
    try {
      if (command.command === "lock") {
        await devicePolicy.lock();
        setLocked(true);
        setMessage("Mode kios diaktifkan oleh master.");
        return { ok: true, detail: "Lock task aktif." };
      }
      await devicePolicy.unlock();
      setLocked(false);
      setMessage("Mode kios dibuka oleh master.");
      return { ok: true, detail: "Lock task dihentikan." };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Perintah Device Policy gagal." };
    }
  };
  const broker = usePilotBroker("tracker", "R9RXC03EC9N", runRemoteCommand);

  useEffect(() => {
    void proximityBle.isScanning().then((result) => { setScanning(result.active); setLocationActive(result.locationActive); }).catch(() => undefined);
    void proximityBle.getLocationStatus().then(setLocationStatus).catch(() => undefined);
    void devicePolicy.getStatus().then((status) => {
      setDeviceOwner(status.deviceOwner);
      setLocked(status.lockTaskMode !== 0);
      setPolicyNotice(status.deviceOwner ? "Device Owner aktif di Android." : "Belum terdaftar sebagai Device Owner.");
    }).catch(() => setPolicyNotice("Status Device Owner tidak dapat dibaca."));
  }, []);

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
      if (mounted) setMessage(`Pemindaian BLE gagal (kode ${event.errorCode}).`);
    });
    const serviceListener = proximityBle.addListener("serviceState", (event) => {
      if (!mounted) return;
      setScanning(event.running);
      setLocationActive(event.locationActive);
      if (!event.running && event.detail !== "stopped") setMessage(`Service BLE berhenti: ${event.detail}`);
    });
    const locationListener = proximityBle.addListener("locationResult", (event) => {
      if (!mounted) return;
      setLastLocation(event);
      setLocationActive(true);
      void proximityBle.getLocationStatus().then(setLocationStatus).catch(() => undefined);
    });

    return () => {
      mounted = false;
      void resultListener.then((listener) => listener.remove());
      void errorListener.then((listener) => listener.remove());
      void serviceListener.then((listener) => listener.remove());
      void locationListener.then((listener) => listener.remove());
    };
  }, []);

  useEffect(() => {
    if (!scanning) return;
    const timer = window.setInterval(() => {
      const latest = latestRef.current;
      if (latest.detected && latest.at > 0 && Date.now() - latest.at > 8000) {
        latestRef.current = { detected: false, rssi: null, at: latest.at };
        setMessage("Beacon master tidak terdeteksi. Buka jarak atau periksa Bluetooth.");
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [scanning]);

  const startScanning = async () => {
    try {
      const access = await proximityBle.requestAccess();
      if (!access.granted) {
        setMessage("Izin Bluetooth belum diberikan. Izinkan Nearby devices untuk melanjutkan.");
        return;
      }
      if (!access.serviceNotification) {
        setMessage("Izin notifikasi harus aktif agar layanan pemantauan selalu terlihat.");
        return;
      }
      const locationAccess = await proximityBle.requestLocationAccess();
      const currentLocationStatus = await proximityBle.getLocationStatus();
      setLocationStatus(currentLocationStatus);
      await proximityBle.startScan({
        brokerUrl: brokerConfig.url,
        token: brokerConfig.token,
        deviceId: "R9RXC03EC9N",
        masterId: "R9RY506354P",
      });
      setScanning(true);
      setLocationActive(false);
      setMessage(locationAccess.granted
        ? "Layanan GPS + BLE berjalan dengan notifikasi yang terlihat."
        : "Izin GPS belum diberikan; BLE berjalan dan lokasi tidak dibagikan.");
    } catch (error) {
      setScanning(false);
      setMessage(error instanceof Error ? error.message : "Tidak dapat memulai pemindaian BLE.");
    }
  };

  const enableBackgroundLocation = async () => {
    try {
      const result = await proximityBle.requestBackgroundLocation();
      const status = await proximityBle.getLocationStatus();
      setLocationStatus(status);
      setMessage(result.granted
        ? "Izin lokasi sepanjang waktu aktif; Android dapat memulihkan GPS setelah restart."
        : "Android belum memberi izin lokasi sepanjang waktu. Pemantauan tetap terlihat, tetapi GPS setelah restart perlu dibuka lagi.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Pengaturan lokasi latar tidak dapat dibuka.");
    }
  };

  const enableGpsNow = async () => {
    try {
      let status = await proximityBle.getLocationStatus();
      if (!status.granted) {
        const permissionResult = await proximityBle.requestLocationAccess();
        if (!permissionResult.granted) {
          setMessage("Izin lokasi belum diberikan. BLE tetap berjalan tanpa mengirim koordinat.");
          return;
        }
        status = await proximityBle.getLocationStatus();
        setLocationStatus(status);
      }
      if (!status.gpsEnabled) {
        setMessage("Aktifkan Layanan Lokasi Android, lalu tekan Aktifkan GPS lagi.");
        return;
      }
      await proximityBle.enableLocation();
      setMessage("Permintaan lokasi GPS dikirim ke layanan foreground.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Lokasi GPS tidak dapat diaktifkan.");
    }
  };

  const stopScanning = async () => {
    await proximityBle.stop();
    setScanning(false);
    latestRef.current = { detected: false, rssi: null, at: Date.now() };
    setMessage("Pemindaian dihentikan.");
  };

  const ageSeconds = lastSeenAt === null ? null : Math.floor((Date.now() - lastSeenAt) / 1000);
  const signalStrength = lastResult ? Math.max(0, Math.min(100, Math.round((lastResult.rssi + 100) * 2))) : 0;
  const isDetected = scanning && lastSeenAt !== null && Date.now() - lastSeenAt < 8000;

  if (locked) {
    return (
      <main className="tracker-lock-screen">
        <div className="tracker-lock-icon"><LockKeyhole size={34} /></div>
        <span className="tracker-eyebrow"><i /> PERANGKAT DIKUNCI MASTER</span>
        <h1>Silakan kembali ke posisi Anda, bosku.</h1>
        <p>Mode kiosk Android aktif. Akses aplikasi dan tombol Home dibatasi sampai SMB Master mengirim buka kunci.</p>
        <div className="tracker-lock-status"><span className="tracker-status-pulse" /> BLE latar {scanning ? "aktif" : "tidak aktif"} · broker {broker.connected ? "terhubung" : "menyambung"}</div>
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
          <small>PEMANTAUAN BLE</small>
        </div>
        <span className="tracker-device-pill">PELACAK</span>
      </header>

      <section className="tracker-intro">
        <div className="tracker-eyebrow"><span /> PANTAUAN LANGSUNG</div>
        <h1>Perangkat master</h1>
        <p>SMB Lacak memakai GPS perangkat dan BLE untuk mengirim lokasi nyata ke broker lokal saat layanan pemantauan aktif.</p>
      </section>

      <section className={`tracker-signal-card ${isDetected ? "signal-detected" : ""}`}>
        <div className="tracker-signal-top">
          <div className="tracker-signal-icon"><Bluetooth size={22} /></div>
          <span className={`tracker-state ${isDetected ? "state-online" : ""}`}>
            <i /> {isDetected ? "TERDETEKSI" : scanning ? "MENCARI" : "BERHENTI"}
          </span>
        </div>
        <div className="tracker-master-id">R9RY506354P</div>
        <div className="tracker-master-caption">Beacon master yang dipasangkan</div>
        <div className="tracker-signal-meter" aria-label={`Kekuatan sinyal ${signalStrength}%`}>
          {Array.from({ length: 5 }, (_, index) => (
            <i key={index} className={signalStrength > index * 20 ? "meter-active" : ""} />
          ))}
          <strong>{lastResult ? `${lastResult.rssi} dBm` : "— dBm"}</strong>
        </div>
        <div className="tracker-last-seen">
          <span><Signal size={14} /> {lastResult ? "Sinyal BLE diterima" : "Belum ada sinyal"}</span>
          <span>{ageSeconds !== null && isDetected ? "Baru saja" : "—"}</span>
        </div>
      </section>

      <div className="tracker-status-line">
        <span className={scanning ? "tracker-status-pulse" : "tracker-status-idle"} />
        <span>{message} Broker WSS: <strong>{broker.connected ? "terhubung" : "menyambung…"}</strong></span>
      </div>

      <div className="tracker-permission-note">
        <ShieldCheck size={17} />
        <span>Lokasi dikirim ke server PC melalui TLS hanya saat izin Android diberikan. Notifikasi foreground selalu terlihat ketika pemantauan berjalan.</span>
      </div>

      <section className="tracker-location-card">
        <div className="tracker-location-heading"><MapPin size={17} /><strong>Lokasi perangkat aktual</strong><span className={lastLocation ? "location-live" : "location-waiting"}>{lastLocation ? "TERKIRIM" : "MENUNGGU GPS"}</span></div>
        {lastLocation ? <div className="tracker-location-values"><strong>{lastLocation.latitude.toFixed(6)}, {lastLocation.longitude.toFixed(6)}</strong><small>Akurasi ±{lastLocation.accuracyMeters == null ? "—" : `${Math.round(lastLocation.accuracyMeters)} m`} · {lastLocation.provider.toUpperCase()} · {new Date(lastLocation.capturedAt).toLocaleTimeString()}</small></div> : <p>{locationStatus.granted ? locationStatus.gpsEnabled ? "Menunggu perbaikan lokasi pertama dari Android." : "Aktifkan Layanan Lokasi/GPS Android untuk mendapat koordinat." : "Izin lokasi belum diberikan. Tekan Mulai pantau GPS + BLE untuk meminta izin."}</p>}
      </section>

      {scanning && locationStatus.granted && !locationStatus.backgroundGranted && (
        <button className="tracker-background-location-button" onClick={() => void enableBackgroundLocation()}>
          Izinkan lokasi sepanjang waktu untuk pemulihan setelah restart
        </button>
      )}
      {scanning && !locationActive && (
        <button className="tracker-background-location-button" onClick={() => void enableGpsNow()}>
          Aktifkan GPS sekarang
        </button>
      )}

      <div className="tracker-actions">
        {!scanning ? (
          <button className="tracker-primary-button" onClick={() => void startScanning()}>
            <Bluetooth size={17} /> Mulai pantau GPS + BLE
          </button>
        ) : (
          <button className="tracker-stop-button" onClick={() => void stopScanning()}>
            <X size={17} /> Hentikan pemantauan
          </button>
        )}
      </div>

      <div className="tracker-warning">
        <AlertTriangle size={16} />
        <span>RSSI hanya menunjukkan kedekatan perkiraan, bukan jarak meter akurat. {deviceOwner ? "Device Owner terdaftar; kiosk dapat diuji." : "Lock Android perlu Device Owner."}</span>
      </div>
      <footer className="tracker-footer">{policyNotice} · {locationStatus.backgroundGranted ? "Izin lokasi sepanjang waktu aktif." : "Izin lokasi latar belum aktif; setelah restart buka aplikasi untuk melanjutkan GPS."}</footer>
    </main>
  );
}
