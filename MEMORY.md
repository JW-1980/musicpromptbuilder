# MEMORY.md
**File:** `MEMORY.md`

## Core DSP Mathematics & Thresholds
- **RMS Noise Gate:** $\text{RMS} = \sqrt{\frac{1}{N} \sum x_i^2}$. If $\text{RMS} < 0.015$, bypass pitch detection to save CPU cycles.
- **Vocal Frequency Bounds:** Cap Autocorrelation search between $65\text{ Hz}$ (C2) and $1050\text{ Hz}$ (C6).
- **Web Worker Transferables:** Always use `Transferable` objects (`Float32Array` buffers) when passing audio data between the main UI thread and the background DSP worker to prevent memory copy overhead.

## Suno v5.5 Engine Constraints
- **Absolute Character Limit:** 1,000 characters. Exceeding this causes Suno to silently truncate or hallucinate.
- **Negative Exclusions:** Must be formatted exactly as `[Exclude: item1, item2]`.
- **Metatag Syntax:** Structural tags must use standard brackets (e.g., `[Pre-Chorus]`, `[Guitar Solo]`). 
- **Workspace Profiles:** The "Neon" profile weights techno, Scandi house, and French electro tags higher. The "Aetheris" profile weights progressive trance, Afro house, and ambient tags higher.

## Automated Testing Protocols
- E2E testing framework must run entirely locally, mocking the Web Audio microphone stream with a static sine wave buffer to validate the pitch detection pipeline during overnight automated analysis runs.