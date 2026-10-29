<?php
declare(strict_types=1);

function blacklist_ascii_fold(string $value): string {
    $value = trim(mb_strtolower($value, 'UTF-8'));
    if (function_exists('iconv')) {
        $converted = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value);
        if ($converted !== false) {
            $value = strtolower($converted);
        }
    }
    return $value;
}

function blacklist_squash_repeats(string $value): string {
    return (string) preg_replace('/(.)\\1+/u', '$1', $value);
}

function normalize_subdomain_variants(string $subdomain): array {
    $base = blacklist_ascii_fold($subdomain);
    $base = str_replace(['_', ' ', '.', '/', '\\', "\t", "\n", "\r"], '-', $base);

    $leet = strtr($base, [
        '0' => 'o', '1' => 'i', '2' => 'z', '3' => 'e', '4' => 'a', 
        '5' => 's', '6' => 'g', '7' => 't', '8' => 'b', '9' => 'g', 
        '@' => 'a', '$' => 's', '!' => 'i', '+' => 't'
    ]);

    $variants = [
        (string) preg_replace('/[^a-z0-9-]/', '', $base),
        (string) preg_replace('/[^a-z0-9-]/', '', $leet),
        (string) preg_replace('/[^a-z0-9]/', '', $base),
        (string) preg_replace('/[^a-z0-9]/', '', $leet),
        (string) preg_replace('/[^a-z]/', '', $base),
        (string) preg_replace('/[^a-z]/', '', $leet),
    ];

    $final = [];
    foreach ($variants as $variant) {
        if ($variant === '') continue;
        $final[] = $variant;
        $final[] = blacklist_squash_repeats($variant);
    }
    return array_values(array_unique($final));
}

$forbidden_subdomains = array_values(array_unique(array_merge(
    [
        'admin', 'administrator', 'root', 'sysadmin', 'superadmin', 'operator', 'ops', 'devops', 'noc', 'soc', 'staff', 'team', 'owner', 'founder',
        'support', 'help', 'hilfe', 'kontakt', 'contact', 'info', 'about', 'legal', 'privacy', 'impressum', 'terms', 'agb', 'trust', 'security',
        'secure', 'status', 'health', 'uptime', 'docs', 'doc', 'faq', 'kb', 'knowledgebase', 'wiki', 'portal', 'console', 'dashboard', 'panel',
        'controlpanel', 'cpanel', 'webpanel', 'adminpanel', 'monitor', 'metrics', 'logs', 'logging', 'grafana', 'kibana', 'elk',
        'api', 'apiv1', 'apiv2', 'app', 'apps', 'web', 'mobile', 'm', 'beta', 'alpha', 'preview', 'sandbox',
        'login', 'signin', 'signup', 'register', 'registration', 'auth', 'oauth', 'sso', 'session', 'account', 'accounts', 'user', 'users',
        'member', 'members', 'profile', 'profiles', 'mail', 'email', 'webmail', 'smtp', 'imap', 'pop', 'mx', 'ftp', 'sftp', 'ssh', 'vpn', 'rdp',
        'cdn', 'static', 'assets', 'asset', 'img', 'image', 'images', 'media', 'files', 'file', 'download', 'downloads', 'upload', 'uploads',
        'backup', 'backups', 'restore', 'db', 'database', 'mysql', 'mariadb', 'postgres', 'postgresql', 'sql', 'redis', 'cache', 'queue', 'worker', 'workers', 'cron', 'jobs',
        'localhost', 'local', 'internal', 'intranet', 'test', 'testing', 'demo', 'dev', 'development', 'stage', 'staging', 'preprod', 'prod', 'production', 'qa', 'uat',
        'ns1', 'ns2', 'ns3', 'ns4', 'www', 'ww2', 'news', 'press', 'blog', 'forum', 'community', 'chat', 'shop', 'store', 'cart', 'checkout', 'search'
    ],
    [
        'onyoursite', 'premium', 'pro', 'plus', 'vip', 'enterprise', 'business', 'teamplan', 'communityplan',
        'partner', 'partners', 'affiliate', 'affiliates', 'rewards', 'loyalty', 'promo', 'coupon', 'deals'
    ],
    [
        'billing', 'bill', 'payment', 'payments', 'invoice', 'invoices', 'pay', 'payout', 'wallet', 'bank', 'banking', 'crypto', 'exchange',
        'refund', 'refunds', 'recovery', 'recover', 'restoreaccount', 'verify', 'verification', 'validated', 'validation',
        'reset', 'passwordreset', 'resetpassword', 'passwortreset', 'authenticator', '2fa', 'mfa', 'kyc',
        'supportdesk', 'helpdesk', 'customerservice', 'customercare', 'service', 'services', 'helpcenter', 'trustcenter'
    ],
    [
        'gov', 'government', 'police', 'court', 'judge', 'tax', 'treasury', 'ministerium', 'minister', 'official', 'authority'
    ],
    [
        'google', 'gmail', 'googlemail', 'youtube', 'yt', 'android', 'apple', 'icloud', 'itunes', 'appstore',
        'microsoft', 'ms', 'office', 'office365', 'outlook', 'hotmail', 'live', 'amazon', 'aws', 'prime',
        'meta', 'facebook', 'instagram', 'whatsapp', 'messenger', 'twitter', 'x', 'tiktok', 'snapchat', 'reddit', 'pinterest',
        'linkedin', 'telegram', 'signal', 'discord', 'discordapp', 'twitch', 'spotify', 'netflix', 'paypal', 'stripe',
        'visa', 'mastercard', 'wise', 'skrill', 'binance', 'coinbase', 'kraken',
        'github', 'gitlab', 'bitbucket', 'cloudflare', 'docker', 'kubernetes', 'vercel', 'netlify', 'digitalocean', 'linode',
        'hetzner', 'shopify', 'salesforce', 'hubspot', 'zendesk', 'notion', 'dropbox', 'box', 'onedrive', 'gdrive', 'googledrive',
        'slack', 'zoom', 'teams', 'skype', 'steam', 'epicgames', 'riotgames', 'openai', 'chatgpt'
    ],
    [
        'abuse', 'nocontact', 'noreply', 'donotreply', 'mailer', 'postmaster', 'hostmaster', 'webmaster', 'administratoraccount',
        'autoconfig', 'autodiscover', 'mta-sts', 'wpad', 'isatap', 'pop3', 'imaps', 'smtps', 'caldav', 'carddav', 'webdisk', 'plesk', 'whm', 'lists',
        'staticfiles', 'public', 'private', 'client', 'clients', 'partnerportal', 'adminconsole', 'control', 'manager',
        'server', 'servers', 'host', 'hosting', 'proxy', 'gateway', 'edge', 'origin'
    ]
)));

$forbidden_contains = array_values(array_unique([
    'adolf', 'hitler', 'adolfhitler', 'nazi', 'nazism', 'neonazi', 'nationalsozial', 'heilhitler', 'gestapo', 'swastika', 'hakenkreuz', 'whitepower', 'whitesupremacy', 'supremacist', 'kukluxklan',
    'terror', 'terrorist', 'genocide', 'alqaeda', 'daesh', 'isis',
    'porn', 'porno', 'sexcam', 'onlyfans', 'nudes', 'pedo', 'pedophile', 'childabuse', 'rape', 'incest', 'gore', 'snuff', 
    'scam', 'phish', 'phishing', 'malware', 'ransom', 'ransomware', 'trojan', 'keylogger', 'botnet', 'stealer', 'exploit', 'credential', 'stolen', 'leak', 'warez', 'nulled', 'crack',
    'cocaine', 'heroin', 'meth', 'fentanyl', 'mdma', 'ecstasy', 'lsd', 'ketamine', 'opium', 'weapon', 'bomb', 'explosive', 'grenade', 'ak47', 'glock',
    'fuck', 'shit', 'bitch', 'asshole', 'bastard'
]));

$forbidden_regex = [
    '/^xn--/i',
    '/^\d+$/',
    '/^(?:www|mail|mx|smtp|imap|pop|ftp|sftp|ssh|ns|cdn|img|api|app|panel|portal|dashboard)\d*$/i',
    '/^(?:admin|administrator|root|login|signin|signup|register|auth|oauth|sso|account|support|help|secure|security|verify|billing|payment|checkout)\d*$/i',
    '/^(?:test|testing|demo|dev|development|stage|staging|qa|uat|preprod|prod|production|sandbox)\d*$/i',
    '/^(?:google|gmail|youtube|apple|icloud|microsoft|office365|outlook|amazon|aws|meta|facebook|instagram|whatsapp|twitter|tiktok|telegram|signal|discord|spotify|netflix|paypal|stripe|binance|coinbase|github|cloudflare|openai|chatgpt)\d*$/i',
    '/x{3,}/i',
    '/k{3,}/i',
];

$forbidden_subdomains_squashed = array_values(array_unique(array_map('blacklist_squash_repeats', $forbidden_subdomains)));

$forbidden_contains_squashed = [];
foreach ($forbidden_contains as $word) {
    $sq = blacklist_squash_repeats($word);
    if (strlen($sq) >= 3) {
        $forbidden_contains_squashed[] = $sq;
    }
}
$forbidden_contains_squashed = array_values(array_unique($forbidden_contains_squashed));

function is_forbidden_subdomain(string $subdomain): bool {
    global $forbidden_subdomains, $forbidden_contains, $forbidden_regex, $forbidden_subdomains_squashed, $forbidden_contains_squashed;

    $subdomain = trim($subdomain);

    if ($subdomain === '' || strlen($subdomain) > 63) return true;
    if ($subdomain[0] === '-' || substr($subdomain, -1) === '-') return true;
    if (!preg_match('/^[a-z0-9-]+$/i', $subdomain)) return true;

    $variants = normalize_subdomain_variants($subdomain);

    foreach ($variants as $variant) {
        $squashedVariant = blacklist_squash_repeats($variant);

        if (in_array($variant, $forbidden_subdomains, true)) return true;
        if (in_array($squashedVariant, $forbidden_subdomains_squashed, true)) return true;

        foreach ($forbidden_regex as $regex) {
            if (preg_match($regex, $variant) || preg_match($regex, $squashedVariant)) {
                return true;
            }
        }

        // Abwärtskompatibel zu PHP 7.x (strpos statt str_contains)
        foreach ($forbidden_contains as $needle) {
            if ($needle !== '' && strpos($variant, $needle) !== false) return true;
        }

        foreach ($forbidden_contains_squashed as $needle) {
            if ($needle !== '' && strpos($squashedVariant, $needle) !== false) return true;
        }
    }

    return false;
}

function validate_subdomain_name(string $subdomain): bool {
    return !is_forbidden_subdomain($subdomain);
}
?>