import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getDefaultConfigPath: () => ipcRenderer.invoke("get-default-config-path"),
  loadConfig: (configPath: string) =>
    ipcRenderer.invoke("load-config", configPath),
  startProc: (procId: string) => ipcRenderer.invoke("start-proc", procId),
  stopProc: (procId: string) => ipcRenderer.invoke("stop-proc", procId),
  restartProc: (procId: string) => ipcRenderer.invoke("restart-proc", procId),
  onProcessOutput: (fn: (data: { procId: string; text: string; isStderr: boolean }) => void) => {
    ipcRenderer.on("process-output", (_e, data) => fn(data));
  },
  onProcStarted: (fn: (procId: string) => void) => {
    ipcRenderer.on("proc-started", (_e, procId) => fn(procId));
  },
  onProcStopped: (fn: (data: { procId: string; code: number | null }) => void) => {
    ipcRenderer.on("proc-stopped", (_e, data) => fn(data));
  },
});
