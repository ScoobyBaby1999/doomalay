package com.doomalay.engine

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this)
        tv.text = "Hello Doomalay — Brick 1b\n\nKotlin plugin fix.\nIf you see this, the APK works."
        tv.textSize = 20f
        tv.setPadding(64, 200, 64, 64)
        setContentView(tv)
    }
}
