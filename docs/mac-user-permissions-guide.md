# Meetel Flow on Mac — Permissions & First-Run Guide

This guide walks you through the one-time setup Meetel Flow needs on macOS.
It takes about 3 minutes.

---

## Why Mac asks so many questions

Meetel Flow is a **dictation tool**. It listens to your voice and types the
result into whatever app is in front of you. To do that on macOS, it needs
three separate permissions:

1. **Microphone** — so it can hear what you say.
2. **Accessibility** — so it can type text into other apps on your behalf.
3. **Automation (System Events)** — so it can press keys across app boundaries.

Unlike Windows, macOS asks for each of these separately, and each one goes
through a different settings panel. This is not Meetel Flow being nosy — it's
how Apple designed the system. The good news: **it's a one-time setup**. Once
granted, the permissions stick.

Meetel Flow never sends your voice anywhere except the transcription provider
you chose (Groq by default). It does not record in the background. It only
listens when you press the hotkey.

---

## Step 1 — Microphone permission

The first time you press the Meetel Flow hotkey to dictate, macOS will pop up:

> **"Meetel Flow" would like to access the microphone.**
> Meetel Flow uses your microphone to transcribe your voice into text in any application.
>
> [Don't Allow]   [OK]

**Click OK.**

If you missed the popup or clicked "Don't Allow" by accident:

1. Open **System Settings** (Apple menu → System Settings, or press `⌘ Space` and type "System Settings").
2. In the sidebar, click **Privacy & Security**.
3. Scroll down and click **Microphone**.
4. Find **Meetel Flow** in the list.
5. Click the toggle so it turns **blue / on**.
6. Quit and relaunch Meetel Flow (tray icon → Quit → reopen from Applications).

---

## Step 2 — Accessibility permission

The first time Meetel Flow tries to **type transcribed text into another app**,
macOS will pop up:

> **"Meetel Flow" would like to control this computer using accessibility features.**
> Meetel Flow needs Accessibility access to insert transcribed text into other applications.
>
> [Deny]   [Open System Settings]

**Click Open System Settings.**

macOS will take you straight to the Accessibility list.

1. Find **Meetel Flow** in the list.
2. Click the toggle so it turns **blue / on**.
   - macOS will ask you to enter your Mac password or use Touch ID to confirm.
3. You don't need to restart the app — the permission takes effect immediately.

If you missed the popup:

1. Open **System Settings → Privacy & Security → Accessibility**.
2. If Meetel Flow isn't in the list yet, click the **+** button, navigate to
   `/Applications/Meetel Flow.app`, and add it.
3. Toggle it on.

---

## Step 3 — Automation permission (System Events)

Closely related to Accessibility. The first time Meetel Flow tries to type,
macOS may also pop up:

> **"Meetel Flow" wants to control "System Events".**
> Meetel Flow uses Apple Events to insert transcribed text into other applications.
>
> [Don't Allow]   [OK]

**Click OK.**

If you denied it by accident:

1. Open **System Settings → Privacy & Security → Automation**.
2. Scroll down and find **Meetel Flow**.
3. Expand it — you'll see "System Events" listed underneath.
4. Turn the toggle on.

If "Meetel Flow" doesn't appear in the Automation list at all, trigger a
dictation + insert cycle once more — macOS only adds apps to this list after
they've requested the permission at least once.

---

## Step 4 — "Meetel Flow is damaged and can't be opened" (unsigned builds)

If you installed Meetel Flow from a DMG that was **not yet notarized by Apple**
(the first release builds for the initial cohort), macOS may refuse to open
the app with:

> "Meetel Flow" is damaged and can't be opened. You should move it to the Trash.

This is **not actually damage**. It means the DMG wasn't signed with an Apple
Developer ID, so macOS quarantined it. You have two options.

### Option A — Remove the quarantine attribute (recommended)

1. Open the Terminal app (press `⌘ Space` and type "Terminal").
2. Paste this command exactly and press Return:
   ```bash
   xattr -d com.apple.quarantine "/Applications/Meetel Flow.app"
   ```
3. If prompted for your Mac password, enter it.
4. Relaunch Meetel Flow from Applications.

### Option B — Right-click Open (older workaround)

1. Open **Finder** → **Applications**.
2. **Right-click** (or Control-click) on **Meetel Flow**.
3. Choose **Open** from the menu.
4. A dialog asks "Are you sure you want to open it?" — click **Open**.
5. From now on, double-clicking Meetel Flow will work normally.

Once Meetel Flow ships signed + notarized builds (coming with the stable
release), this workaround will no longer be needed — the DMG will open cleanly
on first double-click.

---

## Step 5 — Fix the Cmd+Space hotkey conflict with Spotlight

By default, Meetel Flow uses **`⌘ Space`** (Cmd+Space) to start and stop
dictation. On macOS, this same shortcut is used by **Spotlight**, Apple's
built-in search. You can't have both.

You have three options. Pick whichever feels least disruptive.

### Option A — Change Meetel Flow's hotkey (recommended)

In Meetel Flow's settings panel, change the hotkey to one of:

- **`⌘ ⇧ Space`** (Cmd+Shift+Space) — doesn't conflict with anything on Mac or Windows.
- **`⌥ Space`** (Option+Space) — short and free on Mac.
- **`⌃ Space`** (Ctrl+Space) — free on Mac but conflicts with IME on Windows.

Open the Meetel Flow settings panel (the gear icon) → Hotkey → choose a new
combination. If hotkey rebinding is not yet available in-app, edit
`~/.meetel-flow/config.json` directly.

### Option B — Change Spotlight's hotkey

1. Open **System Settings → Keyboard → Keyboard Shortcuts…**
2. In the left sidebar, click **Spotlight**.
3. Click the current shortcut next to **Show Spotlight search**.
4. Press a new combination, for example **`⌘ ⌥ Space`** (Cmd+Option+Space).
5. Click **Done**.

Now `⌘ Space` is free for Meetel Flow. Quit and relaunch Meetel Flow so it can
re-register the hotkey.

### Option C — Disable Spotlight's shortcut entirely

Some users navigate with Raycast, Alfred, or LaunchBar instead of Spotlight.
If you're one of them, you can simply **uncheck** Spotlight's shortcut in
System Settings → Keyboard → Keyboard Shortcuts → Spotlight. Meetel Flow will
then claim `⌘ Space` on launch.

---

## Verifying the setup

After you've granted all three permissions and resolved the hotkey conflict,
do this quick smoke test:

1. Open **TextEdit** and create a new blank document.
2. Click once inside the document so the cursor is blinking.
3. Press the Meetel Flow hotkey (whatever you chose in Step 5).
4. The Meetel Flow widget should show **"Listening…"**.
5. Say a short sentence in your chosen language. For example:
   *"Hello, this is a test of Meetel Flow on macOS."*
6. Press the hotkey again to stop listening.
7. Within 1–3 seconds, the transcribed text should appear **inside TextEdit**.

If any step fails:

| Symptom | Likely cause | Fix |
|---|---|---|
| Widget says "No voice detected" | Mic permission denied, or wrong mic selected | Step 1; or change mic in Meetel Flow settings |
| Widget transcribes but nothing appears in TextEdit | Accessibility or Automation permission denied | Steps 2 and 3 |
| Hotkey does nothing, not even a sound | Hotkey collision (probably Spotlight) | Step 5 |
| "Meetel Flow is damaged" on launch | Unsigned build, macOS quarantined it | Step 4 |
| Transcription sounds sped up / chipmunked in the log | Sample rate bug — please report to the Meetel team with the contents of `~/.meetel-flow/stt.log` | Report |
| French accents (é, è, ç) come through as garbage | Language setting is wrong, or insertion method stripped them | Set language to French in settings |

---

## Where Meetel Flow keeps its data on Mac

Everything lives in a hidden folder in your home directory:

```
~/.meetel-flow/
├── config.json       ← your settings and API keys
├── debug.log         ← main process log (useful for bug reports)
├── stt.log           ← transcription log (sensitive — contains transcribed text)
└── whisper/          ← optional local fallback (not auto-installed on Mac yet)
```

To inspect it: in Finder, press `⌘ ⇧ G` and type `~/.meetel-flow`, then press
Return. You'll usually only open this folder when asked to share a log file
for a bug report.

To fully uninstall Meetel Flow:

1. Quit Meetel Flow (tray icon → Quit).
2. Drag **Meetel Flow.app** from Applications to the Trash.
3. In Terminal: `rm -rf ~/.meetel-flow`
4. Empty the Trash.

---

## Getting help

If you hit something not covered here, grab the contents of
`~/.meetel-flow/debug.log` (last 50 lines is usually enough) and the first
line of `~/.meetel-flow/stt.log`, and include them with your bug report.

**Welcome to Meetel Flow on Mac.**
