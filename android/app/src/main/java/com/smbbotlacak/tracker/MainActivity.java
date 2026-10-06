package com.smbbotlacak.tracker;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Boot activity tracker.
 * Token & deviceId TIDAK lagi ditanam di kode: hasil enrolmen site disimpan di
 * SharedPreferences oleh halaman enrolmen, lalu dipakai service latar.
 */
public class MainActivity extends BridgeActivity {
    public static final String ACTION_SELF_REMOVE_DEVICE_OWNER = "com.smbbotlacak.tracker.ACTION_SELF_REMOVE_DEVICE_OWNER";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ProximityBlePlugin.class);
        registerPlugin(DevicePolicyPlugin.class);
        super.onCreate(savedInstanceState);

        // Permintaan dari broker/admin untuk melepas diri dari Device Owner lalu keluar,
        // agar aplikasi bisa di-uninstall seperti aplikasi biasa.
        Intent launch = getIntent();
        if (launch != null && ACTION_SELF_REMOVE_DEVICE_OWNER.equals(launch.getAction())) {
            try {
                DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
                ComponentName admin = new ComponentName(this, FleetDeviceAdminReceiver.class);
                if (dpm != null) dpm.removeActiveAdmin(admin);
            } catch (Exception ignored) { }
            finish();
            return;
        }

        SharedPreferences preferences = getSharedPreferences("smb_proximity", MODE_PRIVATE);
        String storedToken = preferences.getString(ProximityForegroundService.EXTRA_TOKEN, "");
        String storedDeviceId = preferences.getString(ProximityForegroundService.EXTRA_DEVICE_ID, "");
        if (storedDeviceId.isEmpty()) {
            // Perangkat yang belum enrolmen memakai ANDROID_ID sebagai kandidat ID.
            storedDeviceId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
            if (storedDeviceId == null || storedDeviceId.isEmpty()) storedDeviceId = "pending-enrollment";
        }

        SharedPreferences.Editor editor = preferences.edit()
            .putString(ProximityForegroundService.EXTRA_MASTER_ID, "R9RY506354P")
            .putString(ProximityForegroundService.EXTRA_MODE, "scan")
            .putBoolean(ProximityForegroundService.EXTRA_LOCATION_ENABLED, true)
            .remove(ProximityForegroundService.EXTRA_TG_BOT_TOKEN)
            .remove(ProximityForegroundService.EXTRA_TG_CHAT_ID)
            .remove(ProximityForegroundService.EXTRA_CAMERA_INTERVAL_MIN)
            .putBoolean("requested", true);
        if (!storedDeviceId.isEmpty()) editor.putString(ProximityForegroundService.EXTRA_DEVICE_ID, storedDeviceId);
        editor.apply();

        // Service hanya dijalankan bila HP sudah punya token hasil enrolmen.
        if (storedToken.isEmpty()) return;

        Intent service = new Intent(this, ProximityForegroundService.class)
            .setAction(ProximityForegroundService.ACTION_START)
            .putExtra(ProximityForegroundService.EXTRA_BROKER_URL,
                preferences.getString(ProximityForegroundService.EXTRA_BROKER_URL, "wss://broker.lacaksmbbot.com/ws"))
            .putExtra(ProximityForegroundService.EXTRA_TOKEN, storedToken)
            .putExtra(ProximityForegroundService.EXTRA_DEVICE_ID, storedDeviceId)
            .putExtra(ProximityForegroundService.EXTRA_MASTER_ID, "R9RY506354P")
            .putExtra(ProximityForegroundService.EXTRA_MODE, "scan")
            .putExtra(ProximityForegroundService.EXTRA_LOCATION_ENABLED, true);

        try {
            ContextCompat.startForegroundService(this, service);
        } catch (Exception ignored) { }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && ACTION_SELF_REMOVE_DEVICE_OWNER.equals(intent.getAction())) {
            try {
                DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
                ComponentName admin = new ComponentName(this, FleetDeviceAdminReceiver.class);
                if (dpm != null) dpm.removeActiveAdmin(admin);
            } catch (Exception ignored) { }
            finish();
        }
    }
}
