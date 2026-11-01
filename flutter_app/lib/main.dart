import 'dart:io';

import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import 'package:provider/provider.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:window_manager/window_manager.dart';

import 'core/theme.dart';
import 'services/download_engine.dart';
import 'services/notification_service.dart';
import 'services/settings_service.dart';
import 'services/storage/download_repository.dart';
import 'services/ytdlp/ytdlp_service.dart';
import 'screens/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  MediaKit.ensureInitialized();

  if (Platform.isWindows || Platform.isLinux) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
    await windowManager.ensureInitialized();
    await windowManager.setTitle('BlackHole Ultra Downloader');
    await windowManager.setMinimumSize(const Size(900, 600));
  }

  final settings = SettingsService();
  await settings.load();
  final repo = DownloadRepository();
  await repo.open();
  final notifications = NotificationService();
  await notifications.init();
  final ytdlp = YtDlpService.forPlatform(settings);
  await ytdlp.init();
  final engine = DownloadEngine(
    repo: repo,
    ytdlp: ytdlp,
    settings: settings,
    notifications: notifications,
  );
  await engine.recover();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: settings),
        ChangeNotifierProvider.value(value: engine),
        Provider.value(value: ytdlp),
      ],
      child: const BlackHoleApp(),
    ),
  );
}

class BlackHoleApp extends StatelessWidget {
  const BlackHoleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'BlackHole Ultra Downloader',
      debugShowCheckedModeBanner: false,
      theme: buildBlackHoleTheme(),
      locale: const Locale('ar'),
      builder: (context, child) => Directionality(
        textDirection: TextDirection.rtl,
        child: child ?? const SizedBox.shrink(),
      ),
      home: const HomeScreen(),
    );
  }
}
