import 'dart:io';

import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';

import '../core/theme.dart';
import '../models/models.dart';

/// Simple in-app media player (video + audio) built on media_kit (libmpv) —
/// plays MP4/MKV/WEBM/MP3/M4A/OPUS/WAV/AAC/FLAC on Android & Windows.
class PlayerScreen extends StatefulWidget {
  final DownloadTask task;
  const PlayerScreen({super.key, required this.task});

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  late final Player _player = Player();
  late final VideoController _controller = VideoController(_player);
  int? _width, _height;
  Duration _duration = Duration.zero;

  bool get _isAudio => widget.task.kind == MediaKind.audio || audioContainers.contains(widget.task.container);

  @override
  void initState() {
    super.initState();
    _player.open(Media(widget.task.filePath!));
    _player.stream.width.listen((w) => setState(() => _width = w));
    _player.stream.height.listen((h) => setState(() => _height = h));
    _player.stream.duration.listen((d) => setState(() => _duration = d));
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.task;
    final size = File(t.filePath!).existsSync() ? File(t.filePath!).lengthSync() : null;
    return Scaffold(
      appBar: AppBar(title: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis)),
      body: Column(children: [
        Expanded(
          child: _isAudio
              ? Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(20),
                    child: SizedBox(
                      width: 220,
                      height: 220,
                      child: t.thumbnail != null
                          ? Image.network(t.thumbnail!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const _Disc())
                          : const _Disc(),
                    ),
                  ),
                  const SizedBox(height: 24),
                  SizedBox(height: 0, child: Video(controller: _controller)), // keeps controls engine alive
                  _AudioControls(player: _player),
                ])
              : Video(controller: _controller, controls: AdaptiveVideoControls),
        ),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: const BoxDecoration(border: Border(top: BorderSide(color: BHColors.border))),
          child: Wrap(spacing: 28, runSpacing: 8, children: [
            _meta('الناشر', t.uploader ?? '—'),
            _meta('المدة', fmtDuration(_duration.inSeconds > 0 ? _duration.inSeconds : t.duration)),
            _meta('الصيغة', t.container.toUpperCase()),
            _meta('الحجم', fmtBytes(size ?? t.totalBytes)),
            if (_width != null && _height != null && _width! > 0) _meta('الأبعاد', '$_width×$_height'),
            _meta('اسم الملف', t.fileName ?? '—'),
            _meta('المسار', t.filePath ?? '—'),
          ]),
        ),
      ]),
    );
  }

  Widget _meta(String k, String v) => Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Text(k, style: const TextStyle(fontSize: 10, color: BHColors.muted)),
        Text(v, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500), textDirection: TextDirection.ltr),
      ]);
}

class _Disc extends StatelessWidget {
  const _Disc();
  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: const SweepGradient(colors: [BHColors.violet, BHColors.fuchsia, Color(0xFF4C1D95), BHColors.violet]),
          boxShadow: [BoxShadow(color: BHColors.fuchsia.withOpacity(0.4), blurRadius: 60)],
        ),
        child: const Center(child: Icon(Icons.music_note, size: 72, color: Colors.black)),
      );
}

class _AudioControls extends StatelessWidget {
  final Player player;
  const _AudioControls({required this.player});

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<Duration>(
      stream: player.stream.position,
      builder: (context, snap) {
        final pos = snap.data ?? Duration.zero;
        final dur = player.state.duration;
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Slider(
              value: dur.inMilliseconds == 0 ? 0 : pos.inMilliseconds.clamp(0, dur.inMilliseconds).toDouble(),
              max: dur.inMilliseconds.toDouble().clamp(1, double.infinity),
              onChanged: (v) => player.seek(Duration(milliseconds: v.toInt())),
            ),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              Text(fmtDuration(pos.inSeconds), style: const TextStyle(color: BHColors.muted)),
              const SizedBox(width: 16),
              IconButton(icon: const Icon(Icons.replay_10), onPressed: () => player.seek(pos - const Duration(seconds: 10))),
              StreamBuilder<bool>(
                stream: player.stream.playing,
                builder: (_, s) => IconButton.filled(
                  iconSize: 36,
                  icon: Icon((s.data ?? false) ? Icons.pause : Icons.play_arrow),
                  onPressed: player.playOrPause,
                ),
              ),
              IconButton(icon: const Icon(Icons.forward_10), onPressed: () => player.seek(pos + const Duration(seconds: 10))),
              const SizedBox(width: 16),
              Text(fmtDuration(dur.inSeconds), style: const TextStyle(color: BHColors.muted)),
            ]),
          ]),
        );
      },
    );
  }
}
