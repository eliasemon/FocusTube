# FocusTube - Topic Deep-Dive & Distraction Blocker (Chrome Extension)

A Chrome extension built with Manifest V3 designed to turn YouTube into a distraction-free learning environment. Choose a topic, analyze and discover tags, block algorithmic feeds, and replace YouTube's right-hand recommendation column with an interactive **Focus Workspace** for timestamped notes, topic queues, and focus timers.

---

## ✨ Features

### 1. 🎯 Topic Selection & Real-Time Tag Analyzer
- Create and switch between distinct learning topics (e.g. *Full-Stack Development*, *Machine Learning*, *Quantum Computing*).
- **Tag Analyzer**: Queries real-time YouTube topic completions to explore subtopics, related keywords, and tags as you build your learning curriculum.
- 1-click search on YouTube scoped directly to your selected topic or tag.

### 2. ⚡ Large-Scale Topic Indexer (50 - 100+ Videos) & Native Infinite Scroll Feed
- **Large-Scale Indexing**: When a topic is created or selected, FocusTube performs multi-query parallel searches across topic permutations (tutorials, full courses, roadmaps, project builds, and sub-tags) to index 50 to 100+ videos per topic.
- **Complete Home Page Distraction Cleanup**: Removes all algorithmic video feeds, chips bars, Shorts shelves, banners, and **the left-side navigation menubar** (which prevents navigating away to unrelated channels or Shorts), leaving **ONLY the top search bar**.
- **Native-Style Video Grid & Zero-Shift Scroll**: Renders a full-width video grid that looks and feels just like native YouTube (16:9 thumbnails, duration badges, channel avatars, view counts, clean titles). As you scroll, new cards append smoothly at the bottom with zero jumping or layout shifts.
- **Video Ending Protection & Next Topic Endscreen**: Blocks YouTube's default algorithmic endscreen video grid and countdown popup. When a video ends, FocusTube presents a focused overlay showing the next indexed or queued topic video with a 1-click play button and a replay option.

### 3. 📱 Full Mobile & Tablet Support (`m.youtube.com`)
- **Subdomain Ready**: Fully compatible with `m.youtube.com`, `www.youtube.com`, and tablet/mobile viewports (e.g. Kiwi Browser, Orion, Chrome on Android tablets).
- **Responsive Workspace**: On mobile devices where the desktop right sidebar isn't present, the Focus Workspace seamlessly docks right beneath the video player with touch-friendly controls.
- **Mobile Search Enforcer**: Intercepts mobile YouTube search forms and redirects off-topic searches to your selected learning topic.

### 3. 📝 Right-Side Sidebar Replacement (Focus Workspace)
On any YouTube video watch page (`/watch?v=...`), the right sidebar (`#secondary`) is replaced with an interactive **Focus Workspace**:
- **📝 Rich Text Notes & Live Playback Sync**:
  - **Live Synchronized Video Timer**: Displays real-time playback time ticking with a pulsing live indicator.
  - **📍 Grab Timestamp Button**: Click to snapshot and lock the exact video time (`📌 Locked at: 03:45`) for your note, or click `↺ Sync Live` to resume real-time tracking.
  - **Simple Rich Text Editor**: Format takeaways with **Bold** (<kbd>Ctrl+B</kbd>), *Italic* (<kbd>Ctrl+I</kbd>), <u>Underline</u> (<kbd>Ctrl+U</kbd>), <s>Strikethrough</s>, Text Headings (H1/H2/H3), Bullet Lists (`•`), Numbered Lists (`1.`), 🖍 Key Idea Highlights, and `code` snippets.
  - **Inline Editing with Rich Toolbar**: Click `✎ Edit` or double-click any note to open inline rich text editing and one-click timestamp re-syncing.
  - **Interactive Playback Seeking**: Click any saved timestamp pill (`▶ 03:45`) in your notes to jump directly to that moment.
  - **Multi-Format Note Export (PDF, Word DOCX & Markdown)**:
    - **PDF (.pdf)**: Generates high-resolution, professionally formatted multi-page PDFs with automatic page breaks, isolated clean typography, embedded video screenshots, clickable video timestamps, and complete Unicode support (including Bangla).
    - **Word (.docx)**: Generates genuine Microsoft Word documents (.docx) with editable headings, formatted text runs, task lists with checkboxes, code blocks with shading, blockquotes, and embedded screenshots maintaining aspect ratio and captions.
    - **Obsidian & Markdown (.md)**: Converts formatted rich text into standard Markdown for Obsidian, Notion, Logseq, and `.md` files.
- **📚 Curated Topic Queue**:
  - Keep a queue of videos specifically related to the active topic.
  - "+ Queue Current Video" button grabs the active video, title, thumbnail, and channel into your study queue.
  - Click through your queue sequentially without touching recommendations.
- **⏱️ Study & Pomodoro Timer**:
  - Built-in study timer (customizable 5–180 minutes) with start/pause/reset controls.
  - Plays an auditory chime via Web Audio when your session finishes.
- **🏷️ Topic Tags & Concepts**:
  - Visual tags for the topic with 1-click search buttons.

### 4. ⚙️ Extension Popup
- Instant **Master Focus Toggle** switch (ON/OFF).
- Topic management & tag search.
- Video queue browser.
- Global notes manager & all-notes Markdown export.
- Granular blocker toggles and optional YouTube Data API v3 key setting.

---

## 🚀 How to Install & Use in Chrome

### Step 1: Load into Chrome
1. Open Google Chrome.
2. In the URL bar, go to: `chrome://extensions/`
3. Toggle on **Developer mode** in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select this project folder:
   ```
   /Users/eliasemon/Projects/personal-projects/Focused topic
   ```
6. FocusTube will appear in your extensions list and toolbar!

### Step 2: Pin the Extension
Click the puzzle piece icon (Extensions) in Chrome's top-right toolbar and click the pin icon next to **FocusTube**.

### Step 3: Start a Focused Session
1. Click the **FocusTube** icon in your toolbar.
2. Pick a learning topic or click `+` to create a new one (e.g. `Next.js 15`).
3. Click **Analyze** to explore related tags from YouTube.
4. Open [YouTube](https://www.youtube.com):
   - Notice the home feed is replaced by your **Focus Hub**.
   - Click any video or open your topic search.
   - On the watch page, the right side is now your **Notes & Queue Workspace**!
   - Take notes with timestamps, jump backwards/forwards by clicking timestamps, and stay completely in the zone.

---

## 📂 Project Architecture

```
Focused topic/
├── manifest.json              # Chrome Manifest V3 configuration
├── icons/                     # Standard icons (16px, 48px, 128px PNG)
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── background/
│   └── service-worker.js      # Background worker, state init, badge, API suggestions
├── content/
│   ├── content.js             # YouTube DOM injector, sidebar workspace, notes, timer
│   └── content.css            # Distraction blocker styles & sidebar workspace theme
├── popup/
│   ├── popup.html             # Extension popup interface
│   ├── popup.css              # Glassmorphic dark styling
│   └── popup.js               # Topic management, tag analyzer, queue, settings
├── CHROMEWEBSTORE.md          # Store listing metadata, permissions justification
└── README.md                  # Installation & usage documentation
```

---

## 🔒 Privacy & Permissions
- **All data stays on your local device**: Notes, topics, and settings are saved using Chrome's native `chrome.storage.local`.
- Zero tracking or telemetry.
- No external server dependencies.
