# SKILL-TRACK Developer Guidelines & Engineering Rulebook (`DEVELOPER.md`)

This living rulebook establishes the non-negotiable architectural, algorithmic, UI/UX, and engineering protocols for all developers and AI agents working on the SKILL-TRACK workspace (`skillprax-backend` & `skillprax-frontend`).

---

## Core Engineering Protocols

### PROTOCOL A: Interactive Clarification Gate
- **No Speculative Refactoring**: Never write speculative code blocks or perform unprompted major restructuring based on raw assumptions.
- **Clarification Priority**: Before executing structural changes across existing layouts or business logic, identify ambiguities and present targeted architectural questions to align on requirements, data models, and user experience.
- **Change Justification**: Provide clear rationale and verify impact across both frontend components and backend services before touching working implementations.

---

### PROTOCOL B: Immutable Baseline Logic & Continuity
- **Preserve Existing Functionality**: Do not drop, delete, or break working state variables, telemetry metrics, database relationships, API routes, or prop interfaces.
- **Telemetry Row Invariant**: The XP meters, flame streak badges, freeze shields, and 7-day volume cadence bar charts are permanent core telemetry features and must never be stripped or displaced.
- **State Decoupling Standard**: Keep inspection states (`viewingStepIndex`, review modes) decoupled from active database progression states (`activeStepIndex`) to ensure retrospective review never overwrites user progress.
- **Zero Link Rot Guarantee**: All external study resources and failure remediation links must resolve from verified sources (e.g., Tavily API live queries). Never hardcode fake or dead links.

---

### PROTOCOL C: Zero-Bug & No-Placeholder Production Execution
- **100% Complete Implementation**: Always author complete, syntactically valid, production-ready code. Never leave placeholders, truncated skeletons, or `// rest of code here` shortcuts.
- **Strict Verification Build**: Code must compile cleanly with `npm run build` (exit code 0) across both frontend and backend before considering a task complete.
- **Defensive Layout Design**: Enforce explicit aspect ratios (e.g., 16:9 for video viewports), strict overflow handling (`overflow-hidden`, `overflow-x-auto`), zero black placeholder rectangles, and comprehensive fallback states.

---

### PROTOCOL D: Multi-Agent Portable Handoffs & Clean Architecture
- **Layered Separation of Concerns**:
  - **Directives (Layer 1)**: SOPs and architectural specs in Markdown.
  - **Orchestration (Layer 2)**: Agentic routing, error handling, and component orchestration.
  - **Deterministic Execution (Layer 3)**: Strongly typed TypeScript/Node services and Prisma queries.
- **Self-Documenting Code**: Standardize naming conventions, strict TypeScript interfaces, JSDoc annotations, and descriptive event handlers so that any AI model family (Claude, Gemini, Codex) can parse the workspace with zero context loss.

---

### PROTOCOL E: Premium Visual, Motion & Aesthetic Standards
- **Design Aesthetic**:
  - Surfaces: Pure White (`#FFFFFF`), Slate-50 (`#F8FAFC`), translucent dark glassmorphism surfaces where applicable (`backdrop-blur-md` / `backdrop-blur-[14px]`).
  - Brand Palette: Tech Blue (`#0284C7`), Warm Amber (`#F59E0B`), Mint Emerald (`#10B981`), Rose (`#F43F5E`).
  - Borders & Shadows: Subtle hairline borders (`border-slate-200/90`, `border-emerald-200/80`), soft shadows (`shadow-sm`, `shadow-xl`).
- **Motion & Spring Physics**:
  - **Snappy Transitions**: `mass: 1, stiffness: 400, damping: 30` (for tabs, buttons, pills, toggles).
  - **Smooth View Transitions**: `mass: 1, stiffness: 140, damping: 22` (for page reveals, modals, hero sections).
  - **Orchestrated Entrances**: `staggerChildren: 0.05` for card lists and node flows.
  - **Continuous Looping Video Background**: Maintain hardware-accelerated video background with watchdog recovery and zero playback freezing across all routes.
