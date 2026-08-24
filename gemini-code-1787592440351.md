<!-- Filename: docs/PHP-SQLITE-QUALITY-CHECKLIST.md -->
# VANILLA JS & PHP/SQLITE QUALITY CHECKLIST

Use this checklist during the Agent's self-review phase. Because this project relies on a strict single-file zero-dependency frontend and an optional lightweight backend, both environments have strict standards.

## 1. Frontend: Single-File Vanilla JS Integrity
- [ ] **Zero External CDNs:** Are all CSS styles, fonts (using system stacks), and SVG icons fully embedded in `index.html`?
- [ ] **Web Worker Isolation:** Is the `AnalyserNode` FFT math and Autocorrelation algorithm running in a background Web Worker to keep the UI at 60 FPS?
- [ ] **DOM Performance:** Are CSS Container Queries and native View Transitions used instead of heavy JavaScript layout calculations?
- [ ] **Character Budget Enforcement:** Does the string compiler rigorously check `string.length <= 1000` on *every* state change and trim at word boundaries?
- [ ] **Anti-Simulation:** Is the Web Audio API pulling actual microphone data (no random `Math.random()` pitch fakers)?

## 2. Backend: Modern PHP 8.4 Foundation
- [ ] `declare(strict_types=1);` present at the top of every PHP file.
- [ ] Typed properties, argument types, and return types enforced everywhere.
- [ ] Enums used for fixed values (e.g., `ModelVersion::V5_5`).
- [ ] Centralized Exception handling with generic client errors (no stack traces leaked in production).

## 3. Backend: SQLite Database Integrity
- [ ] `PRAGMA journal_mode = WAL;` enabled for concurrent read performance.
- [ ] `PRAGMA foreign_keys = ON;` explicitly set on every connection.
- [ ] `PRAGMA busy_timeout = 5000;` configured to prevent lock timeouts.
- [ ] `STRICT` table definitions enforced on all SQLite tables.
- [ ] Numbered SQL migration files tracking schema changes.
- [ ] Database file placed outside the web-accessible root directory.

## 4. Backend: Security & API Design
- [ ] All database queries executed exclusively using PDO Prepared Statements.
- [ ] Output escaping applied with `htmlspecialchars($str, ENT_QUOTES, 'UTF-8')`.
- [ ] Strict CORS headers configured to allow only the local client origin.
- [ ] JSON endpoints validate payload shapes and enforce the 1,000-character prompt constraint before storage.