package id.nusarental.fleetconsole;

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
        if (received == null || !Intent.ACTION_BOOT_COMPLETED.equals(received.getAction())) return;

        SharedPreferences preferences = context.getSharedPreferences("smb_proximity", Context.MODE_PRIVATE);
        if (!preferences.getBoolean("requested", false)) return;

        Intent service = new Intent(context, ProximityForegroundService.class)
            .setAction(ProximityForegroundService.ACTION_START)
            .putExtra(ProximityForegroundService.EXTRA_BROKER_URL, preferences.getString(ProximityForegroundService.EXTRA_BROKER_URL, ""))
            .putExtra(ProximityForegroundService.EXTRA_TOKEN, preferences.getString(ProximityForegroundService.EXTRA_TOKEN, ""))
            .putExtra(ProximityForegroundService.EXTRA_DEVICE_ID, preferences.getString(ProximityForegroundService.EXTRA_DEVICE_ID, ""))
            .putExtra(ProximityForegroundService.EXTRA_MASTER_ID, preferences.getString(ProximityForegroundService.EXTRA_MASTER_ID, "R9RY506354P"))
            .putExtra(ProximityForegroundService.EXTRA_MODE, preferences.getString(ProximityForegroundService.EXTRA_MODE, "scan"));

        boolean allowBackgroundLocation = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q
            || context.checkSelfPermission(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED;
        service.putExtra(ProximityForegroundService.EXTRA_LOCATION_ENABLED, allowBackgroundLocation);

        try {
            ContextCompat.startForegroundService(context, service);
        } catch (RuntimeException error) {
            Log.e(TAG, "Android blocked BLE service restart at boot", error);
        }
    }
}
