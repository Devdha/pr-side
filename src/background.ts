import { loadSettings, onSettingsChanged } from "./lib/settings.js";
import { syncAll } from "./lib/sync.js";
import type { SyncStatus } from "./lib/types.js";

const ALARM_NAME = "sync";
// 브라우저 시작 직후에는 세션 복원(닫혔던 탭 그룹 포함)이 아직 끝나지 않았을
// 수 있다. 곧바로 syncAll을 실행하면 복원 중인 그룹을 무효한 groupId로 보고
// 중복 그룹을 만들 위험이 있으므로, 복원이 끝날 시간을 준 뒤 1회성 알람으로
// 실행한다.
const STARTUP_SYNC_ALARM_NAME = "startup-sync";
const STARTUP_SYNC_DELAY_MS = 15_000;

async function setupAlarm(): Promise<void> {
  const settings = await loadSettings();
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: settings.syncIntervalMinutes,
  });
}

async function initializeImmediately(): Promise<void> {
  await setupAlarm();
  await syncAll();
}

chrome.runtime.onInstalled.addListener(() => {
  // 확장 설치/업데이트는 세션 복원과 무관하므로 즉시 동기화한다.
  void initializeImmediately();
});

chrome.runtime.onStartup.addListener(() => {
  void setupAlarm();
  void chrome.alarms.create(STARTUP_SYNC_ALARM_NAME, {
    when: Date.now() + STARTUP_SYNC_DELAY_MS,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === STARTUP_SYNC_ALARM_NAME) {
    void syncAll();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && typeof message === "object" && message.type === "sync") {
    void syncAll().then((status: SyncStatus) => {
      sendResponse(status);
    });
    return true;
  }
  return undefined;
});

onSettingsChanged(() => {
  void setupAlarm();
});
