package com.smbbotlacak.tracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.core.content.ContextCompat;

public final class ProximityBootReceiver extends BroadcastReceiver {
    private static final String TAG = "SMBProximityBoot";

    @Override
    public void onReceive(Context context, Intent received) {
        if (received == null) return;
        String action = received.getAction();
        boolean isValidTrigger = Intent.ACTION_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (!isValidTrigger) return;

        SharedPreferences preferences = context.getSharedPreferences("smb_proximity", Context.MODE_PRIVATE);
        String storedToken = preferences.getString(ProximityForegroundService.EXTRA_TOKEN, "");
        // Perangkat yang belum menyelesaikan enrolmen site tidak punya token;
        // jangan jalankan service dengan kredensial pura-pura.
        if (storedToken.isEmpty()) {
            Log.d(TAG, "Skip service restart: enrollment token missing.");
            return;
        }

        Intent service = new Intent(context, ProximityForegroundService.class)
            .setAction(ProximityForegroundService.ACTION_START)
            .putExtra(ProximityForegroundService.EXTRA_BROKER_URL, preferences.getString(ProximityForegroundService.EXTRA_BROKER_URL, "wss://broker.lacaksmbbot.com/ws"))
            .putExtra(ProximityForegroundService.EXTRA_TOKEN, storedToken)
            .putExtra(ProximityForegroundService.EXTRA_DEVICE_ID, preferences.getString(ProximityForegroundService.EXTRA_DEVICE_ID, ""))
            .putExtra(ProximityForegroundService.EXTRA_MASTER_ID, preferences.getString(ProximityForegroundService.EXTRA_MASTER_ID, "R9RY506354P"))
            .putExtra(ProximityForegroundService.EXTRA_MODE, preferences.getString(ProximityForegroundService.EXTRA_MODE, "scan"));

        boolean allowBackgroundLocation = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q
            || context.checkSelfPermission(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED;
        service.putExtra(ProximityForegroundService.EXTRA_LOCATION_ENABLED, allowBackgroundLocation);

        try {
            ContextCompat.startForegroundService(context, service);
            Log.d(TAG, "ProximityForegroundService started on trigger: " + action);
        } catch (RuntimeException error) {
            Log.e(TAG, "Android blocked BLE service restart at boot", error);
        }
    }
}
