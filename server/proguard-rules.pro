-keep class dev.another.server.Main {
    public static void main(java.lang.String[]);
}
-dontobfuscate
-allowaccessmodification
-dontwarn kotlin.**
-dontwarn org.jetbrains.annotations.**
-keep class dev.another.server.AppIcons {
    public static void main(java.lang.String[]);
}
