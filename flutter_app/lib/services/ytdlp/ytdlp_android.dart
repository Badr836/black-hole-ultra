import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

import '../../models/models.dart';
import '../settings_service.dart';
import 'ytdlp_service.dart';

/// Android implementation.
///
/// Uses the native library **youtubedl-android** (https://github.com/yausername/youtubedl-android)
/// which bundles a Python runtime, yt-dlp and FFmpeg inside the APK — no root, no system install.
///
/// The Dart side talks to it over a small [MethodChannel]/[EventChannel] implemented in
/// `android/app/src/main/kotlin/.../YtDlpPlugin.kt` (included in this project). This avoids
/// depending on a third-party Flutter wrapper's API stability.
class YtDlpAndroidService extends YtDlpService {
  YtDlpAndroidService(super.settings);

  static const _method = MethodChannel('blackhole/ytdlp');
  static const _events = EventChannel('blackhole/ytdlp/progress');

  Stream<Map<dynamic, dynamic>>? _eventStream;

  @override
  Future<void> init() async {
    await _method.invokeMethod('init');
    _eventStream = _events.receiveBroadcastStream().cast<Map<dynamic, dynamic>>();
  }

  @override
  Future<bool> get ffmpegAvailable async => true; // bundled

  @override
  Future<String?> version() async => await _method.invokeMethod<String>('version');

  @override
  Future<void> update() async => _method.invokeMethod('update');

  @override
  Future<String> convertToWma(String inputPath) async {
    throw UnsupportedError('WMA متاح في نسخة Windows فقط؛ استخدم MP3 أو M4A على Android.');
  }

  @override
  Future<String> runJson(List<String> args) async {
    final out = await _method.invokeMethod<String>('run', {'args': args});
    return out ?? '';
  }

  /// Publishes a completed file into Movies/BlackHole through the native
  /// MediaStore bridge in MainActivity (see GallerySaver.kt).
  ///
  /// Returns the file's new absolute path when it was moved, or null when the
  /// native side could not confirm the move (the original file is then kept, so
  /// playback and the queue entry keep working).
  @override
  Future<String?> publishToGallery(String filePath) async {
    try {
      final res = await _method.invokeMethod<Map<dynamic, dynamic>>('saveToGallery', {
        'path': filePath,
        'album': 'BlackHole',
        'move': true,
      });
      if (res == null) return null;
      final newPath = res['absolutePath'] as String?;
      final moved = res['moved'] == true;
      if (moved && newPath != null) return newPath;
      return null;
    } on PlatformException {
      // Not fatal: the download itself succeeded and stays where it is.
      return null;
    } on MissingPluginException {
      return null;
    }
  }

  @override
  Future<YtJob> download(DownloadTask task) async {
    // ffmpeg is bundled by youtubedl-android; location is handled natively.
    final args = buildDownloadArgs(task, ffmpeg: true);
    final jobId = 'job_${task.id}_${DateTime.now().millisecondsSinceEpoch}';
    final job = _AndroidJob(jobId, _eventStream!, _method);
    await _method.invokeMethod('download', {'jobId': jobId, 'args': args});
    return job;
  }
}

class _AndroidJob implements YtJob {
  final String jobId;
  final MethodChannel _method;
  final _ctrl = StreamController<YtProgress>.broadcast();
  final _exit = Completer<int>();
  final _err = StringBuffer();
  late final StreamSubscription _sub;

  _AndroidJob(this.jobId, Stream<Map<dynamic, dynamic>> events, this._method) {
    _sub = events.where((e) => e['jobId'] == jobId).listen((e) {
      switch (e['type']) {
        case 'line':
          final ev = YtDlpService.parseLine(e['line'] as String);
          if (ev != null) _ctrl.add(ev);
          break;
        case 'stderr':
          _err.write(e['line']);
          break;
        case 'exit':
          if (!_exit.isCompleted) _exit.complete(e['code'] as int);
          _ctrl.close();
          _sub.cancel();
          break;
      }
    });
  }

  @override
  Stream<YtProgress> get progress => _ctrl.stream;
  @override
  Future<int> get exitCode => _exit.future;
  @override
  String get stderr => _err.toString();
  @override
  Future<void> kill() async {
    await _method.invokeMethod('cancel', {'jobId': jobId});
    if (!_exit.isCompleted) _exit.complete(-9);
  }
}

/// Helper: default Android downloads dir (scoped storage friendly).
Future<String> androidDefaultDownloadDir() async {
  final d = Directory('/storage/emulated/0/Download/BlackHole');
  if (!d.existsSync()) {
    try {
      d.createSync(recursive: true);
    } catch (_) {}
  }
  return d.path;
}
