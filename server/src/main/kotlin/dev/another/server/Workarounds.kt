package dev.another.server

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Application
import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Looper
import android.os.Process

/**
 * A shell process has no Android application around it. Some framework code (display info on some Samsung
 * devices, audio capture) expects one, so build a minimal ActivityThread and application context.
 * Ported from scrcpy's Workarounds and FakeContext (Apache-2.0, Genymobile).
 */
@SuppressLint("PrivateApi,DiscouragedPrivateApi")
object Workarounds {
    private val activityThreadClass: Class<*> = Class.forName("android.app.ActivityThread")
    private lateinit var activityThread: Any

    @Suppress("DEPRECATION")
    fun apply() {
        Looper.prepareMainLooper()

        val constructor = activityThreadClass.getDeclaredConstructor()
        constructor.isAccessible = true
        activityThread = constructor.newInstance()
        activityThreadClass.getDeclaredField("sCurrentActivityThread").apply { isAccessible = true }.set(null, activityThread)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            fillConfigurationController()
        }
        if (!Build.BRAND.equals("ONYX", ignoreCase = true)) {
            fillAppInfo()
        }
        fillAppContext()
    }

    fun systemContext(): Context? = try {
        activityThreadClass.getDeclaredMethod("getSystemContext").invoke(activityThread) as Context
    } catch (e: Throwable) {
        Ln.d("Could not get system context: ${e.message}")
        null
    }

    private fun fillAppInfo() = attempt("app info") {
        val bindDataClass = Class.forName("android.app.ActivityThread\$AppBindData")
        val bindData = bindDataClass.getDeclaredConstructor().apply { isAccessible = true }.newInstance()
        val appInfo = ApplicationInfo().apply { packageName = FakeContext.PACKAGE_NAME }
        bindDataClass.getDeclaredField("appInfo").apply { isAccessible = true }.set(bindData, appInfo)
        activityThreadClass.getDeclaredField("mBoundApplication").apply { isAccessible = true }.set(activityThread, bindData)
    }

    private fun fillAppContext() = attempt("app context") {
        val app = Application()
        ContextWrapper::class.java.getDeclaredField("mBase").apply { isAccessible = true }.set(app, FakeContext.instance)
        activityThreadClass.getDeclaredField("mInitialApplication").apply { isAccessible = true }.set(activityThread, app)
    }

    private fun fillConfigurationController() = attempt("configuration") {
        val controllerClass = Class.forName("android.app.ConfigurationController")
        val internalClass = Class.forName("android.app.ActivityThreadInternal")
        val controller = controllerClass.getDeclaredConstructor(internalClass).apply { isAccessible = true }.newInstance(activityThread)
        activityThreadClass.getDeclaredField("mConfigurationController").apply { isAccessible = true }.set(activityThread, controller)
    }

    private inline fun attempt(what: String, block: () -> Unit) {
        try {
            block()
        } catch (e: Throwable) {
            Ln.d("Could not fill $what: ${e.message}")
        }
    }
}

class FakeContext private constructor(base: Context?) : ContextWrapper(base) {
    companion object {
        const val PACKAGE_NAME = "com.android.shell"
        val instance: FakeContext by lazy { FakeContext(Workarounds.systemContext()) }
    }

    override fun getPackageName(): String = PACKAGE_NAME

    override fun getOpPackageName(): String = PACKAGE_NAME

    @TargetApi(Build.VERSION_CODES.S)
    override fun getAttributionSource(): AttributionSource =
        AttributionSource.Builder(Process.SHELL_UID).setPackageName(PACKAGE_NAME).build()

    override fun getApplicationContext(): Context = this
}
