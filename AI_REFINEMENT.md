50 test prompts — every common angle
Run these and note any that pick the wrong action, wrong/missing color/size/position, or wrong target. Group headers tell you the expected behavior.

Shapes (add)

<!-- add a red circle (passed)
add a neutral orange shape (passed)
add a blue box at the top (passed)
create a small black square in the center (passed)
draw a green rectangle at the bottom right (passed)
put a #ff00aa pill on screen (passed) -->
put a vertical #ff00aa pill on screen (failed, added horizontal, cannot identified the orientation)
<!-- add a shape (passed) -->
add a big yellow circle (failed, added big pill instead of circle, no big identification, failed to shape)
add a tiny yellow circle(failed, added tiny pill instead of circle, no big identification, failed to shape)


Text (add)
9. add text saying WARNING (passed)
add text saying WARNING in bottom center (passed)

10. add bold red text saying SALE (Need TESTING AGAIN)

10.1 add italic text saying "SALE" (failed, no italic or bold detection)
<!-- 11. add a title that says "Summer Drop" (passed) -->
12. write "50% OFF" in the top left (it put in the top left, but half text was over flown to extreme top left, the top left quadrant to text portion was out of frame)
13. add large white text saying SUBSCRIBE (passed)
14. add a caption label reads LIVE (failed)
15. put text saying hello at the bottom (added at the bottom, but half portion was out of frame)

Text edits (follow-up / delta)
16. make the title bigger (passed)
put selected text to center (failed)
17. make it smaller (passed)
18. change the text color to blue (passed)
19. recolor it green (passed)
20. make the text more dramatic (passed
)
21. change the title to "New Title" (passed)
22. make the text huge (passed)

Captions
23. add captions (passed)
24. generate subtitles (passed)
25. transcribe the video (passed)
26. add captions in my usual style (passed)

Background / person
27. remove the background (able to open remove background window, but when i clickedrun, it said No runner is registered for Remove Background yet.)
28. delete the background (same)
29. remove the person (it removes the layer in the timeline, its great but, we have not made a profesional grade person removal tool, whatever is right now is very imature, time consuming, and imperfect result)
30. cut out the background (same, runner not registered)

Effects
31. blur the video (passed, with intensity intent passed like more or less ,good)
(failed in removing blur effect)
32. make it cinematic (applied color grade)
(we need to make our effects much more mature next)
33. add a color grade
34. make it moody and filmic (able to do that, but we need to be more advanced in color techniques in our traditional way in the color grade settings and effects)
35. add a subtle blur to the selected layer (applied blur, but i think it didnot recognise subtle, we need to be more advanced)

Tracking / follow text
36. track the subject and follow with text (passed but applied extract background first then it opens track, user shouldselect and deselect what to apply and what not)
37. make text follow the person (passed)

Transitions / timing
38. add a fade in (passed)
39. add a fade out (passed, but it removes the earlier fade in effect) 
40. add a fade in and fade out (only adds fade out, but ai shown both that it will add both, but only one is applied)
41. make the clip start two seconds later (it dont know how to do that, it asked for clarification)
42. delay the selected layer by 3 seconds (passed)

Delete / layers
43. delete this layer (deleted the clip, it dont know difference between clip, element, track, layer... no way.. thats why its doing it wrong)
44. remove the selected layer (deleted the selected clip)
45. delete the text (passed)

Multi-intent / compound
46. add captions and make it cinematic
47. add a red circle and a fade in
48. add bold text saying SALE and blur the video

Ambiguous / clarify (should ask, not guess)
49. make it pop
50. do something cool

For each, tell me: ✅ correct, or ❌ + what it did. Especially watch #6 (hex), #4/#5 (position + shape kind), #46–48 (compound), and #49–50 (should clarify). With your keys set, the LLM runs first — set LUMIO_AI_DEBUG=1 on the API if you want to see which provider answered, and VITE_LUMIO_LLM_PLANNER=off if you want to test the offline NLU planner in isolation.


Other remarks
apps/api dev: [ai] stream pywvrkk: gemini returned unparseable reply: {"steps":[{"kind":"clarify","question":"There are two blur effects on the video. Do you want to remove both of them, or just one? If just one, I need to know which specific blur effect you'd like to r… -> it did shown in the chat as a reply, but later it did not applied any removal

apps/api dev: [ai] stream ppy4s4f: gemini returned unparseable reply: ```json { "steps": [ { "kind": "clarify", "question": "To remove both blur effects from the video layer 'beautiful lady with cycle.mp4' (ID: layer_1782281428733_1), I need the unique identifier for ea… -> when i clicked apply, it remvoed the video elemnt from the timeline track

there should be a way to individually accept the suggestions from ai, it it wants to apply 3-4 items, or more, or even 2, user should have a way to select which suggestions to apply,and which not...

Effect applied - track saved, attach it to any other layer from the inspector 9in the header) it is taking lots of space, it should be short and crisp..


my take : 
Most AI editors today are:

Prompt
   ↓
Generate result

You're describing:

Intent
   ↓
AI understands project
   ↓
AI inspects timeline
   ↓
AI asks questions
   ↓
AI finds assets
   ↓
AI builds plan
   ↓
User approves
   ↓
AI executes using tools
   ↓
Everything remains editable

That's a different category.

For example:

"Make this look like an Apple product launch video."

A normal editor might apply:

zoom
color preset
transitions

Lumio could instead:

AI:
I noticed:
- 1 talking-head clip
- 3 product shots
- no background music
- captions disabled

To achieve an Apple-style launch:

1. Minimal white typography
2. Slow cinematic zooms
3. Soft ambient soundtrack
4. Product callouts
5. Clean fade transitions

Proceed?

That's closer to an editor assistant than an effect generator.
---
The reference upload idea is even stronger.

User uploads:

MrBeast video
Apple keynote
documentary trailer
Instagram reel

and says:

"Make my video feel like this."

AI should not copy.

Instead it should analyze:

Pacing
Shot duration
Caption style
Color mood
Camera movement
Music energy
Narrative structure

Then map those concepts onto available Lumio tools.

That's a genuinely valuable workflow.

The hard part is not AI.

The hard part is building enough tools.

Because AI can only do what exists.

If Lumio has:

Track Object
Auto Captions
Color Grade
Mask
Text
Transitions
Motion Blur
Speed Ramp
Auto Reframe
Audio Ducking
Scene Detection

then AI becomes powerful.

If Lumio has only:

Text
Captions
Track Object

then even Claude Opus cannot create professional edits.

So your moat is likely:

Tool Registry
+
Timeline Understanding
+
Planning Layer
+
Editable Execution

not the model itself.

A year from now everyone will have access to similar AI models.

Very few editors will have:

timeline-aware AI
capability registry
clarification loops
deterministic execution
full undoability
reference-driven editing

That's where I'd focus.

One thing I would add to your vision:

Creative Memory

Lumio should learn the creator.

After 20 videos:

Roshan's style:
- captions yellow
- 1.1x zoom punches
- cinematic color grade
- no sound effects
- documentary pacing

Then:

"Edit this in my style."

becomes a one-click workflow.

That is much harder for competitors to replicate than simply adding another AI model.

# and for memory part 
this is my approcah.. what you say..
For Lumio, don’t think of memory like **saving chat history**.

Think of memory like a **creative profile + project brain**.

Professional AI apps usually don’t remember everything. They remember only useful, reusable signals.

### Best memory structure for Lumio

Use **4 levels of memory**:

```text
1. Session Memory
2. Project Memory
3. Creator Memory
4. Style Memory
```

---

## 1. Session Memory

Temporary memory for the current editing chat.

Example:

```json
{
  "user_current_goal": "make the video feel like a documentary",
  "selected_clip": "clip_03",
  "recent_decision": "user chose smooth tracking over fast tracking"
}
```

This disappears after the session or becomes part of project memory.

Use it for:

* current prompt
* current selected clip
* last AI action
* user corrections

---

## 2. Project Memory

Memory attached to one video project.

Example:

```json
{
  "project_id": "video_102",
  "theme": "documentary scam awareness",
  "preferred_caption_style": "bold yellow center captions",
  "music_mood": "serious, suspenseful",
  "do_not_use": ["cartoon effects", "funny transitions"],
  "approved_reference": "crime documentary trailer style"
}
```

Use it when the user says:

> “Make the rest of the video like the first 20 seconds.”

or

> “Continue the same style.”

---

## 3. Creator Memory

Long-term memory for the user.

Example:

```json
{
  "creator_id": "user_123",
  "default_caption_style": "yellow bold captions",
  "default_language": "Hindi/Hinglish",
  "preferred_video_style": "cinematic documentary",
  "usual_platform": "YouTube/Reels",
  "avoids": ["overly flashy effects", "childish fonts"]
}
```

This powers:

> “Edit this in my style.”

This is very powerful.

---

## 4. Style Memory

This is your biggest moat.

When user uploads a reference video, Lumio should not copy it. It should extract a **style fingerprint**.

Example:

```json
{
  "style_name": "Apple keynote style",
  "pacing": "slow",
  "average_shot_length": "4-6 seconds",
  "color_mood": "clean white, soft contrast",
  "text_style": "minimal sans-serif",
  "transitions": "fade, smooth push",
  "camera_motion": "slow zoom, product pan",
  "music_energy": "calm premium"
}
```

Then Lumio maps that style to real tools:

```json
{
  "actions": [
    "applyColorGrade",
    "addSlowZoom",
    "addMinimalText",
    "addFadeTransition",
    "adjustPacing"
  ]
}
```

That is better than just saying “AI edit this.”

---

# Best professional memory architecture

Use this flow:

```text
User message / timeline action
        ↓
Memory Extractor
        ↓
Classify memory
        ↓
Store useful memory only
        ↓
Retrieve relevant memory
        ↓
Inject small memory into AI prompt
```

Important: **never send all memory to the AI.**

Send only relevant memory.

Example prompt context:

```json
{
  "creatorMemory": {
    "language": "Hinglish",
    "captionStyle": "bold yellow center"
  },
  "projectMemory": {
    "theme": "documentary",
    "avoid": ["funny transitions"]
  },
  "currentTask": "make intro cinematic"
}
```

Small memory = cheaper and smarter.

---

# Memory should have confidence

Don’t store everything as fact.

Example:

```json
{
  "memory": "User prefers yellow captions",
  "confidence": 0.92,
  "source": "user repeatedly selected yellow captions",
  "last_used": "2026-06-24",
  "scope": "creator"
}
```

If confidence is low, ask:

> “Should I remember this as your default caption style?”

---

# Add a Memory Panel in Lumio

Very important for trust.

User should see:

```text
Lumio remembers:
- Default language: Hinglish
- Caption style: Bold yellow center
- Editing style: cinematic documentary
- Avoid: cartoon transitions
```

Buttons:

```text
Edit | Forget | Use for this project only
```

This makes memory feel professional, not creepy.

---

# My recommended memory model

For Lumio, build this:

```text
Memory System
├── Session Memory
├── Project Memory
├── Creator Profile
├── Style Fingerprints
├── Decision History
└── Feedback Learning
```

The magic feature:

> “Learn my editing style.”

After 10–20 edits, Lumio can say:

```text
I noticed your usual style:
- Hinglish captions
- bold yellow text
- serious documentary mood
- smooth zooms
- low use of flashy transitions

Save this as your default style?
```

That will feel pro.
one more addition, it should know the user intent, whether he making intent with last request or a new request, just like pro chatbots do like claude and chatgpt and gemini...
lets plan it...
