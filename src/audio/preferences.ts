const mutedPreferenceKey = 'tidewrit.audio.muted'

export function readMutedPreference() {
  try {
    return localStorage.getItem(mutedPreferenceKey) === 'true'
  } catch {
    return false
  }
}

export function writeMutedPreference(muted: boolean) {
  try {
    localStorage.setItem(mutedPreferenceKey, String(muted))
  } catch {
    // Storage can be blocked or full; sound controls still work for this visit.
  }
}
