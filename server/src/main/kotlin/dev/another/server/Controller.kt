package dev.another.server

import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream

/** Reads control messages from the client and injects them. Message layouts match scrcpy 2.7 plus types 100 to 102. */
class Controller(stream: InputStream) {

    companion object {
        private const val TYPE_INJECT_KEYCODE = 0
        private const val TYPE_INJECT_TEXT = 1
        private const val TYPE_INJECT_TOUCH = 2
        private const val TYPE_INJECT_SCROLL = 3
        private const val TYPE_BACK_OR_SCREEN_ON = 4
        private const val TYPE_EXPAND_NOTIFICATION_PANEL = 5
        private const val TYPE_EXPAND_SETTINGS_PANEL = 6
        private const val TYPE_COLLAPSE_PANELS = 7
        private const val TYPE_GET_CLIPBOARD = 8
        private const val TYPE_SET_CLIPBOARD = 9
        private const val TYPE_SET_SCREEN_POWER_MODE = 10
        private const val TYPE_ROTATE_DEVICE = 11
        private const val TYPE_OPEN_HARD_KEYBOARD_SETTINGS = 15
        private const val TYPE_SET_VIDEO_BIT_RATE = 100
        private const val TYPE_REQUEST_KEY_FRAME = 101
        private const val TYPE_SET_VIDEO_SIZE = 102
        private const val DISPLAY_ID = 0
    }

    private val input = DataInputStream(BufferedInputStream(stream))
    private val charMap: KeyCharacterMap = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
    private val pointers = PointersState()
    private var lastTouchDown = 0L

    fun run() {
        try {
            while (true) {
                handle(input.readUnsignedByte())
            }
        } catch (e: EOFException) {
            Ln.d("Control channel closed")
        } catch (e: IOException) {
            Ln.d("Control channel error: ${e.message}")
        }
    }

    private fun handle(type: Int) {
        when (type) {
            TYPE_INJECT_KEYCODE -> {
                val action = input.readUnsignedByte()
                val keycode = input.readInt()
                val repeat = input.readInt()
                val metaState = input.readInt()
                injectKey(action, keycode, repeat, metaState)
            }
            TYPE_INJECT_TEXT -> {
                val bytes = ByteArray(input.readInt()).also { input.readFully(it) }
                injectText(String(bytes, Charsets.UTF_8))
            }
            TYPE_INJECT_TOUCH -> {
                val action = input.readUnsignedByte()
                val pointerId = input.readLong()
                val position = readPosition()
                val pressure = u16ToFloat(input.readUnsignedShort())
                input.readInt()
                input.readInt()
                injectTouch(action, pointerId, position, pressure)
            }
            TYPE_INJECT_SCROLL -> {
                val position = readPosition()
                val hScroll = i16ToFloat(input.readShort().toInt())
                val vScroll = i16ToFloat(input.readShort().toInt())
                val buttons = input.readInt()
                injectScroll(position, hScroll, vScroll, buttons)
            }
            TYPE_BACK_OR_SCREEN_ON -> backOrScreenOn(input.readUnsignedByte())
            TYPE_GET_CLIPBOARD, TYPE_SET_SCREEN_POWER_MODE -> input.readUnsignedByte()
            TYPE_SET_CLIPBOARD -> {
                input.readLong()
                input.readUnsignedByte()
                input.skipBytes(input.readInt())
            }
            TYPE_EXPAND_NOTIFICATION_PANEL, TYPE_EXPAND_SETTINGS_PANEL, TYPE_COLLAPSE_PANELS,
            TYPE_OPEN_HARD_KEYBOARD_SETTINGS -> Ln.d("Ignoring control message $type")
            TYPE_ROTATE_DEVICE -> rotateDevice()
            TYPE_SET_VIDEO_BIT_RATE -> VideoControl.setBitRate(input.readInt())
            TYPE_REQUEST_KEY_FRAME -> VideoControl.requestKeyFrame()
            TYPE_SET_VIDEO_SIZE -> VideoControl.setVideoSize(input.readUnsignedShort(), input.readUnsignedShort())
            else -> throw IOException("Unknown control message type $type")
        }
    }

    private class Position(val x: Int, val y: Int, val screenWidth: Int, val screenHeight: Int)

    private fun readPosition() = Position(input.readInt(), input.readInt(), input.readUnsignedShort(), input.readUnsignedShort())

    /** Maps a point in the client's video coordinates to the physical screen. */
    private fun toScreen(position: Position): Pair<Float, Float>? {
        val screen = Displays.current ?: Displays.refresh() ?: return null
        if (position.screenWidth == 0 || position.screenHeight == 0) return null
        val x = position.x.toFloat() * screen.width / position.screenWidth
        val y = position.y.toFloat() * screen.height / position.screenHeight
        return x to y
    }

    private fun injectKey(action: Int, keycode: Int, repeat: Int, metaState: Int): Boolean {
        val now = SystemClock.uptimeMillis()
        val event = KeyEvent(
            now, now, action, keycode, repeat, metaState, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD,
        )
        return Input.inject(event)
    }

    private fun injectText(text: String) {
        for (char in text) {
            val events = charMap.getEvents(charArrayOf(char))
            if (events == null) {
                Ln.w("Could not inject char u+%04x".format(char.code))
                continue
            }
            events.forEach { Input.inject(it) }
        }
    }

    private fun injectTouch(action: Int, pointerId: Long, position: Position, pressure: Float) {
        val (x, y) = toScreen(position) ?: return
        val now = SystemClock.uptimeMillis()
        val index = pointers.indexOf(pointerId)
        if (index == -1) {
            Ln.w("Too many pointers for touch event")
            return
        }
        pointers.set(index, x, y, pressure, up = action == MotionEvent.ACTION_UP)
        val count = pointers.update()

        var motionAction = action
        if (count == 1) {
            if (action == MotionEvent.ACTION_DOWN) lastTouchDown = now
        } else if (action == MotionEvent.ACTION_UP) {
            motionAction = MotionEvent.ACTION_POINTER_UP or (index shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
        } else if (action == MotionEvent.ACTION_DOWN) {
            motionAction = MotionEvent.ACTION_POINTER_DOWN or (index shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
        }

        val event = MotionEvent.obtain(
            lastTouchDown, now, motionAction, count, pointers.properties, pointers.coords,
            0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
        )
        Input.inject(event)
        event.recycle()
    }

    private fun injectScroll(position: Position, hScroll: Float, vScroll: Float, buttons: Int) {
        val (x, y) = toScreen(position) ?: return
        val now = SystemClock.uptimeMillis()
        val properties = arrayOf(MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_MOUSE })
        val coords = arrayOf(MotionEvent.PointerCoords().apply {
            this.x = x
            this.y = y
            setAxisValue(MotionEvent.AXIS_HSCROLL, hScroll)
            setAxisValue(MotionEvent.AXIS_VSCROLL, vScroll)
        })
        val event = MotionEvent.obtain(
            lastTouchDown, now, MotionEvent.ACTION_SCROLL, 1, properties, coords, 0, buttons, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0,
        )
        Input.inject(event)
        event.recycle()
    }

    private fun backOrScreenOn(action: Int) {
        if (Power.isScreenOn()) {
            injectKey(action, KeyEvent.KEYCODE_BACK, 0, 0)
        } else if (action == KeyEvent.ACTION_DOWN) {
            injectKey(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_POWER, 0, 0)
            injectKey(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_POWER, 0, 0)
        }
    }

    private fun rotateDevice() {
        val followsSensor = !Windows.isRotationFrozen(DISPLAY_ID)
        val next = (Windows.rotation() and 1) xor 1
        Windows.freezeRotation(DISPLAY_ID, next)
        if (followsSensor) {
            Windows.thawRotation(DISPLAY_ID)
        }
    }

    private fun u16ToFloat(value: Int): Float = if (value == 0xffff) 1f else value / 65536f

    private fun i16ToFloat(value: Int): Float = if (value == 0x7fff) 1f else value / 32768f
}

/** Active touch pointers, so several fingers can be down at once. */
class PointersState {
    companion object {
        const val MAX_POINTERS = 10
    }

    private class Pointer(val id: Long, val localId: Int) {
        var x = 0f
        var y = 0f
        var pressure = 0f
        var up = false
    }

    private val pointers = ArrayList<Pointer>()
    val properties = Array(MAX_POINTERS) { MotionEvent.PointerProperties() }
    val coords = Array(MAX_POINTERS) { MotionEvent.PointerCoords() }

    fun indexOf(id: Long): Int {
        val existing = pointers.indexOfFirst { it.id == id }
        if (existing != -1) return existing
        if (pointers.size >= MAX_POINTERS) return -1
        val used = pointers.map { it.localId }.toSet()
        val localId = (0 until MAX_POINTERS).first { it !in used }
        pointers += Pointer(id, localId)
        return pointers.size - 1
    }

    fun set(index: Int, x: Float, y: Float, pressure: Float, up: Boolean) {
        pointers[index].apply {
            this.x = x
            this.y = y
            this.pressure = pressure
            this.up = up
        }
    }

    /** Fills [properties] and [coords] with every pointer, then forgets the ones that went up. */
    fun update(): Int {
        val count = pointers.size
        for (i in 0 until count) {
            val pointer = pointers[i]
            properties[i].id = pointer.localId
            properties[i].toolType = MotionEvent.TOOL_TYPE_FINGER
            coords[i].x = pointer.x
            coords[i].y = pointer.y
            coords[i].pressure = pointer.pressure
        }
        pointers.removeAll { it.up }
        return count
    }
}
