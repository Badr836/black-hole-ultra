import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SettingsService extends ChangeNotifier {
  late SharedPreferences _prefs;

  String outputDir = '';
  String fileNameTemplate = '%(title)s [%(id)s].%(ext)s';
  int maxConcurrent = 3;
  int maxRetries = 3;
  String speedLimit = ''; // e.g. "2M"
  bool embedThumbnail = true;
  bool embedMetadata = true;
  bool notifications = true;
  String? ytdlpPath;
  String? ffmpegPath;

  Future<void> load() async {
    _prefs = await SharedPreferences.getInstance();
    outputDir = _prefs.getString('outputDir') ?? await _defaultDir();
    fileNameTemplate = _prefs.getString('fileNameTemplate') ?? fileNameTemplate;
    maxConcurrent = _prefs.getInt('maxConcurrent') ?? 3;
    maxRetries = _prefs.getInt('maxRetries') ?? 3;
    speedLimit = _prefs.getString('speedLimit') ?? '';
    embedThumbnail = _prefs.getBool('embedThumbnail') ?? true;
    embedMetadata = _prefs.getBool('embedMetadata') ?? true;
    notifications = _prefs.getBool('notifications') ?? true;
    ytdlpPath = _prefs.getString('ytdlpPath');
    ffmpegPath = _prefs.getString('ffmpegPath');
    Directory(outputDir).createSync(recursive: true);
  }

  Future<String> _defaultDir() async {
    if (Platform.isAndroid) {
      final d = Directory('/storage/emulated/0/Download/BlackHole');
      try {
        d.createSync(recursive: true);
        return d.path;
      } catch (_) {
        return (await getExternalStorageDirectory())!.path;
      }
    }
    final downloads = await getDownloadsDirectory();
    return p.join(downloads?.path ?? (await getApplicationDocumentsDirectory()).path, 'BlackHole');
  }

  Future<void> save({
    String? outputDir,
    String? fileNameTemplate,
    int? maxConcurrent,
    int? maxRetries,
    String? speedLimit,
    bool? embedThumbnail,
    bool? embedMetadata,
    bool? notifications,
    String? ytdlpPath,
    String? ffmpegPath,
  }) async {
    if (outputDir != null) {
      this.outputDir = outputDir;
      await _prefs.setString('outputDir', outputDir);
      try {
        Directory(outputDir).createSync(recursive: true);
      } catch (_) {}
    }
    if (fileNameTemplate != null) {
      this.fileNameTemplate = fileNameTemplate;
      await _prefs.setString('fileNameTemplate', fileNameTemplate);
    }
    if (maxConcurrent != null) {
      this.maxConcurrent = maxConcurrent.clamp(1, 8);
      await _prefs.setInt('maxConcurrent', this.maxConcurrent);
    }
    if (maxRetries != null) {
      this.maxRetries = maxRetries.clamp(0, 10);
      await _prefs.setInt('maxRetries', this.maxRetries);
    }
    if (speedLimit != null) {
      this.speedLimit = speedLimit.trim();
      await _prefs.setString('speedLimit', this.speedLimit);
    }
    if (embedThumbnail != null) {
      this.embedThumbnail = embedThumbnail;
      await _prefs.setBool('embedThumbnail', embedThumbnail);
    }
    if (embedMetadata != null) {
      this.embedMetadata = embedMetadata;
      await _prefs.setBool('embedMetadata', embedMetadata);
    }
    if (notifications != null) {
      this.notifications = notifications;
      await _prefs.setBool('notifications', notifications);
    }
    if (ytdlpPath != null) {
      this.ytdlpPath = ytdlpPath.isEmpty ? null : ytdlpPath;
      await _prefs.setString('ytdlpPath', ytdlpPath);
    }
    if (ffmpegPath != null) {
      this.ffmpegPath = ffmpegPath.isEmpty ? null : ffmpegPath;
      await _prefs.setString('ffmpegPath', ffmpegPath);
    }
    notifyListeners();
  }
}
