package com.doomalay.engine

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

class DebugActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this).apply {
            text = AppLog.read()
            textSize = 11f
            setTextColor(0xFFE4E4E7.toInt())
            setBackgroundColor(0xFF0A0A0B.toInt())
            setPadding(32, 64, 32, 32)
            setTextIsSelectable(true)
        }
        setContentView(ScrollView(this).apply { addView(tv) })
    }
}
