# jsoup does small amounts of reflection-free class loading; keep its nodes
# so HtmlParser's tree walking survives R8 optimization.
-keep class org.jsoup.** { *; }
-dontwarn org.jsoup.**

# OkHttp platform shims reference optional classes.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
