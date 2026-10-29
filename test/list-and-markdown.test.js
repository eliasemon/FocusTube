const test = require('node:test');
const assert = require('node:assert');

// 1. Test Marker Detection Regex
const LIST_MARKER_REGEX = /^(\s*)(?:(\d+)\.|([-*+])|\[([ xX]?)\])$/;

test('List marker regex detects ordered lists', () => {
  assert.ok(LIST_MARKER_REGEX.test('1.'));
  assert.ok(LIST_MARKER_REGEX.test('2.'));
  assert.ok(LIST_MARKER_REGEX.test('  3.'));
  const m = '1.'.match(LIST_MARKER_REGEX);
  assert.strictEqual(m[2], '1');
});

test('List marker regex detects unordered lists', () => {
  assert.ok(LIST_MARKER_REGEX.test('-'));
  assert.ok(LIST_MARKER_REGEX.test('*'));
  assert.ok(LIST_MARKER_REGEX.test('+'));
  assert.ok(LIST_MARKER_REGEX.test('  -'));
  const m = '-'.match(LIST_MARKER_REGEX);
  assert.strictEqual(m[3], '-');
});

test('List marker regex detects task lists', () => {
  assert.ok(LIST_MARKER_REGEX.test('[ ]'));
  assert.ok(LIST_MARKER_REGEX.test('[x]'));
  assert.ok(LIST_MARKER_REGEX.test('[X]'));
  assert.ok(LIST_MARKER_REGEX.test('[]'));
  const m = '[ ]'.match(LIST_MARKER_REGEX);
  assert.strictEqual(m[4], ' ');
  const m2 = '[x]'.match(LIST_MARKER_REGEX);
  assert.strictEqual(m2[4], 'x');
});

test('List marker regex ignores regular text', () => {
  assert.strictEqual(LIST_MARKER_REGEX.test('hello'), false);
  assert.strictEqual(LIST_MARKER_REGEX.test('1. hello'), false);
  assert.strictEqual(LIST_MARKER_REGEX.test('a. '), false);
});

// 2. Test Empty-Item List Handling Logic
function simulateListEnter({ items, currentIndex }) {
  // Returns action: 'continue_empty', 'clear_list', 'exit_to_p'
  const allEmpty = items.every(it => it.trim() === '');
  const isCurEmpty = items[currentIndex].trim() === '';

  if (!isCurEmpty) {
    return { action: 'insert_item' };
  }

  if (allEmpty) {
    // Case 1: Initially empty list
    // If items.length < 3, add another empty item (Enter 1 -> 2 items, Enter 2 -> 3 items)
    // If items.length >= 3, 3rd Enter while 3rd item is empty -> clear list
    if (items.length < 3) {
      return { action: 'continue_empty', newCount: items.length + 1 };
    } else {
      return { action: 'clear_list' };
    }
  } else {
    // Cases 2 & 3: List already contains meaningful text
    // Never clear the list! Exit list at the empty item to paragraph
    return { action: 'exit_to_p' };
  }
}

test('Case 1: Three consecutive empty items at start of list sequence', () => {
  // Step 1: User creates list: '1. ' (1 item, empty)
  let items = [''];
  let res1 = simulateListEnter({ items, currentIndex: 0 });
  assert.strictEqual(res1.action, 'continue_empty');
  assert.strictEqual(res1.newCount, 2);

  // Step 2: Now list has 2 items: '1. ', '2. '
  items = ['', ''];
  let res2 = simulateListEnter({ items, currentIndex: 1 });
  assert.strictEqual(res2.action, 'continue_empty');
  assert.strictEqual(res2.newCount, 3);

  // Step 3: Now list has 3 items: '1. ', '2. ', '3. '
  items = ['', '', ''];
  let res3 = simulateListEnter({ items, currentIndex: 2 });
  assert.strictEqual(res3.action, 'clear_list');
});

test('Case 2 & 3: List with content is NEVER cleared', () => {
  // List with 1st item non-empty: ['First item', '']
  let items = ['First item', ''];
  let res = simulateListEnter({ items, currentIndex: 1 });
  assert.strictEqual(res.action, 'exit_to_p');

  // List with multiple items: ['Introduction', 'Details', '']
  items = ['Introduction', 'Details', ''];
  let res2 = simulateListEnter({ items, currentIndex: 2 });
  assert.strictEqual(res2.action, 'exit_to_p');
});

test('Case 4: Typing content resets empty list clearing', () => {
  // User created empty 1, empty 2, then in item 2 typed 'Apple'
  let items = ['', 'Apple'];
  // User pressed Enter at end of 'Apple': creates item 3
  let res = simulateListEnter({ items, currentIndex: 1 });
  assert.strictEqual(res.action, 'insert_item');

  // Now list has ['', 'Apple', '']
  items = ['', 'Apple', ''];
  // User is on empty item 3: pressing Enter exits to paragraph, does NOT clear list!
  let res2 = simulateListEnter({ items, currentIndex: 2 });
  assert.strictEqual(res2.action, 'exit_to_p');
});

// 3. Test HTML to Markdown conversion
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
  return str.replace(/\n{3,}/g, '\n\n').trim();
}

test('htmlToMarkdown converts screenshots with captions', () => {
  const html = '<figure class="focustube-screenshot-figure" data-timestamp="272"><img src="data:image/jpeg;base64,abc" class="focustube-screenshot-img"><figcaption class="focustube-screenshot-caption">Screenshot — 04:32</figcaption></figure>';
  const md = htmlToMarkdown(html);
  assert.ok(md.includes('![Screenshot — 04:32](data:image/jpeg;base64,abc)'));
  assert.ok(md.includes('*Screenshot — 04:32*'));
});

test('htmlToMarkdown converts task lists', () => {
  const html = '<ul class="focustube-task-list"><li class="focustube-task-item"><input type="checkbox" class="focustube-task-checkbox"><span class="focustube-task-text">Task One</span></li><li class="focustube-task-item checked"><input type="checkbox" checked class="focustube-task-checkbox"><span class="focustube-task-text">Task Two</span></li></ul>';
  const md = htmlToMarkdown(html);
  assert.ok(md.includes('- [ ] Task One'));
  assert.ok(md.includes('- [x] Task Two'));
});

test('htmlToMarkdown converts code blocks and blockquotes', () => {
  const html = '<pre><code>const x = 10;</code></pre><blockquote>Important note</blockquote>';
  const md = htmlToMarkdown(html);
  assert.ok(md.includes('```\nconst x = 10;\n```'));
  assert.ok(md.includes('> Important note'));
});
