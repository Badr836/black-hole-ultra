enum DownloadStatus { queued, downloading, converting, paused, completed, failed, cancelled, missing }

enum MediaKind { video, audio }

const videoContainers = ['mp4', 'mkv', 'webm'];
const audioContainers = ['mp3', 'm4a', 'opus', 'wav', 'aac', 'flac', 'wma'];

class QualityPreset {
  final String value; // best | 4320 | 2160 | 1440 | 1080 | 720 | 480
  final String label;
  final String sub;
  const QualityPreset(this.value, this.label, this.sub);

  int? get height => value == 'best' ? null : int.tryParse(value);
}

const qualityPresets = [
  QualityPreset('best', 'أفضل جودة', 'تلقائي'),
  QualityPreset('4320', '8K', '4320p'),
  QualityPreset('2160', '4K', '2160p'),
  QualityPreset('1440', '2K', '1440p'),
  QualityPreset('1080', '1080p', 'Full HD'),
  QualityPreset('720', '720p', 'HD'),
  QualityPreset('480', '480p', 'SD'),
  QualityPreset('360', '360p', 'منخفض'),
  QualityPreset('240', '240p', 'موفّر'),
  QualityPreset('144', '144p', 'الأقل'),
];

class VideoOption {
  final String formatId;
  final int height;
  final int? fps;
  final String ext;
  final String vcodec;
  final int? filesize;
  final bool hasAudio;
  VideoOption({
    required this.formatId,
    required this.height,
    this.fps,
    required this.ext,
    required this.vcodec,
    this.filesize,
    this.hasAudio = false,
  });
  String get label => '${height}p${fps != null && fps! > 30 ? fps : ''}';
}

class AudioOption {
  final String formatId;
  final String ext;
  final String acodec;
  final double? abr;
  final int? filesize;
  AudioOption({required this.formatId, required this.ext, required this.acodec, this.abr, this.filesize});
  String get label => '${abr != null ? '${abr!.round()} kbps' : 'audio'} · $acodec · $ext';
}

class MediaInfo {
  final String id;
  final String title;
  final String? thumbnail;
  final String? uploader;
  final int? duration;
  final String webpageUrl;
  final String extractor;
  final bool isPlaylist;
  final int? entryCount;
  final List<VideoOption> videoOptions;
  final List<AudioOption> audioOptions;
  final List<String> subtitles;

  MediaInfo({
    required this.id,
    required this.title,
    this.thumbnail,
    this.uploader,
    this.duration,
    required this.webpageUrl,
    required this.extractor,
    this.isPlaylist = false,
    this.entryCount,
    this.videoOptions = const [],
    this.audioOptions = const [],
    this.subtitles = const [],
  });

  int get maxHeight => videoOptions.fold(0, (m, v) => v.height > m ? v.height : m);

  /// Parses `yt-dlp -J` output.
  factory MediaInfo.fromJson(Map<String, dynamic> j, {Map<String, dynamic>? formatsSource}) {
    final src = formatsSource ?? j;
    final formats = (src['formats'] as List? ?? []).cast<Map<String, dynamic>>();
    final vids = <String, VideoOption>{};
    final auds = <String, AudioOption>{};
    for (final f in formats) {
      final vcodec = (f['vcodec'] as String?) ?? 'none';
      final acodec = (f['acodec'] as String?) ?? 'none';
      final hasV = vcodec != 'none';
      final hasA = acodec != 'none';
      final size = (f['filesize'] ?? f['filesize_approx']) as num?;
      if ((f['protocol'] as String? ?? '').contains('mhtml')) continue;
      if (hasV && f['height'] != null) {
        final fps = (f['fps'] as num?)?.round();
        final key = '${f['height']}-$fps-${f['ext']}-${vcodec.split('.').first}';
        vids.putIfAbsent(
          key,
          () => VideoOption(
            formatId: f['format_id'].toString(),
            height: (f['height'] as num).toInt(),
            fps: fps,
            ext: f['ext'] ?? '',
            vcodec: vcodec.split('.').first,
            filesize: size?.toInt(),
            hasAudio: hasA,
          ),
        );
      } else if (hasA && !hasV) {
        final abr = (f['abr'] ?? f['tbr']) as num?;
        final key = '${f['ext']}-${acodec.split('.').first}-${abr?.round()}';
        auds.putIfAbsent(
          key,
          () => AudioOption(
            formatId: f['format_id'].toString(),
            ext: f['ext'] ?? '',
            acodec: acodec.split('.').first,
            abr: abr?.toDouble(),
            filesize: size?.toInt(),
          ),
        );
      }
    }
    final v = vids.values.toList()..sort((a, b) => b.height != a.height ? b.height - a.height : (b.fps ?? 0) - (a.fps ?? 0));
    final a = auds.values.toList()..sort((x, y) => ((y.abr ?? 0) - (x.abr ?? 0)).round());
    final thumbs = (src['thumbnails'] as List?)?.cast<Map<String, dynamic>>();
    final isPlaylist = j['_type'] == 'playlist';
    return MediaInfo(
      id: j['id']?.toString() ?? '',
      title: j['title'] ?? src['title'] ?? 'Untitled',
      thumbnail: src['thumbnail'] ?? thumbs?.last['url'] ?? j['thumbnail'],
      uploader: j['uploader'] ?? j['channel'] ?? src['uploader'],
      duration: (src['duration'] as num?)?.toInt(),
      webpageUrl: j['webpage_url'] ?? '',
      extractor: j['extractor_key'] ?? 'generic',
      isPlaylist: isPlaylist,
      entryCount: isPlaylist ? (j['playlist_count'] ?? (j['entries'] as List?)?.length) as int? : null,
      videoOptions: v,
      audioOptions: a,
      subtitles: ((src['subtitles'] as Map?)?.keys.cast<String>().toList()) ?? const [],
    );
  }
}

class DownloadTask {
  int? id;
  String url;
  String title;
  String? thumbnail;
  String? uploader;
  int? duration;
  MediaKind kind;
  String quality; // best | 1080 | id:<fmt>
  String? audioFormatId;
  String container;
  bool subtitles;
  bool playlist;
  String outputDir;
  String? filePath;
  DownloadStatus status;
  double progress;
  String? speed;
  String? eta;
  int? totalBytes;
  int? downloadedBytes;
  int retries;
  String? error;
  String? log;
  DateTime createdAt;
  DateTime? completedAt;

  DownloadTask({
    this.id,
    required this.url,
    required this.title,
    this.thumbnail,
    this.uploader,
    this.duration,
    this.kind = MediaKind.video,
    this.quality = 'best',
    this.audioFormatId,
    this.container = 'mp4',
    this.subtitles = false,
    this.playlist = false,
    required this.outputDir,
    this.filePath,
    this.status = DownloadStatus.queued,
    this.progress = 0,
    this.speed,
    this.eta,
    this.totalBytes,
    this.downloadedBytes,
    this.retries = 0,
    this.error,
    this.log,
    DateTime? createdAt,
    this.completedAt,
  }) : createdAt = createdAt ?? DateTime.now();

  bool get isActive => status == DownloadStatus.downloading || status == DownloadStatus.converting;
  bool get isPending => isActive || status == DownloadStatus.queued || status == DownloadStatus.paused;
  String? get fileName => filePath == null ? null : filePath!.split(RegExp(r'[\\/]')).last;

  Map<String, dynamic> toMap() => {
        'id': id,
        'url': url,
        'title': title,
        'thumbnail': thumbnail,
        'uploader': uploader,
        'duration': duration,
        'kind': kind.name,
        'quality': quality,
        'audio_format_id': audioFormatId,
        'container': container,
        'subtitles': subtitles ? 1 : 0,
        'playlist': playlist ? 1 : 0,
        'output_dir': outputDir,
        'file_path': filePath,
        'status': status.name,
        'progress': progress,
        'speed': speed,
        'eta': eta,
        'total_bytes': totalBytes,
        'downloaded_bytes': downloadedBytes,
        'retries': retries,
        'error': error,
        'log': log,
        'created_at': createdAt.millisecondsSinceEpoch,
        'completed_at': completedAt?.millisecondsSinceEpoch,
      };

  factory DownloadTask.fromMap(Map<String, dynamic> m) => DownloadTask(
        id: m['id'] as int?,
        url: m['url'],
        title: m['title'],
        thumbnail: m['thumbnail'],
        uploader: m['uploader'],
        duration: m['duration'],
        kind: MediaKind.values.byName(m['kind']),
        quality: m['quality'],
        audioFormatId: m['audio_format_id'],
        container: m['container'],
        subtitles: m['subtitles'] == 1,
        playlist: m['playlist'] == 1,
        outputDir: m['output_dir'],
        filePath: m['file_path'],
        status: DownloadStatus.values.byName(m['status']),
        progress: (m['progress'] as num?)?.toDouble() ?? 0,
        speed: m['speed'],
        eta: m['eta'],
        totalBytes: m['total_bytes'],
        downloadedBytes: m['downloaded_bytes'],
        retries: m['retries'] ?? 0,
        error: m['error'],
        log: m['log'],
        createdAt: DateTime.fromMillisecondsSinceEpoch(m['created_at']),
        completedAt: m['completed_at'] == null ? null : DateTime.fromMillisecondsSinceEpoch(m['completed_at']),
      );
}

String fmtBytes(num? n) {
  if (n == null || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  var v = n.toDouble();
  var i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return '${v.toStringAsFixed(i == 0 ? 0 : 1)} ${u[i]}';
}

String fmtDuration(int? sec) {
  if (sec == null || sec <= 0) return '—';
  final h = sec ~/ 3600, m = (sec % 3600) ~/ 60, s = sec % 60;
  String p(int n) => n.toString().padLeft(2, '0');
  return h > 0 ? '$h:${p(m)}:${p(s)}' : '$m:${p(s)}';
}
