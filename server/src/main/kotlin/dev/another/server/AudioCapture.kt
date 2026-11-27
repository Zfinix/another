package dev.another.server

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.content.ComponentName
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import java.io.IOException
import java.nio.ByteBuffer

/**
 * Captures the device's audio output as raw 48 kHz stereo 16-bit PCM. Needs Android 11+.
 * The Android 11 foreground workaround and PTS fixing follow scrcpy (Apache-2.0, Genymobile).
 */
@TargetApi(Build.VERSION_CODES.R)
class AudioCapture(private val sink: PacketSink) {

    companion object {
        private const val RAW_CODEC_ID = 0x00726177
        private const val SAMPLE_RATE = 48_000
        private const val CHANNELS = 2
        private const val BYTES_PER_SAMPLE = 2
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_STEREO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

        /** The system captures audio in blocks of 1024 samples; reading more only adds latency. */
        private const val MAX_READ_SIZE = 1024 * CHANNELS * BYTES_PER_SAMPLE
        private const val ONE_SAMPLE_US = (1_000_000L + SAMPLE_RATE - 1) / SAMPLE_RATE
    }

    @Volatile
    private var stopped = false

    fun stop() {
        stopped = true
    }

    fun run() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Ln.w("Audio disabled: it is not supported before Android 11")
            sink.writeDisabled()
            return
        }
        val recorder = try {
            start()
        } catch (e: Exception) {
            Ln.e("Could not start audio capture", e)
            sink.writeDisabled()
            return
        }
        try {
            sink.writeAudioMeta(RAW_CODEC_ID)
            record(recorder)
        } catch (e: IOException) {
            Ln.d("Audio stream closed: ${e.message}")
        } finally {
            recorder.release()
        }
    }

    private fun record(recorder: AudioRecord) {
        val buffer = ByteBuffer.allocateDirect(MAX_READ_SIZE)
        val timestamp = AudioTimestamp()
        var previousRecorderTimestamp = -1L
        var previousPts = 0L
        var nextPts = 0L

        while (!stopped) {
            buffer.clear()
            val read = recorder.read(buffer, MAX_READ_SIZE)
            if (read < 0) throw IOException("Could not read audio: $read")
            if (read == 0) continue

            var pts: Long
            if (recorder.getTimestamp(timestamp, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS &&
                timestamp.nanoTime != previousRecorderTimestamp
            ) {
                pts = timestamp.nanoTime / 1000
                previousRecorderTimestamp = timestamp.nanoTime
            } else {
                if (nextPts == 0L) nextPts = System.nanoTime() / 1000
                pts = nextPts
            }
            nextPts = pts + read * 1_000_000L / (CHANNELS * BYTES_PER_SAMPLE * SAMPLE_RATE)
            if (previousPts != 0L && pts < previousPts + ONE_SAMPLE_US) {
                pts = previousPts + ONE_SAMPLE_US
            }
            previousPts = pts

            buffer.position(0)
            buffer.limit(read)
            sink.writePacket(buffer, pts, config = false, keyFrame = false)
        }
    }

    private fun start(): AudioRecord {
        if (Build.VERSION.SDK_INT != Build.VERSION_CODES.R) {
            return createRecorder().apply { startRecording() }
        }
        // Android 11 only allows audio capture from the foreground: briefly bring a shell activity up.
        Activities.start(
            Intent(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(ComponentName(FakeContext.PACKAGE_NAME, "com.android.shell.HeapDumpActivity")),
        )
        try {
            var attempts = 5
            while (true) {
                SystemClock.sleep(100)
                try {
                    return createRecorder().apply { startRecording() }
                } catch (e: UnsupportedOperationException) {
                    if (--attempts == 0) throw e
                }
            }
        } finally {
            Activities.forceStop(FakeContext.PACKAGE_NAME)
        }
    }

    @SuppressLint("MissingPermission", "WrongConstant")
    private fun createRecorder(): AudioRecord {
        val builder = AudioRecord.Builder()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setContext(FakeContext.instance)
        }
        builder.setAudioSource(MediaRecorder.AudioSource.REMOTE_SUBMIX)
        builder.setAudioFormat(
            AudioFormat.Builder().setEncoding(ENCODING).setSampleRate(SAMPLE_RATE).setChannelMask(CHANNEL_CONFIG).build(),
        )
        val minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, ENCODING)
        if (minBufferSize > 0) {
            builder.setBufferSizeInBytes(8 * minBufferSize)
        }
        return builder.build()
    }
}
