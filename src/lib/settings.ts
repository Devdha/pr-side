import { DEFAULT_SETTINGS, type Settings } from "./types.js";

const SETTINGS_KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...value,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

export function onSettingsChanged(
  callback: (settings: Settings) => void,
): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!(SETTINGS_KEY in changes)) return;
    const newValue = changes[SETTINGS_KEY]?.newValue as
      | Partial<Settings>
      | undefined;
    callback({ ...DEFAULT_SETTINGS, ...newValue });
  });
}
