package com.pearguard;

import android.content.pm.ApplicationInfo;
import android.os.Build;

/**
 * Maps an Android app to a human-readable category string.
 * Uses ApplicationInfo.category (API 26+) with package-name fallbacks.
 */
public final class AppCategoryHelper {

    private AppCategoryHelper() {}

    public static String getCategory(ApplicationInfo ai) {
        // API 26+ exposes a category field populated from Play Store metadata
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && ai.category >= 0) {
            switch (ai.category) {
                case ApplicationInfo.CATEGORY_GAME:
                    return "Games";
                case ApplicationInfo.CATEGORY_AUDIO:
                case ApplicationInfo.CATEGORY_VIDEO:
                case ApplicationInfo.CATEGORY_IMAGE:
                    return "Video & Music";
                case ApplicationInfo.CATEGORY_SOCIAL:
                    return "Social";
                case ApplicationInfo.CATEGORY_NEWS:
                    return "News";
                case ApplicationInfo.CATEGORY_PRODUCTIVITY:
                    return "Productivity";
                case ApplicationInfo.CATEGORY_MAPS:
                    return "Productivity";
                case ApplicationInfo.CATEGORY_ACCESSIBILITY:
                    return "System";
                default:
                    // Unknown positive category — fall through to heuristics
                    break;
            }
        }

        // Game flag (works even when category is UNDEFINED)
        if ((ai.flags & ApplicationInfo.FLAG_IS_GAME) != 0) {
            return "Games";
        }

        return categorizeByPackageName(ai.packageName);
    }

    /**
     * Fallback heuristics based on well-known package prefixes/names.
     */
    private static String categorizeByPackageName(String pkg) {
        if (pkg == null) return "Other";
        String lower = pkg.toLowerCase();

        // --- Games ---
        if (lower.contains(".game") || lower.contains(".games")
                || lower.startsWith("com.supercell.")
                || lower.startsWith("com.king.")
                || lower.startsWith("com.rovio.")
                || lower.startsWith("com.epicgames.")
                || lower.startsWith("com.mojang.")
                || lower.startsWith("com.roblox.")
                || lower.startsWith("com.ea.")
                || lower.startsWith("com.gameloft.")
                || lower.startsWith("com.zynga.")
                || lower.startsWith("com.igg.")
                || lower.startsWith("com.miniclip.")
                || lower.startsWith("com.playgendary.")
                || lower.startsWith("com.voodoo.")
                || lower.startsWith("com.ketchapp.")
                || lower.startsWith("io.supercent.")
                || lower.equals("com.innersloth.spacemafia")       // Among Us
                || lower.equals("com.dts.freefireth")              // Free Fire
                || lower.equals("com.tencent.ig")                  // PUBG Mobile
                || lower.equals("com.activision.callofduty.shooter") // COD Mobile
                || lower.equals("com.nianticlabs.pokemongo")
                || lower.equals("com.kiloo.subwaysurf")) {
            return "Games";
        }

        // --- Social ---
        if (lower.equals("com.instagram.android")
                || lower.equals("com.twitter.android")
                || lower.equals("com.twitter.android.lite")
                || lower.equals("com.zhiliaoapp.musically")        // TikTok
                || lower.equals("com.ss.android.ugc.trill")        // TikTok alt
                || lower.equals("com.ss.android.ugc.boom")         // TikTok Lite
                || lower.equals("com.snapchat.android")
                || lower.equals("com.facebook.katana")
                || lower.equals("com.facebook.lite")
                || lower.equals("com.facebook.orca")               // Messenger
                || lower.equals("com.facebook.mlite")              // Messenger Lite
                || lower.equals("com.reddit.frontpage")
                || lower.equals("com.pinterest")
                || lower.equals("com.tumblr")
                || lower.equals("com.linkedin.android")
                || lower.startsWith("com.discord")
                || lower.equals("com.bereal.ft")
                || lower.equals("com.lemon8.android")
                || lower.equals("com.kwai.video")) {
            return "Social";
        }

        // --- Communication ---
        if (lower.equals("com.whatsapp")
                || lower.equals("com.whatsapp.w4b")
                || lower.equals("org.telegram.messenger")
                || lower.equals("com.google.android.apps.messaging")
                || lower.equals("com.google.android.apps.tachyon")  // Google Duo/Meet
                || lower.equals("com.samsung.android.messaging")
                || lower.equals("com.google.android.dialer")
                || lower.equals("com.samsung.android.dialer")
                || lower.equals("com.samsung.android.incallui")
                || lower.equals("com.android.phone")
                || lower.equals("com.android.contacts")
                || lower.equals("com.google.android.contacts")
                || lower.equals("com.samsung.android.contacts")
                || lower.equals("com.android.mms")
                || lower.equals("org.thoughtcrime.securesms")       // Signal
                || lower.equals("com.viber.voip")
                || lower.equals("com.skype.raider")
                || lower.equals("jp.naver.line.android")
                || lower.equals("com.google.android.apps.meet")
                || lower.contains(".messaging")
                || lower.contains(".dialer")
                || lower.contains(".contacts")) {
            return "Communication";
        }

        // --- Video & Music ---
        if (lower.equals("com.google.android.youtube")
                || lower.equals("com.google.android.apps.youtube.kids")
                || lower.equals("com.google.android.apps.youtube.music")
                || lower.equals("com.spotify.music")
                || lower.equals("com.netflix.mediaclient")
                || lower.equals("com.amazon.avod")
                || lower.equals("com.disney.disneyplus")
                || lower.equals("com.hulu.livingroomplus")
                || lower.equals("com.apple.android.music")
                || lower.equals("com.pandora.android")
                || lower.equals("tv.twitch.android.app")
                || lower.equals("com.amazon.mp3")
                || lower.equals("com.soundcloud.android")
                || lower.equals("com.clearchannel.iheartradio.controller")
                || lower.equals("com.google.android.apps.photos")
                || lower.equals("com.samsung.android.gallery")
                || lower.equals("com.sec.android.gallery3d")
                || lower.equals("com.google.android.videos")
                || lower.equals("com.plexapp.android")
                || lower.equals("org.videolan.vlc")
                || lower.equals("com.mxtech.videoplayer.ad")
                || lower.equals("com.crunchyroll.crunchyroid")
                || lower.equals("com.hbo.hbonow")
                || lower.equals("com.peacocktv.peacockandroid")
                || lower.equals("com.cbs.app")
                || lower.equals("com.paramount.paramountplus")
                || lower.contains(".music")
                || lower.contains(".video")
                || lower.contains(".player")
                || lower.contains(".camera")
                || lower.contains(".gallery")) {
            return "Video & Music";
        }

        // --- Education ---
        if (lower.equals("com.google.android.apps.classroom")
                || lower.equals("com.duolingo")
                || lower.equals("com.khanacademy.android")
                || lower.equals("com.quizlet.quizletandroid")
                || lower.equals("com.byju")
                || lower.equals("com.photomath.camera")
                || lower.equals("com.brainly")
                || lower.contains(".education")
                || lower.contains(".learning")
                || lower.contains(".school")
                || lower.contains(".study")) {
            return "Education";
        }

        // --- News ---
        if (lower.equals("com.google.android.apps.magazines")    // Google News
                || lower.equals("com.twitter.android.lite")
                || lower.equals("com.cnn.mobile.android.phone")
                || lower.equals("com.foxnews.android")
                || lower.equals("com.bbc.news")
                || lower.contains(".news")) {
            return "News";
        }

        // --- Productivity ---
        if (lower.equals("com.google.android.apps.docs")
                || lower.equals("com.google.android.apps.docs.editors.sheets")
                || lower.equals("com.google.android.apps.docs.editors.slides")
                || lower.equals("com.google.android.calendar")
                || lower.equals("com.google.android.gm")            // Gmail
                || lower.equals("com.google.android.apps.maps")
                || lower.equals("com.google.android.apps.translate")
                || lower.equals("com.google.android.keep")
                || lower.equals("com.google.android.apps.nbu.files") // Files by Google
                || lower.equals("com.google.android.apps.walletnfcrel") // Google Pay
                || lower.equals("com.google.android.deskclock")
                || lower.equals("com.google.android.calculator")
                || lower.equals("com.android.calculator2")
                || lower.equals("com.android.chrome")
                || lower.equals("com.google.android.googlequicksearchbox") // Google app
                || lower.equals("com.microsoft.office.outlook")
                || lower.equals("com.microsoft.office.word")
                || lower.equals("com.microsoft.office.excel")
                || lower.equals("com.microsoft.teams")
                || lower.equals("us.zoom.videomeetings")
                || lower.equals("com.samsung.android.email.provider")
                || lower.equals("com.samsung.android.calendar")
                || lower.equals("com.samsung.android.app.notes")
                || lower.equals("com.sec.android.app.myfiles")
                || lower.equals("com.sec.android.app.sbrowser")     // Samsung Internet
                || lower.equals("org.mozilla.firefox")
                || lower.equals("com.brave.browser")
                || lower.equals("com.opera.browser")
                || lower.equals("com.amazon.mShop.android.shopping")
                || lower.equals("com.ebay.mobile")
                || lower.contains(".browser")
                || lower.contains(".calculator")
                || lower.contains(".calendar")
                || lower.contains(".notes")
                || lower.contains(".mail")
                || lower.contains(".email")
                || lower.contains(".clock")
                || lower.contains(".weather")
                || lower.contains(".files")
                || lower.contains(".filemanager")) {
            return "Productivity";
        }

        // --- System ---
        if (lower.startsWith("com.android.")
                || lower.startsWith("com.google.android.gms")
                || lower.startsWith("com.google.android.gsf")
                || lower.startsWith("com.google.android.ext.")
                || lower.equals("com.google.android.apps.nexuslauncher")
                || lower.equals("com.google.android.packageinstaller")
                || lower.equals("com.google.android.permissioncontroller")
                || lower.equals("com.google.android.apps.wellbeing")
                || lower.equals("com.google.android.apps.restore")
                || lower.equals("com.google.android.setupwizard")
                || lower.startsWith("com.samsung.android.launcher")
                || lower.startsWith("com.samsung.android.lool")
                || lower.startsWith("com.samsung.android.app.smartcapture")
                || lower.startsWith("com.sec.android.app.launcher")
                || lower.contains(".launcher")
                || lower.contains(".settings")
                || lower.contains(".provision")
                || lower.contains(".setupwizard")) {
            return "System";
        }

        return "Other";
    }
}
