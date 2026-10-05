package id.nusarental.fleetconsole;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
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
        boolean owner = policyManager != null && policyManager.isDeviceOwnerApp(getContext().getPackageName());
        result.put("deviceOwner", owner);
        android.app.ActivityManager activityManager = (android.app.ActivityManager) getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
        result.put("lockTaskMode", activityManager == null ? 0 : activityManager.getLockTaskModeState());
        result.put("lockTaskPermitted", policyManager != null && policyManager.isLockTaskPermitted(getContext().getPackageName()));
        call.resolve(result);
    }

    @PluginMethod
    public void lock(PluginCall call) {
        if (policyManager == null || !policyManager.isDeviceOwnerApp(getContext().getPackageName())) {
            call.reject("SMB Lacak belum terdaftar sebagai Android Device Owner.", "DEVICE_OWNER_REQUIRED");
            return;
        }
        try {
            policyManager.setLockTaskPackages(adminComponent, new String[] { getContext().getPackageName() });
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                policyManager.setLockTaskFeatures(adminComponent, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
            }
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().startLockTask();
                    getActivity().getWindow().getDecorView().postDelayed(() -> {
                        if (getLockTaskMode() != android.app.ActivityManager.LOCK_TASK_MODE_LOCKED) {
                            call.reject("Android tidak memulai kiosk karena SMB Lacak tidak sedang di layar depan. Buka SMB Lacak lalu kirim lock lagi.", "LOCK_TASK_REQUIRES_FOREGROUND");
                            return;
                        }
                        JSObject result = new JSObject();
                        result.put("locked", true);
                        result.put("lockTaskMode", getLockTaskMode());
                        call.resolve(result);
                    }, 350);
                } catch (RuntimeException error) {
                    call.reject("Android gagal memulai mode kiosk: " + error.getMessage(), "LOCK_TASK_FAILED");
                }
            });
        } catch (SecurityException error) {
            call.reject("Android menolak kebijakan Device Owner: " + error.getMessage(), "DEVICE_POLICY_DENIED");
        }
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().stopLockTask();
                getActivity().getWindow().getDecorView().postDelayed(() -> {
                    if (getLockTaskMode() != android.app.ActivityManager.LOCK_TASK_MODE_NONE) {
                        call.reject("Android belum keluar dari mode kiosk.", "UNLOCK_FAILED");
                        return;
                    }
                    JSObject result = new JSObject();
                    result.put("locked", false);
                    result.put("lockTaskMode", getLockTaskMode());
                    call.resolve(result);
                }, 250);
            } catch (RuntimeException error) {
                call.reject("Android gagal keluar dari mode kiosk: " + error.getMessage(), "UNLOCK_FAILED");
            }
        });
    }

    private int getLockTaskMode() {
        android.app.ActivityManager activityManager = (android.app.ActivityManager) getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
        return activityManager == null ? android.app.ActivityManager.LOCK_TASK_MODE_NONE : activityManager.getLockTaskModeState();
    }
}
