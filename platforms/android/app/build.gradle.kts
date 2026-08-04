plugins {
    id("com.android.application")
    id("com.chaquo.python")
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
            // ARM64 only — covers 99% of modern Android devices.
            // x86_64 can be added for emulators if needed.
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}

// ── Chaquopy configuration ────────────────────────────────────────────────
// Bundles the Python 3.12 interpreter + pure-Python packages into the APK.
// The brain source is at brain/ (relative to the monorepo root).
chaquopy {
    defaultConfig {
        // Install pure-Python deps (no C extensions — verified).
        pip {
            // litellm pinned to 1.55.10 (safe — pre-supply-chain-attack).
            // v1.82.7/1.82.8 were compromised (March 2026).
            install("litellm==1.55.10")
            install("strands-agents")
            install("httpx")
            install("duckduckgo-search")
            install("beautifulsoup4")
            install("PyGithub")
            install("gitpython")
            install("uvicorn")
        }

        // Python source from the monorepo's brain/ directory.
        // The path is relative to this build.gradle.kts file.
        src {
            srcDir("../../../brain")
            include("*.py")
            include("tools/*.py")
            include("catalog/*.json")
            include("content/**")
            include("orchestrator/**")
            include("judge/**")
            include("agent_skills/**")
        }
    }
}
