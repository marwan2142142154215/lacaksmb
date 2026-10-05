package id.nusarental.fleetconsole;

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
import android.os.Build;
import android.os.BatteryManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelUuid;
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
    public static final String ACTION_START = "id.nusarental.fleetconsole.action.START_PROXIMITY";
    public static final String ACTION_STOP = "id.nusarental.fleetconsole.action.STOP_PROXIMITY";
    public static final String ACTION_ENABLE_LOCATION = "id.nusarental.fleetconsole.action.ENABLE_LOCATION";
    public static final String ACTION_RESULT = "id.nusarental.fleetconsole.action.SCAN_RESULT";
    public static final String ACTION_ERROR = "id.nusarental.fleetconsole.action.SCAN_ERROR";
    public static final String ACTION_STATE = "id.nusarental.fleetconsole.action.SCAN_STATE";
    public static final String ACTION_LOCATION = "id.nusarental.fleetconsole.action.LOCATION_RESULT";
    public static final String EXTRA_BROKER_URL = "brokerUrl";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_DEVICE_ID = "deviceId";
    public static final String EXTRA_MASTER_ID = "masterId";
    public static final String EXTRA_MODE = "mode";
    public static final String EXTRA_LOCATION_ENABLED = "locationEnabled";

    private static final String TAG = "SMBProximityService";
    private static final String CHANNEL_ID = "smb_proximity_monitor";
    private static final int NOTIFICATION_ID = 851;
    private static final ParcelUuid MASTER_BEACON_UUID = ParcelUuid.fromString("5e2c7f85-c146-4976-9120-2ad0bafe0011");
    private static final long LOCATION_INTERVAL_MS = 15_000L;
    private static final float LOCATION_DISTANCE_M = 10f;
    private static volatile boolean active;
    private static volatile boolean locationActive;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService networkQueue = Executors.newSingleThreadExecutor();
    private BluetoothLeScanner scanner;
    private BluetoothLeAdvertiser advertiser;
    private LocationManager locationManager;
    private LocationListener locationListener;
    private Location latestLocation;
    private ScanCallback scanCallback;
    private AdvertiseCallback advertiseCallback;
    private String brokerUrl = "";
    private String token = "";
    private String deviceId = "";
    private String masterId = "";
    private String mode = "scan";
    private boolean locationEnabled = true;
    private int lastRssi = 0;
    private long lastSeenAt = 0;

    private final Runnable heartbeat = new Runnable() {
        @Override public void run() {
            if (!active) return;
            boolean detected = mode.equals("scan") && lastSeenAt > 0 && System.currentTimeMillis() - lastSeenAt < 8000;
            if (mode.equals("scan")) postTelemetry(detected, detected ? lastRssi : null);
            handler.postDelayed(this, 3000);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_ENABLE_LOCATION.equals(intent.getAction())) {
            if (active && "scan".equals(mode) && hasLocationPermission()) {
                locationEnabled = true;
                getSharedPreferences("smb_proximity", MODE_PRIVATE).edit().putBoolean(EXTRA_LOCATION_ENABLED, true).apply();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE | ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
                }
                locationActive = startLocationUpdates();
                postState(true, locationActive ? "BLE dan lokasi GPS aktif" : "GPS menunggu penyedia lokasi");
                ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, buildNotification());
            }
            return START_STICKY;
        }
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopMonitoring();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        SharedPreferences preferences = getSharedPreferences("smb_proximity", MODE_PRIVATE);
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            brokerUrl = stringExtra(intent, EXTRA_BROKER_URL, "");
            token = stringExtra(intent, EXTRA_TOKEN, "");
            deviceId = stringExtra(intent, EXTRA_DEVICE_ID, "");
            masterId = stringExtra(intent, EXTRA_MASTER_ID, "R9RY506354P");
            mode = stringExtra(intent, EXTRA_MODE, "scan");
            locationEnabled = intent.getBooleanExtra(EXTRA_LOCATION_ENABLED, true);
            preferences.edit().putString(EXTRA_BROKER_URL, brokerUrl).putString(EXTRA_TOKEN, token)
                .putString(EXTRA_DEVICE_ID, deviceId).putString(EXTRA_MASTER_ID, masterId)
                .putString(EXTRA_MODE, mode).putBoolean(EXTRA_LOCATION_ENABLED, locationEnabled).putBoolean("requested", true).apply();
        } else if (intent == null) {
            brokerUrl = preferences.getString(EXTRA_BROKER_URL, "");
            token = preferences.getString(EXTRA_TOKEN, "");
            deviceId = preferences.getString(EXTRA_DEVICE_ID, "");
            masterId = preferences.getString(EXTRA_MASTER_ID, "R9RY506354P");
            mode = preferences.getString(EXTRA_MODE, "scan");
            locationEnabled = preferences.getBoolean(EXTRA_LOCATION_ENABLED, true);
            if (!preferences.getBoolean("requested", false)) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        if (!"scan".equals(mode) && !"beacon".equals(mode)) mode = "scan";
        int serviceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        if (!"beacon".equals(mode) && locationEnabled && hasLocationPermission()) serviceType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, buildNotification(), serviceType);
        else startForeground(NOTIFICATION_ID, buildNotification());
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
            postState(true, "beacon".equals(mode) ? "BLE beacon aktif" : locationStarted ? "BLE dan lokasi GPS aktif" : "BLE aktif; lokasi menunggu izin atau penyedia lokasi");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, buildNotification());
        }
        return START_STICKY;
    }

    private boolean startScanning() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) return false;
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null || !adapter.isEnabled()) return false;
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return false;
        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(MASTER_BEACON_UUID).build();
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).setReportDelay(0).build();
        scanCallback = new ScanCallback() {
            @Override public void onScanResult(int callbackType, ScanResult result) {
                lastRssi = result.getRssi();
                lastSeenAt = System.currentTimeMillis();
                Intent event = new Intent(ACTION_RESULT).setPackage(getPackageName());
                event.putExtra("beaconId", masterId).putExtra("rssi", lastRssi).putExtra("timestampMs", lastSeenAt);
                sendBroadcast(event);
            }
            @Override public void onScanFailed(int errorCode) {
                Intent event = new Intent(ACTION_ERROR).setPackage(getPackageName()).putExtra("errorCode", errorCode);
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

    private boolean startLocationUpdates() {
        if (!hasLocationPermission()) { locationActive = false; return false; }
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (locationManager == null) { locationActive = false; return false; }
        locationListener = new LocationListener() {
            @Override public void onLocationChanged(Location location) {
                latestLocation = location;
                Intent event = new Intent(ACTION_LOCATION).setPackage(getPackageName());
                event.putExtra("latitude", location.getLatitude());
                event.putExtra("longitude", location.getLongitude());
                event.putExtra("accuracyMeters", location.hasAccuracy() ? location.getAccuracy() : -1f);
                event.putExtra("provider", location.getProvider() == null ? "unknown" : location.getProvider());
                event.putExtra("capturedAt", isoTime(location.getTime()));
                sendBroadcast(event);
            }
            @Override public void onProviderEnabled(String provider) { postState(true, "Penyedia lokasi aktif: " + provider); }
            @Override public void onProviderDisabled(String provider) { postState(true, "Penyedia lokasi nonaktif: " + provider); }
        };
        boolean requested = false;
        try {
            for (String provider : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                if (LocationManager.GPS_PROVIDER.equals(provider)
                    && checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) continue;
                if (locationManager.isProviderEnabled(provider)) {
                    locationManager.requestLocationUpdates(provider, LOCATION_INTERVAL_MS, LOCATION_DISTANCE_M, locationListener, handler.getLooper());
                    requested = true;
                }
            }
        } catch (SecurityException error) {
            Log.w(TAG, "Location permission was revoked", error);
        } catch (IllegalArgumentException error) {
            Log.w(TAG, "A location provider is unavailable", error);
        }
        locationActive = requested;
        return requested;
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private String isoTime(long timestamp) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(timestamp));
    }

    private boolean startAdvertising() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && checkSelfPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) return false;
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null || !adapter.isEnabled()) return false;
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) return false;
        AdvertiseSettings settings = new AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH).setConnectable(false).setTimeout(0).build();
        AdvertiseData data = new AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(MASTER_BEACON_UUID).build();
        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartFailure(int errorCode) { postState(false, "BLE advertising failed: " + errorCode); }
        };
        try {
            advertiser.startAdvertising(settings, data, advertiseCallback);
            return true;
        } catch (SecurityException error) {
            Log.e(TAG, "BLE advertise permission denied", error);
            return false;
        }
    }

    private BluetoothAdapter getAdapter() {
        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private String stringExtra(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null ? fallback : value;
    }

    public static boolean isActive() { return active; }
    public static boolean isLocationActive() { return locationActive; }

    private void postTelemetry(boolean detected, Integer rssi) {
        if (brokerUrl.isEmpty() || token.isEmpty() || deviceId.isEmpty()) return;
        networkQueue.execute(() -> {
            HttpURLConnection connection = null;
            try {
                String endpoint = brokerUrl.trim().replaceFirst("(?i)^wss:", "https:")
                    .replaceFirst("/ws(?:\\?.*)?$", "/api/telemetry");
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
                android.app.admin.DevicePolicyManager policy = (android.app.admin.DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
                body.put("deviceOwner", policy != null && policy.isDeviceOwnerApp(getPackageName()));
                android.app.ActivityManager activityManager = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
                body.put("lockTaskMode", activityManager == null ? 0 : activityManager.getLockTaskModeState());
                BatteryManager batteryManager = (BatteryManager) getSystemService(BATTERY_SERVICE);
                int batteryLevel = batteryManager == null ? -1 : batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                body.put("batteryLevel", batteryLevel >= 0 && batteryLevel <= 100 ? batteryLevel : JSONObject.NULL);
                Location location = latestLocation;
                if (location != null) {
                    body.put("latitude", location.getLatitude());
                    body.put("longitude", location.getLongitude());
                    body.put("accuracyMeters", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
                    body.put("locationAt", isoTime(location.getTime()));
                    body.put("locationProvider", location.getProvider() == null ? "unknown" : location.getProvider());
                }
                try (OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) Log.w(TAG, "Telemetry upload failed: HTTP " + status);
            } catch (Exception error) {
                Log.w(TAG, "Telemetry upload error: " + error.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPending = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, ProximityForegroundService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(this, 2, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = "beacon".equals(mode) ? "SMB Master · beacon aktif" : "SMB Lacak · pemantauan aktif";
        String text = "beacon".equals(mode) ? "Beacon BLE master aktif · ketuk untuk membuka aplikasi"
            : locationActive ? "Lokasi GPS dan pemindaian BLE dikirim ke broker · ketuk untuk membuka aplikasi"
            : "Pemindaian BLE aktif; izin lokasi belum diberikan · ketuk untuk membuka aplikasi";
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        return builder.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(text)
            .setContentIntent(openPending).setOngoing(true).addAction(0, "Hentikan", stopPending).build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Pemantauan BLE SMB", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Menampilkan pemantauan BLE dan berbagi lokasi perangkat saat izin lokasi diberikan.");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
        }
    }

    private void postState(boolean running, String detail) {
        Intent state = new Intent(ACTION_STATE).setPackage(getPackageName()).putExtra("running", running).putExtra("detail", detail).putExtra("locationActive", locationActive);
        sendBroadcast(state);
    }

    private void stopMonitoring() {
        active = false;
        locationActive = false;
        handler.removeCallbacks(heartbeat);
        try { if (scanner != null && scanCallback != null) scanner.stopScan(scanCallback); } catch (SecurityException ignored) { }
        try { if (advertiser != null && advertiseCallback != null) advertiser.stopAdvertising(advertiseCallback); } catch (SecurityException ignored) { }
        try { if (locationManager != null && locationListener != null) locationManager.removeUpdates(locationListener); } catch (SecurityException ignored) { }
        scanner = null; scanCallback = null; advertiser = null; advertiseCallback = null;
        locationManager = null; locationListener = null; latestLocation = null;
        getSharedPreferences("smb_proximity", MODE_PRIVATE).edit().putBoolean("requested", false).apply();
        postState(false, "stopped");
    }

    @Override public void onDestroy() {
        stopMonitoring();
        networkQueue.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
