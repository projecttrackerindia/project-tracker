package PKG;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;
import com.google.firebase.messaging.RemoteMessage;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import java.util.Map;
import org.json.JSONArray;

/**
 * Quick actions on Android: a push that carries a one-time key ("qa") and its buttons ("actions") is shown with those buttons (Approve / Reject,
 * Reply inline, Done / Snooze / Open, Join / Running late, Accept / Decline / Maybe...). Pressing one goes to QuickActionReceiver, which acts
 * through the key with the app closed. A ringing call ("call") opens the full-screen IncomingCallActivity, like the phone's own calls.
 * Everything else is left to Capacitor's push plugin as before (this class extends its service).
 */
public class QuickActionsMessagingService extends MessagingService {
    static final String CHANNEL = "alerts", CALLS = "calls";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> d = message.getData();
        String qa = d.get("qa"), call = d.get("call");
        if (qa == null && call == null) { super.onMessageReceived(message); return; }
        String title = message.getNotification() != null ? message.getNotification().getTitle() : d.getOrDefault("title", "ProjectTracker");
        String body = message.getNotification() != null ? message.getNotification().getBody() : d.getOrDefault("body", "");
        String tag = d.getOrDefault("tag", String.valueOf(System.currentTimeMillis()));
        String link = d.getOrDefault("link", "/");
        Context ctx = getApplicationContext();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        channels(nm);
        int id = tag.hashCode();
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, call != null ? CALLS : CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notify).setContentTitle(title).setContentText(body).setAutoCancel(true)
            .setContentIntent(openIntent(ctx, link, id));
        if (call != null) {
            Intent full = new Intent(ctx, IncomingCallActivity.class).putExtra("title", title).putExtra("call", call).putExtra("link", link).putExtra("qa", qa)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent fullPi = PendingIntent.getActivity(ctx, id, full, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_MAX).setOngoing(true).setTimeoutAfter(45_000)
                .setFullScreenIntent(fullPi, true);
        } else {
            b.setPriority(NotificationCompat.PRIORITY_HIGH);
        }
        try {
            JSONArray acts = new JSONArray(d.getOrDefault("actions", "[]"));
            for (int i = 0; i < acts.length() && i < 3; i++) {
                String a = acts.getString(i);
                if (qa == null || QuickActionReceiver.label(a) == null) continue;
                Intent press = new Intent(ctx, QuickActionReceiver.class).setAction("pt.quick." + a)
                    .putExtra("qa", qa).putExtra("action", a).putExtra("link", link).putExtra("id", id);
                boolean text = a.equals("reply") || a.equals("reject") || a.equals("message");
                PendingIntent pi = PendingIntent.getBroadcast(ctx, id * 31 + i, press,
                    PendingIntent.FLAG_UPDATE_CURRENT | (text ? PendingIntent.FLAG_MUTABLE : PendingIntent.FLAG_IMMUTABLE));
                NotificationCompat.Action.Builder ab = new NotificationCompat.Action.Builder(0, QuickActionReceiver.label(a), pi);
                if (text) ab.addRemoteInput(new RemoteInput.Builder("text").setLabel(a.equals("reject") ? "Reason for rejecting" : "Reply…").build());
                b.addAction(ab.build());
            }
        } catch (org.json.JSONException ignored) { /* no buttons, the notice still opens */ }
        nm.notify(tag, id, b.build());
    }

    static PendingIntent openIntent(Context ctx, String link, int id) {
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("projecttracker:/" + link)).setPackage(ctx.getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void channels(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < 26) return;
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Alerts", NotificationManager.IMPORTANCE_HIGH));
        if (nm.getNotificationChannel(CALLS) == null) nm.createNotificationChannel(new NotificationChannel(CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH));
        if (nm.getNotificationChannel(LiveTimerPlugin.CHANNEL) == null) nm.createNotificationChannel(new NotificationChannel(LiveTimerPlugin.CHANNEL, "Ongoing", NotificationManager.IMPORTANCE_LOW));
    }
}
