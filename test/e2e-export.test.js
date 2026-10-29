const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const docx = require('docx');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.docx = docx;

const FocusTubeExport = require('../content/export-service.js');

test('E2E: Realistic note with rich-text, Bangla, code, tasks, and screenshots exports to DOCX', async () => {
  // Realistic 16:9 screenshot sample (base64 PNG)
  const screenshotBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAYAAAA6UIehAAAAQElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const notes = [
    {
      id: 'note_1',
      seconds: 45,
      text: `
        <h1>React Server Components Architecture</h1>
        <p>In this lesson, we explore how <b>Server Components</b> reduce bundle size and run on the server.</p>
        <p>Special notes in Bangla: <i>বাংলা নোট - এটি সার্ভার সাইড রেন্ডারিং এবং পারফরম্যান্স উন্নত করে।</i></p>
        <blockquote>"Always separate data-fetching components from interactive client leaves."</blockquote>
      `,
      isDraft: false
    },
    {
      id: 'note_2',
      seconds: 125,
      text: `
        <h2>Implementation Code</h2>
        <pre><code>async function CoursePage({ params }) {
  const data = await getCourse(params.id);
  return &lt;CourseView course={data} /&gt;;
}</code></pre>
        <p>More details on <a href="https://nextjs.org/docs">Next.js Documentation</a>.</p>
        <figure class="focustube-screenshot-figure" data-timestamp="125">
          <img src="${screenshotBase64}" class="focustube-screenshot-img" alt="Component Hierarchy">
          <figcaption class="focustube-screenshot-caption">Screenshot — 02:05 Component Hierarchy Diagram</figcaption>
        </figure>
      `,
      isDraft: false
    },
    {
      id: 'note_3',
      seconds: 320,
      text: `
        <h3>Deployment Checklist</h3>
        <ul class="focustube-task-list">
          <li class="focustube-task-item checked"><input type="checkbox" checked><span class="focustube-task-text">Environment variables configured</span></li>
          <li class="focustube-task-item"><input type="checkbox"><span class="focustube-task-text">Database migrations applied</span></li>
        </ul>
        <ol>
          <li>Build with npm run build</li>
          <li>Run tests</li>
        </ol>
      `,
      isDraft: true
    }
  ];

  const docData = {
    title: 'Next.js 15 Full Course: Production Grade App',
    topic: 'Full-Stack Development',
    videoUrl: 'https://www.youtube.com/watch?v=mockNext15Id',
    date: 'October 29, 2026',
    notes
  };

  // 1. Export to DOCX
  const docxResult = await FocusTubeExport.exportNotesToDocx(docData, { skipDownload: true });
  assert.strictEqual(docxResult.success, true);
  assert.strictEqual(docxResult.noteCount, 3);
  assert.ok(docxResult.filename.includes('Next.js_15_Full_Course_Production_Grade_App.docx'));
  assert.ok(docxResult.buffer.length > 5000);

  // Validate ZIP PK header of DOCX
  assert.strictEqual(docxResult.buffer[0], 0x50); // P
  assert.strictEqual(docxResult.buffer[1], 0x4B); // K

  // 2. Validate PDF export HTML generation
  const pdfHtml = FocusTubeExport.buildExportHtml(docData);
  assert.ok(pdfHtml.includes('FocusTube Study Notes: Next.js 15 Full Course: Production Grade App'));
  assert.ok(pdfHtml.includes('Full-Stack Development'));
  assert.ok(pdfHtml.includes('React Server Components Architecture'));
  assert.ok(pdfHtml.includes('বাংলা নোট - এটি সার্ভার সাইড রেন্ডারিং এবং পারফরম্যান্স উন্নত করে।'));
  assert.ok(pdfHtml.includes('Screenshot — 02:05 Component Hierarchy Diagram'));
  assert.ok(pdfHtml.includes('Environment variables configured'));
  assert.ok(pdfHtml.includes('Database migrations applied'));
  assert.ok(pdfHtml.includes('Current Draft (Unsaved)'));
  assert.ok(pdfHtml.includes('https://www.youtube.com/watch?v=mockNext15Id'));
});

test('E2E: Handles note with only screenshot and no text gracefully', async () => {
  const screenshotBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAYAAAA6UIehAAAAQElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const docData = {
    title: 'Visual Architecture Capture',
    topic: 'System Design',
    videoUrl: 'https://www.youtube.com/watch?v=visualArch',
    notes: [
      {
        id: 'n_only_img',
        seconds: 80,
        text: `<figure class="focustube-screenshot-figure" data-timestamp="80"><img src="${screenshotBase64}"></figure>`,
        isDraft: false
      }
    ]
  };

  const res = await FocusTubeExport.exportNotesToDocx(docData, { skipDownload: true });
  assert.strictEqual(res.success, true);
  assert.ok(res.buffer.length > 4000);
});

test('Mode: Specific note export generates targeted document and custom filename', async () => {
  const specificNote = {
    id: 'note_target_99',
    seconds: 145, // 02:25
    text: `
      <h2>Specific Concept Note</h2>
      <p>This is a targeted takeaway regarding <b>Dynamic Programming</b>.</p>
      <p>Bengali notes: <i>ডাইনামিক প্রোগ্রামিং মেমোইজেশন ও অপটিমাইজেশন।</i></p>
    `,
    isDraft: false
  };

  const docData = {
    title: 'Algorithms Masterclass - Note [2:25]',
    topic: 'Computer Science',
    videoUrl: 'https://www.youtube.com/watch?v=algoMaster',
    date: 'October 29, 2026',
    notes: [specificNote]
  };

  const customFilename = 'Algorithms_Masterclass_Note_2-25.docx';
  const res = await FocusTubeExport.exportNotesToDocx(docData, {
    skipDownload: true,
    filename: customFilename
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.noteCount, 1);
  assert.strictEqual(res.filename, customFilename);
  assert.ok(res.buffer.length > 4000);
  assert.strictEqual(res.buffer[0], 0x50);
  assert.strictEqual(res.buffer[1], 0x4B);
});
