<?php
// Die 25 Designs. Das Aussehen steht in static/css/themes.css (Klasse .t-<schlüssel>),
// hier nur die Daten für Editor, Vorschau und Landingpage.

function oys_themes(): array
{
    return [
        // --- Standard-Designs ---
        'trs'       => ['name' => 'TRS',            'group' => 'standard', 'dark' => true,  'accent' => '#ff7a1a', 'font' => 'outfit',            'desc' => 'Standard – dunkel mit orangem Glühen'],
        'deep-dark' => ['name' => 'Dunkel',         'group' => 'standard', 'dark' => true,  'accent' => '#a1a1aa', 'font' => 'inter',             'desc' => 'Schlicht, schwarz, zeitlos'],
        'minimal'   => ['name' => 'Minimal',        'group' => 'standard', 'dark' => false, 'accent' => '#18181b', 'font' => 'inter',             'desc' => 'Weiß, klar, aufgeräumt'],
        'glass'     => ['name' => 'Glas',           'group' => 'standard', 'dark' => false, 'accent' => '#6366f1', 'font' => 'inter',             'desc' => 'Milchglas auf Pastell'],
        'brutal'    => ['name' => 'Brutal',         'group' => 'standard', 'dark' => false, 'accent' => '#ff5c39', 'font' => 'space-grotesk',     'desc' => 'Dicke Ränder, harte Schatten'],
        'candy'     => ['name' => 'Candy',          'group' => 'standard', 'dark' => false, 'accent' => '#ff4fa0', 'font' => 'fredoka',           'desc' => 'Bonbonfarben und verspielt'],
        'zen'       => ['name' => 'Zen',            'group' => 'standard', 'dark' => false, 'accent' => '#b33a3a', 'font' => 'cormorant-garamond', 'desc' => 'Ruhig wie Reispapier'],
        'code'      => ['name' => 'Code',           'group' => 'standard', 'dark' => true,  'accent' => '#4fc1ff', 'font' => 'fira-code',         'desc' => 'Wie dein Lieblings-Editor'],
        'cafe'      => ['name' => 'Café',           'group' => 'standard', 'dark' => false, 'accent' => '#c08552', 'font' => 'dm-serif-display',  'desc' => 'Latte, Kaffee und Serifen'],
        'forest'    => ['name' => 'Wald',           'group' => 'standard', 'dark' => true,  'accent' => '#34d399', 'font' => 'inter',             'desc' => 'Tiefes Grün'],
        'sunset'    => ['name' => 'Sunset',         'group' => 'standard', 'dark' => true,  'accent' => '#fb923c', 'font' => 'inter',             'desc' => 'Abendrot von Lila bis Orange'],
        'cherry'    => ['name' => 'Kirsche',        'group' => 'standard', 'dark' => true,  'accent' => '#fb7185', 'font' => 'inter',             'desc' => 'Dunkles Kirschrot'],
        'hacker'    => ['name' => 'Hacker',         'group' => 'standard', 'dark' => true,  'accent' => '#22c55e', 'font' => 'fira-code',         'desc' => 'Grün auf Schwarz'],
        'cyberpunk' => ['name' => 'Cyber',          'group' => 'standard', 'dark' => false, 'accent' => '#00e5ff', 'font' => 'orbitron',          'desc' => 'Gelb, schwarz, kantig'],
        'neon'      => ['name' => 'Neon',           'group' => 'standard', 'dark' => true,  'accent' => '#ff2bd6', 'font' => 'tilt-neon',         'desc' => 'Leuchtröhren in der Nacht'],
        'luxe'      => ['name' => 'Luxus',          'group' => 'standard', 'dark' => true,  'accent' => '#d4af37', 'font' => 'playfair-display',  'desc' => 'Schwarz und Gold'],
        'aurora'    => ['name' => 'Aurora',         'group' => 'standard', 'dark' => true,  'accent' => '#5eead4', 'font' => 'outfit',            'desc' => 'Bewegtes Polarlicht'],

        // --- Besondere Vorlagen ---
        'galaxy'    => ['name' => 'Galaxie',        'group' => 'special',  'dark' => true,  'accent' => '#a78bfa', 'font' => 'space-grotesk',     'desc' => 'Funkelnde Sterne und Nebel'],
        'notebook'  => ['name' => 'Notizbuch',      'group' => 'special',  'dark' => false, 'accent' => '#ef4444', 'font' => 'caveat',            'desc' => 'Liniertes Papier, Handschrift'],
        'comic'     => ['name' => 'Comic',          'group' => 'special',  'dark' => false, 'accent' => '#ef4444', 'font' => 'bangers',           'desc' => 'Sprechblasen und Rasterpunkte'],
        'ocean'     => ['name' => 'Ozean',          'group' => 'special',  'dark' => true,  'accent' => '#22d3ee', 'font' => 'quicksand',         'desc' => 'Wellen und Luftblasen'],
        'midnight'  => ['name' => 'Mitternacht',    'group' => 'special',  'dark' => true,  'accent' => '#a5b4fc', 'font' => 'cormorant-garamond', 'desc' => 'Mond und Sternenhimmel'],
        'retro'     => ['name' => 'Retro',          'group' => 'special',  'dark' => true,  'accent' => '#ff2e88', 'font' => 'orbitron',          'desc' => '80er-Synthwave mit Gitter'],
        'pixel'     => ['name' => 'Pixel',          'group' => 'special',  'dark' => true,  'accent' => '#fbbf24', 'font' => 'press-start-2p',    'desc' => '8-Bit wie im Arcade'],
        'newspaper' => ['name' => 'Zeitung',        'group' => 'special',  'dark' => false, 'accent' => '#b91c1c', 'font' => 'playfair-display',  'desc' => 'Schlagzeile auf Zeitungspapier'],
    ];
}

function oys_theme_key($key): string
{
    $key = (string) $key;
    return array_key_exists($key, oys_themes()) ? $key : 'trs';
}

// Schriften, die man im Feinschliff zusätzlich wählen kann
function oys_font_choices(): array
{
    return [
        ''                   => 'Wie im Design',
        'inter'              => 'Inter',
        'outfit'             => 'Outfit',
        'space-grotesk'      => 'Space Grotesk',
        'quicksand'          => 'Quicksand',
        'fredoka'            => 'Fredoka',
        'playfair-display'   => 'Playfair Display',
        'lora'               => 'Lora',
        'cormorant-garamond' => 'Cormorant',
        'caveat'             => 'Caveat (Handschrift)',
        'fira-code'          => 'Fira Code',
        'orbitron'           => 'Orbitron',
    ];
}

// Die 13 Anordnungen der Links
function oys_layouts(): array
{
    return [
        'buttons'  => ['name' => 'Knöpfe',        'desc' => 'Klassisch untereinander'],
        'cards'    => ['name' => 'Breite Karten', 'desc' => 'Mit Symbol und Adresse'],
        'tiles'    => ['name' => 'Kacheln',       'desc' => 'Quadratisch, zwei nebeneinander'],
        'apps'     => ['name' => 'App-Raster',    'desc' => 'Wie ein Handy-Startbildschirm'],
        'timeline' => ['name' => 'Zeitstrahl',    'desc' => 'Punkte an einer Linie'],
        'cloud'    => ['name' => 'Wolke',         'desc' => 'Kompakte Schlagwörter'],
        'columns'  => ['name' => 'Zwei Spalten',  'desc' => 'Knöpfe nebeneinander'],
        'tree'     => ['name' => 'Baum',          'desc' => 'Äste links und rechts'],
        'bento'    => ['name' => 'Bento',         'desc' => 'Kacheln in verschiedenen Größen'],
        'carousel' => ['name' => 'Karussell',     'desc' => 'Zum Durchwischen'],
        'polaroid' => ['name' => 'Polaroid',      'desc' => 'Schiefe Sofortbilder'],
        'magazine' => ['name' => 'Magazin',       'desc' => 'Titelgeschichte und Liste'],
        'stack'    => ['name' => 'Stapel',        'desc' => 'Übereinanderliegende Karten'],
    ];
}

function oys_layout_key($key): string
{
    $key = (string) $key;
    return array_key_exists($key, oys_layouts()) ? $key : 'buttons';
}
