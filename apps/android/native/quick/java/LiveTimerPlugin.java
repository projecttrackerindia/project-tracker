package PKG;

import android.app.NotificationManager;
import android.content.Context;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** A live timer in the shade while a call, a meeting or the work day runs: an ongoing, quiet notification with a running clock. */
@CapacitorPlugin(name = "LiveTimer")
public class LiveTimerPlugin extends Plugin {
    static final String CHANNEL = "ongoing";
    private static final int ID = 0x51A7;

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        QuickActionsMessagingService.channels(nm);
        long since = call.getLong("since", System.currentTimeMillis());
        String link = call.getString("link", "/");
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(call.getString("title", "ProjectTracker")).setContentText(call.getString("body", ""))
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true).setUsesChronometer(true).setWhen(since).setShowWhen(true)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH).setContentIntent(QuickActionsMessagingService.openIntent(ctx, link, ID));
        nm.notify(call.getString("kind", "timer"), ID, b.build());
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ((NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE)).cancel(call.getString("kind", "timer"), ID);
        call.resolve();
    }
}
