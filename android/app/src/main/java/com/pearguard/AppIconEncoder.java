package com.pearguard;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.util.Base64;

import java.io.ByteArrayOutputStream;

/**
 * Renders an app icon for the parent's Apps tab as a small base64 WebP.
 *
 * The icon travels to every parent inside apps:sync and app:installed and is
 * stored in the parent's policy for that child, so its size is paid many times
 * over. It used to be a 144 px lossless PNG (15 to 40 KB); 96 px lossy WebP is
 * two to five KB and still sharp at the 40 CSS px the Apps tab draws it at on a
 * 2x screen.
 */
final class AppIconEncoder {
    static final int SIZE_PX = 96;
    static final int QUALITY = 85;

    private AppIconEncoder() {}

    static String encode(Drawable drawable) {
        Bitmap bitmap = Bitmap.createBitmap(SIZE_PX, SIZE_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        drawable.setBounds(0, 0, SIZE_PX, SIZE_PX);
        drawable.draw(canvas);
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        // WEBP_LOSSY arrived in API 30; the plain WEBP constant on API 29 is
        // lossy at any quality below 100, so both branches produce the same thing.
        Bitmap.CompressFormat format = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? Bitmap.CompressFormat.WEBP_LOSSY
                : Bitmap.CompressFormat.WEBP;
        bitmap.compress(format, QUALITY, baos);
        bitmap.recycle();
        return Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
    }
}
