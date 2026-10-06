package com.smbbotlacak.tracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelUuid;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ProximityForegroundService extends Service {
    public static final String ACTION_START            = "com.smbbotlacak.tracker.action.START_PROXIMITY";
    public static final String ACTION_STOP             = "com.smbbotlacak.tracker.action.STOP_PROXIMITY";
    public static final String ACTION_ENABLE_LOCATION  = "com.smbbotlacak.tracker.action.ENABLE_LOCATION";
    public static final String ACTION_RESULT           = "com.smbbotlacak.tracker.action.SCAN_RESULT";
    public static final String ACTION_ERROR            = "com.smbbotlacak.tracker.action.SCAN_ERROR";
    public static final String ACTION_STATE            = "com.smbbotlacak.tracker.action.SCAN_STATE";
    public static final String ACTION_LOCATION         = "com.smbbotlacak.tracker.action.LOCATION_RESULT";
    public static final String EXTRA_BROKER_URL        = "brokerUrl";
    public static final String EXTRA_LAN_BROKER_URL    = "lanBrokerUrl";
    public static final String EXTRA_TOKEN             = "token";
    public static final String EXTRA_DEVICE_ID         = "deviceId";
    public static final String EXTRA_MASTER_ID         = "masterId";
    public static final String EXTRA_MODE              = "mode";
    public static final String EXTRA_LOCATION_ENABLED  = "locationEnabled";

    // ── Telegram keys (disimpan di SharedPreferences) ──────────────────────────
    public static final String EXTRA_TG_BOT_TOKEN = "tgBotToken";
    public static final String EXTRA_TG_CHAT_ID   = "tgChatId";
    // Interval kamera dalam menit (0 = nonaktif)
    public static final String EXTRA_CAMERA_INTERVAL_MIN = "cameraIntervalMin";

    private static final String TAG          = "SMBProximityService";
    private static final String CHANNEL_ID   = "smb_proximity_monitor";
    private static final int    NOTIFICATION_ID = 851;

    private static final ParcelUuid MASTER_BEACON_UUID = ParcelUuid.fromString("5e2c7f85-c146-4976-9120-2ad0bafe0011");
    private static final long   LOCATION_INTERVAL_MS   = 15_000L;
    private static final float  LOCATION_DISTANCE_M    = 10f;

    private static volatile boolean active;
    private static volatile boolean locationActive;

    private final Handler         handler      = new Handler(Looper.getMainLooper());
    private final ExecutorService networkQueue = Executors.newSingleThreadExecutor();

    private BluetoothLeScanner  scanner;
    private BluetoothLeAdvertiser advertiser;
    private LocationManager     locationManager;
    private LocationListener    locationListener;
    private Location            latestLocation;
    private ScanCallback        scanCallback;
    private AdvertiseCallback   advertiseCallback;

    private String  brokerUrl          = "";
    private String  lanBrokerUrl       = "";
    private String  token              = "";
    private String  deviceId           = "";
    private String  masterId           = "";
    private String  mode               = "scan";
    private boolean locationEnabled    = true;
    private int     lastRssi           = 0;
    private long    lastSeenAt         = 0;

    // ── Heartbeat: kirim telemetri setiap 3 detik ───────────────────────────────
    private final Runnable heartbeat = new Runnable() {
        @Override public void run() {
            if (!active) return;
            boolean detected = mode.equals("scan") && lastSeenAt > 0
                    && System.currentTimeMillis() - lastSeenAt < 8000;
            if (mode.equals("scan")) postTelemetry(detected, detected ? lastRssi : null);

            handler.postDelayed(this, 3000);
        }
    };

    // ── Lifecycle ────────────────────────────────────────────────────────────────

    @Override public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_ENABLE_LOCATION.equals(intent.getAction())) {
            if (active && "scan".equals(mode) && hasLocationPermission()) {
                locationEnabled = true;
                getSharedPreferences("smb_proximity", MODE_PRIVATE).edit()
                        .putBoolean(EXTRA_LOCATION_ENABLED, true).apply();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIFICATION_ID, buildNotification(),
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                            | ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
                }
                locationActive = startLocationUpdates();
                postState(true, locationActive
                        ? "BLE dan lokasi GPS aktif"
                        : "GPS menunggu penyedia lokasi");
                ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                        .notify(NOTIFICATION_ID, buildNotification());
            }
            return START_STICKY;
        }

        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            if ("scan".equals(mode)) {
                // Tracker mode is permanent and cannot be stopped
                Log.d(TAG, "ACTION_STOP ignored: Tracker mode is permanent.");
                return START_STICKY;
            }
            stopMonitoring();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        SharedPreferences prefs = getSharedPreferences("smb_proximity", MODE_PRIVATE);
        prefs.edit().remove(EXTRA_TG_BOT_TOKEN).remove(EXTRA_TG_CHAT_ID).remove(EXTRA_CAMERA_INTERVAL_MIN).apply();
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            brokerUrl         = stringExtra(intent, EXTRA_BROKER_URL, "");
            lanBrokerUrl      = stringExtra(intent, EXTRA_LAN_BROKER_URL, "");
            token             = stringExtra(intent, EXTRA_TOKEN, "");
            deviceId          = stringExtra(intent, EXTRA_DEVICE_ID, "");
            masterId          = stringExtra(intent, EXTRA_MASTER_ID, "R9RY506354P");
            mode              = stringExtra(intent, EXTRA_MODE, "scan");
            locationEnabled   = intent.getBooleanExtra(EXTRA_LOCATION_ENABLED, true);

            prefs.edit()
                    .putString(EXTRA_BROKER_URL, brokerUrl)
                    .putString(EXTRA_LAN_BROKER_URL, lanBrokerUrl)
                    .putString(EXTRA_TOKEN, token)
                    .putString(EXTRA_DEVICE_ID, deviceId)
                    .putString(EXTRA_MASTER_ID, masterId)
                    .putString(EXTRA_MODE, mode)
                    .putBoolean(EXTRA_LOCATION_ENABLED, locationEnabled)
                    .putBoolean("requested", true)
                    .apply();

        } else if (intent == null) {
            // Restart oleh Android (START_STICKY) — pulihkan dari SharedPreferences
            brokerUrl         = prefs.getString(EXTRA_BROKER_URL, "");
            lanBrokerUrl      = prefs.getString(EXTRA_LAN_BROKER_URL, "");
            token             = prefs.getString(EXTRA_TOKEN, "");
            deviceId          = prefs.getString(EXTRA_DEVICE_ID, "");
            masterId          = prefs.getString(EXTRA_MASTER_ID, "R9RY506354P");
            mode              = prefs.getString(EXTRA_MODE, "scan");
            locationEnabled   = prefs.getBoolean(EXTRA_LOCATION_ENABLED, true);
            if (!prefs.getBoolean("requested", false)) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }

        if (!"scan".equals(mode) && !"beacon".equals(mode)) mode = "scan";

        int serviceType = 0;
        boolean hasBtPermission = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED;

        if (hasBtPermission) {
            serviceType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        }
        if (!"beacon".equals(mode) && locationEnabled && hasLocationPermission()) {
            serviceType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && serviceType != 0) {
                startForeground(NOTIFICATION_ID, buildNotification(), serviceType);
            } else {
                startForeground(NOTIFICATION_ID, buildNotification());
            }
        } catch (SecurityException e) {
            Log.e(TAG, "startForeground SecurityException, fallback to basic startForeground: " + e.getMessage());
            try {
                startForeground(NOTIFICATION_ID, buildNotification());
            } catch (Exception ignored) {}
        }

        if (!active) {
            active = true;
            boolean started = "beacon".equals(mode) ? startAdvertising() : startScanning();
            if (!started) {
                active = false;
                postState(false, "Bluetooth permission or radio unavailable");
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
                return START_NOT_STICKY;
            }
            boolean locationStarted = !"beacon".equals(mode) && locationEnabled && startLocationUpdates();
            locationActive = locationStarted;
            handler.removeCallbacks(heartbeat);
            handler.post(heartbeat);
            postState(true, "beacon".equals(mode)
                    ? "BLE beacon aktif"
                    : locationStarted ? "BLE dan lokasi GPS aktif"
                    : "BLE aktif; lokasi menunggu izin atau penyedia lokasi");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                    .notify(NOTIFICATION_ID, buildNotification());
        }
        return START_STICKY;
    }

    // ── Kamera: ambil foto dan kirim ke Telegram ─────────────────────────────────

    private boolean startScanning() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN)
                != PackageManager.PERMISSION_GRANTED) return false;
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null || !adapter.isEnabled()) return false;
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return false;
        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(MASTER_BEACON_UUID).build();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).setReportDelay(0).build();
        scanCallback = new ScanCallback() {
            @Override public void onScanResult(int callbackType, ScanResult result) {
                lastRssi    = result.getRssi();
                lastSeenAt  = System.currentTimeMillis();
                Intent event = new Intent(ACTION_RESULT).setPackage(getPackageName());
                event.putExtra("beaconId", masterId)
                     .putExtra("rssi", lastRssi)
                     .putExtra("timestampMs", lastSeenAt);
                sendBroadcast(event);
            }
            @Override public void onScanFailed(int errorCode) {
                Intent event = new Intent(ACTION_ERROR).setPackage(getPackageName())
                        .putExtra("errorCode", errorCode);
                sendBroadcast(event);
            }
        };
        try {
            scanner.startScan(Collections.singletonList(filter), settings, scanCallback);
            return true;
        } catch (SecurityException error) {
            Log.e(TAG, "BLE scan permission denied", error);
            return false;
        }
    }

    // ── GPS Location ─────────────────────────────────────────────────────────────

    private boolean startLocationUpdates() {
        if (!hasLocationPermission()) { locationActive = false; return false; }
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (locationManager == null) { locationActive = false; return false; }
        locationListener = new LocationListener() {
            @Override public void onLocationChanged(Location location) {
                latestLocation = location;
                Intent event = new Intent(ACTION_LOCATION).setPackage(getPackageName());
                event.putExtra("latitude",      location.getLatitude())
                     .putExtra("longitude",     location.getLongitude())
                     .putExtra("accuracyMeters", location.hasAccuracy() ? location.getAccuracy() : -1f)
                     .putExtra("provider",       location.getProvider() == null ? "unknown" : location.getProvider())
                     .putExtra("capturedAt",     isoTime(location.getTime()));
                sendBroadcast(event);
            }
            @Override public void onProviderEnabled(String provider) {
                postState(true, "Penyedia lokasi aktif: " + provider);
            }
            @Override public void onProviderDisabled(String provider) {
                postState(true, "Penyedia lokasi nonaktif: " + provider);
            }
        };
        boolean requested = false;
        try {
            for (String provider : new String[]{ LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                if (LocationManager.GPS_PROVIDER.equals(provider)
                        && checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                        != PackageManager.PERMISSION_GRANTED) continue;
                if (locationManager.isProviderEnabled(provider)) {
                    locationManager.requestLocationUpdates(provider, LOCATION_INTERVAL_MS,
                            LOCATION_DISTANCE_M, locationListener, handler.getLooper());
                    requested = true;
                }
            }
        } catch (SecurityException e) {
            Log.w(TAG, "Location permission was revoked", e);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "A location provider is unavailable", e);
        }
        locationActive = requested;
        return requested;
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    // ── BLE Advertising (mode master) ────────────────────────────────────────────

    private boolean startAdvertising() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && checkSelfPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE)
                != PackageManager.PERMISSION_GRANTED) return false;
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null || !adapter.isEnabled()) return false;
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) return false;
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(false).setTimeout(0).build();
        AdvertiseData data = new AdvertiseData.Builder()
                .setIncludeDeviceName(false).addServiceUuid(MASTER_BEACON_UUID).build();
        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartFailure(int errorCode) {
                postState(false, "BLE advertising failed: " + errorCode);
            }
        };
        try {
            advertiser.startAdvertising(settings, data, advertiseCallback);
            return true;
        } catch (SecurityException error) {
            Log.e(TAG, "BLE advertise permission denied", error);
            return false;
        }
    }

    // ── Telemetri ke broker ───────────────────────────────────────────────────────

    private void postTelemetry(boolean detected, Integer rssi) {
        if (brokerUrl.isEmpty() || token.isEmpty() || deviceId.isEmpty()) return;
        String wifiSsid = currentWifiSsid();
        // Urutan percobaan: broker utama (publik) dulu, lalu broker LAN agar
        // telemetri tetap terkirim saat HP tidak punya akses internet.
        String[] endpoints = telemetryEndpoints();
        networkQueue.execute(() -> {
            for (String endpoint : endpoints) {
                if (postTelemetryTo(endpoint, detected, rssi, wifiSsid)) return;
            }
        });
    }

    private String[] telemetryEndpoints() {
        java.util.List<String> endpoints = new java.util.ArrayList<>();
        String primary = telemetryUrl(brokerUrl);
        String lan = telemetryUrl(lanBrokerUrl);
        if (!primary.isEmpty()) endpoints.add(primary);
        if (!lan.isEmpty() && !lan.equals(primary)) endpoints.add(lan);
        return endpoints.toArray(new String[0]);
    }

    private String telemetryUrl(String url) {
        if (url == null || url.trim().isEmpty()) return "";
        return url.trim()
                .replaceFirst("(?i)^wss:", "https:")
                .replaceFirst("(?i)^ws:", "http:")
                .replaceFirst("/ws(?:\\?.*)?$", "/api/telemetry");
    }

    /** SSID WiFi aktif; null bila izin tidak cukup atau jaringan belum terhubung. */
    private String currentWifiSsid() {
        try {
            android.net.wifi.WifiManager wifi = (android.net.wifi.WifiManager)
                    getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return null;
            android.net.wifi.WifiInfo info = wifi.getConnectionInfo();
            if (info == null) return null;
            String ssid = info.getSSID();
            if (ssid == null) return null;
            ssid = ssid.replace("\"", "").trim();
            if (ssid.isEmpty() || "unknown ssid".equalsIgnoreCase(ssid)) return null;
            return ssid;
        } catch (RuntimeException error) {
            return null;
        }
    }

    private boolean postTelemetryTo(String endpoint, boolean detected, Integer rssi, String wifiSsid) {
        if (endpoint.isEmpty()) return false;
        HttpURLConnection connection = null;
        try {
            URL url = new URL(endpoint);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(3500);
            connection.setReadTimeout(3500);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId);
            body.put("masterId", masterId);
            body.put("detected", detected);
            body.put("rssi", detected ? rssi : JSONObject.NULL);
            body.put("wifiSsid", wifiSsid == null ? JSONObject.NULL : wifiSsid);
            android.app.admin.DevicePolicyManager policy =
                    (android.app.admin.DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
            body.put("deviceOwner", policy != null && policy.isDeviceOwnerApp(getPackageName()));
            android.app.ActivityManager activityManager =
                    (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            body.put("lockTaskMode", activityManager == null ? 0 : activityManager.getLockTaskModeState());
            BatteryManager batteryManager = (BatteryManager) getSystemService(BATTERY_SERVICE);
            int batteryLevel = batteryManager == null ? -1
                    : batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            body.put("batteryLevel", batteryLevel >= 0 && batteryLevel <= 100
                    ? batteryLevel : JSONObject.NULL);
            Location location = latestLocation;
            if (location != null) {
                body.put("latitude",        location.getLatitude());
                body.put("longitude",       location.getLongitude());
                body.put("accuracyMeters",  location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
                body.put("locationAt",      isoTime(location.getTime()));
                body.put("locationProvider", location.getProvider() == null ? "unknown" : location.getProvider());
            }
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                Log.w(TAG, "Telemetry upload failed: HTTP " + status);
                return false;
            }
            // Simpan URL broker LAN yang terbukti terjangkau untuk percobaan berikutnya.
            if (endpoint.equals(telemetryUrl(lanBrokerUrl)) && !lanBrokerUrl.isEmpty()) {
                getSharedPreferences("smb_proximity", MODE_PRIVATE).edit()
                        .putString(EXTRA_BROKER_URL, lanBrokerUrl)
                        .putString(EXTRA_LAN_BROKER_URL, brokerUrl)
                        .apply();
                String swap = brokerUrl; brokerUrl = lanBrokerUrl; lanBrokerUrl = swap;
            }
            return true;
        } catch (Exception error) {
            Log.w(TAG, "Telemetry upload error: " + error.getMessage());
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // ── Notifikasi ───────────────────────────────────────────────────────────────

    /**
     * Notifikasi foreground:
     * - Mode TRACKER → IMPORTANCE_MIN (tersembunyi dari status bar, tidak ada suara)
     * - Mode MASTER/BEACON → IMPORTANCE_LOW (terlihat tapi tidak bersuara)
     *
     * Dengan IMPORTANCE_MIN, notifikasi tidak muncul di status bar secara default —
     * hanya terlihat jika pengguna menarik notification shade dan menggulir ke bawah.
     */
    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPending = PendingIntent.getActivity(this, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, ProximityForegroundService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(this, 2, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        boolean isTracker = "scan".equals(mode);

        // Untuk mode tracker: label generik agar tidak mencolok
        String title = isTracker ? "Layanan sistem" : "SMB Master · beacon aktif";
        String text  = isTracker ? "Berjalan di latar belakang."
                : locationActive ? "Lokasi GPS dan pemindaian BLE dikirim ke broker"
                : "Pemindaian BLE aktif; izin lokasi belum diberikan";

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        builder.setSmallIcon(android.R.drawable.stat_notify_sync_noanim)  // icon tidak mencolok
               .setContentTitle(title)
               .setContentText(text)
               .setContentIntent(openPending)
               .setOngoing(true);

        // Hanya tampilkan tombol "Hentikan" untuk mode master (bukan tracker)
        if (!isTracker) {
            builder.addAction(0, "Hentikan", stopPending);
        }

        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Channel dengan IMPORTANCE_MIN = tersembunyi dari status bar
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Layanan sistem",                  // nama generik
                    NotificationManager.IMPORTANCE_MIN // <── tersembunyi!
            );
            channel.setDescription("Layanan latar belakang.");
            channel.setShowBadge(false);
            channel.enableLights(false);
            channel.enableVibration(false);
            channel.setSound(null, null);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                    .createNotificationChannel(channel);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────

    private String isoTime(long timestamp) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(timestamp));
    }

    private BluetoothAdapter getAdapter() {
        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private String stringExtra(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null ? fallback : value;
    }

    public static boolean isActive()         { return active; }
    public static boolean isLocationActive() { return locationActive; }

    private void postState(boolean running, String detail) {
        Intent state = new Intent(ACTION_STATE).setPackage(getPackageName())
                .putExtra("running",        running)
                .putExtra("detail",         detail)
                .putExtra("locationActive", locationActive);
        sendBroadcast(state);
    }

    private void stopMonitoring() {
        active         = false;
        locationActive = false;
        handler.removeCallbacks(heartbeat);
        try { if (scanner   != null && scanCallback   != null) scanner.stopScan(scanCallback); }   catch (SecurityException ignored) {}
        try { if (advertiser != null && advertiseCallback != null) advertiser.stopAdvertising(advertiseCallback); } catch (SecurityException ignored) {}
        try { if (locationManager != null && locationListener != null) locationManager.removeUpdates(locationListener); } catch (SecurityException ignored) {}
        scanner = null; scanCallback = null;
        advertiser = null; advertiseCallback = null;
        locationManager = null; locationListener = null; latestLocation = null;
        getSharedPreferences("smb_proximity", MODE_PRIVATE).edit()
                .putBoolean("requested", false).apply();
        postState(false, "stopped");
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        if ("scan".equals(mode)) {
            Intent restartIntent = new Intent(getApplicationContext(), ProximityForegroundService.class)
                    .setAction(ACTION_START);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    getApplicationContext().startForegroundService(restartIntent);
                } else {
                    getApplicationContext().startService(restartIntent);
                }
            } catch (Exception ignored) {}
        }
    }

    @Override public void onDestroy() {
        if ("scan".equals(mode)) {
            Intent restartIntent = new Intent(getApplicationContext(), ProximityForegroundService.class)
                    .setAction(ACTION_START);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    getApplicationContext().startForegroundService(restartIntent);
                } else {
                    getApplicationContext().startService(restartIntent);
                }
            } catch (Exception ignored) {}
        } else {
            stopMonitoring();
            networkQueue.shutdownNow();
            super.onDestroy();
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
