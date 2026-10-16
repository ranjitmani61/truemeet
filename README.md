# TrueMeet

Premium, self-hosted video meetings in the browser. No accounts, no downloads, no time limits.
Audio and video go directly between participants (WebRTC, DTLS-SRTP), and the server only relays signaling.

```bash
npm start              # http://localhost:3000  (busy? PORT=3100 npm start)
npm test               # unit tests (director, time machine, ledger, co-pilot, tracker, witness) + server tests
npm run test:e2e       # headless 2- and 3-browser suites (see Testing)
```

Requires Node.js 24.2 or later. It has no npm dependencies.

## Features

**Meeting**
- Lobby with camera preview, mic test, device pickers and setup checks.
- 16:9 auto-fit gallery and speaker view. Active-speaker highlight and audio-level bars on name tags. Pin a tile by double-clicking it.
- Screen sharing, chat, reactions, raise hand, noise suppression, native background blur, connection-quality bars.
- A warning appears when you talk while muted. Join and leave chimes.

**Auto-Mode — the meeting director** (A key, or the wand in the dock)
- **Auto-spotlight**:
  - The stage follows whoever is talking. With 3 or more people, the active speaker is spotlighted.
  - A shared screen keeps the stage while it is being annotated.
  - After 10 seconds without pointer, pen or pin activity, if someone else is speaking, the stage moves to them. New ink on the share brings it back.
  - Whiteboard activity opens the board, and Auto-Mode closes it again once things go quiet.
  - Changes wait 1 second before switching so the stage doesn't flicker, and tiles glide between positions (View Transitions).
- **Auto-highlights**: these use the same notes system as the B key and appear as `[Auto]` in the export with meeting and recording timestamps. They come from:
  - caption phrases: action item, deadline, let's decide, next step, to-do, agreed, follow up
  - reaction bursts: 3 or more reactions from 2 or more people within 5 seconds
  - crosstalk: 2 or more people talking for more than 1.5 seconds
  - Only one participant acts as the director (the lowest id among Auto-Mode users), so moments are never logged twice.
- **Away protection**: an unmuted mic that stays silent while there's no keyboard or mouse input and no camera movement first gets a "Still there? Mute?" prompt (after 2 minutes). After 5 minutes it is muted automatically. Camera movement is a 32×18 luminance frame difference computed locally.

**Novel collaboration capabilities**
- **Screen Time Machine**:
  - Every viewer keeps a private, local 2-minute rewind of any shared screen (one 960 px JPEG every 2 s, held in memory only).
  - Scrub the timeline on the share tile to rewind without disturbing anyone. A **Viewing -34s** badge and **Jump to live** button show while you're rewound.
  - Marks and pins you make on a past frame live on a separate private layer and are never sent live.
  - **Beam to presenter** sends that frame plus your marks to the presenter only: a validated JPEG of at most 200 KB, plus your strokes and pins as structured data.
  - The presenter gets a card ("Ada is referencing your screen from 34s ago"), inside their pop-out presenter window if it's open, that opens a side-by-side **then vs. now** comparison.
- **Lean-in whisper**: hold the ear button on someone's tile (or hold **Alt** over it, or press-and-hold Space/Enter on the focused button).
  - Your mic is cut for everyone else on each individual connection, so the room truly can't hear. Audio already in flight plays out within about one round trip.
  - Both of you hear the room at 25% in the left ear and each other at 100% in the right (Web Audio stereo panner + gain, only while a whisper is active).
  - Glowing tiles and a notice mark the whisper. Releasing restores everything; leaving the window or the partner leaving also ends it.
- **Decision ledger**:
  - Any highlight can become a **Proposal**. Everyone can **Sign & Agree** with a per-tab ECDSA P-256 key whose private half never leaves the browser.
  - The server verifies each signature (using the same `ledger.js`) and refuses forgeries. Every browser verifies again against the key it knows for that person.
  - Each signing key's fingerprint is part of the pairwise safety code, so matching codes also prove the server didn't swap keys.
  - **Download notes** includes a human-readable ledger plus a machine-verifiable JSON block. `verifyLedger()` from `public/ledger.js` checks it offline and rejects any edited decision text, swapped key or borrowed signature.
- **Polite turn engine**:
  - When two or more people talk over each other for more than 350 ms, both stop and an awkward pause follows, the Auto-Mode director posts **"Collision detected — Ada go ahead, then Bo"**. Whoever has spoken least so far goes first.
  - If someone unmutes, says less than 200 ms while another person is talking, and mutes again within 3 s, the **host privately** gets "Bo tried to jump in — invite them to speak?" with a one-click nudge. This is detected in the host's browser, never transmitted.
- **Snip to whiteboard**: drag the **scissors** tool over a live (or rewound) shared screen.
  - That exact region is cropped from the video at source resolution, correcting for letterboxing, and lands on everyone's whiteboard as a captioned card.
  - Cards sit in a side-by-side grid so the team can annotate and compare captured states while the presenter moves on. Late joiners get them too.

**Living anchors, proposed moves, Proof-of-Frame** (computer vision + crypto, zero dependencies)
- **Living anchors**: a pin dropped on a shared screen carries a 16×16 grayscale template of what it points at (256 bytes, captured from the exact frame you clicked).
  - Every participant tracks that template on the video *they* see, about 12 times a second: zero-mean normalized cross-correlation (immune to codec brightness/contrast shifts), a ±12 px local search with sub-pixel refinement, at 320 px analysis width. No extra network traffic, and each pin is locked to its viewer's own frames.
  - When the feature disappears (scrolled away, window closed), the pin docks at the nearest edge as an **Off-screen** pill. A coarse-to-fine whole-frame scan (half resolution, all four sampling phases) re-locks it when it returns, and refuses to re-lock onto one of several identical copies.
  - Late joiners receive the template with the pin, so everyone follows the same feature. Featureless spots (flat color) aren't tracked; those pins stay where they were dropped.
  - Cost, measured: 0.2 ms per tracked pin per tick, plus 0.6 ms to read the frame. A re-lock scan is 4.3 ms, run about 4 times a second just after the feature is lost and once a second after 3 s.
- **Proposed move** (the four-arrows tool): drag a box around part of a shared screen, then drag the lifted region where it should go (or use the arrow keys, Shift for bigger steps, and Enter).
  - Everyone, the presenter included and inside the pop-out presenter window, sees the region's **live** pixels at the new spot with a "Proposed move · Ada" tag, an arrow from the old spot, and a background plate where it was.
  - The plate is a Coons patch (transfinite interpolation) through the live pixels ringing the region. It reproduces solid and linear-gradient UI backgrounds exactly and refreshes about 8 times a second.
  - The `screen-patch` message is schema-checked (both places inside the frame, at least 2% in size), room-wide, and allowed only while the sharer allows annotation. The author or the sharer dismisses it for everyone; anyone can hide it for themselves.
- **Proof-of-Frame witness**: while you share, every 2 s your browser computes a 128-bit **dual-band perceptual digest** of the frame it is sending. It chains it (`chain = SHA-256(prev:seq:digest:t)`) and signs it with your decision-ledger key, the same key that is folded into the safety code.
  - **Layout band**, 64 bits: dHash, comparing the mean luma of each of 9×8 cells with its right neighbour.
  - **Detail band**, 64 bits: eHash, the edge energy (mean |∂x|+|∂y|) of each of 8×8 tiles compared with the median non-empty tile. Box averages dilute thin UI detail into a flat backdrop; edge energy doesn't. Tiles under a noise floor of 8 levels count as flat, so codec noise never sets a detail bit.
  - Two digests show the same frame when **both** bands are close: at most 7 differing layout bits and 8 detail bits.
  - The server refuses frames that don't verify, don't extend your chain, are replayed, or are more than 30 s old (`witness-frame`, at most one per 500 ms).
  - Each viewer verifies the signature and the chain again. It digests what its own decoder displayed in the window from t−0.4 s to t+2.2 s, and the share's badge reads **Witness Verified · Frame #N** when both bands agree. Two mismatches in a row show **Frame Mismatch**; a bad signature or broken chain shows **Tamper detected**.
  - Clicking the badge saves the exact frame on screen as PNG evidence. **Download notes** lists every frame (VALID / MISMATCH / INVALID, with the measured bit distance) plus a machine-verifiable chain.
  - **`/verify.html`** re-checks the notes offline in the browser (ledger and witness), and proves which signed frame a saved screenshot matches.
  - **What it proves, measured** (`witness.test.js`, `e2e/deep-tech.mjs`):
    - **Real WebRTC:** frames match at 0–1 layout and 0 detail bits (3 runs, 30 frames).
    - **Synthetic codec damage:** a harsher simulation, applied once and twice, stays within 5 layout and 8 detail bits on 90 synthetic UI screens.
    - **Look-alike screens:** 64-bit dHash alone mistook 51 of 435 pairs (12%) for the same frame. The dual-band digest mistakes **0 of 435** on that benchmark, and **10 of 1770 (0.6%) on 60 more screens outside the benchmark**, down from 235 (13.3%).
    - **The remaining ceiling:** at 128 bits some screens really are look-alikes (same layout, same busy tiles). It is perceptual, not pixel-exact: one edited line of text is still "the same frame". It proves *which screen* was shown, not every character on it.
    - **What was ruled out:** a 256-bit mean-grid dHash didn't separate look-alikes either. A noise floor of 3 or less let codec noise flip up to 26 detail bits.

**Live Polyglot + private "Best Answer" Co-Pilot**
- **Live cross-language captions**: pick your language under More → Translate captions. Every caption from someone speaking another language is translated on your device as they speak, interim words included, with an `EN → ES` tag. Results are cached and the newest always wins.
- **Co-Pilot**:
  - When someone else asks a question, raises an objection, names a price or a deadline, or asks for a status update, you get a card **only you can see**.
  - The card shows what they're asking, in your language, plus **two ranked replies** grounded in the meeting's own pins, highlights, proposals, whiteboard snips and recent captions.
  - Each reply appears in **your language and in theirs**. The version in their language is phrased for reading aloud ("$5k" becomes "5 thousand dollars", and Hindi gets a romanized "Say it: …" guide). **Read aloud** previews it with speech synthesis; **Send** posts it to the meeting chat in their language with one click.
  - `public/copilot.js` is deterministic and offline:
    - intent detection with Unicode-aware whole-word cues in English, Spanish, French, German, Hindi, Portuguese and Italian
    - date, money and percentage extraction
    - intent-weighted retrieval (for a status question, current-state pins outrank decisions; for deadlines, decisions come first)
    - reply templates written natively in all seven languages
  - Meeting facts are quoted verbatim, never machine-translated, so a commitment reads exactly as it was written.
  - When Chrome's on-device **LanguageModel** (Prompt API) is already `available`, replies are refined with a JSON-schema-constrained prompt grounded in the same facts, then translated on-device. TrueMeet never starts a model download on its own.
  - **Speak to room**: TrueMeet says your chosen reply aloud, in the asker's language, on every other participant's device, and shows it as a banner on your tile. This works around browsers being unable to route speech synthesis into a microphone.
    - The message is validated, at most 280 characters, room-wide only, and limited to one every 2.5 s per person.
    - Your own browser stays silent, so your mic never carries the reply twice.
    - Speech synthesis bypasses echo cancellation, so each listener's mic is briefly ducked, and their own captions paused, while the voice plays. Otherwise every listener would re-broadcast the reply.
    - With no voice installed for that language, listeners get a soft Web Audio cue and a text-only banner instead. Listeners who chose another caption language also see a translation.
  - Toggle under More → Co-Pilot suggestions.

**Time-travel catch-up**
- The server keeps a bounded buffer per room: the last 40 final caption lines and up to 200 highlights.
- People admitted from the waiting room, or joining more than 30 seconds into a meeting, get a dismissible **Catch-up card**. It shows how long the meeting has run, key moments (incl. `[Auto]` ones), recent conversation, and buttons for the whiteboard and the notes.
- The history is also merged into their notes, deduplicated by note id.

**Collaboration**
- **Annotation on shared screens**: viewers use a laser pointer or pen on top of the shared screen. The presenter can switch this off and clear it at any time. Annotations are visual only; nobody controls anyone else's computer.
- **Presenter view**: a floating, always-on-top window (Document Picture-in-Picture) shows viewers' pointers and drawings over whatever app you're presenting.
- **Whiteboard**: shared real-time drawing with colors, undo and clear, and saving as PNG. Late joiners receive the current board from the host.
- **Numbered pins**: drop `#1`, `#2`… with a short note anywhere on a shared screen or the whiteboard.
  - The server assigns numbers and timestamps, so everyone sees the same order, and echoes each pin back to its author.
  - Pins are DOM buttons with text-node notes. They render live in the sharer's pop-out presenter window.
  - The pin author or the sharer can resolve a pin (the host can too on the whiteboard).
  - Every pin goes into the exported notes (number, author, time, note, resolution).
- **Live captions** via the Web Speech API, plus a transcript.
- **On-device caption translation** via Chrome's built-in Translator API (Chrome 138+). Translation runs in your browser.
- **Highlights** (B key): mark moments. Notes include meeting time and, if you're recording, recording time.
- **Download notes**: highlights, transcript (with translations) and chat as `.txt`.

**Trust and control**
- **Safety codes**: per-participant 6-digit codes derived from the DTLS fingerprints both sides negotiated. Read them aloud: matching codes mean no one is intercepting the call, not even a compromised signaling server.
- **Waiting room**: the host admits or denies each person. If everyone leaves, the person who has waited longest is let in as host.
- **Host controls**: lock, mute all, remove participant. Host role passes on automatically.
- **Talk-time balance**: the host privately sees who has spoken how much. It's measured locally from audio levels.
- **Recording**: everyone's audio is mixed locally and saved as `.webm`. Everyone sees a REC badge.

**Browser fallbacks**: capabilities are detected once.
- Caption translation uses the `Translator` API, the older `window.translation` preview, or shows a "Not supported" badge.
- The presenter view uses Document Picture-in-Picture, falls back to video Picture-in-Picture, or shows "Not supported".
- Live captions are greyed out where the Web Speech API is missing.
- Nothing throws when an API is absent.

**Keyboard shortcuts:** M mic · V camera · S share · W whiteboard · A Auto-Mode · H hand · L captions · B highlight · C chat · P people · Esc stop annotating.

## Deploying beyond localhost

Camera and microphone access needs HTTPS. Peers behind strict NATs also need a TURN server.

```bash
TLS_CERT=cert.pem TLS_KEY=key.pem PORT=443 \
TURN_URL=turn:turn.example.com:3478 TURN_USERNAME=user TURN_CREDENTIAL=secret \
npm start
```

## Design

- `server.js`: static files and signaling over Server-Sent Events + `POST /api/signal`.
  - It is the single authority for host and waiting room, pin numbers, and the catch-up buffer.
  - Every relayed type has a schema that **rebuilds the payload from allowed fields only**:
    - types are checked
    - coordinates are clamped to [0, 1]
    - strings are capped (notes 140, captions 500, chat 2000)
    - unknown fields are dropped
    - the server stamps `from`/`name`
  - Annotation on a share is only accepted while the sharer allows it. Only the sharer can wipe all marks, and only the host can seed whiteboard syncs.
  - The catch-up buffer lives in memory and disappears when the room empties.
- `public/app.js`: full-mesh WebRTC. The newcomer sends offers, so no glare is possible. Each peer link has one audio and one video transceiver, so camera/screen swaps use `replaceTrack` with no renegotiation.
- `public/director.js`: Auto-Mode decision logic as pure functions, unit-tested in `director.test.js`: phrase triggers, burst/crosstalk/collision detectors, turn order, hesitation detector, focus choice with dwell, away monitor, frame diff.
- `public/timemachine.js`: rewind ring buffer and frame geometry (crop, fit, whiteboard slots), with thin capture helpers. Unit-tested.
- `public/ledger.js`: canonical JSON, ECDSA identities, sign/verify, and ledger verification. It runs unchanged in browsers, in the server, and in offline verification. Unit-tested, including tamper cases.
- `public/copilot.js`: Co-Pilot intent detection, entity extraction, context retrieval, native-language reply templates, read-aloud phrasing and Devanagari romanization. Pure and unit-tested in `copilot.test.js`.
- `public/spatial.js`: the whisper's Web Audio mix, engaged only while a whisper is active, so Chrome's normal echo-cancellation path is used the rest of the time.
- `public/tracker.js`: living anchors (ZNCC block matching, sub-pixel peaks, four-phase coarse re-lock, docking) and the proposed-move pixel math (Coons-patch plate, tether geometry). Pure and unit-tested in `tracker.test.js`.
- `public/witness.js`: the dual-band digest (dHash + eHash), per-band Hamming distance, the SHA-256 frame chain, ECDSA frame signing and checking, offline verification and screenshot matching. It runs unchanged in browsers, in the server and in `verify.html`. Unit-tested in `witness.test.js`.
- `public/ink.js`: one ink engine for annotation, pins, proposed moves and the whiteboard.
  - Strokes use normalized coordinates over the content rectangle, so letterboxed video lines up for everyone.
  - Pointer input uses coalesced events and is batched about 25 times per second.
  - Remote input is validated, and strokes are capped per surface.
- Rooms are capped at 8 people, which is the practical limit for a mesh. Larger rooms need an SFU (LiveKit or mediasoup) behind the same signaling.

## Testing

- `npm test`: Node unit and integration tests.
  - Director logic.
  - Signaling, waiting room, lock and kick.
  - Pins: `pid`, server numbering, author/sharer resolution, malformed payloads.
  - Auto-highlight relay and caption buffering.
  - Late-joiner catch-up, both from the waiting room and after 30 seconds.
  - Schema stripping.
  - Living anchors (`tracker.test.js`), on synthetic moving frames with codec-like noise:
    - follows a translating feature to within 0.6 px
    - goes `occluded` when the feature is gone, and re-locks when it returns elsewhere
    - re-locks after jumps beyond the search radius
    - refuses ambiguous duplicates; ignores flat templates
    - also covers the Coons plate (a gradient reconstructed to ±1 level) and the move geometry
  - Proof-of-Frame (`witness.test.js`):
    - dual-band digest: 90 synthetic UI screens stay "the same frame" through one and two codec passes; unrelated images stay apart
    - look-alikes: 0/435 on the benchmark versus 51/435 for dHash alone; the held-out ceiling (≤ 10/1770) is pinned
    - the signed chain verifies; a swapped picture, a forged link, a gap, a replay, another key or another room are each rejected
    - an edited export pinpoints the edited frame
  - Server: pin templates and `screen-patch` validated and room-wide; `witness-frame` relayed only when signed, chained, fresh and not too frequent.
- `npm run test:e2e`: headless Chrome suites that start their own server on a free port.
  - Each suite uses fake camera/mic devices, plus a fake SpeechRecognition so captions can be tested.
  - Needs `playwright-core` (not a dependency): `PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs`. Optional: `CHROME=/path/to/chrome`, and `E2E_OUT=dir` for screenshots.
  - `e2e/two-person.mjs`: lobby, live video both ways, hand/chat/reactions, mute-all, camera off, speaker view, phone layout, removing a participant.
  - `e2e/three-person.mjs`:
    - waiting room and matching safety codes
    - Auto-Mode caption and reaction-burst auto-highlights
    - late joiner's catch-up card: no overlaps, inside the viewport, whiteboard synced
    - a viewer's numbered pin rendered on the sharer's side
    - spotlight moving to the speaker after 10 seconds idle and back when someone draws
    - exported notes with `[Auto]` highlights and pins, and the sharer resolving the pin
  - `e2e/real-browser.mjs` (`npm run test:e2e:real`, about 3 minutes): the capabilities fakes alone can't prove.
    - **Away protection**: Chrome gets a generated silent WAV mic and a still Y4M camera, and Playwright's fake clock fast-forwards minutes. The test expects the "Still there?" prompt at 2:00 and auto-mute at 5:00. With the moving fake camera, there must be no prompt over 2.5 minutes, since motion counts as being present.
    - **Real on-device translation**: Chrome's Translator API with downloaded models translates a live caption. The test checks the Spanish text, the original kept as a tooltip, and both appearing in the exported notes.
      - The first run needs network access. It installs Chrome's TranslateKit library and the en→es pack into a cached test profile (`TRUEMEET_PROFILE`, default `<tmp>/truemeet-e2e-profile`; never your own Chrome profile).
      - Offline, this part is reported as **skipped** with the reason.
    - **Sliding transition**: at 1/10 animation speed, the test reads the browser's own `::view-transition-group` animations. It asserts that tiles morph from their old box to the new one (e.g. 698×393 → 1156×650 in 380 ms) and saves frames.
    - **Pins in the presenter window**: a real Document Picture-in-Picture window opens. A viewer's pin appears inside it live and returns with the tile when the window closes.
  - `e2e/novel.mjs` (3 browsers, about 45 s):
    - rewind a live share, mark the past frame privately, beam it, then compare (stack card and real pop-out presenter window)
    - jump back to live
    - snip a live region onto the whiteboard
    - promote a highlight to a proposal; two people sign; the exported ledger verifies offline and a tampered copy fails
    - whisper privacy measured at the third participant: their audio level for the whisperer is 0 while the partner still hears them
  - `e2e/copilot.mjs` (part of `npm run test:e2e:real`, about 10 s):
    - Ada asks in English and Bo has chosen Spanish.
    - Bo sees the caption translated on-device.
    - Bo gets a private Co-Pilot card: the question in Spanish, plus two replies grounded in the meeting's whiteboard pin and proposal, in Spanish and in English.
    - Ada never sees the card.
    - **Speak to room**:
      - Ada's browser speaks the exact English reply with an English voice (a recording speech-synthesis test double).
      - Cy, with no voices installed, gets the text-only fallback; Bo's own browser stays silent.
      - The banner appears on Bo's tile everywhere, and the reply is in everyone's notes.
      - Measured: Bo receives **0** from Ada's mic while her device speaks, and normal levels afterwards, so no echo.
    - Bo's one-click Send delivers the English reply to Ada's chat.
  - `e2e/deep-tech.mjs` (part of `npm run test:e2e`, 3 browsers, about 35 s). Bo shares a deterministic animated canvas screen through the real WebRTC encoder.
    - **Living anchors**: Ada pins an orange badge. As it glides across Bo's screen, the pin follows it through at least 4 intermediate positions on every participant's own decoded video, including Bo's. It docks at the bottom edge as "Off-screen" when the badge is hidden, and re-locks within 0.02 when the badge reappears elsewhere.
      - Measured here: about 7 fps decoded in headless Chrome. A pin can only move as often as its video delivers frames.
    - **Proposed move**: Cy lifts the magenta card and drops it lower down. Bo's own tile, Ada's tile and Bo's real pop-out presenter window show card pixels at the new spot and the blue gradient plate where it was (read back from the canvas).
    - **Proof-of-Frame**: Ada's and Cy's badges reach "Witness Verified · Frame #N" across real compression (measured 0–1/64 layout, 0/64 detail bits). The exported notes list the frames VALID, and the chain verifies offline in Node.
    - **`verify.html`**:
      - Ada's saved frame matches a signed frame.
      - A screenshot of the meeting window matches none (closest at 37/64 layout and 9–11/64 detail bits).
      - An edited digest in the notes is flagged INVALID.
  - All suites assert zero console errors.

## Privacy notes

- Audio and video never touch the server.
- Screen Time Machine frames stay in each viewer's memory; only frames you explicitly beam leave your browser, and only to the presenter. Snips go to the whiteboard, like drawings.
- Ledger private keys are non-extractable and never leave the tab. Only public keys and signatures are shared.
- Living anchors send only a 16×16 grayscale patch with each pin. Tracking runs locally. Proof-of-Frame sends only 128-bit digests, chain hashes and signatures, never pixels; saved evidence frames go only to your own downloads.
- Chat, captions and pins already pass through it as signaling text. For catch-up, the server now keeps the last 40 final caption lines and up to 200 highlights per room, **in memory only**, dropped when the room empties.
- Away detection, talk-time and the Co-Pilot run entirely in your browser. A Co-Pilot reply leaves your device only when you click Send.
- Captions use the browser's speech service (in Chrome this may use Google's servers). Translation runs on-device.

## Trademarks

TrueMeet uses no third-party marks.
- The name, two-ring logo, violet/cyan palette and floating control dock are original.
- The product UI doesn't reference any other video-meeting brand.
- Before a public launch, search the USPTO/EUIPO databases for "TrueMeet" and have counsel review. This note is not legal advice.
