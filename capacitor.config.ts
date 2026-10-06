import type { CapacitorConfig } from '@capacitor/cli';

const mode = process.env.VITE_BUILD_MODE ?? "";
const isTracker = mode === "tracker";

const config: CapacitorConfig = {
  appId: isTracker ? "com.smbbotlacak.tracker" : "com.smbbotlacak.master",
  appName: isTracker ? "SMB Lacak" : "SMB Master",
  webDir: "dist",
};

export default config;
