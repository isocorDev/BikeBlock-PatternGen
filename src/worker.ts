// Background builder for field patterns, so sliders stay responsive while
// reaction diffusion grows and the fabrication repair runs.

import { buildFieldPlate } from './fields';
import type { Settings } from './settings';

export interface BuildRequest {
  id: number;
  settings: Settings;
  quality: 'draft' | 'final';
}

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const { id, settings, quality } = e.data;
  try {
    const plate = buildFieldPlate(settings, quality, (msg) => self.postMessage({ id, progress: msg }));
    self.postMessage({ id, plate });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
