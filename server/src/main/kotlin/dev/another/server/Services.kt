package dev.another.server

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.view.InputEvent
import android.view.Surface
import java.lang.reflect.Method

/** Hidden system services reached by reflection, as scrcpy does (Apache-2.0, Genymobile). */
@SuppressLint("PrivateApi,DiscouragedPrivateApi")
object Services {
    private val getService: Method =
        Class.forName("android.os.ServiceManager").getDeclaredMethod("getService", String::class.java)

    fun get(name: String, type: String): Any {
        val binder = getService.invoke(null, name) as IBinder
        return Class.forName("$type\$Stub").getMethod("asInterface", IBinder::class.java).invoke(null, binder)!!
    }
}

data class DisplayInfo(val width: Int, val height: Int, val rotation: Int, val layerStack: Int)

@SuppressLint("PrivateApi,DiscouragedPrivateApi")
object Displays {
    private val global: Any by lazy {
        Class.forName("android.hardware.display.DisplayManagerGlobal").getDeclaredMethod("getInstance").invoke(null)!!
    }

    @Volatile
    var current: DisplayInfo? = null
        private set

    fun refresh(displayId: Int = 0): DisplayInfo? {
        val info = global.javaClass.getMethod("getDisplayInfo", Int::class.javaPrimitiveType).invoke(global, displayId) ?: return current
        val cls = info.javaClass
        val fresh = DisplayInfo(
            cls.getDeclaredField("logicalWidth").getInt(info),
            cls.getDeclaredField("logicalHeight").getInt(info),
            cls.getDeclaredField("rotation").getInt(info),
            cls.getDeclaredField("layerStack").getInt(info),
        )
        current = fresh
        return fresh
    }

    /**
     * Calls [onChange] as soon as the display changes, instead of waiting for the next poll. The signature of
     * DisplayManagerGlobal.registerDisplayListener differs across Android versions, so every known shape is tried.
     * Returns false when none matched.
     */
    fun listen(displayId: Int, onChange: () -> Unit): Boolean {
        val thread = HandlerThread("display-listener").apply { isDaemon = true; start() }
        val handler = Handler(thread.looper)
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(id: Int) {}
            override fun onDisplayRemoved(id: Int) {}
            override fun onDisplayChanged(id: Int) {
                if (id == displayId) onChange()
            }
        }
        val methods = global.javaClass.methods
            .filter { it.name == "registerDisplayListener" && it.parameterTypes.size >= 2 }
            .filter { it.parameterTypes[0] == DisplayManager.DisplayListener::class.java && it.parameterTypes[1] == Handler::class.java }
            .sortedByDescending { it.parameterTypes.size }
        for (method in methods) {
            val args: Array<Any?> = when (method.parameterTypes.size) {
                2 -> arrayOf(listener, handler)
                3 -> arrayOf(listener, handler, displayChangedFlag)
                4 -> arrayOf(listener, handler, displayChangedFlag, FakeContext.PACKAGE_NAME)
                else -> continue
            }
            try {
                method.invoke(global, *args)
                return true
            } catch (e: Exception) {
                Ln.d("registerDisplayListener with ${method.parameterTypes.size} arguments failed: $e")
            }
        }
        thread.quit()
        return false
    }

    /** Android 16 renumbered these flags, so the platform's own value is read where it exists. */
    private val displayChangedFlag: Long by lazy {
        val names = listOf("INTERNAL_EVENT_FLAG_DISPLAY_BASIC_CHANGED", "INTERNAL_EVENT_FLAG_DISPLAY_CHANGED", "EVENT_FLAG_DISPLAY_CHANGED")
        for (name in names) {
            try {
                return@lazy global.javaClass.getDeclaredField(name).apply { isAccessible = true }.getLong(null)
            } catch (e: Exception) {
                // try the next name
            }
        }
        1L shl 2
    }

    fun createVirtualDisplay(name: String, width: Int, height: Int, displayIdToMirror: Int, surface: Surface): VirtualDisplay {
        val int = Int::class.javaPrimitiveType
        val method = DisplayManager::class.java.getMethod(
            "createVirtualDisplay", String::class.java, int, int, int, Surface::class.java,
        )
        return method.invoke(null, name, width, height, displayIdToMirror, surface) as VirtualDisplay
    }
}

@SuppressLint("PrivateApi")
object SurfaceControlApi {
    private val cls: Class<*> = Class.forName("android.view.SurfaceControl")

    fun createDisplay(name: String, secure: Boolean): IBinder =
        cls.getMethod("createDisplay", String::class.java, Boolean::class.javaPrimitiveType).invoke(null, name, secure) as IBinder

    fun destroyDisplay(token: IBinder) {
        cls.getMethod("destroyDisplay", IBinder::class.java).invoke(null, token)
    }

    fun configure(token: IBinder, surface: Surface, layerStackRect: Rect, displayRect: Rect, layerStack: Int) {
        cls.getMethod("openTransaction").invoke(null)
        try {
            cls.getMethod("setDisplaySurface", IBinder::class.java, Surface::class.java).invoke(null, token, surface)
            cls.getMethod("setDisplayProjection", IBinder::class.java, Int::class.javaPrimitiveType, Rect::class.java, Rect::class.java)
                .invoke(null, token, 0, layerStackRect, displayRect)
            cls.getMethod("setDisplayLayerStack", IBinder::class.java, Int::class.javaPrimitiveType).invoke(null, token, layerStack)
        } finally {
            cls.getMethod("closeTransaction").invoke(null)
        }
    }
}

@SuppressLint("PrivateApi,DiscouragedPrivateApi")
object Input {
    private const val INJECT_MODE_ASYNC = 0

    private val manager: Any by lazy {
        val cls = try {
            Class.forName("android.hardware.input.InputManagerGlobal")
        } catch (e: ClassNotFoundException) {
            android.hardware.input.InputManager::class.java
        }
        cls.getDeclaredMethod("getInstance").invoke(null)!!
    }

    private val inject: Method by lazy {
        manager.javaClass.getMethod("injectInputEvent", InputEvent::class.java, Int::class.javaPrimitiveType)
    }

    fun inject(event: InputEvent): Boolean = try {
        inject.invoke(manager, event, INJECT_MODE_ASYNC) as Boolean
    } catch (e: ReflectiveOperationException) {
        Ln.e("Could not inject input event", e)
        false
    }
}

@SuppressLint("PrivateApi,DiscouragedPrivateApi")
object Power {
    private val manager: Any by lazy { Services.get("power", "android.os.IPowerManager") }

    fun isScreenOn(): Boolean = try {
        manager.javaClass.getMethod("isInteractive").invoke(manager) as Boolean
    } catch (e: ReflectiveOperationException) {
        Ln.e("Could not read the screen state", e)
        true
    }
}

@SuppressLint("PrivateApi,DiscouragedPrivateApi")
object Windows {
    private val manager: Any by lazy { Services.get("window", "android.view.IWindowManager") }
    private val int = Int::class.javaPrimitiveType

    fun rotation(): Int = try {
        val cls = manager.javaClass
        val method = try {
            cls.getMethod("getDefaultDisplayRotation")
        } catch (e: NoSuchMethodException) {
            cls.getMethod("getRotation")
        }
        method.invoke(manager) as Int
    } catch (e: ReflectiveOperationException) {
        Ln.e("Could not read the rotation", e)
        0
    }

    fun isRotationFrozen(displayId: Int): Boolean = try {
        val cls = manager.javaClass
        try {
            cls.getMethod("isDisplayRotationFrozen", int).invoke(manager, displayId) as Boolean
        } catch (e: NoSuchMethodException) {
            cls.getMethod("isRotationFrozen").invoke(manager) as Boolean
        }
    } catch (e: ReflectiveOperationException) {
        Ln.e("Could not read the rotation lock", e)
        false
    }

    fun freezeRotation(displayId: Int, rotation: Int) = callFirst(
        { it.getMethod("freezeDisplayRotation", int, int, String::class.java).invoke(manager, displayId, rotation, "another") },
        { it.getMethod("freezeDisplayRotation", int, int).invoke(manager, displayId, rotation) },
        { it.getMethod("freezeRotation", int).invoke(manager, rotation) },
    )

    fun thawRotation(displayId: Int) = callFirst(
        { it.getMethod("thawDisplayRotation", int, String::class.java).invoke(manager, displayId, "another") },
        { it.getMethod("thawDisplayRotation", int).invoke(manager, displayId) },
        { it.getMethod("thawRotation").invoke(manager) },
    )

    private fun callFirst(vararg variants: (Class<*>) -> Any?) {
        for (variant in variants) {
            try {
                variant(manager.javaClass)
                return
            } catch (e: NoSuchMethodException) {
                continue
            } catch (e: ReflectiveOperationException) {
                Ln.e("Could not change the rotation", e)
                return
            }
        }
    }
}

@SuppressLint("PrivateApi,DiscouragedPrivateApi")
object Activities {
    private val manager: Any by lazy {
        Class.forName("android.app.ActivityManagerNative").getDeclaredMethod("getDefault").invoke(null)!!
    }

    fun start(intent: Intent) {
        try {
            val method = manager.javaClass.getMethod(
                "startActivityAsUser",
                Class.forName("android.app.IApplicationThread"), String::class.java, Intent::class.java, String::class.java,
                IBinder::class.java, String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType,
                Class.forName("android.app.ProfilerInfo"), android.os.Bundle::class.java, Int::class.javaPrimitiveType,
            )
            method.invoke(manager, null, FakeContext.PACKAGE_NAME, intent, null, null, null, 0, 0, null, null, -2)
        } catch (e: Throwable) {
            Ln.e("Could not start activity", e)
        }
    }

    fun forceStop(packageName: String) {
        try {
            manager.javaClass.getMethod("forceStopPackage", String::class.java, Int::class.javaPrimitiveType)
                .invoke(manager, packageName, -2)
        } catch (e: Throwable) {
            Ln.e("Could not stop package", e)
        }
    }
}

object Platform {
    /** Since Android 12, shell cannot create secure displays. Android 12 previews still report SDK R with codename "S". */
    val canCreateSecureDisplay: Boolean
        get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.R ||
            (Build.VERSION.SDK_INT == Build.VERSION_CODES.R && Build.VERSION.CODENAME != "S")
}
