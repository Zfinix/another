package dev.another.server

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Looper
import android.os.SystemClock
import android.view.Surface
import java.io.IOException
import kotlin.concurrent.thread

/**
 * Encodes the mirrored screen with low-latency settings and restarts the encoder when the display size or
 * rotation changes, so the client receives a new config packet.
 */
class VideoEncoder(private val options: Options, private val sink: PacketSink) {

    companion object {
        private const val CLOCK_INTERVAL_MS = 500L
        private const val I_FRAME_INTERVAL_S = 10
        private const val REPEAT_FRAME_DELAY_US = 100_000L
        private const val DEQUEUE_TIMEOUT_US = 100_000L
        private const val WATCH_INTERVAL_MS = 200L
        private const val MAX_CONSECUTIVE_ERRORS = 3
        private const val KEY_MAX_FPS_TO_ENCODER = "max-fps-to-encoder"
        private const val KEY_LATENCY = "latency"
        private const val KEY_PRIORITY = "priority"
        private const val KEY_MAX_B_FRAMES = "max-bframes"
        private const val KEY_OPERATING_RATE = "operating-rate"
        private val MAX_SIZE_FALLBACK = intArrayOf(2560, 1920, 1600, 1280, 1024, 800)
    }

    private data class Size(val width: Int, val height: Int)

    @Volatile
    private var resetRequested = false

    @Volatile
    private var stopped = false

    @Volatile
    private var sessionScreen: DisplayInfo? = null

    @Volatile
    private var runningCodec: MediaCodec? = null

    private var firstFrameSent = false
    private var consecutiveErrors = 0

    fun stop() {
        stopped = true
    }

    fun run() {
        Looper.prepare()
        var screen = Displays.refresh() ?: throw IllegalStateException("Could not read the display")
        var maxSize = options.maxSize
        sink.writeVideoMeta(options.videoCodec.id, videoSize(screen, maxSize).width, videoSize(screen, maxSize).height)

        val writer = options.maxQueuedFrames.takeIf { it > 0 }?.let { BoundedPacketWriter(sink, it).apply { start() } }
        VideoControl.onResize = { requestReset() }
        val listening = Displays.listen(0) { checkDisplay() }
        if (!listening) Ln.w("Display listener unavailable, polling for rotation")
        val watcher = thread(name = "display-watcher", isDaemon = true) { watchDisplay() }
        val clock = options.sendClock.takeIf { it }?.let { thread(name = "clock", isDaemon = true) { sendClock() } }
        val capture = ScreenCapture()
        val codec = MediaCodec.createEncoderByType(options.videoCodec.mimeType)
        Ln.i("Using video encoder: ${codec.name}")
        val format = createFormat()

        try {
            while (!stopped) {
                screen = Displays.refresh() ?: screen
                sessionScreen = screen
                resetRequested = false
                VideoControl.takeVideoSize()?.let { requested ->
                    Ln.i("Resizing the video to max size ${requested.maxSize} at ${requested.maxFps} fps")
                    maxSize = requested.maxSize
                    if (requested.maxFps > 0) {
                        format.setFloat(KEY_MAX_FPS_TO_ENCODER, requested.maxFps.toFloat())
                        format.setFloat(KEY_OPERATING_RATE, requested.maxFps.toFloat())
                    }
                }
                val size = videoSize(screen, maxSize)
                format.setInteger(MediaFormat.KEY_WIDTH, size.width)
                format.setInteger(MediaFormat.KEY_HEIGHT, size.height)
                format.setInteger(MediaFormat.KEY_BIT_RATE, VideoControl.bitRateOr(options.videoBitRate))

                var surface: Surface? = null
                try {
                    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                    surface = codec.createInputSurface()
                    capture.start(surface, screen, size.width, size.height)
                    codec.start()
                    VideoControl.attach(codec)
                    runningCodec = codec
                    if (resetRequested) requestEndOfStream()
                    val ended = encode(codec, writer)
                    runningCodec = null
                    codec.stop()
                    if (ended) break
                } catch (e: IllegalStateException) {
                    maxSize = recover(e, size, maxSize)
                } catch (e: IllegalArgumentException) {
                    maxSize = recover(e, size, maxSize)
                } finally {
                    runningCodec = null
                    VideoControl.detach(codec)
                    codec.reset()
                    surface?.release()
                }
            }
        } finally {
            VideoControl.onResize = null
            watcher.interrupt()
            clock?.interrupt()
            writer?.close()
            codec.release()
            capture.release()
        }
    }

    /** Returns the max size to retry with, or rethrows when retrying cannot help. */
    private fun recover(error: RuntimeException, size: Size, maxSize: Int): Int {
        Ln.e("Encoding error: ${error.javaClass.name}: ${error.message}")
        if (firstFrameSent) {
            if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw error
            SystemClock.sleep(50)
            Ln.i("Retrying...")
            return maxSize
        }
        val current = maxOf(size.width, size.height)
        val smaller = MAX_SIZE_FALLBACK.firstOrNull { it < current } ?: throw error
        Ln.i("Retrying with max size $smaller...")
        return smaller
    }

    private fun encode(codec: MediaCodec, writer: BoundedPacketWriter?): Boolean {
        val info = MediaCodec.BufferInfo()
        while (!stopped) {
            if (resetRequested) return false
            val index = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)
            if (index < 0) continue
            try {
                val endOfStream = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                if (info.size > 0) {
                    val buffer = codec.getOutputBuffer(index) ?: continue
                    buffer.position(info.offset)
                    buffer.limit(info.offset + info.size)
                    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    if (!config) {
                        firstFrameSent = true
                        consecutiveErrors = 0
                    }
                    if (writer != null) {
                        writer.offer(buffer, info)
                    } else {
                        val keyFrame = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                        sink.writePacket(buffer, info.presentationTimeUs, config, keyFrame)
                    }
                }
                if (endOfStream) return !resetRequested
            } finally {
                codec.releaseOutputBuffer(index, false)
            }
        }
        return true
    }

    private fun sendClock() {
        try {
            while (!stopped) {
                sink.writeClock()
                Thread.sleep(CLOCK_INTERVAL_MS)
            }
        } catch (e: InterruptedException) {
            // stopping
        } catch (e: IOException) {
            // the client went away; the encoder notices on its next write
        }
    }

    private fun watchDisplay() {
        while (!stopped) {
            try {
                Thread.sleep(WATCH_INTERVAL_MS)
            } catch (e: InterruptedException) {
                return
            }
            checkDisplay()
        }
    }

    @Synchronized
    private fun checkDisplay() {
        if (resetRequested) return
        val fresh = try {
            Displays.refresh()
        } catch (e: Exception) {
            null
        } ?: return
        val session = sessionScreen ?: return
        if (fresh.width != session.width || fresh.height != session.height || fresh.rotation != session.rotation) {
            Ln.d("Display changed to ${fresh.width}x${fresh.height}, restarting the encoder")
            requestReset()
        }
    }

    private fun requestReset() {
        resetRequested = true
        requestEndOfStream()
    }

    /** Ends the running encoder now, so [encode] returns without waiting for the next output buffer. */
    private fun requestEndOfStream() {
        try {
            runningCodec?.signalEndOfInputStream()
        } catch (e: IllegalStateException) {
            // the encoder is already stopping
        }
    }

    private fun createFormat(): MediaFormat = MediaFormat().apply {
        setString(MediaFormat.KEY_MIME, options.videoCodec.mimeType)
        setInteger(MediaFormat.KEY_BIT_RATE, options.videoBitRate)
        setInteger(MediaFormat.KEY_FRAME_RATE, 60)
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED)
        }
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL_S)
        setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, REPEAT_FRAME_DELAY_US)
        setInteger(KEY_LATENCY, 1)
        setInteger(KEY_PRIORITY, 0)
        setInteger(KEY_MAX_B_FRAMES, 0)
        if (options.maxFps > 0) {
            setFloat(KEY_MAX_FPS_TO_ENCODER, options.maxFps)
            setFloat(KEY_OPERATING_RATE, options.maxFps)
        }
        for (option in options.videoCodecOptions) {
            when (val value = option.value) {
                is Int -> setInteger(option.key, value)
                is Long -> setLong(option.key, value)
                is Float -> setFloat(option.key, value)
                is String -> setString(option.key, value)
            }
            Ln.d("Video codec option set: ${option.key} = ${option.value}")
        }
    }

    /** Scales the long side down to [maxSize], keeps the aspect ratio and rounds both sides to multiples of 8. */
    private fun videoSize(screen: DisplayInfo, maxSize: Int): Size {
        var width = screen.width and 7.inv()
        var height = screen.height and 7.inv()
        if (maxSize > 0) {
            val portrait = height > width
            var major = if (portrait) height else width
            var minor = if (portrait) width else height
            if (major > maxSize) {
                minor = (minor * maxSize / major + 4) and 7.inv()
                major = maxSize
            }
            width = if (portrait) minor else major
            height = if (portrait) major else minor
        }
        return Size(width, height)
    }
}
