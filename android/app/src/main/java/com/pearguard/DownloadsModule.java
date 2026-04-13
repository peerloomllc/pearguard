package com.pearguard;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.widget.Toast;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class DownloadsModule extends ReactContextBaseJavaModule {

    public DownloadsModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return "PearGuardDownloads";
    }

    /**
     * Save a UTF-8 string to the public Downloads folder.
     * On Android Q+ uses MediaStore (no permission required).
     * On older versions writes directly to the Downloads directory.
     */
    @ReactMethod
    public void saveToDownloads(String filename, String content, String mimeType, Promise promise) {
        try {
            String resolvedMime = (mimeType == null || mimeType.isEmpty()) ? "application/json" : mimeType;
            String savedPath;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getReactApplicationContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, resolvedMime);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Uri uri = resolver.insert(collection, values);
                if (uri == null) throw new Exception("MediaStore insert returned null");
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) throw new Exception("openOutputStream returned null");
                    out.write(content.getBytes("UTF-8"));
                }
                savedPath = "Downloads/" + filename;
            } else {
                File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!downloadsDir.exists()) downloadsDir.mkdirs();
                File file = new File(downloadsDir, filename);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(content.getBytes("UTF-8"));
                }
                savedPath = file.getAbsolutePath();
            }
            promise.resolve(savedPath);
        } catch (Exception e) {
            promise.reject("DOWNLOADS_SAVE_FAILED", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void showToast(String message, boolean longDuration) {
        getReactApplicationContext().runOnUiQueueThread(() -> {
            Toast.makeText(
                getReactApplicationContext(),
                message,
                longDuration ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT
            ).show();
        });
    }
}
