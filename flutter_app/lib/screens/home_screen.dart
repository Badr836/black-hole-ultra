import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/theme.dart';
import '../services/download_engine.dart';
import 'queue_screen.dart';
import 'settings_screen.dart';
import 'widgets/add_download_card.dart';
import 'widgets/blackhole_logo.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final engine = context.watch<DownloadEngine>();
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(0.9, -1.2),
            radius: 1.4,
            colors: [Color(0x268B5CF6), BHColors.bg],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Row(
                  children: [
                    const BlackHoleLogo(size: 40),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          RichText(
                            text: const TextSpan(
                              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: BHColors.text),
                              children: [
                                TextSpan(text: 'BlackHole '),
                                TextSpan(text: 'Ultra Downloader', style: TextStyle(color: BHColors.violet2)),
                              ],
                            ),
                          ),
                          const Text('yt-dlp + FFmpeg · بدون إعلانات أو تتبع', style: TextStyle(fontSize: 11, color: BHColors.muted)),
                        ],
                      ),
                    ),
                    _Stat('نشط', engine.activeCount, glow: engine.activeCount > 0),
                    const SizedBox(width: 6),
                    _Stat('طابور', engine.queuedCount),
                    const SizedBox(width: 6),
                    _Stat('مكتمل', engine.completedCount),
                    const SizedBox(width: 6),
                    IconButton(
                      tooltip: 'الإعدادات',
                      icon: const Icon(Icons.settings_outlined),
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SettingsScreen())),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: const [
                    AddDownloadCard(),
                    SizedBox(height: 16),
                    QueueScreen(),
                    SizedBox(height: 24),
                    Center(
                      child: Text(
                        'استخدم التطبيق للمحتوى الذي تملك حق تحميله فقط. لا يتجاوز التطبيق أي حماية تقنية (DRM).',
                        style: TextStyle(fontSize: 11, color: BHColors.muted),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final int value;
  final bool glow;
  const _Stat(this.label, this.value, {this.glow = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.black.withOpacity(0.3),
        border: Border.all(color: BHColors.border),
        borderRadius: BorderRadius.circular(10),
        boxShadow: glow ? [BoxShadow(color: BHColors.violet.withOpacity(0.5), blurRadius: 16)] : null,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('$value', style: const TextStyle(fontWeight: FontWeight.bold, color: BHColors.violet2)),
          Text(label, style: const TextStyle(fontSize: 9, color: BHColors.muted)),
        ],
      ),
    );
  }
}
