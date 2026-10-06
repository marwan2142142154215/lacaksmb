import { registerPlugin } from "@capacitor/core";

export type BleScanResult = {
  beaconId: string;
  rssi: number;
  timestampMs: number;
};

export type DeviceLocation = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  provider: string;
  capturedAt: string;
};

export type LocationPermissionStatus = {
  granted: boolean;
  precise: boolean;
  backgroundGranted: boolean;
  gpsEnabled: boolean;
};

type ProximityBlePlugin = {
  requestAccess(): Promise<{ granted: boolean; serviceNotification: boolean }>;
  requestLocationAccess(): Promise<{ granted: boolean; precise: boolean }>;
  requestBackgroundLocation(): Promise<{ granted: boolean }>;
  getLocationStatus(): Promise<LocationPermissionStatus>;
  startAdvertising(options?: { brokerUrl?: string; deviceId?: string }): Promise<{ active: boolean; beaconId: string; background: boolean }>;
  startScan(options?: { brokerUrl?: string; token?: string; deviceId?: string; masterId?: string }): Promise<{ active: boolean; background: boolean }>;
  stop(): Promise<{ active: boolean }>;
  isScanning(): Promise<{ active: boolean; locationActive: boolean }>;
  enableLocation(): Promise<{ accepted: boolean }>;
  addListener(eventName: "locationResult", listener: (event: DeviceLocation) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "scanResult",
    listener: (event: BleScanResult) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "scanError",
    listener: (event: { errorCode: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "serviceState",
    listener: (event: { running: boolean; detail: string; locationActive: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
};

export const proximityBle = registerPlugin<ProximityBlePlugin>("ProximityBle");

export type DevicePolicyStatus = {
  deviceOwner: boolean;
  lockTaskMode: number;
  lockTaskPermitted: boolean;
};

type DevicePolicyPlugin = {
  getStatus(): Promise<DevicePolicyStatus>;
  lock(): Promise<{ locked: boolean }>;
  unlock(): Promise<{ locked: boolean }>;
};

export const devicePolicy = registerPlugin<DevicePolicyPlugin>("DevicePolicy");

const trackerBuildToken = import.meta.env.MODE === "tracker" ? import.meta.env.VITE_DEVICE_TOKEN || "" : "";

export const brokerConfig = {
  url: import.meta.env.VITE_BROKER_URL || "wss://broker.lacaksmbbot.com/ws",
  token: trackerBuildToken,
};

// The tracker build may include its own device credential. Master builds and
// the web dashboard authenticate with short-lived runtime admin sessions.
const ADMIN_TOKEN_KEY = "smb.admin.token";
const ADMIN_USER_KEY = "smb.admin.user";
const ADMIN_TOKEN_EVENT = "smb:admin-token";

export type AdminIdentity = { id: number; username: string; role: "superadmin" | "staff" };

export function readAdminToken(): string {
  if (typeof window === "undefined") return "";
  try { return window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || ""; } catch { return ""; }
}

export function readAdminIdentity(): AdminIdentity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ADMIN_USER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as AdminIdentity;
    return Number.isInteger(value.id) && typeof value.username === "string" && ["superadmin", "staff"].includes(value.role)
      ? value
      : null;
  } catch { return null; }
}

function writeAdminToken(value: string) {
  if (typeof window === "undefined") return;
  const trimmed = value.trim();
  try {
    if (trimmed) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, trimmed);
    else window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Private-mode browsers can refuse sessionStorage; the gate then simply
    // stays closed and the operator retries in a normal window.
  }
  window.dispatchEvent(new Event(ADMIN_TOKEN_EVENT));
}

export function saveAdminSession(token: string, user: AdminIdentity) {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(ADMIN_USER_KEY, JSON.stringify(user)); } catch { /* The login gate will retry if storage is unavailable. */ }
  writeAdminToken(token);
}

export function clearAdminToken() {
  if (typeof window !== "undefined") {
    try { window.sessionStorage.removeItem(ADMIN_USER_KEY); } catch { /* Continue to clear the token. */ }
  }
  writeAdminToken("");
}
