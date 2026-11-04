# Mascot: Hexi, the OnYourSite bee

Status: second draft (3 poses, redrawn after the owner's feedback on the first one), waiting for the owner's feedback.
Not used on the site yet.

## Idea

OnYourSite's logo is a group of honeycomb cells, and users collect **honeycombs**. A bee fits both: it builds the
honeycombs and it is busy, friendly and a little curious – like someone building their own page.

- **Name:** Hexi (from *hexagon*, the shape of a honeycomb cell). Short, easy to say in English and German.
  Alternatives if the owner prefers: Combi, Bee-Bo, Honey.
- **Character:** cheerful, helpful, never cheeky. Hexi explains, points the way and celebrates with the user;
  Hexi never scolds. Speaks plain English in short sentences (when there are speech bubbles).

## Look

- A real little bee in a cute, chubby style: a **big round head** (honey yellow `#fff3c4` → `#fdd34d` → `#e3920f`)
  with a small curl on top, a **striped body** below it (two dark brown stripes `#3a2312`, a small stinger) and short
  legs with little feet.
- Big, glossy dark eyes (two highlights each), pink cheeks and a small smile. Dark brown outlines (6 px at 400 px).
- Two pairs of glassy wings in the brand colours: white → light indigo, outline `#6366f1`, with a shine.
- **Antennae end in small honeycomb cells** in brand indigo (`#a5b4fc` → `#4f46e5`) – the link to the logo.
- A soft shadow on the ground. No text and no emoji inside the artwork.

## Poses (second draft)

| Files | Pose | Where it could be used |
|---|---|---|
| `static/images/mascot/hexi-hello.svg` / `.png` | Waving | home page, sign-up done, the empty editor ("Add your first block") |
| `static/images/mascot/hexi-winter.svg` / `.png` | Santa hat on the head (tip and bobble fall to the left, like the hat on the logo) and a green knitted scarf around the neck | the winter season theme (Admin → Seasons), holiday updates |
| `static/images/mascot/hexi-celebrate.svg` / `.png` | Arms up, laughing, confetti and small honeycombs | a new release on `/updates`, a purchase in the shop, a streak |

The SVGs come from `tools/mascot.py` (`python3 tools/mascot.py static/images/mascot`), the PNGs (512 × 512,
transparent) from `tools/mascot-png.js` (`node tools/mascot-png.js static/images/mascot`) – change the drawing in
`tools/mascot.py`, not in the files. Each SVG has a `<title>` and `aria-label` for screen readers.

## Next poses (proposal)

- **Thinking** (hand on chin) – help texts, the docs site (D5), "Something went wrong".
- **Searching with a magnifying glass** – the 404 page.
- **Building** (carrying a honeycomb cell) – code pages, "Your page is being set up".
- **Sleeping** – maintenance on the status page.
- **Small head-only version** – a 32–64 px avatar for the Discord bot, notifications and the favicon set.

## Rules

- Hexi never covers content or buttons and is never animated so it distracts; a small bounce on hover is the most.
- At most one Hexi per page.
- Season versions (winter, later others) only while that season theme is on.
- Users' own pages never show Hexi (only OnYourSite's own pages, the editor and the admin).

## Open decisions for the owner

1. Name: Hexi – or one of the alternatives?
2. Style: keep this outlined, softly shaded style, or a full 3D look?
3. Where first: 404 page and the empty editor, or the winter theme on the home page?
