import '../../models/models.dart';

/// Builds a yt-dlp `-f` selector. Mirrors the web app's logic.
String buildSelector({
  required MediaKind kind,
  required String quality, // best | 2160 | 1080 | id:<fmt>
  required String container,
  String? audioFormatId,
}) {
  if (kind == MediaKind.audio) {
    if (quality.startsWith('id:')) return '${quality.substring(3)}/bestaudio/best';
    return 'bestaudio/best';
  }
  final audio = audioFormatId != null && audioFormatId.isNotEmpty ? '($audioFormatId/bestaudio)' : 'bestaudio';
  if (quality.startsWith('id:')) {
    final id = quality.substring(3);
    return '$id+$audio/$id/best';
  }
  final h = quality == 'best' ? null : int.tryParse(quality);
  final hf = h != null ? '[height<=$h]' : '';
  late final String videoAlts;
  switch (container) {
    case 'mp4':
      videoAlts = 'bestvideo$hf[vcodec^=avc1]/bestvideo$hf[ext=mp4]/bestvideo$hf';
      break;
    case 'webm':
      videoAlts = 'bestvideo$hf[ext=webm]/bestvideo$hf[vcodec^=vp9]/bestvideo$hf';
      break;
    default:
      videoAlts = 'bestvideo$hf';
  }
  return '($videoAlts)+$audio/best$hf/best';
}

/// When ffmpeg is unavailable we can only download single-file formats.
String noFfmpegSelector(MediaKind kind, String quality) {
  if (kind == MediaKind.audio) return 'bestaudio[ext=m4a]/bestaudio/best';
  final h = quality == 'best' || quality.startsWith('id:') ? null : int.tryParse(quality);
  final hf = h != null ? '[height<=$h]' : '';
  return 'best$hf[ext=mp4]/best$hf/best';
}

String qualityLabel(String quality) {
  if (quality == 'best') return 'أفضل جودة';
  if (quality.startsWith('id:')) return 'format ${quality.substring(3)}';
  return '${quality}p';
}
