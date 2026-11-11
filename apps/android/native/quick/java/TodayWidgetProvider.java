package PKG;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The home-screen widget: today's tasks (up to three), the next meeting with Join, and the check-in ring. The app writes a small snapshot
 * (WidgetBridgePlugin.set) whenever its Today data changes; the widget only reads it, so it never needs a sign-in of its own.
 */
public class TodayWidgetProvider extends AppWidgetProvider {
    static final String PREFS = "pt_glance";

    static void refresh(Context ctx) {
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        new TodayWidgetProvider().onUpdate(ctx, m, m.getAppWidgetIds(new ComponentName(ctx, TodayWidgetProvider.class)));
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager m, int[] ids) {
        JSONObject g;
        try { g = new JSONObject(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("glance", "{}")); } catch (Exception e) { g = new JSONObject(); }
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_today);
            JSONArray tasks = g.optJSONArray("tasks");
            int[] rows = { R.id.pt_task1, R.id.pt_task2, R.id.pt_task3 };
            int n = tasks == null ? 0 : tasks.length();
            v.setTextViewText(R.id.pt_today, "TODAY · " + n);
            for (int i = 0; i < rows.length; i++) v.setTextViewText(rows[i], i < n ? "○  " + tasks.optJSONObject(i).optString("title") : "");
            JSONObject meet = g.optJSONObject("meeting");
            v.setTextViewText(R.id.pt_join, meet == null ? "Open" : "Join " + meet.optString("time"));
            String joinLink = meet == null ? "/" : meet.optString("link", "/");
            Intent join = new Intent(Intent.ACTION_VIEW, Uri.parse("projecttracker:/" + joinLink)).setPackage(ctx.getPackageName());
            v.setOnClickPendingIntent(R.id.pt_join, PendingIntent.getActivity(ctx, id, join, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            v.setProgressBar(R.id.pt_ring, 100, Math.min(100, g.optInt("checkInPercent", 0)), false);
            v.setTextViewText(R.id.pt_ring_label, g.optString("checkInLabel", ""));
            Intent home = new Intent(Intent.ACTION_VIEW, Uri.parse("projecttracker://my-work")).setPackage(ctx.getPackageName());
            v.setOnClickPendingIntent(R.id.pt_widget, PendingIntent.getActivity(ctx, id + 1, home, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            m.updateAppWidget(id, v);
        }
    }
}
