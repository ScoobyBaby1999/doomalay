plugins {
    id("com.android.application") version "8.5.0"
    id("com.chaquo.python") version "17.0.0"
}

android {
    namespace = "com.doomalay.engine"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.doomalay.engine"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.3.0"

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
}

// ── Chaquopy ──────────────────────────────────────────────────────────────
chaquopy {
    defaultConfig {
        pip {
            install("litellm==1.55.10")
            install("strands-agents")
            install("httpx")
            install("duckduckgo-search")
            install("beautifulsoup4")
            install("PyGithub")
            install("gitpython")
        }
    }

    // Include Python source from the monorepo's brain/ directory.
    // See https://chaquo.com/chaquopy/doc/current/android.html#sourceSets
    sourceSets {
        getByName("main") {
            srcDir("../../../brain")
        }
    }
}
