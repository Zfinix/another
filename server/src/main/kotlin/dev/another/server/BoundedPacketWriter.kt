package dev.another.server

import android.media.MediaCodec
import java.io.IOException
import java.nio.ByteBuffer
import java.util.ArrayDeque

/**
 * Sends encoded packets from a dedicated thread so a slow client never stalls the encoder.
 *
 * When more than [maxQueuedFrames] frames wait to be sent, the backlog is stale: it is dropped, a key frame is
 * requested and frames are skipped until it arrives. Latency stays bounded instead of growing with the backlog.
 * Config packets are never dropped.
 */
class BoundedPacketWriter(private val sink: PacketSink, private val maxQueuedFrames: Int) {

    private class Packet(val data: ByteArray, val pts: Long, val config: Boolean, val keyFrame: Boolean)

    companion object {
        private const val CLOSE_TIMEOUT_MS = 1000L
    }

    private val lock = Object()
    private val queue = ArrayDeque<Packet>()
    private var queuedFrames = 0
    private var dropUntilKeyFrame = false
    private var closed = false
    private var failure: IOException? = null
    private val thread = Thread(::run, "video-writer").apply { isDaemon = true }

    fun start() = thread.start()

    fun offer(buffer: ByteBuffer, info: MediaCodec.BufferInfo) {
        val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
        val keyFrame = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        val data = ByteArray(buffer.remaining()).also { buffer.get(it) }

        synchronized(lock) {
            failure?.let { throw it }
            if (!config) {
                if (keyFrame) {
                    dropUntilKeyFrame = false
                } else if (dropUntilKeyFrame) {
                    return
                }
                if (queuedFrames >= maxQueuedFrames) {
                    val dropped = dropQueuedFrames()
                    if (!keyFrame) {
                        dropUntilKeyFrame = true
                        VideoControl.requestKeyFrame()
                        Ln.i("Client behind: dropped ${dropped + 1} frames, waiting for a key frame")
                        return
                    }
                    Ln.i("Client behind: dropped $dropped frames before a key frame")
                }
                queuedFrames++
            }
            queue.addLast(Packet(data, info.presentationTimeUs, config, keyFrame))
            lock.notifyAll()
        }
    }

    private fun dropQueuedFrames(): Int {
        val before = queue.size
        queue.removeAll { !it.config }
        queuedFrames = 0
        return before - queue.size
    }

    private fun run() {
        while (true) {
            val packet = synchronized(lock) {
                while (queue.isEmpty() && !closed) {
                    try {
                        lock.wait()
                    } catch (e: InterruptedException) {
                        return
                    }
                }
                val next = queue.pollFirst() ?: return
                if (!next.config) queuedFrames--
                next
            }
            try {
                sink.writePacket(ByteBuffer.wrap(packet.data), packet.pts, packet.config, packet.keyFrame)
            } catch (e: IOException) {
                synchronized(lock) {
                    failure = e
                    queue.clear()
                    queuedFrames = 0
                }
                return
            }
        }
    }

    fun close() {
        synchronized(lock) {
            closed = true
            lock.notifyAll()
        }
        try {
            thread.join(CLOSE_TIMEOUT_MS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }
}
