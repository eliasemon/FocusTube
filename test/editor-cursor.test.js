const test = require('node:test');
const assert = require('node:assert');

// Mock a lightweight DOM node environment for testing schema insertion logic
class MockNode {
  constructor(tagName, text = '') {
    this.tagName = tagName ? tagName.toUpperCase() : null;
    this.nodeType = tagName ? 1 : 3;
    this.childNodes = [];
    this.parentNode = null;
    this.nextSibling = null;
    this.previousSibling = null;
    this.attributes = {};
    this.className = '';
    this.contentEditable = 'false';
    if (text) {
      this.textContent = text;
    }
  }

  get textContent() {
    if (this.nodeType === 3) return this._text || '';
    return this.childNodes.map(c => c.textContent).join('');
  }

  set textContent(val) {
    if (this.nodeType === 3) {
      this._text = val;
    } else {
      this.childNodes = [];
      if (val) {
        const textNode = new MockNode(null, val);
        this.appendChild(textNode);
      }
    }
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get nextElementSibling() {
    let cur = this.nextSibling;
    while (cur) {
      if (cur.nodeType === 1) return cur;
      cur = cur.nextSibling;
    }
    return null;
  }

  setAttribute(name, val) {
    this.attributes[name] = val;
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const prev = this.lastChild;
    this.childNodes.push(child);
    child.parentNode = this;
    child.previousSibling = prev;
    if (prev) prev.nextSibling = child;
    child.nextSibling = null;
    return child;
  }

  insertBefore(newChild, refChild) {
    if (!refChild) return this.appendChild(newChild);
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    const index = this.childNodes.indexOf(refChild);
    if (index === -1) return this.appendChild(newChild);

    const prev = refChild.previousSibling;
    this.childNodes.splice(index, 0, newChild);
    newChild.parentNode = this;
    newChild.nextSibling = refChild;
    newChild.previousSibling = prev;
    if (prev) prev.nextSibling = newChild;
    refChild.previousSibling = newChild;
    return newChild;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index === -1) return child;
    const prev = child.previousSibling;
    const next = child.nextSibling;
    if (prev) prev.nextSibling = next;
    if (next) next.previousSibling = prev;
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    child.nextSibling = null;
    child.previousSibling = null;
    return child;
  }

  replaceChild(newChild, oldChild) {
    this.insertBefore(newChild, oldChild);
    this.removeChild(oldChild);
    return oldChild;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  closest(selector) {
    const tag = selector.toUpperCase();
    let cur = this;
    while (cur) {
      if (cur.tagName === tag) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
}

// Simulated insertion function based on our implementation in content.js
function simulateScreenshotInsertion(editor, blockAtCursor, dataUrl, currentSec, formattedTime) {
  const figure = new MockNode('FIGURE');
  figure.className = 'focustube-screenshot-figure';
  figure.setAttribute('data-timestamp', currentSec);

  const img = new MockNode('IMG');
  img.setAttribute('src', dataUrl);
  img.setAttribute('alt', `Screenshot at ${formattedTime}`);

  const figcaption = new MockNode('FIGCAPTION', `Screenshot — ${formattedTime}`);
  figure.appendChild(img);
  figure.appendChild(figcaption);

  const trailingP = new MockNode('P');

  if (!blockAtCursor || (editor.textContent.trim() === '' && editor.childNodes.length === 0)) {
    // Empty editor: insert as first content block
    editor.childNodes = [];
    editor.appendChild(figure);
    editor.appendChild(trailingP);
  } else {
    // Inside a list: move figure after the list to preserve list integrity
    if (blockAtCursor.tagName === 'LI') {
      const parentList = blockAtCursor.closest('OL') || blockAtCursor.closest('UL') || blockAtCursor;
      parentList.parentNode.insertBefore(figure, parentList.nextSibling);
      parentList.parentNode.insertBefore(trailingP, figure.nextSibling);
    } else if (blockAtCursor.tagName === 'PRE') {
      blockAtCursor.parentNode.insertBefore(figure, blockAtCursor.nextSibling);
      blockAtCursor.parentNode.insertBefore(trailingP, figure.nextSibling);
    } else {
      // Normal paragraph / div: insert after block
      blockAtCursor.parentNode.insertBefore(figure, blockAtCursor.nextSibling);
      blockAtCursor.parentNode.insertBefore(trailingP, figure.nextSibling);
    }
  }

  return { figure, trailingP };
}

test('Screenshot insertion in empty editor inserts figure and trailing paragraph', () => {
  const editor = new MockNode('DIV');
  simulateScreenshotInsertion(editor, null, 'data:image/jpeg;base64,123', 45, '00:45');
  assert.strictEqual(editor.childNodes.length, 2);
  assert.strictEqual(editor.childNodes[0].tagName, 'FIGURE');
  assert.strictEqual(editor.childNodes[1].tagName, 'P');
  assert.strictEqual(editor.childNodes[0].getAttribute('data-timestamp'), 45);
});

test('Screenshot insertion between paragraphs preserves order', () => {
  const editor = new MockNode('DIV');
  const p1 = new MockNode('P', 'First paragraph');
  const p2 = new MockNode('P', 'Second paragraph');
  editor.appendChild(p1);
  editor.appendChild(p2);

  // Cursor is at p1
  simulateScreenshotInsertion(editor, p1, 'data:image/jpeg;base64,123', 90, '01:30');

  assert.strictEqual(editor.childNodes[0], p1);
  assert.strictEqual(editor.childNodes[1].tagName, 'FIGURE');
  assert.strictEqual(editor.childNodes[2].tagName, 'P');
  assert.strictEqual(editor.childNodes[3], p2);
});

test('Screenshot insertion inside a list places image cleanly after the list', () => {
  const editor = new MockNode('DIV');
  const ol = new MockNode('OL');
  const li1 = new MockNode('LI', 'Item 1');
  const li2 = new MockNode('LI', 'Item 2');
  ol.appendChild(li1);
  ol.appendChild(li2);
  editor.appendChild(ol);

  // Cursor is in li1
  simulateScreenshotInsertion(editor, li1, 'data:image/jpeg;base64,123', 120, '02:00');

  assert.strictEqual(editor.childNodes[0], ol);
  assert.strictEqual(editor.childNodes[1].tagName, 'FIGURE');
  assert.strictEqual(editor.childNodes[2].tagName, 'P');
  assert.strictEqual(ol.childNodes.length, 2); // list items preserved!
});
