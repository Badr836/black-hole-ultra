import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blackhole_ultra_downloader/services/settings_service.dart';
import 'package:blackhole_ultra_downloader/services/ytdlp/ytdlp_android.dart';
import 'package:blackhole_ultra_downloader/services/ytdlp/ytdlp_service.dart';

/// Contract tests for the Android gallery bridge (`saveToGallery`).
///
/// These do not need a device: they mock the native side of the MethodChannel
/// exactly as `MainActivity.kt` + `GallerySaver.kt` answer it, so a regression in
/// the Dart half of the contract (method name, argument keys, result mapping)
/// is caught here. The Kotlin half is verified by the APK build itself; real
/// MediaStore behaviour still needs a physical device.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('blackhole/ytdlp');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('publishToGallery returns the new path when the native side moved the file', () async {
    MethodCall? seen;
    messenger.setMockMethodCallHandler(channel, (call) async {
      seen = call;
      return <String, Object?>{
        'uri': 'content://media/external/video/media/42',
        'absolutePath': '/storage/emulated/0/Movies/BlackHole/clip.mp4',
        'displayName': 'clip.mp4',
        'bytes': 1024,
        'moved': true,
      };
    });

    final service = YtDlpAndroidService(SettingsService());
    final result = await service.publishToGallery('/storage/emulated/0/Download/BlackHole/clip.mp4');

    expect(seen?.method, 'saveToGallery');
    expect((seen?.arguments as Map)['album'], 'BlackHole');
    expect((seen?.arguments as Map)['move'], true);
    expect(result, '/storage/emulated/0/Movies/BlackHole/clip.mp4');
  });

  test('a copy-only result (move=false) keeps the original path', () async {
    messenger.setMockMethodCallHandler(channel, (call) async {
      return <String, Object?>{'absolutePath': '/storage/emulated/0/Movies/BlackHole/clip.mp4', 'moved': false};
    });

    final service = YtDlpAndroidService(SettingsService());
    expect(await service.publishToGallery('/x/clip.mp4'), isNull);
  });

  test('a native failure never fails the download and never loses the file', () async {
    messenger.setMockMethodCallHandler(channel, (call) async {
      throw PlatformException(code: 'COPY_FAILED', message: 'لا مساحة');
    });

    final service = YtDlpAndroidService(SettingsService());
    expect(await service.publishToGallery('/x/clip.mp4'), isNull);
  });

  test('platforms without a gallery (desktop) are a no-op', () async {
    final service = YtDlpService.forPlatform(SettingsService());
    // On the test host this is the desktop backend; its default hook does nothing.
    expect(await service.publishToGallery('/tmp/clip.mp4'), isNull);
  });
}
