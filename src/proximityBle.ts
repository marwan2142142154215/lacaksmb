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
  url: import.meta.env.VITE_BROKER_URL || "wss://192.168.100.118:8787/ws",
  token: import.meta.env.VITE_DEVICE_TOKEN || "",
};
