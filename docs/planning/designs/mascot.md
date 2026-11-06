# Mascot: Bea, the OnYourSite bee

Status: in use in the winter season theme (since 3.4.2). Name chosen by the owner (Bea); the first name idea was
dropped.

## Idea

OnYourSite's logo is a group of honeycomb cells, and users collect **honeycombs**. A bee fits both: it builds the
honeycombs and it is busy, friendly and a little curious – like someone building their own page.

- **Name:** Bea – short and friendly, sounds like "bee", easy to say in English and German.
- **Character:** cheerful, helpful, never cheeky. Bea explains, points the way and celebrates with the user; Bea
  never scolds. Speaks plain English in short sentences (when there are speech bubbles).

## Look

- A real little bee in a cute, chubby style: a **big round head** (honey yellow `#fff3c4` → `#fdd34d` → `#e3920f`)
  with a small curl on top, a **striped body** below it (two dark brown stripes `#3a2312`, a small stinger) and short
  legs with little feet.
- Big, glossy dark eyes (two highlights each), pink cheeks and a small smile. Dark brown outlines (6 px at 400 px).
- Two pairs of glassy wings in the brand colours: white → light indigo, outline `#6366f1`, with a shine.
- **Antennae end in small honeycomb cells** in brand indigo (`#a5b4fc` → `#4f46e5`) – the link to the logo.
- A soft shadow on the ground. No text and no emoji inside the artwork.
- In winter Bea wears **the same Santa hat as the logo** (`tools/santa_hat.py`: fluffy trim, the tip and its bobble
  fall to the left) and a green knitted scarf around the neck.

## Poses

| Files | Pose | Used / could be used |
|---|---|---|
| `static/images/mascot/bea-winter.svg` / `.png` | Santa hat and scarf | **in use:** the winter season theme – Bea sits on the snow at the bottom right of the footer (on pages without a footer at the bottom right of the window; not on phones there) |
| `static/images/mascot/bea-hello.svg` / `.png` | Waving | home page, sign-up done, the empty editor ("Add your first block") |
| `static/images/mascot/bea-celebrate.svg` / `.png` | Arms up, laughing, confetti and small honeycombs | a new release on `/updates`, a purchase in the shop, a streak |

The SVGs come from `tools/mascot.py` (`python3 tools/mascot.py static/images/mascot`), the PNGs (512 × 512,
transparent) from `tools/mascot-png.js` (`node tools/mascot-png.js static/images/mascot`) – change the drawing in
`tools/mascot.py` (the hat in `tools/santa_hat.py`), not in the files. Each SVG has a `<title>` and `aria-label` for
screen readers. The hat on the logo in `static/css/season-winter.css` is the same SVG as `tools/santa_hat.py`
(`app/test/seasons.test.ts` checks it).

## Next poses (proposal)

- **Thinking** (hand on chin) – help texts, the docs site (D5), "Something went wrong".
- **Searching with a magnifying glass** – the 404 page.
- **Building** (carrying a honeycomb cell) – code pages, "Your page is being set up".
- **Sleeping** – maintenance on the status page.
- **Small head-only version** – a 32–64 px avatar for the Discord bot, notifications and the favicon set.

## Rules

- Bea never covers content or buttons and never catches clicks; the most movement is a slow, small sway.
- At most one Bea per page.
- Season versions (winter, later others) only while that season theme is on.
- Users' own pages never show Bea (only OnYourSite's own pages, the editor and the admin).

## Open decisions for the owner

1. Style: keep this outlined, softly shaded style, or a full 3D look?
2. Where next: the 404 page and the empty editor?
