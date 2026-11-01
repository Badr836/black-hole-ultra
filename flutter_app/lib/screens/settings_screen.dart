import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/theme.dart';
import '../services/settings_service.dart';
import '../services/ytdlp/ytdlp_service.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final SettingsService s = context.read<SettingsService>();
  late final _template = TextEditingController(text: s.fileNameTemplate);
  late final _speed = TextEditingController(text: s.speedLimit);
  late final _ytdlp = TextEditingController(text: s.ytdlpPath ?? '');
  late final _ffmpeg = TextEditingController(text: s.ffmpegPath ?? '');
  String? _version;
  bool? _ffmpegOk;
  bool _updating = false;

  @override
  void initState() {
    super.initState();
    _probe();
  }

  Future<void> _probe() async {
    final yt = context.read<YtDlpService>();
    final v = await yt.version();
    final f = await yt.ffmpegAvailable;
    if (mounted) setState(() {
      _version = v;
      _ffmpegOk = f;
    });
  }

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<SettingsService>();
    return Scaffold(
      appBar: AppBar(title: const Text('الإعدادات')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('حالة المحركات', style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              _engine('yt-dlp', _version != null, _version ?? 'غير موجود'),
              _engine('FFmpeg', _ffmpegOk == true, _ffmpegOk == true ? 'متاح' : 'غير موجود'),
              const SizedBox(height: 8),
              Row(children: [
                OutlinedButton.icon(
                  icon: _updating ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.system_update_alt, size: 16),
                  label: const Text('تحديث yt-dlp'),
                  onPressed: _updating
                      ? null
                      : () async {
                          setState(() => _updating = true);
                          try {
                            await context.read<YtDlpService>().update();
                            await _probe();
                          } catch (e) {
                            if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('فشل التحديث: $e')));
                          } finally {
                            if (mounted) setState(() => _updating = false);
                          }
                        },
                ),
              ]),
              if (Platform.isWindows) ...[
                const SizedBox(height: 8),
                const Text(
                  'Windows: ضع yt-dlp.exe و ffmpeg.exe في مجلد bin/ بجانب التطبيق، أو ثبّتهما عبر:\nwinget install yt-dlp.yt-dlp Gyan.FFmpeg',
                  style: TextStyle(fontSize: 11, color: BHColors.muted),
                ),
              ],
              if (Platform.isAndroid)
                const Text('Android: yt-dlp و FFmpeg مدمجان داخل التطبيق (youtubedl-android).', style: TextStyle(fontSize: 11, color: BHColors.muted)),
            ]),
          ),
        ),
        const SizedBox(height: 14),
        _section('مجلد الحفظ الافتراضي'),
        Row(children: [
          Expanded(child: Text(settings.outputDir, textDirection: TextDirection.ltr, overflow: TextOverflow.ellipsis)),
          OutlinedButton.icon(
            icon: const Icon(Icons.folder_open),
            label: const Text('تغيير'),
            onPressed: () async {
              final d = await FilePicker.platform.getDirectoryPath();
              if (d != null) await s.save(outputDir: d);
            },
          ),
        ]),
        const SizedBox(height: 14),
        _section('قالب اسم الملف (yt-dlp output template)'),
        TextField(controller: _template, textDirection: TextDirection.ltr, onSubmitted: (v) => s.save(fileNameTemplate: v)),
        const Text('مثال: %(title)s [%(id)s].%(ext)s — للقوائم: %(playlist_index)s - %(title)s.%(ext)s', style: TextStyle(fontSize: 11, color: BHColors.muted)),
        const SizedBox(height: 14),
        Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _section('التحميلات المتزامنة: ${settings.maxConcurrent}'),
              Slider(min: 1, max: 8, divisions: 7, value: settings.maxConcurrent.toDouble(), onChanged: (v) => s.save(maxConcurrent: v.round())),
            ]),
          ),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _section('إعادة المحاولة: ${settings.maxRetries}'),
              Slider(min: 0, max: 10, divisions: 10, value: settings.maxRetries.toDouble(), onChanged: (v) => s.save(maxRetries: v.round())),
            ]),
          ),
        ]),
        _section('حد السرعة لكل تحميل (مثال: 2M أو 500K — فارغ = بلا حد)'),
        TextField(controller: _speed, textDirection: TextDirection.ltr, decoration: const InputDecoration(hintText: 'unlimited'), onSubmitted: (v) => s.save(speedLimit: v)),
        const SizedBox(height: 8),
        SwitchListTile(title: const Text('تضمين الصورة المصغرة في الملف'), value: settings.embedThumbnail, onChanged: (v) => s.save(embedThumbnail: v), activeColor: BHColors.violet),
        SwitchListTile(title: const Text('تضمين البيانات الوصفية'), value: settings.embedMetadata, onChanged: (v) => s.save(embedMetadata: v), activeColor: BHColors.violet),
        SwitchListTile(title: const Text('إشعارات التحميل'), value: settings.notifications, onChanged: (v) => s.save(notifications: v), activeColor: BHColors.violet),
        if (!Platform.isAndroid) ...[
          const SizedBox(height: 8),
          _section('مسار yt-dlp (اختياري)'),
          TextField(controller: _ytdlp, textDirection: TextDirection.ltr, decoration: const InputDecoration(hintText: r'C:\tools\yt-dlp.exe'), onSubmitted: (v) => s.save(ytdlpPath: v)),
          const SizedBox(height: 8),
          _section('مسار ffmpeg (اختياري)'),
          TextField(controller: _ffmpeg, textDirection: TextDirection.ltr, decoration: const InputDecoration(hintText: r'C:\ffmpeg\bin\ffmpeg.exe'), onSubmitted: (v) => s.save(ffmpegPath: v)),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: () async {
            await s.save(fileNameTemplate: _template.text, speedLimit: _speed.text, ytdlpPath: _ytdlp.text, ffmpegPath: _ffmpeg.text);
            await context.read<YtDlpService>().init();
            await _probe();
            if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم الحفظ ✓')));
          },
          child: const Text('حفظ الإعدادات'),
        ),
        const SizedBox(height: 24),
        const Text('🛡 لا إعلانات · لا تتبع · لا حسابات · كل شيء يعمل محلياً على جهازك.', style: TextStyle(fontSize: 12, color: BHColors.muted)),
        const Text('⚖️ استخدم التطبيق للمحتوى الذي تملك حق تحميله أو المرخّص لذلك فقط. لا يتجاوز التطبيق أي حماية تقنية (DRM).', style: TextStyle(fontSize: 12, color: BHColors.muted)),
      ]),
    );
  }

  Widget _section(String t) => Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(t, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: BHColors.muted)));

  Widget _engine(String name, bool ok, String info) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          Text(name, style: const TextStyle(fontFamily: 'monospace')),
          const Spacer(),
          Icon(Icons.circle, size: 10, color: ok ? BHColors.success : BHColors.danger),
          const SizedBox(width: 6),
          Text(info, style: TextStyle(fontSize: 12, color: ok ? BHColors.success : BHColors.danger), textDirection: TextDirection.ltr),
        ]),
      );
}
