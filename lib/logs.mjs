const MAX_LOG_ENTRIES = 20;
const logBuffer = [];

export function addLogEntry(entry) {
  logBuffer.unshift({
    id: entry.id || String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7),
    timestamp: entry.timestamp || new Date().toISOString(),
    providerId: entry.providerId || "-",
    model: entry.model || "-",
    endpoint: entry.endpoint || "-",
    status: entry.status || 200,
    latencyMs: typeof entry.latencyMs === "number" ? entry.latencyMs : 0,
    error: entry.error || ""
  });
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.length = MAX_LOG_ENTRIES;
}

export function getLogEntries() {
  return [...logBuffer];
}

export function clearLogEntries() {
  logBuffer.length = 0;
}
