package PKG;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.app.RemoteInput;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** A button on a quick-action notice: POST to /api/v1/notification-actions/{key} with no sign-in; open the app when it must finish there. */
public class QuickActionReceiver extends BroadcastReceiver {
    static String label(String a) {
        switch (a) {
            case "approve": return "Approve"; case "reject": return "Reject"; case "reply": return "Reply"; case "read": return "Mark read";
            case "done": return "Done"; case "snooze": return "Snooze 1h"; case "open": return "Open"; case "join": return "Join";
            case "late": return "Running late"; case "accept": return "Accept"; case "decline": return "Decline"; case "maybe": return "Maybe";
            case "review": return "Review"; case "discuss": return "Discuss"; case "callback": return "Call back"; case "message": return "Message";
            case "answer": return "Answer";
            default: return null;
        }
    }
    static boolean opens(String a) { return a.equals("open") || a.equals("join") || a.equals("review") || a.equals("discuss") || a.equals("callback") || a.equals("answer"); }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        final String qa = intent.getStringExtra("qa"), action = intent.getStringExtra("action"), link = intent.getStringExtra("link");
        final int id = intent.getIntExtra("id", 0);
        Bundle input = RemoteInput.getResultsFromIntent(intent);
        final String text = input != null && input.getCharSequence("text") != null ? input.getCharSequence("text").toString().trim() : "";
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (qa == null || action == null) return;
        boolean needsText = action.equals("reply") || action.equals("reject") || action.equals("message");
        if (opens(action) || (needsText && text.isEmpty())) {
            nm.cancel(id);
            try { QuickActionsMessagingService.openIntent(ctx, link == null ? "/" : link, id).send(); } catch (Exception ignored) { }
            if (opens(action)) post(ctx, qa, "read", "", null, id);
            return;
        }
        final PendingResult async = goAsync();
        post(ctx, qa, action.equals("message") ? "reply" : action, text, async, id);
    }

    private static void post(Context ctx, String qa, String action, String text, PendingResult async, int id) {
        new Thread(() -> {
            boolean ok = false;
            try {
                URL url = new URL(BuildConfigHost.BASE + "/api/v1/notification-actions/" + URLEncoder.encode(qa, "UTF-8"));
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setRequestMethod("POST"); c.setDoOutput(true); c.setConnectTimeout(10_000); c.setReadTimeout(10_000);
                c.setRequestProperty("Content-Type", "application/json");
                JSONObject body = new JSONObject().put("action", action);
                if (!text.isEmpty()) body.put("text", text);
                if (action.equals("snooze")) body.put("preset", "1h");
                try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                ok = c.getResponseCode() < 300;
                c.disconnect();
            } catch (Exception ignored) { }
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.cancel(id);
            if (!ok && async != null) { try { QuickActionsMessagingService.openIntent(ctx, "/", id).send(); } catch (Exception ignored) { } }
            if (async != null) async.finish();
        }).start();
    }
}
