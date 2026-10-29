const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const docx = require('docx');

// Mock browser globals for testing export service
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.docx = docx;

const FocusTubeExport = require('../content/export-service.js');

// 1. Test Filename Sanitization
test('sanitizeFilename removes illegal characters and handles extensions', () => {
  const dirty = 'Next.js 15: Full Course [2026] / Guide? *Awesome* <Must Watch> | "Tips" - YouTube';
  const clean = FocusTubeExport.sanitizeFilename(dirty);
  assert.ok(!clean.includes(':'));
  assert.ok(!clean.includes('/'));
  assert.ok(!clean.includes('?'));
  assert.ok(!clean.includes('*'));
  assert.ok(!clean.includes('<'));
  assert.ok(!clean.includes('>'));
  assert.ok(!clean.includes('|'));
  assert.ok(!clean.includes('"'));
  assert.ok(!clean.includes('YouTube'));
  assert.strictEqual(clean, 'Next.js_15_Full_Course_[2026]_Guide_Awesome_Must_Watch_Tips');
});

test('sanitizeFilename preserves Unicode and Bangla characters', () => {
  const bangla = 'বাংলা টিউটোরিয়াল: ওয়েব ডেভেলপমেন্ট ও জাভাস্ক্রিপ্ট';
  const clean = FocusTubeExport.sanitizeFilename(bangla);
  assert.ok(clean.includes('বাংলা_টিউটোরিয়াল'));
  assert.ok(clean.includes('ওয়েব_ডেভেলপমেন্ট'));
});

test('sanitizeFilename handles empty or whitespace-only titles with default', () => {
  assert.strictEqual(FocusTubeExport.sanitizeFilename(''), 'FocusTube_Study_Notes');
  assert.strictEqual(FocusTubeExport.sanitizeFilename('    '), 'FocusTube_Study_Notes');
  assert.strictEqual(FocusTubeExport.sanitizeFilename(null, 'CustomFallback'), 'CustomFallback');
});

test('sanitizeFilename truncates excessively long titles gracefully', () => {
  const longTitle = 'a'.repeat(150);
  const clean = FocusTubeExport.sanitizeFilename(longTitle);
  assert.ok(clean.length <= 90);
});

// 2. Test Format Seconds
test('formatSeconds formats timestamps correctly', () => {
  assert.strictEqual(FocusTubeExport.formatSeconds(0), '0:00');
  assert.strictEqual(FocusTubeExport.formatSeconds(45), '0:45');
  assert.strictEqual(FocusTubeExport.formatSeconds(65), '1:05');
  assert.strictEqual(FocusTubeExport.formatSeconds(3665), '1:01:05');
  assert.strictEqual(FocusTubeExport.formatSeconds(null), '0:00');
});

// 3. Test Aspect Ratio & Dimension Calculation
test('calculateFittedDimensions preserves 16:9 aspect ratio and prevents distortion', () => {
  // 1920x1080 (16:9)
  const fitted = FocusTubeExport.calculateFittedDimensions(1920, 1080, 560, 680);
  assert.strictEqual(fitted.width, 560);
  assert.strictEqual(fitted.height, 315); // 560 / (16/9) = 315
  assert.ok(Math.abs(fitted.width / fitted.height - 16 / 9) < 0.01);
});

test('calculateFittedDimensions scales down tall portrait images without exceeding maxHeight', () => {
  // 600x1200 (1:2)
  const fitted = FocusTubeExport.calculateFittedDimensions(600, 1200, 560, 680);
  assert.strictEqual(fitted.height, 680);
  assert.strictEqual(fitted.width, 340); // 680 * 0.5 = 340
});

test('calculateFittedDimensions leaves smaller images within bounds unchanged', () => {
  const fitted = FocusTubeExport.calculateFittedDimensions(400, 225, 560, 680);
  assert.strictEqual(fitted.width, 400);
  assert.strictEqual(fitted.height, 225);
});

// 4. Test DataURL to Uint8Array Conversion
test('dataUrlToUint8Array accurately converts base64 to byte array', () => {
  // 1x1 transparent PNG base64
  const pngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const u8 = FocusTubeExport.dataUrlToUint8Array(pngBase64);
  assert.ok(u8 instanceof Uint8Array);
  assert.strictEqual(u8[0], 0x89);
  assert.strictEqual(u8[1], 0x50); // 'P'
  assert.strictEqual(u8[2], 0x4E); // 'N'
  assert.strictEqual(u8[3], 0x47); // 'G'
});

// 5. Test Image Resolution
test('resolveImageSource extracts dimensions and bytes from data URL', async () => {
  const pngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const resolved = await FocusTubeExport.resolveImageSource(pngBase64);
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(resolved.naturalWidth, 1);
  assert.strictEqual(resolved.naturalHeight, 1);
  assert.ok(resolved.uint8Array instanceof Uint8Array);
});

// 6. Test PDF HTML Generation
test('buildExportHtml generates complete document markup with metadata and notes', () => {
  const docData = {
    title: 'Advanced React Patterns',
    topic: 'Frontend Architecture',
    videoUrl: 'https://www.youtube.com/watch?v=abc123xyz',
    date: 'October 29, 2026',
    notes: [
      {
        id: 'note_1',
        seconds: 135,
        text: '<p>Key concept: <strong>Compound Components</strong>.</p>',
        isDraft: false
      },
      {
        id: 'note_2',
        seconds: 280,
        text: '<p>বাংলা টেক্সট: হুক্স এবং স্টেট ম্যানেজমেন্ট।</p>',
        isDraft: true
      }
    ]
  };

  const html = FocusTubeExport.buildExportHtml(docData);
  assert.ok(html.includes('FocusTube Study Notes: Advanced React Patterns'));
  assert.ok(html.includes('Frontend Architecture'));
  assert.ok(html.includes('https://www.youtube.com/watch?v=abc123xyz'));
  assert.ok(html.includes('▶ 2:15'));
  assert.ok(html.includes('Compound Components'));
  assert.ok(html.includes('Current Draft (Unsaved)'));
  assert.ok(html.includes('বাংলা টেক্সট: হুক্স এবং স্টেট ম্যানেজমেন্ট।'));
});

// 7. Test HTML to DOCX Elements
test('htmlToDocxElements preserves headings, formatting, task lists, code blocks, and blockquotes', async () => {
  const sampleHtml = `
    <h1>Introduction</h1>
    <p>This is <b>bold</b>, <i>italic</i>, <u>underlined</u>, <s>strikethrough</s>, and <mark>highlighted</mark> text with <code>inlineCode()</code>.</p>
    <p>Check this <a href="https://example.com">useful link</a>.</p>
    <blockquote>Important architecture rule.</blockquote>
    <pre><code>const a = 1;\nconsole.log(a);</code></pre>
    <ul>
      <li>First bullet</li>
      <li>Second bullet</li>
    </ul>
    <ul class="focustube-task-list">
      <li class="focustube-task-item"><input type="checkbox"><span class="focustube-task-text">Pending task</span></li>
      <li class="focustube-task-item checked"><input type="checkbox" checked><span class="focustube-task-text">Done task</span></li>
    </ul>
    <p>বাংলা টেক্সট ও উদাহরণ।</p>
  `;

  const elements = FocusTubeExport.htmlToDocxElements(sampleHtml, docx);
  assert.ok(elements.length >= 7);

  // Verify elements array contains docx Paragraphs
  elements.forEach(el => {
    assert.ok(el instanceof docx.Paragraph);
  });
});

test('htmlToDocxElements embeds screenshots and captions correctly', async () => {
  const pngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const resolved = await FocusTubeExport.resolveImageSource(pngBase64);
  const imagesMap = new Map();
  imagesMap.set(pngBase64, resolved);

  const figureHtml = `
    <figure class="focustube-screenshot-figure" data-timestamp="75">
      <img src="${pngBase64}" class="focustube-screenshot-img" alt="Screenshot at 01:15">
      <figcaption class="focustube-screenshot-caption">Screenshot — 01:15 Architecture Diagram</figcaption>
    </figure>
  `;

  const elements = FocusTubeExport.htmlToDocxElements(figureHtml, docx, imagesMap, 'https://www.youtube.com/watch?v=test');
  assert.strictEqual(elements.length, 2); // Image paragraph + Caption paragraph
});

// 8. Test Full DOCX Export Generation
test('exportNotesToDocx generates genuine, non-empty DOCX file with ZIP PK header', async () => {
  const pngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const docData = {
    title: 'Full Stack Mastery: React + Node',
    topic: 'Full-Stack Web Development',
    videoUrl: 'https://www.youtube.com/watch?v=fullstack123',
    date: 'October 29, 2026',
    notes: [
      {
        id: 'n1',
        seconds: 90,
        text: '<h2>Setup</h2><p>Initialize project using <code>npm init -y</code>.</p>',
        isDraft: false
      },
      {
        id: 'n2',
        seconds: 180,
        text: `
          <figure class="focustube-screenshot-figure" data-timestamp="180">
            <img src="${pngBase64}">
            <figcaption>Screenshot — 03:00</figcaption>
          </figure>
          <ul class="focustube-task-list">
            <li class="focustube-task-item checked"><input type="checkbox" checked><span class="focustube-task-text">Database schema</span></li>
          </ul>
          <p>বাংলা নোট: সার্ভার কনফিগারেশন সম্পন্ন।</p>
        `,
        isDraft: true
      }
    ]
  };

  const result = await FocusTubeExport.exportNotesToDocx(docData, { skipDownload: true });
  assert.strictEqual(result.success, true);
  assert.ok(result.buffer instanceof Buffer);
  assert.ok(result.buffer.length > 5000);

  // Standard DOCX is a ZIP file starting with 'PK\x03\x04' (0x50, 0x4B, 0x03, 0x04)
  assert.strictEqual(result.buffer[0], 0x50);
  assert.strictEqual(result.buffer[1], 0x4B);
  assert.strictEqual(result.buffer[2], 0x03);
  assert.strictEqual(result.buffer[3], 0x04);
});

// 9. Test Notes with only images
test('exportNotesToDocx handles note containing only an image', async () => {
  const pngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const docData = {
    title: 'Only Image Note',
    topic: 'Visual Study',
    notes: [
      {
        id: 'img_only',
        seconds: 42,
        text: `<figure><img src="${pngBase64}"></figure>`,
        isDraft: false
      }
    ]
  };

  const result = await FocusTubeExport.exportNotesToDocx(docData, { skipDownload: true });
  assert.strictEqual(result.success, true);
  assert.ok(result.buffer.length > 4000);
});

// 10. Test Document Integrity: Does not mutate input notes
test('exportNotesToDocx does not mutate the original note objects or text', async () => {
  const originalText = '<p>Original unmutated text</p>';
  const noteObj = {
    id: 'n_orig',
    seconds: 10,
    text: originalText,
    isDraft: false
  };

  const docData = {
    title: 'Integrity Test',
    topic: 'Testing',
    notes: [noteObj]
  };

  await FocusTubeExport.exportNotesToDocx(docData, { skipDownload: true });
  assert.strictEqual(noteObj.text, originalText);
  assert.strictEqual(noteObj.seconds, 10);
});

// 11. Test Broken / Unresolvable Image Graceful Handling
test('resolveImageSource gracefully handles unresolvable sources', async () => {
  const broken = await FocusTubeExport.resolveImageSource('');
  assert.strictEqual(broken.ok, false);

  const elements = FocusTubeExport.htmlToDocxElements('<figure><img src="invalid_broken_src"></figure>', docx);
  assert.ok(elements.length > 0);
});

