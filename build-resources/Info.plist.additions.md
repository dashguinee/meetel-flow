# Info.plist Additions — Meetel Flow (macOS)

Since `package.json` is not directly edited in this audit pass, this file
documents the exact `build.mac` configuration that must be merged into
`package.json` before shipping a macOS build.

The `build.mac` block in `package.json` is currently missing. Add the
following keys under `"build"` alongside the existing `"win"` block.

## Required additions to `package.json` → `build`

```jsonc
{
  "build": {
    "appId": "com.meetel.flow",
    "productName": "Meetel Flow",
    "directories": {
      "buildResources": "build-resources"
    },
    "files": [
      "dist/**/*",
      "package.json"
    ],

    "mac": {
      "category": "public.app-category.productivity",
      "target": [
        { "target": "dmg", "arch": ["x64", "arm64"] },
        { "target": "zip", "arch": ["x64", "arm64"] }
      ],
      "icon": "build-resources/icon.icns",
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "build-resources/entitlements.mac.plist",
      "entitlementsInherit": "build-resources/entitlements.mac.plist",
      "notarize": false,
      "extendInfo": {
        "NSMicrophoneUsageDescription": "Meetel Flow uses your microphone to transcribe your voice into text in any application.",
        "NSAppleEventsUsageDescription": "Meetel Flow uses Apple Events to insert transcribed text into other applications.",
        "NSAccessibilityUsageDescription": "Meetel Flow needs Accessibility access to insert transcribed text into other applications.",
        "LSUIElement": true,
        "NSHighResolutionCapable": true,
        "LSMinimumSystemVersion": "10.15.0"
      }
    },

    "dmg": {
      "sign": false,
      "contents": [
        { "x": 130, "y": 220 },
        { "x": 410, "y": 220, "type": "link", "path": "/Applications" }
      ]
    },

    "afterSign": "build-resources/notarize.js"
  }
}
```

## Key-by-key explanation

| Key | Purpose |
|---|---|
| `NSMicrophoneUsageDescription` | Shown in the macOS system prompt the first time Meetel Flow calls `getUserMedia({ audio: true })`. Without this key, the call fails silently on macOS 10.14+. |
| `NSAppleEventsUsageDescription` | Shown when `inserter.ts` runs `osascript -e "tell application \"System Events\" to keystroke ..."`. Without this, macOS blocks cross-app keystroking. |
| `NSAccessibilityUsageDescription` | Required because `System Events` keystroking needs Accessibility permission. macOS reads this key when prompting the user in System Settings. |
| `LSUIElement` = `true` | Hides the dock icon. Meetel Flow is a floating widget driven from the tray, matching the Windows "skipTaskbar" behavior. |
| `NSHighResolutionCapable` = `true` | Enables Retina rendering. Without this, the app renders at 1x and looks blurry on Retina displays. |
| `LSMinimumSystemVersion` = `10.15.0` | Electron 34 requires macOS 10.15 (Catalina) or later. |

## Target architecture

Build both `x64` and `arm64`. The first cohort includes Apple Silicon machines
(M1–M4). An x64-only build would run through Rosetta 2 and incur CPU cost on
every Whisper fallback invocation.

## Notarization hook (`afterSign`)

When Dash is ready to notarize (requires an Apple Developer ID — see the audit
report), create `build-resources/notarize.js` that calls
`@electron/notarize`. Keep `"notarize": false` in the mac config and run
notarization via the `afterSign` hook so credentials stay in env vars
(`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

Until notarization is wired up, shipped DMGs will trigger Gatekeeper's
"Meetel Flow is damaged and can't be opened" dialog. The user-facing guide
(`docs/mac-user-permissions-guide.md`) documents the workaround.

## Icon asset required

`build-resources/icon.icns` does not currently exist. It must be generated
from a 1024×1024 source PNG. See `docs/mac-platform-audit.md` §"Retina asset
gaps" for the full list of required asset variants.
