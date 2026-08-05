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
// We install litellm with --no-deps (because tiktoken + pydantic v2 are C
// extensions with no Android wheels). Then we install litellm's pure-Python
// deps manually. For pydantic, we use v1 (pure Python). For tiktoken, litellm
// falls back to word-count token estimation (close enough for UI display).
chaquopy {
    defaultConfig {
        pip {
            // litellm without deps — we install its deps manually below
            install("--no-deps", "litellm==1.55.10")

            // litellm's pure-Python deps (skip tiktoken + pydantic v2)
            install("httpx")
            install("openai")
            install("anthropic")
            install("google-generativeai")
            install("cohere")
            install("redis")
            install("python-dotenv")
            install("requests")
            install("aiohttp")
            install("pyyaml")
            install("jsonschema")
            install("click")
            install("jinja2")
            install("tokenizers")  // pure-Python fallback for tiktoken

            // pydantic v1 (pure Python — no C extension)
            install("pydantic<2.0.0")

            // Other brain deps (all pure Python)
            install("strands-agents")
            install("duckduckgo-search")
            install("beautifulsoup4")
            install("PyGithub")
            install("gitpython")
        }
    }

    sourceSets {
        getByName("main") {
            srcDir("../../../brain")
        }
    }
}
