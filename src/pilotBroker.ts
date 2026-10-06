import { useCallback, useEffect, useRef, useState } from "react";

const PUBLIC_BROKER_URL = import.meta.env.VITE_BROKER_URL || "wss://broker.lacaksmbbot.com/ws";

/** Kunci penyimpanan enrolmen HP tracker (diisi halaman enrolmen). */
export const TRACKER_AUTH_KEY = "smb.tracker.auth";
export const TRACKER_AUTH_EVENT = "smb:tracker-auth";

export type TrackerAuth = {
  deviceId: string;
  token: string;
  brokerUrl?: string;
  lanBrokerUrl?: string;
  site?: { id: number; name: string } | null;
};

export function readTrackerAuth(): TrackerAuth | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TRACKER_AUTH_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as TrackerAuth;
    if (typeof value.deviceId !== "string" || typeof value.token !== "string" || !value.deviceId || !value.token) return null;
    return value;
  } catch { return null; }
}

export function saveTrackerAuth(auth: TrackerAuth) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRACKER_AUTH_KEY, JSON.stringify(auth));
  window.dispatchEvent(new Event(TRACKER_AUTH_EVENT));
}

export function clearTrackerAuth() {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(TRACKER_AUTH_KEY); } catch { /* Storage bisa ditolak mode privat. */ }
  window.dispatchEvent(new Event(TRACKER_AUTH_EVENT));
}

export type PilotTelemetry = {
  deviceId: string;
  masterId: string;
  detected: boolean;
  rssi: number | null;
  receivedAt: string | null;
  online: boolean;
  deviceOwner?: boolean;
  lockTaskMode?: number;
  batteryLevel?: number | null;
  wifiSsid?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  locationAt?: string | null;
  locationProvider?: string | null;
};

export type BrokerCommand = {
  type: "command";
  commandId: string;
  targetId: string;
  command: "lock" | "unlock" | "uninstall" | "photo" | "photo_front";
};
type BrokerCommandResult = { ok: boolean; detail?: string; lockTaskMode?: number };

export type SiteViolation = {
  type: "siteViolation";
  deviceId: string;
  deviceName: string;
  siteId: number;
  siteName: string;
  wifiSsid: string;
  allowedNetworks: string[];
  at: string;
};

type BrokerRole = "master" | "tracker";
type BrokerPacket = Record<string, unknown> & { type?: string };
const trackerBuildToken = import.meta.env.MODE === "tracker" ? import.meta.env.VITE_DEVICE_TOKEN || "" : "";

/** URL broker yang dicoba berurutan: LAN dulu bila tersedia (HP tanpa internet), lalu publik. */
export function brokerCandidates(lanBrokerUrl?: string | null): string[] {
  const list: string[] = [];
  if (lanBrokerUrl && lanBrokerUrl.startsWith("wss://")) list.push(lanBrokerUrl);
  list.push(PUBLIC_BROKER_URL);
  return [...new Set(list)];
}

export function usePilotBroker(
  role: BrokerRole,
  deviceId: string,
  onCommand?: (command: BrokerCommand) => Promise<BrokerCommandResult>,
  tokenOverride?: string,
  lanBrokerUrl?: string | null,
) {
  const socket = useRef<WebSocket | null>(null);
  const retryTimer = useRef<number | undefined>(undefined);
  const commandHandler = useRef(onCommand);
  const [connected, setConnected] = useState(false);
  const [brokerUrl, setBrokerUrl] = useState(PUBLIC_BROKER_URL);
  const [telemetry, setTelemetry] = useState<PilotTelemetry | null>(null);
  const [telemetryById, setTelemetryById] = useState<Record<string, PilotTelemetry>>({});
  const [devices, setDevices] = useState<Array<{ deviceId: string; name: string; role?: string; online: boolean; lastSeenAt?: string | null; siteId?: number | null; siteName?: string | null; wifiSsid?: string | null; uninstallBlocked?: boolean; telemetry?: PilotTelemetry | null }>>([]);
  const [commandUpdates, setCommandUpdates] = useState<BrokerPacket[]>([]);
  const [violations, setViolations] = useState<SiteViolation[]>([]);
  const [uninstallBlocked, setUninstallBlocked] = useState<boolean | null>(null);
  // Dinaikkan setiap enrolmen selesai supaya koneksi dibuka ulang dengan token baru.
  const [authGeneration, setAuthGeneration] = useState(0);

  commandHandler.current = onCommand;

  useEffect(() => {
    let disposed = false;
    // Master build memakai sesi admin pendek; build tracker memakai token enrolmen
    // yang disimpan di localStorage (fallback ke token env untuk build lama).
    const stored = role === "tracker" ? readTrackerAuth() : null;
    const token = tokenOverride || stored?.token || (role === "tracker" ? trackerBuildToken : "");
    const resolvedDeviceId = role === "tracker" && stored?.deviceId ? stored.deviceId : deviceId;
    if (!token || !resolvedDeviceId) {
      setConnected(false);
      return;
    }

    const candidates = brokerCandidates(lanBrokerUrl ?? stored?.lanBrokerUrl ?? null);
    let candidateIndex = 0;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      const target = candidates[candidateIndex % candidates.length];
      const url = new URL(target);
      url.searchParams.set("deviceId", resolvedDeviceId);
      url.searchParams.set("token", token);
      setBrokerUrl(target);
      const current = new WebSocket(url);
      socket.current = current;
      current.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setConnected(true);
      };
      current.onmessage = (event) => {
        if (disposed) return;
        try {
          const packet = JSON.parse(String(event.data)) as BrokerPacket;
          if (packet.type === "telemetry") {
            const sample = packet as unknown as PilotTelemetry;
            setTelemetry(sample);
            if (sample.deviceId) setTelemetryById((all) => ({ ...all, [sample.deviceId]: sample }));
          }
          if (packet.type === "devices" && Array.isArray(packet.devices)) setDevices(packet.devices as typeof devices);
          if (packet.type === "siteViolation") {
            const violation = packet as unknown as SiteViolation;
            setViolations((all) => [violation, ...all].slice(0, 20));
          }
          if (packet.type === "uninstallBlocked") setUninstallBlocked(packet.blocked === true);
          if (packet.type === "command" && role === "tracker") {
            const command = packet as unknown as BrokerCommand;
            void commandHandler.current?.(command).then((result) => {
              if (current.readyState === WebSocket.OPEN) {
                current.send(JSON.stringify({ type: "commandAck", commandId: command.commandId, ...result }));
              }
            }).catch((error: unknown) => {
              if (current.readyState === WebSocket.OPEN) {
                current.send(JSON.stringify({ type: "commandAck", commandId: command.commandId, ok: false, detail: error instanceof Error ? error.message : "Command failed." }));
              }
            });
          }
          if (packet.type === "commandQueued" || packet.type === "commandUpdate" || packet.type === "commandResult") {
            setCommandUpdates((currentUpdates) => [packet, ...currentUpdates].slice(0, 20));
          }
        } catch {
          // Ignore malformed broker packets.
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (disposed) return;
        setConnected(false);
        attempt += 1;
        // Coba URL berikutnya bila kandidat sebelumnya gagal beruntun.
        if (attempt >= 3 && candidates.length > 1) { candidateIndex += 1; attempt = 0; }
        retryTimer.current = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer.current !== undefined) window.clearTimeout(retryTimer.current);
      socket.current?.close();
      socket.current = null;
    };
  }, [deviceId, role, tokenOverride, lanBrokerUrl, authGeneration]);

  // Enrolmen selesai → buka ulang koneksi dengan token & deviceId baru.
  useEffect(() => {
    if (role !== "tracker") return;
    const resync = () => setAuthGeneration((value) => value + 1);
    window.addEventListener(TRACKER_AUTH_EVENT, resync);
    return () => window.removeEventListener(TRACKER_AUTH_EVENT, resync);
  }, [role]);

  const send = useCallback((message: Record<string, unknown>) => {
    const current = socket.current;
    if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify(message));
  }, []);

  return { connected, brokerUrl, telemetry, telemetryById, devices, commandUpdates, violations, uninstallBlocked, send };
}
