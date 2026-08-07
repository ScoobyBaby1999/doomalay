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
        versionCode = 2
        versionName = "0.4.0"
        ndk { abiFilters += "arm64-v8a" }
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "META-INF/INDEX.LIST"
        }
    }
}

dependencies {
    // No AppCompat — we use android.app.Activity (built-in, no dependency)
}

chaquopy {
    defaultConfig {
        pip {
            options("--no-deps")
            install("litellm==1.55.10")
            options()
            install("httpx")
            install("openai")
            install("python-dotenv")
            install("requests")
            install("aiohttp")
            install("pyyaml")
            install("jsonschema")
            install("click")
            install("jinja2")
            install("pydantic<2.0.0")
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
