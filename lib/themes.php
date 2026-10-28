<?php
// Die 30 Designs. Das Aussehen steht in static/css/themes.css (Klasse .t-<schlüssel>),
// hier nur die Daten für Editor, Vorschau und Landingpage.

// Design für neue Seiten (und Ersatz für unbekannte/entfernte Designs)
const OYS_DEFAULT_THEME = 'deep-dark';

function oys_themes(): array
{
    return [
        // --- Standard-Designs ---
        'deep-dark' => ['name' => 'Deep Dark',      'group' => 'standard', 'dark' => true,  'accent' => '#a1a1aa', 'font' => 'inter',             'desc' => 'Simple, black, timeless'],
        'minimal'   => ['name' => 'Minimal',        'group' => 'standard', 'dark' => false, 'accent' => '#18181b', 'font' => 'inter',             'desc' => 'White, clean, tidy'],
        'glass'     => ['name' => 'Glass',          'group' => 'standard', 'dark' => false, 'accent' => '#6366f1', 'font' => 'inter',             'desc' => 'Frosted glass on pastels'],
        'brutal'    => ['name' => 'Brutal',         'group' => 'standard', 'dark' => false, 'accent' => '#ff5c39', 'font' => 'space-grotesk',     'desc' => 'Thick borders, hard shadows'],
        'candy'     => ['name' => 'Candy',          'group' => 'standard', 'dark' => false, 'accent' => '#ff4fa0', 'font' => 'fredoka',           'desc' => 'Sweet colors, playful'],
        'zen'       => ['name' => 'Zen',            'group' => 'standard', 'dark' => false, 'accent' => '#b33a3a', 'font' => 'cormorant-garamond', 'desc' => 'Calm as rice paper'],
        'code'      => ['name' => 'Code',           'group' => 'standard', 'dark' => true,  'accent' => '#4fc1ff', 'font' => 'fira-code',         'desc' => 'Like your favorite code editor'],
        'cafe'      => ['name' => 'Café',           'group' => 'standard', 'dark' => false, 'accent' => '#c08552', 'font' => 'dm-serif-display',  'desc' => 'Latte, coffee and serifs'],
        'forest'    => ['name' => 'Forest',         'group' => 'standard', 'dark' => true,  'accent' => '#34d399', 'font' => 'inter',             'desc' => 'Deep green'],
        'sunset'    => ['name' => 'Sunset',         'group' => 'standard', 'dark' => true,  'accent' => '#fb923c', 'font' => 'inter',             'desc' => 'Dusk from purple to orange'],
        'cherry'    => ['name' => 'Cherry',         'group' => 'standard', 'dark' => true,  'accent' => '#fb7185', 'font' => 'inter',             'desc' => 'Dark cherry red'],
        'hacker'    => ['name' => 'Hacker',         'group' => 'standard', 'dark' => true,  'accent' => '#22c55e', 'font' => 'fira-code',         'desc' => 'Green on black'],
        'cyberpunk' => ['name' => 'Cyber',          'group' => 'standard', 'dark' => false, 'accent' => '#00e5ff', 'font' => 'orbitron',          'desc' => 'Yellow, black, edgy'],
        'neon'      => ['name' => 'Neon',           'group' => 'standard', 'dark' => true,  'accent' => '#ff2bd6', 'font' => 'tilt-neon',         'desc' => 'Neon tubes at night'],
        'luxe'      => ['name' => 'Luxe',           'group' => 'standard', 'dark' => true,  'accent' => '#d4af37', 'font' => 'playfair-display',  'desc' => 'Black and gold'],
        'aurora'    => ['name' => 'Aurora',         'group' => 'standard', 'dark' => true,  'accent' => '#5eead4', 'font' => 'outfit',            'desc' => 'Moving northern lights'],
        'noir'      => ['name' => 'Noir',           'group' => 'standard', 'dark' => true,  'accent' => '#f5f5f5', 'font' => 'playfair-display',  'desc' => 'Black and white, like an old film'],
        'holo'      => ['name' => 'Holo',           'group' => 'standard', 'dark' => false, 'accent' => '#7c3aed', 'font' => 'outfit',            'desc' => 'Iridescent shimmer on white'],
        'dune'      => ['name' => 'Dune',           'group' => 'standard', 'dark' => false, 'accent' => '#c2410c', 'font' => 'dm-serif-display',  'desc' => 'Warm sand, desert sun'],

        // --- Besondere Vorlagen ---
        'galaxy'    => ['name' => 'Galaxy',         'group' => 'special',  'dark' => true,  'accent' => '#a78bfa', 'font' => 'space-grotesk',     'desc' => 'Twinkling stars and nebulae'],
        'notebook'  => ['name' => 'Notebook',       'group' => 'special',  'dark' => false, 'accent' => '#ef4444', 'font' => 'caveat',            'desc' => 'Lined paper, handwriting'],
        'comic'     => ['name' => 'Comic',          'group' => 'special',  'dark' => false, 'accent' => '#ef4444', 'font' => 'bangers',           'desc' => 'Speech bubbles and halftone dots'],
        'ocean'     => ['name' => 'Ocean',          'group' => 'special',  'dark' => true,  'accent' => '#22d3ee', 'font' => 'quicksand',         'desc' => 'Waves and bubbles'],
        'midnight'  => ['name' => 'Midnight',       'group' => 'special',  'dark' => true,  'accent' => '#a5b4fc', 'font' => 'cormorant-garamond', 'desc' => 'Moon and starry sky'],
        'retro'     => ['name' => 'Retro',          'group' => 'special',  'dark' => true,  'accent' => '#ff2e88', 'font' => 'orbitron',          'desc' => '80s synthwave with a grid'],
        'pixel'     => ['name' => 'Pixel',          'group' => 'special',  'dark' => true,  'accent' => '#fbbf24', 'font' => 'press-start-2p',    'desc' => '8-bit, straight from the arcade'],
        'newspaper' => ['name' => 'Newspaper',      'group' => 'special',  'dark' => false, 'accent' => '#b91c1c', 'font' => 'playfair-display',  'desc' => 'Headlines on newsprint'],
        'blueprint' => ['name' => 'Blueprint',      'group' => 'special',  'dark' => true,  'accent' => '#ffd166', 'font' => 'fira-code',         'desc' => 'Technical drawing on blue paper'],
        'chalkboard' => ['name' => 'Chalkboard',    'group' => 'special',  'dark' => true,  'accent' => '#ffe27a', 'font' => 'patrick-hand',      'desc' => 'Chalk on a green board'],
        'sakura'    => ['name' => 'Sakura',         'group' => 'special',  'dark' => false, 'accent' => '#e75480', 'font' => 'quicksand',         'desc' => 'Falling cherry blossoms'],
    ];
}

function oys_theme_key($key): string
{
    $key = (string) $key;
    return array_key_exists($key, oys_themes()) ? $key : OYS_DEFAULT_THEME;
}

// Schriften, die man im Feinschliff zusätzlich wählen kann
function oys_font_choices(): array
{
    return [
        ''                   => 'Theme default',
        'inter'              => 'Inter',
        'outfit'             => 'Outfit',
        'space-grotesk'      => 'Space Grotesk',
        'quicksand'          => 'Quicksand',
        'fredoka'            => 'Fredoka',
        'playfair-display'   => 'Playfair Display',
        'lora'               => 'Lora',
        'cormorant-garamond' => 'Cormorant',
        'caveat'             => 'Caveat (handwriting)',
        'fira-code'          => 'Fira Code',
        'orbitron'           => 'Orbitron',
    ];
}

// Die 13 Anordnungen der Links
function oys_layouts(): array
{
    return [
        'buttons'  => ['name' => 'Buttons',       'desc' => 'Classic, one below the other'],
        'cards'    => ['name' => 'Wide cards',    'desc' => 'With icon and address'],
        'tiles'    => ['name' => 'Tiles',         'desc' => 'Square, two side by side'],
        'apps'     => ['name' => 'App grid',      'desc' => 'Like a phone home screen'],
        'timeline' => ['name' => 'Timeline',      'desc' => 'Dots along a line'],
        'cloud'    => ['name' => 'Cloud',         'desc' => 'Compact tags'],
        'columns'  => ['name' => 'Two columns',   'desc' => 'Buttons side by side'],
        'tree'     => ['name' => 'Tree',          'desc' => 'Branches left and right'],
        'bento'    => ['name' => 'Bento',         'desc' => 'Tiles in different sizes'],
        'carousel' => ['name' => 'Carousel',      'desc' => 'Swipe through'],
        'polaroid' => ['name' => 'Polaroid',      'desc' => 'Tilted instant photos'],
        'magazine' => ['name' => 'Magazine',      'desc' => 'Cover story and list'],
        'stack'    => ['name' => 'Stack',         'desc' => 'Cards stacked on top of each other'],
    ];
}

function oys_layout_key($key): string
{
    $key = (string) $key;
    return array_key_exists($key, oys_layouts()) ? $key : 'buttons';
}
