// ============================================================================
// Project YUKTI — Content Script (v1.3)
// Runs inside every webpage. Responsible for:
//   1. Detecting sensitive/PII fields and text on the page (for redaction)
//   2. Listing interactive elements (buttons, inputs, links, radios, checkboxes,
//      dropdowns) the agent can act on, tagged with a semantic category when
//      the label matches a known profile field (name/email/phone/project/etc.),
//      plus whether each field is REQUIRED and whether it's already FILLED.
//   3. Detecting product listings (title + price + rating) for shopping tasks
//   4. Executing agent-decided actions: click, type, press_enter, scroll, fill
//   5. Modal/dialog-aware element matching, so overlays (chat boxes, popups)
//      don't get confused with background page elements
//   6. v1.3: a hard, non-LLM safety guard — a click on a Submit/Next/Continue/
//      Send/Apply/Save/Done -style button is REFUSED if any required field on
//      the page is still empty. This is the fix for the agent submitting a
//      form (e.g. a Google Form) while fields are still blank: previously
//      that decision relied entirely on the model's judgement calls.
// ============================================================================

// ----------------------------------------------------------------------------
// PART 1: Sensitive field + PII detection (used for client-side redaction)
// ----------------------------------------------------------------------------
function detectSensitiveFields() {
  const sensitiveFields = [];

  const inputs = document.querySelectorAll('input, textarea');
  inputs.forEach((input) => {
    const type = (input.type || '').toLowerCase();
    const name = (input.name || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    const placeholder = (input.placeholder || '').toLowerCase();
    const combined = `${name} ${id} ${placeholder}`;

    let category = null;
    if (type === 'password') category = 'password';
    else if (type === 'email' || combined.includes('email')) category = 'email';
    else if (combined.includes('phone') || combined.includes('mobile') || type === 'tel') category = 'phone';
    else if (combined.includes('card') || combined.includes('cvv') || combined.includes('cvc')) category = 'card';
    else if (combined.includes('aadhar') || combined.includes('aadhaar') || combined.includes('ssn') || combined.includes('pan')) category = 'national_id';
    else if (combined.includes('otp') || combined.includes('pin')) category = 'otp';
    else if (combined.includes('address') && !combined.includes('email')) category = 'address';

    if (category) {
      const rect = input.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        sensitiveFields.push({
          category,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        });
      }
    }
  });

  const patterns = [
    { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
    { name: 'phone', regex: /(?<!\d)[6-9]\d{9}(?!\d)/g },
    { name: 'card_number', regex: /\b(?:\d[ -]?){13,16}\b/g },
    { name: 'aadhaar', regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g },
    { name: 'pan_card', regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  ];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    if (!text || !text.trim()) continue;

    patterns.forEach(({ name, regex }) => {
      const matches = [...text.matchAll(regex)];
      matches.forEach(match => {
        try {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rect = range.getBoundingClientRect();

          if (rect.width > 0 && rect.height > 0) {
            sensitiveFields.push({
              category: name,
              boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            });
          }
        } catch (e) { /* skip invalid ranges */ }
      });
    });
  }

  const avatarSelectors = 'img[class*="avatar" i], img[alt*="profile" i], img[class*="profile" i], img[class*="photo" i]';
  document.querySelectorAll(avatarSelectors).forEach((img) => {
    const rect = img.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      sensitiveFields.push({
        category: 'profile_image',
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      });
    }
  });

  return {
    sensitiveFields,
    pageWidth: window.innerWidth,
    pageHeight: window.innerHeight
  };
}

// ----------------------------------------------------------------------------
// PART 2: Semantic field categorization — maps a label to a known profile key
// (used for the resume-profile "fill" pipeline; NEVER sends actual values,
// only tells the caller which profile key this field probably corresponds to)
//
// This list covers both standard resume fields AND common extra fields that
// forms ask for but a resume wouldn't naturally contain (project, roll
// number, etc.) — these are filled from user-added custom profile fields.
//
// v1.3: added firstName/lastName so forms that split the name into two
// boxes (very common on Google Forms) still get filled correctly instead
// of being left blank because only a combined "name" value existed.
// ----------------------------------------------------------------------------
const PROFILE_FIELD_PATTERNS = [
  { key: 'firstName', patterns: ['first name', 'given name', /^first$/] },
  { key: 'lastName', patterns: ['last name', 'surname', 'family name', /^last$/] },
  { key: 'name', patterns: ['full name', 'your name', /^name$/, 'candidate name'] },
  { key: 'email', patterns: ['email', 'e-mail'] },
  { key: 'phone', patterns: ['phone', 'mobile', 'contact number', 'whatsapp'] },
  { key: 'address', patterns: ['address', 'location', 'city'] },
  { key: 'college', patterns: ['college', 'university', 'institute', 'school'] },
  { key: 'degree', patterns: ['degree', 'qualification'] },
  { key: 'branch', patterns: ['branch', 'stream', 'specialization', 'major'] },
  { key: 'graduationYear', patterns: ['graduation year', 'year of passing', 'passing year', 'batch'] },
  { key: 'skills', patterns: ['skills', 'technical skills', 'expertise'] },
  { key: 'github', patterns: ['github'] },
  { key: 'linkedin', patterns: ['linkedin'] },
  { key: 'portfolio', patterns: ['portfolio', 'website'] },
  { key: 'project', patterns: ['project title', 'project name', /^project$/, 'projects', 'project details', 'describe your project'] },
  { key: 'rollNumber', patterns: ['roll number', 'roll no', 'registration number', 'reg no', 'student id'] },
  { key: 'department', patterns: [/^department$/, 'dept'] },
  { key: 'experience', patterns: ['experience', 'work experience', 'years of experience'] },
  { key: 'organization', patterns: ['organization', 'organisation', 'company'] },
];

function categorizeFieldLabel(label) {
  const lower = label.toLowerCase();
  for (const { key, patterns } of PROFILE_FIELD_PATTERNS) {
    for (const p of patterns) {
      if (p instanceof RegExp) {
        if (p.test(lower)) return key;
      } else if (lower.includes(p)) {
        return key;
      }
    }
  }
  return null;
}

function resolveFieldLabel(el) {
  let label = el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.placeholder || '';
  if (label) return label.trim();

  // FIX: buttons, links, and similar self-labeling controls almost always
  // carry their own visible text ("Follow", "Add to Cart", "Sign in").
  // That text MUST win here, before the ancestor/heading heuristic further
  // below runs. That heuristic exists to label bare form inputs that have
  // no visible text of their own (e.g. a text box under a form question) —
  // but because it used to run unconditionally, it could grab an unrelated
  // heading sitting a few DOM levels up (e.g. a profile name next to a
  // "Follow" button) and report THAT as the button's label instead of
  // "Follow". The agent would then never see an element actually labeled
  // "Follow" in the list it's given, so it could never click it — this was
  // the root cause of the agent scrolling/re-navigating instead of clicking
  // a button that was clearly visible on screen.
  const tagName = el.tagName.toLowerCase();
  const roleAttr = el.getAttribute('role') || '';
  const isSelfLabeling = tagName === 'button' || tagName === 'a' ||
    ['button', 'radio', 'checkbox', 'option'].includes(roleAttr);
  if (isSelfLabeling) {
    const ownText = (el.innerText || el.value || '').trim();
    if (ownText) return ownText;
  }

  if (el.id) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (labelEl && labelEl.innerText) return labelEl.innerText.trim();
  }

  const closestLabel = el.closest('label');
  if (closestLabel && closestLabel.innerText) return closestLabel.innerText.trim();

  let container = el.closest('[role="listitem"]') || el.parentElement?.parentElement?.parentElement;
  if (container) {
    const heading = container.querySelector('[role="heading"], .M7eMe, [aria-level]');
    if (heading && heading.innerText) return heading.innerText.trim();
    const text = (container.innerText || '').split('\n')[0];
    if (text) return text.trim();
  }

  return (el.innerText || el.value || el.name || '').trim();
}

// ----------------------------------------------------------------------------
// Shared visibility check. Many sites (Instagram included) keep more than
// one copy of the same control in the DOM at once — e.g. a mobile-layout
// version hidden via CSS alongside the desktop one. Without this check,
// bounding-box size alone isn't enough to filter those out (visibility:
// hidden/opacity:0 elements can still report a non-zero rect), so the agent
// could end up "clicking" an invisible duplicate that has no visible effect.
// ----------------------------------------------------------------------------
function isElementVisible(el) {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity) === 0) return false;
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  return true;
}

// ----------------------------------------------------------------------------
// v1.3 NEW: required / filled detection.
//
// isFieldRequired — a field counts as required if:
//   - it has the native HTML `required` attribute, or
//   - aria-required="true", or
//   - it sits inside a Google Forms question block that carries the
//     "Required question" accessible marker (the little red asterisk).
// This last check is what makes it work reliably on Google Forms, which
// doesn't rely on the native `required` attribute at all.
//
// isFieldFilled — true if the field already has a non-empty value (text/
// textarea/contenteditable), a selection (select), or is checked (radio/
// checkbox, including custom ARIA role="radio"/"checkbox" widgets and
// grouped native radios sharing a `name`).
// ----------------------------------------------------------------------------
function isFieldRequired(el) {
  if (el.required) return true;
  if (el.getAttribute('aria-required') === 'true') return true;

  // Google Forms marks a required question with an element carrying
  // aria-label="Required question" somewhere inside that question's block.
  let node = el;
  for (let i = 0; i < 6 && node; i++) {
    node = node.parentElement;
    if (!node) break;
    if (node.querySelector('[aria-label="Required question"]')) return true;
    // stop climbing once we've clearly left the question block and hit a
    // page/section-level container, so we don't accidentally match a
    // required marker belonging to a totally different question.
    if (node.getAttribute && node.getAttribute('role') === 'list') break;
  }
  return false;
}

function isFieldFilled(el) {
  const role = el.getAttribute('role');
  const type = (el.type || '').toLowerCase();

  if (type === 'radio' || role === 'radio') {
    if (el.name) {
      return [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)]
        .some(r => r.checked);
    }
    if (el.getAttribute('aria-checked') === 'true') return true;
    const group = el.closest('[role="radiogroup"], [role="list"]');
    if (group) return !!group.querySelector('[aria-checked="true"], [aria-selected="true"]');
    return false;
  }

  if (type === 'checkbox' || role === 'checkbox') {
    if (el.name) {
      return [...document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`)]
        .some(c => c.checked);
    }
    if ('checked' in el) return el.checked;
    return el.getAttribute('aria-checked') === 'true';
  }

  if (el.tagName === 'SELECT') {
    return !!el.value && el.selectedIndex > 0;
  }

  if (el.isContentEditable) {
    return (el.innerText || '').trim().length > 0;
  }

  if ('value' in el) {
    return (el.value || '').trim().length > 0;
  }

  return false;
}

// ----------------------------------------------------------------------------
// v1.3 NEW: scans the WHOLE document (not just the current viewport — a
// required field further down an unscrolled page still counts) for
// required-but-empty fields. Used by the click guard below to decide
// whether a Submit/Next/Continue-style click is safe to perform.
// Deduplicates radio/checkbox groups by their shared `name` so a group of
// 4 radio buttons for one required question is reported once, not 4 times.
// ----------------------------------------------------------------------------
function getUnfilledRequiredFields() {
  const selector = 'input, textarea, select, [role="radio"], [role="checkbox"], [contenteditable="true"]';
  const seen = new Set();
  const missing = [];

  document.querySelectorAll(selector).forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (!isElementVisible(el)) return;
    if (!isFieldRequired(el)) return;
    if (isFieldFilled(el)) return;

    const label = resolveFieldLabel(el).replace(/\s+/g, ' ').substring(0, 90) || '(unlabeled field)';
    const dedupeKey = el.name ? `name:${el.name}` : `label:${label}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    missing.push(label);
  });

  return missing;
}

// ----------------------------------------------------------------------------
// PART 3: List interactive elements — inputs, buttons, links, radios,
// checkboxes, dropdowns. Each gets a stable [data-yukti-index] stamp so
// 'fill' actions can reliably re-select the exact same element later in
// the same round (safer than fuzzy text matching for form fields).
//
// v1.3: each element now also reports `required` and `filled` so both the
// server-side model AND the side panel's local guard can see which fields
// still need attention, instead of only ever seeing labels.
// ----------------------------------------------------------------------------
function getInteractiveElements() {
  const elements = [];
  const selector = [
    'input', 'textarea', 'button', 'a', '[role="button"]', 'select',
    '[contenteditable="true"]', '[role="radio"]', '[role="checkbox"]',
    '[role="listbox"]', '[role="option"]'
  ].join(', ');

  document.querySelectorAll(selector).forEach((el, index) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (!isElementVisible(el)) return;

    const label = resolveFieldLabel(el).replace(/\s+/g, ' ').substring(0, 90);
    if (!label) return;

    const type = el.type || el.getAttribute('role') || '';
    const combined = `${el.name || ''} ${el.id || ''} ${label} ${type}`.toLowerCase();
    const isSearchLike = combined.includes('search') || el.type === 'search';
    const profileCategory = categorizeFieldLabel(label);

    el.setAttribute('data-yukti-index', index);

    elements.push({
      index,
      tag: el.contentEditable === 'true' ? 'contenteditable' : el.tagName.toLowerCase(),
      type,
      label,
      isSearchLike,
      profileCategory,
      required: isFieldRequired(el),
      filled: isFieldFilled(el)
    });
  });

  elements.sort((a, b) => (b.isSearchLike - a.isSearchLike));
  return elements.slice(0, 90);
}

// ----------------------------------------------------------------------------
// PART 4: Product listing detection (shopping tasks)
// ----------------------------------------------------------------------------
function getProductListings() {
  const priceRegex = /₹\s?[\d,]+(?:\.\d{1,2})?/;
  const ratingRegex = /\b[1-5]\.\d\b/;
  const products = [];
  const seenTitles = new Set();

  const links = document.querySelectorAll('a');

  links.forEach((link) => {
    const rect = link.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;

    let container = link;
    let text = (link.innerText || '').trim();
    let priceMatch = text.match(priceRegex);

    if (!priceMatch && link.parentElement) {
      container = link.parentElement.parentElement || link.parentElement;
      text = (container.innerText || '').trim();
      priceMatch = text.match(priceRegex);
    }

    if (!priceMatch) return;

    let title = (link.getAttribute('aria-label') || '').trim();
    if (!title) {
      const firstLine = text.split('\n').map(s => s.trim()).find(s => s.length > 8 && !priceRegex.test(s));
      title = firstLine || text.split('\n')[0] || '';
    }
    title = title.substring(0, 100).trim();
    if (!title || title.length < 5) return;
    if (seenTitles.has(title)) return;
    seenTitles.add(title);

    const ratingMatch = text.match(ratingRegex);

    products.push({
      title,
      price: priceMatch[0].replace(/\s+/g, ''),
      rating: ratingMatch ? ratingMatch[0] : null
    });
  });

  return products.slice(0, 15);
}

// ----------------------------------------------------------------------------
// PART 5: Modal/dialog-aware element matching
// ----------------------------------------------------------------------------
function getActiveOverlayContainer() {
  const candidates = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i]')]
    .filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return true;
    });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const za = parseInt(window.getComputedStyle(a).zIndex) || 0;
    const zb = parseInt(window.getComputedStyle(b).zIndex) || 0;
    return zb - za;
  });
  return candidates[0];
}

// FIX: was 1.0, which let a single generic shared word (e.g. "with") push a
// completely wrong element over the line. Raised so the fuzzy fallback only
// fires on genuinely close matches — if nothing clears this bar, the action
// correctly reports "not found" instead of guessing and misclicking.
const MIN_MATCH_SCORE = 1.5;

const MATCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you',
  'are', 'was', 'were', 'have', 'has', 'into', 'onto', 'then', 'than',
  'also', 'more', 'less', 'not', 'now', 'here', 'there'
]);

function scoreElement(el, searchText, preferredTag) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return 0;
  if (!isElementVisible(el)) return 0;

  const label = resolveFieldLabel(el).toLowerCase();
  if (!label) return 0;

  let score = 0;
  if (label === searchText) {
    score = 5;
  } else if (label.includes(searchText) || searchText.includes(label)) {
    score = 3;
  } else {
    const words = searchText.split(' ').filter(w => w.length > 2 && !MATCH_STOPWORDS.has(w));
    if (words.length > 0) {
      const matchedWords = words.filter(w => label.includes(w)).length;
      if (matchedWords > 0) score = 1 + (matchedWords / words.length);
    }
  }

  if (preferredTag) {
    const tag = el.contentEditable === 'true' ? 'contenteditable' : el.tagName.toLowerCase();
    if (tag === preferredTag || (preferredTag === 'input' && tag === 'contenteditable')) {
      score += 1;
    }
  }

  if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
    score += 0.25;
  }

  return score;
}

function findBestMatch(targetText, preferredTag) {
  const searchText = targetText.trim().toLowerCase();
  const selector = 'input, textarea, button, a, [role="button"], select, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="option"]';

  const overlay = getActiveOverlayContainer();

  if (overlay) {
    const overlayCandidates = [...overlay.querySelectorAll(selector)];
    let best = null, bestScore = 0;
    overlayCandidates.forEach(el => {
      const s = scoreElement(el, searchText, preferredTag);
      if (s > bestScore) { bestScore = s; best = el; }
    });
    if (best && bestScore >= MIN_MATCH_SCORE) return best;
  }

  // FIX: only consider elements currently in the viewport — the same scope
  // getInteractiveElements() used when it built the list the model chose
  // this target_text from. Searching the whole document here (as before)
  // meant an off-screen duplicate with similar text could outscore, or tie
  // with, the on-screen element the model actually meant.
  const candidates = [...document.querySelectorAll(selector)].filter(el => {
    const r = el.getBoundingClientRect();
    return r.bottom >= 0 && r.top <= window.innerHeight;
  });
  let matchedEl = null;
  let bestScore = 0;
  candidates.forEach(el => {
    const s = scoreElement(el, searchText, preferredTag);
    if (s > bestScore) { bestScore = s; matchedEl = el; }
  });

  if (bestScore < MIN_MATCH_SCORE) return null;
  return matchedEl;
}

function findSearchButtonNear(inputEl) {
  const container = inputEl.closest('form') || inputEl.parentElement?.parentElement || document.body;
  const candidates = container.querySelectorAll('button, [role="button"], svg, a');
  for (const el of candidates) {
    const attrs = `${el.getAttribute('aria-label') || ''} ${el.className || ''} ${el.title || ''}`.toLowerCase();
    if (attrs.includes('search') || attrs.includes('submit')) {
      return el.tagName === 'SVG' ? (el.closest('button, a') || el) : el;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// PART 6: Highlight + text-setting helpers
// ----------------------------------------------------------------------------
function highlight(el) {
  const rect = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.style.cssText = `position:fixed; left:${rect.left}px; top:${rect.top}px; width:${rect.width}px; height:${rect.height}px;
    border:3px solid #17b6d4; border-radius:6px; box-shadow:0 0 12px rgba(23,182,212,0.8); pointer-events:none; z-index:2147483647; transition:opacity 0.3s;`;
  document.body.appendChild(box);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 300); }, 2200);
}

function setElementText(el, value) {
  if (el.isContentEditable) {
    el.focus();
    document.execCommand('insertText', false, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  try {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch (e) {
    return false;
  }
}

// ----------------------------------------------------------------------------
// v1.3 NEW: does this element's own visible text look like a form-finalizing
// control (Submit / Send / Continue / Next / Apply / Save / Done / Finish)?
// Word-boundary match so it doesn't misfire on unrelated text that merely
// contains one of these as a substring (e.g. "Submitted 3 responses").
// ----------------------------------------------------------------------------
const FINALIZE_WORDS_REGEX = /\b(submit|send|continue|next|finish|done|apply|save)\b/i;

function looksLikeFinalizeControl(el, targetTextHint) {
  const ownText = (el.innerText || el.value || targetTextHint || '').trim();
  return FINALIZE_WORDS_REGEX.test(ownText);
}

// ----------------------------------------------------------------------------
// PART 7: Execute a single action decided by the agent
// ----------------------------------------------------------------------------
function executeAction({ action, target_text, target_index, value }) {
  if (action === 'finish') {
    return { success: true, message: "Task marked complete." };
  }

  if (action === 'scroll' && (!target_text || target_text.toLowerCase() === 'page' || target_text.toLowerCase() === 'down')) {
    window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
    return { success: true, message: "Scrolled down the page" };
  }

  // FIX: previously only 'fill' actions reused the stable [data-yukti-index]
  // stamp; every 'click' re-ran a fresh fuzzy text search over the whole
  // document. That meant the element actually clicked could differ from the
  // element the model saw and reasoned about — the fix below applies the
  // same reliable index-based lookup to every action, falling back to the
  // fuzzy text search only if no valid index was given or it's gone stale.
  let matchedEl = null;
  if (target_index !== undefined && target_index !== null) {
    const byIndex = document.querySelector(`[data-yukti-index="${target_index}"]`);
    if (byIndex) {
      const rect = byIndex.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && isElementVisible(byIndex)) {
        matchedEl = byIndex;
      }
    }
  }

  if (!matchedEl) {
    if (!target_text) return { success: false, message: "No target specified" };
    const preferredTag = (action === 'type' || action === 'press_enter' || action === 'fill') ? 'input' : 'button';
    matchedEl = findBestMatch(target_text, preferredTag);
  }

  if (!matchedEl) {
    return { success: false, message: `Element "${target_text || target_index}" not found on page` };
  }

  // ------------------------------------------------------------------------
  // v1.3 HARD GUARD: refuse to click a Submit/Next/Continue/Send/Apply/
  // Save/Done -style control while any required field on the page is still
  // empty. This does NOT depend on the model getting it right — it fires
  // regardless of what the model reasoned, which is the actual fix for
  // "fills half the form and submits anyway". If blocked, the calling loop
  // (sidepanel.js) treats this like any other failed step and re-observes,
  // giving the model another round to fill the missing field(s) — the
  // returned message tells it exactly what's still empty.
  // ------------------------------------------------------------------------
  if (action === 'click' && looksLikeFinalizeControl(matchedEl, target_text)) {
    const missing = getUnfilledRequiredFields();
    if (missing.length > 0) {
      return {
        success: false,
        message: `Blocked click on "${target_text}" — required field(s) still empty: ${missing.slice(0, 6).join(', ')}. Fill these before submitting/continuing.`
      };
    }
  }

  highlight(matchedEl);

  try {
    if ((action === 'type' || action === 'fill') && value !== undefined && value !== null) {
      const role = matchedEl.getAttribute('role') || matchedEl.type;
      if (role === 'radio' || role === 'checkbox' || matchedEl.type === 'radio' || matchedEl.type === 'checkbox') {
        matchedEl.click();
        return { success: true, message: `Selected "${target_text || target_index}"` };
      }
      if (matchedEl.tagName === 'SELECT') {
        const options = [...matchedEl.options];
        const match = options.find(o => o.text.toLowerCase().includes(String(value).toLowerCase()));
        if (match) {
          matchedEl.value = match.value;
          matchedEl.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, message: `Selected "${match.text}" in dropdown` };
        }
        return { success: false, message: `Option "${value}" not found in dropdown` };
      }

      const ok = setElementText(matchedEl, String(value));
      return ok
        ? { success: true, message: `Filled "${target_text || target_index}" with "${value}"` }
        : { success: false, message: `Could not fill "${target_text || target_index}"` };
    }

    if (action === 'click') {
      matchedEl.click();
      return { success: true, message: `Clicked "${target_text}"` };
    }

    if (action === 'press_enter') {
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        matchedEl.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      });
      const form = matchedEl.closest('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }
      const searchBtn = findSearchButtonNear(matchedEl);
      if (searchBtn) searchBtn.click();
      return { success: true, message: `Submitted on "${target_text}"` };
    }

    if (action === 'scroll') {
      matchedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { success: true, message: `Scrolled to "${target_text}"` };
    }

    return { success: false, message: `Unknown action: ${action}` };
  } catch (e) {
    return { success: false, message: `Error: ${e.message}` };
  }
}

// ----------------------------------------------------------------------------
// PART 8: Message listener
// ----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'detectSensitiveFields') {
    sendResponse(detectSensitiveFields());
  } else if (request.action === 'getInteractiveElements') {
    sendResponse({
      elements: getInteractiveElements(),
      products: getProductListings()
    });
  } else if (request.action === 'executeAction') {
    sendResponse(executeAction(request.payload));
  }
  return true;
});