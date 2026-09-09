# Tactical Blue design QA

final result: passed

This result covers the optional interface's visual and interaction review, not repository-wide release readiness. Existing functional and CI defects are recorded separately.

## Reference and evidence

- Source visual truth: user-supplied `codex-clipboard-68d6726f-720f-4970-bf46-28249fa768aa.png` (2547 × 1516), Arknights × P3R navigation screenshot. The video-player chrome is excluded from the design target.
- Backgrounds: user-supplied 1672 × 941 PNGs, copied unchanged to `src/assets/tactical/closer.png` and `falling.png`.
- Implementation: local Vite page, optional `tactical-blue` mode; screenshots in `docs/tactical-blue/screenshots/`.
- Main comparison: `home-closer.png` (934 × 900 CSS/bitmap viewport, approximately 1×); source and implementation opened together in the same comparison input. Different aspect ratios and product content are intentional; this is a functional adaptation, not pixel-for-pixel game reproduction.
- Additional viewports: 1440 × 900 CSS, 800 × 600 CSS. DOM measurements confirm no horizontal document overflow; at minimum height the overview scrolls and all footer controls remain reachable. The browser's wide-viewport screenshot capture includes a scaled canvas, so it is not used for pixel-level scoring. Temporary viewport override was reset.
- States: home, both backgrounds, keyboard focus, background preferences, archive, configuration, runtime logs, empty workbench, typed input, sent browser test session, restored modern interface.

## Findings and iterations

1. P2: narrow navigation rows compressed labels. Increased responsive row heights and prevented child shrink. Recaptured `home-closer.png` and minimum-window scroll state: labels are readable and entrances remain reachable.
2. P2: Solid control-center flex layout gave the input only intrinsic width. Scoped input-row/editor width and minimum height to this mode; wrapped model/status controls. `workbench.png` records the final usable input area.
3. P2: inherited error red and translucent pale log background had weak contrast. Scoped the log background and error/diagnostic tokens to navy and light pink. Recaptured `diagnostics.png`: error text and levels are readable.

## Acceptance

- Typography: large condensed italic English navigation, smaller Chinese functional labels; body forms and logs keep normal alignment. Reference navigation hierarchy is retained without game-only currencies or advertisements.
- Layout: a background character plane, left identity plane, and right navigation plane establish depth. Full button hit areas remain available; scene elements cannot intercept clicks.
- Color: cyan/blue navigation on dark navy; internal reading panels reduce background prominence. Independent scene opacity is constrained to 15–70% and persisted.
- Assets: original supplied PNGs are used, not substitute drawings; object-fit preserves aspect ratio. The third image is only a reference and is not embedded in the application.
- Copy: actions use real Pylon semantics and current session/agent counts. Browser mock states are not represented as native connection evidence.
- Motion: staggered entrance occurs on entering the command deck; hover/focus/press feedback belongs to the actual buttons; panel entrance belongs to navigation; artwork selection crossfades; pointer movement affects only the decorative plane. Reduced-motion disables entrance/background motion. No standalone animation demonstration or auto-rotating background.
- Functionality: optional mode selection and switch back preserve the browser session. Archive/configuration/runtime navigation and input/send feedback were exercised. Shared input/permission transport/component tests pass. Native fixture verification separately covers actual Tauri/ACP send, cancel, persistence and resume.

No remaining P0/P1/P2 visual issue was identified in these reviewed states. This is a reviewed game-inspired desktop interface, not a claim of equivalent commercial game production quality, controller support, or frame-time certification. Native visual automation was unavailable; native checks used the application's real CLI and a deterministic ACP fixture. Real model/provider credentials and real tool execution were not tested.
