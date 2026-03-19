package com.pearguard;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * Stub — replaced with full implementation in Task 8.
 * Exists here so BootReceiverModule compiles.
 */
public class EnforcementService extends Service {
    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent i, int f, int id) {
        return START_STICKY;
    }
}
