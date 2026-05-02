package com.pearguard;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Thread-safe SharedPreferences-backed queue for time/approval requests
 * created from the block overlay while the RN bridge was detached. Mirrors
 * UsageQueueHelper. UsageFlushWorker drains entries by emitting
 * onTimeRequestDrain to JS, which forwards each as a time:request to bare.
 */
public class TimeRequestQueueHelper {

    private static final String PREFS_NAME = "PearGuardPrefs";
    private static final String QUEUE_KEY = "time_request_queue";
    private static final int MAX_ENTRIES = 64;
    private static final Object LOCK = new Object();

    /**
     * Enqueue a time/approval request. Each entry is:
     * { "timestamp": long, "packageName": str, "appName": str,
     *   "requestType": "approval" | "extra_time", "extraSeconds": int? }
     */
    public static void enqueue(Context context, String packageName, String appName,
                               String requestType, int extraSeconds) {
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
                entry.put("packageName", packageName);
                if (appName != null) entry.put("appName", appName);
                if (requestType != null) entry.put("requestType", requestType);
                if (extraSeconds > 0) entry.put("extraSeconds", extraSeconds);
                queue.put(entry);

                while (queue.length() > MAX_ENTRIES) {
                    queue.remove(0);
                }
            } catch (JSONException e) {
                return;
            }

            prefs.edit().putString(QUEUE_KEY, queue.toString()).apply();
        }
    }

    public static String dequeue(Context context) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.getString(QUEUE_KEY, "[]");
        }
    }

    public static void clear(Context context) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(QUEUE_KEY, "[]").apply();
        }
    }

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
