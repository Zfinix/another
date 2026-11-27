package dev.another.server

import android.media.MediaCodec
import android.os.Bundle

/**
 * Live controls for the running encoder. The bitrate is remembered so an encoder recreated after rotation keeps it.
 * A size change needs a new encoder, so it is handed to the encoder loop through [onResize].
 */
object VideoControl {
    data class VideoSize(val maxSize: Int, val maxFps: Int)

    @Volatile
    private var codec: MediaCodec? = null

    @Volatile
    private var bitRateOverride = 0

    @Volatile
    private var pendingSize: VideoSize? = null

    @Volatile
    var onResize: (() -> Unit)? = null

    fun attach(mediaCodec: MediaCodec) {
        codec = mediaCodec
    }

    fun detach(mediaCodec: MediaCodec) {
        if (codec === mediaCodec) {
            codec = null
        }
    }

    fun bitRateOr(fallback: Int): Int = bitRateOverride.takeIf { it > 0 } ?: fallback

    fun setBitRate(bitRate: Int) {
        if (bitRate <= 0) return
        bitRateOverride = bitRate
        apply("bitrate $bitRate") { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bitRate) }
    }

    fun setVideoSize(maxSize: Int, maxFps: Int) {
        pendingSize = VideoSize(maxSize, maxFps)
        onResize?.invoke()
    }

    @Synchronized
    fun takeVideoSize(): VideoSize? = pendingSize.also { pendingSize = null }

    fun requestKeyFrame() = apply("key frame request") { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }

    private inline fun apply(what: String, fill: Bundle.() -> Unit) {
        val current = codec ?: return
        try {
            current.setParameters(Bundle().apply(fill))
            Ln.d("Applied $what")
        } catch (e: IllegalStateException) {
            Ln.w("Could not apply $what: ${e.message}")
        }
    }
}
