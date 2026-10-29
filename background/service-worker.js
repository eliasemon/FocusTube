/**
 * FocusTube Background Service Worker (Manifest V3)
 * Large-Scale Topic Video Indexing Engine (50 - 100+ videos per topic).
 * Handles parallel multi-query searching, regex matching, and on-demand pagination.
 */

const DEFAULT_STATE = {
  focusModeEnabled: true,
  activeTopic: "Full-Stack Web Development",
  topics: [
    {
      id: "topic-default-1",
      name: "Full-Stack Web Development",
      tags: ["react", "next.js", "typescript", "architecture", "system design", "node.js"],
      createdAt: Date.now()
    },
    {
      id: "topic-default-2",
      name: "Machine Learning & AI",
      tags: ["neural networks", "transformers", "python", "pytorch", "deep learning", "llm"],
      createdAt: Date.now() - 3600000
    }
  ],
  blockHomeFeed: true,
  blockShorts: true,
  blockSidebarVideos: true,
  blockComments: false,
  autoSeekNotes: true,
  timerDurationMinutes: 25,
  videoQueue: [],
  indexedVideos: {},
  watchedVideoIds: [],
  notes: {},
  youtubeApiKey: ""
};

// Initialize default settings on extension installation or update
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(null);
  const updates = {};

  for (const [key, value] of Object.entries(DEFAULT_STATE)) {
    if (current[key] === undefined) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  await updateBadge(current.focusModeEnabled ?? true);

  // Trigger initial indexing for default topic in background
  const state = await chrome.storage.local.get(['topics', 'activeTopic', 'indexedVideos']);
  const activeTopicObj = (state.topics || []).find(t => t.name === state.activeTopic);
  if (activeTopicObj) {
    indexTopicVideos(activeTopicObj, 1);
  }
});

// Sync badge on storage change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.focusModeEnabled !== undefined) {
    updateBadge(changes.focusModeEnabled.newValue);
  }
});

async function updateBadge(enabled) {
  if (enabled) {
    await chrome.action.setBadgeText({ text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ color: "#10B981" });
  } else {
    await chrome.action.setBadgeText({ text: "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
  }
}

// ==========================================================
// Regex Engine for Topic & Heading / Tag Matching
// ==========================================================
function buildTopicRegex(topicName, tags = []) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allTerms = [topicName, ...(tags || [])].filter(Boolean);

  const words = [];
  allTerms.forEach(term => {
    const trimmed = term.trim().toLowerCase();
    words.push(trimmed);
    trimmed.split(/[\s\-]+/).forEach(w => {
      if (w.length >= 3) words.push(w);
    });
  });

  const uniqueTerms = Array.from(new Set(words));
  const patternStr = uniqueTerms.map(w => escapeRegex(w).replace(/\\\./g, '\\.?')).join('|');
  const regex = new RegExp(`(?:^|[\\s.,_\\-/#"'(])(${patternStr})(?:$|[\\s.,_\\-/#"')])`, 'i');

  return { regex, terms: uniqueTerms };
}

// Generate diverse search queries to ensure at least 50-100+ videos
function generateSearchQueries(topicName, tags = [], tier = 1) {
  const queries = [];
  const base = topicName.trim();

  if (tier === 1) {
    queries.push(base);
    queries.push(`${base} full course`);
    queries.push(`${base} tutorial for beginners`);
    queries.push(`${base} roadmap`);
    queries.push(`${base} project build`);

    // Add top tags
    (tags || []).slice(0, 3).forEach(tag => {
      queries.push(`${base} ${tag}`);
    });
  } else {
    // Additional queries for infinite scroll expansion
    queries.push(`${base} masterclass`);
    queries.push(`${base} crash course`);
    queries.push(`${base} interview questions`);
    queries.push(`${base} best practices`);
    queries.push(`${base} deep dive`);

    (tags || []).slice(3, 8).forEach(tag => {
      queries.push(`${tag} tutorial full course`);
    });
  }

  return Array.from(new Set(queries));
}

// Fetch YouTube search page HTML and extract videoRenderers
async function fetchSingleSearchPage(query) {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) return [];

    const html = await response.text();
    let initialData = null;

    const match1 = html.match(/var ytInitialData\s*=\s*({.+?});<\/script>/);
    const match2 = html.match(/ytInitialData\s*=\s*({.+?});/);

    if (match1) {
      initialData = JSON.parse(match1[1]);
    } else if (match2) {
      initialData = JSON.parse(match2[1]);
    }

    if (!initialData) return [];

    const videos = [];
    const contents = initialData.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    for (const section of contents) {
      const itemSection = section.itemSectionRenderer?.contents || [];
      for (const item of itemSection) {
        const vr = item.videoRenderer;
        if (vr && vr.videoId) {
          const vid = vr.videoId;
          const title = vr.title?.runs?.[0]?.text || '';
          const channel = vr.ownerText?.runs?.[0]?.text || '';
          const thumb = vr.thumbnail?.thumbnails?.[vr.thumbnail.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
          const duration = vr.lengthText?.simpleText || '';
          const views = vr.viewCountText?.simpleText || vr.shortViewCountText?.simpleText || '';
          const published = vr.publishedTimeText?.simpleText || '';
          const channelThumb = vr.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url || '';

          videos.push({
            id: vid,
            title,
            channelTitle: channel,
            channelThumbnail: channelThumb,
            thumbnail: thumb,
            duration,
            views,
            published,
            querySource: query
          });
        }
      }
    }

    return videos;
  } catch (err) {
    console.warn(`[FocusTube Indexer] Error fetching query "${query}":`, err);
    return [];
  }
}

// Large-scale multi-query topic indexer
async function indexTopicVideos(topic, tier = 1) {
  if (!topic || !topic.name) return [];

  try {
    const { regex, terms } = buildTopicRegex(topic.name, topic.tags);
    const queries = generateSearchQueries(topic.name, topic.tags, tier);

    // Fetch across queries in parallel
    const queryResults = await Promise.all(queries.map(q => fetchSingleSearchPage(q)));

    // Load existing indexed videos to merge and avoid duplicates
    const data = await chrome.storage.local.get('indexedVideos');
    const indexedVideosMap = data.indexedVideos || {};
    const existingList = indexedVideosMap[topic.id] || [];

    const candidateMap = new Map();
    // Put existing first
    existingList.forEach(v => candidateMap.set(v.id, v));

    // Add new results
    queryResults.flat().forEach(v => {
      if (!candidateMap.has(v.id)) {
        candidateMap.set(v.id, {
          ...v,
          topic: topic.name,
          topicId: topic.id
        });
      }
    });

    const candidates = Array.from(candidateMap.values());

    // Filter using Regex on title & channel
    const matchedVideos = candidates.filter(v => {
      const fullText = `${v.title} ${v.channelTitle}`.toLowerCase();
      return regex.test(fullText);
    });

    // Score relevance
    matchedVideos.forEach(v => {
      let score = 0;
      const lowerTitle = v.title.toLowerCase();
      terms.forEach(term => {
        if (lowerTitle.includes(term)) score += 2;
      });
      v.matchScore = score;
    });

    matchedVideos.sort((a, b) => b.matchScore - a.matchScore);

    // Save updated list in local storage
    indexedVideosMap[topic.id] = matchedVideos;
    await chrome.storage.local.set({ indexedVideos: indexedVideosMap });

    return matchedVideos;
  } catch (err) {
    console.error('[FocusTube Indexer Failed]:', err);
    return [];
  }
}

// Runtime message listeners
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "FETCH_TOPIC_SUGGESTIONS": {
          const query = message.query?.trim();
          if (!query) {
            sendResponse({ success: true, suggestions: [] });
            return;
          }

          const endpoint = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
          const response = await fetch(endpoint);
          if (!response.ok) throw new Error(`Status ${response.status}`);

          const data = await response.json();
          const suggestions = Array.isArray(data[1]) ? data[1] : [];
          sendResponse({ success: true, suggestions });
          break;
        }

        case "INDEX_TOPIC_VIDEOS": {
          const topic = message.topic;
          const videos = await indexTopicVideos(topic, 1);
          sendResponse({ success: true, videos, count: videos.length });
          break;
        }

        case "INDEX_MORE_VIDEOS": {
          const topic = message.topic;
          // Tier 2 generates deeper and tag-based queries for infinite scrolling
          const videos = await indexTopicVideos(topic, 2);
          sendResponse({ success: true, videos, count: videos.length });
          break;
        }

        case "INDEX_FRESH_VIDEOS": {
          const topic = message.topic;
          // Clear current cache for this topic to obtain completely fresh list
          const data = await chrome.storage.local.get('indexedVideos');
          const indexedVideosMap = data.indexedVideos || {};
          indexedVideosMap[topic.id] = [];
          await chrome.storage.local.set({ indexedVideos: indexedVideosMap });

          // Run both tier 1 and tier 2 to produce 60-100+ fresh videos
          const videos = await indexTopicVideos(topic, 1);
          await indexTopicVideos(topic, 2);
          const updated = await chrome.storage.local.get('indexedVideos');
          const finalVideos = (updated.indexedVideos && updated.indexedVideos[topic.id]) || videos;
          sendResponse({ success: true, videos: finalVideos, count: finalVideos.length });
          break;
        }

        case "GET_INDEXED_VIDEOS": {
          const { topicId } = message;
          const data = await chrome.storage.local.get('indexedVideos');
          const videos = (data.indexedVideos && data.indexedVideos[topicId]) || [];
          sendResponse({ success: true, videos, count: videos.length });
          break;
        }

        default:
          sendResponse({ success: false, error: "Unknown action" });
      }
    } catch (err) {
      console.error("[FocusTube Service Worker Error]:", err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});
