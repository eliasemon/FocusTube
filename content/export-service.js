/**
 * FocusTube - Note Export Service (PDF & Microsoft Word DOCX)
 * Supports rich-text formatting, Unicode (including Bangla), video screenshots,
 * custom timestamps, task lists, code blocks, and clickable hyperlinks.
 */
(function (global) {
  'use strict';

  // ==========================================================
  // Helper: Filename Sanitizer
  // ==========================================================
  function sanitizeFilename(title, defaultName = 'FocusTube_Study_Notes') {
    if (!title || typeof title !== 'string') {
      return defaultName;
    }

    // Remove YouTube suffix if present
    let cleaned = title.replace(/\s*-\s*YouTube$/i, '').trim();

    // Replace illegal filename characters across Windows, macOS, Linux:
    // \ / : * ? " < > | and control characters
    cleaned = cleaned.replace(/[\/\\?%*:|"<>~]/g, '_');
    // Remove control characters (0-31 and 127-159)
    cleaned = cleaned.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    // Collapse multiple underscores or spaces
    cleaned = cleaned.replace(/[\s_]+/g, '_');
    // Trim leading/trailing dots, spaces, underscores
    cleaned = cleaned.replace(/^[\s._-]+|[\s._-]+$/g, '');

    // Limit length to 90 characters to avoid filesystem limit errors
    if (cleaned.length > 90) {
      cleaned = cleaned.slice(0, 90).replace(/[._-]+$/, '');
    }

    return cleaned || defaultName;
  }

  // ==========================================================
  // Helper: Format Seconds to MM:SS or HH:MM:SS
  // ==========================================================
  function formatSeconds(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return '0:00';
    const totalSecs = Math.max(0, Math.floor(sec));
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ==========================================================
  // Helper: HTML Escaping
  // ==========================================================
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ==========================================================
  // Helper: DataURL to Uint8Array Converter
  // ==========================================================
  function dataUrlToUint8Array(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') {
      return new Uint8Array(0);
    }
    const parts = dataUrl.split(',');
    if (parts.length < 2) {
      return new Uint8Array(0);
    }
    const base64Str = parts[1];
    if (typeof atob === 'function') {
      const binaryString = atob(base64Str);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    } else if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(base64Str, 'base64'));
    }
    return new Uint8Array(0);
  }

  // ==========================================================
  // Helper: Parse Image Dimensions from Raw Bytes (JPEG / PNG)
  // Fallback for Node.js / headless environments without Image()
  // ==========================================================
  function getImageDimensionsFromBytes(bytes) {
    if (!bytes || bytes.length < 16) return { width: 800, height: 450 };

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (width > 0 && height > 0) return { width, height };
    }

    // JPEG signature: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xFF) break;
        const marker = bytes[offset + 1];
        // SOF0, SOF1, SOF2 markers
        if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
            (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
          const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
          const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
          if (width > 0 && height > 0) return { width, height };
          break;
        }
        offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
      }
    }

    return { width: 800, height: 450 };
  }

  // ==========================================================
  // Image Scaling Helper (Preserves Aspect Ratio strictly)
  // ==========================================================
  function calculateFittedDimensions(origWidth, origHeight, maxWidth = 560, maxHeight = 680) {
    let width = origWidth || 800;
    let height = origHeight || 450;

    if (width <= 0) width = 800;
    if (height <= 0) height = 450;

    const aspectRatio = width / height;

    // Constrain width
    if (width > maxWidth) {
      width = maxWidth;
      height = Math.round(width / aspectRatio);
    }

    // Constrain height if still too tall
    if (height > maxHeight) {
      height = maxHeight;
      width = Math.round(height * aspectRatio);
    }

    return {
      width: Math.max(50, width),
      height: Math.max(30, height),
      aspectRatio
    };
  }

  // ==========================================================
  // Image Resolver
  // Resolves base64 data URLs, blob URLs, and remote URLs
  // into valid image data with dimensions and Uint8Array bytes
  // ==========================================================
  const imageResolutionCache = new Map();

  async function resolveImageSource(src) {
    if (!src || typeof src !== 'string') {
      return { ok: false, error: 'Empty image source' };
    }

    if (imageResolutionCache.has(src)) {
      return imageResolutionCache.get(src);
    }

    try {
      let dataUrl = src;
      let uint8Array = null;
      let naturalWidth = 0;
      let naturalHeight = 0;

      if (src.startsWith('data:image/')) {
        dataUrl = src;
        uint8Array = dataUrlToUint8Array(dataUrl);
      } else if (src.startsWith('blob:')) {
        // Blob URL: fetch blob content
        if (typeof fetch === 'function') {
          const resp = await fetch(src);
          const blob = await resp.blob();
          dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          uint8Array = dataUrlToUint8Array(dataUrl);
        }
      } else if (src.startsWith('http://') || src.startsWith('https://')) {
        // Remote URL: attempt fetch or image drawing
        let converted = false;
        if (typeof fetch === 'function') {
          try {
            const resp = await fetch(src, { mode: 'cors' });
            if (resp.ok) {
              const blob = await resp.blob();
              dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
              uint8Array = dataUrlToUint8Array(dataUrl);
              converted = true;
            }
          } catch (e) {
            // CORS or network error on fetch, fallback to canvas
          }
        }

        if (!converted && typeof document !== 'undefined' && typeof Image !== 'undefined') {
          dataUrl = await new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || 800;
                canvas.height = img.naturalHeight || 450;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/jpeg', 0.9));
              } catch (err) {
                // Tainted canvas or DRM issue
                resolve(src);
              }
            };
            img.onerror = () => reject(new Error('Failed to load remote image: ' + src));
            img.src = src;
          });
          if (dataUrl.startsWith('data:')) {
            uint8Array = dataUrlToUint8Array(dataUrl);
          }
        }
      }

      // Determine dimensions
      if (typeof Image !== 'undefined') {
        try {
          const dims = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
            img.onerror = () => reject(new Error('Failed to decode image dimensions'));
            img.src = dataUrl;
          });
          naturalWidth = dims.width;
          naturalHeight = dims.height;
        } catch (_) {
          const headerDims = getImageDimensionsFromBytes(uint8Array);
          naturalWidth = headerDims.width;
          naturalHeight = headerDims.height;
        }
      } else {
        const headerDims = getImageDimensionsFromBytes(uint8Array);
        naturalWidth = headerDims.width;
        naturalHeight = headerDims.height;
      }

      const fitted = calculateFittedDimensions(naturalWidth, naturalHeight);

      const resolved = {
        ok: true,
        src,
        dataUrl,
        uint8Array,
        naturalWidth,
        naturalHeight,
        fittedWidth: fitted.width,
        fittedHeight: fitted.height,
        aspectRatio: fitted.aspectRatio
      };

      imageResolutionCache.set(src, resolved);
      return resolved;
    } catch (err) {
      console.warn('[FocusTubeExport] Failed to resolve image:', src, err);
      const fallback = {
        ok: false,
        src,
        error: err.message || 'Image retrieval failed',
        dataUrl: src
      };
      return fallback;
    }
  }

  // Pre-resolve all images in an HTML snippet
  async function resolveAllImagesInHtml(html) {
    if (!html || typeof html !== 'string') return { cleanHtml: '', resolvedImages: [] };

    let doc;
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      doc = parser.parseFromString(html, 'text/html');
    } else {
      // In minimal test environments, regex match images
      return { cleanHtml: html, resolvedImages: [] };
    }

    const imgs = Array.from(doc.querySelectorAll('img'));
    const resolvedList = [];

    for (const img of imgs) {
      const rawSrc = img.getAttribute('src');
      if (rawSrc) {
        const resolved = await resolveImageSource(rawSrc);
        resolvedList.push(resolved);
        if (resolved.ok && resolved.dataUrl) {
          img.setAttribute('src', resolved.dataUrl);
        }
      }
    }

    return {
      cleanHtml: doc.body.innerHTML,
      resolvedImages: resolvedList
    };
  }

  // ==========================================================
  // PDF Generation HTML Builder
  // Creates standalone, clean, isolated printable HTML document
  // ==========================================================
  function buildExportHtml(documentData) {
    const {
      title = 'FocusTube Notes',
      topic = 'General Study',
      videoUrl = '',
      date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
      notes = []
    } = documentData;

    const safeTitle = escapeHtml(title);
    const safeTopic = escapeHtml(topic);
    const safeVideoUrl = escapeHtml(videoUrl);
    const safeDate = escapeHtml(date);

    let notesHtml = '';

    if (!notes || notes.length === 0) {
      notesHtml = `
        <div style="text-align: center; color: #64748b; padding: 40px 20px; font-style: italic;">
          No notes recorded for this video session.
        </div>
      `;
    } else {
      notesHtml = notes.map((note, index) => {
        const formattedTime = formatSeconds(note.seconds);
        const noteUrl = videoUrl ? `${videoUrl}${videoUrl.includes('?') ? '&' : '?'}t=${note.seconds}s` : '#';
        const isDraft = note.isDraft ? '<span class="focustube-pdf-draft-badge">Current Draft (Unsaved)</span>' : '';

        return `
          <div class="focustube-pdf-note-card">
            <div class="focustube-pdf-note-header">
              <a href="${safeVideoUrl ? noteUrl : '#'}" class="focustube-pdf-timestamp-pill" title="Jump to ${formattedTime} on YouTube">
                ▶ ${formattedTime}
              </a>
              ${isDraft}
            </div>
            <div class="focustube-pdf-note-content">
              ${note.text || ''}
            </div>
          </div>
        `;
      }).join('\n');
    }

    return `
      <div class="focustube-pdf-document" id="focustube-pdf-render-root">
        <style>
          .focustube-pdf-document {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans Bengali", sans-serif;
            color: #0f172a;
            background: #ffffff;
            line-height: 1.6;
            font-size: 13.5px;
            padding: 24px;
            max-width: 800px;
            margin: 0 auto;
            box-sizing: border-box;
            -webkit-font-smoothing: antialiased;
          }

          /* Header Section */
          .focustube-pdf-header {
            border-bottom: 2px solid #e2e8f0;
            padding-bottom: 18px;
            margin-bottom: 24px;
          }
          .focustube-pdf-title {
            font-size: 22px;
            font-weight: 700;
            color: #0f172a;
            margin: 0 0 10px 0;
            line-height: 1.3;
          }
          .focustube-pdf-meta-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 12px 20px;
            font-size: 12px;
            color: #475569;
          }
          .focustube-pdf-meta-item strong {
            color: #1e293b;
          }
          .focustube-pdf-meta-item a {
            color: #2563eb;
            text-decoration: underline;
            word-break: break-all;
          }

          /* Note Cards */
          .focustube-pdf-note-card {
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 16px 18px;
            margin-bottom: 20px;
            background: #ffffff;
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .focustube-pdf-note-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid #f1f5f9;
          }
          .focustube-pdf-timestamp-pill {
            display: inline-block;
            background: #e0e7ff;
            color: #4338ca;
            font-weight: 700;
            font-size: 12px;
            padding: 3px 10px;
            border-radius: 14px;
            text-decoration: none;
          }
          .focustube-pdf-draft-badge {
            display: inline-block;
            background: #fef3c7;
            color: #b45309;
            font-size: 10.5px;
            font-weight: 600;
            padding: 2px 7px;
            border-radius: 4px;
          }

          /* Note Body Typography */
          .focustube-pdf-note-content h1 {
            font-size: 18px;
            color: #0f172a;
            margin: 14px 0 8px 0;
            page-break-after: avoid;
            break-after: avoid;
          }
          .focustube-pdf-note-content h2 {
            font-size: 16px;
            color: #1e293b;
            margin: 12px 0 6px 0;
            page-break-after: avoid;
            break-after: avoid;
          }
          .focustube-pdf-note-content h3 {
            font-size: 14.5px;
            color: #334155;
            margin: 10px 0 4px 0;
            page-break-after: avoid;
            break-after: avoid;
          }
          .focustube-pdf-note-content p {
            margin: 0 0 10px 0;
          }
          .focustube-pdf-note-content p:last-child {
            margin-bottom: 0;
          }

          /* Marks & Code */
          .focustube-pdf-note-content mark {
            background-color: #fef08a;
            color: #713f12;
            padding: 1px 4px;
            border-radius: 2px;
          }
          .focustube-pdf-note-content code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            background-color: #f1f5f9;
            color: #b91c1c;
            padding: 2px 5px;
            border-radius: 4px;
            font-size: 12px;
          }
          .focustube-pdf-note-content pre {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            padding: 12px 14px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
            margin: 10px 0;
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .focustube-pdf-note-content pre code {
            background: transparent;
            color: inherit;
            padding: 0;
            border-radius: 0;
          }

          /* Blockquotes */
          .focustube-pdf-note-content blockquote {
            border-left: 4px solid #6366f1;
            margin: 10px 0;
            padding: 6px 14px;
            background: #f8fafc;
            color: #334155;
            font-style: italic;
            page-break-inside: avoid;
            break-inside: avoid;
          }

          /* Lists */
          .focustube-pdf-note-content ul, 
          .focustube-pdf-note-content ol {
            margin: 8px 0 10px 22px;
            padding: 0;
          }
          .focustube-pdf-note-content li {
            margin-bottom: 4px;
          }

          /* Task Lists */
          .focustube-pdf-note-content ul.focustube-task-list {
            list-style: none;
            margin-left: 0;
            padding-left: 0;
          }
          .focustube-pdf-note-content li.focustube-task-item {
            display: flex;
            align-items: baseline;
            gap: 8px;
            margin-bottom: 6px;
          }
          .focustube-pdf-note-content li.focustube-task-item input[type="checkbox"] {
            margin: 0;
            accent-color: #6366f1;
            cursor: default;
          }
          .focustube-pdf-note-content li.focustube-task-item.checked span.focustube-task-text {
            text-decoration: line-through;
            color: #94a3b8;
          }

          /* Screenshots & Figures */
          .focustube-pdf-note-content figure.focustube-screenshot-figure,
          .focustube-pdf-note-content figure {
            margin: 14px 0;
            text-align: center;
            page-break-inside: avoid;
            break-inside: avoid;
          }
          .focustube-pdf-note-content img.focustube-screenshot-img,
          .focustube-pdf-note-content img {
            max-width: 100%;
            height: auto;
            border-radius: 6px;
            border: 1px solid #e2e8f0;
            display: inline-block;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
          }
          .focustube-pdf-note-content figcaption.focustube-screenshot-caption,
          .focustube-pdf-note-content figcaption {
            font-size: 11.5px;
            color: #64748b;
            font-style: italic;
            margin-top: 6px;
            text-align: center;
          }

          /* Links */
          .focustube-pdf-note-content a {
            color: #2563eb;
            text-decoration: underline;
          }

          /* Footer */
          .focustube-pdf-footer {
            margin-top: 32px;
            padding-top: 14px;
            border-top: 1px solid #e2e8f0;
            font-size: 11px;
            color: #94a3b8;
            text-align: center;
          }
        </style>

        <!-- Header -->
        <div class="focustube-pdf-header">
          <h1 class="focustube-pdf-title">FocusTube Study Notes: ${safeTitle}</h1>
          <div class="focustube-pdf-meta-grid">
            <div class="focustube-pdf-meta-item">
              <strong>🎯 Topic:</strong> ${safeTopic}
            </div>
            <div class="focustube-pdf-meta-item">
              <strong>📅 Date:</strong> ${safeDate}
            </div>
            <div class="focustube-pdf-meta-item">
              <strong>⏱️ Total Notes:</strong> ${notes.length}
            </div>
            ${safeVideoUrl ? `
              <div class="focustube-pdf-meta-item" style="flex-basis: 100%;">
                <strong>🔗 Video URL:</strong> <a href="${safeVideoUrl}">${safeVideoUrl}</a>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Notes Body -->
        <div class="focustube-pdf-notes-container">
          ${notesHtml}
        </div>

        <!-- Footer -->
        <div class="focustube-pdf-footer">
          Generated with FocusTube • Deep-Dive Study & Distraction Blocker
        </div>
      </div>
    `;
  }

  // ==========================================================
  // Trigger Browser Download
  // ==========================================================
  function triggerDownload(blobOrBuffer, filename, mimeType) {
    let blob;
    if (blobOrBuffer instanceof Blob) {
      blob = blobOrBuffer;
    } else {
      blob = new Blob([blobOrBuffer], { type: mimeType });
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1500);
  }

  // ==========================================================
  // Export as PDF
  // ==========================================================
  async function exportNotesToPdf(documentData, options = {}) {
    if (typeof window === 'undefined' || !window.document) {
      throw new Error('PDF export must be executed in a browser environment');
    }

    const html2pdfLib = window.html2pdf || (typeof html2pdf !== 'undefined' ? html2pdf : null);
    if (!html2pdfLib) {
      throw new Error('PDF export has been deactivated. Please use Word (.docx) or Markdown (.md) export.');
    }

    // 1. Pre-resolve and embed all images in the notes
    const sanitizedNotes = [];
    const notes = documentData.notes || [];

    for (const note of notes) {
      const resolvedRes = await resolveAllImagesInHtml(note.text);
      sanitizedNotes.push({
        ...note,
        text: resolvedRes.cleanHtml
      });
    }

    const preparedData = {
      ...documentData,
      notes: sanitizedNotes
    };

    // 2. Build printable HTML
    const htmlString = buildExportHtml(preparedData);

    // 3. Mount in a hidden container off-screen
    const container = document.createElement('div');
    container.id = 'focustube-pdf-temp-container';
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '0';
    container.style.width = '794px'; // Standard A4 width in 96 DPI
    container.style.background = '#ffffff';
    container.style.zIndex = '-9999';
    container.innerHTML = htmlString;
    document.body.appendChild(container);

    const filename = `${sanitizeFilename(documentData.title || 'FocusTube_Notes')}.pdf`;

    try {
      const opt = {
        margin: [12, 12, 12, 12], // mm: top, left, bottom, right
        filename,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2, // 2x high resolution rendering for sharp screenshots & Bangla glyphs
          useCORS: true,
          letterRendering: true,
          logging: false,
          scrollX: 0,
          scrollY: 0
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: {
          mode: ['avoid-all', 'css', 'legacy'],
          avoid: [
            '.focustube-pdf-note-card',
            '.focustube-screenshot-figure',
            'figure',
            'img',
            'pre',
            'blockquote',
            '.focustube-pdf-header'
          ]
        },
        enableLinks: true
      };

      // Generate PDF Blob
      const pdfBlob = await html2pdfLib().set(opt).from(container).outputPdf('blob');
      triggerDownload(pdfBlob, filename, 'application/pdf');

      return {
        success: true,
        filename,
        noteCount: sanitizedNotes.length
      };
    } finally {
      // Always cleanup DOM container
      if (container && container.parentNode) {
        container.parentNode.removeChild(container);
      }
    }
  }

  // ==========================================================
  // Recursive HTML to DOCX AST Converter
  // Converts rich HTML into genuine Microsoft Word Document elements
  // ==========================================================
  function htmlToDocxElements(html, docxLib, resolvedImagesMap = new Map(), videoUrl = '') {
    const {
      Paragraph,
      TextRun,
      HeadingLevel,
      ImageRun,
      ExternalHyperlink,
      BorderStyle,
      UnderlineType,
      AlignmentType,
      ShadingType
    } = docxLib;

    if (!html || typeof html !== 'string') {
      return [];
    }

    let body;
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      body = doc.body;
    } else {
      return [new Paragraph({ children: [new TextRun(html.replace(/<[^>]+>/g, ''))] })];
    }

    const docElements = [];

    // Helper: Collect inline runs from a node hierarchy
    function extractInlineRuns(node, currentStyles = {}) {
      const runs = [];

      node.childNodes.forEach(child => {
        if (child.nodeType === 3 /* Node.TEXT_NODE */) {
          const text = child.textContent;
          if (text) {
            const runOptions = {
              text,
              bold: Boolean(currentStyles.bold),
              italics: Boolean(currentStyles.italics),
              strike: Boolean(currentStyles.strike),
            };

            if (currentStyles.underline) {
              runOptions.underline = { type: UnderlineType.SINGLE };
            }
            if (currentStyles.highlight) {
              runOptions.highlight = 'yellow';
            }
            if (currentStyles.code) {
              runOptions.font = 'Consolas';
              runOptions.color = 'B91C1C';
              runOptions.size = 20; // 10pt
            }

            if (currentStyles.link) {
              runs.push(
                new ExternalHyperlink({
                  children: [
                    new TextRun({
                      ...runOptions,
                      style: 'Hyperlink'
                    })
                  ],
                  link: currentStyles.link
                })
              );
            } else {
              runs.push(new TextRun(runOptions));
            }
          }
        } else if (child.nodeType === 1 /* Node.ELEMENT_NODE */) {
          const tag = child.tagName.toUpperCase();

          if (tag === 'BR') {
            runs.push(new TextRun({ break: 1 }));
            return;
          }

          const nextStyles = { ...currentStyles };

          if (tag === 'B' || tag === 'STRONG' || child.style?.fontWeight === 'bold') {
            nextStyles.bold = true;
          }
          if (tag === 'I' || tag === 'EM' || child.style?.fontStyle === 'italic') {
            nextStyles.italics = true;
          }
          if (tag === 'U' || child.style?.textDecoration?.includes('underline')) {
            nextStyles.underline = true;
          }
          if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || child.style?.textDecoration?.includes('line-through')) {
            nextStyles.strike = true;
          }
          if (tag === 'MARK' || child.style?.backgroundColor) {
            nextStyles.highlight = true;
          }
          if (tag === 'CODE') {
            nextStyles.code = true;
          }
          if (tag === 'A') {
            const href = child.getAttribute('href');
            if (href) nextStyles.link = href;
          }

          const childRuns = extractInlineRuns(child, nextStyles);
          runs.push(...childRuns);
        }
      });

      return runs;
    }

    // Process block nodes
    function processBlockNode(node, listContext = { type: null, index: 0, level: 0 }) {
      if (node.nodeType === 3) {
        const text = node.textContent.trim();
        if (text) {
          docElements.push(new Paragraph({ children: [new TextRun(text)] }));
        }
        return;
      }

      if (node.nodeType !== 1) return;

      const tag = node.tagName.toUpperCase();

      // Headings
      if (tag === 'H1') {
        const runs = extractInlineRuns(node, { bold: true });
        docElements.push(
          new Paragraph({
            children: runs,
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 }
          })
        );
        return;
      }
      if (tag === 'H2') {
        const runs = extractInlineRuns(node, { bold: true });
        docElements.push(
          new Paragraph({
            children: runs,
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 160, after: 80 }
          })
        );
        return;
      }
      if (tag === 'H3' || tag === 'H4') {
        const runs = extractInlineRuns(node, { bold: true });
        docElements.push(
          new Paragraph({
            children: runs,
            heading: HeadingLevel.HEADING_4,
            spacing: { before: 120, after: 60 }
          })
        );
        return;
      }

      // Blockquotes
      if (tag === 'BLOCKQUOTE') {
        const runs = extractInlineRuns(node, { italics: true });
        docElements.push(
          new Paragraph({
            children: runs,
            indent: { left: 720 }, // 0.5 in
            border: {
              left: {
                color: '6366F1',
                size: 24, // 3pt
                value: BorderStyle.SINGLE,
                space: 12
              }
            },
            spacing: { before: 120, after: 120 }
          })
        );
        return;
      }

      // Preformatted Code Blocks
      if (tag === 'PRE') {
        const text = node.textContent || '';
        const lines = text.split('\n');
        lines.forEach(line => {
          docElements.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: line || ' ',
                  font: 'Consolas',
                  size: 20, // 10pt
                  color: '0F172A'
                })
              ],
              shading: {
                fill: 'F1F5F9',
                type: ShadingType.CLEAR,
                color: 'auto'
              },
              spacing: { line: 240, before: 20, after: 20 }
            })
          );
        });
        return;
      }

      // Figures & Screenshots
      if (tag === 'FIGURE') {
        const img = node.querySelector('img');
        const figcaption = node.querySelector('figcaption');
        const tsAttr = node.getAttribute('data-timestamp');

        if (img) {
          const src = img.getAttribute('src');
          const resolved = resolvedImagesMap.get(src) || { ok: false };

          if (resolved.ok && resolved.uint8Array && resolved.uint8Array.length > 0) {
            const dims = calculateFittedDimensions(resolved.naturalWidth, resolved.naturalHeight, 560, 680);
            docElements.push(
              new Paragraph({
                children: [
                  new ImageRun({
                    data: resolved.uint8Array,
                    transformation: {
                      width: dims.width,
                      height: dims.height
                    },
                    altText: {
                      title: 'Video Screenshot',
                      description: figcaption?.textContent || 'Screenshot',
                      name: 'Screenshot'
                    }
                  })
                ],
                alignment: AlignmentType.CENTER,
                spacing: { before: 160, after: 60 }
              })
            );
          } else {
            // Unresolved or broken image fallback message
            docElements.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: `[⚠️ Image: ${src?.slice(0, 60) || 'Unavailable'} could not be loaded]`,
                    italics: true,
                    color: 'DC2626'
                  })
                ],
                alignment: AlignmentType.CENTER
              })
            );
          }
        }

        // Add caption if present
        const captionText = figcaption?.textContent?.trim();
        if (captionText) {
          const captionRuns = [
            new TextRun({
              text: `📷 ${captionText}`,
              italics: true,
              size: 19, // 9.5pt
              color: '64748B'
            })
          ];

          if (tsAttr && videoUrl) {
            const seekUrl = `${videoUrl}${videoUrl.includes('?') ? '&' : '?'}t=${tsAttr}s`;
            captionRuns.push(
              new TextRun({ text: '  •  ', color: '94A3B8' }),
              new ExternalHyperlink({
                children: [
                  new TextRun({
                    text: `[Jump to ${formatSeconds(parseFloat(tsAttr))}]`,
                    style: 'Hyperlink'
                  })
                ],
                link: seekUrl
              })
            );
          }

          docElements.push(
            new Paragraph({
              children: captionRuns,
              alignment: AlignmentType.CENTER,
              spacing: { before: 40, after: 160 }
            })
          );
        }
        return;
      }

      // Standalone Image
      if (tag === 'IMG') {
        const src = node.getAttribute('src');
        const resolved = resolvedImagesMap.get(src) || { ok: false };

        if (resolved.ok && resolved.uint8Array && resolved.uint8Array.length > 0) {
          const dims = calculateFittedDimensions(resolved.naturalWidth, resolved.naturalHeight, 560, 680);
          docElements.push(
            new Paragraph({
              children: [
                new ImageRun({
                  data: resolved.uint8Array,
                  transformation: {
                    width: dims.width,
                    height: dims.height
                  }
                })
              ],
              alignment: AlignmentType.CENTER,
              spacing: { before: 140, after: 140 }
            })
          );
        }
        return;
      }

      // Lists (Unordered, Ordered, Task Lists)
      if (tag === 'UL' || tag === 'OL') {
        const isOrdered = tag === 'OL';
        const isTaskList = node.classList.contains('focustube-task-list');
        let itemIndex = 1;

        Array.from(node.children).forEach(child => {
          if (child.tagName.toUpperCase() === 'LI') {
            if (isTaskList || child.classList.contains('focustube-task-item')) {
              // Task item
              const checkbox = child.querySelector('input[type="checkbox"]');
              const isChecked = Boolean(checkbox?.checked || checkbox?.hasAttribute('checked') || child.classList.contains('checked'));
              const checkSymbol = isChecked ? '☑  ' : '☐  ';
              const textEl = child.querySelector('.focustube-task-text') || child;

              // Filter out the raw input element before extracting runs
              const clone = textEl.cloneNode(true);
              clone.querySelectorAll('input').forEach(i => i.remove());
              const runs = extractInlineRuns(clone, isChecked ? { strike: true } : {});

              docElements.push(
                new Paragraph({
                  children: [
                    new TextRun({
                      text: checkSymbol,
                      bold: true,
                      color: isChecked ? '16A34A' : '64748B',
                      font: 'Consolas'
                    }),
                    ...runs
                  ],
                  indent: { left: 400 * (listContext.level + 1) },
                  spacing: { before: 40, after: 40 }
                })
              );
            } else if (isOrdered) {
              const runs = extractInlineRuns(child);
              docElements.push(
                new Paragraph({
                  children: [
                    new TextRun({ text: `${itemIndex}.  `, bold: true, color: '475569' }),
                    ...runs
                  ],
                  indent: { left: 400 * (listContext.level + 1) },
                  spacing: { before: 40, after: 40 }
                })
              );
              itemIndex++;
            } else {
              // Standard unordered bullet
              const runs = extractInlineRuns(child);
              docElements.push(
                new Paragraph({
                  children: [
                    new TextRun({ text: '•  ', bold: true, color: '6366F1' }),
                    ...runs
                  ],
                  indent: { left: 400 * (listContext.level + 1) },
                  spacing: { before: 40, after: 40 }
                })
              );
            }

            // Check for nested lists inside LI
            const nestedList = child.querySelector('ul, ol');
            if (nestedList) {
              processBlockNode(nestedList, {
                type: nestedList.tagName.toUpperCase(),
                index: 0,
                level: listContext.level + 1
              });
            }
          }
        });
        return;
      }

      // Horizontal Rule
      if (tag === 'HR') {
        docElements.push(
          new Paragraph({
            border: {
              bottom: {
                color: 'E2E8F0',
                size: 6,
                value: BorderStyle.SINGLE
              }
            },
            spacing: { before: 140, after: 140 }
          })
        );
        return;
      }

      // Regular Paragraph or Div
      if (tag === 'P' || tag === 'DIV') {
        // If it contains nested blocks (like figure, ul, ol), process children individually
        const hasBlockChildren = Boolean(node.querySelector('p, div, figure, ul, ol, blockquote, pre, h1, h2, h3'));
        if (hasBlockChildren) {
          Array.from(node.childNodes).forEach(c => processBlockNode(c, listContext));
          return;
        }

        const runs = extractInlineRuns(node);
        if (runs.length > 0) {
          docElements.push(
            new Paragraph({
              children: runs,
              spacing: { before: 60, after: 60 }
            })
          );
        }
        return;
      }

      // Fallback: extract inline runs
      const runs = extractInlineRuns(node);
      if (runs.length > 0) {
        docElements.push(
          new Paragraph({
            children: runs,
            spacing: { before: 60, after: 60 }
          })
        );
      }
    }

    Array.from(body.childNodes).forEach(node => processBlockNode(node));

    return docElements;
  }

  // ==========================================================
  // Export as Microsoft Word DOCX
  // ==========================================================
  async function exportNotesToDocx(documentData, options = {}) {
    let docxLib = null;
    if (typeof window !== 'undefined' && window.docx) {
      docxLib = window.docx;
    } else if (typeof global !== 'undefined' && global.docx) {
      docxLib = global.docx;
    } else if (typeof require === 'function') {
      try {
        docxLib = require('docx');
      } catch (e) {}
    }

    if (!docxLib) {
      throw new Error('Word (.docx) export library is not loaded');
    }

    const {
      Document,
      Packer,
      Paragraph,
      TextRun,
      HeadingLevel,
      ExternalHyperlink,
      BorderStyle,
      AlignmentType
    } = docxLib;

    const {
      title = 'FocusTube Study Notes',
      topic = 'General Study',
      videoUrl = '',
      date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
      notes = []
    } = documentData;

    // 1. Resolve all images across all notes
    const resolvedImagesMap = new Map();
    for (const note of notes) {
      if (note.text && typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(note.text, 'text/html');
        const imgs = Array.from(doc.querySelectorAll('img'));
        for (const img of imgs) {
          const src = img.getAttribute('src');
          if (src && !resolvedImagesMap.has(src)) {
            const res = await resolveImageSource(src);
            resolvedImagesMap.set(src, res);
          }
        }
      }
    }

    // 2. Build Document Section Elements
    const sectionChildren = [];

    // Document Title
    sectionChildren.push(
      new Paragraph({
        text: `FocusTube Study Notes: ${title}`,
        heading: HeadingLevel.TITLE,
        spacing: { before: 100, after: 120 }
      })
    );

    // Metadata Block
    const metaRuns = [
      new TextRun({ text: '🎯 Active Topic: ', bold: true, color: '1E293B' }),
      new TextRun({ text: `${topic}\n`, color: '334155' }),
      new TextRun({ text: '📅 Export Date: ', bold: true, color: '1E293B' }),
      new TextRun({ text: `${date}\n`, color: '334155' }),
      new TextRun({ text: '⏱️ Total Notes: ', bold: true, color: '1E293B' }),
      new TextRun({ text: `${notes.length}\n`, color: '334155' }),
    ];

    if (videoUrl) {
      metaRuns.push(
        new TextRun({ text: '🔗 Video Link: ', bold: true, color: '1E293B' }),
        new ExternalHyperlink({
          children: [
            new TextRun({
              text: videoUrl,
              style: 'Hyperlink'
            })
          ],
          link: videoUrl
        })
      );
    }

    sectionChildren.push(
      new Paragraph({
        children: metaRuns,
        spacing: { before: 80, after: 160 },
        border: {
          bottom: {
            color: 'CBD5E1',
            size: 12, // 1.5pt
            value: BorderStyle.SINGLE
          }
        }
      })
    );

    // Notes List
    if (!notes || notes.length === 0) {
      sectionChildren.push(
        new Paragraph({
          children: [
            new TextRun({
              text: 'No notes recorded for this video.',
              italics: true,
              color: '94A3B8'
            })
          ],
          spacing: { before: 200 }
        })
      );
    } else {
      notes.forEach((note, idx) => {
        const formattedTime = formatSeconds(note.seconds);
        const noteUrl = videoUrl ? `${videoUrl}${videoUrl.includes('?') ? '&' : '?'}t=${note.seconds}s` : '#';

        // Note Timestamp Header
        const headerRuns = [
          new TextRun({ text: `Note #${idx + 1} — `, bold: true, size: 24, color: '1E293B' }),
          new ExternalHyperlink({
            children: [
              new TextRun({
                text: `[▶ ${formattedTime}]`,
                bold: true,
                size: 24,
                color: '4338CA',
                style: 'Hyperlink'
              })
            ],
            link: noteUrl
          })
        ];

        if (note.isDraft) {
          headerRuns.push(
            new TextRun({
              text: '  (Current Draft - Unsaved)',
              italics: true,
              size: 20,
              color: 'B45309'
            })
          );
        }

        sectionChildren.push(
          new Paragraph({
            children: headerRuns,
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 280, after: 100 }
          })
        );

        // Convert note's rich HTML to DOCX paragraphs
        const noteElements = htmlToDocxElements(note.text, docxLib, resolvedImagesMap, videoUrl);
        if (noteElements.length === 0) {
          sectionChildren.push(
            new Paragraph({
              children: [
                new TextRun({ text: '(Empty note content)', italics: true, color: '94A3B8' })
              ]
            })
          );
        } else {
          sectionChildren.push(...noteElements);
        }

        // Divider between notes (except after last note)
        if (idx < notes.length - 1) {
          sectionChildren.push(
            new Paragraph({
              border: {
                bottom: {
                  color: 'E2E8F0',
                  size: 6,
                  value: BorderStyle.SINGLE
                }
              },
              spacing: { before: 180, after: 100 }
            })
          );
        }
      });
    }

    // Document Footer Note
    sectionChildren.push(
      new Paragraph({
        children: [
          new TextRun({
            text: '— Generated with FocusTube Study & Distraction Blocker —',
            italics: true,
            size: 18,
            color: '94A3B8'
          })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { before: 360 }
      })
    );

    // 3. Assemble DOCX Document with Standard Page Margins (1 inch / 1440 twips)
    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: 1440,
                right: 1440,
                bottom: 1440,
                left: 1440
              }
            }
          },
          children: sectionChildren
        }
      ]
    });

    const filename = options.filename || `${sanitizeFilename(documentData.title || 'FocusTube_Notes')}.docx`;

    // 4. Generate Blob / Buffer and trigger download
    let blob = null;
    let buffer = null;

    if (options.returnBuffer || typeof window === 'undefined') {
      buffer = await Packer.toBuffer(doc);
    } else {
      blob = await Packer.toBlob(doc);
      if (typeof Buffer !== 'undefined') {
        const arrayBuf = await blob.arrayBuffer();
        buffer = Buffer.from(arrayBuf);
      }
    }

    if (!options.skipDownload && typeof window !== 'undefined' && typeof window.document !== 'undefined') {
      try {
        triggerDownload(blob || buffer, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      } catch (e) {
        // Catch mocked DOM navigation errors in test environments
      }
    }

    return {
      success: true,
      filename,
      blob,
      buffer,
      noteCount: notes.length
    };
  }

  // ==========================================================
  // Public Export API
  // ==========================================================
  const FocusTubeExport = {
    sanitizeFilename,
    formatSeconds,
    calculateFittedDimensions,
    dataUrlToUint8Array,
    resolveImageSource,
    resolveAllImagesInHtml,
    buildExportHtml,
    htmlToDocxElements,
    exportNotesToPdf,
    exportNotesToDocx
  };

  // Expose to window / globalThis / module.exports
  if (typeof window !== 'undefined') {
    window.FocusTubeExport = FocusTubeExport;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.FocusTubeExport = FocusTubeExport;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FocusTubeExport;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
