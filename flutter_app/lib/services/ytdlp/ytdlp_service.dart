import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../models/models.dart';
import '../settings_service.dart';
import 'format_selector.dart';
import 'ytdlp_android.dart';
import 'ytdlp_process.dart';

/// Progress event emitted by a running yt-dlp job.
class YtProgress {
  final String status; // downloading | finished | converting
  final int downloaded;
  final int total;
  final double? speedBps;
  final int? etaSec;
  final String? finalPath;
  const YtProgress({
    required this.status,
    this.downloaded = 0,
    this.total = 0,
    this.speedBps,
    this.etaSec,
    this.finalPath,
  });

  double get percent => total > 0 ? (downloaded / total * 100).clamp(0, 100) : 0;
}

/// Handle for a running download; allows cancellation (pause = cancel + keep .part).
abstract class YtJob {
  Stream<YtProgress> get progress;
  Future<int> get exitCode; // 0 = success
  String get stderr;
  Future<void> kill();
}

/// Platform-agnostic yt-dlp API. Two implementations:
///  - [YtDlpProcessService]  → Windows/Linux/macOS, spawns yt-dlp(.exe) + ffmpeg(.exe)
///  - [YtDlpAndroidService]  → Android, uses youtubedl-android (bundled Python + ffmpeg)
abstract class YtDlpService {
  final SettingsService settings;
  YtDlpService(this.settings);

  static YtDlpService forPlatform(SettingsService settings) {
    if (Platform.isAndroid) return YtDlpAndroidService(settings);
    return YtDlpProcessService(settings);
  }

  Future<void> init();
  Future<String?> version();
  Future<bool> get ffmpegAvailable;
  Future<void> update(); // self-update yt-dlp

  /// Optional final conversion used for WMA on desktop (yt-dlp itself does not
  /// expose WMA in --audio-format). Implemented by the Windows Process backend.
  Future<String> convertToWma(String inputPath);

  /// Runs `yt-dlp -J` and returns parsed info (first entry's formats for playlists).
  Future<MediaInfo> analyze(String url, {bool playlist = false}) async {
    final out = await runJson([
      '-J',
      '--no-warnings',
      '--no-check-certificates',
      playlist ? '--yes-playlist' : '--no-playlist',
      '--flat-playlist',
      url,
    ]);
    final j = jsonDecode(out) as Map<String, dynamic>;
    Map<String, dynamic>? src;
    if (j['_type'] == 'playlist') {
      final entries = (j['entries'] as List?)?.cast<Map<String, dynamic>>() ?? [];
      final first = entries.firstWhere((e) => e['url'] != null || e['webpage_url'] != null || e['id'] != null, orElse: () => {});
      final firstUrl = first['webpage_url'] ?? first['url'] ?? first['id'];
      if (firstUrl != null) {
        try {
          src = jsonDecode(await runJson(['-J', '--no-warnings', '--no-playlist', firstUrl.toString()])) as Map<String, dynamic>;
        } catch (_) {}
      }
    }
    return MediaInfo.fromJson(j, formatsSource: src);
  }

  /// Starts a download for [task]. Implementations build the process/stream.
  Future<YtJob> download(DownloadTask task);

  /// Raw JSON runner (stdout).
  Future<String> runJson(List<String> args);

  /// Android only: publish a finished file into the public media collection so
  /// the system Gallery/Photos app can see it (Movies/BlackHole for video, …).
  ///
  /// Returns the new absolute path when the file was moved there, or `null`
  /// when the platform has no gallery concept (Windows/Linux keep the file in
  /// the download folder). Must never throw away the original file on failure —
  /// implementations return `null` and the caller keeps the existing path.
  Future<String?> publishToGallery(String filePath) async => null;

  /// Shared argument builder used by both platforms.
  List<String> buildDownloadArgs(DownloadTask t, {required bool ffmpeg, String? ffmpegLocation}) {
    final s = settings;
    final template = s.fileNameTemplate;
    final outPath = '${t.outputDir}${Platform.pathSeparator}$template';
    final args = <String>[
      '--newline',
      '--progress',
      '--no-warnings',
      '--no-check-certificates',
      '--continue',
      '--no-overwrites',
      '--retries', '5',
      '--fragment-retries', '10',
      '--concurrent-fragments', '8',
      '--windows-filenames',
      '--print', 'after_move:filepath',
      '-o', outPath,
      '--progress-template',
      'download:[BH]%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s',
      t.playlist ? '--yes-playlist' : '--no-playlist',
    ];
    if (s.speedLimit.isNotEmpty) args.addAll(['--limit-rate', s.speedLimit]);
    if (ffmpegLocation != null) args.addAll(['--ffmpeg-location', ffmpegLocation]);

    if (!ffmpeg) {
      args.addAll(['-f', noFfmpegSelector(t.kind, t.quality)]);
      if (t.subtitles) args.addAll(['--write-subs', '--write-auto-subs', '--sub-langs', 'ar,en,-live_chat']);
      args.add(t.url);
      return args;
    }

    final sel = buildSelector(kind: t.kind, quality: t.quality, container: t.container, audioFormatId: t.audioFormatId);
    args.addAll(['-f', sel]);
    if (t.kind == MediaKind.audio) {
      args.addAll(['-x', '--audio-format', t.container == 'wma' ? 'wav' : t.container, '--audio-quality', '0']);
    } else {
      args.addAll(['--merge-output-format', t.container]);
      if (t.container != 'webm') args.addAll(['--remux-video', t.container]);
    }
    if (s.embedMetadata) args.add('--embed-metadata');
    if (s.embedThumbnail && ['mp4', 'mkv', 'mp3', 'm4a', 'flac', 'opus'].contains(t.container)) {
      args.add('--embed-thumbnail');
    }
    if (t.subtitles) {
      args.addAll(['--write-subs', '--write-auto-subs', '--sub-langs', 'ar,en,-live_chat']);
      if (t.kind == MediaKind.video) args.add('--embed-subs');
    }
    args.add(t.url);
    return args;
  }

  /// Parses one stdout line into a [YtProgress] or null.
  static YtProgress? parseLine(String raw) {
    final l = raw.trim();
    if (l.isEmpty) return null;
    if (l.startsWith('[BH]')) {
      final p = l.substring(4).split('|');
      if (p.length < 8) return null;
      int n(String s) => int.tryParse(s) ?? (double.tryParse(s)?.toInt() ?? 0);
      final downloaded = n(p[1]);
      var total = n(p[2]);
      if (total == 0) total = n(p[3]);
      final speed = double.tryParse(p[4]);
      final eta = int.tryParse(p[5]);
      if (total == 0 && n(p[7]) > 0) {
        // fragment-based progress
        return YtProgress(status: p[0], downloaded: n(p[6]), total: n(p[7]), speedBps: speed, etaSec: eta);
      }
      return YtProgress(status: p[0], downloaded: downloaded, total: total, speedBps: speed, etaSec: eta);
    }
    if (RegExp(r'^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|EmbedThumbnail|Metadata|EmbedSubtitle|FixupM3u8)\]').hasMatch(l)) {
      return const YtProgress(status: 'converting');
    }
    if (!l.startsWith('[') && (l.startsWith('/') || RegExp(r'^[A-Za-z]:\\').hasMatch(l))) {
      return YtProgress(status: 'path', finalPath: l);
    }
    return null;
  }
}
