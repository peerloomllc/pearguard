package com.pearguard;

import android.Manifest;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.ContactsContract;

import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

public class ContactsModule extends ReactContextBaseJavaModule {

    private final ReactApplicationContext reactContext;

    public ContactsModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
    }

    @Override
    public String getName() {
        return "ContactsModule";
    }

    /**
     * Returns all device contacts with at least one phone number as an array of
     * { name: string, phone: string }.
     * If READ_CONTACTS is not granted, rejects with an error.
     */
    @ReactMethod
    public void getContacts(Promise promise) {
        if (ContextCompat.checkSelfPermission(reactContext, Manifest.permission.READ_CONTACTS)
                != PackageManager.PERMISSION_GRANTED) {
            promise.reject("PERMISSION_DENIED", "READ_CONTACTS permission not granted");
            return;
        }

        WritableArray contacts = Arguments.createArray();

        String[] projection = {
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER
        };

        Cursor cursor = reactContext.getContentResolver().query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            projection,
            null,
            null,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
        );

        if (cursor != null) {
            int nameCol = cursor.getColumnIndex(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
            int phoneCol = cursor.getColumnIndex(
                ContactsContract.CommonDataKinds.Phone.NUMBER);

            while (cursor.moveToNext()) {
                String name = cursor.getString(nameCol);
                String phone = cursor.getString(phoneCol);
                if (name == null || phone == null) continue;

                // Normalize: strip spaces and dashes for consistent comparison
                String normalized = phone.replaceAll("[\\s\\-()]", "");

                WritableMap contact = Arguments.createMap();
                contact.putString("name", name);
                contact.putString("phone", normalized);
                contacts.pushMap(contact);
            }
            cursor.close();
        }

        promise.resolve(contacts);
    }
}
