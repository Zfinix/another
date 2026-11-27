package dev.another.server

object Ln {
    @Volatile
    var debug = false

    fun d(message: String) {
        if (debug) {
            write("DEBUG", message, null)
        }
    }

    fun i(message: String) = write("INFO", message, null)

    fun w(message: String, error: Throwable? = null) = write("WARN", message, error)

    fun e(message: String, error: Throwable? = null) = write("ERROR", message, error)

    private fun write(level: String, message: String, error: Throwable?) {
        val stream = if (level == "ERROR" || level == "WARN") System.err else System.out
        stream.println("[server] $level: $message")
        error?.printStackTrace(stream)
    }
}
