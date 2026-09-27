// ============================================================================
// Project YUKTI — Side Panel Controller (v1.2)
// Adds: local resume upload/parsing, private profile storage, valueSource
// resolution (server never sees actual PII — only field categories), and a
// live "Privacy Shield" panel showing exactly what stays local vs. what is
// sent to the server.
//
// v1.2: a second, local layer of the same safety idea now in content.js —
// before a Submit/Next/Continue/Send/Apply/Save/Done -style click step is
// even sent to the page, check whether any element the page reported as
// matching a KNOWN profile field (email, name, phone, ...) that we actually
// HAVE a local value for is still unfilled. If so, the click is held back
// here and the round is repeated instead, giving the model another chance
// to fill it — this is what fixes the agent submitting a form (e.g. a
// Google Form) while some of the profile-derived fields are still blank.
// ============================================================================

let modelsLoaded = false;
let currentProfile = null; // loaded once at startup, kept only in memory + chrome.storage.local

const logEl = document.getElementById('logConsole');
const previewImg = document.getElementById('previewImg');
const submitBtn = document.getElementById('submitBtn');
const commandBox = document.getElementById('commandBox');
const MAX_ROUNDS = 14;
const SERVER_URL = "http://127.0.0.1:8000";

// Matches the same finalize-style wording content.js's hard guard looks for,
// kept in sync deliberately: this is the "should I even try clicking that
// yet" pre-check, content.js's guard is the actual enforcement.
const FINALIZE_WORDS_REGEX = /\b(submit|send|continue|next|finish|done|apply|save)\b/i;

// ----------------------------------------------------------------------------
// Logging helper
// ----------------------------------------------------------------------------
function log(message, type = 'info') {
  const placeholder = logEl.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ----------------------------------------------------------------------------
// PROFILE UI — upload, view, replace, delete
// ----------------------------------------------------------------------------
const profileEmptyState = document.getElementById('profileEmptyState');
const profileLoaded = document.getElementById('profileLoaded');
const profileFileName = document.getElementById('profileFileName');
const profileFieldsView = document.getElementById('profileFieldsView');
const profileFileInput = document.getElementById('profileFileInput');

function renderProfileUI() {
  if (currentProfile) {
    profileEmptyState.style.display = 'none';
    profileLoaded.style.display = 'block';
    profileFileName.textContent = `✓ ${currentProfile._sourceFileName || 'Resume.pdf'}`;
  } else {
    profileEmptyState.style.display = 'block';
    profileLoaded.style.display = 'none';
    profileFieldsView.style.display = 'none';
  }
}

async function loadProfileFromStorage() {
  currentProfile = await getProfile();
  renderProfileUI();
}

async function handleResumeUpload(file) {
  if (!file || file.type !== 'application/pdf') {
    log("Please select a valid PDF file.", "error");
    return;
  }
  log("Parsing resume locally (no upload to any server)...");
  try {
    const profile = await parseResumeFile(file); // resumeParser.js — fully local
    await saveProfile(profile); // profileStore.js — chrome.storage.local only
    currentProfile = profile;
    renderProfileUI();
    log(`Resume parsed and stored locally. Extracted ${Object.values(profile).filter(v => v && (Array.isArray(v) ? v.length : true)).length} field(s).`, "success");
  } catch (err) {
    log("Failed to parse resume: " + err.message, "error");
  }
}

document.getElementById('uploadResumeBtn').addEventListener('click', () => profileFileInput.click());
document.getElementById('replaceResumeBtn').addEventListener('click', () => profileFileInput.click());
profileFileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleResumeUpload(e.target.files[0]);
  }
});

document.getElementById('deleteProfileBtn').addEventListener('click', async () => {
  const ok = confirm("Delete your locally stored resume profile? This cannot be undone.");
  if (!ok) return;
  await deleteProfile();
  currentProfile = null;
  renderProfileUI();
  log("Local profile deleted.", "success");
});

document.getElementById('viewProfileBtn').addEventListener('click', () => {
  if (!currentProfile) return;
  const visible = profileFieldsView.style.display === 'block';
  if (visible) {
    profileFieldsView.style.display = 'none';
    return;
  }
  const rows = [
    ['Name', currentProfile.name],
    ['First Name', currentProfile.firstName],
    ['Last Name', currentProfile.lastName],
    ['Email', currentProfile.email],
    ['Phone', currentProfile.phone],
    ['Address', currentProfile.address],
    ['College', currentProfile.college],
    ['Degree', currentProfile.degree],
    ['Branch', currentProfile.branch],
    ['Graduation Year', currentProfile.graduationYear],
    ['Skills', Array.isArray(currentProfile.skills) ? currentProfile.skills.join(', ') : currentProfile.skills],
    ['GitHub', currentProfile.github],
    ['LinkedIn', currentProfile.linkedin],
    ['Portfolio', currentProfile.portfolio],
  ];
  profileFieldsView.innerHTML = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<div>${k}: <span>${v}</span></div>`)
    .join('') || '<div>No fields could be extracted from this PDF.</div>';
  profileFieldsView.style.display = 'block';
});

// ----------------------------------------------------------------------------
// PRIVACY SHIELD LIVE PANEL
// ----------------------------------------------------------------------------
const privacyShieldPanel = document.getElementById('privacyShieldPanel');
const privacyLocalList = document.getElementById('privacyLocalList');
const privacyServerList = document.getElementById('privacyServerList');
const piiDetectedCountEl = document.getElementById('piiDetectedCount');
const piiRedactedCountEl = document.getElementById('piiRedactedCount');
const piiTransmittedCountEl = document.getElementById('piiTransmittedCount');
const serverViewJson = document.getElementById('serverViewJson');

document.getElementById('toggleServerView').addEventListener('click', () => {
  const showing = serverViewJson.style.display === 'block';
  serverViewJson.style.display = showing ? 'none' : 'block';
});

function updatePrivacyShield({ localItems, serverItems, piiDetected, piiRedacted, piiTransmitted, serverPayloadPreview }) {
  privacyShieldPanel.style.display = 'block';
  privacyLocalList.innerHTML = localItems.map(i => `<div class="privacy-item privacy-yes">✓ ${i}</div>`).join('');
  privacyServerList.innerHTML = serverItems.map(i => `<div class="privacy-item">${i}</div>`).join('');
  piiDetectedCountEl.textContent = piiDetected;
  piiRedactedCountEl.textContent = piiRedacted;
  piiTransmittedCountEl.textContent = piiTransmitted;
  if (serverPayloadPreview) {
    serverViewJson.textContent = JSON.stringify(serverPayloadPreview, null, 2);
  }
}

// ----------------------------------------------------------------------------
// Local face-detection model
// ----------------------------------------------------------------------------
async function loadModels() {
  if (modelsLoaded) return;
  const modelUrl = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
  await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
  modelsLoaded = true;
}

// ----------------------------------------------------------------------------
// Wait for tab navigation to finish
// ----------------------------------------------------------------------------
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // FIX: heavy single-page apps (Instagram, Twitter/X, LinkedIn, etc.)
        // fire "complete" as soon as the initial shell loads, then spend
        // another second or more hydrating and fetching data before
        // buttons like "Follow" actually render. 500ms was often too short,
        // so the very first observation after navigating saw an
        // incomplete page and the agent had nothing real to click yet.
        setTimeout(resolve, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 12000);
  });
}

// ----------------------------------------------------------------------------
// Safe content-script messaging wrappers
// ----------------------------------------------------------------------------
async function safeGetElements(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'getInteractiveElements' });
    return { elements: res.elements || [], products: res.products || [] };
  } catch (e) {
    return { elements: [], products: [] };
  }
}
async function safeDetectSensitive(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: 'detectSensitiveFields' });
  } catch (e) {
    return { sensitiveFields: [], pageWidth: window.screen.width, pageHeight: window.screen.height };
  }
}

function resizeCanvas(sourceCanvas, maxWidth) {
  if (sourceCanvas.width <= maxWidth) return sourceCanvas;
  const scale = maxWidth / sourceCanvas.width;
  const out = document.createElement('canvas');
  out.width = maxWidth;
  out.height = sourceCanvas.height * scale;
  out.getContext('2d').drawImage(sourceCanvas, 0, 0, out.width, out.height);
  return out;
}

async function captureAndRedact(tabId, skipFaceDetection) {
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  } catch (e) {
    return null;
  }

  const [domData, elData] = await Promise.all([
    safeDetectSensitive(tabId),
    safeGetElements(tabId)
  ]);
  const sensitiveFields = domData.sensitiveFields || [];
  const elements = elData.elements;
  const products = elData.products;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const scaleX = img.width / (domData.pageWidth || img.width);
      const scaleY = img.height / (domData.pageHeight || img.height);

      ctx.fillStyle = "black";
      sensitiveFields.forEach(field => {
        const box = field.boundingBox;
        ctx.fillRect(box.x * scaleX, box.y * scaleY, box.width * scaleX, box.height * scaleY);
      });

      let faceCount = 0;
      if (!skipFaceDetection) {
        try {
          const faceDetections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }));
          faceCount = faceDetections.length;
          faceDetections.forEach(det => {
            const box = det.box;
            ctx.fillStyle = "black";
            ctx.beginPath();
            ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 1.5, box.height / 1.5, 0, 0, 2 * Math.PI);
            ctx.fill();
          });
        } catch (e) {}
      }

      const smallCanvas = resizeCanvas(canvas, 1000);
      smallCanvas.toBlob(
        (blob) => resolve({ blob, canvas, redactedCount: sensitiveFields.length, faceCount, elements, products }),
        "image/png",
        0.85
      );
    };
    img.src = dataUrl;
  });
}

// ----------------------------------------------------------------------------
// Build the sanitized field list sent to the server: labels + type +
// profileCategory + required/filled flags ONLY — never actual values. This
// is what powers the "What Server Sees" panel and the valueSource-based
// fill protocol. `required`/`filled` are booleans (no PII), added in v1.2
// so the model itself is also told which fields still need attention,
// on top of the hard local/content-script guards.
// ----------------------------------------------------------------------------
function buildSanitizedElementsForServer(elements) {
  return elements.map(e => ({
    index: e.index, // position only, not private — lets the model point at the exact element
    tag: e.tag,
    type: e.type,
    label: e.label,
    profileCategory: e.profileCategory || null, // e.g. "email" — category only, never a value
    required: !!e.required,
    filled: !!e.filled
  }));
}

// ----------------------------------------------------------------------------
// v1.2 NEW: local pre-flight check before a finalize-style click is sent to
// the page at all. Looks only at fields the page told us map to a KNOWN
// profile key (e.g. "email") that we actually have a non-empty local value
// for (availableProfileKeys) and that aren't filled in yet. This catches
// the common case even on forms that don't mark fields as HTML-required —
// content.js's own guard (keyed off actual `required`/aria-required) is the
// second, independent layer for that case.
// ----------------------------------------------------------------------------
function findUnfilledKnownProfileFields(elements, availableProfileKeys) {
  if (!availableProfileKeys || availableProfileKeys.length === 0) return [];
  return elements.filter(e =>
    e.profileCategory &&
    availableProfileKeys.includes(e.profileCategory) &&
    !e.filled
  );
}

// ----------------------------------------------------------------------------
// Main task execution loop
// ----------------------------------------------------------------------------
submitBtn.addEventListener('click', async () => {
  const command = commandBox.value.trim();
  if (!command) {
    log("Please enter a command first.", "error");
    return;
  }

  submitBtn.disabled = true;
  document.getElementById('metricsPanel').style.display = 'none';
  const t0 = performance.now();
  const history = [];
  let totalRedacted = 0, totalFaces = 0, round = 0, stopped = false;
  let piiTransmittedTotal = 0;

  const availableProfileKeys = getAvailableProfileKeys(currentProfile);

  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    log("Loading local vision model...");
    await loadModels();

    while (round < MAX_ROUNDS && !stopped) {
      round++;
      log(`--- Round ${round}: observing screen ---`);

      const capture = await captureAndRedact(tab.id, round % 2 === 0);
      let blob, canvas, elements = [], products = [];

      if (capture) {
        ({ blob, canvas, elements, products } = capture);
        totalRedacted += capture.redactedCount;
        totalFaces += capture.faceCount;
        previewImg.src = canvas.toDataURL('image/png');
        previewImg.style.display = 'block';
      } else {
        log("Current page can't be captured (browser internal page).", "info");
      }

      const sanitizedElements = buildSanitizedElementsForServer(elements);

      // --- Ask the server what to do next (server NEVER receives actual PII values) ---
      const formData = new FormData();
      if (blob) formData.append("file", blob, "screenshot.png");
      formData.append("command", command);
      formData.append("elements", JSON.stringify(sanitizedElements));
      formData.append("products", JSON.stringify(products));
      formData.append("history", JSON.stringify(history));
      formData.append("current_url", tab.url || "");
      formData.append("profile_keys", JSON.stringify(availableProfileKeys)); // key NAMES only

      // Update the "What Server Sees" panel with the exact sanitized payload
      updatePrivacyShield({
        localItems: currentProfile ? ['Resume', ...availableProfileKeys.map(k => k[0].toUpperCase() + k.slice(1))] : ['(no resume loaded)'],
        serverItems: ['Page structure', 'Field labels', 'Redacted visual context', 'Action targets', `Profile field NAMES only: [${availableProfileKeys.join(', ') || 'none'}]`],
        piiDetected: totalRedacted,
        piiRedacted: totalRedacted,
        piiTransmitted: piiTransmittedTotal,
        serverPayloadPreview: { command, elements: sanitizedElements, products, history, profile_keys: availableProfileKeys }
      });

      const serverResponse = await fetch(`${SERVER_URL}/next_step`, { method: "POST", body: formData });
      if (!serverResponse.ok) throw new Error(`Server error ${serverResponse.status}`);
      const plan = await serverResponse.json();
      const steps = plan.steps || [plan];

      let shouldReobserve = false;

      for (const step of steps) {
        if (step.action === 'finish') {
          // v1.2: don't take the model's word for it if fields it could
          // clearly have filled from the resume are still empty — this is
          // the "leaves the name blank and calls it done" case.
          const unfilledKnown = findUnfilledKnownProfileFields(elements, availableProfileKeys);
          if (unfilledKnown.length > 0) {
            const names = unfilledKnown.map(e => e.label).slice(0, 6).join(', ');
            log(`Not finishing yet — these profile-linked fields are still empty: ${names}`, "error");
            history.push(`model said finish, but held off -> unfilled profile fields still visible: ${names}`);
            shouldReobserve = true;
            break;
          }
          log(`Task complete: ${step.reasoning || ''}`, "success");
          stopped = true;
          break;
        }

        if (step.action === 'confirm_needed') {
          log(`PAYMENT / FINAL STEP REACHED: ${step.reasoning || 'Confirmation required.'}`, "error");
          const proceed = confirm(
            `The agent has reached a step that may finalize a submission/payment:\n\n"${step.reasoning || ''}"\n\nDo you want to allow this action?`
          );
          if (!proceed) {
            log("User declined. Stopping task.", "error");
            stopped = true;
            break;
          }
          history.push(`user confirmed to proceed past confirmation step`);
          shouldReobserve = true;
          break;
        }

        if (step.action === 'navigate' && step.url) {
          log(`Navigating to ${step.url}`, "nav");
          await chrome.tabs.update(tab.id, { url: step.url });
          await waitForTabLoad(tab.id);
          [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          history.push(`navigate to ${step.url} -> done`);
          shouldReobserve = true;
          break;
        }

        // --- v1.2 NEW: local pre-flight guard for finalize-style clicks.
        // Held back BEFORE it's even sent to content.js if a field we know
        // maps to a profile key we have data for is still empty. content.js
        // has its own independent guard keyed off required/aria-required,
        // which still applies even if this one doesn't catch it. ---
        if (step.action === 'click' && step.target_text && FINALIZE_WORDS_REGEX.test(step.target_text)) {
          const unfilledKnown = findUnfilledKnownProfileFields(elements, availableProfileKeys);
          if (unfilledKnown.length > 0) {
            const names = unfilledKnown.map(e => e.label).slice(0, 6).join(', ');
            log(`Holding off on "${step.target_text}" — profile field(s) not filled yet: ${names}`, "error");
            history.push(`click on "${step.target_text}" -> blocked locally (unfilled profile fields: ${names})`);
            shouldReobserve = true;
            continue;
          }
        }

        // --- 'fill' action: server gave us a valueSource (e.g. "email"), NOT
        // an actual value. We resolve the real value LOCALLY right here,
        // then pass it to content.js. This value never crosses the network. ---
        let executionPayload = { ...step };
        if (step.action === 'fill' && step.valueSource) {
          const resolvedValue = resolveValueSource(currentProfile, step.valueSource);
          if (resolvedValue === null || resolvedValue === '') {
            log(`No local value available for "${step.valueSource}" — skipping this field.`, "error");
            history.push(`fill ${step.target_text || ''} from ${step.valueSource} -> skipped (no local data)`);
            continue;
          }
          executionPayload = { action: 'fill', target_index: step.target_index, target_text: step.target_text, value: resolvedValue };
          log(`Filling "${step.target_text}" locally from profile field "${step.valueSource}" (value never sent to server)`);
        } else {
          log(`${step.action}${step.target_text ? ' on "' + step.target_text + '"' : ''}${step.value ? ' = "' + step.value + '"' : ''}`);
        }
        if (step.reasoning) log(`Reasoning: ${step.reasoning}`);

        let result;
        try {
          result = await chrome.tabs.sendMessage(tab.id, { action: 'executeAction', payload: executionPayload });
        } catch (e) {
          result = { success: false, message: "Could not reach page (try again)" };
        }
        log(result.message, result.success ? "success" : "error");
        history.push(
          `${step.action}${step.target_text ? ' on "' + step.target_text + '"' : ''}` +
          `${step.valueSource ? ' from profile field "' + step.valueSource + '"' : ''} -> ${result.success ? 'succeeded' : 'failed: ' + result.message}`
        );

        if (step.action === 'press_enter' || step.action === 'click' || step.action === 'scroll') {
          shouldReobserve = true;
          await new Promise(r => setTimeout(r, step.action === 'scroll' ? 700 : 1000));
          break;
        }
      }

      if (stopped) break;
      if (round >= MAX_ROUNDS) {
        log("Reached maximum round limit.", "error");
        break;
      }
      if (!shouldReobserve) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    const totalTime = performance.now() - t0;
    document.getElementById('metricsTable').innerHTML = `
      <tr><td>Total time</td><td>${(totalTime / 1000).toFixed(1)} s</td></tr>
      <tr><td>Rounds taken</td><td>${round}</td></tr>
      <tr><td>Fields redacted</td><td>${totalRedacted}</td></tr>
      <tr><td>Faces redacted</td><td>${totalFaces}</td></tr>
      <tr><td>PII values transmitted</td><td>${piiTransmittedTotal}</td></tr>
    `;
    document.getElementById('metricsPanel').style.display = 'block';
    log("Session finished.", "success");

  } catch (err) {
    log("Error: " + err.message, "error");
    console.error(err);
  } finally {
    submitBtn.disabled = false;
  }
});

previewImg.addEventListener('click', () => {
  chrome.tabs.create({ url: previewImg.src });
});

// Load any previously stored profile on panel open
loadProfileFromStorage();