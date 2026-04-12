package com.pearguard;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Thread-safe SharedPreferences-backed queue for usage reports.
 * Used when the RN bridge is dead and EnforcementService needs to
 * store usage snapshots for later delivery.
 */
public class UsageQueueHelper {

    private static final String PREFS_NAME = "PearGuardPrefs";
    private static final String QUEUE_KEY = "usage_queue";
    private static final int MAX_ENTRIES = 96;
    private static final Object LOCK = new Object();

    /**
     * Enqueue a usage snapshot. Each entry is:
     * { "timestamp": long, "usage": [ { packageName, appName, secondsToday } ] }
     */
    public static void enqueue(Context context, JSONArray usage) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray queue;
            try {
                String raw = prefs.getString(QUEUE_KEY, "[]");
                queue = new JSONArray(raw);
            } catch (JSONException e) {
                queue = new JSONArray();
            }

            try {
                JSONObject entry = new JSONObject();
                entry.put("timestamp", System.currentTimeMillis());
                entry.put("usage", usage);
                queue.put(entry);

                // Drop oldest entries if over cap
                while (queue.length() > MAX_ENTRIES) {
                    queue.remove(0);
                }
            } catch (JSONException e) {
                return; // Don't corrupt the queue
            }

            prefs.edit().putString(QUEUE_KEY, queue.toString()).apply();
        }
    }

    /**
     * Read all queued reports without removing them.
     * Returns a JSON array string of report objects.
     */
    public static String dequeue(Context context) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.getString(QUEUE_KEY, "[]");
        }
    }

    /**
     * Clear the queue after successful flush.
     */
    public static void clear(Context context) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(QUEUE_KEY, "[]").apply();
        }
    }

    /**
     * Check if there are any queued reports.
     */
    public static boolean hasQueued(Context context) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(QUEUE_KEY, "[]");
            try {
                return new JSONArray(raw).length() > 0;
            } catch (JSONException e) {
                return false;
            }
        }
    }
}
