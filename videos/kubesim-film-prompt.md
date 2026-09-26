<context>
kubesim runs a simulated Kubernetes cluster in the browser tab: you type real `kubectl` commands and watch Pods get scheduled, crash, heal and roll out, with every step explained in plain English. Free, open source, no sign-up.
This film plays in the X / LinkedIn feed. It must read with the sound off (autoplay is muted) and hit harder with it on.
Read `videos/BRAND.md` first. It holds the brief, the look, the brand element, the components, the owner's rulings and what we may claim. This prompt only adds the story.
</context>

<inputs>
Decided: 1920x1080, 60 fps, light, 23 bars at 120 BPM (119.995), 46 s. Music: "Astral Generated Music f328b92b" (HeyGen library), in `public/audio/kubesim-film/music/` (gitignored). Edit: song bars 0-16, 16-20, 22-25 (`edit.json`).
</inputs>

<direction>
Calm, clear, a little playful: the cluster is a toy you are allowed to break.
Ingredients (from the interview): logo draws itself · big punchlines between scenes · one canvas with camera moves · cursor with the real Chaos tool, one typed `kubectl scale`, a real-app proof shot.
Only the product's own surfaces, colors, borders and effects.
Banned: glow, neon, dark mode, particles for decoration (voxel shards only as the killed Pod itself), bouncy easing on type, "real cluster", "playground", claims beyond the simulated set.
</direction>

<cast>
- The brand element: the kubesim hexagon. It draws itself in bar 1 and returns in bar 22, born from the last Pod cube (a Pod's silhouette is the same hexagon).
- Cursors: the user's OS arrow, carrying the Chaos badge (red-50 tile, lightning glyph) when it kills things.
- Demo world: Deployment `web`, 3 → 6 replicas; Nodes `control-plane`, `worker-1`, `worker-2`, `worker-3` (the Sandbox's own names).
</cast>

<structure>
120 BPM, 4/4, 23 bars. One beat is 0.5 s, one bar 2 s. Something happens on every beat.

Bar 1, opening. The logo outline draws itself (beats 1-2), fills on beat 3, the inner hexagon draws on beat 4.
Bar 2. "kubesim" lands letter by letter beside the mark (beats 1-2); the lockup holds, then lifts away on beat 4.
Bar 3, punchline: "Kubernetes, / you can see." (Kubernetes, · you · can · see. on beats 1-4, "see." accent).
Bar 4, the world. The camera opens wide on the dot grid; the four Nodes rise, one per beat (control-plane, worker-1, worker-3, worker-2); system parts click on in eighths.
Bar 5. Three Pods drop onto the workers on beats 1, 2, 3 (squash, ripple, amber LED); all LEDs go green on beat 4.
Bar 6, punchline: "Kill a Pod."
Bars 7-8 (the song's lift), self-healing. The cursor, Chaos badge on, glides to the Pod on worker-3 (bar 7 beats 1-2) and clicks on beat 3: the Pod shatters into voxels, camera punches in, readout "desired 3 · actual 2" goes red on beat 4. Bar 8: the ReplicaSet ring appears (beat 1), pulses (2), its beam draws down to an empty slot (3), a new Pod rides the beam (4)...
Bar 9, the drop. ...and lands exactly on the downbeat: squash, ripple, readout back to 3, camera pulls back.
Bar 10, punchline: "It heals itself."
Bar 11, scaling. A terminal bar slides in and types `kubectl scale deploy web --replicas=6` (beats 1-3), Enter on beat 4.
Bar 12. Three Pods rain in on eighths (beat 1, 1.5, 2) with echo trails; their LEDs go green on beats 3 and 4.
Bar 13, punchline: "One line. Six Pods."
Bar 14, Node failure. The cursor glides to a "Power off" button on worker-3 (beats 1-2), clicks on beat 3, worker-3 glitches on beat 4.
Bars 15-16 (lift). worker-3 turns red and cracks (15.1), sinks (15.2), its Pods go grey (15.3), chip "worker-3 · NotReady" (15.4). Bar 16: the grey Pods lift (16.1) and arc toward healthy Nodes (16.2-16.4).
Bar 17. They land on beats 1 and 2 and turn blue; chip "Evicted → Running" on beat 3; camera pulls back on beat 4.
Bar 18, punchline: "Break it. / Watch it recover."
Bars 19-20, proof. The camera flies right to the real Sandbox, in a browser frame on the same canvas (19.1); pills land on beats: "Real kubectl", "8 Lessons", "6 Explainers", "Sandbox" (19.2-20.1); "Every event explained in plain English" (20.3).
Bar 21, punchline: "Free. No sign-up. / Just your browser."
Bar 22 (last lift), ending. One blue Pod cube drops to centre (22.1) and becomes the logo (22.2-22.3); "kubesim" lands (22.4).
Bar 23 (ring-out). "Learn Kubernetes on a cluster you can see." word by word under the lockup; hold still to the end.
</structure>

<build>
1. Remotion in `videos/`, set up as BRAND.md "Workspace" says. Kit in `src/kit/`, this film in `src/videos/kubesim-film/`. fps from props: 60 in Studio, 240 for the final render.
2. Every style is a pure function of the frame.
3. `cues.ts` is the beat sheet as data; scene code never holds a literal frame number. `scripts/beat-sheet.ts` writes the table.
4. Springs are closed form; values that retarget sum one spring per key.
5. Camera on `kit/camera.ts` over one world; punchlines in screen space with the world blurred out under them.
6. Music measured with `scripts/beats.py`; cut on bars with `scripts/audio-edit.py`; SFX placed on measured peaks.
7. Final: `scripts/render.ts` (240 fps, motion blur), then `scripts/verify.py`.
</build>

<gotchas>
Never put will-change on anything the camera scales. Text never travels across text. Keep a slot for every word before it lands. Not a loop: the ending holds. Judge the encoded file, and decode its pixels. Claims: simulated cluster only; nothing beyond the simulated feature set.
</gotchas>
