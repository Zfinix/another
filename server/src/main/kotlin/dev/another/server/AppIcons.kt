package dev.another.server

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.system.exitProcess

/**
 * Prints each package's launcher icon as `<package> <base64 png>`, one per line, so the Mac app can show real
 * app icons next to phone notifications. Started with `app_process / dev.another.server.AppIcons <packages>`.
 */
object AppIcons {
    private const val SIZE = 96

    @JvmStatic
    fun main(args: Array<String>) {
        Workarounds.apply()
        val packageManager = FakeContext.instance.packageManager
        for (pkg in args) {
            try {
                val icon = packageManager.getApplicationIcon(pkg)
                val bitmap = render(icon)
                val png = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, png)
                println("$pkg ${Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP)}")
            } catch (e: Exception) {
                Ln.d("No icon for $pkg: ${e.message}")
            }
        }
        exitProcess(0)
    }

    /** Draws the whole icon at [SIZE] and leaves the shape to the Mac app, since launchers mask icons differently. */
    private fun render(icon: Drawable): Bitmap {
        val bitmap = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        icon.setBounds(0, 0, SIZE, SIZE)
        icon.draw(Canvas(bitmap))
        return bitmap
    }
}
