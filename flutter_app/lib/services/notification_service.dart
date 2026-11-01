import 'dart:io';

import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:permission_handler/permission_handler.dart';

/// Local notifications (progress + completion) and an Android foreground service
/// that keeps downloads alive when the app is in the background.
class NotificationService {
  final _plugin = FlutterLocalNotificationsPlugin();
  bool _fgRunning = false;

  Future<void> init() async {
    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    const windows = WindowsInitializationSettings(
      appName: 'BlackHole Ultra Downloader',
      appUserModelId: 'com.blackhole.ultradownloader',
      guid: 'a1b2c3d4-0000-4000-8000-blackhole0001',
    );
    await _plugin.initialize(const InitializationSettings(android: android, windows: windows));

    if (Platform.isAndroid) {
      await Permission.notification.request();
      await Permission.storage.request();
      if (await Permission.manageExternalStorage.isDenied) {
        await Permission.manageExternalStorage.request();
      }
      FlutterForegroundTask.init(
        androidNotificationOptions: AndroidNotificationOptions(
          channelId: 'bh_downloads',
          channelName: 'BlackHole downloads',
          channelDescription: 'Active downloads keep running in the background',
          channelImportance: NotificationChannelImportance.LOW,
          priority: NotificationPriority.LOW,
        ),
        iosNotificationOptions: const IOSNotificationOptions(),
        foregroundTaskOptions: ForegroundTaskOptions(
          eventAction: ForegroundTaskEventAction.nothing(),
          allowWakeLock: true,
          allowWifiLock: true,
        ),
      );
    }
  }

  /// Start/stop the Android foreground service depending on whether downloads are active.
  Future<void> setBackgroundActive(bool active, {String? text}) async {
    if (!Platform.isAndroid) return;
    if (active && !_fgRunning) {
      await FlutterForegroundTask.startService(
        notificationTitle: 'BlackHole — جارٍ التحميل',
        notificationText: text ?? 'التحميلات تعمل في الخلفية',
      );
      _fgRunning = true;
    } else if (!active && _fgRunning) {
      await FlutterForegroundTask.stopService();
      _fgRunning = false;
    } else if (active && text != null) {
      await FlutterForegroundTask.updateService(notificationTitle: 'BlackHole — جارٍ التحميل', notificationText: text);
    }
  }

  Future<void> progress(int id, String title, double percent, String? speed) async {
    if (!Platform.isAndroid) return; // Windows: only completion toasts
    await _plugin.show(
      id,
      title,
      '${percent.toStringAsFixed(1)}% ${speed != null ? '· $speed' : ''}',
      NotificationDetails(
        android: AndroidNotificationDetails(
          'bh_progress',
          'Download progress',
          importance: Importance.low,
          priority: Priority.low,
          onlyAlertOnce: true,
          showProgress: true,
          maxProgress: 100,
          progress: percent.round(),
          ongoing: true,
        ),
      ),
    );
  }

  Future<void> done(int id, String title, {required bool success, String? error}) async {
    await _plugin.cancel(id);
    await _plugin.show(
      10000 + id,
      success ? 'اكتمل التحميل ✓' : 'فشل التحميل ✗',
      success ? title : '$title\n${error ?? ''}',
      const NotificationDetails(
        android: AndroidNotificationDetails('bh_done', 'Download finished', importance: Importance.high, priority: Priority.high),
        windows: WindowsNotificationDetails(),
      ),
    );
  }
}
