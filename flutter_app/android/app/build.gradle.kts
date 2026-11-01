plugins {
    id("com.android.application")
    id("kotlin-android")
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.blackhole.ultradownloader"
    compileSdk = 36

    compileOptions {
        // Required by flutter_local_notifications 19.x (uses java.time on API < 26)
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    defaultConfig {
        applicationId = "com.blackhole.ultradownloader"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        // youtubedl-android ships native libs for these ABIs
        ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86_64") }
    }

    packaging {
        // Required by youtubedl-android (Python stdlib + ffmpeg must not be compressed)
        jniLibs { useLegacyPackaging = true }
    }

    buildTypes {
        release {
            // Use your own keystore in key.properties for store distribution
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }

    // Split APKs per ABI to keep size reasonable (optional)
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86_64")
            isUniversalApk = true
        }
    }
}

flutter { source = "../.." }

dependencies {
    // youtubedl-android: bundled Python + yt-dlp + ffmpeg.
    // The upstream JitPack coordinates stopped publishing after 0.14.0; the
    // maintained releases (0.18.x) live on Maven Central under this group and keep
    // the same `com.yausername.youtubedl_android` packages, so MainActivity.kt works
    // unchanged. Pinned to the newest published version.
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:aria2c:0.18.1")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}
