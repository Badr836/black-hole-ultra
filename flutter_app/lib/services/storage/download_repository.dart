import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import '../../models/models.dart';

/// Local SQLite persistence for the download queue (works on Android & Windows via sqflite_ffi).
class DownloadRepository {
  late Database _db;

  Future<void> open() async {
    final dir = await getApplicationSupportDirectory();
    _db = await openDatabase(
      p.join(dir.path, 'blackhole.db'),
      version: 2,
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) await db.execute('ALTER TABLE downloads ADD COLUMN log TEXT');
      },
      onCreate: (db, v) async {
        await db.execute('''
          CREATE TABLE downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            thumbnail TEXT,
            uploader TEXT,
            duration INTEGER,
            kind TEXT NOT NULL,
            quality TEXT NOT NULL,
            audio_format_id TEXT,
            container TEXT NOT NULL,
            subtitles INTEGER NOT NULL DEFAULT 0,
            playlist INTEGER NOT NULL DEFAULT 0,
            output_dir TEXT NOT NULL,
            file_path TEXT,
            status TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0,
            speed TEXT,
            eta TEXT,
            total_bytes INTEGER,
            downloaded_bytes INTEGER,
            retries INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            log TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
          )
        ''');
      },
    );
  }

  Future<List<DownloadTask>> all() async {
    final rows = await _db.query('downloads', orderBy: 'created_at DESC');
    return rows.map(DownloadTask.fromMap).toList();
  }

  Future<DownloadTask> insert(DownloadTask t) async {
    final map = t.toMap()..remove('id');
    t.id = await _db.insert('downloads', map);
    return t;
  }

  Future<void> update(DownloadTask t) async {
    if (t.id == null) return;
    await _db.update('downloads', t.toMap()..remove('id'), where: 'id = ?', whereArgs: [t.id]);
  }

  Future<void> delete(int id) => _db.delete('downloads', where: 'id = ?', whereArgs: [id]);

  Future<void> deleteWhereStatus(List<DownloadStatus> statuses) async {
    final q = List.filled(statuses.length, '?').join(',');
    await _db.delete('downloads', where: 'status IN ($q)', whereArgs: statuses.map((s) => s.name).toList());
  }

  Future<void> resetStale() async {
    await _db.update(
      'downloads',
      {'status': DownloadStatus.paused.name, 'speed': null, 'eta': null},
      where: 'status IN (?, ?)',
      whereArgs: [DownloadStatus.downloading.name, DownloadStatus.converting.name],
    );
    final completed = await _db.query(
      'downloads',
      columns: ['id', 'file_path'],
      where: 'status = ?',
      whereArgs: [DownloadStatus.completed.name],
    );
    for (final row in completed) {
      final filePath = row['file_path'] as String?;
      if (filePath == null || !File(filePath).existsSync()) {
        await _db.update(
          'downloads',
          {
            'status': DownloadStatus.missing.name,
            'error': 'الملف المكتمل لم يعد موجوداً في مسار الحفظ. يمكنك إعادة تنزيله.',
          },
          where: 'id = ?',
          whereArgs: [row['id']],
        );
      }
    }
  }
}
