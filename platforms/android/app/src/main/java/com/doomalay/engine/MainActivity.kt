package com.doomalay.engine

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import android.graphics.Color

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this).apply {
            text = "Hello Doomalay — Brick 1\n\nIf you see this, the APK works."
            textSize = 20f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#0A0A0B"))
            setPadding(64, 200, 64, 64)
        }
        setContentView(tv)
    }
}
