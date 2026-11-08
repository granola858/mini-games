---
target: Meowdoku 貓咪數獨
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/user/mini-games/games/meowdoku/index.html"
target_fingerprint: "sha256:4197ab3cdc9b87a41406864530c0c4a2f5775889fcfe55e6303afb88d30c712f"
target_path: /home/user/mini-games/games/meowdoku/index.html
timestamp: 2026-11-08T13-01-09Z
slug: games-meowdoku-index-html
closed: true
---
Method: dual-agent (A: design review subagent · B: detector subagent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Wrong-cell flash too short (400 ms); no "x of N cats" progress |
| 2 | Match System / Real World | 3 | Paw print normally means "a cat was here"; here it means "no cat" and needs a parenthetical |
| 3 | User Control and Freedom | 2 | No undo; 清空標記 also wipes confirmed cats; dismissing the lose card loses same-puzzle retry |
| 4 | Consistency and Standards | 3 | Won and lost boards look identical (both .frozen grey) |
| 5 | Error Prevention | 2 | Help says "tap again to cancel" but a re-tap within 280 ms places a cat and costs a heart |
| 6 | Recognition Rather Than Recall | 3 | Double-tap window and tool x gesture combinations must be remembered |
| 7 | Flexibility and Efficiency | 3 | Drag-paint, double-tap, keyboard good; no undo, no auto-mark of cells ruled out by a confirmed cat |
| 8 | Aesthetic and Minimalist Design | 3 | ~40% of phone viewport above the board is setup chrome |
| 9 | Error Recovery | 3 | Clear toast; but the mistaken cell is wiped, no persistent mark |
| 10 | Help and Documentation | 3 | Concise help; no diagram of the diagonal-adjacency rule |
| **Total** | | **28/40** | **Good** |

## Design Specificity Verdict

LLM assessment: the cat layer is authored for this product (8 per-region cat portraits, 16 recorded meows, paw note, "貓咪都回家了！", the win-card meow parade with each cat on its region color). Everything around it is category-interchangeable: the site-wide frame and a flat colored grid like any Queens/Star Battle clone. "Home" exists only in win copy; regions are never drawn as homes and there is no visible tray of cats waiting to go home.

Deterministic scan: `impeccable detect` on games/meowdoku/index.html and the directory: 0 findings; URL scan at 390 and 1280: 0. Runtime injection across 11 states: 2 advisories on the win card only: low-contrast `span.bobo-result__best` 4.39:1 (#765bd8 on #f3f0fd, true positive, missed by the LLM review because the card is injected at runtime) and flat-type-hierarchy (false positive: stat values counted as body text, page h1 compared with dialog h2).

Visual overlays: injection ran headlessly; no human-visible browser in this cloud environment, so no [Human] overlay tab.

## Overall Impression

Tactile and charming, with a real win peak. Biggest problem: the rules are unforgiving of normal touch corrections (the documented cancel gesture costs a heart) and the won board goes the same dead grey as a loss. Biggest opportunity: make "cats going home" visible on the board, not only in copy.

## What's Working

1. Win card tied to the board: each cat on its region's color, staggered hop, a real meow; one cat stays on a loss.
2. Input engineering: coordinate hit testing, interpolated drag-paint, second-finger guard, keyboard grid, labelled cells, 2 px region boundaries so color is not the only cue.
3. Consequence-aware microcopy at the moment of risk (cat tool hint, confirm dialogs, same-puzzle retry).

## Priority Issues

1. [P1] Normal corrections cost hearts. Re-tap within 280 ms in paw tool places a cat (meowdoku.js handleBoardPointerDown; verified 3→2 hearts). Cat tool has no guard for pawed cells. Wrong placement wipes the cell. Placements that conflict with an already-confirmed cat still cost a heart. Fix: lock pawed cells against cats; only count a double-tap when the first tap pawed an empty cell; auto-stamp a known-empty mark after a wrong placement; reject visible rule conflicts without a heart. Command: /impeccable harden
2. [P1] Won board uses the same grey .frozen state as a loss (updateGameOverUI; meowdoku.css .frozen). "看盤面" shows a dead board, near-black in dark. Fix: split .won / .lost; won keeps full color, fades paws, small cat settle; lost keeps veil, consider "看答案". Command: /impeccable delight
3. [P2] Error feedback weak, short, far away. Error red ~1.4:1 vs warm regions, 400 ms then wiped, no non-hue signal under reduced motion; toast pinned top and shrink-wrapped to ~195 px so it wraps. Fix: non-hue mark (ring or cross) that persists as known-empty; move message near board/hearts; width max-content. Command: /impeccable harden (+ polish for toast)
4. [P2] Dark theme weakest despite night use. Warm jewel tones crowd (copper/amber ~0.074, garnet/berry ~0.077 OKLab), paws ~2:1 in both themes, focus ring <3:1 on amber/teal/copper/violet, dark active size segment 1.12:1. Fix: widen lightness alternation (~0.40 vs 0.62), separate copper/amber, paws ≥3:1, real fill/outline on active segment. Command: /impeccable colorize
5. [P2] Too much chrome above the board; tool toggle out of thumb reach; hint 2→1 lines shifts board 20 px; desktop 8×8 board only 300 px; landscape board below fold. Fix: tool toggle below board, demote size picker, fixed-height hint, let board use available height. Command: /impeccable layout

## Persona Red Flags

- Casey (one-handed, night): tool toggle at y≈232–275 of 844; re-tap to undo a paw costs a heart; board jumps 20 px after tool switch; reload after a loss removes same-puzzle retry.
- Jordan (first-timer): default tool is paw so the first "place a cat" tap stamps a paw; paw = no cat must be decoded; mistaken cell goes blank; lose subtitle reads as kept-and-cleared and doesn't say correct cats are removed; answer never shown.
- Sam (screen reader / keyboard): keyboard grid works; correct placement never announced (placeCat success branch has no live-region message); no success signal when muted; paws ~2:1; reduced motion leaves only a hue change for errors.

## Minor Observations

- Outcomes announced twice (toast + card title).
- "1 分 23 秒" wraps in the 96 px stat tile on phones.
- 清空標記 stays enabled on a won board and leaves an empty frozen board.
- "貓爪（沒有貓）" wraps to 3 lines at 320 px.
- Tool icons mismatch: solid paw beside a thin outline cat mask.
- No visible timer during play, yet the end card frames speed (用時, 新紀錄).
- Cat art mixes 4 solid and 4 thin-line cats; uneven visual weight.

## Questions to Consider

- Should placements be checked against the hidden answer at all? What if only visible rule conflicts lit up, plus a no-hearts bedtime mode?
- Once a cat is confirmed, its row, column, region and neighbours are known empty. Why paint those paws by hand?
- Would an empty cushion read as "no cat" without a parenthetical, where a paw print does not?
- What if a tray of cats waiting to go home were visible from the first second and emptied as you play?
