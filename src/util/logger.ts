/**
 * Minimal structured logger. Cloud Run / Cloud Logging parses one JSON object per line
 * and maps the "severity" field to log levels.
 */
type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

function write(severity: Severity, message: string, fields?: Record<string, unknown>) {
  const entry = { severity, message, time: new Date().toISOString(), ...fields };
  const line = JSON.stringify(entry, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
  );
  if (severity === "ERROR" || severity === "WARNING") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("DEBUG", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("INFO", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("WARNING", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("ERROR", msg, f),
};
