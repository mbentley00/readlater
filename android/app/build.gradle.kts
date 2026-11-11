import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

// Release signing (keystore.properties + *.keystore are gitignored).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.readlater.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.readlater.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 89
        versionName = "5.48"
    }

    // Two apps from one codebase, signed with the same key and signed in to the
    // same server account: Earmark (articles) and Hark (podcasts). They share
    // the player, transcript reader and sync; BuildConfig.PODCAST_APP picks the
    // podcast-only home screen. Each installs and updates on its own.
    flavorDimensions += "app"
    productFlavors {
        create("reader") {
            dimension = "app"
            isDefault = true
            buildConfigField("boolean", "PODCAST_APP", "false")
            // The other app of the pair: where a sign-in can be borrowed from.
            buildConfigField("String", "SIBLING_PACKAGE", "\"com.readlater.podcasts\"")
            // Server APK name for the update check; "" = the main /app.apk.
            buildConfigField("String", "APK_NAME", "\"\"")
        }
        create("podcasts") {
            dimension = "app"
            applicationId = "com.readlater.podcasts"
            versionCode = 6
            versionName = "1.5"
            buildConfigField("boolean", "PODCAST_APP", "true")
            buildConfigField("String", "SIBLING_PACKAGE", "\"com.readlater.app\"")
            buildConfigField("String", "APK_NAME", "\"podcasts\"")
        }
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // R8 shrinking is a large startup + size win over debug builds.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (keystoreProps.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")

    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.5")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.5")
    implementation("io.coil-kt:coil-compose:2.6.0") // article thumbnails
    implementation("androidx.navigation:navigation-compose:2.8.0")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jsoup:jsoup:1.17.2")
    implementation("androidx.media:media:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
