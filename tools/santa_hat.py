"""Die Weihnachtsmützen von OnYourSite: logo_hat_svg() für das Logo im Winter-Look (nach der Vorlage des Inhabers:
große rote Mütze, Spitze hängt rechts herab, schräger Fellrand von links unten nach rechts oben, Bommel links; viewBox in
den Maßen der Vorlage, 300 × 280), hat_svg() für Bea (viewBox 80 × 64)."""
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

def logo_hat_svg():
    s = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='80 30 300 280'>"
    s += ("<defs>"
          "<linearGradient id='r' x1='0' y1='0' x2='1' y2='.35'><stop offset='0' stop-color='#ec3a3f'/><stop offset='.5' stop-color='#d81e2e'/><stop offset='1' stop-color='#a8102b'/></linearGradient>"
          "<radialGradient id='f' cx='38%' cy='30%' r='75%'><stop offset='0' stop-color='#ffffff'/><stop offset='.7' stop-color='#eef2f8'/><stop offset='1' stop-color='#cfd8e6'/></radialGradient>"
          "</defs>")
    # Rote Mütze: links hoch, oben rund, die Spitze hängt rechts herab (dunkler, hinter dem Fellrand)
    s += ("<path d='M100 250 C100 205 112 150 140 105 C165 65 205 42 245 42 C285 43 315 66 330 100 C340 122 342 146 340 170 "
          "L320 172 C322 150 318 128 306 112 C302 160 250 205 160 255 Z' fill='url(#r)'/>"
          "<path d='M306 112 C300 150 280 165 255 180 L330 170 C334 150 332 128 306 112 Z' fill='#9f1239' opacity='.55'/>"
          # Falte von oben nach links unten, das helle Innere unten links, Glanz rechts
          "<path d='M206 92 C185 120 160 160 150 225' stroke='#8f1024' stroke-width='6' fill='none' stroke-linecap='round' opacity='.55'/>"
          "<path d='M152 196 L140 238 L162 232 Z' fill='#ffffff' opacity='.85'/>"
          "<path d='M276 58 C304 70 322 92 330 128' stroke='#ffffff' stroke-width='7' fill='none' stroke-linecap='round' opacity='.35'/>")
    # Fellrand: schräg, aus weichen Kugeln
    s += "<g fill='url(#f)'>"
    for cx, cy, r in [(160, 243, 27), (192, 228, 27), (224, 213, 27), (256, 198, 27), (288, 184, 27), (320, 171, 27), (348, 160, 24)]:
        s += f"<circle cx='{cx}' cy='{cy}' r='{r}'/>"
    s += "</g>"
    s += "<path d='M140 262 C200 240 290 205 365 172' stroke='#b9c4d6' stroke-width='3' fill='none' opacity='.7' stroke-linecap='round'/>"
    # Bommel links am Ende des Fellrands
    s += "<circle cx='112' cy='256' r='29' fill='url(#f)'/><circle cx='103' cy='246' r='9' fill='#ffffff' opacity='.9'/>"
    return s + '</svg>'

if __name__ == '__main__':
    open(sys.argv[1], 'w').write(hat_svg())
