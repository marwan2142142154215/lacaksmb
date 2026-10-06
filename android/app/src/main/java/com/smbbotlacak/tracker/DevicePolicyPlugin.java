package com.smbbotlacak.tracker;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DevicePolicy")
public class DevicePolicyPlugin extends Plugin {
    private DevicePolicyManager policyManager;
    private ComponentName adminComponent;

    @Override
    public void load() {
        policyManager = (DevicePolicyManager) getContext().getSystemService(android.content.Context.DEVICE_POLICY_SERVICE);
        adminComponent = new ComponentName(getContext(), FleetDeviceAdminReceiver.class);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        boolean isOwner = policyManager != null && policyManager.isDeviceOwnerApp(getContext().getPackageName());
        boolean isAdmin = policyManager != null && policyManager.isAdminActive(adminComponent);
        result.put("deviceOwner", isOwner);
        result.put("deviceAdmin", isAdmin);
        android.app.ActivityManager activityManager = (android.app.ActivityManager) getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
        result.put("lockTaskMode", activityManager == null ? 0 : activityManager.getLockTaskModeState());
        result.put("lockTaskPermitted", isOwner);
        call.resolve(result);
    }

    @PluginMethod
    public void lock(PluginCall call) {
        boolean isOwner = policyManager != null && policyManager.isDeviceOwnerApp(getContext().getPackageName());
        if (!isOwner) {
            call.reject("Mode kios jarak jauh memerlukan enrollment Android Device Owner.");
            return;
        }
        try {
            policyManager.setLockTaskPackages(adminComponent, new String[] { getContext().getPackageName() });
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                policyManager.setLockTaskFeatures(adminComponent, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
            }
        } catch (Exception error) {
            call.reject("Android menolak kebijakan Lock Task: " + error.getMessage());
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startLockTask();
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    int mode = getLockTaskMode();
                    if (mode == android.app.ActivityManager.LOCK_TASK_MODE_LOCKED) {
                        JSObject result = new JSObject();
                        result.put("locked", true);
                        result.put("lockTaskMode", mode);
                        call.resolve(result);
                    } else {
                        call.reject("Android tidak mengaktifkan mode kios; status Lock Task tetap " + mode + ".");
                    }
                }, 350);
            } catch (Exception error) {
                call.reject("Gagal memulai Lock Task: " + error.getMessage());
            }
        });
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        int before = getLockTaskMode();
        if (before == android.app.ActivityManager.LOCK_TASK_MODE_NONE) {
            JSObject result = new JSObject();
            result.put("locked", false);
            result.put("lockTaskMode", before);
            call.resolve(result);
            return;
        }
        boolean isOwner = policyManager != null && policyManager.isDeviceOwnerApp(getContext().getPackageName());
        if (!isOwner) {
            call.reject("Melepas Lock Task terkelola memerlukan Android Device Owner.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().stopLockTask();
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    int mode = getLockTaskMode();
                    if (mode == android.app.ActivityManager.LOCK_TASK_MODE_NONE) {
                        JSObject result = new JSObject();
                        result.put("locked", false);
                        result.put("lockTaskMode", mode);
                        call.resolve(result);
                    } else {
                        call.reject("Android belum melepas Lock Task; status tetap " + mode + ".");
                    }
                }, 350);
            } catch (Exception error) {
                call.reject("Gagal melepas Lock Task: " + error.getMessage());
            }
        });
    }

    @PluginMethod
    public void setUninstallBlocked(PluginCall call) {
        Boolean blocked = call.getBoolean("blocked");
        if (blocked == null) { call.reject("Field blocked wajib diisi."); return; }
        boolean isOwner = policyManager != null && policyManager.isDeviceOwnerApp(getContext().getPackageName());
        if (!isOwner) {
            // Tanpa Device Owner Android tidak bisa memblokir uninstall;
            // kembalikan status sebenarnya supaya UI tidak menampilkan janji palsu.
            JSObject result = new JSObject();
            result.put("blocked", false);
            result.put("supported", false);
            call.resolve(result);
            return;
        }
        try {
            // Signature Android: setUninstallBlocked(admin, namaPaket, statusBlokir).
            policyManager.setUninstallBlocked(adminComponent, getContext().getPackageName(), blocked);
            JSObject result = new JSObject();
            result.put("blocked", blocked);
            result.put("supported", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Android menolak perubahan blokir hapus aplikasi: " + error.getMessage());
        }
    }

    @PluginMethod
    public void openUninstallScreen(PluginCall call) {
        boolean isOwner = policyManager != null && policyManager.isDeviceOwnerApp(getContext().getPackageName());
        if (!isOwner) { call.reject("Pembuka layar hapus memerlukan Android Device Owner."); return; }
        try {
            // Layar hapus bawaan Android selalu menampilkan 1 konfirmasi milik sistem,
            // sehingga penghapusan tetap butuh persetujuan di perangkat.
            getActivity().runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    android.app.Activity activity = getActivity();
                    if (activity != null) activity.startActivity(intent);
                    else getContext().startActivity(intent);
                    JSObject result = new JSObject();
                    result.put("opened", true);
                    call.resolve(result);
                } catch (Exception error) {
                    call.reject("Android tidak membuka layar detail aplikasi: " + error.getMessage());
                }
            });
        } catch (Exception error) {
            call.reject("Gagal membuka layar hapus aplikasi: " + error.getMessage());
        }
    }

    private int getLockTaskMode() {
        android.app.ActivityManager activityManager = (android.app.ActivityManager) getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
        return activityManager == null ? android.app.ActivityManager.LOCK_TASK_MODE_NONE : activityManager.getLockTaskModeState();
    }
}
