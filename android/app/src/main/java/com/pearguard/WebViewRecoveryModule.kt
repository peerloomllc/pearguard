package com.pearguard

import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// GrapheneOS/Vanadium WebView resume-freeze recovery.
//
// Android's cached-app freezer cgroup-freezes the WebView's out-of-process
// Vanadium renderer while the app is backgrounded. Since the 2026-07-19 Vanadium
// 151 update, the thawed renderer's compositor never re-attaches to the new
// window surface the app receives on resume, so it emits no buffers and the
// screen never repaints. JS, input and haptics keep working because they live in
// a separate, healthy process - which is why the app looks alive but frozen.
//
// Only a FRESH render process recovers it. A view-remount does not: it rebinds
// the same pooled, stale renderer. WebViewRenderProcess.terminate() (API 29+,
// and minSdk here is 29) kills only this app's renderer; the JS
// onRenderProcessGone handler then reloads a fresh one bound to the current
// surface.
//
// Returns the number of renderers terminated. Zero is meaningful and the JS side
// warns on it: it means either no WebView was found in the hierarchy, or the
// device runs the renderer in-process (getWebViewRenderProcess() is null in
// single-process mode), in which case this recovery cannot do anything and the
// freeze would otherwise appear to be "unfixed" with no explanation anywhere.
class WebViewRecoveryModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = NAME

    @ReactMethod
    fun terminateRenderer(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.resolve(0)
            return
        }
        activity.runOnUiThread {
            try {
                val webViews = findWebViews(activity.window?.decorView)
                var withRenderProcess = 0
                var terminated = 0
                for (wv in webViews) {
                    val rp = wv.webViewRenderProcess
                    if (rp == null) continue
                    withRenderProcess++
                    if (rp.terminate()) terminated++
                }
                // Break the zero down, because the three ways to get zero need
                // completely different responses and are indistinguishable from a
                // bare count: no WebView found means our view-tree walk is wrong
                // (the fix is broken); a WebView with a null render process means
                // the device runs WebView in single-process mode and this recovery
                // cannot apply at all; found-but-terminate-refused is a genuine
                // failure. Guessing between those from JS is impossible.
                Log.i(NAME, "terminateRenderer: webViews=" + webViews.size
                        + " withRenderProcess=" + withRenderProcess
                        + " terminated=" + terminated)
                promise.resolve(terminated)
            } catch (e: Throwable) {
                Log.w(NAME, "terminateRenderer failed", e)
                promise.reject("terminate_failed", e)
            }
        }
    }

    private fun findWebViews(root: View?): List<WebView> {
        if (root == null) return emptyList()
        val out = ArrayList<WebView>()
        val stack = ArrayDeque<View>()
        stack.addLast(root)
        while (stack.isNotEmpty()) {
            val v = stack.removeLast()
            if (v is WebView) out.add(v)
            if (v is ViewGroup) for (i in 0 until v.childCount) stack.addLast(v.getChildAt(i))
        }
        return out
    }

    companion object {
        // Must match NativeModules.WebViewRecovery on the JS side.
        const val NAME = "WebViewRecovery"
    }
}
