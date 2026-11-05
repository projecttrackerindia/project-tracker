package PKG;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The page hands the widget its snapshot: { tasks: [{ title }], meeting: { title, time, link }, checkInPercent, checkInLabel }. */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        String json = call.getData().toString();
        if (json.length() > 8000) { call.reject("too large"); return; }
        getContext().getSharedPreferences(TodayWidgetProvider.PREFS, android.content.Context.MODE_PRIVATE).edit().putString("glance", json).apply();
        TodayWidgetProvider.refresh(getContext());
        call.resolve();
    }
}
