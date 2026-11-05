package PKG;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The full-screen incoming call (shown over the lock screen by the call notification's full-screen intent): Answer opens the call in the app,
 * Decline stops the ringing, quick replies send a short message. A scaffold: a ConnectionService (self-managed) would also put the call in the
 * system's call log and Bluetooth controls (see docs/quick-actions-native.md).
 */
public class IncomingCallActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        final String title = getIntent().getStringExtra("title"), link = getIntent().getStringExtra("link"), qa = getIntent().getStringExtra("qa");
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL); col.setGravity(Gravity.CENTER); col.setBackgroundColor(0xFF1C1C1E); col.setPadding(48, 48, 48, 48);
        TextView name = new TextView(this); name.setText(title); name.setTextColor(0xFFFFFFFF); name.setTextSize(26); name.setGravity(Gravity.CENTER);
        col.addView(name);
        for (String reply : new String[] { "Can't talk now", "Call you in 5", "In a meeting" }) {
            Button r = new Button(this); r.setText(reply); r.setAllCaps(false);
            r.setOnClickListener(v -> { quick(qa, "message", reply, link); finish(); });
            col.addView(r);
        }
        Button answer = new Button(this); answer.setText("Answer"); answer.setBackgroundColor(0xFF30B158); answer.setTextColor(0xFFFFFFFF);
        answer.setOnClickListener(v -> { stopRinging(); startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("projecttracker:/" + (link == null ? "/" : link))).setPackage(getPackageName())); finish(); });
        Button decline = new Button(this); decline.setText("Decline"); decline.setBackgroundColor(0xFFFF3B30); decline.setTextColor(0xFFFFFFFF);
        decline.setOnClickListener(v -> { quick(qa, "decline", "", link); finish(); });
        col.addView(answer); col.addView(decline);
        setContentView(col);
    }

    private void stopRinging() { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancelAll(); }

    private void quick(String qa, String action, String text, String link) {
        stopRinging();
        if (qa == null) return;
        Intent press = new Intent(this, QuickActionReceiver.class).putExtra("qa", qa).putExtra("action", action).putExtra("link", link);
        if (!text.isEmpty()) {
            Bundle b = new Bundle(); b.putCharSequence("text", text);
            androidx.core.app.RemoteInput.addResultsToIntent(new androidx.core.app.RemoteInput[] { new androidx.core.app.RemoteInput.Builder("text").build() }, press, b);
        }
        sendBroadcast(press);
    }
}
