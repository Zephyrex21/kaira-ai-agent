/* ===========================================================================
 * KAIRA — Electron preload
 * ---------------------------------------------------------------------------
 * Runs in an isolated context and exposes a minimal, explicit API surface to
 * the renderer via contextBridge. In Phase 1 this only advertises that the UI
 * is running inside the desktop shell (so the web UI can adapt if it wants);
 * tray/notification/window controls are added alongside those features.
 * ========================================================================= */

'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('kaira', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
});
