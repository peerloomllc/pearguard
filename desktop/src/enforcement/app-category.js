// Heuristic categorizer for Windows apps. The parent UI expects a category
// string from the fixed set declared in src/ui/components/AppsTab.jsx:
// Games, Social, Video & Music, Communication, Education, Productivity,
// News, System, Other.
//
// Input can combine exe basename, appName (display name), UWP package family
// name, and the synthesized packageName. The first signal that matches wins;
// the order mirrors Android's AppCategoryHelper so parents see the same
// classification across platforms where possible.

const EXE_CATEGORY = {
  // Browsers
  'chrome.exe': 'Productivity',
  'msedge.exe': 'Productivity',
  'firefox.exe': 'Productivity',
  'brave.exe': 'Productivity',
  'opera.exe': 'Productivity',
  'iexplore.exe': 'Productivity',
  'safari.exe': 'Productivity',

  // Social
  'discord.exe': 'Social',
  'discordptb.exe': 'Social',
  'discordcanary.exe': 'Social',

  // Communication
  'slack.exe': 'Communication',
  'telegram.exe': 'Communication',
  'whatsapp.exe': 'Communication',
  'signal.exe': 'Communication',
  'teams.exe': 'Communication',
  'ms-teams.exe': 'Communication',
  'zoom.exe': 'Communication',
  'skype.exe': 'Communication',
  'thunderbird.exe': 'Communication',
  'outlook.exe': 'Communication',
  'keet.exe': 'Communication',

  // Video & Music
  'spotify.exe': 'Video & Music',
  'vlc.exe': 'Video & Music',
  'itunes.exe': 'Video & Music',
  'foobar2000.exe': 'Video & Music',
  'mpc-hc.exe': 'Video & Music',
  'mpc-hc64.exe': 'Video & Music',
  'obs64.exe': 'Video & Music',
  'obs32.exe': 'Video & Music',
  'netflix.exe': 'Video & Music',
  'hulu.exe': 'Video & Music',

  // Productivity
  'code.exe': 'Productivity',
  'notepad.exe': 'Productivity',
  'notepad++.exe': 'Productivity',
  'winword.exe': 'Productivity',
  'excel.exe': 'Productivity',
  'powerpnt.exe': 'Productivity',
  'onenote.exe': 'Productivity',
  'acrobat.exe': 'Productivity',
  'acrord32.exe': 'Productivity',
  'sublime_text.exe': 'Productivity',
  'atom.exe': 'Productivity',
  'devenv.exe': 'Productivity',

  // Games & launchers
  'steam.exe': 'Games',
  'epicgameslauncher.exe': 'Games',
  'gog galaxy.exe': 'Games',
  'galaxyclient.exe': 'Games',
  'battle.net.exe': 'Games',
  'origin.exe': 'Games',
  'eadesktop.exe': 'Games',
  'ealauncher.exe': 'Games',
  'ubisoftconnect.exe': 'Games',
  'upc.exe': 'Games',
  'roblox.exe': 'Games',
  'robloxplayerbeta.exe': 'Games',
  'robloxplayerlauncher.exe': 'Games',
  'minecraft.exe': 'Games',
  'minecraftlauncher.exe': 'Games',
  'fortnite.exe': 'Games',
  'fortniteclient-win64-shipping.exe': 'Games',
  'rocketleague.exe': 'Games',
  'valorant.exe': 'Games',
  'leagueclient.exe': 'Games',
  'league of legends.exe': 'Games',
  'dota2.exe': 'Games',
  'csgo.exe': 'Games',
  'cs2.exe': 'Games',
}

// UWP package family prefixes. The family name is
// "<Publisher>.<AppName>_<hash>"; matching on the publisher/app prefix lets
// us classify whole publisher families at once.
const UWP_FAMILY_PREFIX_CATEGORY = [
  // Games
  ['Microsoft.XboxApp_', 'Games'],
  ['Microsoft.GamingApp_', 'Games'],
  ['Microsoft.MinecraftUWP_', 'Games'],
  ['Microsoft.MinecraftEducationEdition_', 'Education'],
  ['Microsoft.Solitaire', 'Games'],
  ['Microsoft.MicrosoftSolitaireCollection_', 'Games'],
  ['king.com.', 'Games'],
  ['Roblox', 'Games'],
  ['ROBLOX', 'Games'],

  // Social
  ['Facebook.', 'Social'],
  ['FACEBOOK.', 'Social'],
  ['Instagram', 'Social'],
  ['A278AB0D.InstagramBeta_', 'Social'],
  ['5319275A.WhatsAppDesktop_', 'Communication'],
  ['BytedancePte.Ltd.TikTok_', 'Social'],
  ['SnapInc.Snapchat_', 'Social'],
  ['9E2F88E3.Twitter_', 'Social'],

  // Communication
  ['MicrosoftTeams_', 'Communication'],
  ['MSTeams_', 'Communication'],
  ['Microsoft.Teams_', 'Communication'],
  ['Microsoft.SkypeApp_', 'Communication'],
  ['Discord.', 'Social'],
  ['Keet_', 'Communication'],

  // Video & Music
  ['SpotifyAB.SpotifyMusic_', 'Video & Music'],
  ['Microsoft.ZuneMusic_', 'Video & Music'],
  ['Microsoft.ZuneVideo_', 'Video & Music'],
  ['Microsoft.WindowsMediaPlayer_', 'Video & Music'],
  ['AppleInc.iTunes_', 'Video & Music'],
  ['Netflix_', 'Video & Music'],
  ['4DF9E0F8.Netflix_', 'Video & Music'],
  ['Hulu_', 'Video & Music'],
  ['DisneyStreaming.DisneyPlus_', 'Video & Music'],
  ['YouTube_', 'Video & Music'],

  // News
  ['Microsoft.BingNews_', 'News'],
  ['Microsoft.News_', 'News'],

  // Productivity
  ['Microsoft.Office.', 'Productivity'],
  ['Microsoft.MicrosoftEdge_', 'Productivity'],
  ['Microsoft.MicrosoftEdge.Stable_', 'Productivity'],
  ['Microsoft.OutlookForWindows_', 'Communication'],
  ['Microsoft.WindowsCalculator_', 'Productivity'],
  ['Microsoft.WindowsNotepad_', 'Productivity'],
  ['Microsoft.WindowsTerminal_', 'Productivity'],
  ['Microsoft.Todos_', 'Productivity'],
  ['Microsoft.WindowsMaps_', 'Productivity'],
  ['Microsoft.BingWeather_', 'Productivity'],
  ['Microsoft.MicrosoftStickyNotes_', 'Productivity'],
  ['Microsoft.MSPaint_', 'Productivity'],
  ['Microsoft.Paint_', 'Productivity'],

  // Education
  ['Microsoft.MicrosoftOfficeHub_', 'Productivity'],
  ['KhanAcademy', 'Education'],
  ['Duolingo', 'Education'],

  // System (Windows shell surfaces)
  ['Microsoft.Windows.', 'System'],
  ['Microsoft.XboxGamingOverlay_', 'System'],
  ['Microsoft.XboxIdentityProvider_', 'System'],
  ['Microsoft.WindowsStore_', 'System'],
  ['Microsoft.StorePurchaseApp_', 'System'],
  ['Microsoft.GetHelp_', 'System'],
  ['Microsoft.Getstarted_', 'System'],
  ['Microsoft.MicrosoftSolitaire', 'Games'],
  ['Microsoft.AV1VideoExtension_', 'System'],
  ['Microsoft.HEIFImageExtension_', 'System'],
  ['Microsoft.VP9VideoExtensions_', 'System'],
  ['Microsoft.WebMediaExtensions_', 'System'],
  ['Microsoft.WebpImageExtension_', 'System'],
  ['Microsoft.LanguageExperiencePack', 'System'],
  ['Microsoft.UI.Xaml.', 'System'],
  ['Microsoft.VCLibs.', 'System'],
  ['Microsoft.NET.Native.', 'System'],
  ['Microsoft.UI.', 'System'],
]

// Fuzzy matches on the normalized (lowercase alphanumeric) display name.
// Only used as a last-ditch heuristic before falling back to 'Other'.
const NAME_KEYWORD_CATEGORY = [
  [/game|games|studios|steam|epicgames|ubisoft|blizzard/, 'Games'],
  [/music|spotify|pandora|soundcloud|audible/, 'Video & Music'],
  [/video|movie|netflix|hulu|youtube|disneyplus|twitch|plex|vlc/, 'Video & Music'],
  [/player|mediaplayer/, 'Video & Music'],
  [/chat|messenger|messaging|telegram|whatsapp|signal|discord/, 'Communication'],
  [/mail|outlook|thunderbird/, 'Communication'],
  [/teams|zoom|skype|webex|slack/, 'Communication'],
  [/twitter|facebook|instagram|tiktok|snapchat|reddit|pinterest|tumblr|linkedin/, 'Social'],
  [/news|headline|bbc|cnn|foxnews/, 'News'],
  [/khanacademy|duolingo|quizlet|brainly|photomath|education|learning|school|study/, 'Education'],
  [/office|word|excel|powerpoint|onenote|outlook|teams|acrobat|notes|notepad|calculator|calendar|weather|browser|chrome|firefox|edge|brave|opera|code|vscode|visualstudio|intellij|pycharm|android studio/, 'Productivity'],
]

// UWP family slugs (used in our synthesized packageName uwp.<slug>) carry
// underscores where dots appear in the raw family name. Re-normalize so
// prefix matching still works either way.
function unslugFamily(family) {
  if (!family) return ''
  return String(family)
}

function normalizeName(name) {
  if (typeof name !== 'string') return ''
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// Primary entry point. All fields optional; pass whatever the caller has.
// Returns one of the APP_CATEGORIES values.
function categorizeApp({ exeBasename = null, appName = null, packageFamilyName = null, packageName = null } = {}) {
  // 1. Exe basename is the most reliable signal when present.
  if (exeBasename) {
    const hit = EXE_CATEGORY[String(exeBasename).toLowerCase()]
    if (hit) return hit
  }

  // 2. UWP family prefix. Keep raw (case-sensitive) because publisher names
  //    are stable and the prefixes above are hand-written to match them.
  const family = unslugFamily(packageFamilyName)
  if (family) {
    for (const [prefix, category] of UWP_FAMILY_PREFIX_CATEGORY) {
      if (family.startsWith(prefix) || family === prefix.replace(/_$/, '')) return category
    }
  }

  // 3. Launcher packageName prefix. Any row that a launcher scanner produced
  //    (Steam/Epic/Ubisoft/EA/GOG) is a game, by definition of the source.
  if (typeof packageName === 'string') {
    if (packageName.startsWith('steam.app.')) return 'Games'
    if (packageName.startsWith('epic.')) return 'Games'
    if (packageName.startsWith('ubisoft.')) return 'Games'
    if (packageName.startsWith('ea.')) return 'Games'
    if (packageName.startsWith('origin.')) return 'Games'
    if (packageName.startsWith('gog.')) return 'Games'
  }

  // 4. DisplayName keyword match.
  const n = normalizeName(appName)
  if (n) {
    for (const [re, category] of NAME_KEYWORD_CATEGORY) {
      if (re.test(n)) return category
    }
  }

  return 'Other'
}

module.exports = { categorizeApp, EXE_CATEGORY, UWP_FAMILY_PREFIX_CATEGORY, NAME_KEYWORD_CATEGORY }
