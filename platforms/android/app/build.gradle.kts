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
        ndk { abiFilters += "arm64-v8a" }
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // Fix duplicate Kotlin stdlib classes
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "META-INF/INDEX.LIST"
            excludes += "META-INF/io.netty.versions.properties"
        }
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Force consistent Kotlin stdlib version to avoid duplicate classes
    constraints {
        implementation("org.jetbrains.kotlin:kotlin-stdlib:1.9.24")
        implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.9.24")
        implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.9.24")
    }
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
