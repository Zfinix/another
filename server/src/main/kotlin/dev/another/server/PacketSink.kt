package dev.another.server

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.FileDescriptor
import java.io.IOException
import java.nio.ByteBuffer

/**
 * Writes the scrcpy stream format: codec metadata once, then packets with a 12-byte header
 * (pts or flags in a u64, payload size in a u32). Writes go straight from the codec's buffer to the socket.
 */
class PacketSink(private val fd: FileDescriptor) {

    companion object {
        private const val FLAG_CONFIG = 1L shl 63
        private const val FLAG_KEY_FRAME = 1L shl 62

        /** A config packet with every pts bit set carries the device clock instead of codec data. */
        private const val CLOCK_MARKER = FLAG_CONFIG or (FLAG_KEY_FRAME - 1)
        private const val CLOCK_PAYLOAD_SIZE = 8
    }

    private val clockPayload = ByteBuffer.allocate(CLOCK_PAYLOAD_SIZE)

    private val header = ByteBuffer.allocate(12)

    fun writeVideoMeta(codecId: Int, width: Int, height: Int) {
        writeFully(ByteBuffer.allocate(12).putInt(codecId).putInt(width).putInt(height).flip() as ByteBuffer)
    }

    fun writeAudioMeta(codecId: Int) {
        writeFully(ByteBuffer.allocate(4).putInt(codecId).flip() as ByteBuffer)
    }

    /** Code 0 tells the client the stream is disabled (audio could not be captured) but mirroring goes on. */
    fun writeDisabled() {
        writeFully(ByteBuffer.allocate(4))
    }

    /**
     * Sends the monotonic clock that MediaCodec stamps captured frames with, read just before the write,
     * so the client can place every frame's capture time on its own clock.
     */
    @Synchronized
    fun writeClock() {
        header.clear()
        header.putLong(CLOCK_MARKER).putInt(CLOCK_PAYLOAD_SIZE).flip()
        clockPayload.clear()
        clockPayload.putLong(System.nanoTime() / 1000).flip()
        writeFully(header)
        writeFully(clockPayload)
    }

    @Synchronized
    fun writePacket(payload: ByteBuffer, pts: Long, config: Boolean, keyFrame: Boolean) {
        val ptsAndFlags = when {
            config -> FLAG_CONFIG
            keyFrame -> pts or FLAG_KEY_FRAME
            else -> pts
        }
        header.clear()
        header.putLong(ptsAndFlags).putInt(payload.remaining()).flip()
        writeFully(header)
        writeFully(payload)
    }

    private fun writeFully(buffer: ByteBuffer) {
        while (buffer.hasRemaining()) {
            try {
                Os.write(fd, buffer)
            } catch (e: ErrnoException) {
                if (e.errno != OsConstants.EINTR) {
                    throw IOException(e)
                }
            }
        }
    }
}
