package id.nusarental.fleetconsole;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ProximityBlePlugin.class);
        registerPlugin(DevicePolicyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
