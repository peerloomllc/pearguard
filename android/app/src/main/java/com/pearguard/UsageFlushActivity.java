package com.pearguard;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

/**
 * Invisible Activity launched by UsageFlushWorker to restart the
 * React Native lifecycle when the app has been dismissed.
 *
 * Starting this Activity causes Android to create the Application
 * instance (which initializes RN), giving index.tsx a chance to
 * flush queued usage reports to the bare worklet.
 *
 * Finishes itself after 30 seconds - enough time for:
 *   - RN bridge init (~2-3s)
 *   - Bare worklet start + Hyperswarm connect (~5-10s)
 *   - Queue flush + P2P delivery (~5-10s)
 */
public class UsageFlushActivity extends Activity {

    private static final long FINISH_DELAY_MS = 30_000;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // No setContentView - fully transparent, invisible to user

        new Handler(Looper.getMainLooper()).postDelayed(this::finish, FINISH_DELAY_MS);
    }
}
