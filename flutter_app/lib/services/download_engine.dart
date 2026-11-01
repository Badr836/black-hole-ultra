import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import '../models/models.dart';
import 'notification_service.dart';
import 'settings_service.dart';
import 'storage/download_repository.dart';
import 'ytdlp/ytdlp_service.dart';

/// IDM-style download manager:
///  - persistent queue (SQLite)
///  - N concurrent jobs (settings.maxConcurrent)
///  - pause (kill process, keep .part) / resume (yt-dlp --continue)
///  - automatic retry with back-off
///  - live speed / ETA / size / percent
///  - notifications + Android foreground service while active
class DownloadEngine extends ChangeNotifier {
  final DownloadRepository repo;
  final YtDlpService ytdlp;
  final SettingsService settings;
  final NotificationService notifications;

  final List<DownloadTask> tasks = [];
  final Map<int, YtJob> _jobs = {};
  final Set<int> _pausedByUser = {};
  final Set<int> _cancelled = {};
  final Map<int, DateTime> _lastNotify = {};
  bool _pumping = false;

  DownloadEngine({required this.repo, required this.ytdlp, required this.settings, required this.notifications}) {
    settings.addListener(pump);
  }

  UnmodifiableListView<DownloadTask> get all => UnmodifiableListView(tasks);
  int get activeCount => tasks.where((t) => t.isActive).length;
  int get queuedCount => tasks.where((t) => t.status == DownloadStatus.queued).length;
  int get completedCount => tasks.where((t) => t.status == DownloadStatus.completed).length;

  /// Load persisted queue; anything that was "downloading" when the app died becomes paused.
  Future<void> recover() async {
    await repo.resetStale();
    tasks
      ..clear()
      ..addAll(await repo.all());
    notifyListeners();
    pump();
  }

  Future<DownloadTask> enqueue(DownloadTask t) async {
    await repo.insert(t);
    tasks.insert(0, t);
    notifyListeners();
    pump();
    return t;
  }

  Future<void> pump() async {
    if (_pumping) return;
    _pumping = true;
    try {
      final free = settings.maxConcurrent - _jobs.length;
      if (free <= 0) return;
      final queued = tasks.where((t) => t.status == DownloadStatus.queued && !_jobs.containsKey(t.id)).toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
      for (final t in queued.take(free)) {
        await _start(t);
      }
    } finally {
      _pumping = false;
      await notifications.setBackgroundActive(_jobs.isNotEmpty, text: '${_jobs.length} تحميل نشط');
    }
  }

  Future<void> _start(DownloadTask t) async {
    t
      ..status = DownloadStatus.downloading
      ..error = null
      ..speed = null
      ..eta = null;
    await _persist(t);
    late YtJob job;
    try {
      job = await ytdlp.download(t);
    } catch (e) {
      t
        ..status = DownloadStatus.failed
        ..error = e.toString();
      await _persist(t);
      return;
    }
    _jobs[t.id!] = job;
    String? finalPath;

    job.progress.listen((ev) {
      switch (ev.status) {
        case 'downloading':
        case 'finished':
          t
            ..status = DownloadStatus.downloading
            ..downloadedBytes = ev.downloaded
            ..totalBytes = ev.total > 0 ? ev.total : t.totalBytes
            ..progress = ev.percent.clamp(0, 99.9)
            ..speed = ev.speedBps != null ? '${fmtBytes(ev.speedBps)}/s' : null
            ..eta = ev.etaSec != null ? fmtDuration(ev.etaSec) : null;
          _throttledNotify(t);
          break;
        case 'converting':
          t
            ..status = DownloadStatus.converting
            ..progress = 99.9
            ..speed = null
            ..eta = null;
          notifyListeners();
          break;
        case 'path':
          finalPath = ev.finalPath;
          break;
      }
    });

    unawaited(job.exitCode.then((code) async {
      _jobs.remove(t.id);
      if (_cancelled.remove(t.id)) {
        // already marked cancelled
      } else if (_pausedByUser.remove(t.id)) {
        t
          ..status = DownloadStatus.paused
          ..speed = null
          ..eta = null;
      } else if (code == 0) {
        try {
          if (t.kind == MediaKind.audio && t.container == 'wma') {
            if (finalPath == null) throw Exception('لم يُرجع yt-dlp مسار الملف الوسيط.');
            t
              ..status = DownloadStatus.converting
              ..progress = 99.9
              ..speed = null
              ..eta = null;
            await _persist(t);
            finalPath = await ytdlp.convertToWma(finalPath!);
          }
          // Android: move the finished video into Movies/BlackHole so it shows
          // up in the Gallery. Best-effort — a failure here never fails the job
          // and never deletes the downloaded file.
          if (t.kind == MediaKind.video && finalPath != null) {
            final published = await ytdlp.publishToGallery(finalPath!);
            if (published != null) finalPath = published;
          }
          t
            ..status = DownloadStatus.completed
            ..progress = 100
            ..speed = null
            ..eta = null
            ..filePath = finalPath
            ..completedAt = DateTime.now();
          if (settings.notifications) await notifications.done(t.id!, t.title, success: true);
        } catch (e) {
          t
            ..status = DownloadStatus.failed
            ..error = e.toString().replaceFirst('Exception: ', '')
            ..speed = null
            ..eta = null;
          if (settings.notifications) await notifications.done(t.id!, t.title, success: false, error: t.error);
        }
      } else {
        final err = _extractError(job.stderr, code);
        if (t.retries < settings.maxRetries) {
          t
            ..retries += 1
            ..status = DownloadStatus.queued
            ..error = 'إعادة المحاولة (${t.retries}/${settings.maxRetries}): $err';
          await Future.delayed(Duration(seconds: 2 * t.retries));
        } else {
          t
            ..status = DownloadStatus.failed
            ..error = err
            ..speed = null
            ..eta = null;
          if (settings.notifications) await notifications.done(t.id!, t.title, success: false, error: err);
        }
      }
      await _persist(t);
      pump();
    }));
  }

  Future<void> pause(int id) async {
    final t = _byId(id);
    if (t == null) return;
    final job = _jobs[id];
    if (job != null) {
      _pausedByUser.add(id);
      await job.kill();
    } else if (t.status == DownloadStatus.queued) {
      t.status = DownloadStatus.paused;
      await _persist(t);
    }
  }

  Future<void> resume(int id) async {
    final t = _byId(id);
    if (t == null) return;
    if (t.status == DownloadStatus.paused || t.status == DownloadStatus.failed || t.status == DownloadStatus.cancelled || t.status == DownloadStatus.missing) {
      t
        ..status = DownloadStatus.queued
        ..error = null
        ..retries = 0;
      await _persist(t);
      pump();
    }
  }

  Future<void> cancel(int id) async {
    final t = _byId(id);
    if (t == null) return;
    final job = _jobs[id];
    if (job != null) {
      _cancelled.add(id);
      await job.kill();
    }
    t
      ..status = DownloadStatus.cancelled
      ..speed = null
      ..eta = null;
    await _persist(t);
  }

  Future<void> remove(int id) async {
    final job = _jobs[id];
    if (job != null) {
      _cancelled.add(id);
      await job.kill();
    }
    tasks.removeWhere((t) => t.id == id);
    await repo.delete(id);
    notifyListeners();
    pump();
  }

  Future<void> pauseAll() async {
    for (final id in _jobs.keys.toList()) {
      await pause(id);
    }
    for (final t in tasks.where((t) => t.status == DownloadStatus.queued)) {
      t.status = DownloadStatus.paused;
      await repo.update(t);
    }
    notifyListeners();
  }

  Future<void> resumeAll() async {
    for (final t in tasks.where((t) => t.status == DownloadStatus.paused || t.status == DownloadStatus.failed)) {
      t
        ..status = DownloadStatus.queued
        ..error = null;
      await repo.update(t);
    }
    notifyListeners();
    pump();
  }

  Future<void> clearFinished() async {
    await repo.deleteWhereStatus([DownloadStatus.completed, DownloadStatus.cancelled]);
    tasks.removeWhere((t) => t.status == DownloadStatus.completed || t.status == DownloadStatus.cancelled);
    notifyListeners();
  }

  DownloadTask? _byId(int id) => tasks.cast<DownloadTask?>().firstWhere((t) => t!.id == id, orElse: () => null);

  Future<void> _persist(DownloadTask t) async {
    await repo.update(t);
    notifyListeners();
  }

  void _throttledNotify(DownloadTask t) {
    final now = DateTime.now();
    final last = _lastNotify[t.id!];
    if (last == null || now.difference(last).inMilliseconds > 400) {
      _lastNotify[t.id!] = now;
      notifyListeners();
      unawaited(repo.update(t));
      if (settings.notifications) unawaited(notifications.progress(t.id!, t.title, t.progress, t.speed));
    }
  }

  String _extractError(String stderr, int code) {
    final lines = stderr.split('\n').where((l) => l.contains('ERROR')).toList();
    if (lines.isNotEmpty) return lines.last.replaceFirst(RegExp(r'^.*ERROR:\s*'), '').trim();
    return 'yt-dlp exited with code $code';
  }
}
