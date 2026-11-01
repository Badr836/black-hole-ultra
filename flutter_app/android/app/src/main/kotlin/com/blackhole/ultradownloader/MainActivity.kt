package com.blackhole.ultradownloader

import android.os.Handler
import android.os.Looper
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Bridges Flutter <-> youtubedl-android (bundled Python + yt-dlp + FFmpeg).
 *
 * Channels:
 *  - MethodChannel "blackhole/ytdlp":   init | version | update | run{args} | download{jobId,args} | cancel{jobId} | saveToGallery{path,album,move}
 *  - EventChannel  "blackhole/ytdlp/progress": {jobId,type:"line"|"stderr"|"exit", line|code}
 */
class MainActivity : FlutterActivity() {
    private val executor = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    private var sink: EventChannel.EventSink? = null
    private val jobs = ConcurrentHashMap<String, String>() // jobId -> processId
    private val canceled = ConcurrentHashMap.newKeySet<String>()

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, "blackhole/ytdlp/progress")
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(args: Any?, events: EventChannel.EventSink?) { sink = events }
                override fun onCancel(args: Any?) { sink = null }
            })

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "blackhole/ytdlp")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "init" -> executor.execute {
                        try {
                            YoutubeDL.getInstance().init(applicationContext)
                            FFmpeg.getInstance().init(applicationContext)
                            main.post { result.success(true) }
                        } catch (e: Exception) { main.post { result.error("INIT", e.message, null) } }
                    }
                    "version" -> executor.execute {
                        val v = try { YoutubeDL.getInstance().version(applicationContext) } catch (e: Exception) { null }
                        main.post { result.success(v) }
                    }
                    "update" -> executor.execute {
                        try {
                            YoutubeDL.getInstance().updateYoutubeDL(applicationContext, YoutubeDL.UpdateChannel.STABLE)
                            main.post { result.success(true) }
                        } catch (e: Exception) { main.post { result.error("UPDATE", e.message, null) } }
                    }
                    "run" -> {
                        val args = call.argument<List<String>>("args") ?: emptyList()
                        executor.execute {
                            try {
                                val req = YoutubeDLRequest(emptyList())
                                addArgs(req, args)
                                val resp = YoutubeDL.getInstance().execute(req)
                                main.post { result.success(resp.out) }
                            } catch (e: Exception) {
                                val msg = e.message?.lines()?.lastOrNull { it.contains("ERROR") }?.removePrefix("ERROR: ") ?: e.message
                                main.post { result.error("RUN", msg, null) }
                            }
                        }
                    }
                    "download" -> {
                        val jobId = call.argument<String>("jobId")!!
                        val args = call.argument<List<String>>("args") ?: emptyList()
                        jobs[jobId] = jobId
                        executor.execute {
                            var code = 0
                            try {
                                val req = YoutubeDLRequest(emptyList())
                                addArgs(req, args)
                                // youtubedl-android gives us a progress callback and raw output line
                                val resp = YoutubeDL.getInstance().execute(req, jobId) { progress, eta, line ->
                                    emit(jobId, "line", line)
                                }
                                resp.out.lines().forEach { emit(jobId, "line", it) }
                            } catch (e: Exception) {
                                code = if (canceled.remove(jobId)) -9 else 1
                                emit(jobId, "stderr", e.message ?: "yt-dlp failed")
                            } finally {
                                jobs.remove(jobId)
                                main.post { sink?.success(mapOf("jobId" to jobId, "type" to "exit", "code" to code)) }
                            }
                        }
                        result.success(true)
                    }
                    "cancel" -> {
                        val jobId = call.argument<String>("jobId")!!
                        canceled.add(jobId)
                        YoutubeDL.getInstance().destroyProcessById(jobId)
                        result.success(true)
                    }
                    // Publishes a finished file into the public media collection
                    // (Movies/BlackHole) so Android's Gallery/Photos can see it.
                    // Returns {uri, absolutePath, displayName, bytes, moved}.
                    "saveToGallery" -> {
                        val path = call.argument<String>("path")
                        if (path.isNullOrBlank()) {
                            result.error("ARGS", "path مطلوب", null)
                        } else {
                            val album = call.argument<String>("album") ?: "BlackHole"
                            val move = call.argument<Boolean>("move") ?: true
                            executor.execute {
                                try {
                                    val saved = GallerySaver.save(applicationContext, path, album, move)
                                    main.post {
                                        result.success(
                                            mapOf(
                                                "uri" to saved.uri,
                                                "absolutePath" to saved.absolutePath,
                                                "displayName" to saved.displayName,
                                                "bytes" to saved.bytes,
                                                "moved" to saved.moved,
                                            ),
                                        )
                                    }
                                } catch (e: GallerySaver.Failure) {
                                    main.post { result.error(e.code, e.message, null) }
                                } catch (e: Exception) {
                                    main.post { result.error("GALLERY", e.message ?: e.javaClass.simpleName, null) }
                                }
                            }
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    /** Splits a flat argv list into (option, value) pairs for YoutubeDLRequest. */
    private fun addArgs(req: YoutubeDLRequest, args: List<String>) {
        var i = 0
        val urls = mutableListOf<String>()
        while (i < args.size) {
            val a = args[i]
            if (a.startsWith("-")) {
                val next = args.getOrNull(i + 1)
                if (next != null && !next.startsWith("-") && !isUrl(next)) {
                    req.addOption(a, next); i += 2
                } else { req.addOption(a); i += 1 }
            } else { urls.add(a); i += 1 }
        }
        urls.forEach { req.addOption(it) }
    }

    private fun isUrl(s: String) = s.startsWith("http://") || s.startsWith("https://")

    private fun emit(jobId: String, type: String, line: String) {
        main.post { sink?.success(mapOf("jobId" to jobId, "type" to type, "line" to line)) }
    }
}
