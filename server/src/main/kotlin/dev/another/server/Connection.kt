package dev.another.server

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import java.io.Closeable
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.security.MessageDigest

/**
 * The sockets to the client, in the order the client expects them: video, audio, control.
 *
 * - Forward mode listens on the abstract socket and sends a dummy byte on the first socket so the client can tell a
 *   real connection from adb accepting before the server is up.
 * - Reverse mode connects to the client.
 * - Network mode listens on a TCP port so a client on Wi-Fi or a tailnet reaches the phone without tunnelling
 *   through adb. Every connection must start with the session token.
 */
class Connection private constructor(
    val video: Endpoint,
    val audio: Endpoint?,
    val control: Endpoint?,
) : Closeable {

    class Endpoint(val fd: FileDescriptor, val input: InputStream, val output: OutputStream, val close: () -> Unit)

    companion object {
        private const val DEVICE_NAME_LENGTH = 64
        private const val ACCEPT_TIMEOUT_MS = 15_000
        private const val TOKEN_TIMEOUT_MS = 3_000
        private const val SEND_BUFFER_BYTES = 128 * 1024

        fun open(options: Options): Connection {
            val count = 1 + (if (options.audio) 1 else 0) + (if (options.control) 1 else 0)
            val endpoints = if (options.listenPort > 0) listenTcp(options, count) else openLocal(options, count)
            val video = endpoints[0]
            val audio = if (options.audio) endpoints[1] else null
            val control = if (options.control) endpoints.last() else null
            return Connection(video, audio, control)
        }

        private fun openLocal(options: Options, count: Int): List<Endpoint> {
            val name = if (options.scid == -1) "scrcpy" else "scrcpy_%08x".format(options.scid)
            val sockets = mutableListOf<LocalSocket>()
            try {
                if (options.tunnelForward) {
                    LocalServerSocket(name).use { server ->
                        repeat(count) { index ->
                            val socket = server.accept()
                            sockets += socket
                            if (index == 0 && options.sendDummyByte) {
                                socket.outputStream.write(0)
                            }
                        }
                    }
                } else {
                    repeat(count) {
                        sockets += LocalSocket().apply { connect(LocalSocketAddress(name)) }
                    }
                }
            } catch (e: IOException) {
                sockets.forEach { runCatching { it.close() } }
                throw e
            }
            return sockets.map { socket ->
                Endpoint(socket.fileDescriptor, socket.inputStream, socket.outputStream) {
                    runCatching { socket.shutdownInput() }
                    runCatching { socket.shutdownOutput() }
                    runCatching { socket.close() }
                }
            }
        }

        private fun listenTcp(options: Options, count: Int): List<Endpoint> {
            val token = options.token ?: throw IOException("Network mode needs a token")
            val server = Os.socket(OsConstants.AF_INET, OsConstants.SOCK_STREAM, 0)
            val accepted = mutableListOf<FileDescriptor>()
            try {
                Os.setsockoptInt(server, OsConstants.SOL_SOCKET, OsConstants.SO_REUSEADDR, 1)
                Os.bind(server, InetAddress.getByName("0.0.0.0"), options.listenPort)
                Os.listen(server, count + 2)
                Ln.i("Listening for the client on port ${options.listenPort}")
                val deadline = System.currentTimeMillis() + ACCEPT_TIMEOUT_MS
                while (accepted.size < count) {
                    val remaining = (deadline - System.currentTimeMillis()).toInt()
                    if (remaining <= 0 || !waitReadable(server, remaining)) throw IOException("No client connected")
                    val client = Os.accept(server, null)
                    if (hasToken(client, token)) {
                        tune(client)
                        accepted += client
                    } else {
                        Ln.w("Rejected a connection without the session token")
                        runCatching { Os.close(client) }
                    }
                }
            } catch (e: Exception) {
                accepted.forEach { fd -> runCatching { Os.close(fd) } }
                throw if (e is IOException) e else IOException(e)
            } finally {
                runCatching { Os.close(server) }
            }
            return accepted.map { fd ->
                Endpoint(fd, FileInputStream(fd), FileOutputStream(fd)) {
                    runCatching { Os.shutdown(fd, OsConstants.SHUT_RDWR) }
                    runCatching { Os.close(fd) }
                }
            }
        }

        private fun hasToken(fd: FileDescriptor, token: ByteArray): Boolean {
            val received = ByteArray(token.size)
            var read = 0
            val deadline = System.currentTimeMillis() + TOKEN_TIMEOUT_MS
            while (read < received.size) {
                val remaining = (deadline - System.currentTimeMillis()).toInt()
                if (remaining <= 0 || !waitReadable(fd, remaining)) return false
                val n = try {
                    Os.read(fd, received, read, received.size - read)
                } catch (e: ErrnoException) {
                    return false
                }
                if (n <= 0) return false
                read += n
            }
            return MessageDigest.isEqual(received, token)
        }

        private fun waitReadable(fd: FileDescriptor, timeoutMs: Int): Boolean {
            val poll = StructPollfd().apply {
                this.fd = fd
                events = OsConstants.POLLIN.toShort()
            }
            return try {
                Os.poll(arrayOf(poll), timeoutMs) > 0
            } catch (e: ErrnoException) {
                e.errno == OsConstants.EINTR && waitReadable(fd, timeoutMs)
            }
        }

        /** A small send buffer keeps the backlog in the frame queue, where stale frames are dropped, not in the kernel. */
        private fun tune(fd: FileDescriptor) {
            runCatching { Os.setsockoptInt(fd, OsConstants.IPPROTO_TCP, OsConstants.TCP_NODELAY, 1) }
            runCatching { Os.setsockoptInt(fd, OsConstants.SOL_SOCKET, OsConstants.SO_SNDBUF, SEND_BUFFER_BYTES) }
        }
    }

    fun sendDeviceMeta(deviceName: String) {
        val buffer = ByteArray(DEVICE_NAME_LENGTH)
        val bytes = deviceName.toByteArray(Charsets.UTF_8)
        System.arraycopy(bytes, 0, buffer, 0, minOf(bytes.size, DEVICE_NAME_LENGTH - 1))
        video.output.write(buffer)
    }

    override fun close() {
        for (endpoint in listOfNotNull(video, audio, control)) {
            endpoint.close()
        }
    }
}
