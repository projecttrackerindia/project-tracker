#!/usr/bin/env python3
"""Adds what the app needs to the generated Android project: permissions (notifications, camera for photos, scans and video calls,
microphone for calls and voice notes - the app's WebView turns a page's request into Android's own prompt), links that open the
app (https addresses of the site and projecttracker://), the notification icon and channel for push, and the screen shield (the page marks
the screen secure while it shows the password vault: screenshots, recordings, casting and the recent-apps preview are black). Safe to run again."""
import re, shutil, sys, pathlib

host = sys.argv[1]
root = pathlib.Path('android/app/src/main')
manifest = root / 'AndroidManifest.xml'
xml = manifest.read_text()

perms = ['POST_NOTIFICATIONS', 'CAMERA', 'VIBRATE', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS']
for p in perms:
    line = f'<uses-permission android:name="android.permission.{p}" />'
    if line not in xml:
        xml = xml.replace('</manifest>', f'    {line}\n</manifest>')
# a camera and a microphone are optional: the app also works on devices without them
if 'android.hardware.camera' not in xml:
    xml = xml.replace('</manifest>', '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>')
if 'android.hardware.microphone' not in xml:
    xml = xml.replace('</manifest>', '    <uses-feature android:name="android.hardware.microphone" android:required="false" />\n</manifest>')

links = f'''
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="{host}" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="projecttracker" />
            </intent-filter>
'''
if 'android:scheme="projecttracker"' not in xml:
    xml = xml.replace('        </activity>', links + '\n        </activity>', 1)

meta = '''
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_notify" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_color" android:resource="@color/notification_accent" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="alerts" />
'''
if 'default_notification_icon' not in xml:
    xml = xml.replace('    </application>', meta + '    </application>', 1)
manifest.write_text(xml)

res = root / 'res'
shutil.copytree('native/res', res, dirs_exist_ok=True)
colors = res / 'values' / 'notification_colors.xml'
colors.parent.mkdir(parents=True, exist_ok=True)
colors.write_text('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="notification_accent">#7C3AED</color>\n</resources>\n')

# The screen shield: a small plugin the page calls (ScreenShield.set({ on })), registered in the main activity.
mains = list((root / 'java').rglob('MainActivity.java'))
if not mains:
    sys.exit('MainActivity.java not found: run "npx cap add android" first')
main = mains[0]
pkg = re.search(r'^package\s+([\w.]+);', main.read_text(), re.M).group(1)
(main.parent / 'ScreenShieldPlugin.java').write_text(f'''package {pkg};

import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Marks the screen secure while the page shows secrets: screenshots, screen recordings, casting and the recent-apps preview show black. */
@CapacitorPlugin(name = "ScreenShield")
public class ScreenShieldPlugin extends Plugin {{
    @PluginMethod
    public void set(PluginCall call) {{
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {{
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        }});
    }}
}}
''')
src = main.read_text()
if 'ScreenShieldPlugin' not in src:
    src = re.sub(r'public class MainActivity extends BridgeActivity\s*\{\s*\}', '''public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ScreenShieldPlugin.class);
        super.onCreate(savedInstanceState);
    }
}''', src)
    if 'ScreenShieldPlugin' not in src:
        src = src.replace('super.onCreate(savedInstanceState);', 'registerPlugin(ScreenShieldPlugin.class);\n        super.onCreate(savedInstanceState);', 1)
    if 'ScreenShieldPlugin' not in src:
        sys.exit('Could not register the screen shield in MainActivity.java')
    main.write_text(src)
print('Android project patched')
