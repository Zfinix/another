package dev.another.server

import android.graphics.Rect
import android.hardware.display.VirtualDisplay
import android.os.IBinder
import android.view.Surface

/**
 * Mirrors the screen into the encoder's input surface. The DisplayManager mirror path is tried first and the
 * SurfaceControl display path is the fallback for older Android versions, as in scrcpy (Apache-2.0, Genymobile).
 */
class ScreenCapture(private val displayId: Int = 0) {
    private var virtualDisplay: VirtualDisplay? = null
    private var display: IBinder? = null

    fun start(surface: Surface, screen: DisplayInfo, videoWidth: Int, videoHeight: Int) {
        release()
        try {
            virtualDisplay = Displays.createVirtualDisplay("another", videoWidth, videoHeight, displayId, surface)
            Ln.d("Display: using DisplayManager API")
        } catch (displayManagerError: Exception) {
            try {
                val token = SurfaceControlApi.createDisplay("another", Platform.canCreateSecureDisplay)
                display = token
                SurfaceControlApi.configure(
                    token, surface, Rect(0, 0, screen.width, screen.height), Rect(0, 0, videoWidth, videoHeight), screen.layerStack,
                )
                Ln.d("Display: using SurfaceControl API")
            } catch (surfaceControlError: Exception) {
                Ln.e("Could not create display using DisplayManager", displayManagerError)
                Ln.e("Could not create display using SurfaceControl", surfaceControlError)
                throw IllegalStateException("Could not create display")
            }
        }
    }

    fun release() {
        display?.let { runCatching { SurfaceControlApi.destroyDisplay(it) } }
        display = null
        virtualDisplay?.release()
        virtualDisplay = null
    }
}
