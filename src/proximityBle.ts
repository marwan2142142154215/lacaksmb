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

export const brokerConfig = {
  url: import.meta.env.VITE_BROKER_URL || "wss://broker.lacaksmbbot.com/ws",
  token: import.meta.env.VITE_DEVICE_TOKEN || "",
};

// VITE_DEVICE_TOKEN compiles into the JS bundle, which is fine for the APK
// builds (an APK is not a public web asset) but must never be used for the
// web dashboard: anyone loading the page could read the master token from
// devtools. The dashboard therefore takes its token at runtime from
// sessionStorage, so it leaves no trace in the bundle or source maps.
const ADMIN_TOKEN_KEY = "smb.admin.token";
const ADMIN_TOKEN_EVENT = "smb:admin-token";

export function readAdminToken(): string {
  if (typeof window === "undefined") return "";
  try { return window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || ""; } catch { return ""; }
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

export function saveAdminToken(value: string) {
  writeAdminToken(value);
}

export function clearAdminToken() {
  writeAdminToken("");
}
