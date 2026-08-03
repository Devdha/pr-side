import { loadSettings, saveSettings } from "../lib/settings.js";
import { getMessage, localizeDocument } from "../lib/i18n.js";
import type { GroupMode } from "../lib/types.js";

localizeDocument();

const groupModeInputs = document.querySelectorAll<HTMLInputElement>(
  'input[name="groupMode"]',
);
const syncIntervalInput = document.getElementById(
  "syncInterval",
) as HTMLInputElement;
const maxAgeDaysInput = document.getElementById("maxAgeDays") as HTMLInputElement;
const saveButton = document.getElementById("saveButton") as HTMLButtonElement;
const saveFeedback = document.getElementById("saveFeedback") as HTMLParagraphElement;

async function render(): Promise<void> {
  const settings = await loadSettings();
  for (const input of groupModeInputs) {
    input.checked = input.value === settings.groupMode;
  }
  syncIntervalInput.value = String(settings.syncIntervalMinutes);
  maxAgeDaysInput.value = String(settings.maxAgeDays);
}

function getSelectedGroupMode(): GroupMode {
  for (const input of groupModeInputs) {
    if (input.checked) return input.value as GroupMode;
  }
  return "split";
}

async function handleSave(): Promise<void> {
  const groupMode = getSelectedGroupMode();
  const syncIntervalMinutes = Math.max(
    1,
    Number.parseInt(syncIntervalInput.value, 10) || 1,
  );
  const maxAgeDays = Math.max(0, Number.parseInt(maxAgeDaysInput.value, 10) || 0);

  await saveSettings({ groupMode, syncIntervalMinutes, maxAgeDays });

  saveFeedback.textContent = getMessage("saved", "Saved.");
  setTimeout(() => {
    saveFeedback.textContent = "";
  }, 2000);
}

saveButton.addEventListener("click", () => {
  void handleSave();
});

void render();
