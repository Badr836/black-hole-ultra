import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/theme.dart';
import '../models/models.dart';
import '../services/download_engine.dart';
import 'player_screen.dart';
import 'widgets/blackhole_logo.dart';

enum _Filter { all, active, completed, failed }

class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key});
  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  _Filter _filter = _Filter.all;

  bool _match(DownloadTask t) => switch (_filter) {
        _Filter.all => true,
        _Filter.active => t.isPending,
        _Filter.completed => t.status == DownloadStatus.completed,
        _Filter.failed => t.status == DownloadStatus.failed || t.status == DownloadStatus.cancelled || t.status == DownloadStatus.missing,
      };

  @override
  Widget build(BuildContext context) {
    final engine = context.watch<DownloadEngine>();
    final items = engine.all.where(_match).toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            for (final f in _Filter.values)
              ChoiceChip(
                label: Text(switch (f) { _Filter.all => 'الكل', _Filter.active => 'نشط', _Filter.completed => 'مكتمل', _Filter.failed => 'فشل/ملغى' }),
                selected: _filter == f,
                onSelected: (_) => setState(() => _filter = f),
              ),
            const SizedBox(width: 12),
            TextButton.icon(onPressed: engine.pauseAll, icon: const Icon(Icons.pause, size: 16), label: const Text('إيقاف الكل')),
            TextButton.icon(onPressed: engine.resumeAll, icon: const Icon(Icons.play_arrow, size: 16), label: const Text('استئناف الكل')),
            TextButton.icon(onPressed: engine.clearFinished, icon: const Icon(Icons.cleaning_services, size: 16), label: const Text('مسح المكتمل')),
          ]),
          const SizedBox(height: 12),
          if (items.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 40),
              child: Center(
                child: Column(children: [
                  BlackHoleLogo(size: 56),
                  SizedBox(height: 14),
                  Text('لا توجد تحميلات هنا بعد. الصق رابطاً في الأعلى وابدأ.', style: TextStyle(color: BHColors.muted)),
                ]),
              ),
            )
          else
            ...items.map((t) => Padding(padding: const EdgeInsets.only(bottom: 10), child: _Row(t))),
        ]),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final DownloadTask t;
  const _Row(this.t);

  static const _labels = {
    DownloadStatus.queued: 'في الطابور',
    DownloadStatus.downloading: 'جارٍ التحميل',
    DownloadStatus.converting: 'معالجة / دمج',
    DownloadStatus.paused: 'متوقف مؤقتاً',
    DownloadStatus.completed: 'مكتمل',
    DownloadStatus.failed: 'فشل',
    DownloadStatus.cancelled: 'ملغى',
    DownloadStatus.missing: 'الملف مفقود',
  };
  static const _colors = {
    DownloadStatus.queued: BHColors.violet2,
    DownloadStatus.downloading: BHColors.fuchsia,
    DownloadStatus.converting: BHColors.warning,
    DownloadStatus.paused: BHColors.muted,
    DownloadStatus.completed: BHColors.success,
    DownloadStatus.failed: BHColors.danger,
    DownloadStatus.cancelled: BHColors.muted,
    DownloadStatus.missing: BHColors.warning,
  };

  @override
  Widget build(BuildContext context) {
    final engine = context.read<DownloadEngine>();
    final color = _colors[t.status]!;
    final pct = t.status == DownloadStatus.completed ? 100.0 : t.progress;
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: Colors.black.withOpacity(0.3), border: Border.all(color: BHColors.border), borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Stack(children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: SizedBox(
                width: 100,
                height: 58,
                child: t.thumbnail != null ? Image.network(t.thumbnail!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const ColoredBox(color: BHColors.card2)) : const ColoredBox(color: BHColors.card2),
              ),
            ),
            Positioned(
              bottom: 4,
              left: 4,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(color: Colors.black87, borderRadius: BorderRadius.circular(4)),
                child: Text(t.container.toUpperCase(), style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold)),
              ),
            ),
          ]),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(t.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600))),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(border: Border.all(color: color.withOpacity(0.6)), borderRadius: BorderRadius.circular(999), color: color.withOpacity(0.12)),
                  child: Text(_labels[t.status]!, style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: color)),
                ),
              ]),
              Text(
                '${t.kind == MediaKind.audio ? '🎵 صوت' : '🎬 فيديو'} · ${t.quality == 'best' ? 'أفضل جودة' : t.quality.startsWith('id:') ? t.quality : '${t.quality}p'} · ${t.uploader ?? '—'} · ${fmtDuration(t.duration)}${t.playlist ? ' · قائمة' : ''}${t.subtitles ? ' · ترجمة' : ''}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: BHColors.muted),
              ),
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: LinearProgressIndicator(value: t.isActive && pct <= 0 ? null : pct / 100, minHeight: 7),
              ),
              const SizedBox(height: 4),
              Directionality(
                textDirection: TextDirection.ltr,
                child: Wrap(spacing: 12, children: [
                  Text('${pct.toStringAsFixed(1)}%', style: const TextStyle(fontSize: 11, color: BHColors.violet2, fontFamily: 'monospace')),
                  Text('${fmtBytes(t.downloadedBytes)} / ${fmtBytes(t.totalBytes)}', style: const TextStyle(fontSize: 11, color: BHColors.muted)),
                  if (t.speed != null) Text('⚡ ${t.speed}', style: const TextStyle(fontSize: 11, color: BHColors.fuchsia)),
                  if (t.eta != null) Text('⏱ ${t.eta}', style: const TextStyle(fontSize: 11, color: BHColors.muted)),
                  if (t.retries > 0) Text('↻ ${t.retries}', style: const TextStyle(fontSize: 11, color: BHColors.muted)),
                  if (t.fileName != null) Text('📄 ${t.fileName}', style: const TextStyle(fontSize: 11, color: BHColors.muted), overflow: TextOverflow.ellipsis),
                ]),
              ),
              if (t.error != null) Text(t.error!, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: BHColors.danger)),
            ]),
          ),
        ]),
        const SizedBox(height: 6),
        Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          if (t.status == DownloadStatus.downloading || t.status == DownloadStatus.queued || t.status == DownloadStatus.converting)
            IconButton(tooltip: 'إيقاف مؤقت', icon: const Icon(Icons.pause), onPressed: () => engine.pause(t.id!)),
          if (t.status == DownloadStatus.paused) IconButton(tooltip: 'استئناف', icon: const Icon(Icons.play_arrow), onPressed: () => engine.resume(t.id!)),
          if (t.status == DownloadStatus.failed || t.status == DownloadStatus.cancelled || t.status == DownloadStatus.missing)
            IconButton(tooltip: 'إعادة المحاولة', icon: const Icon(Icons.refresh), onPressed: () => engine.resume(t.id!)),
          if (t.isPending) IconButton(tooltip: 'إلغاء', icon: const Icon(Icons.close), onPressed: () => engine.cancel(t.id!)),
          if (t.status == DownloadStatus.completed && t.filePath != null)
            FilledButton.icon(
              style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8)),
              icon: const Icon(Icons.play_arrow, size: 18),
              label: const Text('تشغيل'),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => PlayerScreen(task: t))),
            ),
          IconButton(tooltip: 'فتح الرابط الأصلي', icon: const Icon(Icons.open_in_new, size: 18), onPressed: () => launchUrl(Uri.parse(t.url), mode: LaunchMode.externalApplication)),
          IconButton(tooltip: 'حذف من القائمة', icon: const Icon(Icons.delete_outline, color: BHColors.danger, size: 20), onPressed: () => engine.remove(t.id!)),
        ]),
      ]),
    );
  }
}
