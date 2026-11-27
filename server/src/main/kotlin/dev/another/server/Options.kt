package dev.another.server

import android.media.MediaFormat

enum class VideoCodec(val id: Int, val mimeType: String) {
    H264(0x68323634, MediaFormat.MIMETYPE_VIDEO_AVC),
    H265(0x68323635, MediaFormat.MIMETYPE_VIDEO_HEVC),
}

class CodecOption(val key: String, val value: Any)

class Options(
    val scid: Int,
    val tunnelForward: Boolean,
    val audio: Boolean,
    val control: Boolean,
    val videoCodec: VideoCodec,
    val maxSize: Int,
    val maxFps: Float,
    val videoBitRate: Int,
    val sendDeviceMeta: Boolean,
    val sendDummyByte: Boolean,
    val videoCodecOptions: List<CodecOption>,
    val maxQueuedFrames: Int,
    val sendClock: Boolean,
    val listenPort: Int,
    val token: ByteArray?,
    val debug: Boolean,
) {
    companion object {
        fun parse(args: Array<String>): Options {
            require(args.isNotEmpty()) { "Missing client version" }
            require(args[0] == Main.VERSION) {
                "The server version (${Main.VERSION}) does not match the client (${args[0]})"
            }

            var scid = -1
            var tunnelForward = false
            var audio = false
            var control = true
            var videoCodec = VideoCodec.H264
            var maxSize = 0
            var maxFps = 0f
            var videoBitRate = 8_000_000
            var sendDeviceMeta = true
            var sendDummyByte = true
            var videoCodecOptions = emptyList<CodecOption>()
            var maxQueuedFrames = 0
            var sendClock = false
            var listenPort = 0
            var token: ByteArray? = null
            var debug = false

            for (arg in args.drop(1)) {
                val eq = arg.indexOf('=')
                require(eq > 0) { "Invalid argument: $arg" }
                val key = arg.substring(0, eq)
                val value = arg.substring(eq + 1)
                when (key) {
                    "scid" -> {
                        scid = value.toLong(16).toInt()
                        require(scid and 0x7FFFFFFF.inv() == 0) { "scid must be a positive 31-bit integer" }
                    }
                    "tunnel_forward" -> tunnelForward = value.toBoolean()
                    "audio" -> audio = value.toBoolean()
                    "control" -> control = value.toBoolean()
                    "video_codec" -> videoCodec = when (value) {
                        "h264" -> VideoCodec.H264
                        "h265" -> VideoCodec.H265
                        else -> throw IllegalArgumentException("Unsupported video codec: $value")
                    }
                    "max_size" -> maxSize = value.toInt() and 7.inv()
                    "max_fps" -> maxFps = value.toFloat()
                    "video_bit_rate" -> videoBitRate = value.toInt()
                    "send_device_meta" -> sendDeviceMeta = value.toBoolean()
                    "send_dummy_byte" -> sendDummyByte = value.toBoolean()
                    "video_codec_options" -> videoCodecOptions = parseCodecOptions(value)
                    "max_queued_frames" -> maxQueuedFrames = value.toInt()
                    "send_clock" -> sendClock = value.toBoolean()
                    "listen_port" -> listenPort = value.toInt()
                    "token" -> token = parseHex(value)
                    "log_level" -> debug = value == "debug" || value == "verbose"
                    else -> Ln.d("Ignoring unknown option: $key")
                }
            }

            return Options(
                scid, tunnelForward, audio, control, videoCodec, maxSize, maxFps, videoBitRate,
                sendDeviceMeta, sendDummyByte, videoCodecOptions, maxQueuedFrames, sendClock, listenPort, token, debug,
            )
        }

        private fun parseHex(text: String): ByteArray {
            require(text.length % 2 == 0 && text.all { it in '0'..'9' || it in 'a'..'f' }) { "Invalid token" }
            return ByteArray(text.length / 2) { i -> text.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
        }

        /** Parses `key[:type]=value` pairs separated by commas, where type is int (default), long, float or string. */
        fun parseCodecOptions(text: String): List<CodecOption> = text.split(',').filter { it.isNotEmpty() }.map { item ->
            val eq = item.indexOf('=')
            require(eq > 0) { "Invalid codec option: $item" }
            val keyAndType = item.substring(0, eq)
            val raw = item.substring(eq + 1)
            val colon = keyAndType.indexOf(':')
            val key = if (colon == -1) keyAndType else keyAndType.substring(0, colon)
            val type = if (colon == -1) "int" else keyAndType.substring(colon + 1)
            val value: Any = when (type) {
                "int" -> raw.toInt()
                "long" -> raw.toLong()
                "float" -> raw.toFloat()
                "string" -> raw
                else -> throw IllegalArgumentException("Invalid codec option type: $type")
            }
            CodecOption(key, value)
        }
    }
}
