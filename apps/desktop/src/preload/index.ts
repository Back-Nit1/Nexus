import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, EVENTS, type Api } from "../shared/ipc";

const api: Api = {
  invoke: (channel, ...req) => (CHANNELS.includes(channel) ? ipcRenderer.invoke(channel, ...req) : Promise.reject(new Error(`Blocked channel ${channel}`))),
  on: (event, cb) => {
    if (!EVENTS.includes(event)) throw new Error(`Blocked event ${event}`);
    const listener = (_: unknown, data: any) => cb(data);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
};
contextBridge.exposeInMainWorld("nexus", api);
