import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import '../../models/models.dart';
import '../settings_service.dart';
import 'ytdlp_service.dart';

/// Windows / desktop implementation: spawns `yt-dlp.exe` and `ffmpeg.exe` via [Process].
///
/// Binary lookup order:
///   1. Settings override paths
///   2. `<exe dir>/bin/yt-dlp.exe` & `ffmpeg.exe` (ship them next to the app)
///   3. `%LOCALAPPDATA%/BlackHole/bin`
///   4. PATH
class YtDlpProcessService extends YtDlpService {
  YtDlpProcessService(super.settings);

  String? _ytdlp;
  String? _ffmpeg;

  String get exeDir => p.dirname(Platform.resolvedExecutable);

  @override
  Future<void> init() async {
    _ytdlp = await _resolve('yt-dlp', settings.ytdlpPath);
    _ffmpeg = await _resolve('ffmpeg', settings.ffmpegPath);
  }

  Future<String?> _resolve(String name, String? override) async {
    final exe = Platform.isWindows ? '$name.exe' : name;
    final candidates = <String>[
      if (override != null && override.isNotEmpty) override,
      p.join(exeDir, 'bin', exe),
      p.join(exeDir, exe),
      if (Platform.isWindows) p.join(Platform.environment['LOCALAPPDATA'] ?? '', 'BlackHole', 'bin', exe),
      if (!Platform.isWindows) ...['/usr/local/bin/$exe', '/usr/bin/$exe', '/opt/homebrew/bin/$exe'],
    ];
    for (final c in candidates) {
      if (c.isNotEmpty && File(c).existsSync()) return c;
    }
    try {
      final r = await Process.run(Platform.isWindows ? 'where' : 'which', [name]);
      if (r.exitCode == 0) {
        final line = (r.stdout as String).split(RegExp(r'\r?\n')).firstWhere((l) => l.trim().isNotEmpty, orElse: () => '');
        if (line.isNotEmpty) return line.trim();
      }
    } catch (_) {}
    return null;
  }

  String? get ytdlpPath => _ytdlp;
  String? get ffmpegPath => _ffmpeg;

  @override
  Future<bool> get ffmpegAvailable async => _ffmpeg != null;

  @override
  Future<String?> version() async {
    if (_ytdlp == null) return null;
    try {
      final r = await Process.run(_ytdlp!, ['--version']);
      return (r.stdout as String).trim();
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> update() async {
    if (_ytdlp == null) throw StateError('yt-dlp not found');
    await Process.run(_ytdlp!, ['-U']);
  }

  @override
  Future<String> convertToWma(String inputPath) async {
    if (_ffmpeg == null) throw Exception('يتطلب تحويل WMA وجود ffmpeg.exe');
    final output = '${p.withoutExtension(inputPath)}.wma';
    final result = await Process.run(
      _ffmpeg!,
      ['-y', '-i', inputPath, '-vn', '-c:a', 'wmav2', '-b:a', '192k', output],
      stdoutEncoding: utf8,
      stderrEncoding: utf8,
    );
    if (result.exitCode != 0 || !File(output).existsSync()) {
      throw Exception('فشل تحويل WMA عبر FFmpeg: ${(result.stderr as String).split('\n').lastWhere((x) => x.trim().isNotEmpty, orElse: () => 'code ${result.exitCode}')}');
    }
    if (inputPath != output) await File(inputPath).delete().catchError((_) => File(inputPath));
    return output;
  }

  @override
  Future<String> runJson(List<String> args) async {
    if (_ytdlp == null) {
      throw Exception('yt-dlp.exe غير موجود. ضعه في مجلد bin/ بجانب التطبيق أو حدّد مساره في الإعدادات.');
    }
    final r = await Process.run(_ytdlp!, args, stdoutEncoding: utf8, stderrEncoding: utf8).timeout(const Duration(seconds: 120));
    if (r.exitCode != 0) {
      final err = (r.stderr as String).split('\n').where((l) => l.contains('ERROR')).lastOrNull ?? 'yt-dlp failed (${r.exitCode})';
      throw Exception(err.replaceFirst('ERROR: ', ''));
    }
    return r.stdout as String;
  }

  @override
  Future<YtJob> download(DownloadTask task) async {
    if (_ytdlp == null) throw Exception('yt-dlp.exe غير موجود.');
    final args = buildDownloadArgs(
      task,
      ffmpeg: _ffmpeg != null,
      ffmpegLocation: _ffmpeg != null ? p.dirname(_ffmpeg!) : null,
    );
    final proc = await Process.start(_ytdlp!, args, runInShell: false);
    return _ProcessJob(proc);
  }
}

class _ProcessJob implements YtJob {
  final Process _proc;
  final _ctrl = StreamController<YtProgress>.broadcast();
  final _err = StringBuffer();
  late final Future<int> _exit;

  _ProcessJob(this._proc) {
    _proc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      final ev = YtDlpService.parseLine(line);
      if (ev != null) _ctrl.add(ev);
    });
    _proc.stderr.transform(utf8.decoder).listen(_err.write);
    _exit = _proc.exitCode.then((c) {
      _ctrl.close();
      return c;
    });
  }

  @override
  Stream<YtProgress> get progress => _ctrl.stream;
  @override
  Future<int> get exitCode => _exit;
  @override
  String get stderr => _err.toString();

  @override
  Future<void> kill() async {
    if (Platform.isWindows) {
      // Kill the whole tree (yt-dlp may spawn ffmpeg)
      await Process.run('taskkill', ['/pid', '${_proc.pid}', '/T', '/F']);
    } else {
      _proc.kill(ProcessSignal.sigterm);
    }
  }
}
