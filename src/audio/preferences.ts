const mutedPreferenceKey = 'tidewrit.audio.muted'

export function readMutedPreference() {
  try {
    // Sound starts off on Play until someone turns it on.
    return localStorage.getItem(mutedPreferenceKey) !== 'false'
  } catch {
    return true
  }
}

export function writeMutedPreference(muted: boolean) {
  try {
    localStorage.setItem(mutedPreferenceKey, String(muted))
  } catch {
    // Storage can be blocked or full; sound controls still work for this visit.
  }
}
