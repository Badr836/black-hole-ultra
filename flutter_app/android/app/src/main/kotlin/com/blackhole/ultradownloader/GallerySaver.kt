package com.blackhole.ultradownloader

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Publishes a finished download into a public media collection so Android's
 * Gallery / Photos app can see it — `Movies/BlackHole` for video,
 * `Music/BlackHole` for audio, `Pictures/BlackHole` for images.
 *
 * Why native code is required: a web page (or the bundled yt-dlp process) can
 * only write files; MediaStore is what makes a file *discoverable* by the
 * Gallery. There is no way to do this from JavaScript or from Dart alone.
 *
 * Safety rules:
 *  - The source file is copied, then verified (size + presence) before the
 *    source is deleted. If anything fails, the original stays untouched and a
 *    [Failure] is returned, so a failed publish never loses a download.
 *  - Nothing is published outside the app's own album folder.
 *  - No storage permission is needed on Android 10+ (scoped storage / MediaStore).
 */
object GallerySaver {

    class Failure(val code: String, message: String) : Exception(message)

    data class Saved(
        val uri: String,
        val absolutePath: String?,
        val displayName: String,
        val bytes: Long,
        val moved: Boolean,
    )

    private const val ALBUM = "BlackHole"

    fun save(context: Context, sourcePath: String, album: String = ALBUM, move: Boolean = true): Saved {
        val src = File(sourcePath)
        if (!src.exists() || !src.isFile) {
            throw Failure("NO_FILE", "الملف غير موجود أو ليس ملفاً: ${src.name}")
        }
        if (src.length() <= 0L) {
            throw Failure("EMPTY_FILE", "الملف فارغ: ${src.name}")
        }
        val safeAlbum = album.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.ifBlank { ALBUM }
        val mime = guessMime(src.name)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveScoped(context, src, safeAlbum, mime, move)
        } else {
            saveLegacy(context, src, safeAlbum, mime, move)
        }
    }

    // ---- Android 10+ (API 29): MediaStore with RELATIVE_PATH, no permission needed ----

    private fun saveScoped(context: Context, src: File, album: String, mime: String, move: Boolean): Saved {
        val resolver = context.contentResolver
        val kind = kindOf(mime)
        val collection: Uri = when (kind) {
            "video" -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            "audio" -> MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            "image" -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            else -> MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        }
        val relativePath = when (kind) {
            "video" -> "${Environment.DIRECTORY_MOVIES}/$album"
            "audio" -> "${Environment.DIRECTORY_MUSIC}/$album"
            "image" -> "${Environment.DIRECTORY_PICTURES}/$album"
            else -> "${Environment.DIRECTORY_DOWNLOADS}/$album"
        }

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, src.name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }

        val uri = resolver.insert(collection, values)
            ?: throw Failure("INSERT_FAILED", "تعذّر إنشاء سجل في MediaStore لهذا الملف")

        val written: Long
        try {
            written = resolver.openOutputStream(uri)?.use { out ->
                src.inputStream().use { input -> input.copyTo(out, 64 * 1024) }
            }?.let { src.length() } ?: 0L
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw Failure("COPY_FAILED", "تعذّر نسخ الملف إلى المعرض: ${e.message ?: e.javaClass.simpleName}")
        }

        // Finalise: the row becomes visible to Gallery apps only after this.
        runCatching {
            val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, done, null, null)
        }.onFailure {
            runCatching { resolver.delete(uri, null, null) }
            throw Failure("FINALIZE_FAILED", "تعذّر إتمام حفظ الملف في المعرض")
        }

        val (realName, realRelative) = queryLocation(resolver, uri, src.name, relativePath)
        val absolutePath = realRelative?.let {
            File(Environment.getExternalStorageDirectory(), "$it$realName")
        }?.takeIf { it.isFile && it.length() == src.length() }?.absolutePath

        // Move = remove the private/download copy, but only after a verified publish.
        val moved = if (move && absolutePath != null) {
            runCatching { src.delete() }.getOrDefault(false)
        } else false

        return Saved(
            uri = uri.toString(),
            absolutePath = absolutePath,
            displayName = realName,
            bytes = written,
            moved = moved,
        )
    }

    /** Reads back the name/path MediaStore actually chose (it de-duplicates names). */
    private fun queryLocation(
        resolver: android.content.ContentResolver,
        uri: Uri,
        fallbackName: String,
        fallbackRelative: String,
    ): Pair<String, String?> {
        return runCatching {
            resolver.query(
                uri,
                arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.RELATIVE_PATH),
                null,
                null,
                null,
            )?.use { c ->
                if (c.moveToFirst()) {
                    val name = c.getString(0)?.takeIf { it.isNotBlank() } ?: fallbackName
                    val rel = runCatching { c.getString(1) }.getOrNull()?.takeIf { it.isNotBlank() }
                        ?: fallbackRelative
                    name to rel
                } else fallbackName to fallbackRelative
            } ?: (fallbackName to fallbackRelative)
        }.getOrDefault(fallbackName to fallbackRelative)
    }

    // ---- Android 7–9 (API 24–28): public folder + MediaScanner ----

    private fun saveLegacy(context: Context, src: File, album: String, mime: String, move: Boolean): Saved {
        @Suppress("DEPRECATION")
        val base = Environment.getExternalStoragePublicDirectory(
            when (kindOf(mime)) {
                "audio" -> Environment.DIRECTORY_MUSIC
                "image" -> Environment.DIRECTORY_PICTURES
                "video" -> Environment.DIRECTORY_MOVIES
                else -> Environment.DIRECTORY_DOWNLOADS
            },
        )
        val dir = File(base, album)
        if (!dir.exists() && !dir.mkdirs()) {
            throw Failure("MKDIR_FAILED", "تعذّر إنشاء مجلد المعرض ${dir.name}")
        }
        val target = uniqueFile(dir, src.name)
        try {
            src.inputStream().use { input -> target.outputStream().use { output -> input.copyTo(output, 64 * 1024) } }
        } catch (e: Exception) {
            runCatching { target.delete() }
            throw Failure("COPY_FAILED", "تعذّر نسخ الملف إلى ${dir.absolutePath}: ${e.message ?: e.javaClass.simpleName}")
        }
        if (!target.isFile || target.length() != src.length()) {
            runCatching { target.delete() }
            throw Failure("VERIFY_FAILED", "فشل التحقق من الملف المنسوخ، وبقي الأصل كما هو")
        }

        // Make it appear in the Gallery.
        MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), arrayOf(mime), null)

        val moved = if (move) runCatching { src.delete() }.getOrDefault(false) else false
        return Saved(
            uri = Uri.fromFile(target).toString(),
            absolutePath = target.absolutePath,
            displayName = target.name,
            bytes = target.length(),
            moved = moved,
        )
    }

    private fun uniqueFile(dir: File, name: String): File {
        var candidate = File(dir, name)
        if (!candidate.exists()) return candidate
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var i = 1
        while (candidate.exists() && i < 1000) {
            candidate = File(dir, "$stem ($i)$ext")
            i += 1
        }
        return candidate
    }

    private fun kindOf(mime: String): String = when {
        mime.startsWith("video/") -> "video"
        mime.startsWith("audio/") -> "audio"
        mime.startsWith("image/") -> "image"
        else -> "other"
    }

    private fun guessMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "mp4", "m4v" -> "video/mp4"
        "mkv" -> "video/x-matroska"
        "webm" -> "video/webm"
        "mov" -> "video/quicktime"
        "avi" -> "video/x-msvideo"
        "ts" -> "video/mp2t"
        "3gp" -> "video/3gpp"
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "aac" -> "audio/aac"
        "opus", "ogg" -> "audio/ogg"
        "flac" -> "audio/flac"
        "wav" -> "audio/wav"
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> "application/octet-stream"
    }
}
