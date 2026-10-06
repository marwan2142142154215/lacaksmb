package com.smbbotlacak.tracker;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.location.LocationManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "ProximityBle",
    permissions = {
        @Permission(alias = "nearby", strings = {
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT
        }),
        @Permission(alias = "legacyLocation", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "backgroundLocation", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class ProximityBlePlugin extends Plugin {
    private BroadcastReceiver serviceReceiver;

    @Override
    public void load() {
        super.load();
        serviceReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (ProximityForegroundService.ACTION_RESULT.equals(action)) {
                    JSObject event = new JSObject();
                    event.put("beaconId", intent.getStringExtra("beaconId"));
                    event.put("rssi", intent.getIntExtra("rssi", -127));
                    event.put("timestampMs", intent.getLongExtra("timestampMs", System.currentTimeMillis()));
                    notifyListeners("scanResult", event);
                } else if (ProximityForegroundService.ACTION_ERROR.equals(action)) {
                    JSObject event = new JSObject();
                    event.put("errorCode", intent.getIntExtra("errorCode", -1));
                    notifyListeners("scanError", event);
                } else if (ProximityForegroundService.ACTION_STATE.equals(action)) {
                    JSObject event = new JSObject();
                    event.put("running", intent.getBooleanExtra("running", false));
                    event.put("detail", intent.getStringExtra("detail"));
                    notifyListeners("serviceState", event);
                } else if (ProximityForegroundService.ACTION_LOCATION.equals(action)) {
                    JSObject event = new JSObject();
                    event.put("latitude", intent.getDoubleExtra("latitude", 0));
                    event.put("longitude", intent.getDoubleExtra("longitude", 0));
                    event.put("accuracyMeters", intent.getFloatExtra("accuracyMeters", -1));
                    event.put("provider", intent.getStringExtra("provider"));
                    event.put("capturedAt", intent.getStringExtra("capturedAt"));
                    notifyListeners("locationResult", event);
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(ProximityForegroundService.ACTION_RESULT);
        filter.addAction(ProximityForegroundService.ACTION_ERROR);
        filter.addAction(ProximityForegroundService.ACTION_STATE);
        filter.addAction(ProximityForegroundService.ACTION_LOCATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(serviceReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(serviceReceiver, filter);
        }
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissionForAlias("nearby", call, "onAccessPermissionResult");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            requestPermissionForAlias("legacyLocation", call, "onAccessPermissionResult");
            return;
        }
        resolveAccess(call, true);
    }

    @PluginMethod
    public void requestLocationAccess(PluginCall call) {
        if (hasForegroundLocationPermission()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            result.put("precise", getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("location", call, "onLocationPermissionResult");
    }

    @PermissionCallback
    private void onLocationPermissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasForegroundLocationPermission());
        result.put("precise", getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void requestBackgroundLocation(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || hasBackgroundLocationPermission()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "onBackgroundLocationPermissionResult");
    }

    @PermissionCallback
    private void onBackgroundLocationPermissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasBackgroundLocationPermission());
        call.resolve(result);
    }

    @PluginMethod
    public void getLocationStatus(PluginCall call) {
        boolean gpsEnabled = false;
        try {
            LocationManager manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            gpsEnabled = manager != null && manager.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (RuntimeException ignored) { }
        JSObject result = new JSObject();
        result.put("granted", hasForegroundLocationPermission());
        result.put("precise", getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED);
        result.put("backgroundGranted", hasBackgroundLocationPermission());
        result.put("gpsEnabled", gpsEnabled);
        call.resolve(result);
    }

    private boolean hasForegroundLocationPermission() {
        return getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED
            || getContext().checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBackgroundLocationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || getContext().checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    @PermissionCallback
    private void onAccessPermissionResult(PluginCall call) {
        String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "nearby" : "legacyLocation";
        boolean granted = getPermissionState(alias) == PermissionState.GRANTED;
        if (granted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "onNotificationPermissionResult");
            return;
        }
        resolveAccess(call, granted);
    }

    @PermissionCallback
    private void onNotificationPermissionResult(PluginCall call) {
        String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "nearby" : "legacyLocation";
        resolveAccess(call, getPermissionState(alias) == PermissionState.GRANTED);
    }

    private void resolveAccess(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("serviceNotification", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        if (!hasBlePermission(true)) {
            call.reject("Izin perangkat sekitar belum diberikan.", "BLE_PERMISSION_REQUIRED");
            return;
        }
        startForegroundMode(call, "beacon", "R9RY506354P");
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        if (!hasBlePermission(false)) {
            call.reject("Izin perangkat sekitar belum diberikan.", "BLE_PERMISSION_REQUIRED");
            return;
        }
        // ID perangkat diambil dari hasil enrolmen; fallback ke ANDROID_ID.
        startForegroundMode(call, "scan", androidId());
    }

    @PluginMethod
    public void getDeviceId(PluginCall call) {
        JSObject result = new JSObject();
        result.put("deviceId", androidId());
        call.resolve(result);
    }

    private String androidId() {
        String value = android.provider.Settings.Secure.getString(
            getContext().getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
        return value == null || value.isEmpty() ? "pending-enrollment" : value;
    }

    private void startForegroundMode(PluginCall call, String mode, String fallbackId) {
        String brokerUrl         = call.getString("brokerUrl", "wss://broker.lacaksmbbot.com/ws");
        String lanBrokerUrl      = call.getString("lanBrokerUrl", "");
        String token             = call.getString("token", "");
        String deviceId          = call.getString("deviceId", fallbackId);
        String masterId          = call.getString("masterId", "R9RY506354P");

        if ("scan".equals(mode) && (token.isEmpty() || !brokerUrl.startsWith("wss://"))) {
            call.reject("Broker WSS dan token unik perangkat belum dikonfigurasi.", "BROKER_CONFIG_REQUIRED");
            return;
        }
        Intent intent = new Intent(getContext(), ProximityForegroundService.class);
        intent.setAction(ProximityForegroundService.ACTION_START);
        intent.putExtra(ProximityForegroundService.EXTRA_BROKER_URL, brokerUrl);
        intent.putExtra(ProximityForegroundService.EXTRA_LAN_BROKER_URL, lanBrokerUrl);
        intent.putExtra(ProximityForegroundService.EXTRA_TOKEN, token);
        intent.putExtra(ProximityForegroundService.EXTRA_DEVICE_ID, deviceId);
        intent.putExtra(ProximityForegroundService.EXTRA_MASTER_ID, masterId);
        intent.putExtra(ProximityForegroundService.EXTRA_MODE, mode);
        intent.putExtra(ProximityForegroundService.EXTRA_LOCATION_ENABLED, "scan".equals(mode));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
            else getContext().startService(intent);
            JSObject result = new JSObject();
            result.put("active", true);
            result.put("beaconId", deviceId);
            result.put("background", true);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Android tidak bisa memulai service BLE latar: " + error.getMessage(), "FOREGROUND_SERVICE_FAILED");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent stop = new Intent(getContext(), ProximityForegroundService.class).setAction(ProximityForegroundService.ACTION_STOP);
        getContext().startService(stop);
        JSObject event = new JSObject();
        event.put("active", false);
        call.resolve(event);
    }

    @PluginMethod
    public void isScanning(PluginCall call) {
        JSObject result = new JSObject();
        result.put("active", ProximityForegroundService.isActive());
        result.put("locationActive", ProximityForegroundService.isLocationActive());
        call.resolve(result);
    }

    @PluginMethod
    public void enableLocation(PluginCall call) {
        if (!hasForegroundLocationPermission()) {
            call.reject("Izin lokasi Android belum diberikan.", "LOCATION_PERMISSION_REQUIRED");
            return;
        }
        Intent intent = new Intent(getContext(), ProximityForegroundService.class).setAction(ProximityForegroundService.ACTION_ENABLE_LOCATION);
        try {
            getContext().startService(intent);
            JSObject result = new JSObject();
            result.put("accepted", true);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Android tidak dapat mengaktifkan lokasi latar: " + error.getMessage(), "LOCATION_SERVICE_FAILED");
        }
    }

    /**
     * Ambil satu foto HANYA ketika admin mengirim perintah photo/photo_front.
     * Tidak ada penjadwalan: kamera tidak pernah menyala sendiri.
     */
    @PluginMethod
    public void capturePhoto(PluginCall call) {
        if (getContext().checkSelfPermission(Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("camera", call, "onCameraPermissionResult");
            return;
        }
        runCapture(call);
    }

    @PermissionCallback
    private void onCameraPermissionResult(PluginCall call) {
        if (getContext().checkSelfPermission(Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            call.reject("Izin kamera Android belum diberikan.", "CAMERA_PERMISSION_REQUIRED");
            return;
        }
        runCapture(call);
    }

    private void runCapture(PluginCall call) {
        String lens = call.getString("lens", "back");
        int facing = "front".equals(lens)
                ? android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT
                : android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK;
        CameraCapture.capture(getContext(), facing, new CameraCapture.CaptureCallback() {
            @Override
            public void onSuccess(byte[] jpeg) {
                JSObject result = new JSObject();
                result.put("imageBase64", android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP));
                result.put("bytes", jpeg.length);
                result.put("capturedAt", new java.text.SimpleDateFormat(
                        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", java.util.Locale.US).format(new java.util.Date()));
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> call.resolve(result));
            }

            @Override
            public void onError(String message) {
                new android.os.Handler(android.os.Looper.getMainLooper())
                        .post(() -> call.reject(message == null ? "Foto gagal diambil." : message, "CAPTURE_FAILED"));
            }
        });
    }

    private boolean hasBlePermission(boolean advertising) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            String permission = advertising ? Manifest.permission.BLUETOOTH_ADVERTISE : Manifest.permission.BLUETOOTH_SCAN;
            return getContext().checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    @Override
    protected void handleOnDestroy() {
        if (serviceReceiver != null) {
            try { getContext().unregisterReceiver(serviceReceiver); } catch (IllegalArgumentException ignored) { }
            serviceReceiver = null;
        }
    }
}
