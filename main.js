
const entrypoints = require("uxp").entrypoints;
const fs = require("uxp").storage.localFileSystem;
const ps = require("photoshop");
const core = ps.core;
const action = ps.action;

const SETTINGS_FILE = "hotfolder_settings.json";
const LEGACY_TOKEN_FILE = "hotfolder_token.json";
const PROCESSED_FOLDER_NAME = "_processed";

let hotfolder = null;
let monitorTimer = null;
let knownNames = new Set();
let processingNames = new Set();
let settingsCache = null;
let actionSetsCache = null;
let processedFolderCache = null;
let fileQueue = [];
let isProcessingQueue = false;

function addLog(message) {
  const logArea = document.getElementById("logArea");
  if (logArea) {
    const currentValue = logArea.value ? `${logArea.value}\n` : "";
    logArea.value = `${currentValue}${message}`;
    logArea.scrollTop = logArea.scrollHeight;
  }
  console.log("[LOG]", message);
}

function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = `Status: ${msg}`;
  addLog(msg);
}

function defaultSettings() {
  return {
    token: null,
    actionSetName: "",
    actionName: "",
    autoRunAction: false
  };
}

async function loadSettings() {
  if (settingsCache) return settingsCache;
  try {
    const dataFolder = await fs.getDataFolder();
    const entry = await dataFolder.getEntry(SETTINGS_FILE).catch(() => null);
    if (entry) {
      const raw = await entry.read();
      settingsCache = { ...defaultSettings(), ...JSON.parse(raw) };
      return settingsCache;
    }

    const legacyEntry = await dataFolder.getEntry(LEGACY_TOKEN_FILE).catch(() => null);
    if (legacyEntry) {
      const raw = await legacyEntry.read();
      const legacy = JSON.parse(raw);
      settingsCache = { ...defaultSettings(), ...legacy };
      await saveSettings(settingsCache);
      try { await legacyEntry.delete(); } catch (_) {}
      return settingsCache;
    }
  } catch (e) {
    addLog("Failed to load settings: " + e.message);
  }
  settingsCache = defaultSettings();
  return settingsCache;
}

async function saveSettings(partial) {
  const current = await loadSettings();
  const next = { ...current, ...partial };
  try {
    const dataFolder = await fs.getDataFolder();
    const file = await dataFolder.createFile(SETTINGS_FILE, { overwrite: true });
    await file.write(JSON.stringify(next, null, 2));
    settingsCache = next;
  } catch (e) {
    addLog("Failed to write settings: " + e.message);
  }
  return settingsCache;
}

async function loadActionSets({ forceReload = false } = {}) {
  if (actionSetsCache && !forceReload) return actionSetsCache;
  try {
    const tree = await ps.app.actionTree;
    actionSetsCache = Array.isArray(tree) ? tree : [];
    addLog(`Loaded ${actionSetsCache.length} action sets`);
  } catch (e) {
    actionSetsCache = [];
    addLog("Failed to load action sets: " + e.message);
  }
  return actionSetsCache;
}

function findActionSet(name) {
  if (!actionSetsCache) return null;
  return actionSetsCache.find(set => set.name === name) || null;
}

async function getProcessedFolder(createIfMissing = true) {
  if (!hotfolder) return null;
  if (processedFolderCache && !createIfMissing) return processedFolderCache;
  try {
    const entries = await hotfolder.getEntries();
    let folder = entries.find(entry => entry.isFolder && entry.name === PROCESSED_FOLDER_NAME);
    if (!folder && createIfMissing) {
      folder = await hotfolder.createFolder(PROCESSED_FOLDER_NAME, { overwrite: false }).catch(async () => {
        const refreshedEntries = await hotfolder.getEntries();
        return refreshedEntries.find(entry => entry.isFolder && entry.name === PROCESSED_FOLDER_NAME);
      });
      if (folder) addLog(`Processed folder ready: ${PROCESSED_FOLDER_NAME}`);
    }
    processedFolderCache = folder || null;
  } catch (err) {
    processedFolderCache = null;
    addLog("Failed to resolve processed folder: " + err.message);
  }
  return processedFolderCache;
}

async function moveFileToProcessed(fileEntry) {
  const processed = await getProcessedFolder(true);
  const originalName = fileEntry?.name || "";
  if (!processed || shouldIgnoreEntry(fileEntry)) return false;

  const refreshEntry = async () => {
    if (!hotfolder || !originalName) return null;
    const entries = await hotfolder.getEntries();
    return entries.find(entry => !entry.isFolder && entry.name === originalName && !shouldIgnoreEntry(entry)) || null;
  };

  const ensureLiveEntry = async (entry) => {
    if (!entry) return null;
    if (typeof entry.getMetadata === "function") {
      try {
        await entry.getMetadata();
        return entry;
      } catch (_) {
        return null;
      }
    }
    return entry;
  };

  const searchEntry = async () => {
    const live = await ensureLiveEntry(fileEntry);
    if (live) return live;
    const refetched = await refreshEntry();
    return refetched;
  };

  let activeEntry = await searchEntry();
  if (!activeEntry) {
    addLog(`Skipped moving ${originalName || "(unknown)"}; file already moved or missing.`);
    knownNames.delete(originalName);
    return true;
  }

  let moved = false;
  let lastError = null;

  const attemptDirectMove = async () => {
    if (typeof activeEntry.move === "function") {
      await activeEntry.move(processed, { overwrite: true });
      return true;
    }
    if (typeof activeEntry.moveTo === "function") {
      await activeEntry.moveTo(processed, { overwrite: true });
      return true;
    }
    return false;
  };

  const attemptCopyDelete = async () => {
    if (typeof activeEntry.copyTo === "function" && typeof activeEntry.delete === "function") {
      await activeEntry.copyTo(processed, { overwrite: true });
      await activeEntry.delete();
      return true;
    }
    return false;
  };

  try {
    moved = await attemptDirectMove();
  } catch (err) {
    lastError = err;
    moved = false;
  }

  if (!moved) {
    try {
      moved = await attemptCopyDelete();
    } catch (err) {
      lastError = err;
      moved = false;
    }
  }

  if (moved) {
    addLog(`Moved ${originalName || activeEntry.name} to ${PROCESSED_FOLDER_NAME}`);
    knownNames.delete(originalName);
    return true;
  }

  const stillExists = hotfolder
    ? (await hotfolder.getEntries()).some(entry => !entry.isFolder && entry.name === originalName && !shouldIgnoreEntry(entry))
    : false;

  if (!stillExists) {
    addLog(`File already absent after processing: ${originalName || "(unknown)"}`);
    knownNames.delete(originalName);
    return true;
  }

  if (lastError) {
    addLog("Failed to move file to processed folder: " + lastError.message);
  } else {
    addLog("Failed to move file: no supported move operation");
  }
  return false;
}

const IGNORED_EXTENSIONS = [".tmp"];

function normalizeName(name = "") {
  return name.toLowerCase();
}

function shouldIgnoreEntry(entry) {
  if (!entry || entry.isFolder) return false;
  const lower = normalizeName(entry.name || "");
  return IGNORED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function diffNew(currentSet, knownSet) {
  const newOnes = [];
  for (const name of currentSet) {
    if (!knownSet.has(name)) newOnes.push(name);
  }
  return newOnes;
}

async function restoreToken() {
  try {
    const settings = await loadSettings();
    if (settings && settings.token) {
      hotfolder = await fs.getEntryForPersistentToken(settings.token);
      processedFolderCache = null;
      addLog("Restored hotfolder from persistent token");
    }
  } catch (e) {
    addLog("Failed to restore token: " + e.message);
  }
}

async function saveToken(entry) {
  try {
    if (!entry) {
      throw new Error("No folder entry provided");
    }
    const token = entry.createPersistentToken
      ? await entry.createPersistentToken()
      : await fs.createPersistentToken(entry);
    await saveSettings({ token });
    addLog("Saved persistent token for hotfolder");
  } catch (e) {
    addLog("Failed to save token: " + e.message);
  }
}

async function ensureHotfolder() {
  // Try restore first
  await restoreToken();
  if (hotfolder) return hotfolder;

  // Ask the user to grant access to the Desktop\hotfolder directory
  try {
    setStatus("First-time setup: please select the Desktop\\hotfolder folder");
    const folder = await fs.getFolder();
    if (!folder) {
      setStatus("No folder selected. Cannot grant access.");
      return null;
    }
    hotfolder = folder;
    processedFolderCache = null;
    await saveToken(hotfolder);
    addLog("Hotfolder set from selected folder");
    return hotfolder;
  } catch (e) {
    addLog("Failed to set hotfolder: " + e.message);
    return null;
  }
}

async function runConfiguredAction(options = {}) {
  const { skipModal = false } = options;
  const settings = await loadSettings();
  if (!settings.autoRunAction) return;
  const actionName = (settings.actionName || "").trim();
  const actionSetName = (settings.actionSetName || "").trim();
  if (!actionName || !actionSetName) {
    addLog("Action configuration incomplete; skipping.");
    return;
  }
  try {
    const execute = async () => {
      await action.batchPlay(
        [
          {
            _obj: "play",
            _target: [
              { _ref: "action", _name: actionName },
              { _ref: "actionSet", _name: actionSetName }
            ],
            _options: { dialogOptions: "dontDisplay" }
          }
        ],
        { synchronousExecution: true, modalBehavior: "execute" }
      );
    };
    if (skipModal) {
      await execute();
    } else {
      await core.executeAsModal(execute, { commandName: "Run Configured Action" });
    }
    addLog(`Action executed: ${actionSetName} / ${actionName}`);
  } catch (err) {
    addLog("Failed to run action: " + err.message);
    setStatus("Action failed. See log.");
  }
}

async function openFileAndProcess(fileEntry, fileName) {
  try {
    await core.executeAsModal(async () => {
      await ps.app.open(fileEntry);
      addLog(`Opened in Photoshop: ${fileEntry.name}`);
      await runConfiguredAction({ skipModal: true });
    }, { commandName: "Process Hotfolder File" });
    await moveFileToProcessed(fileEntry);
    addLog(`Completed processing: ${fileEntry.name}`);
  } catch (err) {
    addLog("Processing failure: " + err.message);
    setStatus("Processing error. See log.");
  } finally {
    if (fileName) processingNames.delete(fileName);
  }
}

async function processQueue() {
  if (isProcessingQueue || fileQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  const queueLength = fileQueue.length;
  addLog(`Processing queue: ${queueLength} file(s) waiting`);
  setStatus(`Processing queue (${queueLength} file(s))`);

  while (fileQueue.length > 0) {
    const { fileEntry, fileName } = fileQueue.shift();
    if (fileEntry && fileName) {
      const remaining = fileQueue.length;
      addLog(`Processing queued file: ${fileName} (${remaining} remaining)`);
      setStatus(`Processing: ${fileName} (${remaining} in queue)`);
      await openFileAndProcess(fileEntry, fileName);
    }
  }

  isProcessingQueue = false;
  addLog("Queue processing complete");
  setStatus("Monitoring…");
}

async function populateActionDropdowns(options = {}) {
  const { actionSetSelect, actionSelect, refreshButton, persistSettings } = options;
  if (!actionSetSelect || !actionSelect) return;

  const settings = await loadSettings();

  const setPlaceholder = document.createElement("option");
  setPlaceholder.value = "";
  setPlaceholder.textContent = "Select action set";

  const actionPlaceholder = document.createElement("option");
  actionPlaceholder.value = "";
  actionPlaceholder.textContent = "Select action";

  const renderActionOptions = (setName, presetActionName = "") => {
    actionSelect.innerHTML = "";
    actionSelect.appendChild(actionPlaceholder.cloneNode(true));
    if (!setName) {
      actionSelect.disabled = true;
      return;
    }
    const targetSet = findActionSet(setName);
    if (!targetSet || !Array.isArray(targetSet.actions) || targetSet.actions.length === 0) {
      actionSelect.disabled = true;
      return;
    }
    targetSet.actions.forEach(act => {
      const opt = document.createElement("option");
      opt.value = act.name;
      opt.textContent = act.name;
      actionSelect.appendChild(opt);
    });
    actionSelect.disabled = false;
    if (presetActionName && targetSet.actions.some(act => act.name === presetActionName)) {
      actionSelect.value = presetActionName;
    }
  };

  const renderActionSets = async ({ preserveSelection = true, presetSetName = "" } = {}) => {
    const tree = await loadActionSets({ forceReload: !preserveSelection && !presetSetName });
    actionSetSelect.innerHTML = "";
    actionSetSelect.appendChild(setPlaceholder.cloneNode(true));
    tree.forEach(set => {
      const opt = document.createElement("option");
      opt.value = set.name;
      opt.textContent = set.name;
      actionSetSelect.appendChild(opt);
    });
    actionSetSelect.disabled = tree.length === 0;
    let targetSetName = "";
    if (preserveSelection && actionSetSelect.value) {
      targetSetName = actionSetSelect.value;
    } else if (presetSetName) {
      targetSetName = presetSetName;
      if (tree.every(set => set.name !== presetSetName)) {
        targetSetName = "";
      }
    }
    if (targetSetName) {
      actionSetSelect.value = targetSetName;
    }
    renderActionOptions(actionSetSelect.value || "", settings.actionName);
  };

  await renderActionSets({ preserveSelection: false, presetSetName: settings.actionSetName });

  actionSetSelect.addEventListener("change", () => {
    renderActionOptions(actionSetSelect.value || "", "");
    persistSettings?.();
  });
  actionSelect.addEventListener("change", () => {
    persistSettings?.();
  });
  refreshButton?.addEventListener("click", async () => {
    refreshButton.disabled = true;
    await loadActionSets({ forceReload: true });
    await renderActionSets({ preserveSelection: false, presetSetName: actionSetSelect.value });
    refreshButton.disabled = false;
  });
}

async function startMonitoring() {
  if (!hotfolder) {
    await ps.app.showAlert("Hotfolder not ready.");
    return;
  }

  const initialEntries = await hotfolder.getEntries();
  knownNames = new Set(initialEntries.filter(e => !e.isFolder && !shouldIgnoreEntry(e)).map(e => e.name));
  setStatus("Monitoring…");

  monitorTimer = setInterval(async () => {
    try {
      const entries = await hotfolder.getEntries();
      const files = entries.filter(e => !e.isFolder && !shouldIgnoreEntry(e));
      const currentNames = new Set(files.map(e => e.name));
      const newFiles = diffNew(currentNames, knownNames);

      if (newFiles.length > 0) {
        for (const name of newFiles) {
          if (processingNames.has(name)) {
            continue;
          }
          processingNames.add(name);
          addLog(`New file detected: ${name}`);
          const fileEntry = files.find(f => f.name === name);
          if (fileEntry) {
            // Add to queue instead of processing immediately
            fileQueue.push({ fileEntry, fileName: name });
            addLog(`Added to queue: ${name} (${fileQueue.length} in queue)`);
          } else {
            processingNames.delete(name);
          }
        }
        knownNames = currentNames;
        
        // Start processing queue if not already processing
        processQueue();
      }
    } catch (err) {
      addLog("Monitor error: " + err.message);
      setStatus("Error monitoring. See console.");
    }
  }, 2000);
}

function stopMonitoring() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    setStatus("Stopped");
  }
  // Clear queue and reset processing flag
  fileQueue = [];
  isProcessingQueue = false;
  addLog("Monitoring stopped, queue cleared");
}

function initializePanel() {
  Promise.resolve().then(async () => {
    const startBtn = document.getElementById("startMonitorBtn");
    const stopBtn = document.getElementById("stopMonitorBtn");
    const pathSpan = document.getElementById("selectedPath");
    const actionSetSelect = document.getElementById("actionSetSelect");
    const actionSelect = document.getElementById("actionSelect");
    const autoRunCheckbox = document.getElementById("autoRunAction");
    const refreshActionsBtn = document.getElementById("refreshActionsBtn");

    const settings = await loadSettings();
    if (autoRunCheckbox) autoRunCheckbox.checked = !!settings.autoRunAction;

    const persistActionSettings = () => {
      saveSettings({
        actionSetName: actionSetSelect ? actionSetSelect.value : "",
        actionName: actionSelect ? actionSelect.value : "",
        autoRunAction: autoRunCheckbox ? autoRunCheckbox.checked : false
      });
    };

    autoRunCheckbox?.addEventListener("change", persistActionSettings);
    await populateActionDropdowns({
      actionSetSelect,
      actionSelect,
      refreshButton: refreshActionsBtn,
      persistSettings: persistActionSettings
    });

    setStatus("Initializing…");
    const entry = await ensureHotfolder();
    if (entry) {
      const nativePath = entry.nativePath || "(hotfolder)";
      pathSpan.textContent = nativePath;
      setStatus("Hotfolder ready");
      startBtn.disabled = false;
    } else {
      setStatus("Hotfolder not set.");
    }

    startBtn.addEventListener("click", () => {
      setStatus("Start Monitoring");
      startMonitoring();
      stopBtn.disabled = false;
    });
    stopBtn.addEventListener("click", () => {
      setStatus("Stop Monitoring");
      stopMonitoring();
    });
  });
}

entrypoints.setup({
  panels: {
    "hotfolder-panel": {
      create(panel) {
        initializePanel(panel);
      },
      destroy() {
        addLog("Panel destroyed");
        stopMonitoring();
      }
    }
  }
});
