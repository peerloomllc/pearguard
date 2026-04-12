# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 85 | Contacts overrides not working | Can't add contacts on Parent device; untested on Child device |
| 98 | Investigate Tailscale VPN compatibility | Tailscale breaks Hyperswarm P2P connections; need to investigate split tunneling or relay options |
| 124 | Android cold start notification tap goes to Dashboard instead of Activity tab | Warm open works correctly; cold start doesn't navigate to child. Rare edge case, non-blocking. |
| 131 | Not consistently receiving usage stats from Child | Background service may stop running; had to foreground PearGuard after ~24 hours for it to check in and update stats. Check background service activity. |

## Features

| # | Title | Where |
|---|-------|-------|
| 125 | Camera/Gallery picker for iOS | Use same approach as PearCal's Profile page Avatar customization (camera/gallery picker) |
| 130 | Global/category time limits | Allow parents to set daily time limits per app category or globally |
| 132 | Co-parent unpair leaves stale parent record on child | When a co-parent unpairs, the child still shows the departed parent as "Offline" indefinitely. No notification to the remaining co-parent either. |
| 133 | Chore list to earn time | Child dashboard shows parent-assigned chores; completing them earns extra screen time |
| 134 | Onboarding design to match rest of app | Update onboarding theme, colors, and styling to be consistent with the main app design |
| 135 | Investigate app storage usage | Check what's consuming storage and optimize if needed |

## Release Pre-work (before first release)

`scripts/app.conf` has been created. Items marked FIXME need to be resolved before running `release.sh`.

| # | Title | Details |
|---|-------|---------|
| 104 | Create release keystore | `keytool -genkey -v -keystore ~/pearguard-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias pearguard`. Currently using debug keystore. |
| 105 | Create scripts/.env | Copy from PearCal template. Set KEYSTORE_PASSWORD, KEY_PASSWORD, KEYSTORE_FILE (~/pearguard-keystore.jks), SIGN_WITH (Zapstore NSEC - can reuse PeerLoom's). Set ASC_KEY_ID/ASC_ISSUER_ID/ASC_PRIVATE_KEY_PATH (reuse PeerLoom-CI key). |
| 106 | Look up ASC_APP_ID | Register PearGuard in App Store Connect (if doing iOS later), then run `asc apps list --output json` to get numeric ID. Skip if Android-only for now. |
| 107 | Copy release.sh and ios-appstore.sh from PearCal | Copy scripts from pearcal-native/scripts/. The scripts are parameterized via app.conf so no code changes needed. |
| 108 | Create zapstore.yaml | Needed for Zapstore publishing. Model after PearCal's zapstore.yaml with PearGuard metadata. |
| 109 | Set up Google Play app listing | Create PearGuard app in Google Play Console, set up internal test track, configure service account or gcloud auth. |
| 110 | Review app.conf values | Check APP_TAGLINE, APP_WEBSITE, NOSTR_HASHTAGS in scripts/app.conf before first Nostr announcement. |
| 111 | Create metadata/ios/ directory | Only needed if/when iOS parent-only version ships (see #102). |
