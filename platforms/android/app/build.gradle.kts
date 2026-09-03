plugins {
    id("com.android.application") version "8.5.0"
    id("org.jetbrains.kotlin.android") version "1.9.24"
}

android {
    namespace = "com.doomalay.engine"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.doomalay.engine"
        minSdk = 24
        targetSdk = 34
        versionCode = 17
        versionName = "0.9.3-8ball-aesthetic"
        ndk { abiFilters += "arm64-v8a" }
    }
    // CRITICAL: libdoomalayengine.so is NOT a JNI library — it is a standalone
    // Go PIE executable spawned via ProcessBuilder in EngineService.kt.
    // AGP 8.x defaults useLegacyPackaging=false, which leaves .so files inside
    // the APK (extractNativeLibs=false). That works for System.loadLibrary()
    // but breaks execve(). Setting useLegacyPackaging=true forces AGP to
    // extract .so files to the real filesystem at install time, so
    // context.applicationInfo.nativeLibraryDir/libdoomalayengine.so exists
    // as an actual file that ProcessBuilder can execute.
    // Without this, EngineBinary.kt throws "Go binary not found" at runtime,
    // the HTTP server on 127.0.0.1:8080 never starts, and the WebView sits on
    // a white screen until the 30s health-poll timeout fires.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
}
