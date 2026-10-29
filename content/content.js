/**
 * FocusTube - YouTube Responsive Content Script (Desktop, Tablet, m.youtube.com)
 * - Complete removal of YouTube Home Feed components AND left-side menubar (preserves top search bar).
 * - Fresh Re-shuffled list on each full page load (Fisher-Yates shuffle).
 * - Watched videos automatically placed at the bottom with "✓ Watched" badges.
 * - Interactive "🔄 Fresh List" button to re-index with a new video batch.
 * - Focused Video Endscreen: Replaces algorithmic video recommendations with next topic video.
 * - Stable, Smooth Infinite Scroll with DocumentFragment & Set-based deduplication (Zero layout shift).
 */

(function () {
  'use strict';

  let currentSettings = {
    focusModeEnabled: true,
    activeTopic: "Full-Stack Web Development",
    topics: [],
    blockHomeFeed: true,
    blockShorts: true,
    blockSidebarVideos: true,
    blockComments: false,
    timerDurationMinutes: 25,
    videoQueue: [],
    indexedVideos: {},
    watchedVideoIds: [],
    notes: {}
  };

  let activeTab = 'notes';
  let timerInterval = null;
  let timerSecondsLeft = 25 * 60;
  let isTimerRunning = false;
  let lastAnalyzedUrl = '';
  let navDebounceTimer = null;
  let workspaceMountedForVideoId = null;

  // Note-Taking Sidebar Layout State
  let isSidebarCollapsed = false; // Default: split-view (video player on left, notes on right)
  let isNotesPanelOpen = false;   // In full-width / fullscreen mode, controls overlay visibility
  let isNotesPinned = false;      // Floating overlay in full mode

  // Stable Infinite Scroll State (Zero Layout Shift)
  let homeFeedMounted = false;
  const renderedVideoIds = new Set();
  let sessionOrderedVideos = [];
  let dividerRendered = false;
  let activeTagFilter = 'ALL';
  let isFetchingMoreVideos = false;
  let scrollListenerAttached = false;
  let endscreenCountdownTimer = null;

  const BATCH_SIZE = 16;
  const runIdle = window.requestIdleCallback || ((cb) => setTimeout(cb, 100));

  // Initialize
  async function init() {
    try {
      const data = await chrome.storage.local.get(null);
      currentSettings = { ...currentSettings, ...data };
      timerSecondsLeft = (currentSettings.timerDurationMinutes || 25) * 60;

      setupKeyboardShortcutIsolation();
      applyBodyClasses();
      setupNavigationListeners();
      setupSearchEnforcer();

      schedulePageHandling(150);
    } catch (err) {
      console.warn('[FocusTube Init]:', err);
    }
  }

  function applyBodyClasses() {
    const b = document.body;
    if (!b) return;

    const isHome = window.location.pathname === '/';

    if (currentSettings.focusModeEnabled) {
      b.classList.add('focustube-active');
      b.classList.toggle('focustube-home-active', isHome && !!currentSettings.blockHomeFeed);
      b.classList.toggle('focustube-hide-sidebar', !!currentSettings.blockSidebarVideos);
      b.classList.toggle('focustube-hide-shorts', !!currentSettings.blockShorts);
      b.classList.toggle('focustube-hide-comments', !!currentSettings.blockComments);
    } else {
      b.classList.remove(
        'focustube-active',
        'focustube-home-active',
        'focustube-hide-sidebar',
        'focustube-hide-shorts',
        'focustube-hide-comments'
      );
      cleanupHomeFeed();
      cleanupSidebarWorkspace();
      cleanupPlayerEndscreen();
      cleanupSearchTargetIndicator();
    }
  }

  // Storage listener with surgical updates to prevent layout resets
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    for (const [key, change] of Object.entries(changes)) {
      currentSettings[key] = change.newValue;
    }

    applyBodyClasses();
    setupSearchEnforcer();

    if (changes.activeTopic || changes.focusModeEnabled) {
      lastAnalyzedUrl = '';
      homeFeedMounted = false;
      renderedVideoIds.clear();
      sessionOrderedVideos = [];
      dividerRendered = false;
      schedulePageHandling(50);
    } else if (changes.indexedVideos) {
      const activeTopic = currentSettings.activeTopic;
      const topicObj = (currentSettings.topics || []).find(t => t.name === activeTopic);
      const topicId = topicObj?.id || 'default';
      const allIndexed = (currentSettings.indexedVideos && currentSettings.indexedVideos[topicId]) || [];
      updateFeedStats(allIndexed.length);

      if (window.location.pathname === '/' && homeFeedMounted) {
        // Merge newly indexed items into sessionOrderedVideos without wiping current view
        const existingIds = new Set(sessionOrderedVideos.map(v => v.id));
        const newItems = allIndexed.filter(v => !existingIds.has(v.id));
        if (newItems.length > 0) {
          sessionOrderedVideos.push(...shuffleArray(newItems));
          renderNextBatchOfVideos();
        }
      }
    }
  });

  function schedulePageHandling(delay = 150) {
    clearTimeout(navDebounceTimer);
    navDebounceTimer = setTimeout(() => {
      runIdle(() => {
        handlePageChangeAsync();
      });
    }, delay);
  }

  function setupNavigationListeners() {
    window.addEventListener('yt-navigate-finish', () => schedulePageHandling(80));
    window.addEventListener('yt-page-data-updated', () => schedulePageHandling(150));
    window.addEventListener('popstate', () => schedulePageHandling(80));
    
    const handleFullscreenSync = () => {
      syncFullscreenContainers();
      applyLayoutState();
    };
    document.addEventListener('fullscreenchange', handleFullscreenSync);
    document.addEventListener('webkitfullscreenchange', handleFullscreenSync);

    let mutationDebounce = null;
    const observer = new MutationObserver((mutations) => {
      let isLayoutAttrChange = false;
      for (const m of mutations) {
        if (m.type === 'attributes' && (m.attributeName === 'theater' || m.attributeName === 'fullscreen')) {
          isLayoutAttrChange = true;
          break;
        }
      }

      clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(() => {
        runIdle(() => {
          ensurePageState();
          if (isLayoutAttrChange) {
            applyLayoutState();
          }
        });
      }, 300);
    });

    observer.observe(document.body, { 
      childList: true, 
      subtree: true, 
      attributes: true, 
      attributeFilter: ['theater', 'fullscreen'] 
    });
  }

  // ==========================================================
  // Shuffle & Watched Video Helpers
  // ==========================================================
  function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  async function markVideoAsWatched(videoId) {
    if (!videoId) return;
    const currentWatched = new Set(currentSettings.watchedVideoIds || []);
    if (!currentWatched.has(videoId)) {
      currentWatched.add(videoId);
      const list = Array.from(currentWatched);
      currentSettings.watchedVideoIds = list;
      await chrome.storage.local.set({ watchedVideoIds: list });
    }
  }

  // Prepares ordered list: Unwatched shuffled at the top, Watched shuffled at the bottom
  function prepareSessionVideos(allIndexed) {
    const watchedSet = new Set(currentSettings.watchedVideoIds || []);
    let filtered = allIndexed;
    if (activeTagFilter !== 'ALL') {
      const lowerTag = activeTagFilter.toLowerCase();
      filtered = allIndexed.filter(v => v.title.toLowerCase().includes(lowerTag) || (v.description && v.description.toLowerCase().includes(lowerTag)));
    }

    const unwatched = filtered.filter(v => !watchedSet.has(v.id));
    const watched = filtered.filter(v => watchedSet.has(v.id));

    // Fresh shuffle on each new page load!
    return [...shuffleArray(unwatched), ...shuffleArray(watched)];
  }

  // ==========================================================
  // Regex Engine for Topic & Heading Matching
  // ==========================================================
  function buildCompiledTopicRegex() {
    const activeTopic = currentSettings.activeTopic || "Web Development";
    const topicObj = (currentSettings.topics || []).find(t => t.name === activeTopic);
    const tags = topicObj?.tags || [];

    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const terms = [activeTopic, ...tags].filter(Boolean);

    const words = [];
    terms.forEach(t => {
      const lower = t.trim().toLowerCase();
      words.push(lower);
      lower.split(/[\s\-]+/).forEach(w => {
        if (w.length >= 3) words.push(w);
      });
    });

    const uniqueTerms = Array.from(new Set(words));
    const pattern = uniqueTerms.map(w => escapeRegex(w).replace(/\\\./g, '\\.?')).join('|');
    const regex = new RegExp(`(?:^|[\\s.,_\\-/#"'(])(${pattern})(?:$|[\\s.,_\\-/#"')])`, 'i');

    return { regex, terms: uniqueTerms, activeTopic, topicObj };
  }

  // ==========================================================
  // Clean Search Target Indicator & Search Enforcement
  // Placed on the right of the search bar (Desktop & Mobile)
  // Preserves native search box UI, borders, and controls
  // ==========================================================
  let activeToastTimeout = null;
  function showFocusTubeToast(message) {
    let toast = document.getElementById('focustube-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'focustube-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(activeToastTimeout);
    activeToastTimeout = setTimeout(() => {
      toast?.classList.remove('visible');
    }, 2800);
  }

  function cleanupSearchTargetIndicator() {
    document.getElementById('focustube-search-enforce-indicator')?.remove();
    document.getElementById('focustube-search-target-indicator')?.remove();

    const searchInput = document.querySelector('input#search, input.search-input, input[name="search_query"], input[type="search"]');
    if (searchInput && searchInput.getAttribute('placeholder')?.startsWith('🎯')) {
      searchInput.setAttribute('placeholder', 'Search');
    }
  }

  function setupSearchTargetIndicator() {
    // 1. Remove legacy or broken internal form indicators
    document.getElementById('focustube-search-enforce-indicator')?.remove();

    if (!currentSettings.focusModeEnabled) {
      cleanupSearchTargetIndicator();
      return;
    }

    const activeTopic = currentSettings.activeTopic || "Focused Topic";

    // Restore clean placeholder on search input so it stays completely native
    const searchInput = document.querySelector('input#search, input.search-input, input[name="search_query"], input[type="search"]');
    if (searchInput && searchInput.getAttribute('placeholder')?.startsWith('🎯')) {
      searchInput.setAttribute('placeholder', 'Search');
    }

    let indicator = document.getElementById('focustube-search-target-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'focustube-search-target-indicator';
      indicator.addEventListener('click', () => {
        showFocusTubeToast(`🎯 Focus Target: "${activeTopic}" (Searches auto-focus here)`);
      });
    }

    // Update tooltip and content
    indicator.setAttribute('title', `FocusTube Target: "${activeTopic}"\nSearches and recommendations are locked to this topic.`);
    indicator.innerHTML = `
      <span class="focustube-target-icon" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </span>
      <span class="focustube-target-content">
        <span class="focustube-target-label">Target:</span>
        <span class="focustube-target-name">${escapeHtml(activeTopic)}</span>
      </span>
    `;

    // 2. Position cleanly on the RIGHT side of the search bar
    const mastheadCenter = document.querySelector('ytd-masthead #center, #masthead #center, #center');
    const voiceBtn = document.querySelector('#voice-search-button');
    const searchbox = document.querySelector('ytd-searchbox');

    if (mastheadCenter) {
      // On desktop, place right after the voice button or searchbox in #center
      if (voiceBtn && voiceBtn.parentElement === mastheadCenter) {
        if (indicator.previousElementSibling !== voiceBtn) {
          voiceBtn.insertAdjacentElement('afterend', indicator);
        }
      } else if (searchbox && searchbox.parentElement === mastheadCenter) {
        if (indicator.previousElementSibling !== searchbox) {
          searchbox.insertAdjacentElement('afterend', indicator);
        }
      } else if (!mastheadCenter.contains(indicator)) {
        mastheadCenter.appendChild(indicator);
      }
      return;
    }

    // Mobile / Tablet Header fallback (m.youtube.com)
    const mobileHeader = document.querySelector('ytm-header-bar, header.header-bar, ytm-searchbox');
    if (mobileHeader && !mobileHeader.contains(indicator)) {
      indicator.classList.add('focustube-target-mobile');
      mobileHeader.appendChild(indicator);
      return;
    }

    // Search form sibling fallback (Strictly outside form, never inside)
    const searchForm = document.querySelector('form#search-form, form.search-form, #search-form');
    if (searchForm && searchForm.parentElement && !searchForm.parentElement.contains(indicator)) {
      searchForm.insertAdjacentElement('afterend', indicator);
    }
  }

  function setupSearchEnforcer() {
    setupSearchTargetIndicator();

    if (!currentSettings.focusModeEnabled) return;

    const searchForm = document.querySelector('form#search-form, form.search-form, #search-form');
    const activeTopic = currentSettings.activeTopic || "Focused Topic";

    if (searchForm && !searchForm.hasAttribute('data-focustube-bound')) {
      searchForm.setAttribute('data-focustube-bound', 'true');

      searchForm.addEventListener('submit', (e) => {
        if (!currentSettings.focusModeEnabled) return;

        const input = searchForm.querySelector('input#search, input.search-input, input[name="search_query"], input[type="search"]');
        if (!input) return;

        const userQuery = input.value.trim();
        const { regex } = buildCompiledTopicRegex();

        if (!regex.test(userQuery)) {
          e.preventDefault();
          e.stopPropagation();
          input.value = activeTopic;

          const baseDomain = window.location.hostname.includes('m.youtube.com') ? 'https://m.youtube.com' : 'https://www.youtube.com';
          window.location.href = `${baseDomain}/results?search_query=${encodeURIComponent(activeTopic)}`;
        }
      }, true);
    }
  }

  function enforceSearchOnUrl() {
    if (!currentSettings.focusModeEnabled) return;

    const path = window.location.pathname;
    if (path === '/results') {
      const params = new URLSearchParams(window.location.search);
      const query = (params.get('search_query') || '').trim();
      const { regex, activeTopic } = buildCompiledTopicRegex();

      if (query && !regex.test(query)) {
        const baseDomain = window.location.hostname.includes('m.youtube.com') ? 'https://m.youtube.com' : 'https://www.youtube.com';
        window.location.replace(`${baseDomain}/results?search_query=${encodeURIComponent(activeTopic)}`);
      }
    }
  }

  // ==========================================================
  // Native Home Page Replacement (Immediate Clean Removal)
  // Re-shuffled render on full load + Watched placed at bottom
  // ==========================================================
  async function renderNativeHomeFeedAsync() {
    if (!currentSettings.focusModeEnabled || !currentSettings.blockHomeFeed) {
      cleanupHomeFeed();
      return;
    }

    const path = window.location.pathname;
    if (path !== '/') {
      cleanupHomeFeed();
      return;
    }

    document.body.classList.add('focustube-home-active');

    const homeContainer = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer, ytd-browse[page-subtype="home"] #primary, ytm-browse, #app');
    if (!homeContainer) return;

    let feed = document.getElementById('focustube-home-feed');
    if (!feed) {
      feed = document.createElement('div');
      feed.id = 'focustube-home-feed';
      homeContainer.insertBefore(feed, homeContainer.firstChild);
      homeFeedMounted = false;
      renderedVideoIds.clear();
      sessionOrderedVideos = [];
      dividerRendered = false;
    }

    if (!homeFeedMounted) {
      buildNativeHomeFeedShell(feed);
      homeFeedMounted = true;
    }

    setupInfiniteScrollListener();
  }

  function cleanupHomeFeed() {
    document.body.classList.remove('focustube-home-active');
    document.getElementById('focustube-home-feed')?.remove();
    homeFeedMounted = false;
    renderedVideoIds.clear();
    sessionOrderedVideos = [];
    dividerRendered = false;
  }

  function buildNativeHomeFeedShell(feed) {
    const activeTopic = currentSettings.activeTopic || "Web Development";
    const topicObj = (currentSettings.topics || []).find(t => t.name === activeTopic);
    const tags = topicObj?.tags || [];
    const topicId = topicObj?.id || 'default';
    const allIndexed = (currentSettings.indexedVideos && currentSettings.indexedVideos[topicId]) || [];

    // Order videos with fresh shuffle: Unwatched at top, Watched at bottom!
    sessionOrderedVideos = prepareSessionVideos(allIndexed);
    renderedVideoIds.clear();
    dividerRendered = false;

    const watchedSet = new Set(currentSettings.watchedVideoIds || []);
    const unwatchedCount = allIndexed.filter(v => !watchedSet.has(v.id)).length;

    feed.innerHTML = `
      <div class="focustube-feed-header">
        <div class="focustube-header-top">
          <div class="focustube-header-title">
            <span class="focustube-header-badge">TOPIC FEED</span>
            <span>${escapeHtml(activeTopic)}</span>
          </div>
          <div class="focustube-header-actions">
            <button class="focustube-btn-refresh" id="focustube-btn-fresh-list" title="Re-index and fetch a fresh batch of videos">
              🔄 Fresh List
            </button>
            <div class="focustube-header-stats" id="focustube-feed-stats">
              ${allIndexed.length} Videos (${unwatchedCount} Unwatched)
            </div>
          </div>
        </div>

        <div class="focustube-filter-chips">
          <button class="focustube-filter-chip ${activeTagFilter === 'ALL' ? 'active' : ''}" data-filter="ALL">
            All Focused Videos
          </button>
          ${tags.map(tag => `
            <button class="focustube-filter-chip ${activeTagFilter === tag ? 'active' : ''}" data-filter="${escapeHtml(tag)}">
              #${escapeHtml(tag)}
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Native-Styled YouTube Video Grid -->
      <div id="focustube-native-grid"></div>

      <!-- Infinite Scroll Loading Indicator -->
      <div class="focustube-infinite-loader" id="focustube-infinite-loader" style="display: none;">
        <div class="focustube-spinner"></div>
        <span>Searching and indexing more videos on "${escapeHtml(activeTopic)}"...</span>
      </div>
    `;

    // Filter chips click
    feed.querySelectorAll('.focustube-filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        activeTagFilter = chip.getAttribute('data-filter');
        feed.querySelectorAll('.focustube-filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');

        renderedVideoIds.clear();
        dividerRendered = false;
        sessionOrderedVideos = prepareSessionVideos(allIndexed);

        const grid = document.getElementById('focustube-native-grid');
        if (grid) grid.innerHTML = '';
        renderNextBatchOfVideos();
      });
    });

    // Fresh List Button Click Handler
    const freshBtn = feed.querySelector('#focustube-btn-fresh-list');
    if (freshBtn && topicObj) {
      freshBtn.addEventListener('click', () => {
        freshBtn.textContent = '🔄 Fetching Fresh...';
        showInfiniteLoader(true);

        chrome.runtime.sendMessage({ type: "INDEX_FRESH_VIDEOS", topic: topicObj }, (res) => {
          showInfiniteLoader(false);
          freshBtn.textContent = '🔄 Fresh List';
          if (res && res.videos) {
            renderedVideoIds.clear();
            dividerRendered = false;
            sessionOrderedVideos = prepareSessionVideos(res.videos);

            const grid = document.getElementById('focustube-native-grid');
            if (grid) grid.innerHTML = '';
            renderNextBatchOfVideos();
          }
        });
      });
    }

    if (allIndexed.length < 20 && topicObj) {
      showInfiniteLoader(true);
      chrome.runtime.sendMessage({ type: "INDEX_TOPIC_VIDEOS", topic: topicObj }, (res) => {
        showInfiniteLoader(false);
        if (res && res.videos) {
          sessionOrderedVideos = prepareSessionVideos(res.videos);
          renderNextBatchOfVideos();
        }
      });
    } else {
      renderNextBatchOfVideos();
    }
  }

  // Render a slice of indexed videos smoothly into the native grid using DocumentFragment
  function renderNextBatchOfVideos() {
    const grid = document.getElementById('focustube-native-grid');
    if (!grid) return;

    const activeTopic = currentSettings.activeTopic || "Web Development";
    const topicObj = (currentSettings.topics || []).find(t => t.name === activeTopic);
    const watchedSet = new Set(currentSettings.watchedVideoIds || []);

    if (sessionOrderedVideos.length === 0) {
      if (grid.children.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 40px 0; color: #888;">
            Indexing topic videos... Please wait a moment.
          </div>
        `;
      }
      return;
    }

    const unrenderedVideos = sessionOrderedVideos.filter(v => !renderedVideoIds.has(v.id));
    if (unrenderedVideos.length === 0) {
      if (sessionOrderedVideos.length > 0 && !isFetchingMoreVideos && topicObj) {
        triggerBackgroundVideoExpansion(topicObj);
      }
      return;
    }

    const nextBatch = unrenderedVideos.slice(0, BATCH_SIZE);
    const fragment = document.createDocumentFragment();

    nextBatch.forEach(v => {
      const isWatched = watchedSet.has(v.id);

      // Insert transition divider when reaching watched section
      if (isWatched && !dividerRendered) {
        dividerRendered = true;
        const divider = document.createElement('div');
        divider.className = 'focustube-feed-divider';
        divider.innerHTML = `<span>📺 Previously Watched / Completed</span>`;
        fragment.appendChild(divider);
      }

      renderedVideoIds.add(v.id);

      const card = document.createElement('a');
      card.className = `focustube-native-card ${isWatched ? 'focustube-card-watched' : ''}`;
      card.href = getWatchUrl(v.id);
      card.setAttribute('data-video-id', v.id);

      const channelInitial = (v.channelTitle || 'Y').charAt(0).toUpperCase();

      card.innerHTML = `
        <div class="focustube-native-thumb-wrap">
          <img class="focustube-native-thumb" src="${v.thumbnail}" alt="thumb" loading="lazy" />
          ${isWatched ? `<span class="focustube-watched-badge">✓ Watched</span>` : ''}
          ${v.duration ? `<span class="focustube-native-duration">${escapeHtml(v.duration)}</span>` : ''}
          <button class="focustube-native-queue-btn" data-queue-id="${v.id}" title="Add to Queue">
            + Queue
          </button>
        </div>
        <div class="focustube-native-card-details">
          <div class="focustube-native-avatar">
            ${v.channelThumbnail ? `<img src="${v.channelThumbnail}" alt="avatar" />` : channelInitial}
          </div>
          <div class="focustube-native-info">
            <h3 class="focustube-native-title" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</h3>
            <div class="focustube-native-channel">${escapeHtml(v.channelTitle)}</div>
            <div class="focustube-native-meta-row">${v.views ? `${escapeHtml(v.views)} • ` : ''}${isWatched ? 'Watched' : '🎯 Topic Match'}</div>
          </div>
        </div>
      `;

      card.querySelector('.focustube-native-queue-btn')?.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await addVideoObjectToQueue(v);
        const btn = card.querySelector('.focustube-native-queue-btn');
        if (btn) {
          btn.textContent = '✓ Queued';
          btn.style.background = '#10b981';
          btn.style.opacity = '1';
        }
      });

      fragment.appendChild(card);
    });

    grid.appendChild(fragment);
    updateFeedStats(sessionOrderedVideos.length);

    if (sessionOrderedVideos.length - renderedVideoIds.size < 16 && !isFetchingMoreVideos && topicObj) {
      triggerBackgroundVideoExpansion(topicObj);
    }
  }

  // Setup infinite scroll listener (Passive, debounced, zero jumps)
  function setupInfiniteScrollListener() {
    if (scrollListenerAttached) return;
    scrollListenerAttached = true;

    let scrollDebounce = null;
    window.addEventListener('scroll', () => {
      if (window.location.pathname !== '/' || !currentSettings.focusModeEnabled) return;

      clearTimeout(scrollDebounce);
      scrollDebounce = setTimeout(() => {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 850) {
          renderNextBatchOfVideos();
        }
      }, 100);
    }, { passive: true });
  }

  function triggerBackgroundVideoExpansion(topicObj) {
    isFetchingMoreVideos = true;
    showInfiniteLoader(true);

    chrome.runtime.sendMessage({ type: "INDEX_MORE_VIDEOS", topic: topicObj }, (res) => {
      isFetchingMoreVideos = false;
      showInfiniteLoader(false);
      if (res && res.videos) {
        const existingIds = new Set(sessionOrderedVideos.map(v => v.id));
        const newItems = res.videos.filter(v => !existingIds.has(v.id));
        if (newItems.length > 0) {
          sessionOrderedVideos.push(...shuffleArray(newItems));
          renderNextBatchOfVideos();
        }
      }
    });
  }

  function showInfiniteLoader(show) {
    const loader = document.getElementById('focustube-infinite-loader');
    if (loader) loader.style.display = show ? 'flex' : 'none';
  }

  function updateFeedStats(total) {
    const stats = document.getElementById('focustube-feed-stats');
    if (!stats) return;
    const watchedSet = new Set(currentSettings.watchedVideoIds || []);
    const unwatchedCount = sessionOrderedVideos.filter(v => !watchedSet.has(v.id)).length;
    stats.textContent = `${total} Videos (${unwatchedCount} Unwatched)`;
  }

  // ==========================================================
  // Video Ending Protection & Focused Next-Video Endscreen
  // Tracks watched videos automatically
  // ==========================================================
  function setupVideoPlayerEndingProtection() {
    const video = getVideoElement();
    if (!video || video.hasAttribute('data-focustube-endscreen-bound')) return;

    video.setAttribute('data-focustube-endscreen-bound', 'true');

    // Mark as watched after user watches for 12 seconds
    let watchProgressTimer = null;
    video.addEventListener('timeupdate', () => {
      const currentVid = getCurrentVideoId();
      if (video.currentTime >= 12 && currentVid) {
        markVideoAsWatched(currentVid);
      }
      if (video.duration > 0 && video.currentTime >= video.duration - 0.5 && !video.paused) {
        onVideoEnded();
      }
    });

    video.addEventListener('ended', onVideoEnded);
  }

  function onVideoEnded() {
    if (!currentSettings.focusModeEnabled || window.location.pathname !== '/watch') return;

    const currentVid = getCurrentVideoId();
    if (currentVid) {
      markVideoAsWatched(currentVid);
    }

    const activeTopic = currentSettings.activeTopic || "Web Development";
    const topicObj = (currentSettings.topics || []).find(t => t.name === activeTopic);
    const topicId = topicObj?.id || 'default';

    let nextVideo = null;
    const queue = currentSettings.videoQueue || [];
    const queueIdx = queue.findIndex(v => v.id === currentVid);

    if (queueIdx !== -1 && queueIdx + 1 < queue.length) {
      nextVideo = queue[queueIdx + 1];
    } else if (queue.length > 0 && queue[0].id !== currentVid) {
      nextVideo = queue[0];
    } else {
      const indexed = (currentSettings.indexedVideos && currentSettings.indexedVideos[topicId]) || [];
      const watchedSet = new Set(currentSettings.watchedVideoIds || []);
      // Prefer an unwatched next video first!
      nextVideo = indexed.find(v => v.id !== currentVid && !watchedSet.has(v.id)) || indexed.find(v => v.id !== currentVid) || indexed[0];
    }

    showPlayerEndscreen(nextVideo, activeTopic);
  }

  function showPlayerEndscreen(nextVideo, activeTopic) {
    cleanupPlayerEndscreen();

    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    if (!player) return;

    const endscreen = document.createElement('div');
    endscreen.id = 'focustube-player-endscreen';

    let countdown = 6;

    if (nextVideo) {
      endscreen.innerHTML = `
        <div class="focustube-endscreen-card">
          <div style="font-size: 11px; font-weight: 700; color: #f87171; text-transform: uppercase; letter-spacing: 0.05em;">
            🎯 TOPIC FOCUS: NEXT UP
          </div>
          <img class="focustube-endscreen-thumb" src="${nextVideo.thumbnail}" alt="next thumb" />
          <div class="focustube-endscreen-title">${escapeHtml(nextVideo.title)}</div>
          <div class="focustube-endscreen-channel">${escapeHtml(nextVideo.channelTitle || '')}</div>

          <div class="focustube-endscreen-actions">
            <button class="focustube-btn-primary" id="focustube-play-next-btn">
              ▶ Play Next (<span id="focustube-cd-pill">${countdown}</span>s)
            </button>
            <button class="focustube-btn-secondary" id="focustube-replay-btn">
              ↺ Replay
            </button>
          </div>
        </div>
      `;

      clearInterval(endscreenCountdownTimer);
      endscreenCountdownTimer = setInterval(() => {
        countdown--;
        const pill = endscreen.querySelector('#focustube-cd-pill');
        if (pill) pill.textContent = countdown;
        if (countdown <= 0) {
          clearInterval(endscreenCountdownTimer);
          window.location.href = getWatchUrl(nextVideo.id);
        }
      }, 1000);

      endscreen.querySelector('#focustube-play-next-btn')?.addEventListener('click', () => {
        clearInterval(endscreenCountdownTimer);
        window.location.href = getWatchUrl(nextVideo.id);
      });
    } else {
      endscreen.innerHTML = `
        <div class="focustube-endscreen-card">
          <div style="font-size: 13px; font-weight: 700; color: #38bdf8;">
            🎉 Focus Session Complete!
          </div>
          <p style="font-size: 13px; color: #94a3b8; margin: 4px 0 10px 0;">
            You completed this video on "${escapeHtml(activeTopic)}".
          </p>
          <div class="focustube-endscreen-actions">
            <button class="focustube-btn-secondary" id="focustube-replay-btn">
              ↺ Replay
            </button>
            <a href="${getSearchUrl(activeTopic)}" class="focustube-btn-primary">
              🔍 Explore More
            </a>
          </div>
        </div>
      `;
    }

    endscreen.querySelector('#focustube-replay-btn')?.addEventListener('click', () => {
      clearInterval(endscreenCountdownTimer);
      cleanupPlayerEndscreen();
      const video = getVideoElement();
      if (video) {
        video.currentTime = 0;
        video.play().catch(() => {});
      }
    });

    player.appendChild(endscreen);
  }

  function cleanupPlayerEndscreen() {
    clearInterval(endscreenCountdownTimer);
    document.getElementById('focustube-player-endscreen')?.remove();
  }

  // ==========================================================
  // YouTube Keyboard Shortcut Conflict Prevention
  // ==========================================================
  function isNoteTakingElement(el) {
    if (!el || !(el instanceof Element)) return false;
    // Check if element is inside FocusTube note-taking workspace, floating expand button, or note components
    const inFocusTube = el.closest?.('#focustube-sidebar-workspace, .focustube-floating-expand-btn, #focustube-player-endscreen');
    if (inFocusTube) return true;
    if (el.closest?.('.focustube-rich-editor, .focustube-note-edit-container') || el.classList?.contains('focustube-rich-editor')) {
      return true;
    }
    return false;
  }

  function handleKeyboardIsolation(e) {
    const target = e.target;
    if (!isNoteTakingElement(target)) return;

    // Prevent propagation to YouTube player and global handlers so keystrokes (space, arrows, letters) do not trigger playback or seeking
    e.stopPropagation();

    // Do NOT call e.preventDefault() here so normal typing, spaces, cursor navigation,
    // selection, undo/redo, copy/paste, backspace, and delete work natively in the text field.
  }

  function setupKeyboardShortcutIsolation() {
    ['keydown', 'keyup', 'keypress'].forEach(type => {
      document.addEventListener(type, handleKeyboardIsolation, false);
    });
  }

  // ==========================================================
  // Note-Taking Sidebar Layout & Pinning Controls
  // ==========================================================
  function attachFloatingButtonToPlayer(btn) {
    if (!btn) return;
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player') || document.querySelector('#player-container');
    if (player && btn.parentElement !== player) {
      player.appendChild(btn);
    } else if (!player && !btn.parentElement) {
      document.body.appendChild(btn);
    }
  }

  function syncFullscreenContainers() {
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.querySelector('.html5-video-player.ytp-fullscreen'));
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    const ws = document.getElementById('focustube-sidebar-workspace');
    const expandBtn = document.getElementById('focustube-expand-toggle-btn');

    if (player && expandBtn && expandBtn.parentElement !== player) {
      player.appendChild(expandBtn);
    }

    if (isFullscreen && player && ws && ws.parentElement !== player) {
      player.appendChild(ws);
    } else if (!isFullscreen && ws && player && ws.parentElement === player) {
      const containerInfo = getWorkspaceContainer();
      if (containerInfo?.el) {
        containerInfo.el.insertBefore(ws, containerInfo.el.firstChild);
      }
    }
  }

  function toggleNotesPanel() {
    isNotesPanelOpen = !isNotesPanelOpen;
    applyLayoutState();
    if (isNotesPanelOpen) {
      showFocusTubeToast("📝 Notes panel opened");
      const editor = document.querySelector('#focustube-note-text');
      if (editor) editor.focus();
    } else {
      showFocusTubeToast("Notes panel hidden");
    }
  }

  function getOrCreateExpandButton() {
    let btn = document.getElementById('focustube-expand-toggle-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'focustube-expand-toggle-btn';
      btn.className = 'focustube-floating-expand-btn visible';
      btn.setAttribute('type', 'button');
      btn.setAttribute('title', isNotesPanelOpen ? 'Hide notes panel' : 'Show notes panel');
      btn.setAttribute('aria-label', isNotesPanelOpen ? 'Hide notes panel' : 'Show notes panel');
      btn.innerHTML = `
        <svg class="focustube-expand-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
        <span class="focustube-expand-text">${isNotesPanelOpen ? 'Hide Notes' : 'Show Notes'}</span>
      `;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleNotesPanel();
      });
      btn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });
      btn.addEventListener('keydown', handleKeyboardIsolation);
      btn.addEventListener('keyup', handleKeyboardIsolation);
      btn.addEventListener('keypress', handleKeyboardIsolation);
    }

    attachFloatingButtonToPlayer(btn);
    return btn;
  }

  function cleanupExpandButton() {
    document.getElementById('focustube-expand-toggle-btn')?.remove();
  }

  function isVideoInFullMode() {
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.querySelector('.html5-video-player.ytp-fullscreen'));
    const isTheater = !!document.querySelector('ytd-watch-flexy[theater]');
    return isSidebarCollapsed || isFullscreen || isTheater;
  }

  function updateWorkspaceHeaderControls(ws, isFullMode) {
    if (!ws) return;
    const splitBtn = ws.querySelector('#focustube-split-toggle-btn');
    const collapseBtn = ws.querySelector('#focustube-collapse-sidebar-btn');
    const collapseLabel = ws.querySelector('#focustube-collapse-label');
    const pinnedIndicator = ws.querySelector('#focustube-pinned-indicator');
    const icon = collapseBtn?.querySelector('.focustube-control-icon');

    if (isFullMode) {
      if (splitBtn) splitBtn.style.display = 'inline-flex';
      if (collapseBtn) {
        collapseBtn.setAttribute('title', 'Hide notes panel');
        collapseBtn.setAttribute('aria-label', 'Hide notes');
        if (icon) {
          icon.innerHTML = `<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>`;
        }
      }
      if (collapseLabel) collapseLabel.textContent = 'Hide';
      if (pinnedIndicator) pinnedIndicator.style.display = 'flex';
    } else {
      if (splitBtn) splitBtn.style.display = 'none';
      if (collapseBtn) {
        collapseBtn.setAttribute('title', 'Full-width video (Collapse sidebar)');
        collapseBtn.setAttribute('aria-label', 'Full-width video');
        if (icon) {
          icon.innerHTML = `
            <polyline points="15 3 21 3 21 9"></polyline>
            <polyline points="9 21 3 21 3 15"></polyline>
            <line x1="21" y1="3" x2="14" y2="10"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
          `;
        }
      }
      if (collapseLabel) collapseLabel.textContent = 'Full Width';
      if (pinnedIndicator) pinnedIndicator.style.display = 'none';
    }
  }

  function applyLayoutState() {
    const ws = document.getElementById('focustube-sidebar-workspace');
    const expandBtn = getOrCreateExpandButton();
    const isFullMode = isVideoInFullMode();

    document.body.classList.toggle('focustube-sidebar-collapsed', isSidebarCollapsed);
    document.body.classList.toggle('focustube-full-video-mode', isFullMode);
    document.body.classList.toggle('focustube-notes-panel-open', isNotesPanelOpen);
    document.body.classList.toggle('focustube-notes-pinned', isFullMode && isNotesPanelOpen);

    // Floating Expand/Collapse Button: ONLY visible when video is in Full Width or Full Screen mode!
    if (expandBtn) {
      if (isFullMode) {
        expandBtn.classList.add('visible');
        expandBtn.classList.toggle('active', isNotesPanelOpen);
        expandBtn.setAttribute('title', isNotesPanelOpen ? 'Hide notes panel' : 'Show notes panel');
        expandBtn.setAttribute('aria-label', isNotesPanelOpen ? 'Hide notes panel' : 'Show notes panel');
        expandBtn.setAttribute('aria-expanded', isNotesPanelOpen ? 'true' : 'false');

        const icon = expandBtn.querySelector('.focustube-expand-icon');
        const text = expandBtn.querySelector('.focustube-expand-text');
        if (icon && text) {
          if (isNotesPanelOpen) {
            icon.innerHTML = `<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>`;
            text.textContent = 'Hide Notes';
          } else {
            icon.innerHTML = `<path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>`;
            text.textContent = 'Show Notes';
          }
        }
      } else {
        // In default Split-View, the floating button is hidden!
        expandBtn.classList.remove('visible');
        expandBtn.classList.remove('active');
      }
    }

    if (ws) {
      if (isFullMode) {
        // In full-width or full screen mode, panel overlay is toggled via isNotesPanelOpen
        ws.style.display = isNotesPanelOpen ? 'flex' : 'none';
        ws.classList.add('focustube-pinned');
      } else {
        // In default split-view: visible on the right side of the video
        ws.style.display = 'flex';
        ws.classList.remove('focustube-pinned');
      }

      updateWorkspaceHeaderControls(ws, isFullMode);
    }

    syncFullscreenContainers();
  }

  // ==========================================================
  // Sidebar & Mobile Workspace Setup (Watch Page)
  // ==========================================================
  function getCurrentVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  }

  function getWorkspaceContainer() {
    const desktopSec = document.querySelector('#secondary-inner') || document.querySelector('#secondary');
    if (desktopSec) return { el: desktopSec, isMobileLayout: false };

    const mobileSec = document.querySelector('ytm-item-section-renderer.watch-below-the-player, .related-items-container, ytm-watch-flexy, #app');
    if (mobileSec) return { el: mobileSec, isMobileLayout: true };

    return null;
  }

  // ==========================================================
  // Rich Text Editor & Live Video Sync Helpers
  // ==========================================================
  let capturedTimestampSeconds = null;
  let videoTimeTrackerSetup = false;

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

  function getClosestElement(node, tagName, stopAt) {
    if (!node) return null;
    let cur = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const tag = tagName.toUpperCase();
    while (cur && cur !== stopAt) {
      if (cur.tagName === tag) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function getBlockContainer(node, stopAt) {
    if (!node) return null;
    let cur = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const blockTags = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'FIGURE']);
    while (cur && cur !== stopAt) {
      if (blockTags.has(cur.tagName)) return cur;
      cur = cur.parentElement;
    }
    return cur || stopAt;
  }

  function setCursorInElement(el, atStart = false) {
    if (!el) return;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(atStart);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      // ignore
    }
  }

  function executeEditorCommand(command, value = null, editorElement = null) {
    if (editorElement) {
      editorElement.focus();
      if (editorElement._savedRange) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !editorElement.contains(sel.getRangeAt(0).commonAncestorContainer)) {
          sel.removeAllRanges();
          sel.addRange(editorElement._savedRange);
        }
      }
    }

    if (command === 'highlight') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const mark = getClosestElement(range.commonAncestorContainer, 'mark', editorElement);
        if (mark) {
          const parent = mark.parentNode;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          mark.remove();
        } else {
          const markEl = document.createElement('mark');
          markEl.className = 'focustube-mark';
          markEl.appendChild(range.extractContents());
          range.insertNode(markEl);
        }
      } else {
        document.execCommand('backColor', false, 'rgba(234, 179, 8, 0.35)');
      }
      return;
    }

    if (command === 'code') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const codeEl = getClosestElement(range.commonAncestorContainer, 'code', editorElement);
        if (codeEl && codeEl.tagName === 'CODE' && codeEl.parentElement?.tagName !== 'PRE') {
          const parent = codeEl.parentNode;
          while (codeEl.firstChild) parent.insertBefore(codeEl.firstChild, codeEl);
          codeEl.remove();
        } else {
          const node = document.createElement('code');
          node.className = 'focustube-code-snippet';
          node.appendChild(range.extractContents());
          range.insertNode(node);
        }
      } else {
        document.execCommand('fontName', false, 'monospace');
      }
      return;
    }

    if (command === 'codeBlock') {
      const sel = window.getSelection();
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const trailingP = document.createElement('p');
      trailingP.innerHTML = '<br>';
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        code.appendChild(range.extractContents());
        pre.appendChild(code);
        range.insertNode(trailingP);
        range.insertNode(pre);
      } else {
        code.innerHTML = '<br>';
        pre.appendChild(code);
        const block = (sel && sel.rangeCount > 0) ? getBlockContainer(sel.getRangeAt(0).commonAncestorContainer, editorElement) : null;
        if (block && block !== editorElement) {
          block.parentNode.insertBefore(pre, block.nextSibling);
          block.parentNode.insertBefore(trailingP, pre.nextSibling);
        } else if (editorElement) {
          editorElement.appendChild(pre);
          editorElement.appendChild(trailingP);
        }
      }
      setCursorInElement(code);
      return;
    }

    if (command === 'blockquote') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const block = getBlockContainer(sel.getRangeAt(0).commonAncestorContainer, editorElement);
        if (block && block.tagName === 'BLOCKQUOTE') {
          document.execCommand('formatBlock', false, '<p>');
          return;
        }
      }
      document.execCommand('formatBlock', false, '<blockquote>');
      return;
    }

    if (command === 'taskList') {
      createTaskListAtCursor(editorElement);
      return;
    }

    if (command === 'createLink') {
      const sel = window.getSelection();
      const existingA = (sel && sel.rangeCount > 0) ? getClosestElement(sel.getRangeAt(0).commonAncestorContainer, 'a', editorElement) : null;
      const initialUrl = existingA ? existingA.getAttribute('href') : 'https://';
      const url = prompt('Enter link URL (e.g. https://developer.mozilla.org):', initialUrl);
      if (url !== null) {
        if (url.trim() && url.trim() !== 'https://') {
          document.execCommand('createLink', false, url.trim());
        } else if (existingA) {
          document.execCommand('unlink');
        }
      }
      return;
    }

    if (command === 'exportDocx') {
      exportNotes('docx');
      return;
    }

    if (command === 'formatBlock') {
      if (value === 'pre') {
        executeEditorCommand('codeBlock', null, editorElement);
        return;
      }
      document.execCommand('formatBlock', false, `<${value}>`);
      return;
    }

    document.execCommand(command, false, value);
  }

  function createTaskListAtCursor(editor, isChecked = false) {
    if (!editor) return;
    editor.focus();
    const ul = document.createElement('ul');
    ul.className = 'focustube-task-list';
    const li = document.createElement('li');
    li.className = 'focustube-task-item' + (isChecked ? ' checked' : '');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'focustube-task-checkbox';
    if (isChecked) input.checked = true;
    const span = document.createElement('span');
    span.className = 'focustube-task-text';
    span.innerHTML = '<br>';

    li.appendChild(input);
    li.appendChild(span);
    ul.appendChild(li);

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const block = getBlockContainer(range.commonAncestorContainer, editor);
      if (block && block !== editor) {
        if (block.textContent.trim() === '') {
          block.parentNode.replaceChild(ul, block);
        } else {
          block.parentNode.insertBefore(ul, block.nextSibling);
        }
      } else {
        range.deleteContents();
        range.insertNode(ul);
      }
    } else {
      editor.appendChild(ul);
    }
    setCursorInElement(span);
  }

  function insertScreenshotIntoEditor(editor, dataUrl, currentSec, formattedTime) {
    if (!editor) return;
    editor.focus();

    let range = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (editor.contains(r.commonAncestorContainer)) {
        range = r;
      }
    }
    if (!range && editor._savedRange && editor.contains(editor._savedRange.commonAncestorContainer)) {
      range = editor._savedRange;
    }

    const figure = document.createElement('figure');
    figure.className = 'focustube-screenshot-figure';
    figure.setAttribute('data-timestamp', currentSec);

    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = `Screenshot at ${formattedTime}`;
    img.className = 'focustube-screenshot-img';

    const figcaption = document.createElement('figcaption');
    figcaption.className = 'focustube-screenshot-caption';
    figcaption.contentEditable = 'true';
    figcaption.textContent = `Screenshot — ${formattedTime}`;

    figure.appendChild(img);
    figure.appendChild(figcaption);

    const trailingP = document.createElement('p');
    trailingP.innerHTML = '<br>';

    if (!range || (editor.textContent.trim() === '' && !editor.querySelector('img, figure'))) {
      editor.innerHTML = '';
      editor.appendChild(figure);
      editor.appendChild(trailingP);
    } else {
      let container = range.commonAncestorContainer;
      if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;

      const block = container.closest('li, pre, blockquote, h1, h2, h3, p, div') || container;
      if (block && block !== editor) {
        if (block.tagName === 'LI') {
          const parentList = block.closest('ul, ol') || block;
          parentList.parentNode.insertBefore(figure, parentList.nextSibling);
          parentList.parentNode.insertBefore(trailingP, figure.nextSibling);
        } else if (block.tagName === 'PRE') {
          block.parentNode.insertBefore(figure, block.nextSibling);
          block.parentNode.insertBefore(trailingP, figure.nextSibling);
        } else {
          block.parentNode.insertBefore(figure, block.nextSibling);
          block.parentNode.insertBefore(trailingP, figure.nextSibling);
        }
      } else {
        range.deleteContents();
        range.insertNode(trailingP);
        range.insertNode(figure);
      }
    }

    setCursorInElement(trailingP);
    if (window.getSelection()?.rangeCount > 0) {
      editor._savedRange = window.getSelection().getRangeAt(0).cloneRange();
    }
  }

  let isCapturingFrame = false;

  async function captureVideoFrame(targetEditor) {
    if (isCapturingFrame) return;
    isCapturingFrame = true;

    try {
      const video = getVideoElement();
      if (!video) {
        showFocusTubeToast("⚠️ No active video player found on page.");
        return;
      }
      if (video.readyState < 2) {
        showFocusTubeToast("⚠️ Video is buffering, please wait a moment.");
        return;
      }

      const currentSec = Math.floor(video.currentTime || 0);
      const formattedTime = formatSeconds(currentSec);

      const naturalWidth = video.videoWidth || 1280;
      const naturalHeight = video.videoHeight || 720;
      const maxWidth = 1280;
      let targetWidth = naturalWidth;
      let targetHeight = naturalHeight;
      if (targetWidth > maxWidth) {
        targetHeight = Math.round((maxWidth / targetWidth) * targetHeight);
        targetWidth = maxWidth;
      }

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        showFocusTubeToast("⚠️ Unable to initialize canvas context.");
        return;
      }

      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

      let dataUrl;
      try {
        dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      } catch (secErr) {
        console.warn('[FocusTube] Frame capture blocked by CORS/DRM:', secErr);
        showFocusTubeToast("⚠️ Frame capture unavailable for this video (cross-origin / protected DRM).");
        return;
      }

      const editor = targetEditor || document.querySelector('#focustube-note-text');
      if (!editor) {
        showFocusTubeToast("⚠️ Note editor not available.");
        return;
      }

      insertScreenshotIntoEditor(editor, dataUrl, currentSec, formattedTime);
      showFocusTubeToast(`📸 Captured frame at ${formattedTime}`);
    } catch (err) {
      console.error('[FocusTube] Screenshot capture error:', err);
      showFocusTubeToast("⚠️ Failed to capture video frame.");
    } finally {
      setTimeout(() => {
        isCapturingFrame = false;
      }, 400);
    }
  }

  function getEditorToolbarHTML(idPrefix = '', isInline = false) {
    const selectId = idPrefix ? `${idPrefix}-font-size-select` : 'focustube-font-size-select';
    return `
      <div class="focustube-toolbar-group">
        <select class="focustube-toolbar-select" id="${selectId}" title="Text Style & Headings" aria-label="Text Style">
          <option value="p">Normal</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="blockquote">Quote</option>
          <option value="pre">Code Block</option>
        </select>
      </div>

      <div class="focustube-toolbar-divider"></div>

      <div class="focustube-toolbar-group">
        <button type="button" class="focustube-tool-btn" data-cmd="bold" title="Bold (Ctrl+B)" aria-label="Bold">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="italic" title="Italic (Ctrl+I)" aria-label="Italic">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"></line><line x1="14" y1="20" x2="5" y2="20"></line><line x1="15" y1="4" x2="9" y2="20"></line></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="underline" title="Underline (Ctrl+U)" aria-label="Underline">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 12 0V3"></path><line x1="4" y1="21" x2="20" y2="21"></line></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="strikeThrough" title="Strikethrough" aria-label="Strikethrough">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"></path><path d="M14 12a4 4 0 0 1 0 8H6"></path><line x1="4" y1="12" x2="20" y2="12"></line></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="highlight" title="Highlight Key Idea" aria-label="Highlight Key Idea">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h3l6-6"></path><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"></path></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="code" title="Inline Code" aria-label="Inline Code">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
        </button>
      </div>

      <div class="focustube-toolbar-divider"></div>

      <div class="focustube-toolbar-group">
        <button type="button" class="focustube-tool-btn" data-cmd="insertUnorderedList" title="Bullet List (- or *)" aria-label="Bullet List">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="insertOrderedList" title="Numbered List (1. 2. 3.)" aria-label="Numbered List">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="taskList" title="Task List ([ ])" aria-label="Task List">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="outdent" title="Outdent (Shift+Tab)" aria-label="Outdent">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 8 3 12 7 16"></polyline><line x1="21" y1="12" x2="11" y2="12"></line><line x1="21" y1="6" x2="11" y2="6"></line><line x1="21" y1="18" x2="11" y2="18"></line></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="indent" title="Indent (Tab)" aria-label="Indent">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 7 12 3 16"></polyline><line x1="21" y1="12" x2="11" y2="12"></line><line x1="21" y1="6" x2="11" y2="6"></line><line x1="21" y1="18" x2="11" y2="18"></line></svg>
        </button>
      </div>

      <div class="focustube-toolbar-divider"></div>

      <div class="focustube-toolbar-group">
        <button type="button" class="focustube-tool-btn" data-cmd="blockquote" title="Quote Block" aria-label="Quote Block">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="codeBlock" title="Code Block" aria-label="Code Block">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="createLink" title="Insert Link" aria-label="Insert Link">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
        </button>
      </div>

      <div class="focustube-toolbar-divider"></div>

      <div class="focustube-toolbar-group">
        <button type="button" class="focustube-tool-btn" data-cmd="undo" title="Undo (Ctrl+Z)" aria-label="Undo">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"></path></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="redo" title="Redo (Ctrl+Y)" aria-label="Redo">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"></path><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"></path></svg>
        </button>
        <button type="button" class="focustube-tool-btn" data-cmd="removeFormat" title="Clear Formatting" aria-label="Clear Formatting">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"></path><path d="M22 21H7"></path><path d="m5 11 9 9"></path></svg>
        </button>
      </div>

      ${!isInline ? `
      <div class="focustube-toolbar-divider"></div>

      <div class="focustube-toolbar-group">
        <button type="button" class="focustube-tool-btn" data-cmd="exportDocx" title="Export as Word (.docx)" aria-label="Export as Word">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
        </button>
      </div>
      ` : ''}
    `;
  }

  function bindToolbarEvents(toolbar, editor) {
    if (!toolbar || !editor) return;

    toolbar.querySelectorAll('[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cmd = btn.getAttribute('data-cmd');
        executeEditorCommand(cmd, null, editor);
        updateToolbarActiveStates(toolbar, editor);
      });
    });

    const select = toolbar.querySelector('.focustube-toolbar-select');
    if (select) {
      select.addEventListener('change', () => {
        executeEditorCommand('formatBlock', select.value, editor);
        updateToolbarActiveStates(toolbar, editor);
      });
    }
  }

  function updateToolbarActiveStates(toolbar, editor) {
    if (!toolbar || !editor) return;
    try {
      const isBold = document.queryCommandState('bold');
      const isItalic = document.queryCommandState('italic');
      const isUnderline = document.queryCommandState('underline');
      const isStrike = document.queryCommandState('strikeThrough');
      const isUL = document.queryCommandState('insertUnorderedList');
      const isOL = document.queryCommandState('insertOrderedList');

      const setBtn = (cmd, active) => {
        const b = toolbar.querySelector(`[data-cmd="${cmd}"]`);
        if (b) b.classList.toggle('active', !!active);
      };

      setBtn('bold', isBold);
      setBtn('italic', isItalic);
      setBtn('underline', isUnderline);
      setBtn('strikeThrough', isStrike);
      setBtn('insertUnorderedList', isUL);
      setBtn('insertOrderedList', isOL);

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const node = sel.anchorNode;
        const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        if (el && editor.contains(el)) {
          setBtn('highlight', !!el.closest('mark'));
          setBtn('code', !!el.closest('code:not(pre code)'));
          setBtn('taskList', !!el.closest('.focustube-task-list'));
          setBtn('blockquote', !!el.closest('blockquote'));
          setBtn('codeBlock', !!el.closest('pre'));

          const select = toolbar.querySelector('.focustube-toolbar-select');
          if (select) {
            if (el.closest('h1')) select.value = 'h1';
            else if (el.closest('h2')) select.value = 'h2';
            else if (el.closest('h3')) select.value = 'h3';
            else if (el.closest('blockquote')) select.value = 'blockquote';
            else if (el.closest('pre')) select.value = 'pre';
            else select.value = 'p';
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  function setupSmartListAndEditorEngine(editor, toolbar) {
    if (!editor || editor._focustubeEngineAttached) return;
    editor._focustubeEngineAttached = true;

    const recordSelection = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (editor.contains(r.commonAncestorContainer)) {
          editor._savedRange = r.cloneRange();
        }
      }
      if (toolbar) updateToolbarActiveStates(toolbar, editor);
    };

    editor.addEventListener('mouseup', recordSelection);
    editor.addEventListener('keyup', recordSelection);
    editor.addEventListener('focus', recordSelection);
    editor.addEventListener('input', recordSelection);

    // Interactive task checkbox clicks
    editor.addEventListener('click', (e) => {
      if (e.target && e.target.classList.contains('focustube-task-checkbox')) {
        const li = e.target.closest('.focustube-task-item');
        if (li) {
          li.classList.toggle('checked', e.target.checked);
          if (e.target.checked) {
            e.target.setAttribute('checked', 'checked');
          } else {
            e.target.removeAttribute('checked');
          }
        }
      }
    });

    editor.addEventListener('keydown', (e) => {
      handleKeyboardIsolation(e);

      // 1. Smart List Auto-Creation on Space
      if (e.key === ' ' || e.key === 'Spacebar') {
        const sel = window.getSelection();
        if (sel && sel.isCollapsed && sel.rangeCount > 0) {
          const anchor = sel.anchorNode;
          const offset = sel.anchorOffset;
          const block = getBlockContainer(anchor, editor);
          if (block) {
            if (block.tagName === 'LI') {
              const r = document.createRange();
              r.setStart(block, 0);
              r.setEnd(anchor, offset);
              const prefix = r.toString().trim();
              if (prefix === '[ ]' || prefix === '[]' || prefix === '[x]' || prefix === '[X]') {
                e.preventDefault();
                r.deleteContents();
                block.className = 'focustube-task-item' + (prefix.toLowerCase().includes('x') ? ' checked' : '');
                let input = block.querySelector('.focustube-task-checkbox');
                if (!input) {
                  input = document.createElement('input');
                  input.type = 'checkbox';
                  input.className = 'focustube-task-checkbox';
                  if (prefix.toLowerCase().includes('x')) input.checked = true;
                  block.insertBefore(input, block.firstChild);
                }
                let textSpan = block.querySelector('.focustube-task-text');
                if (!textSpan) {
                  textSpan = document.createElement('span');
                  textSpan.className = 'focustube-task-text';
                  while (block.childNodes.length > 1) {
                    textSpan.appendChild(block.childNodes[1]);
                  }
                  if (!textSpan.hasChildNodes()) textSpan.innerHTML = '<br>';
                  block.appendChild(textSpan);
                }
                setCursorInElement(textSpan);
                return;
              }
            } else {
              const r = document.createRange();
              r.setStart(block, 0);
              r.setEnd(anchor, offset);
              const textBefore = r.toString();
              const match = textBefore.match(/^(\s*)(?:(\d+)\.|([-*+])|\[([ xX]?)\])$/);
              if (match) {
                e.preventDefault();
                r.deleteContents();
                if (match[2]) {
                  const startNum = parseInt(match[2], 10);
                  document.execCommand('insertOrderedList');
                  const curLi = getClosestElement(window.getSelection().anchorNode, 'li', editor);
                  if (curLi) {
                    const ol = curLi.closest('ol');
                    if (ol && startNum > 1) ol.setAttribute('start', startNum);
                  }
                } else if (match[3]) {
                  document.execCommand('insertUnorderedList');
                } else if (match[4] !== undefined) {
                  createTaskListAtCursor(editor, match[4].toLowerCase() === 'x');
                }
                return;
              }
            }
          }
        }
      }

      // 2. Intelligent Enter Behavior in Lists
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const anchor = sel.anchorNode;
          const curLi = getClosestElement(anchor, 'li', editor);
          if (curLi) {
            const parentList = curLi.closest('ol, ul');
            if (parentList) {
              const curText = curLi.textContent.replace(/[\u200B\u00A0\s]/g, '');
              const hasMedia = !!curLi.querySelector('img, figure');
              const isCurEmpty = (curText === '' && !hasMedia);

              if (isCurEmpty) {
                const allItems = Array.from(parentList.querySelectorAll('li'));
                const hasMeaningfulContent = allItems.some(i => i.querySelector('img, figure') || i.textContent.replace(/[\u200B\u00A0\s]/g, '').length > 0);

                if (!hasMeaningfulContent) {
                  // Case 1: 3-step confirmation sequence for initially empty list
                  e.preventDefault();
                  if (allItems.length < 3) {
                    const newLi = document.createElement('li');
                    if (curLi.classList.contains('focustube-task-item')) {
                      newLi.className = 'focustube-task-item';
                      newLi.innerHTML = '<input type="checkbox" class="focustube-task-checkbox"><span class="focustube-task-text"><br></span>';
                    } else {
                      newLi.innerHTML = '<br>';
                    }
                    curLi.parentNode.insertBefore(newLi, curLi.nextSibling);
                    setCursorInElement(newLi.querySelector('.focustube-task-text') || newLi);
                  } else {
                    // Third consecutive Enter on empty 3rd item: clear empty list structure, return cursor to paragraph
                    const p = document.createElement('p');
                    p.innerHTML = '<br>';
                    parentList.parentNode.replaceChild(p, parentList);
                    setCursorInElement(p);
                  }
                  return;
                } else {
                  // Case 2 & 3: List already contains meaningful text: NEVER clear entire list!
                  e.preventDefault();
                  const p = document.createElement('p');
                  p.innerHTML = '<br>';

                  if (curLi === parentList.lastElementChild) {
                    curLi.remove();
                    parentList.parentNode.insertBefore(p, parentList.nextSibling);
                  } else if (curLi === parentList.firstElementChild) {
                    curLi.remove();
                    parentList.parentNode.insertBefore(p, parentList);
                  } else {
                    const nextLis = [];
                    let sib = curLi.nextElementSibling;
                    while (sib) {
                      nextLis.push(sib);
                      sib = sib.nextElementSibling;
                    }
                    curLi.remove();
                    parentList.parentNode.insertBefore(p, parentList.nextSibling);
                    if (nextLis.length > 0) {
                      const secondList = parentList.cloneNode(false);
                      nextLis.forEach(l => secondList.appendChild(l));
                      if (secondList.tagName === 'OL') {
                        const prevCount = parentList.querySelectorAll('li').length;
                        const baseStart = parseInt(parentList.getAttribute('start') || '1', 10);
                        secondList.setAttribute('start', baseStart + prevCount);
                      }
                      p.parentNode.insertBefore(secondList, p.nextSibling);
                    }
                  }
                  setCursorInElement(p);
                  return;
                }
              } else {
                // Non-empty list item: if task item, continue with next task item
                if (curLi.classList.contains('focustube-task-item')) {
                  e.preventDefault();
                  const newLi = document.createElement('li');
                  newLi.className = 'focustube-task-item';
                  newLi.innerHTML = '<input type="checkbox" class="focustube-task-checkbox"><span class="focustube-task-text"><br></span>';
                  curLi.parentNode.insertBefore(newLi, curLi.nextSibling);
                  setCursorInElement(newLi.querySelector('.focustube-task-text') || newLi);
                  return;
                }
              }
            }
          }
        }
      }

      // 3. Indent & Outdent via Tab and Shift+Tab
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          document.execCommand('outdent');
        } else {
          document.execCommand('indent');
        }
        return;
      }

      // 4. Keyboard formatting shortcuts
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'b') {
          e.preventDefault();
          executeEditorCommand('bold', null, editor);
        } else if (k === 'i') {
          e.preventDefault();
          executeEditorCommand('italic', null, editor);
        } else if (k === 'u') {
          e.preventDefault();
          executeEditorCommand('underline', null, editor);
        } else if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            executeEditorCommand('redo', null, editor);
          } else {
            executeEditorCommand('undo', null, editor);
          }
        } else if (k === 'y') {
          e.preventDefault();
          executeEditorCommand('redo', null, editor);
        }
      }
    });
  }

  function setupVideoPlaybackTimeTracker() {
    const video = getVideoElement();
    if (!video) return;

    const updateLiveTimeUI = () => {
      const livePill = document.getElementById('focustube-live-time-pill');
      const pulseDot = document.getElementById('focustube-live-indicator');
      const grabBtn = document.getElementById('focustube-grab-ts-btn');
      const resetBtn = document.getElementById('focustube-reset-ts-btn');
      const hint = document.getElementById('focustube-ts-hint');
      const grabLabel = grabBtn?.querySelector('.focustube-grab-btn-label');

      if (!livePill) return;

      const currentSec = Math.floor(video.currentTime || 0);

      if (capturedTimestampSeconds === null) {
        livePill.textContent = formatSeconds(currentSec);
        if (pulseDot) {
          pulseDot.classList.toggle('playing', !video.paused);
        }
        if (grabBtn) {
          grabBtn.classList.remove('captured');
        }
        if (grabLabel) {
          grabLabel.textContent = '📍 Grab Timestamp:';
        }
        if (resetBtn) {
          resetBtn.style.display = 'none';
        }
        if (hint) {
          hint.textContent = video.paused ? 'Playback paused' : 'Live synced with player';
        }
      } else {
        livePill.textContent = formatSeconds(capturedTimestampSeconds);
        if (pulseDot) {
          pulseDot.classList.remove('playing');
        }
        if (grabBtn) {
          grabBtn.classList.add('captured');
        }
        if (grabLabel) {
          grabLabel.textContent = '📌 Locked at:';
        }
        if (resetBtn) {
          resetBtn.style.display = 'inline-flex';
        }
        if (hint) {
          hint.textContent = 'Timestamp locked for this note';
        }
      }
    };

    if (!videoTimeTrackerSetup) {
      videoTimeTrackerSetup = true;
      video.addEventListener('timeupdate', updateLiveTimeUI);
      video.addEventListener('play', updateLiveTimeUI);
      video.addEventListener('pause', updateLiveTimeUI);
      video.addEventListener('seeked', updateLiveTimeUI);
    }

    updateLiveTimeUI();
  }

  function injectSidebarWorkspace() {
    if (!currentSettings.focusModeEnabled) {
      cleanupSidebarWorkspace();
      return;
    }

    const containerInfo = getWorkspaceContainer();
    if (!containerInfo || !containerInfo.el) return;

    document.body.classList.add('focustube-watch-active');

    let ws = document.getElementById('focustube-sidebar-workspace');
    const currentVideoId = getCurrentVideoId();

    if (!ws) {
      ws = document.createElement('div');
      ws.id = 'focustube-sidebar-workspace';
      containerInfo.el.insertBefore(ws, containerInfo.el.firstChild);
      buildWorkspaceDOM(ws);
      workspaceMountedForVideoId = currentVideoId;
    } else if (workspaceMountedForVideoId !== currentVideoId) {
      workspaceMountedForVideoId = currentVideoId;
      updateWorkspaceContent(ws);
    }

    applyLayoutState();
    setupVideoPlayerEndingProtection();
  }

  function cleanupSidebarWorkspace() {
    document.getElementById('focustube-sidebar-workspace')?.remove();
    cleanupExpandButton();
    document.body.classList.remove('focustube-sidebar-collapsed', 'focustube-full-video-mode', 'focustube-notes-panel-open', 'focustube-notes-pinned', 'focustube-watch-active');
    workspaceMountedForVideoId = null;
    isSidebarCollapsed = false;
    isNotesPanelOpen = false;
    isNotesPinned = false;
  }

  function buildWorkspaceDOM(ws) {
    const activeTopic = currentSettings.activeTopic || "Web Development";

    ws.innerHTML = `
      <div class="focustube-ws-header">
        <div class="focustube-ws-header-left">
          <div class="focustube-ws-brand">
            <span class="focustube-brand-badge">FOCUS</span>
            <span>FocusTube</span>
          </div>
          <div class="focustube-ws-topic-tag" id="focustube-active-topic-pill" title="${escapeHtml(activeTopic)}">
            🎯 ${escapeHtml(activeTopic)}
          </div>
        </div>

        <div class="focustube-ws-header-controls">
          <button 
            type="button" 
            class="focustube-ws-control-btn" 
            id="focustube-split-toggle-btn" 
            title="Restore side-by-side split view" 
            aria-label="Split view"
            style="display: none;"
          >
            <svg class="focustube-control-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="14" y1="3" x2="14" y2="21"></line>
            </svg>
            <span class="focustube-control-label">Split View</span>
          </button>

          <button 
            type="button" 
            class="focustube-ws-control-btn" 
            id="focustube-collapse-sidebar-btn" 
            title="Full-width video (Collapse sidebar)" 
            aria-label="Toggle full-width layout"
          >
            <svg class="focustube-control-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 3 21 3 21 9"></polyline>
              <polyline points="9 21 3 21 3 15"></polyline>
              <line x1="21" y1="3" x2="14" y2="10"></line>
              <line x1="3" y1="21" x2="10" y2="14"></line>
            </svg>
            <span class="focustube-control-label" id="focustube-collapse-label">Full Width</span>
          </button>
        </div>
      </div>

      <div class="focustube-pinned-indicator" id="focustube-pinned-indicator" style="${isNotesPinned ? 'display: flex;' : 'display: none;'}">
        <span>📌 Pinned over video &bull; Playback active</span>
      </div>

      <nav class="focustube-tabs-nav">
        <button class="focustube-tab-btn ${activeTab === 'notes' ? 'active' : ''}" data-tab="notes">
          📝 Notes
        </button>
        <button class="focustube-tab-btn ${activeTab === 'suggestions' ? 'active' : ''}" data-tab="suggestions">
          💡 Suggestions
        </button>
        <button class="focustube-tab-btn ${activeTab === 'queue' ? 'active' : ''}" data-tab="queue">
          📚 Queue
        </button>
        <button class="focustube-tab-btn ${activeTab === 'timer' ? 'active' : ''}" data-tab="timer">
          ⏱️ Timer
        </button>
        <button class="focustube-tab-btn ${activeTab === 'tags' ? 'active' : ''}" data-tab="tags">
          🏷️ Tags
        </button>
      </nav>

      <!-- Panel: Notes -->
      <div class="focustube-tab-panel ${activeTab === 'notes' ? 'active' : ''}" id="focustube-panel-notes">
        <div class="focustube-notes-controls">
          <div class="focustube-ts-sync-bar">
            <button class="focustube-btn-grab-timestamp" id="focustube-grab-ts-btn" title="Click to snapshot current video playback time" aria-label="Snapshot playback timestamp">
              <span class="focustube-live-pulse-dot" id="focustube-live-indicator"></span>
              <span class="focustube-grab-btn-label">📍 Grab Timestamp:</span>
              <span class="focustube-live-time-val" id="focustube-live-time-pill">0:00</span>
            </button>
            <button class="focustube-btn-capture-frame" id="focustube-capture-frame-btn" title="Capture video frame (current playback)" aria-label="Capture video frame">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path>
                <circle cx="12" cy="13" r="3"></circle>
              </svg>
              <span>Capture Frame</span>
            </button>
            <button class="focustube-btn-reset-ts" id="focustube-reset-ts-btn" title="Resume real-time video tracking" aria-label="Resume real-time tracking" style="display: none;">
              ↺ Sync Live
            </button>
          </div>
          <div class="focustube-ts-hint" id="focustube-ts-hint">Live synced with player</div>
        </div>

        <!-- Rich Text Formatting Toolbar -->
        <div class="focustube-rich-toolbar" id="focustube-note-toolbar">
          ${getEditorToolbarHTML('focustube-main')}
        </div>

        <!-- Rich Text Editor Body -->
        <div 
          class="focustube-rich-editor" 
          id="focustube-note-text" 
          contenteditable="true" 
          placeholder="Capture key insights, formulas, takeaway notes... (Ctrl+Enter to save)"
          role="textbox"
          aria-multiline="true"
        ></div>

        <div class="focustube-notes-actions">
          <button class="focustube-btn-primary" id="focustube-save-note-btn" title="Save current note (Ctrl+Enter)">
            💾 Save Note
          </button>
          
          <div class="focustube-export-dropdown-wrapper">
            <button class="focustube-btn-secondary focustube-export-menu-btn" id="focustube-export-menu-btn" title="Export all notes for this video" aria-haspopup="true" aria-expanded="false">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span id="focustube-export-btn-label">Export All ▾</span>
            </button>
            <div class="focustube-export-menu-dropdown" id="focustube-export-dropdown-menu" role="menu">
              <button class="focustube-export-menu-item" id="focustube-export-docx-action" role="menuitem" title="Download all notes for this video as Word (.docx)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="12" y1="18" x2="12" y2="12"></line>
                  <line x1="9" y1="15" x2="15" y2="15"></line>
                </svg>
                <span>All Notes as Word (.docx)</span>
              </button>
              <div class="focustube-export-menu-divider"></div>
              <button class="focustube-export-menu-item" id="focustube-export-md-action" role="menuitem" title="Download all notes for this video as Markdown (.md)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span>All Notes as Markdown (.md)</span>
              </button>
            </div>
          </div>
        </div>

        <div class="focustube-notes-list" id="focustube-notes-list"></div>
      </div>

      <!-- Panel: Suggestions -->
      <div class="focustube-tab-panel ${activeTab === 'suggestions' ? 'active' : ''}" id="focustube-panel-suggestions">
        <div style="font-size: 11.5px; color: #94a3b8;">
          Indexed Videos for "${escapeHtml(activeTopic)}":
        </div>
        <div class="focustube-suggestions-list" id="focustube-suggestions-container"></div>
      </div>

      <!-- Panel: Queue -->
      <div class="focustube-tab-panel ${activeTab === 'queue' ? 'active' : ''}" id="focustube-panel-queue">
        <button class="focustube-btn-primary" id="focustube-add-current-video-btn" style="width: 100%;">
          + Queue Current Video
        </button>
        <div class="focustube-queue-list" id="focustube-queue-items-container"></div>
      </div>

      <!-- Panel: Timer -->
      <div class="focustube-tab-panel ${activeTab === 'timer' ? 'active' : ''}" id="focustube-panel-timer">
        <div class="focustube-timer-box">
          <div class="focustube-timer-display" id="focustube-timer-text">
            ${formatTimer(timerSecondsLeft)}
          </div>
          <div class="focustube-timer-controls">
            <button class="focustube-btn-primary" id="focustube-timer-toggle-btn">
              ${isTimerRunning ? '⏸ Pause' : '▶ Start Focus'}
            </button>
            <button class="focustube-btn-secondary" id="focustube-timer-reset-btn">
              ↺ Reset
            </button>
          </div>
        </div>
      </div>

      <!-- Panel: Tags -->
      <div class="focustube-tab-panel ${activeTab === 'tags' ? 'active' : ''}" id="focustube-panel-tags">
        <div style="font-size: 11.5px; color: #94a3b8; margin-bottom: 6px;">
          Active Topic Tags:
        </div>
        <div class="focustube-tags-cloud" id="focustube-tags-cloud-container"></div>
      </div>
    `;

    bindWorkspaceEvents(ws);
    updateWorkspaceContent(ws);
  }

  function updateWorkspaceContent(ws) {
    if (!ws) return;
    const videoId = getCurrentVideoId();
    const activeTopic = currentSettings.activeTopic || "Web Development";
    const topicObj = (currentSettings.topics || []).find(t => t.name === activeTopic);
    const tags = topicObj?.tags || [];
    const topicId = topicObj?.id || 'default';

    const pill = ws.querySelector('#focustube-active-topic-pill');
    if (pill) pill.textContent = `🎯 ${activeTopic}`;

    // Notes List
    const notesList = ws.querySelector('#focustube-notes-list');
    const videoNotes = (currentSettings.notes && currentSettings.notes[videoId]) || [];
    if (notesList) {
      if (videoNotes.length === 0) {
        notesList.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 16px 0; font-size: 12px;">No notes for this video yet.</div>`;
      } else {
        notesList.innerHTML = videoNotes.map(n => `
          <div class="focustube-note-card" data-note-id="${n.id}">
            <div class="focustube-note-header">
              <span class="focustube-timestamp-pill" data-seconds="${n.seconds}" title="Click to seek player">▶ ${formatSeconds(n.seconds)}</span>
              <div class="focustube-note-actions-btns">
                <button class="focustube-note-export-btn" data-export-nid="${n.id}" data-export-fmt="docx" title="Export this note as Word (.docx)" aria-label="Export this note as Word (.docx)">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                  <span>DOCX</span>
                </button>
                <button class="focustube-note-export-btn" data-export-nid="${n.id}" data-export-fmt="md" title="Export this note as Markdown (.md)" aria-label="Export this note as Markdown (.md)">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                  <span>MD</span>
                </button>
                <button class="focustube-note-edit-btn" data-edit-id="${n.id}" title="Edit note">✎</button>
                <button class="focustube-note-del-btn" data-del-id="${n.id}" title="Delete note">×</button>
              </div>
            </div>
            <div class="focustube-note-body">
              <div class="focustube-note-text" data-text-id="${n.id}" title="Double-click to edit">${sanitizeRichHtml(n.text)}</div>
              <div class="focustube-note-edit-container" data-edit-box-id="${n.id}" style="display: none;">
                <div class="focustube-rich-toolbar focustube-inline-toolbar" data-inline-tb-id="${n.id}">
                  ${getEditorToolbarHTML('focustube-inline-' + n.id, true)}
                </div>
                <div class="focustube-rich-editor focustube-inline-rich-editor" data-editor-id="${n.id}" contenteditable="true" role="textbox" aria-multiline="true">${sanitizeRichHtml(n.text)}</div>
                <div class="focustube-note-edit-actions">
                  <button class="focustube-btn-update-time" data-update-time-id="${n.id}" title="Update timestamp to current video position">⏱ Sync to current time</button>
                  <button class="focustube-btn-capture-inline-frame" data-inline-capture-id="${n.id}" title="Capture video frame at current timestamp" aria-label="Capture video frame">📸 Frame</button>
                  <div style="flex: 1;"></div>
                  <button class="focustube-btn-cancel-note" data-cancel-id="${n.id}">Cancel</button>
                  <button class="focustube-btn-save-note" data-save-id="${n.id}">Save</button>
                </div>
              </div>
            </div>
          </div>
        `).join('');

        // Seek video on timestamp click
        notesList.querySelectorAll('.focustube-timestamp-pill').forEach(p => {
          p.addEventListener('click', () => seekVideo(parseFloat(p.getAttribute('data-seconds'))));
        });

        // Seek video on screenshot figure click
        notesList.querySelectorAll('.focustube-screenshot-figure').forEach(fig => {
          fig.addEventListener('click', (e) => {
            if (fig.closest('.focustube-note-edit-container')) return;
            const ts = fig.getAttribute('data-timestamp');
            if (ts !== null && ts !== undefined && ts !== '') {
              seekVideo(parseFloat(ts));
            }
          });
        });

        // Interactive task checkboxes in note view
        notesList.querySelectorAll('.focustube-note-text .focustube-task-checkbox').forEach(cb => {
          cb.addEventListener('click', async (e) => {
            e.stopPropagation();
            const card = cb.closest('.focustube-note-card');
            const noteId = card?.getAttribute('data-note-id');
            const textEl = card?.querySelector('.focustube-note-text');
            if (!noteId || !textEl) return;
            const li = cb.closest('.focustube-task-item');
            if (li) {
              li.classList.toggle('checked', cb.checked);
              if (cb.checked) {
                cb.setAttribute('checked', 'checked');
              } else {
                cb.removeAttribute('checked');
              }
            }
            await updateNote(videoId, noteId, textEl.innerHTML.trim());
          });
        });

        // Bind inline toolbars and editor engines
        notesList.querySelectorAll('.focustube-inline-toolbar').forEach(tb => {
          const nid = tb.getAttribute('data-inline-tb-id');
          const ed = notesList.querySelector(`.focustube-inline-rich-editor[data-editor-id="${nid}"]`);
          if (ed) {
            setupSmartListAndEditorEngine(ed, tb);
            bindToolbarEvents(tb, ed);
          }
        });

        // Bind inline capture frame buttons
        notesList.querySelectorAll('.focustube-btn-capture-inline-frame').forEach(btn => {
          const nid = btn.getAttribute('data-inline-capture-id');
          const ed = notesList.querySelector(`.focustube-inline-rich-editor[data-editor-id="${nid}"]`);
          if (ed) {
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              captureVideoFrame(ed);
            });
          }
        });

        // Open Note Editor helper
        const openEditor = (noteId) => {
          const card = notesList.querySelector(`.focustube-note-card[data-note-id="${noteId}"]`);
          if (!card) return;
          const textEl = card.querySelector(`.focustube-note-text[data-text-id="${noteId}"]`);
          const editBox = card.querySelector(`.focustube-note-edit-container[data-edit-box-id="${noteId}"]`);
          const editor = card.querySelector(`.focustube-inline-rich-editor[data-editor-id="${noteId}"]`);
          const editBtn = card.querySelector(`.focustube-note-edit-btn[data-edit-id="${noteId}"]`);

          if (textEl && editBox && editor) {
            textEl.style.display = 'none';
            editBox.style.display = 'flex';
            if (editBtn) editBtn.style.display = 'none';
            editor.focus();
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        };

        // Close Note Editor helper
        const closeEditor = (noteId) => {
          const card = notesList.querySelector(`.focustube-note-card[data-note-id="${noteId}"]`);
          if (!card) return;
          const textEl = card.querySelector(`.focustube-note-text[data-text-id="${noteId}"]`);
          const editBox = card.querySelector(`.focustube-note-edit-container[data-edit-box-id="${noteId}"]`);
          const editor = card.querySelector(`.focustube-inline-rich-editor[data-editor-id="${noteId}"]`);
          const editBtn = card.querySelector(`.focustube-note-edit-btn[data-edit-id="${noteId}"]`);
          const syncBtn = card.querySelector(`.focustube-btn-update-time[data-update-time-id="${noteId}"]`);
          const origNote = videoNotes.find(n => n.id === noteId);

          if (editor && origNote) {
            editor.innerHTML = sanitizeRichHtml(origNote.text);
          }
          if (syncBtn) {
            syncBtn.removeAttribute('data-custom-seconds');
            syncBtn.textContent = '⏱ Sync to current time';
            syncBtn.classList.remove('active');
          }
          if (textEl && editBox) {
            textEl.style.display = 'block';
            editBox.style.display = 'none';
            if (editBtn) editBtn.style.display = 'inline-block';
          }
        };

        // Individual note export buttons (Mode: Specific note)
        notesList.querySelectorAll('.focustube-note-export-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const nid = btn.getAttribute('data-export-nid');
            const fmt = btn.getAttribute('data-export-fmt');
            if (nid && fmt) {
              exportNotes(fmt, nid, btn);
            }
          });
        });

        // Edit button click
        notesList.querySelectorAll('[data-edit-id]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditor(btn.getAttribute('data-edit-id'));
          });
        });

        // Double click on text to edit
        notesList.querySelectorAll('[data-text-id]').forEach(el => {
          el.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            openEditor(el.getAttribute('data-text-id'));
          });
        });

        // Cancel button click
        notesList.querySelectorAll('[data-cancel-id]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeEditor(btn.getAttribute('data-cancel-id'));
          });
        });

        // Sync timestamp button click
        notesList.querySelectorAll('[data-update-time-id]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const curTime = getVideoCurrentTime();
            btn.setAttribute('data-custom-seconds', curTime);
            btn.textContent = `✓ At ${formatSeconds(curTime)}`;
            btn.classList.add('active');
          });
        });

        // Save button click
        notesList.querySelectorAll('[data-save-id]').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const noteId = btn.getAttribute('data-save-id');
            const card = notesList.querySelector(`.focustube-note-card[data-note-id="${noteId}"]`);
            if (!card) return;
            const editor = card.querySelector(`.focustube-inline-rich-editor[data-editor-id="${noteId}"]`);
            const syncBtn = card.querySelector(`.focustube-btn-update-time[data-update-time-id="${noteId}"]`);
            const customSeconds = syncBtn?.getAttribute('data-custom-seconds');
            const newSeconds = customSeconds !== null && customSeconds !== undefined ? parseFloat(customSeconds) : null;
            const newHtml = editor ? editor.innerHTML.trim() : '';

            if (newHtml && (editor.textContent.trim() || newHtml.includes('<img'))) {
              await updateNote(videoId, noteId, newHtml, newSeconds);
            }
          });
        });

        // Keyboard navigation inside inline editor (Ctrl+Enter to save, Esc to cancel)
        notesList.querySelectorAll('.focustube-inline-rich-editor').forEach(ed => {
          ed.addEventListener('keydown', async (e) => {
            handleKeyboardIsolation(e);
            const noteId = ed.getAttribute('data-editor-id');
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              const card = ed.closest('.focustube-note-card');
              const saveBtn = card?.querySelector(`[data-save-id="${noteId}"]`);
              saveBtn?.click();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeEditor(noteId);
            }
          });
          ed.addEventListener('keyup', handleKeyboardIsolation);
          ed.addEventListener('keypress', handleKeyboardIsolation);
        });

        // Delete button click
        notesList.querySelectorAll('[data-del-id]').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await deleteNote(videoId, btn.getAttribute('data-del-id'));
          });
        });
      }
    }

    setupVideoPlaybackTimeTracker();

    // Suggestions List (Prefer unwatched)
    const suggestionsContainer = ws.querySelector('#focustube-suggestions-container');
    const indexed = (currentSettings.indexedVideos && currentSettings.indexedVideos[topicId]) || [];
    const watchedSet = new Set(currentSettings.watchedVideoIds || []);

    if (suggestionsContainer) {
      if (indexed.length === 0) {
        suggestionsContainer.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 16px 0; font-size: 12px;">No indexed suggestions yet.</div>`;
      } else {
        // Unwatched first, watched after
        const unwatchedSuggestions = indexed.filter(v => !watchedSet.has(v.id));
        const watchedSuggestions = indexed.filter(v => watchedSet.has(v.id));
        const displaySuggestions = [...unwatchedSuggestions, ...watchedSuggestions].slice(0, 15);

        suggestionsContainer.innerHTML = displaySuggestions.map(v => `
          <div class="focustube-queue-item ${v.id === videoId ? 'active-video' : ''}" data-id="${v.id}">
            <img class="focustube-queue-thumb" src="${v.thumbnail}" alt="thumb" />
            <div style="flex: 1; min-width: 0;">
              <div class="focustube-queue-title">${escapeHtml(v.title)}</div>
              <div class="focustube-queue-channel">${escapeHtml(v.channelTitle)}</div>
            </div>
            ${watchedSet.has(v.id) ? `<span style="font-size: 10px; color: #10b981; font-weight: bold; margin-left: 4px;">✓</span>` : ''}
          </div>
        `).join('');

        suggestionsContainer.querySelectorAll('.focustube-queue-item').forEach(item => {
          item.addEventListener('click', () => {
            const vid = item.getAttribute('data-id');
            if (vid && vid !== videoId) window.location.href = getWatchUrl(vid);
          });
        });
      }
    }

    // Queue List
    const queueContainer = ws.querySelector('#focustube-queue-items-container');
    const queue = currentSettings.videoQueue || [];
    if (queueContainer) {
      if (queue.length === 0) {
        queueContainer.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 16px 0; font-size: 12px;">Queue is empty.</div>`;
      } else {
        queueContainer.innerHTML = queue.map(v => `
          <div class="focustube-queue-item ${v.id === videoId ? 'active-video' : ''}" data-id="${v.id}">
            <img class="focustube-queue-thumb" src="${v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`}" alt="thumb" />
            <div style="flex: 1; min-width: 0;">
              <div class="focustube-queue-title">${escapeHtml(v.title || 'Video')}</div>
              <div class="focustube-queue-channel">${escapeHtml(v.channelTitle || '')}</div>
            </div>
            <button class="focustube-note-del-btn" data-remove-id="${v.id}">×</button>
          </div>
        `).join('');

        queueContainer.querySelectorAll('.focustube-queue-item').forEach(item => {
          item.addEventListener('click', (e) => {
            if (e.target.closest('[data-remove-id]')) return;
            const targetId = item.getAttribute('data-id');
            if (targetId && targetId !== videoId) window.location.href = getWatchUrl(targetId);
          });
        });

        queueContainer.querySelectorAll('[data-remove-id]').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await removeVideoFromQueue(btn.getAttribute('data-remove-id'));
          });
        });
      }
    }

    // Tags Cloud
    const tagsCloud = ws.querySelector('#focustube-tags-cloud-container');
    if (tagsCloud) {
      tagsCloud.innerHTML = tags.map(tag => `
        <div class="focustube-tag-chip" data-tag="${escapeHtml(tag)}">
          🔍 #${escapeHtml(tag)}
        </div>
      `).join('');

      tagsCloud.querySelectorAll('.focustube-tag-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const t = chip.getAttribute('data-tag');
          if (t) window.location.href = getSearchUrl(t);
        });
      });
    }
  }

  function bindWorkspaceEvents(ws) {
    // Isolate all keyboard events originating from anywhere inside the workspace
    ws.addEventListener('keydown', handleKeyboardIsolation);
    ws.addEventListener('keyup', handleKeyboardIsolation);
    ws.addEventListener('keypress', handleKeyboardIsolation);

    // Split View restore button
    const splitBtn = ws.querySelector('#focustube-split-toggle-btn');
    if (splitBtn) {
      splitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isSidebarCollapsed = false;
        isNotesPanelOpen = false;
        isNotesPinned = false;
        applyLayoutState();
        showFocusTubeToast("◫ Restored split-view (Video on left, notes on right)");
      });
    }

    // Collapse / Full-width toggle control
    const collapseBtn = ws.querySelector('#focustube-collapse-sidebar-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isFullMode = isVideoInFullMode();
        if (isFullMode) {
          isNotesPanelOpen = false;
          applyLayoutState();
          showFocusTubeToast("Notes hidden");
        } else {
          isSidebarCollapsed = true;
          isNotesPanelOpen = false;
          applyLayoutState();
          showFocusTubeToast("⤢ Video expanded to full width • Floating notes button ready on player");
        }
      });
    }

    ws.querySelectorAll('.focustube-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.getAttribute('data-tab');
        ws.querySelectorAll('.focustube-tab-btn').forEach(b => b.classList.remove('active'));
        ws.querySelectorAll('.focustube-tab-panel').forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        ws.querySelector(`#focustube-panel-${activeTab}`)?.classList.add('active');
      });
    });

    // Rich Text Toolbar for main editor
    const mainToolbar = ws.querySelector('#focustube-note-toolbar');
    const mainEditor = ws.querySelector('#focustube-note-text');

    if (mainToolbar && mainEditor) {
      setupSmartListAndEditorEngine(mainEditor, mainToolbar);
      bindToolbarEvents(mainToolbar, mainEditor);
    }

    // Video Screenshot Capture Button
    const captureBtn = ws.querySelector('#focustube-capture-frame-btn');
    if (captureBtn && mainEditor) {
      captureBtn.addEventListener('mousedown', (e) => {
        // Prevent clicking button from losing selection inside editor
        e.preventDefault();
      });
      captureBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        captureVideoFrame(mainEditor);
      });
    }

    // Live Sync & Grab Timestamp Controls
    const grabBtn = ws.querySelector('#focustube-grab-ts-btn');
    const resetBtn = ws.querySelector('#focustube-reset-ts-btn');

    if (grabBtn) {
      grabBtn.addEventListener('click', () => {
        const time = getVideoCurrentTime();
        capturedTimestampSeconds = time;
        const livePill = ws.querySelector('#focustube-live-time-pill');
        const hint = ws.querySelector('#focustube-ts-hint');
        const grabLabel = grabBtn.querySelector('.focustube-grab-btn-label');

        if (livePill) livePill.textContent = formatSeconds(time);
        if (grabLabel) grabLabel.textContent = '📌 Locked at:';
        grabBtn.classList.add('captured');
        if (resetBtn) resetBtn.style.display = 'inline-flex';
        if (hint) hint.textContent = 'Timestamp locked for this note';

        showFocusTubeToast(`📍 Timestamp locked at ${formatSeconds(time)}`);
        if (mainEditor) mainEditor.focus();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        capturedTimestampSeconds = null;
        const time = getVideoCurrentTime();
        const livePill = ws.querySelector('#focustube-live-time-pill');
        const hint = ws.querySelector('#focustube-ts-hint');
        const grabLabel = grabBtn?.querySelector('.focustube-grab-btn-label');

        if (livePill) livePill.textContent = formatSeconds(time);
        if (grabLabel) grabLabel.textContent = '📍 Grab Timestamp:';
        if (grabBtn) grabBtn.classList.remove('captured');
        resetBtn.style.display = 'none';
        if (hint) hint.textContent = 'Live synced with player';

        showFocusTubeToast(`↺ Resumed live video sync (${formatSeconds(time)})`);
        if (mainEditor) mainEditor.focus();
      });
    }

    // Save Note Button & Shortcut
    const saveBtn = ws.querySelector('#focustube-save-note-btn');
    if (saveBtn && mainEditor) {
      const handleSave = () => saveCurrentNote(getCurrentVideoId(), mainEditor);
      saveBtn.addEventListener('click', handleSave);
      mainEditor.addEventListener('keydown', (e) => {
        handleKeyboardIsolation(e);
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          handleSave();
        }
      });
      mainEditor.addEventListener('keyup', handleKeyboardIsolation);
      mainEditor.addEventListener('keypress', handleKeyboardIsolation);
    }

    // Export Dropdown menu handling
    const exportMenuBtn = ws.querySelector('#focustube-export-menu-btn');
    const exportDropdown = ws.querySelector('#focustube-export-dropdown-menu');

    exportMenuBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isExpanded = exportDropdown?.classList.toggle('show');
      exportMenuBtn.setAttribute('aria-expanded', String(Boolean(isExpanded)));
    });

    ws.querySelector('#focustube-export-docx-action')?.addEventListener('click', (e) => {
      e.stopPropagation();
      exportDropdown?.classList.remove('show');
      exportMenuBtn?.setAttribute('aria-expanded', 'false');
      exportNotes('docx');
    });

    ws.querySelector('#focustube-export-md-action')?.addEventListener('click', (e) => {
      e.stopPropagation();
      exportDropdown?.classList.remove('show');
      exportMenuBtn?.setAttribute('aria-expanded', 'false');
      exportNotes('md');
    });

    // Close export dropdown on clicking outside
    const handleOutsideExportClick = (e) => {
      if (!e.target.closest('.focustube-export-dropdown-wrapper')) {
        exportDropdown?.classList.remove('show');
        exportMenuBtn?.setAttribute('aria-expanded', 'false');
      }
    };
    document.removeEventListener('click', handleOutsideExportClick);
    document.addEventListener('click', handleOutsideExportClick);
    ws.querySelector('#focustube-add-current-video-btn')?.addEventListener('click', () => addCurrentVideoToQueue());
    ws.querySelector('#focustube-timer-toggle-btn')?.addEventListener('click', toggleTimer);
    ws.querySelector('#focustube-timer-reset-btn')?.addEventListener('click', resetTimer);
  }

  // ==========================================================
  // URL Helpers
  // ==========================================================
  function getWatchUrl(videoId) {
    const base = window.location.hostname.includes('m.youtube.com') ? 'https://m.youtube.com' : 'https://www.youtube.com';
    return `${base}/watch?v=${videoId}`;
  }

  function getSearchUrl(query) {
    const base = window.location.hostname.includes('m.youtube.com') ? 'https://m.youtube.com' : 'https://www.youtube.com';
    return `${base}/results?search_query=${encodeURIComponent(query)}`;
  }

  // ==========================================================
  // Video Player Helpers
  // ==========================================================
  function getVideoElement() {
    return document.querySelector('video');
  }

  function getVideoCurrentTime() {
    const video = getVideoElement();
    return video ? Math.floor(video.currentTime) : 0;
  }

  function seekVideo(seconds) {
    const video = getVideoElement();
    if (video) {
      video.currentTime = seconds;
      video.play().catch(() => {});
    }
  }

  async function saveCurrentNote(videoId, editorEl) {
    if (!editorEl || !videoId) return;

    const rawHtml = editorEl.innerHTML.trim();
    const cleanHtml = sanitizeRichHtml(rawHtml);

    if (!editorEl.textContent.trim() && !cleanHtml.includes('<img')) return;

    const seconds = capturedTimestampSeconds !== null ? capturedTimestampSeconds : getVideoCurrentTime();
    const newNote = {
      id: 'note_' + Date.now(),
      seconds,
      text: cleanHtml,
      createdAt: Date.now()
    };

    const notes = { ...currentSettings.notes };
    const list = notes[videoId] ? [...notes[videoId]] : [];
    list.push(newNote);
    list.sort((a, b) => a.seconds - b.seconds);
    notes[videoId] = list;

    currentSettings.notes = notes;
    await chrome.storage.local.set({ notes });
    editorEl.innerHTML = '';
    capturedTimestampSeconds = null;
    editorEl._savedRange = null;

    updateWorkspaceContent(document.getElementById('focustube-sidebar-workspace'));
    showFocusTubeToast(`✓ Note saved at ${formatSeconds(seconds)}`);
  }

  async function updateNote(videoId, noteId, newHtml, newSeconds = null) {
    if (!newHtml || !videoId || !noteId) return;
    const cleanHtml = sanitizeRichHtml(newHtml);
    const notes = { ...currentSettings.notes };
    if (!notes[videoId]) return;

    notes[videoId] = notes[videoId].map(n => {
      if (n.id === noteId) {
        return {
          ...n,
          text: cleanHtml,
          seconds: newSeconds !== null ? newSeconds : n.seconds,
          updatedAt: Date.now()
        };
      }
      return n;
    });

    notes[videoId].sort((a, b) => a.seconds - b.seconds);
    currentSettings.notes = notes;
    await chrome.storage.local.set({ notes });
    showFocusTubeToast("✓ Note updated");
    updateWorkspaceContent(document.getElementById('focustube-sidebar-workspace'));
  }

  async function deleteNote(videoId, noteId) {
    const notes = { ...currentSettings.notes };
    if (!notes[videoId]) return;
    notes[videoId] = notes[videoId].filter(n => n.id !== noteId);
    currentSettings.notes = notes;
    await chrome.storage.local.set({ notes });
    showFocusTubeToast("Note deleted");
    updateWorkspaceContent(document.getElementById('focustube-sidebar-workspace'));
  }

  async function exportNotes(format = 'docx', targetNoteId = null, triggerBtn = null) {
    const videoId = getCurrentVideoId();
    if (!videoId) {
      showFocusTubeToast("⚠️ No active video ID found.");
      return;
    }

    const savedNotes = (currentSettings.notes && currentSettings.notes[videoId]) ? [...currentSettings.notes[videoId]] : [];

    let exportNotesList = [];
    const isSingleNote = Boolean(targetNoteId);

    if (isSingleNote) {
      const foundNote = savedNotes.find(n => n.id === targetNoteId);
      if (!foundNote) {
        showFocusTubeToast("⚠️ Note not found.");
        return;
      }

      // Check if user has open/edited inline editor on this card
      const card = document.querySelector(`.focustube-note-card[data-note-id="${targetNoteId}"]`);
      const inlineEditor = card?.querySelector(`.focustube-inline-rich-editor[data-editor-id="${targetNoteId}"]`);
      const editBox = card?.querySelector(`.focustube-note-edit-container[data-edit-box-id="${targetNoteId}"]`);
      let noteText = foundNote.text;

      if (inlineEditor && editBox && editBox.style.display !== 'none') {
        const inlineHtml = inlineEditor.innerHTML.trim();
        if (inlineHtml) {
          noteText = sanitizeRichHtml(inlineHtml);
        }
      }

      exportNotesList = [{
        ...foundNote,
        text: noteText
      }];
    } else {
      // Capture pending unsaved content from main note editor without mutating editor
      const mainEditor = document.querySelector('#focustube-note-text');
      let hasDraft = false;
      let draftNote = null;

      if (mainEditor) {
        const draftRaw = mainEditor.innerHTML.trim();
        const draftClean = sanitizeRichHtml(draftRaw);
        const hasContent = mainEditor.textContent.trim().length > 0 || draftClean.includes('<img') || draftClean.includes('<figure');

        if (hasContent) {
          hasDraft = true;
          const currentSec = capturedTimestampSeconds !== null ? capturedTimestampSeconds : getVideoCurrentTime();
          draftNote = {
            id: 'draft_' + Date.now(),
            seconds: currentSec,
            text: draftClean,
            isDraft: true,
            createdAt: Date.now()
          };
        }
      }

      exportNotesList = [...savedNotes];
      if (hasDraft && draftNote) {
        exportNotesList.push(draftNote);
        exportNotesList.sort((a, b) => a.seconds - b.seconds);
      }

      if (exportNotesList.length === 0) {
        showFocusTubeToast("⚠️ No notes to export for this video.");
        return;
      }
    }

    const videoTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, .media-item-headline')?.innerText || document.title.replace(/\s*-\s*YouTube$/i, '') || 'Video';
    const videoUrl = window.location.href;
    const activeTopic = currentSettings.activeTopic || 'General Study';

    const sanitizeFn = window.FocusTubeExport?.sanitizeFilename || ((t) => t.replace(/[\/\\?%*:|"<>~]/g, '_'));
    const safeTitle = sanitizeFn(videoTitle);

    let docTitle = videoTitle;
    let baseFilename = safeTitle;

    if (isSingleNote) {
      const timeStr = formatSeconds(exportNotesList[0].seconds);
      const safeTime = timeStr.replace(/[:.]/g, '-');
      docTitle = `${videoTitle} - Note [${timeStr}]`;
      baseFilename = `${safeTitle}_Note_${safeTime}`;
    }

    const documentData = {
      title: docTitle,
      topic: activeTopic,
      videoUrl: videoUrl,
      date: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
      notes: exportNotesList
    };

    // Button loading state management
    const exportBtn = triggerBtn || document.getElementById('focustube-export-menu-btn');
    const labelEl = triggerBtn ? triggerBtn.querySelector('span') : document.getElementById('focustube-export-btn-label');
    const origContent = triggerBtn ? triggerBtn.innerHTML : (labelEl ? labelEl.textContent : 'Export All ▾');

    if (exportBtn) {
      exportBtn.disabled = true;
      if (triggerBtn) {
        triggerBtn.innerHTML = `<span class="focustube-export-spinner"></span>`;
      } else if (labelEl) {
        labelEl.innerHTML = `<span class="focustube-export-spinner"></span> Exporting...`;
      }
    }

    showFocusTubeToast(`⏳ Exporting ${isSingleNote ? 'note' : 'notes'} as ${format.toUpperCase()}...`);

    try {
      if (format === 'md') {
        let md = `# FocusTube Study Note${isSingleNote ? '' : 's'}: ${videoTitle}\n`;
        md += `*Topic:* ${activeTopic}\n`;
        md += `*Video URL:* ${videoUrl}\n`;
        md += `*Date:* ${documentData.date}\n\n---\n\n`;

        exportNotesList.forEach(note => {
          const timeStr = formatSeconds(note.seconds);
          const markdownBody = htmlToMarkdown(note.text);
          const draftLabel = note.isDraft ? ' *(Draft)*' : '';
          md += `### [${timeStr}](${videoUrl}&t=${note.seconds}s)${draftLabel}\n${markdownBody}\n\n`;
        });

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseFilename}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showFocusTubeToast(`📥 ${isSingleNote ? 'Note' : 'All notes'} exported as Markdown!`);
        return;
      }

      if (format === 'docx') {
        if (!window.FocusTubeExport) {
          throw new Error("Export engine is still initializing. Please wait a moment.");
        }

        const res = await window.FocusTubeExport.exportNotesToDocx(documentData, {
          filename: `${baseFilename}.docx`
        });
        showFocusTubeToast(`📥 ${isSingleNote ? 'Note' : 'All notes'} exported as Word (.docx): ${res.filename}`);
      } else {
        throw new Error(`Unsupported export format: ${format}`);
      }
    } catch (err) {
      console.error('[FocusTube] Export error:', err);
      showFocusTubeToast(`⚠️ Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      if (exportBtn) {
        exportBtn.disabled = false;
        if (triggerBtn) {
          triggerBtn.innerHTML = origContent;
        } else if (labelEl) {
          labelEl.textContent = origContent;
        }
      }
    }
  }

  async function addCurrentVideoToQueue() {
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    const exists = (currentSettings.videoQueue || []).some(v => v.id === videoId);
    if (exists) {
      alert("This video is already in your topic queue!");
      return;
    }

    const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, .media-item-headline')?.innerText || document.title.replace(' - YouTube', '');
    const channel = document.querySelector('#upload-info #channel-name a, .media-item-metadata-secondary-text')?.innerText || '';

    const newVideo = {
      id: videoId,
      title: title || 'Focused Video',
      channelTitle: channel || '',
      topic: currentSettings.activeTopic,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      addedAt: Date.now()
    };

    await addVideoObjectToQueue(newVideo);
    updateWorkspaceContent(document.getElementById('focustube-sidebar-workspace'));
  }

  async function addVideoObjectToQueue(videoObj) {
    const queue = currentSettings.videoQueue || [];
    if (queue.some(v => v.id === videoObj.id)) return;

    const newQueue = [...queue, { ...videoObj, addedAt: Date.now() }];
    currentSettings.videoQueue = newQueue;
    await chrome.storage.local.set({ videoQueue: newQueue });
  }

  async function removeVideoFromQueue(removeId) {
    const videoQueue = (currentSettings.videoQueue || []).filter(v => v.id !== removeId);
    currentSettings.videoQueue = videoQueue;
    await chrome.storage.local.set({ videoQueue: newQueue });
    updateWorkspaceContent(document.getElementById('focustube-sidebar-workspace'));
  }

  // ==========================================================
  // Timer
  // ==========================================================
  function toggleTimer() {
    const ws = document.getElementById('focustube-sidebar-workspace');
    const toggleBtn = ws?.querySelector('#focustube-timer-toggle-btn');

    if (isTimerRunning) {
      clearInterval(timerInterval);
      isTimerRunning = false;
      if (toggleBtn) toggleBtn.textContent = '▶ Start Focus';
    } else {
      isTimerRunning = true;
      if (toggleBtn) toggleBtn.textContent = '⏸ Pause';

      timerInterval = setInterval(() => {
        if (timerSecondsLeft > 0) {
          timerSecondsLeft--;
          const textEl = ws?.querySelector('#focustube-timer-text');
          if (textEl) textEl.textContent = formatTimer(timerSecondsLeft);
        } else {
          clearInterval(timerInterval);
          isTimerRunning = false;
          playFocusChime();
          alert("🎉 Focus session completed!");
          resetTimer();
        }
      }, 1000);
    }
  }

  function resetTimer() {
    clearInterval(timerInterval);
    isTimerRunning = false;
    timerSecondsLeft = (currentSettings.timerDurationMinutes || 25) * 60;
    const ws = document.getElementById('focustube-sidebar-workspace');
    if (ws) {
      const textEl = ws.querySelector('#focustube-timer-text');
      const toggleBtn = ws.querySelector('#focustube-timer-toggle-btn');
      if (textEl) textEl.textContent = formatTimer(timerSecondsLeft);
      if (toggleBtn) toggleBtn.textContent = '▶ Start Focus';
    }
  }

  function playFocusChime() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
      osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.15);

      gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.6);
    } catch {
      // AudioContext fallback
    }
  }

  // ==========================================================
  // Page State Handler
  // ==========================================================
  function handlePageChangeAsync() {
    const path = window.location.pathname;
    const currentUrl = window.location.href;

    if (currentUrl === lastAnalyzedUrl) return;
    lastAnalyzedUrl = currentUrl;

    applyBodyClasses();
    setupSearchEnforcer();
    enforceSearchOnUrl();
    cleanupPlayerEndscreen();

    const isWatch = path === '/watch' && !!getCurrentVideoId();
    const isHome = path === '/';

    if (isWatch) {
      cleanupHomeFeed();
      isSidebarCollapsed = false; // Default view: split-view (video on left, note-taking section on right)
      isNotesPanelOpen = false;   // In full mode, overlay is toggled via floating button
      isNotesPinned = false;
      injectSidebarWorkspace();
      applyLayoutState();
    } else if (isHome) {
      cleanupSidebarWorkspace();
      renderNativeHomeFeedAsync();
    } else {
      cleanupSidebarWorkspace();
      cleanupHomeFeed();
    }
  }

  function ensurePageState() {
    setupSearchEnforcer();
    const path = window.location.pathname;
    if (path === '/watch' && getCurrentVideoId()) {
      if (!document.getElementById('focustube-sidebar-workspace')) {
        injectSidebarWorkspace();
      }
      setupVideoPlayerEndingProtection();
    } else if (path === '/') {
      if (!document.getElementById('focustube-home-feed')) {
        renderNativeHomeFeedAsync();
      }
    }
  }

  function formatSeconds(totalSeconds) {
    const sec = Math.floor(totalSeconds || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function formatTimer(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
