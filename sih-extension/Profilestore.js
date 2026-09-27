// ============================================================================
// Project YUKTI — Local Profile Store (v1.1)
// Thin wrapper around chrome.storage.local. This is the ONLY place the
// extracted resume profile lives. It never leaves the browser, and it is
// never passed to fetch()/XMLHttpRequest calls in sidepanel.js — only
// individual resolved field VALUES are passed locally into content.js when
// filling a form (a same-device message, not a network request).
//
// v1.1: added firstName/lastName to the recognized key list so forms that
// split the name into two boxes can be auto-filled from a resume that only
// states the full name once (see Resumeparser.js's splitName()).
// ============================================================================

const PROFILE_STORAGE_KEY = 'yukti_profile';

function saveProfile(profile) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: profile }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(profile);
    });
  });
}

function getProfile() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([PROFILE_STORAGE_KEY], (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result[PROFILE_STORAGE_KEY] || null);
    });
  });
}

function deleteProfile() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([PROFILE_STORAGE_KEY], () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// Returns the list of profile keys that currently have a non-empty value —
// this "schema" (key names only, never values) is what gets shown to the
// remote AI so it knows which valueSource options exist, without ever
// exposing the actual private data.
function getAvailableProfileKeys(profile) {
  if (!profile) return [];
  const keys = [
    'name', 'firstName', 'lastName', 'email', 'phone', 'address', 'college',
    'degree', 'branch', 'graduationYear', 'github', 'linkedin', 'portfolio'
  ];
  const available = keys.filter(k => profile[k] && String(profile[k]).trim().length > 0);
  if (profile.skills && profile.skills.length > 0) available.push('skills');
  return available;
}

// Resolves a valueSource key (e.g. "email") to its actual local value.
// This function is the ONLY bridge between the AI's abstract instruction
// and the real private data — and it never touches the network.
function resolveValueSource(profile, valueSource) {
  if (!profile || !valueSource) return null;
  if (valueSource === 'skills') {
    return Array.isArray(profile.skills) ? profile.skills.join(', ') : (profile.skills || '');
  }
  return profile[valueSource] !== undefined ? profile[valueSource] : null;
}