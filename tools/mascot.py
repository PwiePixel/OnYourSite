"""Hexi, die Biene von OnYourSite: erzeugt die Posen als SVG. Aufruf: python3 tools/mascot.py static/images/mascot
Aufbau (viewBox 400 × 400): Bodenschatten, Flügel (hinten), Hinterleib mit Streifen und Stachel, Beine, Kopf mit Gesicht,
Fühler mit Waben-Enden, Arme; je Pose Zubehör (Mütze und Schal, Konfetti)."""
import math, os, sys

INK = '#3a2312'      # Umriss und Streifen
VIOLET = '#6366f1'   # Markenfarbe (Waben an den Fühlern, Flügelrand)


def hexagon(cx, cy, r, fill, stroke=None, sw=0, rot=-30):
    pts = ' '.join(f"{cx + r * math.cos(math.radians(60 * i + rot)):.1f},{cy + r * math.sin(math.radians(60 * i + rot)):.1f}" for i in range(6))
    st = f" stroke='{stroke}' stroke-width='{sw}' stroke-linejoin='round'" if stroke else ''
    return f"<polygon points='{pts}' fill='{fill}'{st}/>"


DEFS = """<defs>
<radialGradient id='head' cx='38%' cy='30%' r='80%'><stop offset='0' stop-color='#fff3c4'/><stop offset='.45' stop-color='#fdd34d'/><stop offset='1' stop-color='#e3920f'/></radialGradient>
<radialGradient id='belly' cx='38%' cy='28%' r='85%'><stop offset='0' stop-color='#ffe9a3'/><stop offset='.5' stop-color='#fbbf24'/><stop offset='1' stop-color='#d47f0a'/></radialGradient>
<linearGradient id='wing' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#ffffff' stop-opacity='.95'/><stop offset='.5' stop-color='#dfe3ff' stop-opacity='.8'/><stop offset='1' stop-color='#a5b4fc' stop-opacity='.65'/></linearGradient>
<radialGradient id='eye' cx='45%' cy='40%' r='65%'><stop offset='0' stop-color='#4b3a6b'/><stop offset='.6' stop-color='#241a35'/><stop offset='1' stop-color='#120c1c'/></radialGradient>
<linearGradient id='hexi' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#a5b4fc'/><stop offset='1' stop-color='#4f46e5'/></linearGradient>
<linearGradient id='red' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#f25555'/><stop offset='.55' stop-color='#d61f2c'/><stop offset='1' stop-color='#9f1239'/></linearGradient>
<radialGradient id='fur' cx='40%' cy='35%' r='75%'><stop offset='0' stop-color='#ffffff'/><stop offset='1' stop-color='#dbe3ef'/></radialGradient>
<linearGradient id='knit' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#22c55e'/><stop offset='1' stop-color='#15803d'/></linearGradient>
<clipPath id='bellyClip'><ellipse cx='200' cy='288' rx='90' ry='76'/></clipPath>
<filter id='soft' x='-20%' y='-20%' width='140%' height='140%'><feGaussianBlur stdDeviation='6'/></filter>
</defs>"""


def shadow():
    return "<ellipse cx='200' cy='378' rx='96' ry='12' fill='#000000' opacity='.28' filter='url(#soft)'/>"


def wings(lift=0):
    s = ''
    for side in (-1, 1):
        cx = 200 + side * 92
        s += (f"<g transform='rotate({side * (28 + lift)} {200 + side * 40} 230)'>"
              f"<ellipse cx='{cx}' cy='175' rx='52' ry='82' fill='url(#wing)' stroke='{VIOLET}' stroke-width='5'/>"
              f"<path d='M{cx} 104 C{cx - side * 14} 140 {cx - side * 12} 200 {cx + side * 4} 246' stroke='#c7d2fe' stroke-width='3' fill='none'/>"
              f"<ellipse cx='{cx - side * 16}' cy='140' rx='10' ry='22' fill='#ffffff' opacity='.7' transform='rotate({side * -15} {cx - side * 16} 140)'/></g>"
              f"<g transform='rotate({side * (58 + lift)} {200 + side * 40} 245)'>"
              f"<ellipse cx='{200 + side * 82}' cy='232' rx='30' ry='50' fill='url(#wing)' stroke='{VIOLET}' stroke-width='4'/></g>")
    return s


def belly():
    s = "<ellipse cx='200' cy='288' rx='90' ry='76' fill='url(#belly)'/>"
    s += (f"<g clip-path='url(#bellyClip)'>"
          f"<path d='M100 268 C150 284 250 284 300 268 L300 292 C250 308 150 308 100 292 Z' fill='{INK}'/>"
          f"<path d='M100 318 C150 332 250 332 300 318 L300 342 C250 356 150 356 100 342 Z' fill='{INK}'/></g>")
    s += f"<ellipse cx='200' cy='288' rx='90' ry='76' fill='none' stroke='{INK}' stroke-width='6'/>"
    s += "<ellipse cx='160' cy='256' rx='26' ry='12' fill='#fff8dc' opacity='.55' transform='rotate(-20 160 256)'/>"
    # Stachel
    s += f"<path d='M188 360 L200 384 L212 360 Z' fill='{INK}' stroke='{INK}' stroke-width='4' stroke-linejoin='round'/>"
    return s


def legs():
    s = ''
    for x, d in ((172, -1), (228, 1)):
        s += (f"<path d='M{x} 352 L{x + d * 6} 370' stroke='{INK}' stroke-width='9' stroke-linecap='round'/>"
              f"<ellipse cx='{x + d * 10}' cy='372' rx='13' ry='7' fill='{INK}'/>")
    return s


def head():
    s = f"<circle cx='200' cy='158' r='96' fill='url(#head)' stroke='{INK}' stroke-width='6'/>"
    s += "<ellipse cx='160' cy='104' rx='30' ry='16' fill='#fffbe8' opacity='.7' transform='rotate(-24 160 104)'/>"
    return s


def tuft():
    return f"<path d='M188 66 C186 50 198 42 206 48 C200 50 198 56 204 62' stroke='{INK}' stroke-width='6' fill='none' stroke-linecap='round'/>"


def antennae():
    s = ''
    for side in (-1, 1):
        x0, x1 = 200 + side * 40, 200 + side * 78
        s += f"<path d='M{x0} 74 C{x0 + side * 6} 52 {x1 - side * 10} 36 {x1} 24' stroke='{INK}' stroke-width='8' stroke-linecap='round' fill='none'/>"
        s += hexagon(x1 + side * 4, 20, 17, 'url(#hexi)', '#3730a3', 4)
        s += f"<circle cx='{x1 + side * 4 - 5}' cy='14' r='4' fill='#ffffff' opacity='.8'/>"
    return s


def face(mood='happy'):
    s = ''
    for x in (160, 240):
        if mood == 'joy':
            s += f"<path d='M{x - 22} 172 Q{x} 146 {x + 22} 172' stroke='{INK}' stroke-width='8' stroke-linecap='round' fill='none'/>"
        else:
            s += (f"<ellipse cx='{x}' cy='168' rx='23' ry='28' fill='url(#eye)'/>"
                  f"<ellipse cx='{x + 7}' cy='156' rx='9' ry='10' fill='#ffffff'/>"
                  f"<circle cx='{x - 8}' cy='182' r='4.5' fill='#ffffff' opacity='.9'/>")
    s += "<ellipse cx='126' cy='206' rx='18' ry='11' fill='#ff6b81' opacity='.45'/><ellipse cx='274' cy='206' rx='18' ry='11' fill='#ff6b81' opacity='.45'/>"
    if mood == 'joy':
        s += (f"<path d='M174 204 Q200 246 226 204 Z' fill='#7a1f2b' stroke='{INK}' stroke-width='5' stroke-linejoin='round'/>"
              "<path d='M186 222 Q200 236 214 222 Q200 216 186 222 Z' fill='#ff8fa3'/>")
    else:
        s += f"<path d='M182 208 Q200 228 218 208' stroke='{INK}' stroke-width='7' stroke-linecap='round' fill='none'/>"
    return s


def arm(side, pose='down'):
    # side -1 = links, 1 = rechts; Ansatz an der Seite des Hinterleibs
    x0 = 200 + side * 84
    if pose == 'up':
        path = f"M{x0} 262 C{x0 + side * 30} 240 {x0 + side * 40} 214 {x0 + side * 34} 186"
        hand = (x0 + side * 34, 180)
    elif pose == 'wave':
        path = f"M{x0} 262 C{x0 + side * 34} 248 {x0 + side * 48} 222 {x0 + side * 50} 196"
        hand = (x0 + side * 50, 188)
    else:
        path = f"M{x0} 268 C{x0 + side * 18} 282 {x0 + side * 20} 298 {x0 + side * 14} 312"
        hand = (x0 + side * 14, 318)
    return (f"<path d='{path}' stroke='{INK}' stroke-width='9' stroke-linecap='round' fill='none'/>"
            f"<circle cx='{hand[0]}' cy='{hand[1]}' r='14' fill='url(#belly)' stroke='{INK}' stroke-width='5'/>")


def santa_hat():
    # Sitzt auf dem Kopf: der Fellrand folgt der Kopfrundung, die Spitze fällt nach links neben den Kopf, der Bommel
    # hängt links unten gut sichtbar
    s = "<g transform='rotate(-3 200 100)'>"
    s += ("<path d='M292 110 C298 76 286 40 256 24 C226 10 186 12 158 30 C132 48 112 76 100 108 C94 126 90 148 92 166 "
          "C102 150 114 132 130 116 C134 112 138 108 142 104 Z' fill='url(#red)'/>")
    s += ("<path d='M104 104 C114 76 130 56 148 44' stroke='#ffffff' stroke-width='5' opacity='.25' fill='none' stroke-linecap='round'/>"
          "<path d='M130 116 C160 80 206 62 252 64' stroke='#7f1d1d' stroke-width='4' opacity='.4' fill='none' stroke-linecap='round'/>")
    # Fellrand: Wolke aus Kreisen entlang eines Bogens über der Stirn
    for i in range(9):
        t = i / 8
        x = 116 + t * 170
        y = 116 - math.sin(t * math.pi) * 22 + (6 if i in (0, 8) else 0)
        s += f"<circle cx='{x:.1f}' cy='{y:.1f}' r='{19 if i not in (0, 8) else 16}' fill='url(#fur)'/>"
    s += "<path d='M122 128 C170 110 236 108 284 124' stroke='#b6c2d4' stroke-width='4' fill='none' opacity='.7' stroke-linecap='round'/>"
    # Bommel an der herabhängenden Spitze
    s += "<circle cx='90' cy='172' r='21' fill='url(#fur)'/><circle cx='83' cy='164' r='6.5' fill='#ffffff'/>"
    return s + '</g>'


def scarf():
    # Am Hals zwischen Kopf und Hinterleib, ein Ende fällt vorne herab
    s = ("<path d='M118 238 C150 262 250 262 282 238 C288 248 288 262 282 270 C250 292 150 292 118 270 C112 262 112 248 118 238 Z' "
         "fill='url(#knit)' stroke='#14532d' stroke-width='5' stroke-linejoin='round'/>")
    for x in range(132, 276, 16):
        s += f"<path d='M{x} 254 l4 18' stroke='#bbf7d0' stroke-width='3' stroke-linecap='round' opacity='.8'/>"
    s += ("<path d='M236 270 C244 300 246 322 240 346 L210 342 C214 318 214 296 210 276 Z' fill='url(#knit)' stroke='#14532d' stroke-width='5' stroke-linejoin='round'/>"
          "<path d='M214 300 L240 304 M214 318 L240 322' stroke='#bbf7d0' stroke-width='4' opacity='.8'/>")
    for x in (214, 222, 230, 238):
        s += f"<path d='M{x} 344 l-2 12' stroke='#15803d' stroke-width='4' stroke-linecap='round'/>"
    return s


def confetti():
    s = ''
    for x, y, c, r in [(52, 70, '#f472b6', 20), (340, 60, '#34d399', -30), (356, 190, '#fbbf24', 45), (40, 210, '#60a5fa', -15),
                       (72, 330, '#a78bfa', 30), (330, 320, '#f87171', -40), (112, 30, '#38bdf8', 60), (290, 24, '#fb923c', -50)]:
        s += f"<rect x='{x}' y='{y}' width='18' height='8' rx='3' fill='{c}' transform='rotate({r} {x + 9} {y + 4})'/>"
    for x, y, c in [(70, 140, '#fde68a'), (334, 128, '#c7d2fe'), (200, 6, '#fbcfe8'), (360, 260, '#bbf7d0')]:
        s += hexagon(x, y, 10, c)
    return s


def svg(title, parts):
    return (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400' width='400' height='400' role='img' aria-label='{title}'>"
            f"<title>{title}</title>" + DEFS + ''.join(parts) + '</svg>\n')


POSES = {
    'hello': ('Hexi, the OnYourSite bee, waving', lambda: [shadow(), wings(), legs(), belly(), arm(-1), arm(1, 'wave'), head(), tuft(), antennae(), face()]),
    'winter': ('Hexi, the OnYourSite bee, in a Santa hat and scarf', lambda: [shadow(), wings(), legs(), belly(), arm(-1), arm(1), head(), face(), scarf(), santa_hat()]),
    'celebrate': ('Hexi, the OnYourSite bee, celebrating', lambda: [confetti(), shadow(), wings(8), legs(), belly(), arm(-1, 'up'), arm(1, 'up'), head(), tuft(), antennae(), face('joy')]),
}

if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for name, (title, parts) in POSES.items():
        with open(os.path.join(out, f'hexi-{name}.svg'), 'w') as f:
            f.write(svg(title, parts()))
    print('ok', list(POSES))
