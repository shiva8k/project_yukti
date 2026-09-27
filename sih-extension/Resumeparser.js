// ============================================================================
// Project YUKTI — Local Resume Parser (v1.1)
// Runs entirely inside the extension's side panel (never in page/content
// context, never sent to any server). Uses PDF.js (loaded locally from
// lib/pdf.min.js) to extract raw text from an uploaded PDF, then applies
// regex/heuristics to build a structured profile object. The PDF file
// itself is never uploaded anywhere.
//
// v1.1 fixes:
//   - extractName() was case-sensitive on the word "Name", so a resume
//     header written in ALL CAPS ("NAME - JOHN DOE") never matched the
//     reliable Strategy 1 path and fell through to a much weaker fallback
//     that returned garbage like "Name - John Doe" (it literally included
//     the label word and the dash in the extracted name). Rewritten to be
//     case-insensitive and to cleanly separate the label from the value.
//   - parseResumeFile() now also derives firstName/lastName from the
//     extracted name, so forms that ask for them as two separate boxes
//     (very common on Google Forms) don't get left blank just because the
//     resume only has one combined name field.
//
// NOTE: Extraction heuristics are best-effort — resume layouts vary a lot.
// If a field isn't extracted correctly, use "Add/Edit Field" in the side
// panel to fix or add it manually; that value is then usable the same way
// as any auto-extracted field.
// ============================================================================

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
} else {
  console.error('YUKTI: pdfjsLib failed to load. Check that lib/pdf.min.js exists and is listed before resumeParser.js in sidepanel.html.');
}

async function extractTextFromPdf(arrayBuffer) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF library not loaded (pdfjsLib is undefined). Reload the extension.');
  }
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    fullText += pageText + '\n';
  }
  return fullText;
}

// PDF.js sometimes emits text with irregular spacing (extra spaces between
// letters, or missing spaces between words) depending on how the PDF was
// generated. Normalize common issues before running extraction regexes.
function normalizeText(text) {
  return text
    .replace(/[ \t]+/g, ' ')          // collapse multiple spaces/tabs
    .replace(/ ?\n ?/g, '\n')         // trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n');      // collapse excess blank lines
}

function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : '';
}

function extractPhone(text) {
  const match = text.match(/(?<!\d)(\+?91[-\s]?)?[6-9]\d{9}(?!\d)/);
  return match ? match[0].trim() : '';
}

function extractGithub(text) {
  const match = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_-]+/i);
  return match ? (match[0].startsWith('http') ? match[0] : 'https://' + match[0]) : '';
}

function extractLinkedin(text) {
  const match = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i);
  return match ? (match[0].startsWith('http') ? match[0] : 'https://' + match[0]) : '';
}

function extractPortfolio(text) {
  const urls = text.match(/(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+\.[A-Za-z]{2,}(?:\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?/g) || [];
  for (const url of urls) {
    const lower = url.toLowerCase();
    if (lower.includes('github.com') || lower.includes('linkedin.com')) continue;
    if (lower.includes('@')) continue;
    if (url.length > 12) return url.startsWith('http') ? url : 'https://' + url;
  }
  return '';
}

function toTitleCase(str) {
  return str
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Name extraction: tries several strategies, from most to least reliable,
// since resume layouts and PDF text-extraction quality vary a lot.
//
// v1.1: Strategy 1 is now case-insensitive and captures the REST of the
// label's line as a whole (rather than a fixed 1-4 word pattern), so it
// correctly handles "NAME - SHIVOHAM MISHRA", "Name: John Doe", and
// "Full Name — Jane Q. Smith" alike, always returning a clean, properly
// title-cased name with the label and separator stripped out.
function extractName(text) {
  const sectionWords = ['resume', 'curriculum', 'vitae', 'objective', 'summary', 'contact', 'email', 'phone', 'address'];

  // Strategy 1: an explicit "Name" label anywhere on its own line, in any
  // case, followed by a colon/dash/em-dash, then the actual name.
  const labelMatch = text.match(/\b(?:full\s+)?name\s*[:\-–—]\s*([^\n]{2,60})/i);
  if (labelMatch) {
    const candidate = labelMatch[1]
      .replace(/^[\s:\-–—]+/, '')
      .replace(/[\s:\-–—]+$/, '')
      .trim();
    if (candidate && !candidate.includes('@') && /[A-Za-z]/.test(candidate) && candidate.split(/\s+/).length <= 5) {
      return toTitleCase(candidate);
    }
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Strategy 2: first line that looks like a Title-Case name (2-4 words).
  // Each word must be letters only (plus . ' -) — a bare "-" token (as in
  // "NAME - John Doe") is rejected here on purpose so that line falls
  // through to Strategy 3 instead of being mis-parsed as a 4-word name.
  for (const line of lines.slice(0, 10)) {
    const lower = line.toLowerCase();
    if (sectionWords.some(w => lower.includes(w))) continue;
    if (/\d/.test(line)) continue;
    if (line.includes('@')) continue;
    if (line.length > 45) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4 && words.every(w => /^[A-Za-z][A-Za-z.'-]*$/.test(w))) {
      return line;
    }
  }

  // Strategy 3: first ALL-CAPS line that looks like a name. A leading
  // "NAME" / "NAME:" / "NAME -" label (if present) is stripped first so
  // it never ends up embedded in the returned name.
  for (const line of lines.slice(0, 10)) {
    const lower = line.toLowerCase();
    if (sectionWords.some(w => lower.includes(w))) continue;
    if (/\d/.test(line)) continue;
    if (line.includes('@')) continue;
    const stripped = line.replace(/^name\s*[:\-–—]?\s*/i, '').trim();
    if (!stripped) continue;
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4 &&
        stripped === stripped.toUpperCase() &&
        /^[A-Z\s.'-]+$/.test(stripped)) {
      return toTitleCase(stripped);
    }
  }

  return '';
}

function extractCollege(text) {
  const match = text.match(/[A-Z][A-Za-z.&'\s]{2,60}(University|College|Institute of Technology|Institute)/);
  return match ? match[0].trim() : '';
}

function extractDegree(text) {
  const degreePatterns = /\b(B\.?\s?Tech|M\.?\s?Tech|B\.?\s?E\.?|M\.?\s?E\.?|B\.?\s?Sc|M\.?\s?Sc|BCA|MCA|MBA|B\.?\s?Com|M\.?\s?Com|Ph\.?\s?D|Bachelor(?:'s)? of [A-Za-z]+|Master(?:'s)? of [A-Za-z]+)\b/i;
  const match = text.match(degreePatterns);
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}

function extractBranch(text) {
  const branchPatterns = /\b(Computer Science|Information Technology|Electronics(?:\s*(?:and|&)\s*Communication)?|Mechanical|Civil|Electrical|Chemical|AI\s*(?:and|&)?\s*ML|Artificial Intelligence|Data Science)\b/i;
  const match = text.match(branchPatterns);
  return match ? match[0].trim() : '';
}

function extractGraduationYear(text) {
  const matches = text.match(/\b(20[1-3]\d)\b/g);
  if (!matches) return '';
  return matches[matches.length - 1];
}

// Generic section extractor: finds a heading like "Skills" / "Projects" /
// "Experience" and grabs the text until the next likely section heading.
function extractSection(text, headingNames) {
  const headingPattern = headingNames.join('|');
  const regex = new RegExp(
    `(?:${headingPattern})\\s*[:\\-]?\\s*\\n?([\\s\\S]{0,600}?)(?=\\n[A-Z][A-Za-z ]{2,25}\\s*\\n|\\n[A-Z][A-Za-z ]{2,25}:|$)`,
    'i'
  );
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

function extractSkills(text) {
  const raw = extractSection(text, ['Skills', 'Technical Skills', 'Key Skills']);
  if (!raw) return [];
  return raw
    .split(/[,•|\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 1 && s.length < 40)
    .slice(0, 20);
}

// Extracts a short project summary usable for a generic "Project" form
// field. Prefers the first project's title line; falls back to the raw
// section text (trimmed) if no clear title line is found.
function extractProjectSummary(text) {
  const raw = extractSection(text, ['Projects', 'Project', 'Academic Projects', 'Personal Projects']);
  if (!raw) return '';

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  // First non-empty line is usually the project title/name
  const firstLine = lines[0];
  return firstLine.length > 3 ? firstLine.substring(0, 150) : raw.substring(0, 150);
}

function extractAddress(text) {
  const match = text.match(/\b([A-Z][a-zA-Z]+,\s*[A-Z][a-zA-Z]+(?:,\s*India)?)\b/);
  return match ? match[0].trim() : '';
}

// v1.1 NEW: splits a full name into a best-effort firstName/lastName pair
// so forms that ask for them separately (common on Google Forms) can still
// be filled from a resume that only ever states the full name once.
function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Parses a resume PDF File object and returns a structured profile.
 * Everything happens locally in the browser — no network calls.
 */
async function parseResumeFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const rawText = await extractTextFromPdf(arrayBuffer);
  const text = normalizeText(rawText);

  const github = extractGithub(text);
  const linkedin = extractLinkedin(text);
  const name = extractName(text);
  const { firstName, lastName } = splitName(name);

  const profile = {
    name,
    firstName,
    lastName,
    email: extractEmail(text),
    phone: extractPhone(text),
    address: extractAddress(text),
    college: extractCollege(text),
    degree: extractDegree(text),
    branch: extractBranch(text),
    graduationYear: extractGraduationYear(text),
    skills: extractSkills(text),
    github,
    linkedin,
    portfolio: extractPortfolio(text),
    project: extractProjectSummary(text), // short form-fillable summary
    projects: [],
    experience: [],
    _sourceFileName: file.name,
    _extractedAt: new Date().toISOString()
  };

  return profile;
}