"""Die Weihnachtsmütze von OnYourSite (Logo im Winter-Look und Bea): breiter Fellrand, rote Mütze, deren Spitze nach links umfällt, Bommel links. hat_svg() liefert das SVG (viewBox 80 × 64)."""
import sys

def hat_svg():
    s = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 64'>"
    s += ("<defs>"
          "<linearGradient id='r' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#f04444'/><stop offset='.55' stop-color='#d61f2c'/><stop offset='1' stop-color='#9f1239'/></linearGradient>"
          "<radialGradient id='f' cx='40%' cy='35%' r='75%'><stop offset='0' stop-color='#ffffff'/><stop offset='1' stop-color='#dfe7f2'/></radialGradient>"
          "</defs>")
    # Rote Mütze in einem Stück: rechts hoch, oben rund, die Spitze fällt nach links und hängt herab
    s += ("<path d='M67 47 C69 34 68 20 61 11 C53 3 40 2 30 7 C21 12 14 19 10 27 C8 31 7 35 8 38 "
          "C12 34 17 31 23 29 C21 35 18 41 17 47 Z' fill='url(#r)'/>"
          # Falte, wo die Spitze umknickt, und ein Glanzstreifen rechts
          "<path d='M23 29 C28 22 37 16 47 15' stroke='#7f1d1d' stroke-width='1.8' fill='none' opacity='.5' stroke-linecap='round'/>"
          "<path d='M61 14 C66 22 66 33 64 44' stroke='#ffffff' stroke-width='2.4' fill='none' opacity='.25' stroke-linecap='round'/>")
    # Bommel links unten an der Spitze
    s += ("<circle cx='8' cy='40' r='7.5' fill='url(#f)'/>"
          "<circle cx='5.5' cy='37.5' r='2.4' fill='#ffffff' opacity='.9'/>")
    # Fellrand: weiche Wolke aus Kreisen über einem abgerundeten Band
    s += "<rect x='10' y='42' width='62' height='14' rx='7' fill='url(#f)'/>"
    for cx, cy, r in [(15, 49, 7), (24, 47, 7.5), (34, 46.5, 7.5), (44, 46.5, 7.5), (54, 47, 7.5), (63, 48.5, 7), (69, 50, 5.5)]:
        s += f"<circle cx='{cx}' cy='{cy}' r='{r}' fill='url(#f)'/>"
    s += "<path d='M12 54 C30 58 52 58 70 54' stroke='#b8c4d6' stroke-width='1.6' fill='none' opacity='.8' stroke-linecap='round'/>"
    return s + '</svg>'

if __name__ == '__main__':
    open(sys.argv[1], 'w').write(hat_svg())
