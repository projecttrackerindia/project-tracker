#!/usr/bin/env python3
"""Adds what the app needs to the generated Android project: permissions (notifications, camera for photos and scans), links that open the
app (https addresses of the site and projecttracker://), the notification icon and channel for push. Safe to run again."""
import re, shutil, sys, pathlib

host = sys.argv[1]
root = pathlib.Path('android/app/src/main')
manifest = root / 'AndroidManifest.xml'
xml = manifest.read_text()

perms = ['POST_NOTIFICATIONS', 'CAMERA', 'VIBRATE']
for p in perms:
    line = f'<uses-permission android:name="android.permission.{p}" />'
    if line not in xml:
        xml = xml.replace('</manifest>', f'    {line}\n</manifest>')
# a camera is optional: the app also works on devices without one
if 'android.hardware.camera' not in xml:
    xml = xml.replace('</manifest>', '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>')

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
print('Android project patched')
