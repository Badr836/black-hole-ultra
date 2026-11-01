import 'package:file_picker/file_picker.dart';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/theme.dart';
import '../../models/models.dart';
import '../../services/download_engine.dart';
import '../../services/settings_service.dart';
import '../../services/ytdlp/ytdlp_service.dart';

/// URL input → analyze → pick kind / quality / container / subtitles → enqueue.
class AddDownloadCard extends StatefulWidget {
  const AddDownloadCard({super.key});

  @override
  State<AddDownloadCard> createState() => _AddDownloadCardState();
}

class _AddDownloadCardState extends State<AddDownloadCard> {
  final _url = TextEditingController();
  bool _playlist = false;
  bool _subs = false;
  bool _analyzing = false;
  bool _adding = false;
  String? _error;
  MediaInfo? _info;

  MediaKind _kind = MediaKind.video;
  String _quality = 'best';
  String _container = 'mp4';
  String? _audioFormatId;
  String? _outputDir;
  bool _advanced = false;

  Future<void> _analyze() async {
    final yt = context.read<YtDlpService>();
    setState(() {
      _analyzing = true;
      _error = null;
      _info = null;
    });
    try {
      final info = await yt.analyze(_url.text.trim(), playlist: _playlist);
      setState(() {
        _info = info;
        _quality = 'best';
      });
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      setState(() => _analyzing = false);
    }
  }

  Future<void> _add({bool quick = false}) async {
    final engine = context.read<DownloadEngine>();
    final settings = context.read<SettingsService>();
    setState(() {
      _adding = true;
      _error = null;
    });
    try {
      await engine.enqueue(DownloadTask(
        url: _info?.webpageUrl.isNotEmpty == true ? _info!.webpageUrl : _url.text.trim(),
        title: _info?.title ?? _url.text.trim(),
        thumbnail: _info?.thumbnail,
        uploader: _info?.uploader,
        duration: _info?.duration,
        kind: _kind,
        quality: quick ? 'best' : _quality,
        audioFormatId: _audioFormatId,
        container: _container,
        subtitles: _subs,
        playlist: _info?.isPlaylist ?? _playlist,
        outputDir: _outputDir ?? settings.outputDir,
      ));
      setState(() {
        _info = null;
        _url.clear();
      });
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('أُضيف إلى طابور التحميل')));
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      setState(() => _adding = false);
    }
  }

  void _switchKind(MediaKind k) => setState(() {
        _kind = k;
        _container = k == MediaKind.video ? 'mp4' : 'mp3';
        _quality = 'best';
      });

  @override
  Widget build(BuildContext context) {
    final info = _info;
    final maxH = info?.maxHeight ?? 0;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            LayoutBuilder(builder: (context, c) {
              final wide = c.maxWidth > 640;
              final field = TextField(
                controller: _url,
                textDirection: TextDirection.ltr,
                decoration: InputDecoration(
                  hintText: 'الصق رابط فيديو أو صوت من أي منصة مدعومة…',
                  prefixIcon: const Icon(Icons.link),
                  suffixIcon: IconButton(
                    tooltip: 'لصق الرابط من الحافظة',
                    icon: const Icon(Icons.content_paste),
                    onPressed: () async {
                      final data = await Clipboard.getData(Clipboard.kTextPlain);
                      final text = data?.text ?? '';
                      final match = RegExp(r'https?://\S+', caseSensitive: false).firstMatch(text);
                      final link = (match?.group(0) ?? text).trim();
                      if (link.startsWith('http://') || link.startsWith('https://')) {
                        setState(() {
                          _url.text = link;
                          _info = null;
                        });
                      } else if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('لا يوجد رابط صالح في الحافظة')));
                      }
                    },
                  ),
                ),
                onSubmitted: (_) => _analyze(),
              );
              final buttons = Row(mainAxisSize: MainAxisSize.min, children: [
                FilledButton.icon(
                  onPressed: _analyzing || _url.text.isEmpty && false ? null : _analyze,
                  icon: _analyzing ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.search),
                  label: Text(_analyzing ? 'جارٍ التحليل…' : 'تحليل الرابط'),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(onPressed: _adding ? null : () => _add(quick: true), icon: const Icon(Icons.bolt), label: const Text('تحميل سريع')),
              ]);
              return wide
                  ? Row(children: [Expanded(child: field), const SizedBox(width: 12), buttons])
                  : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [field, const SizedBox(height: 10), buttons]);
            }),
            const SizedBox(height: 8),
            Wrap(spacing: 16, children: [
              _check('تحميل قائمة التشغيل كاملة', _playlist, (v) => setState(() => _playlist = v)),
              _check('تحميل الترجمة (ar, en) إن وُجدت', _subs, (v) => setState(() => _subs = v)),
            ]),
            if (_error != null) ...[
              const SizedBox(height: 10),
              _ErrorBox(_error!),
            ],
            if (info != null) ...[
              const SizedBox(height: 16),
              _MediaHeader(info: info),
              const SizedBox(height: 16),
              _label('نوع التحميل'),
              Wrap(spacing: 8, children: [
                ChoiceChip(label: const Text('🎬 فيديو (دمج الصوت تلقائياً)'), selected: _kind == MediaKind.video, onSelected: (_) => _switchKind(MediaKind.video)),
                ChoiceChip(label: const Text('🎵 صوت فقط'), selected: _kind == MediaKind.audio, onSelected: (_) => _switchKind(MediaKind.audio)),
              ]),
              const SizedBox(height: 12),
              _label('الصيغة'),
              Wrap(
                spacing: 8,
                children: (_kind == MediaKind.video
                        ? videoContainers
                        : audioContainers.where((c) => c != 'wma' || Platform.isWindows).toList())
                    .map((c) => ChoiceChip(label: Text(c.toUpperCase()), selected: _container == c, onSelected: (_) => setState(() => _container = c)))
                    .toList(),
              ),
              if (_kind == MediaKind.video) ...[
                const SizedBox(height: 12),
                _label('الجودة (أعلى جودة متاحة: ${maxH > 0 ? '${maxH}p' : '—'})'),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: qualityPresets.map((q) {
                    final hasSuitableStream = q.height == null || info.videoOptions.any((v) => v.height <= q.height!);
                    final unavailable = q.height != null && info.videoOptions.isNotEmpty && (q.height! > maxH || !hasSuitableStream);
                    return ChoiceChip(
                      label: Text('${q.label}  ${q.sub}', style: TextStyle(color: unavailable ? BHColors.muted : null)),
                      selected: _quality == q.value,
                      onSelected: unavailable ? null : (_) => setState(() => _quality = q.value),
                    );
                  }).toList(),
                ),
              ],
              const SizedBox(height: 8),
              TextButton(
                onPressed: () => setState(() => _advanced = !_advanced),
                child: Text(_advanced ? '▲ إخفاء الخيارات المتقدمة' : '▼ خيارات متقدمة (صيغة خام / مجلد الحفظ)'),
              ),
              if (_advanced) ...[
                if (_kind == MediaKind.video)
                  DropdownButtonFormField<String>(
                    value: _quality.startsWith('id:') ? _quality : '',
                    decoration: const InputDecoration(labelText: 'صيغة الفيديو الخام'),
                    items: [
                      const DropdownMenuItem(value: '', child: Text('— تلقائي حسب الجودة —')),
                      ...info.videoOptions.map((v) => DropdownMenuItem(
                            value: 'id:${v.formatId}',
                            child: Text('${v.label} · ${v.ext} · ${v.vcodec} · ${fmtBytes(v.filesize)}${v.hasAudio ? ' · +audio' : ''} [${v.formatId}]', textDirection: TextDirection.ltr),
                          )),
                    ],
                    onChanged: (v) => setState(() => _quality = (v == null || v.isEmpty) ? 'best' : v),
                  ),
                const SizedBox(height: 10),
                DropdownButtonFormField<String>(
                  value: _kind == MediaKind.audio ? (_quality.startsWith('id:') ? _quality.substring(3) : '') : (_audioFormatId ?? ''),
                  decoration: const InputDecoration(labelText: 'صيغة الصوت الخام'),
                  items: [
                    const DropdownMenuItem(value: '', child: Text('— أفضل صوت تلقائياً —')),
                    ...info.audioOptions.map((a) => DropdownMenuItem(value: a.formatId, child: Text('${a.label} · ${fmtBytes(a.filesize)} [${a.formatId}]', textDirection: TextDirection.ltr))),
                  ],
                  onChanged: (v) => setState(() {
                    if (_kind == MediaKind.audio) {
                      _quality = (v == null || v.isEmpty) ? 'best' : 'id:$v';
                    } else {
                      _audioFormatId = (v == null || v.isEmpty) ? null : v;
                    }
                  }),
                ),
                const SizedBox(height: 10),
                Row(children: [
                  Expanded(
                    child: Text('مجلد الحفظ: ${_outputDir ?? context.read<SettingsService>().outputDir}', textDirection: TextDirection.ltr, overflow: TextOverflow.ellipsis),
                  ),
                  OutlinedButton.icon(
                    icon: const Icon(Icons.folder_open),
                    label: const Text('اختيار'),
                    onPressed: () async {
                      final d = await FilePicker.platform.getDirectoryPath();
                      if (d != null) setState(() => _outputDir = d);
                    },
                  ),
                ]),
              ],
              const SizedBox(height: 12),
              Row(children: [
                const Expanded(
                  child: Text('سيُسمّى الملف تلقائياً، ويُدمج/يُحوّل عبر FFmpeg عند الحاجة.', style: TextStyle(fontSize: 11, color: BHColors.muted)),
                ),
                FilledButton.icon(
                  onPressed: _adding ? null : () => _add(),
                  icon: const Icon(Icons.download),
                  label: const Text('إضافة إلى طابور التحميل'),
                ),
              ]),
            ],
          ],
        ),
      ),
    );
  }

  Widget _check(String label, bool v, ValueChanged<bool> on) => InkWell(
        onTap: () => on(!v),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Checkbox(value: v, onChanged: (x) => on(x ?? false), activeColor: BHColors.violet),
          Text(label, style: const TextStyle(fontSize: 13, color: BHColors.muted)),
        ]),
      );

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(t.toUpperCase(), style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: BHColors.muted, letterSpacing: 1)),
      );
}

class _MediaHeader extends StatelessWidget {
  final MediaInfo info;
  const _MediaHeader({required this.info});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: Colors.black.withOpacity(0.3), border: Border.all(color: BHColors.border), borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 140,
            height: 80,
            child: info.thumbnail != null ? Image.network(info.thumbnail!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => const ColoredBox(color: BHColors.card2)) : const ColoredBox(color: BHColors.card2),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(info.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(
              '${info.uploader ?? info.extractor} · ${fmtDuration(info.duration)}${info.isPlaylist && info.entryCount != null ? ' · قائمة تشغيل (${info.entryCount})' : ''}',
              style: const TextStyle(fontSize: 12, color: BHColors.muted),
            ),
            if (info.subtitles.isNotEmpty) Text('ترجمات: ${info.subtitles.take(6).join(', ')}', style: const TextStyle(fontSize: 11, color: BHColors.muted)),
          ]),
        ),
      ]),
    );
  }
}

class _ErrorBox extends StatelessWidget {
  final String msg;
  const _ErrorBox(this.msg);
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: const Color(0x334C0519), border: Border.all(color: const Color(0xFF881337)), borderRadius: BorderRadius.circular(10)),
        child: Text(msg, style: const TextStyle(color: Color(0xFFFECDD3), fontSize: 13)),
      );
}
