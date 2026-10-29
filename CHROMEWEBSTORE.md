# Chrome Web Store Listing — FocusTube - Topic Deep-Dive & Distraction Blocker

> Last Updated: 2026-10-28

## Store Listing

**Extension Name** [REQUIRED]
FocusTube - Topic Deep-Dive & Distraction Blocker

**Short Description** [REQUIRED]
Study topics on YouTube without distractions. Replaces algorithmic feeds with focused queues, tag analysis, and timestamped notes.

**Detailed Description** [REQUIRED]
Eliminate YouTube algorithmic rabbit holes and master any topic with focused learning.

FocusTube helps learners, students, and professionals transform YouTube into an intentional learning environment. Choose a learning topic, analyze relevant tags in real time, queue focused videos, and take timestamped notes right inside the YouTube player sidebar.

KEY FEATURES
- Distraction Blocker: Hides distracting home feed recommendations, YouTube Shorts shelves, and algorithmic sidebars while you study.
- Smart Sidebar Replacement: Replaces the right-hand related video column on the watch page with an interactive Focus Workspace.
- Timestamped Notes: Capture key insights with a single click at the current video timestamp. Click any saved timestamp in your notes to immediately jump to that moment in the video.
- Export Notes: Export your study notes as structured Markdown (.md) documents or copy to clipboard for Obsidian, Notion, or personal notes.
- Focus & Pomodoro Timer: Built-in countdown study timer with audio chimes to keep your study sessions productive.
- Real-Time Topic Tag Analyzer: Discover related subtopics and tags directly as you build your curriculum.
- Curated Video Queue: Save and organize video playlists tailored exclusively to your learning goals.

HOW TO USE IT
1. Click the FocusTube icon in your browser toolbar.
2. Select an existing topic or create a new topic (e.g., "Web Development", "Calculus", "Machine Learning").
3. Use the tag analyzer to explore related subject keywords.
4. Browse YouTube: distraction feeds are automatically blocked, and the watch page sidebar provides your notes, queue, and timer.
5. Take timestamped notes during your video and export them anytime.

PRIVACY & PERMISSIONS
FocusTube stores your notes, topics, and preferences entirely locally on your device using Chrome local storage. It does not track your browsing history or sell any data.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Eliminates YouTube feed distractions and replaces the watch page sidebar with focused topic queues and timestamped notes.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Pending capture | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Pending capture | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Pending capture | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Pending capture | |

### Screenshot Notes
- Screenshot 1: YouTube watch page showing the replaced right-hand sidebar with Timestamped Notes and video player with active focus badge.
- Screenshot 2: YouTube Home page showing the clean Focus Hub banner with active topic and algorithmic grid hidden.
- Screenshot 3: FocusTube Extension Popup showing Topic Creator, Tag Analyzer, and Video Queue.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Stores the user's topics, custom tags, video queue, regex-indexed videos, study notes, and distraction toggle preferences locally on their machine. |
| `tabs` | permissions | Detects the active YouTube video URL and title when the user clicks the "Queue Current Tab" button in the popup to add the current video to their topic queue. |
| `https://*.youtube.com/*` | host_permissions | Injects the sidebar Focus Workspace, home feed topic recommendations, and handles search enforcement across desktop YouTube and mobile (m.youtube.com). |
| `https://suggestqueries.google.com/*` | host_permissions | Fetches real-time search suggestions and related tags when the user inputs a learning topic in the Tag Analyzer. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

All notes, topics, tags, and settings remain strictly on the user's local device via `chrome.storage.local`. No personal data, tracking analytics, or browsing histories are collected or transmitted off-device.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Distribution

**Visibility**: Public  
**Regions**: All regions

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.1.0 | 2026-10-28 | Added Regex-based Topic Heading & Tag Indexer, Home Page Dedicated Topic Video Feed, mobile and tablet responsiveness, and full m.youtube.com subdomain support. | Draft |
| 1.0.0 | 2026-10-28 | Initial release with Topic Manager, Real-time Tag Analyzer, YouTube Feed Distraction Blocker, Right-Side Focus Workspace, Timestamped Notes, and Pomodoro Timer. | Published |
