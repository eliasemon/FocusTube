/**
 * FocusTube Popup Controller (Manifest V3)
 * Manages topic creation, real-time tag analyzer, video queue, notes viewer, and distraction blocker settings.
 */

document.addEventListener('DOMContentLoaded', async () => {
  let state = {
    focusModeEnabled: true,
    activeTopic: "Full-Stack Web Development",
    topics: [],
    blockHomeFeed: true,
    blockShorts: true,
    blockSidebarVideos: true,
    blockComments: false,
    timerDurationMinutes: 25,
    videoQueue: [],
    notes: {},
    youtubeApiKey: ""
  };

  let newTopicSelectedTags = [];

  // DOM Elements
  const masterToggle = document.getElementById('master-focus-toggle');
  const navButtons = document.querySelectorAll('.nav-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const topicSelect = document.getElementById('topic-select');
  const btnShowNewTopic = document.getElementById('btn-show-new-topic');
  const newTopicBox = document.getElementById('new-topic-box');
  const btnCancelTopic = document.getElementById('btn-cancel-topic');
  const newTopicNameInput = document.getElementById('new-topic-name');
  const tagSearchInput = document.getElementById('tag-search-input');
  const btnSearchTags = document.getElementById('btn-search-tags');
  const tagSuggestionsBox = document.getElementById('tag-suggestions-box');
  const selectedTagsBox = document.getElementById('selected-tags-box');
  const btnSaveTopic = document.getElementById('btn-save-topic');
  const activeTagsCloud = document.getElementById('active-tags-cloud');
  const btnSearchTopicYT = document.getElementById('btn-search-topic-youtube');
  const btnQueueCurrentTab = document.getElementById('btn-queue-current-tab');
  const popupQueueList = document.getElementById('popup-queue-list');
  const queueCountBadge = document.getElementById('queue-count-badge');
  const popupNotesList = document.getElementById('popup-notes-list');
  const btnExportAllNotes = document.getElementById('btn-export-all-notes');
  const btnExportNotesDocx = document.getElementById('btn-export-notes-docx');
  const checkBlockHome = document.getElementById('check-block-home');
  const checkBlockSidebar = document.getElementById('check-block-sidebar');
  const checkBlockShorts = document.getElementById('check-block-shorts');
  const checkBlockComments = document.getElementById('check-block-comments');
  const apiKeyInput = document.getElementById('api-key-input');
  const btnSaveApiKey = document.getElementById('btn-save-api-key');
  const timerDurationInput = document.getElementById('timer-duration-input');
  const btnSaveTimer = document.getElementById('btn-save-timer');
  const indexedCountBadge = document.getElementById('indexed-count-badge');
  const btnReindexTopic = document.getElementById('btn-reindex-topic');
  const statusPill = document.getElementById('status-pill');

  // Load initial settings
  async function loadState() {
    const data = await chrome.storage.local.get(null);
    state = { ...state, ...data };

    // Set Master Toggle
    masterToggle.checked = !!state.focusModeEnabled;

    // Set Settings Checkboxes
    checkBlockHome.checked = !!state.blockHomeFeed;
    checkBlockSidebar.checked = !!state.blockSidebarVideos;
    checkBlockShorts.checked = !!state.blockShorts;
    checkBlockComments.checked = !!state.blockComments;

    // Set API Key & Timer inputs
    apiKeyInput.value = state.youtubeApiKey || "";
    timerDurationInput.value = state.timerDurationMinutes || 25;

    renderTopicSelect();
    renderActiveTopicTags();
    renderQueue();
    renderNotes();
    updateIndexedBadge();
  }

  function updateIndexedBadge() {
    const active = (state.topics || []).find(t => t.name === state.activeTopic);
    if (!active || !indexedCountBadge) return;
    const indexed = (state.indexedVideos && state.indexedVideos[active.id]) || [];
    indexedCountBadge.textContent = `${indexed.length} Indexed`;
  }

  // ==========================================================
  // Tab Navigation
  // ==========================================================
  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      navButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetTabId = btn.getAttribute('data-tab');
      const targetPane = document.getElementById(targetTabId);
      if (targetPane) {
        targetPane.classList.add('active');
      }
    });
  });

  // ==========================================================
  // Master Focus Toggle
  // ==========================================================
  masterToggle.addEventListener('change', async () => {
    state.focusModeEnabled = masterToggle.checked;
    await chrome.storage.local.set({ focusModeEnabled: state.focusModeEnabled });
    flashStatus(state.focusModeEnabled ? "Focus Mode ON" : "Focus Mode OFF");
  });

  // ==========================================================
  // Topic Selector & Creation
  // ==========================================================
  function renderTopicSelect() {
    topicSelect.innerHTML = '';
    (state.topics || []).forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      if (t.name === state.activeTopic) {
        opt.selected = true;
      }
      topicSelect.appendChild(opt);
    });
  }

  topicSelect.addEventListener('change', async () => {
    state.activeTopic = topicSelect.value;
    await chrome.storage.local.set({ activeTopic: state.activeTopic });
    renderActiveTopicTags();
    renderQueue();
    updateIndexedBadge();
    flashStatus(`Active Topic: ${state.activeTopic}`);
  });

  btnReindexTopic?.addEventListener('click', async () => {
    const active = (state.topics || []).find(t => t.name === state.activeTopic);
    if (!active) return;

    btnReindexTopic.textContent = "⚡ Indexing videos...";
    flashStatus("Indexing videos with regex...");

    chrome.runtime.sendMessage({ type: "INDEX_TOPIC_VIDEOS", topic: active }, async (res) => {
      btnReindexTopic.textContent = "⚡ Re-Index Topic Videos with Regex";
      if (res && res.videos) {
        const data = await chrome.storage.local.get('indexedVideos');
        state.indexedVideos = data.indexedVideos || {};
        updateIndexedBadge();
        flashStatus(`Indexed ${res.videos.length} videos!`);
      }
    });
  });

  function renderActiveTopicTags() {
    activeTagsCloud.innerHTML = '';
    const current = (state.topics || []).find(t => t.name === state.activeTopic);
    const tags = current?.tags || [];

    if (tags.length === 0) {
      activeTagsCloud.innerHTML = '<span style="color:#64748b;font-size:11px;">No tags defined for this topic.</span>';
      return;
    }

    tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-pill';
      chip.textContent = `#${tag}`;
      chip.style.cursor = 'pointer';
      chip.title = 'Click to search on YouTube';
      chip.addEventListener('click', () => {
        openYouTubeSearch(tag);
      });
      activeTagsCloud.appendChild(chip);
    });
  }

  btnShowNewTopic.addEventListener('click', () => {
    newTopicBox.classList.remove('hidden');
    newTopicNameInput.value = '';
    tagSearchInput.value = '';
    tagSuggestionsBox.innerHTML = '';
    selectedTagsBox.innerHTML = '';
    newTopicSelectedTags = [];
    newTopicNameInput.focus();
  });

  btnCancelTopic.addEventListener('click', () => {
    newTopicBox.classList.add('hidden');
  });

  // ==========================================================
  // Real-time Tag Analyzer via YouTube Suggest API
  // ==========================================================
  async function analyzeTags() {
    const q = tagSearchInput.value.trim() || newTopicNameInput.value.trim();
    if (!q) {
      flashStatus("Enter a topic or tag to analyze");
      return;
    }

    tagSuggestionsBox.innerHTML = '<span style="color:#94a3b8;font-size:11px;">Analyzing YouTube tags...</span>';

    try {
      const res = await chrome.runtime.sendMessage({
        type: "FETCH_TOPIC_SUGGESTIONS",
        query: q
      });

      tagSuggestionsBox.innerHTML = '';
      if (res && res.success && res.suggestions && res.suggestions.length > 0) {
        res.suggestions.slice(0, 10).forEach(sugg => {
          const chip = document.createElement('span');
          chip.className = 'sugg-chip';
          chip.textContent = `+ ${sugg}`;
          chip.addEventListener('click', () => {
            addSelectedTag(sugg);
          });
          tagSuggestionsBox.appendChild(chip);
        });
      } else {
        tagSuggestionsBox.innerHTML = '<span style="color:#64748b;font-size:11px;">No specific tags found. Try another keyword.</span>';
      }
    } catch (err) {
      tagSuggestionsBox.innerHTML = `<span style="color:#ef4444;font-size:11px;">Error: ${err.message}</span>`;
    }
  }

  btnSearchTags.addEventListener('click', analyzeTags);
  tagSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') analyzeTags();
  });

  function addSelectedTag(tag) {
    const normalized = tag.toLowerCase().trim();
    if (!newTopicSelectedTags.includes(normalized)) {
      newTopicSelectedTags.push(normalized);
      renderSelectedTags();
    }
  }

  function renderSelectedTags() {
    selectedTagsBox.innerHTML = '';
    newTopicSelectedTags.forEach(tag => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.innerHTML = `
        <span>#${tag}</span>
        <span class="tag-pill-del" data-tag="${tag}">×</span>
      `;
      pill.querySelector('.tag-pill-del').addEventListener('click', () => {
        newTopicSelectedTags = newTopicSelectedTags.filter(t => t !== tag);
        renderSelectedTags();
      });
      selectedTagsBox.appendChild(pill);
    });
  }

  btnSaveTopic.addEventListener('click', async () => {
    const name = newTopicNameInput.value.trim();
    if (!name) {
      alert("Please enter a topic name.");
      return;
    }

    const exists = (state.topics || []).some(t => t.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      alert("A topic with this name already exists.");
      return;
    }

    // Default tag if none selected
    if (newTopicSelectedTags.length === 0) {
      newTopicSelectedTags.push(name.toLowerCase());
    }

    const newTopic = {
      id: 'topic_' + Date.now(),
      name,
      tags: [...newTopicSelectedTags],
      createdAt: Date.now()
    };

    const topics = [...(state.topics || []), newTopic];
    state.topics = topics;
    state.activeTopic = name;

    await chrome.storage.local.set({ topics, activeTopic: name });

    newTopicBox.classList.add('hidden');
    renderTopicSelect();
    renderActiveTopicTags();
    flashStatus(`Topic "${name}" created! Indexing...`);

    // Automatically index topic videos in background using regex engine
    chrome.runtime.sendMessage({ type: "INDEX_TOPIC_VIDEOS", topic: newTopic }, async (res) => {
      if (res && res.videos) {
        const data = await chrome.storage.local.get('indexedVideos');
        state.indexedVideos = data.indexedVideos || {};
        updateIndexedBadge();
        flashStatus(`Ready! ${res.videos.length} videos indexed.`);
      }
    });
  });

  // ==========================================================
  // YouTube Search & Current Tab Queueing
  // ==========================================================
  function openYouTubeSearch(query) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    chrome.tabs.create({ url });
  }

  btnSearchTopicYT.addEventListener('click', () => {
    if (state.activeTopic) {
      openYouTubeSearch(state.activeTopic);
    }
  });

  btnQueueCurrentTab.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes("youtube.com/watch")) {
      alert("Please open a YouTube video tab first to queue it.");
      return;
    }

    const urlObj = new URL(tab.url);
    const videoId = urlObj.searchParams.get('v');
    if (!videoId) {
      alert("Could not detect video ID.");
      return;
    }

    const alreadyQueued = (state.videoQueue || []).some(v => v.id === videoId);
    if (alreadyQueued) {
      flashStatus("Video already in queue!");
      return;
    }

    const title = tab.title ? tab.title.replace(' - YouTube', '') : 'YouTube Video';
    const newVideo = {
      id: videoId,
      title,
      channelTitle: '',
      topic: state.activeTopic,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      addedAt: Date.now()
    };

    const videoQueue = [...(state.videoQueue || []), newVideo];
    state.videoQueue = videoQueue;
    await chrome.storage.local.set({ videoQueue });

    renderQueue();
    flashStatus("Queued current video!");
  });

  // ==========================================================
  // Video Queue View
  // ==========================================================
  function renderQueue() {
    popupQueueList.innerHTML = '';
    const queue = state.videoQueue || [];
    queueCountBadge.textContent = queue.length;

    if (queue.length === 0) {
      popupQueueList.innerHTML = `
        <div style="text-align: center; color: #64748b; padding: 28px 0; font-size: 12px;">
          No videos queued yet.<br/>Queue from the active tab or YouTube sidebar.
        </div>
      `;
      return;
    }

    queue.forEach(item => {
      const card = document.createElement('div');
      card.className = 'video-card';
      card.innerHTML = `
        <img class="video-thumb" src="${item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`}" alt="thumb">
        <div class="video-info">
          <div class="video-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="video-sub">${escapeHtml(item.channelTitle || item.topic || 'Video')}</div>
        </div>
        <button class="btn-close btn-del-queue" data-id="${item.id}" title="Remove">×</button>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-del-queue')) return;
        chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${item.id}` });
      });

      card.querySelector('.btn-del-queue').addEventListener('click', async (e) => {
        e.stopPropagation();
        const removeId = item.id;
        state.videoQueue = state.videoQueue.filter(v => v.id !== removeId);
        await chrome.storage.local.set({ videoQueue: state.videoQueue });
        renderQueue();
        flashStatus("Removed from queue");
      });

      popupQueueList.appendChild(card);
    });
  }

  // ==========================================================
  // Notes Viewer & Global Export
  // ==========================================================
  function renderNotes() {
    popupNotesList.innerHTML = '';
    const notesMap = state.notes || {};
    const videoIds = Object.keys(notesMap).filter(id => notesMap[id] && notesMap[id].length > 0);

    if (videoIds.length === 0) {
      popupNotesList.innerHTML = `
        <div style="text-align: center; color: #64748b; padding: 28px 0; font-size: 12px;">
          No notes taken yet.<br/>Open a YouTube video in Focus Mode to capture timestamps and key ideas!
        </div>
      `;
      return;
    }

    videoIds.forEach(videoId => {
      const notes = notesMap[videoId];
      const groupCard = document.createElement('div');
      groupCard.className = 'note-group-card';
      groupCard.innerHTML = `
        <div class="note-group-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" style="color: #38bdf8; text-decoration: none;">
            🎬 Video: ${videoId} (${notes.length} note${notes.length === 1 ? '' : 's'})
          </a>
          <div class="note-group-actions" style="display: flex; gap: 4px;">
            <button class="btn-xs btn-export-video-notes" data-vid="${videoId}" data-fmt="docx" title="Export all notes for this video as Word (.docx)">All DOCX</button>
            <button class="btn-xs btn-export-video-notes" data-vid="${videoId}" data-fmt="md" title="Export all notes for this video as Markdown (.md)">All MD</button>
          </div>
        </div>
        <div class="notes-subitems-container">
          ${notes.map(n => `
            <div class="note-subitem" data-note-id="${n.id}">
              <div class="note-subitem-header">
                <span class="note-time">[${formatSeconds(n.seconds)}]</span>
                <div class="note-subitem-btns">
                  <button class="btn-note-action btn-export-popup-note" data-vid="${videoId}" data-nid="${n.id}" data-fmt="docx" title="Export this note as Word (.docx)">DOCX</button>
                  <button class="btn-note-action btn-export-popup-note" data-vid="${videoId}" data-nid="${n.id}" data-fmt="md" title="Export this note as Markdown (.md)">MD</button>
                  <button class="btn-note-action btn-edit-popup-note" data-vid="${videoId}" data-nid="${n.id}" title="Edit note">✎</button>
                  <button class="btn-note-action btn-del-popup-note" data-vid="${videoId}" data-nid="${n.id}" title="Delete note">×</button>
                </div>
              </div>
              <div class="note-text-display rich-note-content" data-nid="${n.id}">${sanitizeRichHtml(n.text)}</div>
              <div class="note-edit-box" data-edit-nid="${n.id}" style="display: none;">
                <textarea class="note-edit-textarea" data-ta-nid="${n.id}" placeholder="Edit your note...">${escapeHtml(n.text)}</textarea>
                <div class="note-edit-actions">
                  <button class="btn-sm btn-cancel-popup-note" data-nid="${n.id}">Cancel</button>
                  <button class="btn-sm btn-save-popup-note" data-vid="${videoId}" data-nid="${n.id}">Save</button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      popupNotesList.appendChild(groupCard);
    });

    // Wire up edit buttons
    popupNotesList.querySelectorAll('.btn-edit-popup-note').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nid = btn.getAttribute('data-nid');
        const item = popupNotesList.querySelector(`.note-subitem[data-note-id="${nid}"]`);
        if (!item) return;
        const textDisplay = item.querySelector(`.note-text-display[data-nid="${nid}"]`);
        const editBox = item.querySelector(`.note-edit-box[data-edit-nid="${nid}"]`);
        const ta = item.querySelector(`.note-edit-textarea[data-ta-nid="${nid}"]`);
        if (textDisplay && editBox && ta) {
          textDisplay.style.display = 'none';
          editBox.style.display = 'flex';
          btn.style.display = 'none';
          ta.focus();
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      });
    });

    // Cancel edit
    popupNotesList.querySelectorAll('.btn-cancel-popup-note').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nid = btn.getAttribute('data-nid');
        const item = popupNotesList.querySelector(`.note-subitem[data-note-id="${nid}"]`);
        if (!item) return;
        const textDisplay = item.querySelector(`.note-text-display[data-nid="${nid}"]`);
        const editBox = item.querySelector(`.note-edit-box[data-edit-nid="${nid}"]`);
        const editBtn = item.querySelector(`.btn-edit-popup-note[data-nid="${nid}"]`);
        const origNote = (state.notes || {})[btn.closest('.note-group-card')?.querySelector('a')?.href.split('v=')[1]]?.find(n => n.id === nid);
        const ta = item.querySelector(`.note-edit-textarea[data-ta-nid="${nid}"]`);
        if (ta && origNote) {
          ta.value = origNote.text;
        }
        if (textDisplay && editBox) {
          textDisplay.style.display = 'block';
          editBox.style.display = 'none';
          if (editBtn) editBtn.style.display = 'inline-block';
        }
      });
    });

    // Save edit
    popupNotesList.querySelectorAll('.btn-save-popup-note').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const vid = btn.getAttribute('data-vid');
        const nid = btn.getAttribute('data-nid');
        const item = popupNotesList.querySelector(`.note-subitem[data-note-id="${nid}"]`);
        if (!item) return;
        const ta = item.querySelector(`.note-edit-textarea[data-ta-nid="${nid}"]`);
        const newText = ta ? ta.value.trim() : '';
        if (newText && state.notes && state.notes[vid]) {
          state.notes[vid] = state.notes[vid].map(n => n.id === nid ? { ...n, text: newText, updatedAt: Date.now() } : n);
          await chrome.storage.local.set({ notes: state.notes });
          flashStatus("Note updated!");
          renderNotes();
        }
      });
    });

    // Keyboard shortcuts in popup textarea
    popupNotesList.querySelectorAll('.note-edit-textarea').forEach(ta => {
      ta.addEventListener('keydown', (e) => {
        const nid = ta.getAttribute('data-ta-nid');
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          const item = ta.closest('.note-subitem');
          const saveBtn = item?.querySelector(`.btn-save-popup-note[data-nid="${nid}"]`);
          saveBtn?.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          const item = ta.closest('.note-subitem');
          const cancelBtn = item?.querySelector(`.btn-cancel-popup-note[data-nid="${nid}"]`);
          cancelBtn?.click();
        }
      });
    });

    // Delete note
    popupNotesList.querySelectorAll('.btn-del-popup-note').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const vid = btn.getAttribute('data-vid');
        const nid = btn.getAttribute('data-nid');
        if (state.notes && state.notes[vid]) {
          state.notes[vid] = state.notes[vid].filter(n => n.id !== nid);
          await chrome.storage.local.set({ notes: state.notes });
          flashStatus("Note deleted");
          renderNotes();
        }
      });
    });

    // Wire up video-level export buttons (Mode: All notes of each video)
    popupNotesList.querySelectorAll('.btn-export-video-notes').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = btn.getAttribute('data-vid');
        const fmt = btn.getAttribute('data-fmt');
        if (vid && fmt) {
          exportVideoNotes(vid, fmt);
        }
      });
    });

    // Wire up single note export buttons (Mode: Specific note)
    popupNotesList.querySelectorAll('.btn-export-popup-note').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = btn.getAttribute('data-vid');
        const nid = btn.getAttribute('data-nid');
        const fmt = btn.getAttribute('data-fmt');
        if (vid && nid && fmt) {
          exportSpecificNote(vid, nid, fmt);
        }
      });
    });
  }

  async function exportVideoNotes(videoId, format = 'docx') {
    const vidNotes = (state.notes && state.notes[videoId]) || [];
    if (vidNotes.length === 0) {
      alert("No notes found for this video.");
      return;
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const sanitizeFn = window.FocusTubeExport?.sanitizeFilename || ((t) => t.replace(/[\/\\?%*:|"<>~]/g, '_'));
    const safeTitle = sanitizeFn(`FocusTube_Video_${videoId}_AllNotes`);
    const docTitle = `FocusTube Study Notes: Video ${videoId}`;
    const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

    flashStatus(`Exporting video notes as ${format.toUpperCase()}...`);

    try {
      if (format === 'md') {
        let md = `# FocusTube Study Notes: Video ${videoId}\n`;
        md += `*Topic:* ${state.activeTopic || 'General Study'}\n`;
        md += `*Video URL:* ${videoUrl}\n`;
        md += `*Date:* ${dateStr}\n\n---\n\n`;

        vidNotes.forEach(note => {
          const timeStr = formatSeconds(note.seconds);
          const mdContent = htmlToMarkdown(note.text);
          md += `### [${timeStr}](${videoUrl}&t=${note.seconds}s)\n${mdContent}\n\n`;
        });

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeTitle}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        flashStatus("Video notes exported!");
        return;
      }

      if (format === 'docx') {
        if (!window.FocusTubeExport) {
          throw new Error("Export engine is initializing. Please try again.");
        }
        const docData = {
          title: docTitle,
          topic: state.activeTopic || 'General Study',
          videoUrl: videoUrl,
          date: dateStr,
          notes: vidNotes
        };
        const res = await window.FocusTubeExport.exportNotesToDocx(docData, {
          filename: `${safeTitle}.docx`
        });
        flashStatus(`Word doc exported: ${res.filename}`);
      }
    } catch (err) {
      console.error('[FocusTube Popup] Export video notes failed:', err);
      flashStatus("Export failed!");
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    }
  }

  async function exportSpecificNote(videoId, noteId, format = 'docx') {
    const vidNotes = (state.notes && state.notes[videoId]) || [];
    const note = vidNotes.find(n => n.id === noteId);
    if (!note) {
      alert("Note not found.");
      return;
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const timeStr = formatSeconds(note.seconds);
    const safeTime = timeStr.replace(/[:.]/g, '-');
    const sanitizeFn = window.FocusTubeExport?.sanitizeFilename || ((t) => t.replace(/[\/\\?%*:|"<>~]/g, '_'));
    const baseFilename = sanitizeFn(`FocusTube_Video_${videoId}_Note_${safeTime}`);
    const docTitle = `FocusTube Note [${timeStr}]: Video ${videoId}`;
    const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

    flashStatus(`Exporting note as ${format.toUpperCase()}...`);

    try {
      if (format === 'md') {
        let md = `# FocusTube Study Note: Video ${videoId}\n`;
        md += `*Topic:* ${state.activeTopic || 'General Study'}\n`;
        md += `*Video URL:* [${videoUrl}&t=${note.seconds}s](${videoUrl}&t=${note.seconds}s)\n`;
        md += `*Timestamp:* ${timeStr}\n`;
        md += `*Date:* ${dateStr}\n\n---\n\n`;
        md += `${htmlToMarkdown(note.text)}\n`;

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseFilename}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        flashStatus("Note exported as Markdown!");
        return;
      }

      if (format === 'docx') {
        if (!window.FocusTubeExport) {
          throw new Error("Export engine is initializing. Please try again.");
        }
        const docData = {
          title: docTitle,
          topic: state.activeTopic || 'General Study',
          videoUrl: videoUrl,
          date: dateStr,
          notes: [note]
        };
        const res = await window.FocusTubeExport.exportNotesToDocx(docData, {
          filename: `${baseFilename}.docx`
        });
        flashStatus(`Word note exported: ${res.filename}`);
      }
    } catch (err) {
      console.error('[FocusTube Popup] Export note failed:', err);
      flashStatus("Export failed!");
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    }
  }

  async function exportAllNotes(format = 'docx') {
    const notesMap = state.notes || {};
    const videoIds = Object.keys(notesMap).filter(id => notesMap[id] && notesMap[id].length > 0);

    if (videoIds.length === 0) {
      alert("No notes to export.");
      return;
    }

    if (format === 'md') {
      let md = `# FocusTube Study Notes Compendium\n`;
      md += `*Topic:* ${state.activeTopic || 'General Study'}\n`;
      md += `*Exported on:* ${new Date().toLocaleString()}\n\n---\n\n`;

      videoIds.forEach(vid => {
        md += `## Video: https://www.youtube.com/watch?v=${vid}\n\n`;
        notesMap[vid].forEach(note => {
          const mdContent = htmlToMarkdown(note.text);
          md += `- **[${formatSeconds(note.seconds)}](https://www.youtube.com/watch?v=${vid}&t=${note.seconds}s)**:\n${mdContent}\n\n`;
        });
        md += `\n`;
      });

      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `focustube-all-notes-${Date.now()}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      flashStatus("Notes exported!");
      return;
    }

    flashStatus(`Exporting ${format.toUpperCase()}...`);

    try {
      if (!window.FocusTubeExport) {
        throw new Error("Export engine is initializing. Please try again.");
      }

      const flattenedNotes = [];
      videoIds.forEach(vid => {
        const vidNotes = notesMap[vid] || [];
        vidNotes.forEach(n => {
          flattenedNotes.push({
            ...n,
            text: `<h3>Video: <a href="https://www.youtube.com/watch?v=${vid}">https://www.youtube.com/watch?v=${vid}</a></h3>` + n.text
          });
        });
      });

      const docData = {
        title: `FocusTube Notes Compendium - ${state.activeTopic || 'All Topics'}`,
        topic: state.activeTopic || 'All Topics',
        videoUrl: '',
        date: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
        notes: flattenedNotes
      };

      if (format === 'docx') {
        const res = await window.FocusTubeExport.exportNotesToDocx(docData);
        flashStatus(`Word doc exported: ${res.filename}`);
      }
    } catch (err) {
      console.error('[FocusTube Popup] Export failed:', err);
      flashStatus("Export failed!");
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    }
  }

  btnExportNotesDocx?.addEventListener('click', () => exportAllNotes('docx'));
  btnExportAllNotes?.addEventListener('click', () => exportAllNotes('md'));

  // ==========================================================
  // Distraction Blocker Settings
  // ==========================================================
  const handleSettingChange = async (key, val) => {
    state[key] = val;
    await chrome.storage.local.set({ [key]: val });
    flashStatus("Setting updated");
  };

  checkBlockHome.addEventListener('change', () => handleSettingChange('blockHomeFeed', checkBlockHome.checked));
  checkBlockSidebar.addEventListener('change', () => handleSettingChange('blockSidebarVideos', checkBlockSidebar.checked));
  checkBlockShorts.addEventListener('change', () => handleSettingChange('blockShorts', checkBlockShorts.checked));
  checkBlockComments.addEventListener('change', () => handleSettingChange('blockComments', checkBlockComments.checked));

  btnSaveApiKey.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    state.youtubeApiKey = key;
    await chrome.storage.local.set({ youtubeApiKey: key });
    flashStatus("API Key saved");
  });

  btnSaveTimer.addEventListener('click', async () => {
    const val = parseInt(timerDurationInput.value, 10);
    if (val && val >= 5 && val <= 180) {
      state.timerDurationMinutes = val;
      await chrome.storage.local.set({ timerDurationMinutes: val });
      flashStatus(`Timer set to ${val} mins`);
    } else {
      alert("Please enter a duration between 5 and 180 minutes.");
    }
  });

  // ==========================================================
  // Utilities
  // ==========================================================
  function flashStatus(msg) {
    statusPill.textContent = msg;
    statusPill.style.color = "#38bdf8";
    setTimeout(() => {
      statusPill.textContent = "Ready";
      statusPill.style.color = "#10b981";
    }, 2000);
  }

  function formatSeconds(sec) {
    const s = Math.floor(sec || 0);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function sanitizeRichHtml(html) {
    if (!html) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const allowedTags = new Set([
      'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
      'P', 'DIV', 'BR', 'H1', 'H2', 'H3', 'H4',
      'UL', 'OL', 'LI', 'CODE', 'MARK', 'SPAN', 'BLOCKQUOTE',
      'FIGURE', 'FIGCAPTION', 'IMG', 'A', 'PRE', 'INPUT'
    ]);

    const cleanNode = (node) => {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const tagName = child.tagName;
          if (!allowedTags.has(tagName)) {
            if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'IFRAME') {
              child.remove();
            } else {
              const text = document.createTextNode(child.textContent);
              child.parentNode.replaceChild(text, child);
            }
          } else {
            const attrs = Array.from(child.attributes);
            for (const attr of attrs) {
              const name = attr.name.toLowerCase();
              if (name === 'style') {
                const safeStyle = attr.value
                  .split(';')
                  .filter(s => /^\s*(background|color|font-weight|font-style|text-decoration|max-width|width|height|border|margin|padding|display)/i.test(s))
                  .join(';');
                child.setAttribute('style', safeStyle);
              } else if (name === 'class' && (attr.value.startsWith('focustube-') || attr.value === 'checked')) {
                // keep class
              } else if (tagName === 'IMG' && (name === 'src' || name === 'alt' || name === 'title')) {
                if (name === 'src') {
                  const val = attr.value.trim();
                  if (val.startsWith('data:image/') || val.startsWith('https://') || val.startsWith('http://')) {
                    child.setAttribute('src', val);
                  } else {
                    child.removeAttribute('src');
                  }
                }
              } else if (tagName === 'FIGURE' && name === 'data-timestamp') {
                child.setAttribute('data-timestamp', attr.value);
              } else if (tagName === 'FIGCAPTION' && name === 'contenteditable') {
                child.setAttribute('contenteditable', 'true');
              } else if (tagName === 'A' && (name === 'href' || name === 'title' || name === 'target' || name === 'rel')) {
                if (name === 'href') {
                  const val = attr.value.trim();
                  if (val.startsWith('https://') || val.startsWith('http://') || val.startsWith('#')) {
                    child.setAttribute('href', val);
                    child.setAttribute('target', '_blank');
                    child.setAttribute('rel', 'noopener noreferrer');
                  } else {
                    child.removeAttribute('href');
                  }
                }
              } else if (tagName === 'INPUT' && (name === 'type' || name === 'checked' || name === 'disabled')) {
                if (name === 'type') child.setAttribute('type', 'checkbox');
                if (name === 'checked' && child.checked) child.setAttribute('checked', 'checked');
              } else {
                child.removeAttribute(attr.name);
              }
            }
            cleanNode(child);
          }
        }
      }
    };

    cleanNode(doc.body);
    return doc.body.innerHTML.trim();
  }

  function htmlToMarkdown(html) {
    if (!html) return '';
    let str = html;

    // Screenshots / Figures with captions
    str = str.replace(/<figure[^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<figcaption[^>]*>(.*?)<\/figcaption>[\s\S]*?<\/figure>/gi, '\n![$2]($1)\n*$2*\n\n');
    str = str.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, '\n![$2]($1)\n');
    str = str.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '\n![Screenshot]($1)\n');

    // Task list items safely scoped per li
    str = str.replace(/<li[^>]*class=["'][^"']*focustube-task-item[^"']*["'][^>]*>(.*?)<\/li>/gis, (match, inner) => {
      const isChecked = /<input[^>]*checked/i.test(inner);
      const text = inner.replace(/<input[^>]*>/gi, '').replace(/<span[^>]*class=["']focustube-task-text["'][^>]*>(.*?)<\/span>/gis, '$1').trim();
      return (isChecked ? '- [x] ' : '- [ ] ') + text + '\n';
    });

    // Code blocks
    str = str.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
    str = str.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

    // Blockquotes
    str = str.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, c) => '\n> ' + c.trim().replace(/\n/g, '\n> ') + '\n');

    // Links
    str = str.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');

    str = str.replace(/<br\s*\/?>/gi, '\n');
    str = str.replace(/<\/(div|p)>/gi, '\n');
    str = str.replace(/<(div|p)[^>]*>/gi, '');
    str = str.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n');
    str = str.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n');
    str = str.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n');
    str = str.replace(/<(b|strong)[^>]*>(.*?)<\/(b|strong)>/gi, '**$2**');
    str = str.replace(/<(i|em)[^>]*>(.*?)<\/(i|em)>/gi, '*$2*');
    str = str.replace(/<(s|strike|del)[^>]*>(.*?)<\/(s|strike|del)>/gi, '~~$2~~');
    str = str.replace(/<mark[^>]*>(.*?)<\/mark>/gi, '==$1==');
    str = str.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    str = str.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
    str = str.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
    str = str.replace(/<[^>]+>/g, '');
    const temp = document.createElement('textarea');
    temp.innerHTML = str;
    return temp.value.replace(/\n{3,}/g, '\n\n').trim();
  }

  await loadState();
});
