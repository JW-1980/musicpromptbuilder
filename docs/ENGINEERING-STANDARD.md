<!-- Filename: docs/ENGINEERING-STANDARD.md -->
# ENGINEERING STANDARD — AUTONOMOUS AGENT EDITION

This standard defines the engineering bar, truthfulness rules, and architecture criteria for the SunoPrompt Studio project.

---

## 1. GLOBAL PRINCIPLES

### 1.1 Correctness Over Speed
Never claim a feature is complete unless all execution paths exist and run in production code. Stubs and placeholder UI elements are strictly forbidden.

### 1.2 Anti-Simulation Rules
* The Web Audio pitch detection engine must process live audio buffers via the Web Audio API. 
* The character counter must evaluate string character length dynamically on every input change.

---

## 2. ADVANCED ARCHITECTURE STANDARDS

### 2.1 Web Worker Execution
* All computationally expensive audio analysis (FFT, autocorrelation) MUST be executed within a background Web Worker. The main thread is reserved strictly for UI rendering (WebGL 3D visualizers, CSS View Transitions).

### 2.2 DOM Optimization & Layout
* **DOM Virtualization:** Any list exceeding 50 items (Presets, History) must utilize virtual scrolling. Rendering thousands of hidden DOM nodes is prohibited.
* **CSS Container Queries:** Rely on `@container` queries instead of standard viewport media `@media` queries to ensure UI components are perfectly modular and can reflow when placed inside split-pane workspace profiles.

### 2.3 Resiliency
* Microphone permission denial must be handled gracefully with clear visual troubleshooting steps.
* Tri-Mode AI fallbacks must chain silently. A failed API call must not throw a fatal unhandled promise rejection.