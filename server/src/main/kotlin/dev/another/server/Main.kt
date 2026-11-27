package dev.another.server

import android.os.Build
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread
import kotlin.system.exitProcess

/**
 * Another's on-device server, started through `adb shell app_process`. It mirrors the screen and audio and
 * injects input, speaking the scrcpy 2.7 wire protocol plus Another's live video controls.
 */
object Main {
    const val VERSION = "another-1"

    @JvmStatic
    fun main(args: Array<String>) {
        Thread.setDefaultUncaughtExceptionHandler { t, e -> Ln.e("Exception on thread $t", e) }

        val options = try {
            Options.parse(args)
        } catch (e: IllegalArgumentException) {
            Ln.e(e.message ?: "Invalid arguments")
            exitProcess(1)
        }
        Ln.debug = options.debug
        Workarounds.apply()
        Ln.i("Device: [${Build.MANUFACTURER}] ${Build.BRAND} ${Build.MODEL} (Android ${Build.VERSION.RELEASE})")

        val connection = try {
            Connection.open(options)
        } catch (e: Exception) {
            Ln.e("Could not connect to the client", e)
            exitProcess(1)
        }

        val finished = CountDownLatch(1)
        if (options.sendDeviceMeta) {
            connection.sendDeviceMeta(Build.MODEL)
        }

        val encoder = VideoEncoder(options, PacketSink(connection.video.fd))
        thread(name = "video") {
            try {
                encoder.run()
            } catch (e: Exception) {
                Ln.d("Video stopped: ${e.message}")
            } finally {
                finished.countDown()
            }
        }

        val audio = connection.audio?.let { AudioCapture(PacketSink(it.fd)) }
        if (audio != null) {
            thread(name = "audio", isDaemon = true) {
                try {
                    audio.run()
                } catch (e: Exception) {
                    Ln.d("Audio stopped: ${e.message}")
                }
            }
        }

        connection.control?.let { endpoint ->
            thread(name = "control") {
                try {
                    Controller(endpoint.input).run()
                } finally {
                    finished.countDown()
                }
            }
        }

        finished.await()
        encoder.stop()
        audio?.stop()
        connection.close()
        exitProcess(0)
    }
}
